import type { EnrollOptions, EnrollResult } from "./types.js";
import type { Recipe } from "../recipe/schema.js";
import { loadRecipe } from "../recipe/load.js";
import { collectNeeds } from "../patient/validate.js";
import { createLogger } from "../logging/logger.js";
import { launchSession } from "../browser/session.js";
import { runPreflight } from "../browser/preflight.js";
import { fillStep, advanceStep, clickAdvance } from "../runner/step.js";
import { checkEligibility } from "../runner/eligibility.js";
import { captureReady, captureConfirmation } from "../runner/confirm.js";
import { makeRunId } from "../util/runId.js";

const SUBMIT_REDIRECT_TIMEOUT = 30_000;

/**
 * Run one patient through a recipe's enrollment flow, deterministically.
 *
 * Order of operations and the guardrails baked in:
 *  1. Missing-info check (collectNeeds) — never start a partial submission.
 *  2. Per step: page-match guard -> fill with native events -> verify acceptance.
 *  3. Eligibility gate at the Savings step — commercial only, before advancing.
 *  4. Final Submit is gated by `submit` (default off). When off, capture the
 *     Confirm state and stop. When on, run the (deferred) consent hook, submit,
 *     wait for the success redirect, and capture confirmation artifacts.
 *
 * The runner never throws past this boundary: every terminal condition is a typed
 * EnrollResult. On any page-structure mismatch it halts rather than guessing.
 */
export async function enroll(opts: EnrollOptions): Promise<EnrollResult> {
  const runId = opts.runId ?? makeRunId("skyrizi");
  const artifactDir = opts.artifactDir ?? "artifacts";
  const logger = createLogger({ context: { runId } });

  let recipe: Recipe;
  try {
    recipe = loadRecipe(opts.recipePath);
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  const needs = collectNeeds(opts.patient, recipe);
  if (needs.length > 0) {
    logger.info("enroll.needs_info", { count: needs.length });
    return { status: "needs_info", needs };
  }

  const session = await launchSession({ headful: opts.headful, slowMo: opts.slowMo });
  try {
    const { page } = session;
    logger.info("enroll.start", { drug: recipe.drug, submit: !!opts.submit });
    await page.goto(recipe.url, { waitUntil: "domcontentloaded" });
    await runPreflight(page, recipe.preflight, logger);

    for (const step of recipe.steps) {
      if (!step.mapped) {
        return {
          status: "unmapped_step",
          step: step.id,
          message: `Step "${step.id}" is not mapped yet — finish mapping before a full enrollment.`,
        };
      }

      // Eligibility gate: enforce BEFORE interacting with the gate step.
      if (step.id === recipe.eligibility.gate_step) {
        const elig = checkEligibility(opts.patient, recipe);
        if (!elig.eligible) {
          logger.warn("enroll.ineligible", { reason: elig.reason });
          return {
            status: "ineligible",
            reason: elig.reason ?? "ineligible",
            ...(elig.insuranceType ? { insuranceType: elig.insuranceType } : {}),
          };
        }
      }

      const fill = await fillStep(page, step, opts.patient, recipe.interaction, logger);
      if (fill.status === "page_mismatch") {
        return { status: "page_mismatch", step: step.id, missingLabels: fill.missing };
      }
      if (fill.status === "validation_failed") {
        return {
          status: "validation_failed",
          step: step.id,
          fieldKey: fill.fieldKey,
          ...(fill.detail ? { detail: fill.detail } : {}),
        };
      }

      // Final (irreversible) step handling.
      if (step.advance?.irreversible) {
        if (!opts.submit) {
          const capture = await captureReady(page, step, artifactDir, runId, logger);
          logger.info("enroll.ready_to_submit", { step: step.id });
          return { status: "ready_to_submit", capture };
        }
        // Consent/authorization gate — deferred (no-op) placeholder in v1.
        if (opts.onBeforeSubmit) await opts.onBeforeSubmit({ runId, patient: opts.patient });
        logger.info("enroll.submitting", { step: step.id });
        await clickAdvance(page, step);
        try {
          await page.waitForURL((url) => url.toString().includes(recipe.success_signal.match), {
            timeout: SUBMIT_REDIRECT_TIMEOUT,
          });
        } catch {
          return {
            status: "error",
            message: `Submit did not reach the success signal (${recipe.success_signal.match}).`,
          };
        }
        const confirmation = await captureConfirmation(page, artifactDir, runId, logger);
        return { status: "submitted", confirmation };
      }

      const advanced = await advanceStep(page, step, logger);
      if (!advanced) {
        return {
          status: "validation_failed",
          step: step.id,
          fieldKey: "(advance)",
          detail: "step did not advance after fill — a field was likely rejected by the form",
        };
      }
    }

    return { status: "error", message: "Flow ended without reaching an irreversible Submit step." };
  } catch (err) {
    logger.error("enroll.error", { detail: (err as Error).message });
    return { status: "error", message: (err as Error).message };
  } finally {
    await session.close();
  }
}

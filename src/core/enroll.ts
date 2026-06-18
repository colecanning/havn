import type { EnrollOptions, EnrollResult } from "./types.js";
import type { Recipe } from "../recipe/schema.js";
import type { Logger } from "../logging/logger.js";
import type { EnrollDriver } from "../drivers/types.js";
import { loadRecipe } from "../recipe/load.js";
import { collectNeeds } from "../patient/validate.js";
import { createLogger } from "../logging/logger.js";
import { checkEligibility } from "../runner/eligibility.js";
import { makeDriver } from "../drivers/index.js";
import { makeRunId } from "../util/runId.js";

/** Submit is retried: the first click triggers the async reCAPTCHA; the token is ready
 *  by a later click. Each attempt waits this long for the success redirect. */
const SUBMIT_ATTEMPTS = 5;
const SUBMIT_ATTEMPT_TIMEOUT = 10_000;
/** How long to keep the browser open waiting for a human to click Submit (handoff). */
const HANDOFF_TIMEOUT = 300_000;

/**
 * Run one patient through a recipe's enrollment flow.
 *
 * This is backend-agnostic: it owns the flow and guardrails and delegates every browser
 * interaction to an EnrollDriver (chosen by opts.driver). Both drivers consume the same
 * recipe + patient.
 *
 * Order of operations / guardrails:
 *  1. Missing-info check (collectNeeds) — never start a partial submission.
 *  2. Per step: page-match guard -> fill -> verify (driver.fillStep).
 *  3. Eligibility gate at the Savings step — commercial only, before advancing.
 *  4. Final Submit gated by `submit`/`handoff` (default: stop at Confirm). Consent
 *     checkbox checked only when consent was obtained out-of-band.
 *
 * Never throws past this boundary: every terminal condition is a typed EnrollResult.
 */
export async function enroll(opts: EnrollOptions): Promise<EnrollResult> {
  const runId = opts.runId ?? makeRunId("skyrizi");
  const artifactDir = opts.artifactDir ?? "artifacts";
  const driverName = opts.driver ?? "playwright";
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

  let driver: EnrollDriver;
  try {
    driver = makeDriver(driverName, {
      headful: !!(opts.headful || opts.handoff), // handoff needs a visible window
      slowMo: opts.slowMo,
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
      humanize: opts.humanize ?? true,
      artifactDir,
      runId,
      logger,
    });
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }

  logger.info("enroll.start", { drug: recipe.drug, submit: !!opts.submit, driver: driverName });
  return runEnrollment(driver, recipe, opts, runId, logger);
}

/**
 * The backend-agnostic flow: open -> per-step guard/fill/eligibility/advance ->
 * consent/submit/handoff -> confirmation. Exposed for testing with a fake driver.
 */
export async function runEnrollment(
  driver: EnrollDriver,
  recipe: Recipe,
  opts: EnrollOptions,
  runId: string,
  logger: Logger,
): Promise<EnrollResult> {
  try {
    await driver.open(recipe);

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

      const fill = await driver.fillStep(step, opts.patient, recipe.interaction);
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
        // Default: fill through Confirm and stop.
        if (!opts.submit && !opts.handoff) {
          const capture = await driver.captureReady(step);
          logger.info("enroll.ready_to_submit", { step: step.id });
          return { status: "ready_to_submit", capture };
        }

        // Required consent checkbox(es): only checked when consent was obtained.
        if (step.consent_checkboxes?.length) {
          if (!opts.consentObtained) {
            return {
              status: "error",
              message:
                `Confirm requires patient consent (${step.consent_checkboxes
                  .map((c) => c.name)
                  .join(", ")}). Re-run with consent obtained to check it.`,
            };
          }
          if (!(await driver.consent(step))) {
            return {
              status: "validation_failed",
              step: step.id,
              fieldKey: "(consent)",
              detail: "could not confirm the required consent checkbox was checked",
            };
          }
        }

        // Consent/authorization hook (e.g. audit logging) — runs before Submit.
        if (opts.onBeforeSubmit) await opts.onBeforeSubmit({ runId, patient: opts.patient });

        // Handoff: a human clicks Submit in the open window; we await the redirect.
        if (opts.handoff) {
          const capture = await driver.captureReady(step);
          logger.info("enroll.handoff_waiting", { timeoutMs: HANDOFF_TIMEOUT, step: step.id });
          if (await driver.awaitSuccess(recipe.success_signal.match, HANDOFF_TIMEOUT)) {
            return { status: "submitted", confirmation: await driver.captureConfirmation() };
          }
          logger.warn("enroll.handoff_timeout", { step: step.id });
          return { status: "ready_to_submit", capture };
        }

        // Auto-submit with retries. The first click triggers the invisible reCAPTCHA,
        // whose token resolves asynchronously — the first POST often fires before it's
        // ready (the page just scrolls to top). Re-clicking after the token resolves
        // succeeds, so we click, wait for the redirect, and re-submit if it didn't land.
        logger.info("enroll.submitting", { step: step.id, consentObtained: !!opts.consentObtained });
        let submitted = false;
        for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS && !submitted; attempt++) {
          try {
            await driver.submit(step); // re-locates + re-scrolls to the Submit button each time
          } catch (err) {
            // The click that triggers the success navigation can throw "element detached"
            // — that's not a failure; awaitSuccess below is the source of truth.
            logger.debug("enroll.submit_click_threw", { attempt, detail: (err as Error).message });
          }
          logger.info("enroll.submit_attempt", { step: step.id, attempt });
          submitted = await driver.awaitSuccess(recipe.success_signal.match, SUBMIT_ATTEMPT_TIMEOUT);
        }
        if (!submitted) {
          return {
            status: "error",
            message:
              `Submit did not reach the success signal (${recipe.success_signal.match}) after ` +
              `${SUBMIT_ATTEMPTS} attempts. The form is reCAPTCHA-protected; if this persists, ` +
              `use handoff (a human click) or the os driver.`,
          };
        }
        return { status: "submitted", confirmation: await driver.captureConfirmation() };
      }

      if (!(await driver.advance(step))) {
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
    await driver.close();
  }
}

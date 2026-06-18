import type { Page } from "playwright";
import type { Patient } from "../patient/schema.js";
import type { FieldSpec, InteractionSpec, StepSpec } from "../recipe/schema.js";
import type { Logger } from "../logging/logger.js";
import { guardStep } from "../browser/guard.js";
import { fillField, fieldVisible, waitFieldVisible } from "../browser/field.js";
import { humanMouse, humanPause, humanScroll, randomBetween } from "../browser/human.js";
import { getByPath } from "../util/path.js";

export type FillStepResult =
  | { status: "ok" }
  | { status: "page_mismatch"; missing: string[] }
  | { status: "validation_failed"; fieldKey: string; detail?: string };

/** Resolve a patient value to the string the field expects. */
function formatValue(field: FieldSpec, raw: unknown): string {
  if (field.type === "date" && typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split("-");
    return `${m}/${d}/${y}`; // form uses MM/DD/YYYY
  }
  return String(raw);
}

function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === "";
}

/** Guard the step against the recipe, then fill every applicable field. */
export async function fillStep(
  page: Page,
  step: StepSpec,
  patient: Patient,
  interaction: InteractionSpec,
  logger: Logger,
  humanize = false,
): Promise<FillStepResult> {
  const guard = await guardStep(page, step);
  if (!guard.ok) {
    logger.warn("step.page_mismatch", { step: step.id, missing: guard.missing });
    return { status: "page_mismatch", missing: guard.missing };
  }

  // Read the step over before touching it.
  if (humanize) await humanScroll(page).catch(() => {});

  let filledAny = false;
  for (const field of step.fields) {
    const raw = getByPath(patient, field.key);
    const hasValue = !isEmpty(raw);

    // A field the patient wants to fill may be a conditional one that renders only
    // after a prior choice — give it a moment to appear before deciding to skip.
    let present = await fieldVisible(page, field);
    if (!present && hasValue) present = await waitFieldVisible(page, field, 3000);

    if (!present) {
      // Required-but-missing was already caught by the guard; an optional field that
      // isn't shown is a conditional one that doesn't apply to this patient — skip.
      if (field.required) {
        return { status: "page_mismatch", missing: [field.label ?? field.name ?? field.key] };
      }
      continue;
    }

    if (!hasValue) {
      if (field.required) {
        return { status: "validation_failed", fieldKey: field.key, detail: "required value missing" };
      }
      continue; // optional + no value provided
    }

    // A beat between fields, like a person moving down the form.
    if (humanize && filledAny) await page.waitForTimeout(randomBetween(1000, 3000));

    const outcome = await fillField(page, field, formatValue(field, raw), interaction, logger, humanize);
    if (!outcome.accepted) {
      logger.warn("step.field_rejected", { step: step.id, key: field.key, method: outcome.method });
      return {
        status: "validation_failed",
        fieldKey: field.key,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
    }
    filledAny = true;
  }

  logger.info("step.filled", { step: step.id, fieldCount: step.fields.length });
  return { status: "ok" };
}

/**
 * Check the step's required consent checkbox(es). Only called when consent has been
 * obtained from the patient out-of-band. Returns false if a box can't be confirmed
 * checked (the runner then halts rather than submitting without recorded consent).
 */
export async function applyConsent(
  page: Page,
  step: StepSpec,
  logger: Logger,
): Promise<boolean> {
  for (const box of step.consent_checkboxes ?? []) {
    const loc = page
      .locator(`input[type="checkbox"][name=${JSON.stringify(box.name)}]`)
      .filter({ visible: true })
      .first();
    try {
      if (!(await loc.isChecked())) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.check({ timeout: 8000 }).catch(async () => {
          await loc.click({ timeout: 8000 }); // custom checkbox: click the control/label
        });
        await loc.dispatchEvent("change").catch(() => {});
      }
      const checked = await loc.isChecked().catch(() => false);
      logger.info("consent.checked", { name: box.name, checked });
      if (!checked) return false;
    } catch (err) {
      logger.warn("consent.failed", { name: box.name, detail: (err as Error).message });
      return false;
    }
  }
  return true;
}

/** Click a step's advance button (visible), with a little human-like lead-in. */
export async function clickAdvance(page: Page, step: StepSpec): Promise<void> {
  if (!step.advance) return;
  const button = page
    .getByRole("button", { name: step.advance.button, exact: true })
    .filter({ visible: true })
    .first();
  try {
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await humanMouse(page).catch(() => {});
    await humanPause(page).catch(() => {});
    await button.click({ timeout: 8000 });
  } catch {
    await page
      .getByText(step.advance.button, { exact: true })
      .filter({ visible: true })
      .first()
      .click({ timeout: 8000 });
  }
}

/**
 * Advance an intermediate step and verify the transition. Because the validator
 * silently keeps you on the same step when a field is rejected, "advanced" is the
 * true acceptance signal: the step's unique signature phrase is no longer visible
 * (falling back to the first field's control disappearing if no signature is set).
 */
export async function advanceStep(page: Page, step: StepSpec, logger: Logger): Promise<boolean> {
  const fallback = step.fields.find((f) => f.required) ?? step.fields[0];
  await clickAdvance(page, step);

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const stillOnStep = step.signature
      ? (await page.getByText(step.signature, { exact: false }).filter({ visible: true }).count()) > 0
      : fallback
        ? await fieldVisible(page, fallback)
        : false;
    if (!stillOnStep) {
      logger.info("step.advanced", { step: step.id });
      return true;
    }
  }
  logger.warn("step.did_not_advance", { step: step.id });
  return false;
}

import type { Page } from "playwright";
import type { Patient } from "../patient/schema.js";
import type { FieldSpec, InteractionSpec, StepSpec } from "../recipe/schema.js";
import type { Logger } from "../logging/logger.js";
import { guardStep } from "../browser/guard.js";
import { fillField } from "../browser/field.js";
import { getByPath } from "../util/path.js";

export type FillStepResult =
  | { status: "ok" }
  | { status: "page_mismatch"; missing: string[] }
  | { status: "validation_failed"; fieldKey: string; detail?: string };

function isChoice(field: FieldSpec): boolean {
  return field.type === "radio" || field.type === "select" || field.type === "checkbox";
}

/** Resolve a patient value to the string the field expects. */
function formatValue(field: FieldSpec, raw: unknown): string {
  if (isChoice(field)) return String(raw); // enum key; fillField maps it via label_map
  if (
    field.type === "date" &&
    typeof raw === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(raw)
  ) {
    // US forms commonly use MM/DD/YYYY — confirm exact format during mapping.
    const [y, m, d] = raw.split("-");
    return `${m}/${d}/${y}`;
  }
  return String(raw);
}

function isEmpty(raw: unknown): boolean {
  return raw === undefined || raw === null || raw === "";
}

/** Guard the step against the recipe, then fill every field and verify acceptance. */
export async function fillStep(
  page: Page,
  step: StepSpec,
  patient: Patient,
  interaction: InteractionSpec,
  logger: Logger,
): Promise<FillStepResult> {
  const guard = await guardStep(page, step);
  if (!guard.ok) {
    logger.warn("step.page_mismatch", { step: step.id, missing: guard.missing });
    return { status: "page_mismatch", missing: guard.missing };
  }

  for (const field of step.fields) {
    const raw = getByPath(patient, field.key);
    if (isEmpty(raw)) {
      if (field.required) {
        // collectNeeds should have caught this pre-run; halt rather than partial-fill.
        return {
          status: "validation_failed",
          fieldKey: field.key,
          detail: "required value missing at runtime",
        };
      }
      continue; // optional + absent
    }

    const outcome = await fillField(page, field, formatValue(field, raw), interaction, logger);
    if (!outcome.accepted) {
      logger.warn("step.field_rejected", { step: step.id, key: field.key, method: outcome.method });
      return { status: "validation_failed", fieldKey: field.key, detail: outcome.detail };
    }
  }

  logger.info("step.filled", { step: step.id, fieldCount: step.fields.length });
  return { status: "ok" };
}

/** Click the step's advance button (Continue / Submit). */
export async function advanceStep(page: Page, step: StepSpec, logger: Logger): Promise<void> {
  if (!step.advance) return;
  const button = page.getByRole("button", { name: step.advance.button, exact: false }).first();
  try {
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ timeout: 8000 });
  } catch {
    // Some SPAs render advance controls as links/divs, not <button>.
    await page.getByText(step.advance.button, { exact: false }).first().click({ timeout: 8000 });
  }
  logger.info("step.advanced", { step: step.id, button: step.advance.button });
}

import type { Page } from "playwright";
import type { StepSpec } from "../recipe/schema.js";

/**
 * Page-match guard. Before filling a step, confirm the live form still matches the
 * recipe: every expected field label and the advance button must be present and
 * visible. If anything is missing the runner HALTS rather than guessing — never
 * submit into a form whose structure has drifted from the recipe.
 */

export interface GuardResult {
  ok: boolean;
  missing: string[];
}

async function isVisibleText(page: Page, text: string, timeout: number): Promise<boolean> {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function isVisibleButton(page: Page, name: string, timeout: number): Promise<boolean> {
  try {
    await page
      .getByRole("button", { name, exact: false })
      .first()
      .waitFor({ state: "visible", timeout });
    return true;
  } catch {
    // Some custom SPAs render advance controls as links/divs, not <button>.
    return isVisibleText(page, name, timeout);
  }
}

function labelsForField(field: StepSpec["fields"][number]): string[] {
  if (field.type === "radio" || field.type === "select" || field.type === "checkbox") {
    return Object.values(field.label_map ?? {});
  }
  return field.label ? [field.label] : [];
}

export async function guardStep(
  page: Page,
  step: StepSpec,
  timeoutMs = 8000,
): Promise<GuardResult> {
  const missing: string[] = [];

  for (const field of step.fields) {
    for (const label of labelsForField(field)) {
      if (!(await isVisibleText(page, label, timeoutMs))) missing.push(label);
    }
  }

  if (step.advance) {
    if (!(await isVisibleButton(page, step.advance.button, timeoutMs))) {
      missing.push(`button:${step.advance.button}`);
    }
  }

  return { ok: missing.length === 0, missing };
}

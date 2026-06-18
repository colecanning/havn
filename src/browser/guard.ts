import type { Page } from "playwright";
import type { FieldSpec, StepSpec } from "../recipe/schema.js";

/**
 * Page-match guard. Before filling a step, confirm the live form still matches the
 * recipe: every REQUIRED field and the advance button must be present and visible.
 * (Optional fields are skipped — many are conditional and only appear after another
 * choice.) If a required field is missing the runner HALTS rather than guessing —
 * never submit into a form whose structure has drifted from the recipe.
 *
 * Everything is filtered to visible because the DOM holds hidden duplicate copies.
 */

export interface GuardResult {
  ok: boolean;
  missing: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function anyVisible(page: Page, makeCount: () => Promise<number>): Promise<boolean> {
  try {
    return (await makeCount()) > 0;
  } catch {
    return false;
  }
}

async function fieldPresent(page: Page, field: FieldSpec): Promise<boolean> {
  if (field.type === "radio") {
    for (const t of Object.values(field.label_map ?? {})) {
      if (await anyVisible(page, () => page.getByText(t, { exact: false }).filter({ visible: true }).count())) {
        return true;
      }
    }
    return false;
  }
  if (field.name) {
    if (await anyVisible(page, () => page.locator(`[name=${JSON.stringify(field.name)}]`).filter({ visible: true }).count())) {
      return true;
    }
  }
  if (field.label) {
    if (await anyVisible(page, () => page.getByText(field.label as string, { exact: false }).filter({ visible: true }).count())) {
      return true;
    }
  }
  return false;
}

async function buttonPresent(page: Page, name: string): Promise<boolean> {
  if (await anyVisible(page, () => page.getByRole("button", { name, exact: false }).filter({ visible: true }).count())) {
    return true;
  }
  return anyVisible(page, () => page.getByText(name, { exact: false }).filter({ visible: true }).count());
}

function fieldLabel(field: FieldSpec): string {
  if (field.type === "radio") return Object.values(field.label_map ?? {})[0] ?? field.key;
  return field.label ?? field.name ?? field.key;
}

export async function guardStep(page: Page, step: StepSpec, timeoutMs = 8000): Promise<GuardResult> {
  // Conditional fields are revealed only after another choice, so they are not part
  // of the step's initial signature — guard on required, non-conditional fields.
  const required = step.fields.filter((f) => f.required && !f.conditional);
  const deadline = Date.now() + timeoutMs;
  let missing: string[] = [];

  do {
    missing = [];
    for (const field of required) {
      if (!(await fieldPresent(page, field))) missing.push(fieldLabel(field));
    }
    if (step.advance && !(await buttonPresent(page, step.advance.button))) {
      missing.push(`button:${step.advance.button}`);
    }
    if (missing.length === 0) return { ok: true, missing: [] };
    await sleep(250);
  } while (Date.now() < deadline);

  return { ok: false, missing };
}

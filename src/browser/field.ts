import type { Locator, Page } from "playwright";
import type { FieldSpec, InteractionSpec } from "../recipe/schema.js";
import type { Logger } from "../logging/logger.js";
import { humanType } from "./human.js";

/**
 * Field interaction, tuned to the live AbbVie form (an AEM Adaptive Form).
 *
 * Ground truth confirmed by mapping:
 *  - The DOM holds hidden duplicate/template copies of every field, so EVERY locator
 *    must be filtered to visible.
 *  - Programmatic value-setting (.fill / set .value) populates the box but the form's
 *    validator ignores it and refuses to advance. Real key events work, so text is
 *    entered with pressSequentially.
 *  - Text inputs and the state <select> have clean, stable `name` attributes; radios
 *    have auto-generated names, so radios are clicked by visible label text.
 *  - Per-field acceptance shows as a green bar (ok) / red indicator (error); the DOM
 *    signal is aria-invalid, which we read as the accepted cue.
 */

export interface FillOutcome {
  accepted: boolean;
  method: string;
  detail?: string;
}

const ACTION_TIMEOUT = 8000;
/** Pause after a radio/select choice so conditional re-renders settle. */
const SETTLE_AFTER_CHOICE = 700;

async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

/** Visible-filtered base locator for a non-radio field (by name, else by label). */
function baseLocator(page: Page, field: FieldSpec): Locator {
  if (field.name) {
    return page.locator(`[name=${JSON.stringify(field.name)}]`).filter({ visible: true });
  }
  return page.getByLabel(field.label ?? "", { exact: false }).filter({ visible: true });
}

/** True when the field currently has a visible control on the page. */
export async function fieldVisible(page: Page, field: FieldSpec): Promise<boolean> {
  if (field.type === "radio") {
    for (const text of Object.values(field.label_map ?? {})) {
      if (await safeCount(page.getByText(text, { exact: false }).filter({ visible: true }))) {
        return true;
      }
    }
    return false;
  }
  return (await safeCount(baseLocator(page, field))) > 0;
}

/** Poll until the field becomes visible, for conditional fields that render late. */
export async function waitFieldVisible(
  page: Page,
  field: FieldSpec,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await fieldVisible(page, field)) return true;
    await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return false;
}

/** aria-invalid="true" is the form's per-field rejection signal (red indicator). */
async function isAccepted(loc: Locator): Promise<boolean> {
  const ariaInvalid = await loc.getAttribute("aria-invalid").catch(() => null);
  return ariaInvalid !== "true";
}

async function fillText(
  page: Page,
  field: FieldSpec,
  value: string,
  interaction: InteractionSpec,
  humanize: boolean,
): Promise<FillOutcome> {
  const loc = baseLocator(page, field).first();
  const method = humanize ? "humanType" : "type";
  try {
    if (humanize) {
      await humanType(page, loc, value);
    } else {
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: ACTION_TIMEOUT });
      await loc.press("ControlOrMeta+a").catch(() => {});
      await loc.press("Delete").catch(() => {});
      await loc.pressSequentially(value, { delay: 28, timeout: ACTION_TIMEOUT });
    }
    for (const ev of interaction.events) {
      if (ev === "blur") continue;
      await loc.dispatchEvent(ev).catch(() => {});
    }
    await loc.blur().catch(() => {});
  } catch (err) {
    return { accepted: false, method, detail: (err as Error).message };
  }
  await page.waitForTimeout(150);
  const accepted = !interaction.verify_field_state || (await isAccepted(loc));
  return accepted
    ? { accepted: true, method }
    : { accepted: false, method, detail: "field rejected (aria-invalid)" };
}

async function fillSelect(page: Page, field: FieldSpec, value: string): Promise<FillOutcome> {
  const loc = baseLocator(page, field).first();
  const optionValue = field.label_map?.[value] ?? value;
  try {
    await loc.selectOption(optionValue).catch(() => loc.selectOption({ label: optionValue }));
    await loc.dispatchEvent("change").catch(() => {});
    await loc.blur().catch(() => {});
  } catch (err) {
    return { accepted: false, method: "select", detail: (err as Error).message };
  }
  // Let any conditional re-render settle before the next field is touched.
  await page.waitForTimeout(SETTLE_AFTER_CHOICE);
  return { accepted: true, method: "select", detail: optionValue };
}

async function fillRadio(page: Page, field: FieldSpec, value: string): Promise<FillOutcome> {
  const text = field.label_map?.[value];
  if (!text) {
    return { accepted: false, method: "radio", detail: `no label_map entry for "${value}"` };
  }
  // Exact first (so "Male" doesn't match "Female"), then fall back to substring.
  const exact = page.getByText(text, { exact: true }).filter({ visible: true });
  const loc = (await safeCount(exact))
    ? exact.first()
    : page.getByText(text, { exact: false }).filter({ visible: true }).first();
  try {
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.click({ timeout: ACTION_TIMEOUT });
  } catch (err) {
    return { accepted: false, method: "radio", detail: (err as Error).message };
  }
  // A selection can reveal/reset conditional fields — let that settle before the
  // next field is filled (otherwise typing into a just-revealed field gets wiped).
  await page.waitForTimeout(SETTLE_AFTER_CHOICE);
  return { accepted: true, method: "radio.click", detail: text };
}

/** Fill one field with native events and verify acceptance. `value` is pre-formatted. */
export async function fillField(
  page: Page,
  field: FieldSpec,
  value: string,
  interaction: InteractionSpec,
  logger: Logger,
  humanize = false,
): Promise<FillOutcome> {
  let outcome: FillOutcome;
  if (field.type === "radio") outcome = await fillRadio(page, field, value);
  else if (field.type === "select") outcome = await fillSelect(page, field, value);
  else outcome = await fillText(page, field, value, interaction, humanize);

  logger.debug("field.fill", { key: field.key, method: outcome.method, accepted: outcome.accepted });
  return outcome;
}

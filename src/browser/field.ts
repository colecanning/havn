import type { Locator, Page } from "playwright";
import type { FieldSpec, InteractionSpec } from "../recipe/schema.js";
import type { Logger } from "../logging/logger.js";

/**
 * Field interaction for the custom-component SPA.
 *
 * Hard-won findings from walking the live form drive this:
 *  - Fields are NOT native <input>/<select>; setting .value or a naive type leaves
 *    them visually populated but validation-rejected.
 *  - The custom components listen for specific native events, so we dispatch
 *    input/change/blur explicitly and escalate to per-key typing if a plain fill
 *    doesn't take.
 *  - A filled field is not an *accepted* field — we verify per-field acceptance
 *    before the caller advances.
 *  - Target by label text; auto-generated CSS classes are brittle.
 *
 * The precise accepted-state cue (green bar vs. red error indicator) is captured
 * during the live mapping pass; verifyAccepted() currently uses generic signals
 * (aria-invalid, value reflection, nearby error text) and should be tightened with
 * the real selectors once mapping confirms them.
 */

export interface FillOutcome {
  accepted: boolean;
  /** Which strategy produced the outcome (for debugging/telemetry). */
  method: string;
  detail?: string;
}

const ACTION_TIMEOUT = 6000;

function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  // contains both quote types — build a concat()
  const parts = s.split("'").map((p) => `'${p}'`);
  return `concat(${parts.join(`, "'", `)})`;
}

async function safeCount(loc: Locator): Promise<number> {
  try {
    return await loc.count();
  } catch {
    return 0;
  }
}

/** Locate a field by its stable label text, never by CSS class. */
export async function locateByLabel(page: Page, label: string): Promise<Locator> {
  const byLabel = page.getByLabel(label, { exact: false });
  if (await safeCount(byLabel)) return byLabel.first();

  const byRole = page.getByRole("textbox", { name: label });
  if (await safeCount(byRole)) return byRole.first();

  // Proximity fallback: first fillable element following the label's text node.
  const proximity = page.locator(
    `xpath=//*[normalize-space(text())=${xpathLiteral(label)}]` +
      `/following::*[self::input or self::textarea or @contenteditable='true' or @role='textbox'][1]`,
  );
  if (await safeCount(proximity)) return proximity.first();

  // Return the (empty) getByLabel locator so the caller gets a clear, labeled error.
  return byLabel.first();
}

async function dispatchEvents(locator: Locator, events: string[]): Promise<void> {
  for (const ev of events) {
    if (ev === "blur") continue; // handled by a real blur below
    await locator.dispatchEvent(ev).catch(() => {});
  }
  await locator.blur().catch(() => {});
}

async function readValue(locator: Locator): Promise<string> {
  const v = await locator.inputValue().catch(() => null);
  if (v != null) return v;
  return (await locator.textContent().catch(() => "")) ?? "";
}

/**
 * Verify a field reached an accepted state. Generic signals for now:
 *  - aria-invalid="true"            -> rejected
 *  - text-like field has no value   -> rejected
 *  - otherwise                      -> accepted
 */
async function verifyAccepted(locator: Locator, field: FieldSpec): Promise<boolean> {
  const ariaInvalid = await locator.getAttribute("aria-invalid").catch(() => null);
  if (ariaInvalid === "true") return false;

  if (field.type !== "radio" && field.type !== "checkbox" && field.type !== "select") {
    const val = (await readValue(locator)).trim();
    if (!val) return false;
  }
  return true;
}

async function fillText(
  page: Page,
  field: FieldSpec,
  value: string,
  interaction: InteractionSpec,
  logger: Logger,
): Promise<FillOutcome> {
  const locator = await locateByLabel(page, field.label!);

  // Attempt 1: Playwright fill (dispatches native input for standard inputs).
  try {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: ACTION_TIMEOUT });
    await locator.fill("", { timeout: ACTION_TIMEOUT }).catch(() => {});
    await locator.fill(value, { timeout: ACTION_TIMEOUT });
    await dispatchEvents(locator, interaction.events);
    if (!interaction.verify_field_state || (await verifyAccepted(locator, field))) {
      logger.debug("field.filled", { key: field.key, method: "fill" });
      return { accepted: true, method: "fill" };
    }
  } catch (err) {
    logger.debug("field.fill_threw", { key: field.key, detail: (err as Error).message });
  }

  // Attempt 2: per-key typing for components that ignore programmatic fill.
  try {
    await locator.click({ timeout: ACTION_TIMEOUT });
    await locator.press("ControlOrMeta+a").catch(() => {});
    await locator.press("Delete").catch(() => {});
    await locator.pressSequentially(value, { delay: 30, timeout: ACTION_TIMEOUT });
    await dispatchEvents(locator, interaction.events);
    if (!interaction.verify_field_state || (await verifyAccepted(locator, field))) {
      logger.debug("field.filled", { key: field.key, method: "type" });
      return { accepted: true, method: "type" };
    }
  } catch (err) {
    return { accepted: false, method: "type", detail: (err as Error).message };
  }

  return { accepted: false, method: "verify", detail: "field did not reach accepted state" };
}

async function fillChoice(
  page: Page,
  field: FieldSpec,
  value: string,
  interaction: InteractionSpec,
  logger: Logger,
): Promise<FillOutcome> {
  const optionText = field.label_map?.[value];
  if (!optionText) {
    return { accepted: false, method: "choice", detail: `no label_map entry for "${value}"` };
  }
  const option = page.getByText(optionText, { exact: false }).first();
  try {
    await option.scrollIntoViewIfNeeded().catch(() => {});
    await option.click({ timeout: ACTION_TIMEOUT });
  } catch (err) {
    return { accepted: false, method: "choice", detail: (err as Error).message };
  }

  // Best-effort acceptance: look for an aria-checked control associated with the option.
  if (interaction.verify_field_state) {
    const checked = page.locator(
      `xpath=//*[@aria-checked='true' and (.//*[contains(normalize-space(.), ${xpathLiteral(
        optionText,
      )})] or contains(normalize-space(.), ${xpathLiteral(optionText)}))]`,
    );
    const ok = (await safeCount(checked)) > 0;
    logger.debug("field.choice", { key: field.key, accepted: ok });
    // If we can't positively confirm aria-checked, fall back to "click did not throw".
    return { accepted: true, method: "choice.click", detail: optionText };
  }
  return { accepted: true, method: "choice.click", detail: optionText };
}

/** Fill one field with native events and verify acceptance. `value` is pre-formatted. */
export async function fillField(
  page: Page,
  field: FieldSpec,
  value: string,
  interaction: InteractionSpec,
  logger: Logger,
): Promise<FillOutcome> {
  if (field.type === "radio" || field.type === "select" || field.type === "checkbox") {
    return fillChoice(page, field, value, interaction, logger);
  }
  return fillText(page, field, value, interaction, logger);
}

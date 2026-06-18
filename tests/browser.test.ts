import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { FieldSpec, StepSpec, InteractionSpec } from "../src/recipe/schema.js";
import { fillField, fieldVisible } from "../src/browser/field.js";
import { guardStep } from "../src/browser/guard.js";
import { createLogger } from "../src/logging/logger.js";

// A fixture that mimics the form's traps: a HIDDEN duplicate of every field plus the
// real visible one, native-named text inputs, and label-wrapped radios.
const FIXTURE = `
<!doctype html><html><body>
  <div style="display:none">
    <label>First Name</label><input name="fname" value="GHOST">
    <label>Color</label>
  </div>
  <form>
    <label for="fn">First Name</label>
    <input id="fn" name="fname" aria-label="First Name" />
    <fieldset>
      <label><input type="radio" name="color" /> Red</label>
      <label><input type="radio" name="color" /> Blue</label>
    </fieldset>
    <button type="button">Continue</button>
  </form>
</body></html>`;

const interaction = InteractionSpec.parse({});
const logger = createLogger({ level: "error" });

const fnameField = FieldSpec.parse({ key: "first_name", type: "text", name: "fname", label: "First Name" });
const colorField = FieldSpec.parse({
  key: "color",
  type: "radio",
  label_map: { red: "Red", blue: "Blue" },
});

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

async function load() {
  page = await browser.newPage();
  await page.setContent(FIXTURE);
}

describe("field fill against a fixture", () => {
  it("types into the VISIBLE input, ignoring the hidden duplicate", async () => {
    await load();
    const out = await fillField(page, fnameField, "Alice", interaction, logger);
    expect(out.accepted).toBe(true);
    const value = await page.locator("#fn").inputValue();
    expect(value).toBe("Alice"); // not "GHOST"
    await page.close();
  });

  it("selects a radio by visible label text", async () => {
    await load();
    const out = await fillField(page, colorField, "blue", interaction, logger);
    expect(out.accepted).toBe(true);
    const checked = await page.evaluate(
      `[...document.querySelectorAll('input[type=radio]')].filter(r=>r.checked).length`,
    );
    expect(checked).toBe(1);
    await page.close();
  });

  it("fieldVisible is true for a present field", async () => {
    await load();
    expect(await fieldVisible(page, fnameField)).toBe(true);
    await page.close();
  });
});

describe("page-match guard against a fixture", () => {
  it("passes when all required fields + the advance button are visible", async () => {
    await load();
    const step = StepSpec.parse({
      id: "s",
      mapped: true,
      fields: [fnameField, colorField],
      advance: { button: "Continue" },
    });
    const r = await guardStep(page, step, 1500);
    expect(r.ok).toBe(true);
    await page.close();
  });

  it("halts (page_mismatch) when a required field is missing from the live page", async () => {
    await load();
    const step = StepSpec.parse({
      id: "s",
      mapped: true,
      fields: [FieldSpec.parse({ key: "ssn", type: "text", name: "ssn", label: "Social Security Number" })],
      advance: { button: "Continue" },
    });
    const r = await guardStep(page, step, 1500);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("Social Security Number");
    await page.close();
  });
});

import type { Locator, Page } from "playwright";

/**
 * Human-like behavior. Real users type unevenly, make and fix mistakes, pause between
 * fields, and scroll while reading. Emulating that raises the invisible reCAPTCHA score.
 * It's a nudge, not a guarantee — and it makes runs much slower (that's the point).
 */

export function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function pick(s: string): string {
  return s[Math.floor(Math.random() * s.length)] ?? "";
}

/** A plausible wrong keystroke for a character (same class, different value). */
function wrongChar(ch: string): string {
  if (/[a-z]/.test(ch)) return pick("abcdefghijklmnopqrstuvwxyz".replace(ch, ""));
  if (/[A-Z]/.test(ch)) return pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ".replace(ch, ""));
  if (/[0-9]/.test(ch)) return pick("0123456789".replace(ch, ""));
  return ch;
}

/** Chance per alphanumeric character of fumbling it and backspacing to fix it. */
const TYPO_RATE = 0.08;

/** A short, human-like pause. */
export async function humanPause(page: Page, min = 300, max = 800): Promise<void> {
  await page.waitForTimeout(randomBetween(min, max));
}

/** Drift the mouse across a few points (e.g. before a click). */
export async function humanMouse(page: Page): Promise<void> {
  const steps = randomBetween(2, 4);
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(randomBetween(120, 1160), randomBetween(140, 760), {
      steps: randomBetween(3, 8),
    });
    await page.waitForTimeout(randomBetween(40, 130));
  }
}

/** Scroll the page slowly, as if reading, then ease back up a little. */
export async function humanScroll(page: Page): Promise<void> {
  const downs = randomBetween(2, 5);
  for (let i = 0; i < downs; i++) {
    await page.mouse.wheel(0, randomBetween(120, 320));
    await page.waitForTimeout(randomBetween(350, 850));
  }
  await page.mouse.wheel(0, -randomBetween(80, 220));
  await page.waitForTimeout(randomBetween(300, 700));
}

/**
 * Type into a field the way a person does: focus, clear, then key-by-key with uneven
 * timing, occasional typos that get backspaced and corrected, and the odd "thinking"
 * pause. Leaves the field holding exactly `value`.
 */
export async function humanType(page: Page, locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click();
  await locator.press("ControlOrMeta+a").catch(() => {});
  await locator.press("Delete").catch(() => {});
  await page.waitForTimeout(randomBetween(200, 550));

  for (const ch of value) {
    if (Math.random() < TYPO_RATE && /[a-zA-Z0-9]/.test(ch)) {
      await page.keyboard.type(wrongChar(ch));
      await page.waitForTimeout(randomBetween(150, 420)); // notice the slip
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(randomBetween(90, 230));
    }
    await page.keyboard.type(ch);
    await page.waitForTimeout(randomBetween(90, 260)); // uneven keystroke cadence
    if (Math.random() < 0.06) await page.waitForTimeout(randomBetween(350, 950)); // brief pause
  }
}

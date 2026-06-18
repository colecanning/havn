import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { StepSpec } from "../recipe/schema.js";
import type { Confirmation, ReadyCapture } from "../core/types.js";
import type { Logger } from "../logging/logger.js";
import { runDir } from "../util/artifacts.js";

/** Screenshot the Confirm step when submit is off (default) and we stop short of Submit. */
export async function captureReady(
  page: Page,
  step: StepSpec,
  artifactDir: string,
  runId: string,
  logger: Logger,
): Promise<ReadyCapture> {
  const dir = runDir(artifactDir, runId);
  const screenshotPath = join(dir, `ready-${step.id}.png`);
  await page
    .screenshot({ path: screenshotPath, fullPage: true })
    .catch((e: Error) => logger.warn("screenshot.failed", { detail: e.message }));
  return {
    step: step.id,
    screenshotPath,
    note: "submit disabled (default) — filled through Confirm and stopped before final Submit",
  };
}

/** Search the page's visible text for a value following one of the label patterns. */
async function scrapeLabeledValue(page: Page, patterns: RegExp[]): Promise<string | undefined> {
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) {
        const after = line.slice((m.index ?? 0) + m[0].length).replace(/^[:\s#-]+/, "").trim();
        if (after) return after.split(/\s{2,}/)[0];
      }
    }
  }
  return undefined;
}

/**
 * On a successful submitted enrollment: screenshot the confirmation page and capture
 * any card id / confirmation number for records. Persists a PII-safe JSON record
 * (identifiers + runId + timestamp, not raw patient PII).
 */
export async function captureConfirmation(
  page: Page,
  artifactDir: string,
  runId: string,
  logger: Logger,
): Promise<Confirmation> {
  const dir = runDir(artifactDir, runId);
  const screenshotPath = join(dir, "confirmation.png");
  await page
    .screenshot({ path: screenshotPath, fullPage: true })
    .catch((e: Error) => logger.warn("screenshot.failed", { detail: e.message }));

  const cardId = await scrapeLabeledValue(page, [/card\s*id/i, /savings\s*card/i, /member\s*id/i]);
  const confirmationNumber = await scrapeLabeledValue(page, [
    /confirmation\s*(number|no\.?|#)/i,
    /reference\s*(number|no\.?|#)/i,
  ]);

  const confirmation: Confirmation = {
    url: page.url(),
    screenshotPath,
    runId,
    capturedAt: new Date().toISOString(),
    ...(cardId ? { cardId } : {}),
    ...(confirmationNumber ? { confirmationNumber } : {}),
  };

  writeFileSync(join(dir, "confirmation.json"), JSON.stringify(confirmation, null, 2));
  logger.info("enrollment.confirmed", {
    runId,
    hasCardId: !!cardId,
    hasConfirmationNumber: !!confirmationNumber,
  });
  return confirmation;
}

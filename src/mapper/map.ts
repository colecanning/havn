import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { Patient } from "../patient/schema.js";
import { loadRecipe } from "../recipe/load.js";
import { createLogger } from "../logging/logger.js";
import { launchSession } from "../browser/session.js";
import { runPreflight } from "../browser/preflight.js";
import { fillStep, advanceStep } from "../runner/step.js";
import { runDir } from "../util/artifacts.js";
import { makeRunId } from "../util/runId.js";
import { testEmail } from "../patient/testEmail.js";

/**
 * Live form mapper. Drives the real enrollment form with DUMMY data to discover and
 * record the fields/labels/validation of not-yet-mapped steps, so they can be turned
 * into recipe YAML by hand.
 *
 * Iterative by design: it fills every already-mapped step with dummy data, advances,
 * and STOPS at the first unmapped step — snapshotting it (screenshot + DOM controls)
 * for a human to translate into the recipe. Re-run after each step is added to reach
 * the next. It NEVER clicks an irreversible Submit, even when the Confirm step is
 * mapped — mapping creates no real enrollment.
 */

export interface ControlSnapshot {
  tag: string;
  role: string;
  type: string;
  name: string;
  placeholder: string;
  ariaLabel: string;
  text: string;
}

export interface StepSnapshot {
  stepId: string;
  mapped: boolean;
  url: string;
  screenshot: string;
  labels: string[];
  controls: ControlSnapshot[];
}

export interface MapReport {
  runId: string;
  recipe: string;
  startedAt: string;
  stoppedReason: string;
  steps: StepSnapshot[];
  reportPath: string;
}

export interface MapOptions {
  recipePath: string;
  headful?: boolean;
  slowMo?: number;
  artifactDir?: string;
  runId?: string;
  /** Base inbox for the dummy email alias. */
  testEmailBase?: string;
}

/** Dummy data plausible enough to clear per-step validation while mapping. */
function dummyPatient(runId: string, emailBase: string): Patient {
  return {
    diagnosis: "plaque_psoriasis",
    first_name: "Test",
    last_name: "Mapper",
    email: testEmail(`${runId}-map`, emailBase),
    date_of_birth: "1985-04-12",
    address: { line1: "123 Test Street", city: "Columbus", state: "OH", zip: "43215" },
    phone: "6145551234",
    insurance_type: "commercial",
  };
}

async function snapshotStep(
  page: Page,
  stepId: string,
  mapped: boolean,
  dir: string,
): Promise<StepSnapshot> {
  const screenshot = join(dir, `${stepId}.png`);
  await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});

  const dom = await page
    .evaluate(() => {
      const labels = new Set<string>();
      document
        .querySelectorAll('label, legend, [role="radio"], [role="checkbox"], [aria-label]')
        .forEach((el) => {
          const t = (el.textContent || el.getAttribute("aria-label") || "").trim();
          if (t && t.length < 200) labels.add(t);
        });
      const controls: ControlSnapshot[] = [];
      document
        .querySelectorAll(
          'input, textarea, select, [role="textbox"], [contenteditable="true"], button, [role="button"]',
        )
        .forEach((el) => {
          controls.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || "",
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name") || "",
            placeholder: el.getAttribute("placeholder") || "",
            ariaLabel: el.getAttribute("aria-label") || "",
            text: (el.textContent || "").trim().slice(0, 80),
          });
        });
      return { labels: Array.from(labels), controls };
    })
    .catch(() => ({ labels: [] as string[], controls: [] as ControlSnapshot[] }));

  const snapshot: StepSnapshot = {
    stepId,
    mapped,
    url: page.url(),
    screenshot,
    labels: dom.labels,
    controls: dom.controls,
  };
  writeFileSync(join(dir, `${stepId}.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

export async function mapForm(opts: MapOptions): Promise<MapReport> {
  const runId = opts.runId ?? makeRunId("map");
  const artifactDir = opts.artifactDir ?? "artifacts";
  const dir = runDir(join(artifactDir, "mapping"), runId);
  const logger = createLogger({ context: { runId, mode: "map" } });
  const recipe = loadRecipe(opts.recipePath);
  const dummy = dummyPatient(runId, opts.testEmailBase ?? "ccanning10@gmail.com");

  const session = await launchSession({ headful: opts.headful ?? true, slowMo: opts.slowMo });
  const steps: StepSnapshot[] = [];
  let stoppedReason = "completed all mapped steps";

  try {
    const { page } = session;
    await page.goto(recipe.url, { waitUntil: "domcontentloaded" });
    await runPreflight(page, recipe.preflight, logger);

    for (const step of recipe.steps) {
      const snap = await snapshotStep(page, step.id, step.mapped, dir);
      steps.push(snap);

      if (!step.mapped) {
        stoppedReason = `stopped at first unmapped step "${step.id}" — translate it into the recipe and re-run`;
        logger.info("map.stop_unmapped", { step: step.id });
        break;
      }

      if (step.advance?.irreversible) {
        stoppedReason = `reached Confirm step "${step.id}" — STOP before Submit (mapping never submits)`;
        logger.info("map.stop_confirm", { step: step.id });
        break;
      }

      const fill = await fillStep(page, step, dummy, recipe.interaction, logger);
      if (fill.status !== "ok") {
        stoppedReason = `could not fill mapped step "${step.id}" (${fill.status}) — fix the recipe/data and re-run`;
        logger.warn("map.fill_failed", { step: step.id, status: fill.status });
        break;
      }
      await advanceStep(page, step, logger);
    }
  } finally {
    await session.close();
  }

  const reportPath = join(dir, "report.json");
  const report: MapReport = {
    runId,
    recipe: opts.recipePath,
    startedAt: new Date().toISOString(),
    stoppedReason,
    steps,
    reportPath,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  logger.info("map.done", { reportPath, steps: steps.length, stoppedReason });
  return report;
}

#!/usr/bin/env -S npx tsx
import "dotenv/config";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { enroll } from "./core/enroll.js";
import { parsePatient } from "./patient/schema.js";
import { collectNeeds } from "./patient/validate.js";
import { loadRecipe } from "./recipe/load.js";
import { testEmail } from "./patient/testEmail.js";
import { makeRunId } from "./util/runId.js";
import { mapForm } from "./mapper/map.js";
import { launchSession } from "./browser/session.js";
import type { EnrollResult } from "./core/types.js";

const DEFAULT_RECIPE = "recipes/skyrizi.yaml";
const DEFAULT_TEST_EMAIL = "ccanning10@gmail.com";

function envBool(name: string, def = false): boolean {
  const v = process.env[name];
  if (v == null) return def;
  return /^(1|true|yes|on)$/i.test(v);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Exit codes are distinct per terminal status so callers/scripts can branch. */
function exitCodeFor(status: EnrollResult["status"]): number {
  switch (status) {
    case "submitted":
    case "ready_to_submit":
      return 0;
    case "error":
      return 1;
    case "needs_info":
      return 2;
    case "ineligible":
      return 3;
    case "page_mismatch":
      return 4;
    case "validation_failed":
      return 5;
    case "unmapped_step":
      return 6;
  }
}

/** Human-readable summary. Never prints raw patient PII — only statuses/identifiers. */
function presentResult(result: EnrollResult): void {
  switch (result.status) {
    case "needs_info":
      console.log(`NEEDS INFO — ${result.needs.length} required field(s) missing:`);
      for (const n of result.needs) console.log(`  - ${n.key} (step: ${n.step}, type: ${n.type})`);
      break;
    case "ineligible":
      console.log(`INELIGIBLE — ${result.reason}`);
      break;
    case "unmapped_step":
      console.log(`UNMAPPED STEP — ${result.message}`);
      break;
    case "page_mismatch":
      console.log(`PAGE MISMATCH at step "${result.step}". Missing on live form:`);
      for (const m of result.missingLabels) console.log(`  - ${m}`);
      console.log("Halted — the live form has drifted from the recipe. Re-map before running.");
      break;
    case "validation_failed":
      console.log(
        `VALIDATION FAILED at step "${result.step}", field "${result.fieldKey}"` +
          (result.detail ? ` — ${result.detail}` : ""),
      );
      break;
    case "ready_to_submit":
      console.log("READY TO SUBMIT — filled through Confirm and stopped.");
      console.log(`  Confirm screenshot: ${result.capture.screenshotPath}`);
      console.log(
        "  Skyrizi rejects automated Submit (reCAPTCHA). Use --handoff (+ --consent) to" +
          " open the browser and let a human click Submit.",
      );
      break;
    case "submitted":
      console.log("SUBMITTED — enrollment confirmed.");
      console.log(`  URL: ${result.confirmation.url}`);
      if (result.confirmation.cardId) console.log(`  Card ID: ${result.confirmation.cardId}`);
      if (result.confirmation.confirmationNumber)
        console.log(`  Confirmation #: ${result.confirmation.confirmationNumber}`);
      console.log(`  Screenshot: ${result.confirmation.screenshotPath}`);
      break;
    case "error":
      console.log(`ERROR — ${result.message}`);
      break;
  }
}

const program = new Command();
program
  .name("havn")
  .description("Havn co-pay assistance card enrollment agent (v1: Skyrizi / AbbVie)")
  .version("0.1.0");

program
  .command("validate")
  .description("Check a patient record against a recipe's required fields (no browser).")
  .argument("<patientFile>", "path to a patient JSON file")
  .option("-r, --recipe <path>", "recipe YAML", DEFAULT_RECIPE)
  .action((patientFile: string, opts: { recipe: string }) => {
    const recipe = loadRecipe(opts.recipe);
    const patient = parsePatient(readJson(patientFile));
    const needs = collectNeeds(patient, recipe);
    if (needs.length === 0) {
      console.log("OK — all required fields present.");
      process.exit(0);
    }
    console.log(`NEEDS INFO — ${needs.length} required field(s) missing:`);
    for (const n of needs) console.log(`  - ${n.key} (step: ${n.step}, type: ${n.type})`);
    process.exit(2);
  });

program
  .command("enroll")
  .description("Run a patient through the enrollment flow.")
  .argument("<patientFile>", "path to a patient JSON file")
  .option("--driver <name>", "execution backend: playwright (default) or os (no-CDP)", "playwright")
  .option("--submit", "auto-click the final Submit (rejected by reCAPTCHA on Skyrizi)", false)
  .option(
    "--handoff",
    "fill everything (incl. consent), open the browser, and let a human click Submit",
    false,
  )
  .option(
    "--consent",
    "patient consent obtained out-of-band; check the required consent box before Submit",
    false,
  )
  .option("--headful", "show the browser window", envBool("HAVN_HEADFUL"))
  .option("--channel <name>", "browser channel, e.g. 'chrome' for real Chrome")
  .option("--user-data-dir <path>", "reuse a persistent (warmed) browser profile dir")
  .option("--no-human", "disable human-like slow typing/scrolling/pauses (much faster)")
  .option("--test-email", "override patient email with the test dot-alias for this run", false)
  .option("-r, --recipe <path>", "recipe YAML", DEFAULT_RECIPE)
  .option("--run-id <id>", "stable id for this run (default: generated)")
  .option("--slowmo <ms>", "slow each action by N ms", (v: string) => parseInt(v, 10))
  .option("--artifact-dir <dir>", "artifacts directory", process.env.HAVN_ARTIFACT_DIR || "artifacts")
  .action(
    async (
      patientFile: string,
      opts: {
        driver: string;
        submit: boolean;
        handoff: boolean;
        consent: boolean;
        headful: boolean;
        channel?: string;
        userDataDir?: string;
        human: boolean;
        testEmail: boolean;
        recipe: string;
        runId?: string;
        slowmo?: number;
        artifactDir: string;
      },
    ) => {
      const runId = opts.runId ?? makeRunId("skyrizi");
      const raw = readJson(patientFile);
      if (opts.testEmail) {
        raw.email = testEmail(runId, process.env.HAVN_TEST_EMAIL || DEFAULT_TEST_EMAIL);
      }
      const patient = parsePatient(raw);
      const result = await enroll({
        recipePath: opts.recipe,
        patient,
        driver: opts.driver === "os" ? "os" : "playwright",
        submit: opts.submit,
        handoff: opts.handoff,
        consentObtained: opts.consent,
        headful: opts.headful,
        humanize: opts.human,
        ...(opts.channel ? { channel: opts.channel } : {}),
        ...(opts.userDataDir ? { userDataDir: opts.userDataDir } : {}),
        ...(opts.slowmo != null ? { slowMo: opts.slowmo } : {}),
        artifactDir: opts.artifactDir,
        runId,
      });
      presentResult(result);
      process.exit(exitCodeFor(result.status));
    },
  );

program
  .command("map")
  .description("Drive the live form with dummy data to map unmapped steps (never submits).")
  .option("--headless", "run headless (default: headful, for observation)", false)
  .option("-r, --recipe <path>", "recipe YAML", DEFAULT_RECIPE)
  .option("--run-id <id>", "stable id for this run (default: generated)")
  .option("--slowmo <ms>", "slow each action by N ms", (v: string) => parseInt(v, 10))
  .action(
    async (opts: { headless: boolean; recipe: string; runId?: string; slowmo?: number }) => {
      const report = await mapForm({
        recipePath: opts.recipe,
        headful: !opts.headless,
        ...(opts.slowmo != null ? { slowMo: opts.slowmo } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
        testEmailBase: process.env.HAVN_TEST_EMAIL || DEFAULT_TEST_EMAIL,
      });
      console.log(`\nMapping report: ${report.reportPath}`);
      console.log(`Stopped: ${report.stoppedReason}`);
      for (const s of report.steps) {
        console.log(
          `  - ${s.stepId} (${s.mapped ? "mapped" : "UNMAPPED"}): ` +
            `${s.labels.length} labels, ${s.controls.length} controls -> ${s.screenshot}`,
        );
      }
    },
  );

program
  .command("warm")
  .description(
    "Open a persistent Chrome profile so you can sign into Google + browse to build " +
      "reputation. Reuse the same --user-data-dir for enroll. Closes when you close Chrome.",
  )
  .requiredOption("--user-data-dir <path>", "profile directory to warm (reuse for enroll)")
  .option("--channel <name>", "browser channel", "chrome")
  .action(async (opts: { userDataDir: string; channel: string }) => {
    const session = await launchSession({
      headful: true,
      channel: opts.channel,
      userDataDir: opts.userDataDir,
    });
    await session.page.goto("https://www.google.com").catch(() => {});
    console.log(
      `Warming profile at ${opts.userDataDir}.\n` +
        "  - Sign into a Google account and browse normally for a while (the more, the better).\n" +
        "  - Then close the Chrome window. Reuse this dir: enroll --user-data-dir " +
        `${opts.userDataDir} --channel ${opts.channel} --headful`,
    );
    await new Promise<void>((resolve) => {
      session.context.on("close", () => resolve());
      setTimeout(resolve, 60 * 60 * 1000); // safety cap: 1h
    });
    await session.close();
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

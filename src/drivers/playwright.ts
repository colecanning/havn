import type { Page } from "playwright";
import type { Recipe, StepSpec, InteractionSpec } from "../recipe/schema.js";
import type { Patient } from "../patient/schema.js";
import type { Confirmation, FillStepResult, ReadyCapture } from "../core/types.js";
import type { DriverContext, EnrollDriver } from "./types.js";
import { launchSession, type Session } from "../browser/session.js";
import { runPreflight } from "../browser/preflight.js";
import { fillStep, advanceStep, clickAdvance, applyConsent } from "../runner/step.js";
import { captureReady, captureConfirmation } from "../runner/confirm.js";

/**
 * Deterministic CDP backend. A thin adapter over the existing Playwright code; all the
 * field-fill/guard/advance/consent/capture logic lives in browser/* and runner/*.
 *
 * Caveat: Playwright drives Chrome over the DevTools Protocol, which reCAPTCHA Enterprise
 * detects — so the final Submit on protected forms (Skyrizi) is rejected. Use the os
 * driver (no CDP) for actual submission. Everything up to Submit works great here.
 */
export class PlaywrightDriver implements EnrollDriver {
  private session?: Session;

  constructor(private readonly ctx: DriverContext) {}

  private get page(): Page {
    if (!this.session) throw new Error("PlaywrightDriver: open() was not called");
    return this.session.page;
  }

  async open(recipe: Recipe): Promise<void> {
    this.session = await launchSession({
      headful: this.ctx.headful,
      slowMo: this.ctx.slowMo,
      ...(this.ctx.channel ? { channel: this.ctx.channel } : {}),
      ...(this.ctx.userDataDir ? { userDataDir: this.ctx.userDataDir } : {}),
    });
    await this.page.goto(recipe.url, { waitUntil: "domcontentloaded" });
    await runPreflight(this.page, recipe.preflight, this.ctx.logger);
  }

  fillStep(step: StepSpec, patient: Patient, interaction: InteractionSpec): Promise<FillStepResult> {
    return fillStep(this.page, step, patient, interaction, this.ctx.logger, this.ctx.humanize);
  }

  advance(step: StepSpec): Promise<boolean> {
    return advanceStep(this.page, step, this.ctx.logger);
  }

  consent(step: StepSpec): Promise<boolean> {
    return applyConsent(this.page, step, this.ctx.logger);
  }

  async submit(step: StepSpec): Promise<void> {
    await clickAdvance(this.page, step);
  }

  async awaitSuccess(matchSubstr: string, timeoutMs: number): Promise<boolean> {
    try {
      await this.page.waitForURL((url) => url.toString().includes(matchSubstr), {
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  captureReady(step: StepSpec): Promise<ReadyCapture> {
    return captureReady(this.page, step, this.ctx.artifactDir, this.ctx.runId, this.ctx.logger);
  }

  captureConfirmation(): Promise<Confirmation> {
    return captureConfirmation(this.page, this.ctx.artifactDir, this.ctx.runId, this.ctx.logger);
  }

  async close(): Promise<void> {
    await this.session?.close();
  }
}

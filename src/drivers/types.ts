import type { Recipe, StepSpec, InteractionSpec } from "../recipe/schema.js";
import type { Patient } from "../patient/schema.js";
import type { Logger } from "../logging/logger.js";
import type { Confirmation, FillStepResult, ReadyCapture } from "../core/types.js";
import type { BrowserbaseConfig } from "../browser/browserbase.js";

/**
 * An enrollment backend. The orchestrator (core/enroll.ts) owns the driver-agnostic
 * flow (missing-info check, eligibility gate, submit/handoff gating, result shaping)
 * and delegates every browser interaction to a driver. Both backends consume the SAME
 * recipe + patient — only execution differs:
 *   - PlaywrightDriver: deterministic CDP automation
 *   - OsInputDriver:    no-CDP real Chrome via OS-level input + screen vision
 */
export interface EnrollDriver {
  /** Launch/focus the browser, navigate to recipe.url, run preflight. */
  open(recipe: Recipe): Promise<void>;
  /** Guard the step against the recipe, then fill every applicable field. */
  fillStep(step: StepSpec, patient: Patient, interaction: InteractionSpec): Promise<FillStepResult>;
  /** Advance an intermediate step; resolves true only if the step actually changed. */
  advance(step: StepSpec): Promise<boolean>;
  /** Check the step's required consent checkbox(es); false if it can't be confirmed. */
  consent(step: StepSpec): Promise<boolean>;
  /** Click the irreversible Submit (does not wait for the result). */
  submit(step: StepSpec): Promise<void>;
  /** Wait until the page URL contains `matchSubstr`; false on timeout. */
  awaitSuccess(matchSubstr: string, timeoutMs: number): Promise<boolean>;
  /** Screenshot the Confirm step (submit off / handoff waiting). */
  captureReady(step: StepSpec): Promise<ReadyCapture>;
  /** Capture confirmation artifacts after a successful submit. */
  captureConfirmation(): Promise<Confirmation>;
  /** Tear down the browser session. */
  close(): Promise<void>;
}

/** Everything a driver needs to construct itself (shared across backends). */
export interface DriverContext {
  headful: boolean;
  newHeadless?: boolean;
  slowMo?: number;
  channel?: string;
  userDataDir?: string;
  /** Run on Browserbase (cloud) over CDP instead of a local browser; inerts the local opts. */
  browserbase?: BrowserbaseConfig;
  humanize: boolean;
  artifactDir: string;
  runId: string;
  logger: Logger;
}

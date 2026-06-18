import type { Patient } from "../patient/schema.js";

/** A single piece of required-but-missing patient info, grouped by the step that needs it. */
export interface NeedsItem {
  key: string;
  step: string;
  type: string;
  reason: "missing";
}

/** Artifact captured on a successful, submitted enrollment. */
export interface Confirmation {
  url: string;
  cardId?: string;
  confirmationNumber?: string;
  screenshotPath?: string;
  runId: string;
  capturedAt: string;
}

/** State captured at the Confirm step when submit is off (the default). */
export interface ReadyCapture {
  step: string;
  screenshotPath?: string;
  note: string;
}

/**
 * Result of an enrollment attempt. A discriminated union — the runner never throws
 * past its boundary; every terminal condition is a typed result the caller handles.
 */
export type EnrollResult =
  | { status: "needs_info"; needs: NeedsItem[] }
  | { status: "ineligible"; reason: string; insuranceType?: string }
  | { status: "unmapped_step"; step: string; message: string }
  | { status: "page_mismatch"; step: string; missingLabels: string[] }
  | { status: "validation_failed"; step: string; fieldKey: string; detail?: string }
  | { status: "ready_to_submit"; capture: ReadyCapture }
  | { status: "submitted"; confirmation: Confirmation }
  | { status: "error"; message: string };

/** Hook invoked immediately before the irreversible Submit. Deferred (no-op) in v1. */
export type BeforeSubmitHook = (ctx: {
  runId: string;
  patient: Patient;
}) => void | Promise<void>;

export interface EnrollOptions {
  /** Path to the recipe YAML (e.g. recipes/skyrizi.yaml). */
  recipePath: string;
  patient: Patient;
  /**
   * Perform the irreversible final Submit. Default false: fill through Confirm,
   * capture state, and stop (returns "ready_to_submit").
   */
  submit?: boolean;
  /** Show a visible browser window. Default false (headless). */
  headful?: boolean;
  /** Slow each Playwright action by N ms (observation aid). Default 0. */
  slowMo?: number;
  /** Directory for screenshots/confirmation records. Default "artifacts". */
  artifactDir?: string;
  /** Stable id for this run; used in artifact paths and the test email alias. */
  runId?: string;
  /** Consent/authorization gate before Submit. Deferred — no-op placeholder in v1. */
  onBeforeSubmit?: BeforeSubmitHook;
}

import type { Patient } from "../patient/schema.js";
import type { BrowserbaseConfig } from "../browser/browserbase.js";

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

/** Result of filling one step. Driver-neutral so both backends return the same shape. */
export type FillStepResult =
  | { status: "ok" }
  | { status: "page_mismatch"; missing: string[] }
  | { status: "validation_failed"; fieldKey: string; detail?: string };

/**
 * Which execution backend runs the flow:
 *  - "playwright": deterministic CDP automation (fast; final Submit blocked by reCAPTCHA)
 *  - "os":         no-CDP real Chrome driven by OS-level input + screen vision
 */
export type DriverName = "playwright" | "os";

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
  // `retryable` marks a transient, environment-dependent failure (e.g. a reCAPTCHA block,
  // which is decided per-session/IP) where re-running on a FRESH session may succeed. The
  // session-level retry wrapper acts on it; exit-code/presentation ignore it.
  | { status: "error"; message: string; retryable?: boolean };

/** Hook invoked immediately before the irreversible Submit. Deferred (no-op) in v1. */
export type BeforeSubmitHook = (ctx: {
  runId: string;
  patient: Patient;
}) => void | Promise<void>;

export interface EnrollOptions {
  /** Path to the recipe YAML (e.g. recipes/skyrizi.yaml). */
  recipePath: string;
  patient: Patient;
  /** Execution backend. Default "playwright". */
  driver?: DriverName;
  /**
   * Perform the irreversible final Submit. Default false: fill through Confirm,
   * capture state, and stop (returns "ready_to_submit").
   *
   * NOTE: on forms protected by reCAPTCHA (e.g. Skyrizi) automated submit is rejected
   * server-side. Use `handoff` instead to keep a human at the actual Submit click.
   */
  submit?: boolean;
  /**
   * Human-in-the-loop submit. Fill everything (including consent if obtained), leave
   * the browser OPEN at Confirm, and wait for a human to click Submit (they pass the
   * invisible reCAPTCHA naturally). Captures confirmation when the success redirect
   * happens. Implies a visible browser. The legitimate path past reCAPTCHA.
   */
  handoff?: boolean;
  /** Show a visible browser window. Default false (headless). */
  headful?: boolean;
  /** Use Chrome "new" headless (`--headless=new`) — no window, full engine. */
  newHeadless?: boolean;
  /** Browser channel, e.g. "chrome" for real Chrome (better invisible-reCAPTCHA score). */
  channel?: string;
  /** Reuse a persistent (warmed) browser profile directory across runs. */
  userDataDir?: string;
  /**
   * Run the browser on Browserbase (cloud) over CDP instead of locally — genuinely
   * non-headless Chrome on a residential IP, the legitimate way to pass the Skyrizi
   * reCAPTCHA off this laptop. When set, headful/newHeadless/channel/userDataDir are inert.
   */
  browserbase?: BrowserbaseConfig;
  /**
   * Human-like behavior: slow uneven typing with occasional typos+corrections, slow
   * scrolling, and 1–3s pauses between fields. Raises the reCAPTCHA score (and run
   * time). Default true for the runner.
   */
  humanize?: boolean;
  /** Slow each Playwright action by N ms (observation aid). Default 0. */
  slowMo?: number;
  /** Directory for screenshots/confirmation records. Default "artifacts". */
  artifactDir?: string;
  /** Stable id for this run; used in artifact paths and the test email alias. */
  runId?: string;
  /**
   * True when patient consent/authorization was obtained out-of-band. Only then does
   * the runner check the Confirm step's required consent checkbox(es) before Submit.
   * Never check a consent box without this set.
   */
  consentObtained?: boolean;
  /** Consent/authorization hook run immediately before Submit (e.g. audit logging). */
  onBeforeSubmit?: BeforeSubmitHook;
}

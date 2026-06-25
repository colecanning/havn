import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * PII-SAFE summary of a form-submit POST body (for reCAPTCHA debugging only). The payload
 * carries patient PII, so we emit ONLY shape facts — never any field value: total length,
 * the field key NAMES (static identifiers, not PII), the longest string-value length (a
 * reCAPTCHA token is ~500–2000 chars, so a large max ⇒ a token is attached), and the name +
 * length of any captcha/token-ish field. Lets us tell "token present" from "token missing"
 * without logging data.
 */
function summarizeSubmitPayload(postData: string | null): string {
  if (!postData) return "no postData";
  const keys: string[] = [];
  let maxValueLen = 0;
  let captcha: { key: string; len: number } | null = null;
  const note = (key: string, value: unknown) => {
    keys.push(key);
    if (typeof value === "string") {
      maxValueLen = Math.max(maxValueLen, value.length);
      if (/captcha|recaptcha|token/i.test(key)) captcha = { key, len: value.length };
    }
  };
  try {
    const walk = (o: unknown, prefix = ""): void => {
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          const path = prefix ? `${prefix}.${k}` : k;
          note(path, v);
          if (v && typeof v === "object") walk(v, path);
        }
      }
    };
    walk(JSON.parse(postData));
  } catch {
    // Not JSON (e.g. multipart) — pull field names only; can't safely length each value.
    for (const m of postData.matchAll(/name="([^"]+)"/g)) keys.push(m[1] ?? "");
    maxValueLen = -1; // unknown
  }
  return (
    `length=${postData.length} maxValueLen=${maxValueLen} ` +
    `captcha=${captcha ? `${(captcha as { key: string }).key}(tokenLen=${(captcha as { len: number }).len})` : "NONE"} ` +
    `keys=[${keys.join(",")}]`
  );
}

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
      ...(this.ctx.newHeadless ? { newHeadless: true } : {}),
      slowMo: this.ctx.slowMo,
      ...(this.ctx.channel ? { channel: this.ctx.channel } : {}),
      ...(this.ctx.userDataDir ? { userDataDir: this.ctx.userDataDir } : {}),
      ...(this.ctx.browserbase ? { browserbase: this.ctx.browserbase } : {}),
    });
    // Opt-in network diagnostics (HAVN_LOG_NETWORK=1): log 4xx/5xx on form/reCAPTCHA
    // endpoints — e.g. the 400 CaptchaValidationException when a Submit is bot-flagged.
    // Structured logs get status + URL only (never the body). For the form-SUBMIT endpoint
    // we additionally dump the response body to a gitignored artifact so we can read the
    // exact server error (it can echo submitted data, so it is sensitive — artifacts only).
    if (process.env.HAVN_LOG_NETWORK) {
      const errLog = join(this.ctx.artifactDir, this.ctx.runId, "net-errors.log");
      this.page.on("response", (res) => {
        const status = res.status();
        if (status < 400) return;
        const url = res.url();
        if (!/abbvie|skyrizi|recaptcha|enroll|signup|guide|forms/i.test(url)) return;
        this.ctx.logger.info("net.error_response", { status, url: url.slice(0, 140) });
        if (/\/submit\//.test(url)) {
          res
            .text()
            .then((body) => {
              mkdirSync(dirname(errLog), { recursive: true });
              appendFileSync(errLog, `\n[${status}] ${url}\n${body}\n`);
            })
            .catch(() => {});
        }
      });
    }
    // Opt-in reCAPTCHA diagnostics (HAVN_DEBUG_RECAPTCHA=1): does the Enterprise script +
    // token-generation actually run over the (proxied) connection, are there reCAPTCHA
    // console errors, and is a real token attached to the Submit POST? Distinguishes a hard
    // bot-flag (token generated, server rejects it) from a mechanical failure (token never
    // generated/attached). PII-safe — recaptcha URLs are query-stripped, the submit payload
    // is summarized to shape only (see summarizeSubmitPayload), values are never written.
    if (process.env.HAVN_DEBUG_RECAPTCHA) {
      const rcLog = join(this.ctx.artifactDir, this.ctx.runId, "recaptcha-debug.log");
      const write = (line: string) => {
        try {
          mkdirSync(dirname(rcLog), { recursive: true });
          appendFileSync(rcLog, line + "\n");
        } catch {
          /* best-effort */
        }
      };
      const isRecaptcha = (u: string) => /google\.com\/recaptcha|recaptcha\.net|gstatic\.com\/recaptcha/.test(u);
      this.page.on("response", (res) => {
        const u = res.url();
        if (isRecaptcha(u)) write(`[net ${res.status()}] ${res.request().method()} ${u.split("?")[0]}`);
      });
      this.page.on("requestfailed", (req) => {
        const u = req.url();
        if (isRecaptcha(u) || /\/submit\//.test(u))
          write(`[net FAILED ${req.failure()?.errorText ?? "?"}] ${u.split("?")[0]}`);
      });
      this.page.on("request", (req) => {
        if (req.method() === "POST" && /\/submit\//.test(req.url()))
          write(`[submit POST] ${summarizeSubmitPayload(req.postData())}`);
      });
      this.page.on("console", (msg) => {
        const t = msg.text();
        if (/captcha|recaptcha|grecaptcha/i.test(t)) write(`[console.${msg.type()}] ${t.slice(0, 200)}`);
      });
    }
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

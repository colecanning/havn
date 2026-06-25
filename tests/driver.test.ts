import { describe, it, expect } from "vitest";
import { runEnrollment, runWithSessionRetry } from "../src/core/enroll.js";
import { makeDriver } from "../src/drivers/index.js";
import type { EnrollDriver } from "../src/drivers/types.js";
import type { EnrollOptions, FillStepResult } from "../src/core/types.js";
import { parsePatient, type Patient } from "../src/patient/schema.js";
import { loadRecipe } from "../src/recipe/load.js";
import { createLogger } from "../src/logging/logger.js";

const recipe = loadRecipe("recipes/skyrizi.yaml");
const logger = createLogger({ level: "error" });

const complete = parsePatient({
  diagnosis: "plaque_psoriasis",
  first_name: "Pat",
  last_name: "Example",
  email: "pat@example.com",
  date_of_birth: "1985-04-12",
  sex: "male",
  phone: "6145551234",
  insurance_type: "commercial",
  treatment: { started: "no", upcoming_date: "12/15/2026" },
  address: { line1: "123 Example St", city: "Columbus", state: "OH", zip: "43215" },
});

/** Configurable in-memory driver — never touches a browser. */
class FakeDriver implements EnrollDriver {
  submitted = false;
  consentCalled = false;
  constructor(
    private cfg: {
      fill?: (stepId: string) => FillStepResult;
      advance?: boolean;
      consent?: boolean;
      awaitSuccess?: boolean;
    } = {},
  ) {}
  async open() {}
  async fillStep(step: { id: string }): Promise<FillStepResult> {
    return this.cfg.fill ? this.cfg.fill(step.id) : { status: "ok" };
  }
  async advance() {
    return this.cfg.advance ?? true;
  }
  async consent() {
    this.consentCalled = true;
    return this.cfg.consent ?? true;
  }
  async submit() {
    this.submitted = true;
  }
  async awaitSuccess() {
    return this.cfg.awaitSuccess ?? true;
  }
  async captureReady(step: { id: string }) {
    return { step: step.id, note: "ready" };
  }
  async captureConfirmation() {
    return { url: "https://x/skyrizi-complete/signup/confirmation", runId: "t", capturedAt: "t" };
  }
  async close() {}
}

function run(driver: EnrollDriver, opts: Partial<EnrollOptions>, patient: Patient = complete) {
  return runEnrollment(
    driver,
    recipe,
    { recipePath: "recipes/skyrizi.yaml", patient, ...opts },
    "test",
    logger,
  );
}

describe("makeDriver factory", () => {
  const ctx = { headful: false, humanize: false, artifactDir: "artifacts", runId: "t", logger };
  it("builds the playwright driver", () => {
    expect(makeDriver("playwright", ctx)).toBeDefined();
  });
  it("throws for the not-yet-built os driver", () => {
    expect(() => makeDriver("os", ctx)).toThrow(/not implemented/i);
  });
});

describe("orchestrator flow (fake driver)", () => {
  it("ready_to_submit when submit & handoff are off; never submits", async () => {
    const d = new FakeDriver();
    const r = await run(d, { submit: false });
    expect(r.status).toBe("ready_to_submit");
    expect(d.submitted).toBe(false);
  });

  it("submitted when submit + consent given", async () => {
    const d = new FakeDriver();
    const r = await run(d, { submit: true, consentObtained: true });
    expect(r.status).toBe("submitted");
    expect(d.consentCalled).toBe(true);
    expect(d.submitted).toBe(true);
  });

  it("errors if consent required but not obtained — and never submits", async () => {
    const d = new FakeDriver();
    const r = await run(d, { submit: true, consentObtained: false });
    expect(r.status).toBe("error");
    expect(d.submitted).toBe(false);
  });

  it("halts ineligible at the gate (government insurance), never reaching submit", async () => {
    const d = new FakeDriver();
    const medicare = parsePatient({ ...complete, insurance_type: "medicare" });
    const r = await run(d, { submit: true, consentObtained: true }, medicare);
    expect(r.status).toBe("ineligible");
    expect(d.submitted).toBe(false);
  });

  it("returns page_mismatch from a step's fill", async () => {
    const d = new FakeDriver({
      fill: (id) => (id === "account" ? { status: "page_mismatch", missing: ["First Name"] } : { status: "ok" }),
    });
    const r = await run(d, {});
    expect(r).toMatchObject({ status: "page_mismatch", step: "account" });
  });

  it("returns validation_failed when a step won't advance", async () => {
    const d = new FakeDriver({ advance: false });
    const r = await run(d, {});
    expect(r).toMatchObject({ status: "validation_failed", step: "account", fieldKey: "(advance)" });
  });

  it("handoff: submitted when a human completes the Submit", async () => {
    const d = new FakeDriver({ awaitSuccess: true });
    const r = await run(d, { handoff: true, consentObtained: true });
    expect(r.status).toBe("submitted");
    expect(d.submitted).toBe(false); // human clicked, not the driver
  });

  it("handoff: ready_to_submit when the human doesn't finish in time", async () => {
    const d = new FakeDriver({ awaitSuccess: false });
    const r = await run(d, { handoff: true, consentObtained: true });
    expect(r.status).toBe("ready_to_submit");
  });
});

describe("session-level retry (fresh-session fallback for reCAPTCHA)", () => {
  // A driver factory whose Nth driver succeeds/fails the Submit per `awaitResults[N]`
  // (default: fail) — i.e. simulates a per-session reCAPTCHA verdict across fresh sessions.
  function sessionFactory(awaitResults: boolean[]) {
    let made = 0;
    return {
      make(): EnrollDriver {
        const d = new FakeDriver({ awaitSuccess: awaitResults[made] ?? false });
        made += 1;
        return d;
      },
      get count() {
        return made;
      },
    };
  }
  const base = (patient: Patient) =>
    ({ recipePath: "recipes/skyrizi.yaml", patient, submit: true, consentObtained: true }) as EnrollOptions;

  it("retries on a fresh session after a reCAPTCHA block and succeeds", async () => {
    const f = sessionFactory([false, false, true]); // 3rd session passes
    const r = await runWithSessionRetry(() => f.make(), recipe, base(complete), "test", logger, 5);
    expect(r.status).toBe("submitted");
    expect(f.count).toBe(3); // stopped on first success
  });

  it("errors after exhausting all attempts (5 total), never more", async () => {
    const f = sessionFactory([]); // every session is blocked
    const r = await runWithSessionRetry(() => f.make(), recipe, base(complete), "test", logger, 5);
    expect(r.status).toBe("error");
    expect(f.count).toBe(5);
  });

  it("does not retry a non-retryable outcome (ineligible halts on attempt 1)", async () => {
    const medicare = parsePatient({ ...complete, insurance_type: "medicare" });
    const f = sessionFactory([true, true, true, true, true]);
    const r = await runWithSessionRetry(() => f.make(), recipe, base(medicare), "test", logger, 5);
    expect(r.status).toBe("ineligible");
    expect(f.count).toBe(1);
  });
});

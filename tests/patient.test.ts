import { describe, it, expect } from "vitest";
import { parsePatient } from "../src/patient/schema.js";
import { collectNeeds } from "../src/patient/validate.js";
import { testEmail } from "../src/patient/testEmail.js";
import { loadRecipe } from "../src/recipe/load.js";

const recipe = loadRecipe("recipes/skyrizi.yaml");

const base = {
  diagnosis: "plaque_psoriasis",
  first_name: "Pat",
  last_name: "Example",
  email: "pat@example.com",
} as const;

// A patient with every recipe-required field present (across all mapped steps).
const complete = {
  ...base,
  date_of_birth: "1985-04-12",
  sex: "male",
  phone: "6145551234",
  insurance_type: "commercial",
  treatment: { started: "no", upcoming_date: "12/15/2026" },
  address: { line1: "123 Example St", city: "Columbus", state: "OH", zip: "43215" },
} as const;

describe("patient schema", () => {
  it("accepts a minimal valid Step-1 patient", () => {
    expect(() => parsePatient(base)).not.toThrow();
  });

  it("rejects an invalid email", () => {
    expect(() => parsePatient({ ...base, email: "not-an-email" })).toThrow();
  });

  it("rejects an unknown diagnosis", () => {
    expect(() => parsePatient({ ...base, diagnosis: "diabetes" })).toThrow();
  });
});

describe("missing-info needs list", () => {
  it("returns no needs when all required (mapped) fields are present", () => {
    const needs = collectNeeds(parsePatient(complete), recipe);
    expect(needs).toEqual([]);
  });

  it("flags a missing required field with its step", () => {
    const { email, ...withoutEmail } = complete;
    const needs = collectNeeds(parsePatient(withoutEmail), recipe);
    expect(needs).toContainEqual({
      key: "email",
      step: "account",
      type: "email",
      reason: "missing",
    });
  });

  it("does not flag optional conditional fields (e.g. address.line2)", () => {
    const needs = collectNeeds(parsePatient(complete), recipe);
    expect(needs.find((n) => n.key === "address.line2")).toBeUndefined();
  });
});

describe("test email (Gmail dot trick — the form rejects '+')", () => {
  it("routes to the same mailbox using dots only, never '+'", () => {
    const e = testEmail("skyrizi-123", "ccanning10@gmail.com");
    expect(e).not.toContain("+");
    expect(e.endsWith("@gmail.com")).toBe(true);
    // Removing dots recovers the canonical mailbox.
    expect(e.split("@")[0]!.replace(/\./g, "")).toBe("ccanning10");
  });

  it("is deterministic per run id", () => {
    expect(testEmail("run-A")).toBe(testEmail("run-A"));
  });

  it("produces multiple distinct addresses across run ids", () => {
    const set = new Set(Array.from({ length: 10 }, (_, i) => testEmail(`run-${i}`)));
    expect(set.size).toBeGreaterThan(1);
  });
});

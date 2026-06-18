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
    const needs = collectNeeds(parsePatient(base), recipe);
    expect(needs).toEqual([]);
  });

  it("flags a missing required field with its step", () => {
    const { email, ...withoutEmail } = base;
    const needs = collectNeeds(parsePatient(withoutEmail), recipe);
    expect(needs).toContainEqual({
      key: "email",
      step: "account",
      type: "email",
      reason: "missing",
    });
  });
});

describe("test email aliasing", () => {
  it("injects the run id as a +alias", () => {
    expect(testEmail("skyrizi-123", "ccanning10@gmail.com")).toBe(
      "ccanning10+skyrizi-123@gmail.com",
    );
  });
});

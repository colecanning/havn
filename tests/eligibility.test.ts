import { describe, it, expect } from "vitest";
import { loadRecipe } from "../src/recipe/load.js";
import { parsePatient } from "../src/patient/schema.js";
import { checkEligibility } from "../src/runner/eligibility.js";

const recipe = loadRecipe("recipes/skyrizi.yaml");
const base = {
  diagnosis: "plaque_psoriasis",
  first_name: "Pat",
  last_name: "Example",
  email: "pat@example.com",
} as const;

describe("eligibility gate", () => {
  it("passes commercial insurance", () => {
    const r = checkEligibility(parsePatient({ ...base, insurance_type: "commercial" }), recipe);
    expect(r.eligible).toBe(true);
  });

  it.each(["medicare", "medicaid", "va", "tricare"] as const)(
    "halts disqualifying government insurance: %s",
    (ins) => {
      const r = checkEligibility(parsePatient({ ...base, insurance_type: ins }), recipe);
      expect(r.eligible).toBe(false);
      expect(r.insuranceType).toBe(ins);
    },
  );

  it("halts non-commercial 'other' insurance", () => {
    const r = checkEligibility(parsePatient({ ...base, insurance_type: "other" }), recipe);
    expect(r.eligible).toBe(false);
  });

  it("halts when insurance type is missing", () => {
    const r = checkEligibility(parsePatient(base), recipe);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/missing/i);
  });
});

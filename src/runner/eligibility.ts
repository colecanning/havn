import type { Recipe } from "../recipe/schema.js";
import type { Patient } from "../patient/schema.js";
import { getByPath } from "../util/path.js";

/**
 * Eligibility gate. Co-pay assistance is commercial-insurance only; government
 * insurance (Medicare incl. Part D, Medicaid, TRICARE, VA) is disqualifying by law.
 * This is a pure check enforced at the Savings step BEFORE advancing — and it holds
 * regardless of the submit flag.
 */

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  insuranceType?: string;
}

export function checkEligibility(patient: Patient, recipe: Recipe): EligibilityResult {
  const key = recipe.eligibility.insurance_field_key;
  const insurance = getByPath(patient, key);

  if (typeof insurance !== "string" || insurance.length === 0) {
    return { eligible: false, reason: `insurance type missing (patient.${key})` };
  }
  if (recipe.eligibility.disqualifying.includes(insurance)) {
    return {
      eligible: false,
      reason: `${insurance} insurance is disqualifying (government program)`,
      insuranceType: insurance,
    };
  }
  if (insurance !== recipe.eligibility.required_insurance) {
    return {
      eligible: false,
      reason: `requires ${recipe.eligibility.required_insurance} insurance, got ${insurance}`,
      insuranceType: insurance,
    };
  }
  return { eligible: true, insuranceType: insurance };
}

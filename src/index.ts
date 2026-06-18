/**
 * Havn enrollment engine — public API.
 *
 * The same core `enroll()` is what a CLI calls today and what the future API
 * trigger will wrap. Everything below is transport-agnostic.
 */

export { enroll } from "./core/enroll.js";
export type {
  EnrollOptions,
  EnrollResult,
  NeedsItem,
  Confirmation,
  ReadyCapture,
  BeforeSubmitHook,
  DriverName,
  FillStepResult,
} from "./core/types.js";

export { makeDriver } from "./drivers/index.js";
export type { EnrollDriver, DriverContext } from "./drivers/types.js";

export { Patient, parsePatient, Diagnosis, InsuranceType, Address } from "./patient/schema.js";
export type { Patient as PatientType } from "./patient/schema.js";
export { collectNeeds } from "./patient/validate.js";
export { testEmail } from "./patient/testEmail.js";

export { loadRecipe, parseRecipe } from "./recipe/load.js";
export { Recipe } from "./recipe/schema.js";
export type { Recipe as RecipeType } from "./recipe/schema.js";

export { checkEligibility } from "./runner/eligibility.js";
export type { EligibilityResult } from "./runner/eligibility.js";

export { makeRunId } from "./util/runId.js";

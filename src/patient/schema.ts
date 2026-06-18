import { z } from "zod";

/**
 * The patient record. This is the only thing that varies between enrollments.
 *
 * This schema validates the *shape and format* of whatever the caller supplies;
 * it does not hard-require fields. The recipe's required-fields list — not this
 * schema — decides what a given run needs, so missing data surfaces as a
 * structured needs list (src/patient/validate.ts) instead of a parse exception.
 * Fields on not-yet-fully-mapped steps (Profile/Treatment) are modeled as best we
 * know today and will be tightened once mapping confirms them.
 */

export const Diagnosis = z.enum([
  "plaque_psoriasis",
  "psoriatic_arthritis",
  "crohns",
  "ulcerative_colitis",
]);
export type Diagnosis = z.infer<typeof Diagnosis>;

export const InsuranceType = z.enum([
  "commercial",
  "medicare",
  "medicaid",
  "va",
  "tricare",
  "other",
]);
export type InsuranceType = z.infer<typeof InsuranceType>;

export const Sex = z.enum(["male", "female"]);
export type Sex = z.infer<typeof Sex>;

export const TreatmentStarted = z.enum(["yes", "no", "unsure"]);
export type TreatmentStarted = z.infer<typeof TreatmentStarted>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date_of_birth must be ISO format YYYY-MM-DD");

export const Address = z
  .object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    city: z.string().min(1),
    /** Two-letter US state code. */
    state: z.string().regex(/^[A-Za-z]{2}$/, "state must be a 2-letter code"),
    zip: z.string().regex(/^\d{5}(-\d{4})?$/, "zip must be 5 or 9 digits"),
  })
  .strict();
export type Address = z.infer<typeof Address>;

export const Patient = z
  .object({
    // Step 1 — Account. Format-validated when present; required-ness is enforced
    // by the recipe via collectNeeds (so missing data becomes a structured needs
    // list, not a parse exception).
    diagnosis: Diagnosis.optional(),
    first_name: z.string().min(1).optional(),
    last_name: z.string().min(1).optional(),
    email: z.string().email().optional(),

    // Step 3 — Profile (confirmed via mapping)
    date_of_birth: isoDate.optional(),
    sex: Sex.optional(),
    /** Optional on the form; left unset if not provided. */
    gender_identity: z.string().optional(),
    address: Address.optional(),
    phone: z
      .string()
      .regex(/^[0-9()+\-.\s]{7,}$/, "phone has unexpected characters")
      .optional(),

    // Step 4 — Savings (eligibility gate)
    insurance_type: InsuranceType.optional(),

    // Step 2 — Treatment. `started` drives conditional fields:
    //   no    -> upcoming_date required
    //   yes   -> recent treatment date/type (not modeled in v1)
    treatment: z
      .object({
        started: TreatmentStarted.optional(),
        /** MM/DD/YYYY upcoming treatment date (when started = "no"). */
        upcoming_date: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .strict();
export type Patient = z.infer<typeof Patient>;

/** Parse/validate an unknown object as a Patient. Throws with readable issues. */
export function parsePatient(raw: unknown): Patient {
  return Patient.parse(raw);
}

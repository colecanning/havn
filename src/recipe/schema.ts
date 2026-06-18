import { z } from "zod";

/**
 * The recipe is a declarative description of one manufacturer's enrollment form.
 * It is generated once by mapping the live form (see src/mapper) and checked into
 * the repo. The deterministic runner executes it per patient. Adding a new drug
 * later means adding a new recipe YAML — not new code.
 *
 * Everything the runner does is driven by this schema, so changes here ripple to
 * both the mapper (what it must capture) and the runner (what it executes).
 */

export const FieldType = z.enum([
  "text",
  "email",
  "tel",
  "date",
  "radio",
  "select",
  "checkbox",
]);
export type FieldType = z.infer<typeof FieldType>;

export const FieldSpec = z
  .object({
    /** Dotted path into the patient record, e.g. "first_name" or "address.line1". */
    key: z.string().min(1),
    type: FieldType,
    /**
     * Primary locator for text/select fields: the input's `name` attribute. On this
     * form the text-input names are clean and stable (e.g. "AccfirstName"), while CSS
     * classes and ids are auto-generated. Radios use auto-generated names, so they are
     * located by visible label text instead (see label_map).
     */
    name: z.string().min(1).optional(),
    /** Stable visible label text — used to locate text fields (fallback) and to guard. */
    label: z.string().min(1).optional(),
    /**
     * For radio: maps a patient enum value to the visible option text to click.
     * For select: optional — maps a patient value to the <option> label; when omitted
     * the patient value is used directly as the option value (e.g. state "OH").
     */
    label_map: z.record(z.string(), z.string()).optional(),
    required: z.boolean().default(true),
    /**
     * True when this field is revealed only after another field is set (e.g. the
     * mailing address appears after choosing commercial insurance). The page-match
     * guard skips conditional fields for initial presence, but collectNeeds still
     * enforces required-ness so the data is gathered up front.
     */
    conditional: z.boolean().default(false),
    /** Free-form note captured during mapping (validation quirks, formatting, etc.). */
    notes: z.string().optional(),
  })
  .strict()
  .refine((f) => (f.type === "radio" ? !!f.label_map : true), {
    message: "radio fields must define a label_map",
  })
  .refine((f) => (f.type === "radio" ? true : !!(f.name || f.label)), {
    message: "non-radio fields must define a name or a label",
  });
export type FieldSpec = z.infer<typeof FieldSpec>;

export const AdvanceSpec = z
  .object({
    /** Visible text of the button that advances to the next step. */
    button: z.string().min(1),
    /** True only for the final Submit. Gates the irreversible action. */
    irreversible: z.boolean().default(false),
  })
  .strict();
export type AdvanceSpec = z.infer<typeof AdvanceSpec>;

export const StepSpec = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    /** False until this step has been mapped against the live form. */
    mapped: z.boolean().default(false),
    /**
     * A unique visible phrase that is present while this step is active and gone on
     * the next step. The runner waits for it to disappear to confirm a real advance
     * (the form silently keeps you on the step when a field is rejected). Avoid generic
     * words — they substring-match the page's safety text.
     */
    signature: z.string().optional(),
    fields: z.array(FieldSpec).default([]),
    /**
     * Consent/authorization checkboxes that must be checked before Submit. Checked
     * only when consent has been obtained from the patient out-of-band and the caller
     * passes consentObtained (CLI: --consent). List only REQUIRED program-consent
     * boxes here — leave optional marketing opt-ins unchecked.
     */
    consent_checkboxes: z
      .array(z.object({ name: z.string().min(1), label: z.string().optional() }).strict())
      .optional(),
    advance: AdvanceSpec.optional(),
    notes: z.string().optional(),
  })
  .strict();
export type StepSpec = z.infer<typeof StepSpec>;

export const InteractionSpec = z
  .object({
    /** How fields are located. v1 only supports label_text (classes are brittle). */
    target_by: z.literal("label_text").default("label_text"),
    /** Native DOM events the custom components listen for; must be dispatched. */
    events: z.array(z.string()).default(["input", "change", "blur"]),
    /** Verify a field reached an accepted state before advancing. */
    verify_field_state: z.boolean().default(true),
  })
  .strict();
export type InteractionSpec = z.infer<typeof InteractionSpec>;

export const PreflightAction = z.enum(["dismiss_cookie_banner", "dismiss_chat_widget"]);
export type PreflightAction = z.infer<typeof PreflightAction>;

export const EligibilitySpec = z
  .object({
    /** Co-pay assistance requires this insurance type. */
    required_insurance: z.string().min(1),
    /** Insurance types that are disqualifying by law (government programs). */
    disqualifying: z.array(z.string()).default([]),
    /** Step id at which to enforce the gate before advancing. */
    gate_step: z.string().min(1),
    /** Patient key holding the insurance type used for the gate. */
    insurance_field_key: z.string().min(1).default("insurance_type"),
  })
  .strict();
export type EligibilitySpec = z.infer<typeof EligibilitySpec>;

export const SuccessSignal = z
  .object({
    type: z.literal("url_redirect"),
    /** Substring/path the final URL must contain to count as success. */
    match: z.string().min(1),
  })
  .strict();
export type SuccessSignal = z.infer<typeof SuccessSignal>;

export const Recipe = z
  .object({
    drug: z.string().min(1),
    manufacturer: z.string().min(1),
    url: z.string().url(),
    form_type: z.string().min(1),
    interaction: InteractionSpec.default({}),
    preflight: z.array(PreflightAction).default([]),
    eligibility: EligibilitySpec,
    steps: z.array(StepSpec).min(1),
    success_signal: SuccessSignal,
  })
  .strict()
  .refine((r) => r.steps.some((s) => s.id === r.eligibility.gate_step), {
    message: "eligibility.gate_step must reference an existing step id",
  });
export type Recipe = z.infer<typeof Recipe>;

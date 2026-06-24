---
name: onboard-drug
description: >-
  Map a new drug / manufacturer co-pay assistance card's enrollment form into a
  checked-in recipe so the deterministic runner can enroll patients for it — the
  repeatable version of the Skyrizi onboarding process. Manual-invoke only: run with
  /onboard-drug.
disable-model-invocation: true
---

# Onboard a new drug

Havn's engine is **map once, run deterministically**: a checked-in **recipe** YAML
describes a manufacturer's enrollment form, and a deterministic Playwright runner
executes it per patient (no LLM at runtime). Onboarding a new drug therefore means
**producing a new `recipes/<drug>.yaml`** (plus small, occasional tweaks to the patient
schema / eligibility / consent), *not* writing new runner code. If you find yourself
writing new browser logic, stop and ask whether the recipe schema can express it
instead — new code should be the rare exception.

Skyrizi is the worked example. Read it and the engine docs before starting; they encode
hard-won facts you must not rediscover the slow way.

## Orient first (read these)

- `recipes/skyrizi.yaml` — a complete, working recipe. Your output should look like this.
- `src/recipe/schema.ts` — the recipe shape (the source of truth for what a recipe can express).
- `CLAUDE.md` — "Hard-won facts about the live form" and "The Submit" sections. The form
  quirks listed there (hidden duplicates, native typing, email `+` rejection, advancement
  signatures, conditional fields) are very likely to recur on other manufacturers' forms.
- `docs/submit-and-recaptcha.md` — the reCAPTCHA timing-quirk fix + headed-vs-headless
  reality. Needed for the final submit/testing step.
- `docs/enrollment-flow.md` — the 5-step Skyrizi flow in plain English (a template for the shape).

## The process

Work **one step of the form at a time**, iteratively — never try to map a whole form
blind. The loop is: *explore the live step → translate it into recipe YAML → advance →
repeat*. The `map` command automates "fill the mapped steps, snapshot the first unmapped
one, stop before Submit."

### 1. Recon the form

Get the patient enrollment URL (the manufacturer's "co-pay card" / "savings card"
enrollment page). Then dump what's actually on it:

```bash
npx tsx .claude/skills/onboard-drug/scripts/explore-form.ts "<enrollment-url>"
```

This launches headed real Chrome, dismisses the cookie banner, and prints every
**visible** form control (tag, `type`, `name`, label, text) + a screenshot to
`artifacts/explore.png`. It leaves the browser open so you can scroll/click to reveal
later steps. **Why visible-only:** these forms (AEM Adaptive Form, common across pharma)
keep the whole wizard in the DOM with hidden duplicate copies of every field — matching a
hidden copy is the #1 mapping bug.

Note the form technology. If `name` attributes are clean and stable (e.g. `firstName`,
`dob`) and radios have hashed names, it's the same family as Skyrizi and the existing
field-fill heuristics will work as-is. If it's a genuinely different stack (React with no
stable names, an iframe, a third-party hub portal), flag it — the recipe schema is generic
but `src/browser/field.ts` assumes the AEM quirks, so a different form may need new
locating logic (the rare new-code case).

### 2. Scaffold the recipe

Copy `recipes/skyrizi.yaml` to `recipes/<drug>.yaml`. Set `drug`, `manufacturer`, `url`,
`form_type`. Replace the steps with stubs (`mapped: false`, empty `fields`) for each tab
you can see in the wizard. Keep `interaction`, `preflight`, and the `success_signal`
placeholder; you'll confirm the success URL later.

### 3. Map each step (the core loop)

For the first unmapped step:

```bash
npx tsx src/cli.ts map --recipe recipes/<drug>.yaml
```

`map` fills all `mapped: true` steps with dummy data, advances, and snapshots the first
`mapped: false` step (labels + controls + screenshot) to `artifacts/mapping/<runId>/`,
stopping before Submit. Translate that snapshot into the step's `fields` (see schema
rules below), set `mapped: true` and a `signature`, then re-run `map` to reach the next
step. Repeat until you reach Confirm.

When `map`'s dummy data can't get a step to advance (a field it doesn't know how to fill,
a tricky reveal), use `explore-form.ts` and drive that step by hand to understand it, then
encode it. The Skyrizi history in `docs/` shows this interplay.

### 4. Encode fields correctly (schema rules)

From `src/recipe/schema.ts`, per field:

- **Text / email / tel / date**: set `name` to the input's `name` attribute (stable;
  preferred locator) and `label` to the visible label. Map `key` to a patient field
  (dotted path ok, e.g. `address.line1`).
- **Radio**: no stable name → use `label_map` mapping each patient enum value to the
  exact **visible option text** to click. (e.g. diagnosis, sex, insurance type.)
- **select** (native `<select>`): set `name`; `label_map` is optional — without it the
  patient value is used directly as the `<option>` value (e.g. state `OH`).
- **`signature`** (per step): a unique visible phrase present on this step and gone on
  the next. The runner waits for it to disappear to confirm a real advance. **Never use
  generic words** like "Yes"/"No" — they substring-match the page's safety text.
- **`conditional: true`**: for fields revealed only after another choice (a date that
  appears after picking "No", an address that appears after picking commercial insurance).
  The guard skips them for initial presence, but `collectNeeds` still requires them.
- **Disabled / auto-populated fields**: omit from the recipe (e.g. a ZIP that auto-fills
  from an earlier ZIP).
- Recurring gotchas you'll likely hit: programmatic `.fill()` is silently rejected (the
  runner types real keys — nothing to do in the recipe); the **email field may reject
  `+`** (test addresses use the Gmail dot-trick, `src/patient/testEmail.ts`); a radio/
  select that reveals fields needs a beat to settle (the runner handles it).

### 5. Eligibility gate

Set the `eligibility` block for this program. Most manufacturer co-pay cards are
**commercial-insurance only** (government insurance — Medicare/Medicaid/TRICARE/VA — is
disqualifying by law), but confirm per program. Point `gate_step` at the step that
collects insurance and `insurance_field_key` at the patient field. The gate halts
ineligible patients before that step regardless of the submit flag — it's a legal
guardrail, so get it right.

### 6. Consent checkbox(es)

On the Confirm step, find any **required** consent checkbox (inspect with
`explore-form.ts`; note its `name`). Add it under the step's `consent_checkboxes`. The
runner checks it ONLY when the operator passes `--consent` (consent obtained from the
patient out-of-band). Leave optional marketing opt-ins out. Read the checkbox's actual
text — if it authorizes sharing health data, treat it as real consent, not a formality.

### 7. Submit + success signal

Set `success_signal.match` to a substring of the post-submit confirmation URL. The final
Submit is irreversible. If the form uses invisible reCAPTCHA (most do), the runner's
**submit-retry loop** handles the token-timing quirk — but it only passes on **headed
real Chrome** (headless scores 0.00). See `docs/submit-and-recaptcha.md` for the full
story and the verified command; reuse that approach. Mapping itself **never submits**.

### 8. Patient schema (only if new fields appeared)

If the form needs a patient field the schema doesn't have, add it to
`src/patient/schema.ts` (format-validated but optional — required-ness is recipe-driven
via `collectNeeds`). Reuse existing fields/enums where possible. This is the main place
new code is legitimately needed.

### 9. Test the recipe

```bash
npx tsx src/cli.ts validate examples/<drug>.example.json --recipe recipes/<drug>.yaml   # missing-info check, no browser
npx tsx src/cli.ts enroll  examples/<drug>.example.json --recipe recipes/<drug>.yaml     # dry run -> ready_to_submit (fills through Confirm, stops)
# Real end-to-end (creates a real enrollment): headed real Chrome, consent obtained, test inbox:
npx tsx src/cli.ts enroll examples/<drug>.example.json --recipe recipes/<drug>.yaml -- --submit --consent --channel chrome --headful --test-email
```

A clean **dry run reaching `ready_to_submit`** is the bar for "mapped correctly." Do the
real submit once to confirm the success signal + that a card is issued (check the test
inbox). Create an `examples/<drug>.example.json` patient with plausible data.

### 10. Land it

Add a couple of unit tests if you introduced schema/eligibility changes (mirror
`tests/eligibility.test.ts` / `tests/patient.test.ts`). Update `CLAUDE.md` / docs if you
learned a new form quirk worth recording. Commit (recipe + example + any schema tweak).

## Guardrails (same as the engine's — do not weaken)

- **Mapping never submits.** Stop before the irreversible Submit while mapping.
- **Eligibility gate is commercial-only** unless the program says otherwise; it's a legal
  line. Enforced before the gate step.
- **Halt on page mismatch** — never guess a selector into a form that drifted.
- **Never log raw PII**; `artifacts/` may contain PII and is gitignored.
- **Never** add CAPTCHA-solving/token-relay services. The legitimate submit path is headed
  real Chrome + the retry; the durable path at scale is an official hub/API.

## What "done" looks like

`recipes/<drug>.yaml` with every step `mapped: true`, an `examples/<drug>.example.json`,
a dry run that returns `ready_to_submit`, one verified real submission, and (if needed)
small schema/eligibility/consent additions — all committed. The same engine now runs the
new drug; only config changed.

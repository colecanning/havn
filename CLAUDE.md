# CLAUDE.md — context for future Claude sessions

Havn enrolls patients in manufacturer co-pay assistance cards. v1 automates the
**Skyrizi Complete Savings Card (AbbVie)** by filling AbbVie's patient enrollment
form. Designed so adding a drug later is a new recipe, not new code.

## The core idea: map once, run deterministically

The form is identical for every patient — only the data varies, and the final
Submit is irreversible. So we do **not** run an LLM live per enrollment. Instead:

- A **recipe** (`recipes/skyrizi.yaml`) declaratively describes the flow: steps,
  fields, how to locate them, the eligibility rule, and the success signal. It was
  produced by mapping the live form and is checked in.
- A **deterministic runner** (`src/core/enroll.ts` + `src/runner/*` + `src/browser/*`)
  executes the recipe for a patient with plain Playwright — no model at runtime.
- A **page-match guard** halts if the live form no longer matches the recipe rather
  than submitting into a changed form.

Self-healing is out of scope. When the form changes, re-map by hand (see below).

## How to run

```bash
pnpm validate examples/patient.example.json   # missing-info check, no browser
pnpm enroll   examples/patient.example.json   # fill through Confirm, STOP (submit off)
pnpm enroll   examples/patient.example.json -- --submit   # actually submit (irreversible)
pnpm map                                       # drive the live form, snapshot unmapped steps
pnpm test                                      # unit tests
```

CLI entry: `src/cli.ts` (commander). Core entry: `enroll()` in `src/core/enroll.ts`
— transport-agnostic, so the future API trigger wraps the same function. Exit codes
are distinct per terminal status (see `exitCodeFor` in `src/cli.ts`).

## Guardrails (do not weaken without asking)

- **Submit is gated by the `submit` flag, default OFF.** Off = fill through Confirm,
  screenshot, and return `ready_to_submit`. On = run the (deferred) consent hook,
  click Submit, wait for the success redirect, capture confirmation.
- **Eligibility gate is commercial-insurance only.** Government insurance (Medicare,
  Medicaid, TRICARE, VA) is disqualifying by law. Enforced at the Savings step before
  advancing, regardless of the submit flag (`src/runner/eligibility.ts`).
- **On any page-structure mismatch, halt** (`page_mismatch`) — never guess, never submit.
- **Mapping never submits** — it stops before the irreversible Submit.
- **Never log raw PII.** Use the PII-safe logger (`src/logging/logger.ts`); artifacts
  (`artifacts/`, gitignored) may contain PII and are treated as sensitive.

## Hard-won facts about the live form (AEM Adaptive Form)

These are why the runner looks the way it does — keep them in mind before "simplifying":

1. **One DOM, hidden duplicates.** The whole wizard is in the DOM at once with hidden
   template copies of every field. **Every locator must filter to visible**
   (`.filter({ visible: true })`).
2. **Programmatic value-setting is silently rejected.** `.fill()` / setting `.value`
   populates the box but the validator ignores it and won't advance. Text is typed
   with `pressSequentially` (real key events). See `src/browser/field.ts`.
3. **Targeting.** Text inputs and the state `<select>` have clean, stable `name`
   attributes (`AccfirstName`, `dob`, `zipcode`, `stateDropdown`, …) — used directly.
   Radios have auto-generated names, so they are clicked by visible **label text**
   (`label_map`). ids/classes are auto-generated and brittle.
4. **The email field rejects `+`.** Gmail plus-aliasing does NOT work. Test addresses
   use Gmail's **dot trick** (`src/patient/testEmail.ts`): `c.canning10@gmail.com` ≡
   `ccanning10@gmail.com`. Insert ONLY dots — adding any other characters changes the
   mailbox.
5. **Advancement is the real acceptance signal.** A rejected field silently keeps you
   on the step. The runner confirms a transition by waiting for the step's unique
   `signature` phrase to disappear (`advanceStep` in `src/runner/step.ts`). Don't use
   generic radio labels ("Yes"/"No") for this — they substring-match the page's safety
   text.
6. **Conditional fields.** Some fields appear only after another choice (the upcoming
   treatment date after "No"; the mailing address after choosing commercial). They are
   marked `conditional: true` in the recipe — the guard skips them for initial
   presence, but `collectNeeds` still requires them. After a radio/select fill the
   runner settles briefly so the reveal/re-render lands before the next field.
7. **Disabled/auto fields.** The Savings mailing-address ZIP is disabled and
   auto-populated from the Profile ZIP — not listed in the recipe.

## The flow (5 steps)

Account → Treatment → Profile → Savings → Confirm. Field-by-field detail lives in
`recipes/skyrizi.yaml`; a human walkthrough is in `docs/enrollment-flow.md`.

## The Submit wall (why v1 stops at Confirm) — confirmed empirically

The final Submit **cannot be fully automated**, by the site's design:

1. The Confirm step has a **required consent checkbox** (`marketingnews1`): "I consent
   to the collection, use, and disclosure of my health-related personal data … for
   online targeted advertising…". This is the **deferred consent/authorization** — the
   runner does NOT auto-check it; it's a patient decision.
2. The step is protected by **invisible reCAPTCHA Enterprise** (anti-bot).

So `--submit` will fill everything, click Submit, and then fail to reach the success
URL (returning `error`). That earlier test created **no enrollment** — the form stays
put. The intended v1 behavior is the default: fill through Confirm, stop, and hand off
to a human who gives consent, clears the CAPTCHA, and submits. The `onBeforeSubmit`
hook + the wired `--submit` path remain for a future where consent is captured and
submission happens in an allowed context. Do not try to defeat the CAPTCHA or
auto-accept the health-data consent.

## Re-mapping when the form changes

1. Set the changed step's `mapped: false` (or stub its fields) in the recipe.
2. `pnpm map` — fills mapped steps with dummy data, snapshots the first unmapped step
   (labels + controls + screenshot) to `artifacts/mapping/<runId>/`, and stops before
   Submit.
3. Translate the snapshot into the recipe (name attrs for text/select, label text for
   radios, a unique `signature`, `conditional: true` for revealed-later fields).
4. Re-run `pnpm map` to reach the next step. Repeat to Confirm.

## Deferred / not in v1

- Patient consent/authorization: a no-op `onBeforeSubmit` hook is wired in front of
  Submit (`EnrollOptions.onBeforeSubmit`) — enforcement is future work.
- Self-healing recipes; capturing the digital card from the email; the HTTP API.

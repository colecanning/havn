# Havn — Skyrizi Co-Pay Enrollment Agent (v1)

## Context

Havn signs patients up for manufacturer co-pay assistance cards. v1 automates one
drug/manufacturer: the **Skyrizi Complete Savings Card (AbbVie)**, by filling
AbbVie's patient-facing enrollment wizard at
`https://www.skyrizi.com/skyrizi-complete/enrollment`.

The architecture is already decided (and correct): **map the form once → run it
deterministically per patient.** The form is identical for every patient; only the
data varies, and the final Submit is irreversible — so we do *not* run an LLM live
on each enrollment. Instead a declarative **recipe** (checked into the repo)
describes the flow, a **deterministic runner** executes it, and a **page-match
guard** halts if the live form drifts from the recipe rather than submitting into a
changed form. Self-healing is explicitly out of scope; re-map by hand when it breaks.

Adding more drugs later should be *config* (a new recipe), not code.

## Decisions locked in this session

- **Stack:** TypeScript + Node + Playwright (Chromium). Rationale above — Node-first
  Playwright, shared types with the TS frontend, trivial to wrap in the future API.
- **Interface:** transport-agnostic core `enroll(patient, opts)` function, wrapped by a
  CLI now. The future API trigger wraps the same core function — no rewrite.
- **Mapping:** done live in *this* build — drive the real form with dummy data to map
  steps 2–5 and finalize the recipe. **Hard-stop before Submit during mapping.**
- **Submit gating:** a `submit` flag, **default `false`** (fill through Confirm, then
  stop). When `true`, the runner performs the real Submit. A consent/authorization
  hook is wired in front of Submit but deferred (no-op in v1).
- **Test identity:** for real test submits use `ccanning10+<runId>@gmail.com` (Gmail
  `+` aliasing → all land in `ccanning10@gmail.com`, which the user checks to confirm
  the card arrived). Capturing the card *from* email is out of scope for now.

## Stack & tooling

- Runtime: Node + TypeScript (strict), `tsx` for running, `pnpm`.
- Browser: `playwright` (Chromium).
- Validation: `zod` for both patient and recipe schemas (runtime-validated, types derived).
- Recipe format: YAML via `js-yaml`, validated against the Zod recipe schema on load.
- CLI: `commander`. Tests: `vitest`. Config: `dotenv`.

## Documentation & commit discipline

- **`CLAUDE.md`** (repo root) — concise context for future Claude sessions: the
  map-once/run-deterministically model, the SPA native-event gotcha, where the recipe
  lives, how the submit flag + eligibility gate + page-match guard work, how to run
  `map` / `enroll` / `validate`, the test-email convention, and the "never submit
  during mapping / never guess on mismatch" rules.
- **`docs/enrollment-flow.md`** — human-readable walkthrough: what the agent does and
  why, the 5-step Skyrizi wizard, the recipe → runner → guard pipeline, the eligibility
  rationale (commercial-only, government insurance disqualifying by law), the
  irreversible-Submit handling, and how to add a second drug later (write a recipe).
  Written for a teammate, not for Claude.
- **Commits:** commit regularly at meaningful milestones (scaffold, schemas, runner,
  mapper, recipe finalized, tests). Authored as the git user (Cole Canning).
  **No Claude attribution anywhere** — no `Co-Authored-By: Claude`, no "Generated with
  Claude Code" trailer, nothing referencing Claude in any commit message or history.

## Project structure

```
havn/
  CLAUDE.md             # future-Claude context (see above)
  docs/enrollment-flow.md
  src/
    index.ts              # exports enroll(), validatePatient(), types
    cli.ts                # subcommands: enroll | validate | map
    core/
      enroll.ts           # orchestrator: load recipe → preflight → steps → (submit?) → capture
      types.ts            # EnrollOptions, EnrollResult (discriminated union), NeedsItem
    recipe/
      schema.ts           # Zod recipe schema
      load.ts             # read + parse + validate a recipe YAML
    patient/
      schema.ts           # Zod patient schema
      validate.ts         # missing-info → structured needs list
      testEmail.ts        # ccanning10+<runId>@gmail.com helper
    browser/
      session.ts          # launch context/page; teardown
      preflight.ts        # dismiss cookie banner + chat widget
      field.ts            # locate-by-label, native-event fill, verify accepted state
      guard.ts            # page-match guard (assert expected labels/buttons present)
    runner/
      step.ts             # one step: guard → fill fields → verify → advance
      eligibility.ts      # commercial-only gate (Savings step)
      confirm.ts          # capture confirmation artifacts
    mapper/
      map.ts              # drive live form w/ dummy data, snapshot each step, stop before Submit
    logging/logger.ts     # PII-safe structured logging (redaction)
  recipes/skyrizi.yaml    # the checked-in recipe (step 1 known; 2–5 filled by mapping)
  artifacts/              # gitignored: screenshots, confirmation/ mapping reports
  tests/
```

## Data model

**Patient (Zod)** — from spec: `diagnosis` enum
(`plaque_psoriasis|psoriatic_arthritis|crohns|ulcerative_colitis`), `first_name`,
`last_name`, `email`, `date_of_birth`, `address{line1,line2?,city,state,zip}`,
`phone`, `insurance_type` enum (`commercial|medicare|medicaid|va|tricare|other`).
Treatment-step fields are unknown until mapped — extend the schema after mapping.

**Recipe (Zod / YAML)** — `drug, manufacturer, url, form_type`,
`interaction{ target_by: label_text, events:[input,change,blur], verify_field_state }`,
`preflight[]`, `eligibility{ required_insurance: commercial, disqualifying:[...] }`,
`steps[]{ id, fields[]{ key, type, label|label_map, required }, advance{ button, irreversible? } }`,
`success_signal{ type: url_redirect, match: /skyrizi-complete/signup/confirmation }`.

**EnrollResult** — discriminated union, never throws past the boundary:
`needs_info{needs}` · `ineligible{reason}` · `page_mismatch{step,missingLabels}` ·
`validation_failed{step,field}` · `ready_to_submit{capture}` (submit=false) ·
`submitted{confirmation{url,cardId?,confirmationNumber?,screenshotPath}}` · `error{...}`.

## Key components (the parts that need care)

**Field fill — the SPA problem.** Fields are custom components, not native
`<input>`/`<select>`; setting `.value` or naive fill leaves them visually populated
but validation-rejected. Strategy per field, escalating until accepted:
1. Locate by **label text** (`getByLabel` → label-proximity fallback), never by the
   auto-generated CSS classes.
2. `locator.fill(value)` then `blur` (dispatches native `input`); re-check.
3. If not accepted: `click()` → `pressSequentially(value, {delay})` → explicit
   `dispatchEvent('change')` / `blur`.
4. Radios (diagnosis): click the option whose visible text matches `label_map[value]`.
5. **Verify accepted state per field** before advancing — check for the accepted cue /
   absence of the error marker near the label (exact selectors discovered during
   mapping, stored in recipe). Treat value-present + no-error as accepted.
6. N attempts with escalation; still rejected → `validation_failed`, halt.

**Page-match guard.** Before filling any step, assert every expected field label and
the advance-button text are present/visible. Missing → `page_mismatch` halt. Never guess.

**Eligibility gate (Savings step).** Co-pay assistance is commercial-insurance only;
government insurance (Medicare incl. Part D, Medicaid, TRICARE, VA) is disqualifying
by law. If `insurance_type !== commercial` → `ineligible` halt **before** advancing
past Savings — enforced regardless of the submit flag.

**Submit gating + consent hook.** Always fill through Confirm. `submit=false` (default):
capture the Confirm-page state (screenshot) and stop → `ready_to_submit`. `submit=true`:
invoke the (deferred, no-op) `onBeforeSubmit` consent hook, click Submit (recipe marks
it `irreversible`), wait for redirect to `success_signal.match`, capture confirmation.

**Missing-info handling.** `validatePatient(patient, recipe)` diffs provided fields
against the recipe's required-fields list across all steps; if anything required is
missing it returns a structured `needs` list (field + step) — never starts a partial
submission.

**PII-safe logging.** Logger redacts known PII keys (names, email, DOB, address,
phone, insurance); logs field *keys* and *accepted states*, never raw values.
`artifacts/` is gitignored; confirmation records store the confirmation id + runId +
timestamp, not raw patient PII.

## Build order

1. **Scaffold** — package.json, tsconfig (strict), `.gitignore` (node_modules,
   artifacts/, .env), deps, `playwright install chromium`.
2. **Schemas** — patient + recipe Zod schemas; recipe loader; `recipes/skyrizi.yaml`
   with Step 1 (Account) fully populated from the spec, steps 2–5 stubbed.
3. **Browser utilities** — session, preflight (dismiss cookie banner + chat widget),
   field fill (native events + verify), page-match guard.
4. **Runner + core** — step executor, eligibility gate, confirm capture; `enroll()`
   orchestrator with `submit` flag (default off) + consent-hook stub.
5. **Validation + logging** — missing-info needs list; PII-safe logger.
6. **CLI** — `enroll <patient.json> [--submit] [--headful]`, `validate <patient.json>`,
   `map`.
7. **MAP LIVE (this build)** — run `havn map`: preflight → fill Step 1 with dummy data
   (`ccanning10+map<id>@gmail.com`) → advance, snapshotting Treatment/Profile/Savings/
   Confirm (labels, field types, validation cues → `artifacts/mapping/`). Use plausible
   dummy data to pass per-step validation; select **commercial** to clear the
   eligibility gate. **Hard-stop before Submit.** First sub-task: probe for any
   staging/test path — if none, mapping stays short of Submit (it already does).
8. **Finalize recipe** — turn the mapping report into `recipes/skyrizi.yaml` steps 2–5;
   extend the patient Zod schema with any newly-discovered required Treatment fields.
9. **Tests + guarded e2e** — unit tests below; one real test submit with
   `--submit` + `ccanning10+<id>@gmail.com`; user checks inbox for the card.
10. **Docs** — `README` (usage), `CLAUDE.md` (future-Claude context), and
    `docs/enrollment-flow.md` (human walkthrough).

Commit at each milestone above (authored as Cole Canning, no Claude attribution).

## Hard rules / guardrails

- Final Submit is the only irreversible action — gated behind `submit=true` (default
  off) + the (deferred) consent hook.
- Eligibility gate enforced before Submit: commercial insurance only.
- On any page-structure mismatch: halt (`page_mismatch`), never guess, never submit.
- Mapping never submits.
- Capture confirmation artifacts for every successful enrollment.
- Never store raw PII in logs; treat patient + insurance data as sensitive.

## Verification

- **Unit (vitest):** missing-info → needs list; recipe load/validate rejects malformed
  YAML; eligibility gate (commercial passes; medicare/medicaid/va/tricare/other halt);
  field-state verify against a local fixture HTML.
- **Guard:** point the recipe at a renamed label → assert `page_mismatch` halt.
- **Mapping run:** `havn map` reaches the Confirm step, produces snapshots for steps
  2–5, and never clicks Submit.
- **End-to-end test submit:** `havn enroll patient.json --submit` with
  `insurance_type: commercial` and `ccanning10+<id>@gmail.com` → assert redirect to
  `/skyrizi-complete/signup/confirmation` + artifact captured; user confirms the card
  email arrives in `ccanning10@gmail.com`.

## Open questions (resolve during mapping, do not block the build)

- Staging/test environment vs. production-only (probe first; default assume prod-only,
  mapping stays short of Submit).
- Exact Treatment/Profile/Savings fields + the precise per-field validation-state
  selectors (mapping answers both).
- Where patient consent/authorization originates (hook wired, enforcement deferred).

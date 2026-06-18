# Havn — co-pay assistance enrollment agent

Automates enrolling a commercially-insured patient in a manufacturer co-pay
assistance card by filling the manufacturer's online enrollment form.

**v1:** Skyrizi Complete Savings Card (AbbVie). Built so adding more drugs later is a
new recipe, not new code.

## Approach

Map the form once → run it deterministically per patient. A declarative **recipe**
(`recipes/skyrizi.yaml`) describes the flow; a Playwright **runner** executes it; a
**page-match guard** halts if the live form drifts from the recipe rather than
submitting into a changed form. No LLM at run time. See
[docs/enrollment-flow.md](docs/enrollment-flow.md) for the human walkthrough and
[CLAUDE.md](CLAUDE.md) for engineering context.

## Setup

```bash
pnpm install
pnpm exec playwright install chromium
cp .env.example .env   # optional
```

## Usage

```bash
# Validate a patient record against the recipe's required fields (no browser):
pnpm validate examples/patient.example.json

# Dry run: fill through Confirm and STOP before Submit (default — submit is OFF):
pnpm enroll examples/patient.example.json

# Enroll for real (recommended): fill everything + consent, then a HUMAN clicks Submit
# (the form's invisible reCAPTCHA rejects automated submits). Opens a real browser:
pnpm enroll examples/patient.example.json -- --handoff --consent --test-email

# Auto-submit (left in for non-CAPTCHA forms; rejected by reCAPTCHA on Skyrizi):
pnpm enroll examples/patient.example.json -- --submit --consent --test-email

# Re-map the live form (drives it with dummy data, never submits):
pnpm map

# Tests:
pnpm test
```

Useful `enroll` flags: `--submit` (default off), `--headful`, `--test-email`,
`--run-id <id>`, `--slowmo <ms>`, `--recipe <path>`, `--artifact-dir <dir>`.

The CLI exits with a distinct code per outcome (0 ok/ready, 1 error, 2 needs-info,
3 ineligible, 4 page-mismatch, 5 validation-failed, 6 unmapped-step).

## Guardrails

- **Submit is gated by `--submit`, default OFF.** Off fills through Confirm and stops.
- **Commercial insurance only.** Government insurance (Medicare/Medicaid/TRICARE/VA) is
  disqualifying by law; enforced at the Savings step before Submit.
- **Halt on any page mismatch** — never guess, never submit into a changed form.
- **Mapping never submits.** PII is never logged; `artifacts/` is gitignored.
- Patient consent/authorization is **deferred** (a no-op hook is wired before Submit).

## Project layout

```
recipes/skyrizi.yaml   the checked-in recipe (all 5 steps mapped)
src/core/enroll.ts     enroll() orchestrator (the public entry point)
src/runner/*           step executor, eligibility gate, confirmation capture
src/browser/*          session, preflight, native-event field fill, page-match guard
src/recipe/*           recipe schema (zod) + loader
src/patient/*          patient schema, missing-info validation, test-email helper
src/mapper/map.ts      live-form mapper (for re-mapping)
src/cli.ts             CLI (enroll | validate | map)
docs/enrollment-flow.md  human walkthrough
```

## Notes

- The Skyrizi form is an AEM Adaptive Form: one DOM with hidden duplicate fields, custom
  validators that ignore programmatic value-setting, and an **email field that rejects
  `+`**. The runner filters to visible elements, types with real key events, and uses
  Gmail's dot trick for test addresses. Details in [CLAUDE.md](CLAUDE.md).
- **The final Submit is gated by invisible reCAPTCHA Enterprise** (confirmed: the server
  rejects automated submits with "CAPTCHA validation failed"). The agent can auto-check
  the required consent box (`--consent`, when consent was obtained from the patient), but
  it does **not** try to defeat the reCAPTCHA. Use **`--handoff`** to fill everything and
  let a human perform the final click. For scale, an official enrollment API is the
  durable path.

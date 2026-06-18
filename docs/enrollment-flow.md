# How the Skyrizi enrollment agent works

A plain-English walkthrough for a teammate. (Claude-specific notes live in
`../CLAUDE.md`; exact field details live in `../recipes/skyrizi.yaml`.)

## What it does

Havn signs a commercially-insured patient up for the **Skyrizi Complete Savings
Card** by filling AbbVie's online enrollment wizard for them. You give it a patient
record (JSON); it drives a real browser through the five-step form and either stops
just before the final Submit (the default, safe mode) or submits and captures the
confirmation.

## Why it's built "map once, run deterministically"

The enrollment form is the same for every patient — only the data changes — and the
final Submit can't be undone. Running an AI model live on every enrollment would be
slow, costly, and non-deterministic on an irreversible action. So instead:

1. We **mapped the form once** (by driving it with dummy data) and wrote down exactly
   what each step asks for in a **recipe** file (`recipes/skyrizi.yaml`).
2. A **deterministic runner** replays that recipe for each patient — ordinary browser
   automation, no AI at run time.
3. A **page-match guard** checks the live form still matches the recipe before
   touching anything. If AbbVie changes the form, the agent **stops and flags it**
   instead of submitting into a form it no longer understands.

When the form changes, a person re-maps it (a guided, semi-automated process) and
updates the recipe. That's the trade-off we chose for v1: simple and safe over
self-healing.

## The five steps

| Step | What it collects |
|------|------------------|
| **1. Account** | Diagnosis (one of four conditions), first name, last name, email |
| **2. Treatment** | Whether they've started Skyrizi; if not, their upcoming treatment date |
| **3. Profile** | Date of birth, sex, ZIP code, primary phone |
| **4. Savings** | Insurance type — **this is the eligibility gate** — then mailing address |
| **5. Confirm** | Review everything, then **Submit** (the only irreversible action) |

## The eligibility gate (important, and legal)

Co-pay assistance cards are for people with **private/commercial insurance only**.
Government insurance — Medicare (including Part D), Medicaid, TRICARE, VA — is
**disqualifying by law**. At the Savings step the agent checks the patient's insurance
type and, if it isn't commercial, **halts before going any further** and reports the
patient as ineligible. This happens no matter what the submit setting is.

## The final Submit (fully automated)

By default the agent fills the whole form and **stops at the Confirm step**, saving a
screenshot (`ready_to_submit`) — nothing irreversible. To actually enroll, the Submit
step has two things to handle:

1. A **required consent checkbox**: *"I consent to the collection, use, and disclosure of
   my health-related personal data … for online targeted advertising."* If you've
   collected the patient's consent first, run with **`--consent`** and the agent checks
   it. Without that flag it's never checked.
2. **Invisible reCAPTCHA.** This turned out **not** to be a bot wall — it's a *timing*
   quirk. The first Submit click kicks off the reCAPTCHA check, whose token isn't ready
   yet, so the first attempt is rejected and the page just jumps to the top. A second
   click, once the token has resolved, goes through. (We found this when a person had to
   click Submit twice by hand.) The agent now simply **retries the Submit** a few times
   until it lands.

So the modes are:

- **Default (no flag):** fill through Confirm and stop. Safe, nothing irreversible.
- **`--submit --consent` (fully automated — verified):** fills everything, checks
  consent, and retries Submit through the reCAPTCHA timing quirk until the confirmation
  page. No human needed. Run it on real Chrome, visible: add `--channel chrome --headful`.
- **`--handoff --consent` (fallback):** fills everything, then a person clicks Submit. Use
  if the automated submit ever stops working (e.g. the form changes).

For very high volume, an **official enrollment API/partnership** with AbbVie's co-pay
program is still the most durable path — but the consumer form is now fully automatable.

## What can happen at the end of a run

The runner never crashes out — it always returns one clear outcome:

- **needs_info** — the patient record is missing required fields (with a list). Nothing
  was started.
- **ineligible** — non-commercial insurance; halted at the eligibility gate.
- **page_mismatch** — the live form drifted from the recipe; halted without guessing.
- **validation_failed** — a field wouldn't validate / the step wouldn't advance.
- **ready_to_submit** — filled through Confirm and stopped (submit was off).
- **submitted** — submitted successfully, with confirmation artifacts saved.
- **unmapped_step** — a recipe step hasn't been mapped yet.

## Using it

```bash
# 1. Check a patient record has everything the form needs (no browser):
pnpm validate path/to/patient.json

# 2. Dry run — fill everything, stop before Submit, save a Confirm screenshot:
pnpm enroll path/to/patient.json

# 3. Real submission (irreversible):
pnpm enroll path/to/patient.json -- --submit
```

A patient record looks like `examples/patient.example.json`. Required up front:
diagnosis, first/last name, email; plus date of birth, sex, phone, address, insurance
type, and the treatment answer. The `validate` command tells you precisely what's
missing for a given recipe.

### Testing note: the email field rejects "+"

We wanted to use `you+test1@gmail.com`-style aliases so test enrollments all land in
one inbox. **The form rejects the `+` character.** Instead we use Gmail's *dot trick*:
Gmail ignores dots, so `c.canning10@gmail.com` and `cc.anning10@gmail.com` both deliver
to `ccanning10@gmail.com`. The CLI's `--test-email` option generates a unique dotted
address per run automatically.

## Adding another drug later

Adding a second manufacturer's card is meant to be **config, not code**: map its form
once, write a new recipe YAML next to `skyrizi.yaml`, and point the runner at it. The
engine (locating fields, native typing, the eligibility gate, submit gating, guards,
confirmation capture) is shared.

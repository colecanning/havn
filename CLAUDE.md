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
- A **deterministic runner** (`src/core/enroll.ts`) executes the recipe via a
  **pluggable backend** (`src/drivers/*`, chosen with `--driver`). The default
  `playwright` driver (`src/runner/*` + `src/browser/*`) uses plain Playwright — no
  model at runtime. (`os`, a no-CDP backend, is a stub — it proved unnecessary; see
  `docs/submit-and-recaptcha.md`.)
- A **page-match guard** halts if the live form no longer matches the recipe rather
  than submitting into a changed form.

Self-healing is out of scope. When the form changes, re-map by hand (see below).

## How to run

```bash
pnpm validate examples/patient.example.json    # missing-info check, no browser
pnpm enroll   examples/patient.example.json    # fill through Confirm, STOP (submit off — default)

# Fully automated submit (VERIFIED). Must be headed real Chrome. --consent ONLY when
# patient consent was obtained out-of-band. --test-email routes to the dot-trick inbox.
# (Flags go directly after the file — NO bare `--`; see the gotcha below.)
pnpm enroll examples/patient.example.json --submit --consent --channel chrome --headful --test-email

# Fallback: agent fills everything, a human clicks the final Submit:
pnpm enroll examples/patient.example.json --handoff --consent --channel chrome

# Run the headed browser in the cloud (Browserbase) instead of this laptop. Genuinely
# headed Chrome + residential proxy; needs BROWSERBASE_API_KEY/PROJECT_ID in .env and a
# paid (Developer+) plan for the proxy. NOTE: flags go AFTER the file with NO bare `--`
# (see the gotcha below). The Submit is reCAPTCHA-blocked INTERMITTENTLY (per-session/IP), so
# this AUTO-RETRIES the whole enrollment on a fresh session/IP up to 5x (stops on first success;
# failed attempts create no enrollment). See docs/submit-and-recaptcha.md.
pnpm bb:spike                                                          # non-destructive connectivity check first
pnpm bb:fp                                                             # IP + GPU + live reCAPTCHA v3 score (non-destructive)
pnpm enroll examples/patient.example.json --remote browserbase --submit --consent --test-email

pnpm map                                        # drive the live form, snapshot unmapped steps
pnpm test                                       # unit tests
```

> **`--` gotcha (pnpm 9.x — verified):** pnpm forwards a bare `--` to the script, and
> commander treats everything after it as ignored operands. So `pnpm enroll FILE -- --submit`
> silently runs with submit OFF (and drops every other flag). Put flags **directly after the
> file** with NO `--` (pnpm forwards them fine), or run `npx tsx src/cli.ts enroll FILE
> --submit …`. This applies to every `pnpm` command here (`enroll`/`validate`/`map`).

Key flags: `--submit` (default off), `--consent`, `--channel chrome`, `--headful`,
`--handoff`, `--driver playwright|os`, `--no-human` (faster, skips human-like typing),
`--user-data-dir <dir>` (persistent profile), `--headless-new`,
`--remote browserbase` (cloud headed via Browserbase; `--bb-geo <state>`, `--no-bb-proxy`).
CLI entry: `src/cli.ts` (commander). Core entry: `enroll()` in `src/core/enroll.ts` —
transport-agnostic, so the future API trigger wraps the same function. Exit codes are
distinct per terminal status (`exitCodeFor` in `src/cli.ts`).

## Guardrails (do not weaken without asking)

- **Submit is gated by the `submit` flag, default OFF.** Off = fill through Confirm,
  screenshot, return `ready_to_submit`. On = (check the consent box if `--consent`),
  retry-click Submit until the success redirect, capture confirmation. `--handoff`
  instead leaves a human to click Submit. Submit requires headed real Chrome.
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

## The Submit: consent checkbox + a reCAPTCHA TIMING quirk (solved)

The Confirm step has two things to handle:

1. A **required consent checkbox** (`marketingnews1`): "I consent to the collection,
   use, and disclosure of my health-related personal data … for online targeted
   advertising…". The runner checks it ONLY when `consentObtained` is set (`--consent`)
   — i.e. consent was obtained from the patient out-of-band. Never check it otherwise.
   (`applyConsent` in `src/runner/step.ts`.)
2. **Invisible reCAPTCHA Enterprise** — but it is **NOT** a bot wall here. It is a
   **timing quirk**: the first Submit click triggers the reCAPTCHA `execute()`, whose
   token resolves asynchronously, so the first POST fires before the token is ready and
   is rejected (`400 CaptchaValidationException`, "token invalid or malformed") — the
   page just scrolls to top. **A subsequent click, once the token has resolved,
   succeeds.** This was discovered when a human had to click Submit twice manually.

**The fix: retry the Submit.** `enroll()` clicks Submit, waits ~10s for the success
redirect, and re-clicks up to `SUBMIT_ATTEMPTS` (5) times (`src/core/enroll.ts`). The
click that triggers the success navigation can throw "element detached" — that's caught;
`awaitSuccess` (URL redirect) is the source of truth. **Verified: fully automated submit
succeeds** (typically on the 2nd–3rd attempt) and a real enrollment + card is created.

Verified working config: **`--submit --consent --channel chrome --headful`** (real
Chrome, headed; default human-like typing on). Earlier single-click attempts failed only
because they never retried — the "CDP detection" theory was **wrong**. We did not need
nut.js / OS-input / a no-CDP driver.

**Headless does NOT work** (tested): both old headless and Chrome "new" headless
(`--headless-new`) fill the form fine but the Submit is rejected by reCAPTCHA every time
(5/5 retries) — reCAPTCHA scores headless as bot. **A genuinely headed browser with a
display is required.** For a server, run headed Chrome under a **virtual display (xvfb)**
on Linux; on macOS you need a real logged-in GUI session. Or run it off-laptop on
**Browserbase** (`--remote browserbase`) — genuinely headed cloud Chrome + residential
proxy, no xvfb to manage. **Measured 2026-06-24: the Submit is INTERMITTENT on Browserbase** —
two back-to-back real `--submit` runs, identical config: one PASSED (reCAPTCHA cleared on the
2nd retry, real enrollment created), the next FAILED 5/5 with
`CaptchaValidationException: "The response parameter is invalid or malformed."` A valid
~2.6k-char token was generated + attached on every attempt, so this is **AbbVie's server
rejecting Google's verdict for that session**, not a token bug on our side. Pass/fail is
**per-session (its IP/standing)**: a bad session fails all 5 retries (same IP), which is why
the click-retry loop AND `--handoff` (human clicks in the same session) both fail on a bad
session. Browserbase itself is clean — `pnpm bb:fp` shows a **real Intel GPU**
(`navigator.webdriver:false`) and **0.9 reCAPTCHA v3 across 5 IPs** on a generic key — so the
lever is the egress **IP reputation** for AbbVie's sitekey, not the fingerprint.

**Fallback shipped — session-level retry (default ON for Browserbase).** Because the block is
per-session, `enroll` now **re-runs the whole enrollment on a fresh Browserbase session/IP up to
5 total attempts** (`MAX_SESSION_RETRIES=4`), stopping on the first success
(`runWithSessionRetry` in `src/core/enroll.ts`; the captcha failure is flagged `retryable`).
Failed attempts create no enrollment, so only the first success ever submits — no duplicates.
**Verified 2026-06-24:** a real run was reCAPTCHA-blocked on attempt 1, then **succeeded on a
fresh session (attempt 2)** and created the card. Local runs do NOT retry (same IP = no gain).
The other within-policy lever, not yet built: a higher-trust **mobile/dedicated-ISP proxy**
(Browserbase BYO external proxy) to raise the per-session pass rate. NOTE: an earlier "400'd
5/5, needs warmed Google identity" claim AND a same-day "Submit PASSES" claim were both
over-stated; the accurate picture is intermittent-with-retry (see
`docs/submit-and-recaptcha.md`). Separately, an intermittent **click-interception** flake
(floating ISI/safety-bar/menubar chrome covering below-the-fold fields) is **fixed** by
`neutralizeFloatingOverlays` (`src/browser/preflight.ts`), now run before every field/advance
click — the form fills reliably; only the captcha is intermittent. `--handoff` helps only on a
good-IP session. **Never** add CAPTCHA-solving/token-relay services.

| | **Headed** (real Chrome) | **Headless** (old + `--headless-new`) |
|---|---|---|
| reCAPTCHA score | 0.1–0.3 (passes) | **0.00** (Google hard-flags it) |
| Fills 5 steps? | ✅ | ✅ |
| Submit passes? | ✅ (with retry) | ❌ 5/5 rejected |
| Needs a display? | yes (real or xvfb) | no |
| **Verdict** | **use this** | dead end for Submit |

**Full breakdown** — every approach tried (what works / doesn't / is in the code), the
score data, and how to scale past reCAPTCHA legitimately (hub/API vs. profile farms):
see **`docs/submit-and-recaptcha.md`**.

### Measured reCAPTCHA v3 score (cleantalk.org test, a proxy for the Enterprise score)
- Any headless mode: **0.00** (flat floor — Google hard-flags headless; no tweak helped).
- Headed real Chrome: **0.1–0.3** (low but nonzero; enough to pass AbbVie with the retry).
- The FINGERPRINT_MASK and `--disable-blink-features=AutomationControlled` did **not**
  reliably raise the headed score — so the levers are NOT fingerprint tweaks. The real
  levers for a higher/steadier score are: a **warmed profile signed into a Google account
  with browsing history** (`havn warm --user-data-dir <dir>`), a **residential IP** with
  good reputation, and **not hammering reCAPTCHA** (one check per enrollment is fine;
  rapid repeated checks lower the IP's score). The 0.1–0.3 readings are pessimistic —
  back-to-back score tests had already degraded this IP.

### History (for context)
Before the timing quirk was understood, we tried headless, headed real Chrome, a
persistent profile + fingerprint mask (`session.ts` FINGERPRINT_MASK), and full
human-like behavior (`browser/human.ts`) — all "failed", but only because each did a
single Submit click. The human-behavior + warmed-profile code is kept (it's correct and
may help the score / makes handoff natural); the **retry** is what actually mattered.

## Re-mapping when the form changes

1. Set the changed step's `mapped: false` (or stub its fields) in the recipe.
2. `pnpm map` — fills mapped steps with dummy data, snapshots the first unmapped step
   (labels + controls + screenshot) to `artifacts/mapping/<runId>/`, and stops before
   Submit.
3. Translate the snapshot into the recipe (name attrs for text/select, label text for
   radios, a unique `signature`, `conditional: true` for revealed-later fields).
4. Re-run `pnpm map` to reach the next step. Repeat to Confirm.

## Deferred / not in v1

- Patient consent: the runner checks the required consent box only with `--consent`
  (consent obtained out-of-band). The consent-capture/recording **workflow** and the
  `onBeforeSubmit` audit hook (`EnrollOptions.onBeforeSubmit`, currently no-op) are
  future work.
- Running unattended on a server (needs headed-under-xvfb; see
  `docs/submit-and-recaptcha.md`); the no-CDP `os` driver (stubbed, unnecessary).
- Self-healing recipes; capturing the digital card from the email; the HTTP API.

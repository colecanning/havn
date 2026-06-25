# The final Submit, reCAPTCHA, and headed-vs-headless

Reference for the one genuinely hard part of this project: getting AbbVie's
reCAPTCHA-protected Submit to go through, fully automated. The form-filling itself
(all five steps) is solved and deterministic; this doc is about the Submit.

## TL;DR

- The Confirm step has a **required consent checkbox** + **invisible reCAPTCHA
  Enterprise**.
- reCAPTCHA was **not** a bot wall — it was a **timing quirk**: the first click fires
  the submit POST before the async reCAPTCHA token is ready, so it 400s and the page
  scrolls to top. **Retrying the click** (once the token resolves) succeeds.
- Full automation works **on headed real Chrome**. Headless is a hard dead end
  (reCAPTCHA scores it 0.00).

Verified working command:

```bash
pnpm enroll examples/patient.example.json --submit --consent --channel chrome --headful --test-email
```

## Approaches we tried

Legend: ✅ works · ❌ doesn't · ⚪ no measurable effect / inconclusive · ⛔ not built

| Approach | Status | In the code? |
|---|---|---|
| Fill via native key events (`pressSequentially`) | ✅ fills all 5 steps reliably | ✅ default |
| Auto-check the required consent box (`--consent`) | ✅ works | ✅ |
| Submit with a **single** click | ❌ token not ready → reCAPTCHA 400 | ➖ replaced by retry |
| **Submit with retry loop** (click → wait → re-click ×5) | ✅ **full automation, no human** | ✅ default (`SUBMIT_ATTEMPTS=5`) |
| Headed **real Chrome** (`--channel chrome --headful`) | ✅ required for submit to pass | ✅ |
| Headless — old shell **and** `--headless-new` | ❌ reCAPTCHA scores it 0.00 | ✅ option exists, doesn't pass |
| Handoff — human clicks Submit (`--handoff`) | ✅ works (fallback) | ✅ |
| Human-like typing/typos/scroll/pauses | ⚪ realistic, didn't fix submit alone | ✅ default on (`--no-human` off) |
| Fingerprint mask (`navigator.webdriver`, plugins…) | ⚪ no measurable score effect | ✅ always applied (`session.ts`) |
| `--disable-blink-features=AutomationControlled` | ⚪ no measurable effect | ❌ tested only, not kept |
| Persistent/warmed profile (`--user-data-dir`, `warm`) | ⚪ cold = no help; warmed + Google login = the real lever (untested) | ✅ |
| **Browserbase cloud (`--remote browserbase`)** | **Submit INTERMITTENT, handled by session-retry** (2026-06-24): captcha is per-session/IP (one run passed, one failed 5/5). Fix: auto-retry the whole enroll on a fresh session/IP up to 5x (`runWithSessionRetry`) — verified blocked@1 → passed@2. Form-fill reliable; click-retry & handoff don't save a bad session. | ✅* |
| no-CDP OS-input driver (nut.js) | ⛔ retry made it unnecessary | ⛔ `--driver os` is a stub that errors |

## Headed vs headless

| | **Headed** (real Chrome) | **Headless** (old shell *and* `--headless-new`) |
|---|---|---|
| reCAPTCHA v3 score | **0.1–0.3** (low, but nonzero) | **0.00** (flat — Google hard-flags it) |
| Fills all 5 steps? | ✅ yes | ✅ yes |
| Final Submit passes? | ✅ yes (with retry) | ❌ no — 5/5 attempts rejected |
| Needs a display? | yes (real or virtual) | no |
| Fingerprint tweaks help? | n/a (already passes) | ❌ no — score stays 0.00 |
| **Verdict** | **Use this.** Works today. | **Dead end for submit.** Only the *form-fill* works. |

The single factor that decides pass/fail is headed vs headless, and headless is
unfixable. For a server, don't go headless — run **headed under a virtual display
(xvfb on Linux)** so Chrome is genuinely headed without a monitor (macOS needs a real
logged-in GUI session).

## Running headed in the cloud (Browserbase)

Instead of managing xvfb on a box, run the genuinely-headed Chrome on **Browserbase** and
drive it with the same Playwright code over CDP. `enroll --remote browserbase` connects to
a Browserbase session (`chromium.connectOverCDP`) and reuses the existing context/page; the
local options (`--channel`, `--headful`, `--user-data-dir`) are inert in this mode because
Browserbase owns the browser. Code: `src/browser/browserbase.ts` + the remote branch in
`src/browser/session.ts`. Needs `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` in `.env`.

```bash
# Residential proxy ON by default (the IP-reputation lever). Flags go AFTER the file —
# a bare `--` makes commander stop parsing options (see CLAUDE.md "How to run").
pnpm enroll examples/patient.example.json --remote browserbase --submit --consent --test-email
pnpm bb:spike          # non-destructive connectivity check (no submit) — run this first
```

Why Browserbase fits the two real levers:

- **Genuinely headed.** Verified by `pnpm bb:spike`: `navigator.webdriver` is `false`, the
  UA is normal desktop Chrome with **no "Headless"**, on a real X11 display — so it should
  not hit the headless 0.00 floor. (Browserbase markets these as "verified" browsers.)
- **Residential IP.** Browserbase's managed **residential proxy** is on by default here
  (`--bb-geo <state>`, default NY to match our `America/New_York` timezone). This is the
  documented IP lever. **`--no-bb-proxy`** disables it — for free-plan connectivity testing
  ONLY; a datacenter IP is the wrong reputation signal for the real Submit.

Three deliberate differences from local mode:

- **`solveCaptchas: false` is hardcoded.** Browserbase enables a third-party CAPTCHA solver
  by default; repo policy forbids CAPTCHA-solving/token-relay services, so we always disable
  it. (It targets visible challenges anyway; invisible v3/Enterprise is score-based.)
- **`FINGERPRINT_MASK` is NOT applied in remote mode.** Browserbase ships a real fingerprint;
  layering our fakes (fake `plugins`, `webdriver=undefined`) on top would create
  inconsistencies a detector could flag.
- **Viewport is set at session-create** (1280×900, matching the local CONTEXT_DEFAULTS).
  We reuse Browserbase's existing context, so we can't size it later; a shorter viewport let
  the sticky safety bar overlap the form fields.

**Fresh-session overlay quirks (fixed in `src/browser/preflight.ts`).** A clean cloud browser
(no prior cookies) exposed two click-blockers the warmed laptop profile never hit, so preflight
now handles both (helps any fresh/headed browser, incl. xvfb servers):
1. The live form serves an **IAB-TCF OneTrust banner with no "Reject All"** button, so the
   reject-click candidates all miss. Preflight now **removes the OneTrust consent overlay** as
   a fallback (accepts no cookies) so it stops intercepting clicks.
2. AbbVie's sticky **"Important Safety Information" bar** floats over below-the-fold fields and
   intercepts the click after Playwright scrolls them into view. Preflight now makes it
   **`pointer-events:none`** (we never click it).

### Status — 2026-06-24 (two distinct problems: interception FIXED, captcha INTERMITTENT)

> **Two earlier claims here were both wrong and are superseded by this entry.** First "rejected
> 5/5, needs a warmed Google identity"; then (over-correcting on one lucky success) "Submit
> PASSES." The accurate, measured picture is **intermittent**.

- **Submit: INTERMITTENT (measured on two identical back-to-back real runs).**
  - Run A PASSED: reCAPTCHA cleared on the **2nd retry**, valid ~2,532-char token, **zero 400s**,
    redirect to confirmation, real enrollment + card created.
  - Run B FAILED **5/5**: every attempt attached a fresh valid ~2.6k-char token, every submit
    POST returned **HTTP 400** with body
    `CaptchaValidationException: "The response parameter is invalid or malformed."` (captured in
    `net-errors.log` via `HAVN_LOG_NETWORK=1`). No enrollment created.
  - So the token is generated + attached fine; **AbbVie's server rejects Google's verdict for
    that session.** Pass/fail is **per-session, set by the egress IP/standing** — a bad session
    fails all 5 retries (same IP), which is exactly why the **click-retry loop and `--handoff`
    (human clicking in the same session) both fail on a bad session.** The retry only rescues the
    *token-timing* quirk inside a good session.
- **Browserbase itself is clean — the fingerprint is NOT the lever.** `pnpm bb:fp` across 5 fresh
  sessions/IPs returned **0.9** reCAPTCHA v3 each time, **real Intel GPU**
  (`Mesa Intel(R) UHD Graphics 630`, not SwiftShader/llvmpipe), `navigator.webdriver:false`. But
  that's a *generic* sitekey; AbbVie's Enterprise sitekey scores per-site and rejects some
  sessions. The lever is **egress IP reputation for AbbVie's key**, not fingerprint/stealth.
- **Within-policy levers to raise the pass rate (neither guaranteed; never solve captchas):**
  1. **Session-level retry — BUILT & VERIFIED (default ON for Browserbase).** On a captcha block,
     `enroll` tears down the session and re-runs the whole enrollment on a **fresh session (new
     IP)**, up to **5 total attempts** (`MAX_SESSION_RETRIES=4`), stopping on the first success.
     Failed attempts create no enrollment, so only the first success enrolls — no duplicates.
     `runWithSessionRetry` in `src/core/enroll.ts` (acts on the `retryable` flag set when the
     Submit is reCAPTCHA-blocked); local runs don't retry (same IP). **Verified 2026-06-24:** a
     real run was blocked on attempt 1, then **succeeded on attempt 2** (fresh IP) and created the
     card. Unit tests cover succeed-on-retry / exhaust-at-5 / no-retry-on-ineligible
     (`tests/driver.test.ts`).
  2. **Higher-trust IP (not yet built)** — a **mobile (CGNAT)** or **dedicated/ISP residential**
     proxy via Browserbase **bring-your-own external proxy** (`docs.browserbase.com/features/proxies`).
     Mobile/ISP IPs carry much higher baseline trust than a shared rotating residential pool, so
     they'd raise the *per-session* pass rate (fewer retries needed). Stacks with #1.
  3. The durable high-volume answer remains the **front-door hub/API** (below).
- **Separately: click-interception flake — FIXED.** On below-the-fold fields (treatment "No"
  radio, profile DOB), floating chrome (inline ISI `abbv-inline-use-isi`, sticky
  `[role="menubar"]`, safety bar) intercepted clicks and killed runs with a generic validation
  error — easy to misread as "a captcha error." Fix: `neutralizeFloatingOverlays`
  (`src/browser/preflight.ts`), generalized + run **before every field and advance/Submit click**
  (`fillField` in `src/browser/field.ts`, `humanType` in `src/browser/human.ts`, `clickAdvance`
  in `src/runner/step.ts`), plus scroll-to-center + force-click fallback. Verified: the form now
  fills through Confirm reliably (the captcha is the only remaining intermittency).
- **Diagnostics:** `pnpm bb:fp` (non-destructive IP + GPU + v3 score) and
  `HAVN_LOG_NETWORK=1 HAVN_DEBUG_RECAPTCHA=1` on a real run (captures the 400 body + token shape).

## Measured reCAPTCHA score (cleantalk.org v3 test — proxy for the Enterprise score)

- Any headless mode: **0.00** (flat floor; no fingerprint tweak moved it).
- Headed real Chrome: **0.1–0.3** (low but nonzero; passes AbbVie with the retry).
- The result panel showed **no error codes** (valid token, normal UA, residential IP) —
  so the low score is **reputation/behavior, not a broken fingerprint**. That's why
  masks/flags don't help.
- The real levers for a higher, steadier score: a **warmed profile signed into a Google
  account** with real history, a **residential IP**, and **one reCAPTCHA hit per
  enrollment** (rapid back-to-back checks degrade the IP — our 0.1–0.3 readings were
  pessimistic for that reason).

## Scaling past reCAPTCHA — the honest landscape

- **Persistent pre-warmed profile (what we support):** a `--user-data-dir` signed into
  Google, reused at a sane rate on a residential IP, holds a usable score. Fine bridge
  for **low volume**; one profile/account/IP does not scale to high volume (same
  profile submitting many patients is a detectable pattern + against AbbVie ToS).
- **Profile farms + residential proxies + antidetect browsers** (Multilogin/GoLogin/
  etc.): how scrapers/multi-account operators scale past reCAPTCHA. It works but it is
  ban-evasion infrastructure — an arms race, ToS-violating, and **routing PHI through
  farmed accounts/residential proxies is a serious compliance/reputational liability**.
  Not recommended for a healthcare product.
- **The legitimate scale answer:** go through the front door. Skyrizi Complete is run by
  a copay-program **hub/administrator** that offers sanctioned bulk channels — a
  provider/partner **portal, enrollment API/EDI, or e-form intake under a BAA**. No
  reCAPTCHA, reliable, compliant. This is how real patient-services companies enroll at
  volume and is the durable path for Havn.
- **Never** integrate CAPTCHA-solving/token-relay services.

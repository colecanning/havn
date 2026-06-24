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
| **Browserbase cloud (`--remote browserbase`)** | full cloud fill verified; Submit 400s 5/5 on BOTH datacenter AND residential-proxy IP (missing lever: warmed Google identity / handoff) | ✅ |
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

### Status (2026-06-24)

- **Full cloud fill: verified.** `enroll --remote browserbase` fills all 5 steps, passes the
  eligibility gate, checks consent, and reaches Confirm — identical `EnrollResult` to local.
  `pnpm bb:spike` separately confirms genuinely-headed + form reachability.
- **Submit on free-tier datacenter IP: rejected 5/5 (measured).** A real
  `--submit --consent --no-bb-proxy` run filled everything, then the reCAPTCHA retry loop
  failed all 5 attempts and returned `error` — **no enrollment created**. This is exactly the
  predicted datacenter-IP outcome and matches local headless: the gate is **IP reputation**,
  not the fill.
- **Submit WITH the residential proxy (Developer plan): ALSO rejected 5/5 (measured).**
  Confirmed the proxy engaged — egress was a real **residential IP** (Verizon `173.56.x`),
  genuinely headed (`webdriver:false`, no "Headless"). With `HAVN_LOG_NETWORK=1`, every one of
  the 5 Submit POSTs to `…/adobe/forms/af/submit/…` returned **HTTP 400**
  (`CaptchaValidationException` — the same server-side bot-flag). So **headed + residential IP +
  retry + human-typing is NOT sufficient on a fresh Browserbase session.**
- **The missing lever is identity/reputation, not the IP.** A fresh cloud session has **no
  warmed Google-signed-in profile, no history, no reputation cookies** — the very signal the
  score-section below says dominates. The shared residential-proxy IP's reputation is also
  unknown. reCAPTCHA Enterprise scores this too low regardless of the (correct) headed +
  residential setup.
- **Where that leaves Browserbase auto-submit.** Full fill works; the Submit does not pass
  unattended. Options, in order of effort: (1) **warm a Browserbase Context** — sign into a
  Google account + browse, persist it, reuse for enroll (replicates the local lever; Google may
  challenge a cloud/residential login); (2) **handoff over Browserbase** — surface the live-view
  URL and let a human click Submit (passes reCAPTCHA naturally; not fully automated); (3)
  **Scale-plan "Verified" browser** (higher trust, custom pricing); (4) the durable answer —
  the **front-door hub/API** (below). Not yet tried: (1)–(3).

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

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
pnpm enroll examples/patient.example.json -- --submit --consent --channel chrome --headful --test-email
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

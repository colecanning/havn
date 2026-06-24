/**
 * Browserbase connectivity spike — run BEFORE trusting the cloud path for a real submit.
 *
 *   pnpm bb:spike
 *
 * It is deliberately NON-DESTRUCTIVE: it connects to a Browserbase session over CDP, proves
 * the browser is genuinely headed and egresses through a residential proxy IP, confirms the
 * live Skyrizi form is reachable from that IP, screenshots it, and releases the session.
 * It NEVER fills or submits anything. The real reCAPTCHA test is the actual enrollment
 * (flags go directly after the file — NO bare `--`, or pnpm hides them from commander):
 *   pnpm enroll examples/patient.example.json --submit --consent --remote browserbase --test-email
 *
 * Goal: de-risk the plumbing (auth, proxy, connect, reachability) so the only remaining
 * unknown when you run the real submit is the reCAPTCHA score itself.
 */
import "dotenv/config";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  createBrowserbaseSession,
  releaseBrowserbaseSession,
  getBrowserbaseLiveViewUrl,
} from "../src/browser/browserbase.js";
import { loadRecipe } from "../src/recipe/load.js";

async function main(): Promise<void> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    console.error("Set BROWSERBASE_API_KEY (and ideally BROWSERBASE_PROJECT_ID) in .env first.");
    process.exit(1);
  }
  const recipe = loadRecipe("recipes/skyrizi.yaml");
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  // Prefer the residential proxy (the reCAPTCHA lever). It needs a paid (Developer+) plan;
  // on the free plan Browserbase 402s, so fall back to a proxy-less session to still prove
  // the connect plumbing — but loudly, because no-proxy is NOT viable for the real Submit.
  let remote;
  let usedProxy = true;
  try {
    remote = await createBrowserbaseSession({
      apiKey,
      ...(projectId ? { projectId } : {}),
      geolocation: { country: "US", state: "NY" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/prox(y|ies)|paid plan|free plan|402/i.test(msg)) {
      console.warn(`\n⚠️  Residential proxy unavailable (${msg.trim()}).`);
      console.warn("   Falling back to a NO-PROXY session to validate connectivity only.");
      console.warn("   The residential proxy is required for the real Submit — upgrade the plan.\n");
      usedProxy = false;
      remote = await createBrowserbaseSession({
        apiKey,
        ...(projectId ? { projectId } : {}),
        proxy: false,
      });
    } else {
      throw err;
    }
  }
  console.log(`Proxy: ${usedProxy ? "residential (ON)" : "OFF (free-plan fallback)"}`);
  console.log(`Browserbase session: ${remote.sessionId}`);
  const liveUrl = await getBrowserbaseLiveViewUrl(remote.bb, remote.sessionId);
  if (liveUrl) console.log(`Live view (watch it run): ${liveUrl}`);

  const browser = await chromium.connectOverCDP(remote.connectUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Browserbase returned no default context");
    const page = context.pages()[0] ?? (await context.newPage());

    // 1. Egress IP — should be a residential proxy IP, NOT this laptop's address.
    await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded" });
    console.log(`Egress IP: ${(await page.evaluate(() => document.body?.innerText ?? "")).trim()}`);

    // 2. Automation / headed diagnostics — reCAPTCHA hard-flags headless (UA contains
    //    "Headless") and any leftover webdriver signal. We want webdriver falsy + no
    //    "Headless" in the UA.
    const diag = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      headlessInUA: /headless/i.test(navigator.userAgent),
      userAgent: navigator.userAgent,
      languages: navigator.languages,
      hasChrome: "chrome" in window,
    }));
    console.log("Diagnostics:", JSON.stringify(diag, null, 2));

    // 3. Reachability of the live Skyrizi form from this IP (a GET only — never submits).
    await page.goto(recipe.url, { waitUntil: "domcontentloaded" });
    console.log(`Form title: ${await page.title()}`);
    mkdirSync("artifacts/bb-spike", { recursive: true });
    const shot = `artifacts/bb-spike/skyrizi-${remote.sessionId}.png`;
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`Screenshot: ${shot}`);

    console.log("\nSpike OK. If the IP is residential, the UA has no 'Headless', and the form");
    console.log("rendered, the plumbing is good — run the real submit through the CLI next.");
  } finally {
    await browser.close().catch(() => {});
    await releaseBrowserbaseSession(remote.bb, remote.sessionId);
    console.log("Session released.");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

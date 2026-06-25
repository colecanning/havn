/**
 * Browserbase FINGERPRINT diagnostic — confirms (or refutes) the reCAPTCHA-score ceiling.
 *
 *   pnpm bb:fp
 *
 * NON-DESTRUCTIVE: connects to a Browserbase session over CDP under the SAME conditions as a
 * real enroll (residential proxy, NY geo), reads the environment signals reCAPTCHA Enterprise
 * scores BEFORE any click, and releases the session. It never touches the Skyrizi form.
 *
 * The headline signal is the WebGL UNMASKED_RENDERER string. Cloud Linux Chrome with no real
 * GPU returns a SOFTWARE renderer ("SwiftShader" / "llvmpipe" / "Mesa"), which every major
 * anti-bot system has catalogued as a bot tell and which CANNOT be spoofed from JS. If that's
 * what we see, it confirms the score is environment-capped (which is why even a human click in
 * the live view fails) — and that a proxy swap ALONE won't be enough.
 *
 * A best-effort reCAPTCHA v3 score probe (antcpt) is included; it's flaky from cloud IPs, so a
 * failure there is logged and ignored — the WebGL read is the deterministic part.
 */
import "dotenv/config";
import { chromium, type Page } from "playwright";
import {
  createBrowserbaseSession,
  releaseBrowserbaseSession,
  getBrowserbaseLiveViewUrl,
} from "../src/browser/browserbase.js";

// Genuine SOFTWARE rasterizers only. NB: bare "Mesa" is NOT software — Mesa is the Linux
// driver stack that also drives real GPUs (e.g. "Mesa Intel(R) UHD Graphics 630"). The actual
// software fallbacks are llvmpipe / softpipe / swrast (Mesa's) and SwiftShader (Google's).
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|swrast|microsoft basic|\bsoftware\b/i;

/** Read WebGL vendor/renderer (incl. the UNMASKED values via WEBGL_debug_renderer_info).
 *  NOTE: no named inner function — tsx/esbuild would inject a `__name` helper that doesn't
 *  exist in the browser context (ReferenceError: __name is not defined). A flat loop avoids it. */
async function readWebgl(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const result: Record<string, unknown> = {};
    for (const type of ["webgl", "webgl2"]) {
      try {
        const gl = document.createElement("canvas").getContext(type) as WebGLRenderingContext | null;
        if (!gl) {
          result[type] = null;
          continue;
        }
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        result[type] = {
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
          unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        };
      } catch (e) {
        result[type] = `error: ${String(e)}`;
      }
    }
    return result;
  });
}

/** Best-effort reCAPTCHA v3 score from antcpt's public detector. Flaky from cloud IPs. */
async function probeScore(page: Page): Promise<string> {
  try {
    await page.goto("https://antcpt.com/score_detector/", { waitUntil: "domcontentloaded", timeout: 30_000 });
    // The page runs grecaptcha on a timer and prints "Your score is: 0.X".
    await page.waitForFunction(() => /your score is/i.test(document.body?.innerText ?? ""), {
      timeout: 30_000,
    });
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const m = text.match(/your score is:?\s*([0-9.]+)/i);
    return m ? m[1] : "(shown but unparsed)";
  } catch (e) {
    return `unavailable (${(e as Error).message.split("\n")[0]})`;
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) {
    console.error("Set BROWSERBASE_API_KEY (and ideally BROWSERBASE_PROJECT_ID) in .env first.");
    process.exit(1);
  }
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

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
      console.warn(`\n⚠️  Residential proxy unavailable (${msg.trim()}) — falling back to NO-PROXY.`);
      console.warn("   (The WebGL/GPU read is identical either way; the IP line just won't be residential.)\n");
      usedProxy = false;
      remote = await createBrowserbaseSession({ apiKey, ...(projectId ? { projectId } : {}), proxy: false });
    } else {
      throw err;
    }
  }

  console.log(`Proxy:               ${usedProxy ? "residential (ON)" : "OFF (free-plan fallback)"}`);
  console.log(`Browserbase session: ${remote.sessionId}`);
  const liveUrl = await getBrowserbaseLiveViewUrl(remote.bb, remote.sessionId);
  if (liveUrl) console.log(`Live view:           ${liveUrl}`);

  const browser = await chromium.connectOverCDP(remote.connectUrl);
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Browserbase returned no default context");
    const page = context.pages()[0] ?? (await context.newPage());

    // Egress IP under the residential proxy (the conditions a real enroll runs in).
    await page.goto("https://api.ipify.org?format=json", { waitUntil: "domcontentloaded" });
    const ip = (await page.evaluate(() => document.body?.innerText ?? "")).trim();
    console.log(`\nEgress IP:           ${ip}`);

    // Core environment signals reCAPTCHA scores before any interaction.
    const env = await page.evaluate(() => ({
      webdriver: navigator.webdriver,
      headlessInUA: /headless/i.test(navigator.userAgent),
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
      languages: navigator.languages,
      screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio },
    }));

    const webgl = await readWebgl(page);
    const w = webgl.webgl as { unmaskedRenderer?: string; unmaskedVendor?: string } | null;
    const renderer = w?.unmaskedRenderer ?? "";
    const isSoftware = typeof renderer === "string" && SOFTWARE_RENDERER.test(renderer);

    console.log("\n── Environment signals ───────────────────────────────────────────────");
    console.log(`navigator.webdriver: ${env.webdriver}`);
    console.log(`'Headless' in UA:    ${env.headlessInUA}`);
    console.log(`userAgent:           ${env.userAgent}`);
    console.log(`platform:            ${env.platform}`);
    console.log(`hardwareConcurrency: ${env.hardwareConcurrency}    deviceMemory: ${env.deviceMemory}`);
    console.log(`languages:           ${JSON.stringify(env.languages)}`);
    console.log(`screen:              ${env.screen.w}x${env.screen.h} @${env.screen.dpr}x`);

    console.log("\n── WebGL GPU fingerprint  (THE headline signal) ──────────────────────");
    console.log(`UNMASKED_VENDOR:     ${w?.unmaskedVendor ?? "(null)"}`);
    console.log(`UNMASKED_RENDERER:   ${renderer || "(null)"}`);
    console.log(`webgl2:              ${JSON.stringify(webgl.webgl2)}`);

    // Best-effort live score (flaky from cloud IPs — never fatal).
    const score = await probeScore(page);
    console.log(`\nreCAPTCHA v3 score (antcpt, best-effort): ${score}`);

    console.log("\n── Verdict ───────────────────────────────────────────────────────────");
    if (isSoftware) {
      console.log(`❌ SOFTWARE RENDERER detected ("${renderer}").`);
      console.log("   This is a catalogued bot tell and CANNOT be spoofed from JavaScript.");
      console.log("   → Confirms the score is environment-capped (why a human click also fails).");
      console.log("   → A proxy/IP swap ALONE will not be enough; you need a REAL-GPU browser.");
    } else if (renderer) {
      console.log(`✅ Real/hardware GPU renderer ("${renderer}") — NOT a SwiftShader ceiling.`);
      console.log("   → The fingerprint is not the binding constraint; focus on IP reputation");
      console.log("     (mobile/dedicated-ISP proxy) and session/cookie history instead.");
    } else {
      console.log("⚠️  Could not read UNMASKED_RENDERER (WebGL blocked/unavailable). Inconclusive.");
    }
  } finally {
    await browser.close().catch(() => {});
    await releaseBrowserbaseSession(remote.bb, remote.sessionId);
    console.log("\nSession released.");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

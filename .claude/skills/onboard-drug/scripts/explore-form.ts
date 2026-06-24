/**
 * Form recon for onboarding a new drug. Dumps the VISIBLE form controls on a page —
 * the key to mapping AEM-style enrollment forms, which keep hidden duplicate copies of
 * every field in the DOM (matching a hidden copy is the #1 mapping bug).
 *
 * Run from the repo root so it resolves the project's Playwright + real Chrome:
 *   npx tsx .claude/skills/onboard-drug/scripts/explore-form.ts "<url>" [--headless]
 *
 * It launches headed real Chrome, dismisses a common cookie banner, prints each visible
 * control (tag, type, name, label, text) and saves artifacts/explore.png. Unless
 * --headless, it leaves the window open ~5 min so you can scroll/click to reveal later
 * steps, then re-run to dump the new step.
 */
import { chromium } from "playwright";

const url = process.argv[2];
const headless = process.argv.includes("--headless");
if (!url) {
  console.error('usage: explore-form.ts "<url>" [--headless]');
  process.exit(1);
}

// Runs in the browser; returns only VISIBLE controls with a computed label.
const VISIBLE_CONTROLS = `(() => {
  function vis(el){const r=el.getBoundingClientRect();const s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&s.opacity!=='0';}
  function labelFor(el){
    const aria=el.getAttribute('aria-label'); if(aria) return aria;
    const id=el.id; if(id){const l=document.querySelector('label[for="'+CSS.escape(id)+'"]'); if(l) return (l.textContent||'').trim();}
    const wl=el.closest('label'); if(wl) return (wl.textContent||'').trim();
    const ph=el.getAttribute('placeholder'); if(ph) return ph; return '';
  }
  const out=[];
  document.querySelectorAll('input,select,textarea,button,[role="radio"],[role="checkbox"],[role="button"]').forEach(el=>{
    if(!vis(el)) return;
    out.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type')||'',
      name: el.getAttribute('name')||'',
      label: (labelFor(el)||'').replace(/\\s+/g,' ').slice(0,90),
      text: (el.textContent||'').trim().slice(0,50),
    });
  });
  return out;
})()`;

async function main() {
  const browser = await chromium.launch({ headless, channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  // Best-effort cookie dismissal (OneTrust is common on pharma sites).
  for (const sel of ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"]) {
    const b = page.locator(sel);
    if (await b.count()) {
      await b.first().click({ timeout: 3000 }).catch(() => {});
      break;
    }
  }
  await page.waitForTimeout(800);

  const controls = (await page.evaluate(VISIBLE_CONTROLS)) as Array<Record<string, string>>;
  console.log(`\nVISIBLE CONTROLS @ ${page.url()}  (${controls.length})`);
  for (const c of controls) {
    if (c.label === "Search") continue;
    console.log(
      `${c.tag} type=${c.type} name=${c.name} | label=${JSON.stringify(c.label)}` +
        (c.text ? ` | text=${JSON.stringify(c.text)}` : ""),
    );
  }
  await page.screenshot({ path: "artifacts/explore.png", fullPage: false }).catch(() => {});
  console.log("\nScreenshot: artifacts/explore.png");

  if (!headless) {
    console.log("Browser left open ~5 min — drive it to a later step, then re-run to dump it.");
    await page.waitForTimeout(5 * 60 * 1000);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

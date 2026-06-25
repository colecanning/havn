import type { Locator, Page } from "playwright";
import type { PreflightAction } from "../recipe/schema.js";
import type { Logger } from "../logging/logger.js";

/**
 * Preflight cleanup: a cookie/consent banner and a "Chat Live 24/7" widget overlay
 * the page and can intercept clicks on the form. We dismiss/decline them (the most
 * privacy-preserving choice) before interacting.
 *
 * These are BEST-EFFORT with candidate locators — the exact controls are confirmed
 * during the live mapping pass and these candidates hardened then. A miss is logged,
 * not fatal: the page-match guard is the real safety net before we fill anything.
 */

const SHORT = 2000;

async function tryClick(
  candidates: Locator[],
  logger: Logger,
  name: string,
): Promise<boolean> {
  for (const loc of candidates) {
    try {
      await loc.first().waitFor({ state: "visible", timeout: SHORT });
      await loc.first().click({ timeout: SHORT });
      logger.info("preflight.dismissed", { target: name });
      return true;
    } catch {
      // not present / not this one — try the next candidate
    }
  }
  logger.debug("preflight.not_found", { target: name });
  return false;
}

async function dismissCookieBanner(page: Page, logger: Logger): Promise<void> {
  const declined = await tryClick(
    [
      page.locator("#onetrust-reject-all-handler"),
      page.getByRole("button", { name: /reject all/i }),
      page.getByRole("button", { name: /decline all/i }),
      page.getByRole("button", { name: /^decline$/i }),
      page.getByRole("button", { name: /only necessary|necessary only/i }),
    ],
    logger,
    "cookie_banner",
  );
  if (declined) return;

  // Some OneTrust variants (IAB TCF) expose no first-layer reject button — only
  // "Cookies Settings" / "Accept" — so we can't decline with a single click. A fresh
  // browser (e.g. a cloud session with no prior cookies) shows this variant every time,
  // and its overlay intercepts clicks on the form fields. When we can't decline, remove
  // the consent overlay so it stops blocking the form. Removing it accepts NO cookies.
  const removed = await page
    .evaluate(() => {
      let n = 0;
      for (const sel of ["#onetrust-consent-sdk", "#onetrust-banner-sdk", ".onetrust-pc-dark-filter"]) {
        document.querySelectorAll(sel).forEach((el) => {
          el.remove();
          n++;
        });
      }
      return n;
    })
    .catch(() => 0);
  if (removed) logger.info("preflight.cookie_overlay_removed", { count: removed });
}

async function dismissChatWidget(page: Page, logger: Logger): Promise<void> {
  await tryClick(
    [
      page.getByRole("button", { name: /close chat/i }),
      page.getByRole("button", { name: /minimi[sz]e chat/i }),
      page.locator("[aria-label*='close' i][aria-label*='chat' i]"),
    ],
    logger,
    "chat_widget",
  );
}

/**
 * Make AbbVie's floating page chrome click-through so it can't intercept clicks on form
 * fields/buttons below the fold. The AEM form has several such floaters: the sticky
 * "Important Safety Information" safety bar, the inline ISI region, a sticky nav menubar,
 * and dark consent filters. Playwright scrolls a target into view, then one of these covers
 * the click point ("<…> intercepts pointer events" — the exact failure seen on the
 * treatment-step "No" radio). We only neutralize elements that actually FLOAT (computed
 * position fixed/sticky) or are explicit fade overlays — never the form's own static
 * containers or buttons, which share these wrappers.
 *
 * Re-runnable and exported: the wizard re-renders per step and re-stickies its chrome, so
 * callers invoke this again right before below-the-fold clicks (radio, advance/submit), not
 * just once at page load. Returns the count neutralized. `logger` is optional so per-click
 * callers can run it quietly.
 */
export async function neutralizeFloatingOverlays(page: Page, logger?: Logger): Promise<number> {
  const n = await page
    .evaluate(() => {
      const sel = [
        '[class*="safety-bar"]',
        '[id*="safety-bar"]',
        ".abbv-safety-bar-fade",
        ".abbv-isi",
        ".abbv-inline-use-isi",
        '[aria-label="Important Safety Information"]',
        '[role="menubar"]',
        ".onetrust-pc-dark-filter",
      ].join(",");
      let count = 0;
      for (const node of Array.from(document.querySelectorAll(sel))) {
        const el = node as HTMLElement;
        const pos = getComputedStyle(el).position;
        if (pos === "fixed" || pos === "sticky" || el.className.includes("fade")) {
          el.style.pointerEvents = "none";
          count++;
        }
      }
      return count;
    })
    .catch(() => 0);
  if (n && logger) logger.info("preflight.overlays_neutralized", { count: n });
  return n;
}

export async function runPreflight(
  page: Page,
  actions: PreflightAction[],
  logger: Logger,
): Promise<void> {
  for (const action of actions) {
    switch (action) {
      case "dismiss_cookie_banner":
        await dismissCookieBanner(page, logger);
        break;
      case "dismiss_chat_widget":
        await dismissChatWidget(page, logger);
        break;
    }
  }
  // Always clear floating chrome's click interception, regardless of recipe actions.
  await neutralizeFloatingOverlays(page, logger);
}

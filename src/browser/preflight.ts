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
  await tryClick(
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
}

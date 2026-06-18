import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface SessionOptions {
  /** Visible window (true) vs headless (false, default). */
  headful?: boolean;
  /** Slow each action by N ms — useful when observing a run. Default 0. */
  slowMo?: number;
  /**
   * Browser channel, e.g. "chrome" to use the installed Google Chrome instead of
   * bundled Chromium. A real, headed Chrome scores far more "human" on invisible
   * reCAPTCHA than headless Chromium — use it for live submits.
   */
  channel?: string;
}

/**
 * Launch a Chromium session for a single enrollment/mapping run. One context per
 * run keeps cookies/storage isolated between patients.
 */
export async function launchSession(opts: SessionOptions = {}): Promise<Session> {
  const browser = await chromium.launch({
    headless: !opts.headful,
    slowMo: opts.slowMo ?? 0,
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

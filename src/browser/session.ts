import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";

export interface Session {
  /** Present only for non-persistent launches. */
  browser?: Browser;
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
   * reCAPTCHA than headless Chromium.
   */
  channel?: string;
  /**
   * Reuse a persistent profile directory across runs. A profile that has been used
   * for normal browsing accrues cookies/history/reputation and scores much better on
   * invisible reCAPTCHA than a fresh, automation-launched browser. Use with
   * channel:"chrome" + headful for the best score.
   */
  userDataDir?: string;
}

/**
 * Init script applied before page scripts run, masking the most obvious automation
 * fingerprints (navigator.webdriver, empty plugins, etc.). This reduces — does not
 * eliminate — bot signals; invisible reCAPTCHA Enterprise uses many more signals.
 */
const FINGERPRINT_MASK = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch (e) {}
  try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] }); } catch (e) {}
  if (!window.chrome) { window.chrome = { runtime: {} }; }
  const _q = window.navigator.permissions && window.navigator.permissions.query;
  if (_q) {
    window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : _q(p);
  }
`;

const CONTEXT_DEFAULTS = {
  viewport: { width: 1280, height: 900 },
  locale: "en-US",
  timezoneId: "America/New_York",
} as const;

/**
 * Launch a browser session for a single enrollment/mapping run. With userDataDir it
 * reuses a persistent profile (warmed real Chrome — best reCAPTCHA score); otherwise
 * it uses a fresh isolated context.
 */
export async function launchSession(opts: SessionOptions = {}): Promise<Session> {
  const headless = !opts.headful;
  const slowMo = opts.slowMo ?? 0;
  const channelOpt = opts.channel ? { channel: opts.channel } : {};

  if (opts.userDataDir) {
    const context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless,
      slowMo,
      ...channelOpt,
      ...CONTEXT_DEFAULTS,
    });
    await context.addInitScript(FINGERPRINT_MASK);
    const page = context.pages()[0] ?? (await context.newPage());
    return {
      context,
      page,
      close: async () => {
        await context.close().catch(() => {});
      },
    };
  }

  const browser = await chromium.launch({ headless, slowMo, ...channelOpt });
  const context = await browser.newContext(CONTEXT_DEFAULTS);
  await context.addInitScript(FINGERPRINT_MASK);
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

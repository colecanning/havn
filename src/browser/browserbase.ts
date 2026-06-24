import Browserbase from "@browserbasehq/sdk";

/**
 * Browserbase: run the enrollment on a genuinely non-headless Chrome in the cloud instead
 * of this laptop. We connect to it over CDP (see browser/session.ts) and drive it with the
 * exact same Playwright code — only *where* the browser runs changes.
 *
 * Why this matters for the Submit: the invisible reCAPTCHA Enterprise on Skyrizi scores
 * headless 0.00 (rejected) and headed real Chrome 0.1–0.3 (passes with the retry loop).
 * Browserbase browsers are genuinely headed AND can egress through a residential proxy —
 * the two documented "real levers" for a usable score — without us managing xvfb on a box.
 *
 * Policy: Browserbase enables a third-party CAPTCHA solver BY DEFAULT. The repo forbids
 * CAPTCHA-solving/token-relay services, so we hard-disable it (`solveCaptchas: false`) on
 * every session. Do not make this configurable.
 */

/** Residential-proxy egress location. US needs a `state`; omit `state` for other countries. */
export interface BrowserbaseGeolocation {
  /** ISO 3166-1 alpha-2 country code, e.g. "US". */
  country: string;
  /** US state code (2 chars), e.g. "NY". Only valid with country "US". */
  state?: string;
  /** City name (spaces for multi-word, e.g. "New York"). Optional. */
  city?: string;
}

export interface BrowserbaseConfig {
  /** Browserbase API key (BROWSERBASE_API_KEY). */
  apiKey: string;
  /** Browserbase project id (BROWSERBASE_PROJECT_ID). Inferred from the key if omitted. */
  projectId?: string;
  /**
   * Route the session through Browserbase's managed residential proxy. Default true —
   * a residential IP with good reputation is the documented reCAPTCHA score lever.
   */
  proxy?: boolean;
  /** Where the residential proxy egresses. Defaults to US / NY (matches our timezone default). */
  geolocation?: BrowserbaseGeolocation;
  /**
   * Browser viewport. Must be set at session-create time (we reuse Browserbase's existing
   * context, so we can't size it later). Defaults to 1280×900 to match the local
   * CONTEXT_DEFAULTS — a shorter viewport lets AbbVie's sticky safety bar overlap and
   * intercept clicks on the form fields.
   */
  viewport?: { width: number; height: number };
}

/** A live Browserbase session: the SDK client + ids needed to connect, watch, and release it. */
export interface BrowserbaseSession {
  bb: Browserbase;
  sessionId: string;
  /** CDP websocket URL (carries auth) for chromium.connectOverCDP(). */
  connectUrl: string;
}

const DEFAULT_GEO: BrowserbaseGeolocation = { country: "US", state: "NY" };
/** Match the local CONTEXT_DEFAULTS viewport so the form lays out the same in the cloud. */
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };

/**
 * Create a Browserbase session configured for a single enrollment: residential proxy on
 * (by default), CAPTCHA-solving OFF (policy). Returns the client + ids; the caller connects
 * over `connectUrl` and must `releaseBrowserbaseSession` when done (see session.ts close()).
 */
export async function createBrowserbaseSession(cfg: BrowserbaseConfig): Promise<BrowserbaseSession> {
  const bb = new Browserbase({ apiKey: cfg.apiKey });
  const proxies =
    cfg.proxy === false
      ? undefined
      : [{ type: "browserbase" as const, geolocation: cfg.geolocation ?? DEFAULT_GEO }];
  const session = await bb.sessions.create({
    ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
    browserSettings: {
      // Never let Browserbase's third-party solver run — repo policy. It defaults ON.
      solveCaptchas: false,
      viewport: cfg.viewport ?? DEFAULT_VIEWPORT,
    },
    ...(proxies ? { proxies } : {}),
  });
  return { bb, sessionId: session.id, connectUrl: session.connectUrl };
}

/**
 * Tell Browserbase to end the session, releasing the browser and stopping billing promptly.
 * Best-effort: a failure here must not mask the enrollment result, so errors are swallowed.
 */
export async function releaseBrowserbaseSession(bb: Browserbase, sessionId: string): Promise<void> {
  await bb.sessions.update(sessionId, { status: "REQUEST_RELEASE" }).catch(() => {});
}

/**
 * Interactive live-view URL for a running session (a human can watch/click here). Used by a
 * future cloud-handoff path; harmless to surface for observation. Best-effort.
 */
export async function getBrowserbaseLiveViewUrl(
  bb: Browserbase,
  sessionId: string,
): Promise<string | undefined> {
  const links = await bb.sessions.debug(sessionId).catch(() => undefined);
  return links?.debuggerFullscreenUrl;
}

import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { deliverableFacts, type DeliverableKind } from "./deliverables.ts";
import type { CaptureOutcome, CaptureViewport } from "./page-capture.ts";
import { CAPTURE_ACK_MS, CAPTURE_VIEWPORT_DEFAULT } from "./page-capture.ts";

/**
 * Login walls: whether the page a `url` deliverable links shows the page, or a sign-in screen, and on which devices.
 *
 * Tyler's feedback (2026-10-03, item 3): an agent published a URL behind a login (a Vercel dashboard, a private
 * preview). He tapped it on his phone and got a sign-in page, and nobody told the agent, which had said "it's in
 * conch". The Mac's review pane has its own sign-ins (WebView.swift, the default website data store); the phone has
 * none of the Mac's cookies, ever, and conch never sends it any.
 *
 * So when a `url` deliverable is published the daemon looks twice, side by side, while it files it:
 *
 * - `mac`: conch's Mac app draws the page, as `conch_capture` does (page-capture.ts `PageCaptures`, PageCapturer.swift),
 *   with the review pane's cookies. "page" when it drew the page, "sign-in" when it was shown a sign-in screen
 *   (ConchDesign `PageCapture.loginWall`). Only while the Mac app is running (surfaces.ts); otherwise "unchecked".
 * - `anonymous`: the daemon fetches it itself, with no cookies, no tokens, no credentials of any kind (`checkAnonymously`):
 *   what a device without the Mac's sign-ins, the phone, would be shown. "sign-in" for a 401 or 403, a redirect to a
 *   sign-in host or path (the same lists the Mac app uses), or a page that is a sign-in form.
 *
 * When the Mac drew the real page, that picture is filed on the deliverable as its `snapshot`, and the phone shows it
 * first, as conch's Mac saw it then (DeliverableSheet.swift), with the live page one tap away. The verdict carries
 * `access` and, when either look says sign-in, a `warning` the agent can act on (`accessWarning`).
 *
 * The bounds nest inside the verdict's own wait, innermost first (review-verdict.ts):
 *   ACCESS_RENDER_MS (the Mac app's deadline) < ACCESS_CAPTURE_MS (the daemon's) ≤ ACCESS_CHECK_MS
 *   < REVIEW_VERDICT_WAIT_MS (the daemon holds the verdict) < REVIEW_VERDICT_TIMEOUT_MS (the MCP server waits),
 * and the anonymous look, ANONYMOUS_CHECK_MS, runs beside the Mac's, never after it.
 */

export type AccessState = "page" | "sign-in" | "unchecked";
export const ACCESS_STATES: readonly AccessState[] = ["page", "sign-in", "unchecked"];

/** What the two looks found, as the verdict carries it: `why` is one sentence an agent can read. */
export interface PageAccess {
  mac: AccessState;
  anonymous: AccessState;
  why?: string;
}

/** conch's Mac's picture of the page as it was published, filed on the deliverable (`SessionReview.snapshot`). */
export interface ReviewSnapshot {
  /** A PNG in conch's capture folder (capture-folder.ts). */
  path: string;
  /** Epoch-ms the Mac app drew it. */
  capturedAt: number;
}

/** The Mac app's deadline to draw the page: well inside the daemon's, so its own reason arrives first. */
export const ACCESS_RENDER_MS = 12_000;
/** How long the daemon waits on the Mac app's picture. */
export const ACCESS_CAPTURE_MS = 14_000;
/** The whole check, both looks side by side: the backstop the verdict's wait is sized from. */
export const ACCESS_CHECK_MS = 15_000;
/** The anonymous look, all of it: every redirect and the body. */
export const ANONYMOUS_CHECK_MS = 5_000;
/** The most of a page the anonymous look reads: a sign-in form is near the top, and a page may be a video. */
export const ANONYMOUS_MAX_BYTES = 512 * 1024;
/** Redirects followed before it gives up: sign-in flows take three or four, a loop takes them all. */
export const ANONYMOUS_MAX_REDIRECTS = 8;
/**
 * The phone's browser, by name: some hosts answer an unknown client differently (a bot wall's 403), and the question
 * is what the phone would be shown. It never carries anything of the user's.
 */
const PHONE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

// The sign-in rules, the Mac app's own (ConchDesign PageCapture.swift `signInHosts`…`signInTitle`), so the two looks
// agree on what a sign-in screen is. test/page-access.test.ts reads that file and fails when these drift from it.

/** Identity providers' own sign-in hosts. */
export const SIGN_IN_HOSTS: readonly string[] = [
  "accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "idmsa.apple.com",
  "id.atlassian.com", "signin.aws.amazon.com", "auth.openai.com", "login.salesforce.com", "account.box.com",
];
/** Hosted sign-in services, by the end of their hosts. */
export const SIGN_IN_HOST_SUFFIXES: readonly string[] = [".auth0.com", ".okta.com", ".oktapreview.com", ".onelogin.com", ".clerk.accounts.dev", ".authkit.app"];
/** Hosts that are sign-in by their first label. */
export const SIGN_IN_HOST_PREFIXES: readonly string[] = ["login.", "signin.", "sso.", "auth.", "clerk.", "identity."];
/** Paths a site signs in at (Vercel's `/sso-api` is where a protected preview deployment sends you). */
export const SIGN_IN_PATH = /^\/(?:login|log-in|signin|sign-in|sign_in|sso|sso-api|saml|oauth2?|auth\/login|auth\/signin|u\/login|users\/sign_in|account\/login|accounts\/login)(?:\/|$)/i;
export const SIGN_IN_TITLE = /^(?:sign in|sign-in|signin|log in|log-in|login)\b|\b(?:sign in|log in) to\b|[|·–—-]\s*(?:sign in|log in|login)\s*$/i;
/** What a sign-in screen's headings, buttons and labels say (PageCapturer.swift `signalsScript`). */
export const SIGN_IN_WORDS = /\b(sign ?in|log ?in|sign on|continue with (google|github|gitlab|apple|microsoft|email|sso)|single sign-on)\b/i;

/**
 * The link a publication's check looks at: an http(s) link filed as a live page (`url`, said or read off the link), or
 * nothing. A design's link opens in Figma, and an app or a terminal with a link is still that, not a page.
 */
export function accessCheckedLink(review: { summary: string; link?: string; kind?: DeliverableKind; key?: string } | undefined): string | undefined {
  if (!review?.link || !/^https?:\/\//i.test(review.link)) return undefined;
  return deliverableFacts(review).kind === "url" ? review.link : undefined;
}

/**
 * Query parameters that carry a credential, often a one-time one: a magic sign-in link's token, an OAuth callback's
 * code, a signed URL's signature. conch opens a published page twice by itself, so an address carrying one isn't opened
 * at all (`oneTimeCredential`): opening it could use it up before the user does, or send it somewhere new.
 */
const CREDENTIAL_PARAMETER = /^(?:token|access_token|id_token|auth|auth_token|code|otp|magic|magic_link|login_token|ticket|nonce|sig|signature|x-amz-signature|key|api_key|apikey|password|secret)$/i;

/** The query parameter that carries a credential, by name, when the address has one; undefined when it hasn't. */
export function oneTimeCredential(address: string): string | undefined {
  try {
    return [...new URL(address).searchParams.keys()].find((name) => CREDENTIAL_PARAMETER.test(name));
  } catch {
    return undefined;
  }
}

/** Whether an address is a sign-in page by where it is: an identity provider's host, or a sign-in path. */
export function signInAddress(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (SIGN_IN_HOSTS.includes(host) || SIGN_IN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
    || SIGN_IN_HOST_PREFIXES.some((prefix) => host.startsWith(prefix))) return true;
  return SIGN_IN_PATH.test(url.pathname || "/");
}

/** Markup as text: tags and entities gone, space runs one space. Good enough to read a title or a button by. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, "\"").replace(/&middot;/gi, "·").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a page's markup is a sign-in screen, by the Mac app's rule (`PageCapture.loginWall`): a password field or
 * sign-in words under a title that says sign in, or a password field beside words that say so. A password field
 * alone isn't one (a sign-up or settings page has one), and neither are the words alone (every site's header has a
 * Log in button). The markup as served, before any script: a page that builds its sign-in form in the browser reads
 * as a page here, which only the Mac's look can catch.
 */
export function signInMarkup(html: string): boolean {
  // Never what a script or a style says.
  const markup = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ").replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  const password = /<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(markup);
  const title = text(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(markup)?.[1] ?? "");
  const titled = SIGN_IN_TITLE.test(title);
  const lines = [
    ...[...markup.matchAll(/<(h1|h2|button|label)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((match) => text(match[2] ?? "")),
    ...[...markup.matchAll(/<[a-z][a-z0-9]*\b[^>]*\brole\s*=\s*["']?button\b[^>]*>([\s\S]*?)<\//gi)].map((match) => text(match[1] ?? "")),
    ...[...markup.matchAll(/<input\b[^>]*>/gi)]
      .filter((match) => /\btype\s*=\s*["']?submit\b/i.test(match[0]))
      .map((match) => /\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]))
      .map((value) => value?.[1] ?? value?.[2] ?? value?.[3] ?? ""),
  ].slice(0, 400);
  const words = lines.some((line) => SIGN_IN_WORDS.test(line.slice(0, 200)));
  return titled ? password || words : password && words;
}

export interface AnonymousLook {
  state: AccessState;
  /** What it saw, in words: "answered 401", "redirected to https://vercel.com/login". */
  why: string;
  /** Where it ended up, when it got anywhere. */
  finalUrl?: string;
}

export interface AnonymousOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** The fetch it uses; tests hand in their own. Only ever called with `redirect: "manual"` and no credentials. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/** An address as it is said back: no query or fragment, which may carry a token, cut short. */
function said(url: URL): string {
  const shown = `${url.protocol}//${url.host}${url.pathname}`;
  return shown.length > 160 ? `${shown.slice(0, 159)}…` : shown;
}

/** Read at most `max` bytes of a body, then stop reading; whatever arrived, as text. */
async function readSome(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value.subarray(0, max - bytes));
      bytes += Math.min(value.byteLength, max - bytes);
    }
  } finally {
    // A page bigger than the cap is not read to its end: the connection goes.
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * What a device with none of the Mac's sign-ins is shown at `address`: GET it with no cookies, no Authorization, no
 * credentials in the address (an address that carries a user name or password isn't fetched at all: conch never sends
 * them), following redirects by hand, http(s) only, up to `ANONYMOUS_MAX_REDIRECTS`, reading up to
 * `ANONYMOUS_MAX_BYTES` of what it lands on, all within `ANONYMOUS_CHECK_MS`. A local or private-network address is
 * looked at like any other: it is this Mac asking. Never throws.
 */
export async function checkAnonymously(address: string, options: AnonymousOptions = {}): Promise<AnonymousLook> {
  const timeoutMs = options.timeoutMs ?? ANONYMOUS_CHECK_MS;
  const maxBytes = options.maxBytes ?? ANONYMOUS_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? ANONYMOUS_MAX_REDIRECTS;
  const get = options.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { state: "unchecked", why: "its address couldn't be read" };
  }
  const web = (candidate: URL) => candidate.protocol === "http:" || candidate.protocol === "https:";
  if (!web(url)) return { state: "unchecked", why: `it isn't a web address (${url.protocol})` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const seen = new Set<string>();
  try {
    for (let hops = 0; ; hops += 1) {
      if (url.username || url.password) {
        return { state: "unchecked", why: "its address carries a user name or password, which conch never sends", finalUrl: said(url) };
      }
      // Sent to sign in: no need to fetch the sign-in page itself.
      if (signInAddress(url)) {
        return {
          state: "sign-in",
          why: hops ? `without cookies it redirected to a sign-in page (${said(url)})` : `it is a sign-in page (${said(url)})`,
          finalUrl: said(url),
        };
      }
      const here = url.href.replace(/#.*$/, "");
      if (seen.has(here)) return { state: "unchecked", why: "without cookies it redirected in a loop", finalUrl: said(url) };
      seen.add(here);
      const response = await get(here, {
        method: "GET",
        redirect: "manual",
        // Nothing of the user's: no cookies (fetch keeps none), no Authorization, no Referer.
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "user-agent": PHONE_USER_AGENT },
        signal: controller.signal,
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (location !== null) {
        await response.body?.cancel().catch(() => {});
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { state: "unchecked", why: "it redirected to an address that couldn't be read", finalUrl: said(url) };
        }
        if (!web(next)) return { state: "unchecked", why: `it redirected to a non-web address (${next.protocol}), which conch doesn't follow`, finalUrl: said(url) };
        if (hops >= maxRedirects) return { state: "unchecked", why: `it redirected more than ${maxRedirects} times`, finalUrl: said(next) };
        url = next;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        return {
          state: "sign-in",
          why: `without cookies it answered ${response.status} ${response.status === 401 ? "(sign-in required)" : "(forbidden)"}${hops ? ` at ${said(url)}` : ""}`,
          finalUrl: said(url),
        };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // A private page can answer 404 to a stranger (GitHub does); conch can't tell that from a missing one.
        return { state: "unchecked", why: `without cookies it answered ${response.status}`, finalUrl: said(url) };
      }
      const type = response.headers.get("content-type") ?? "";
      if (!/html|xml/i.test(type) && type) {
        await response.body?.cancel().catch(() => {});
        return { state: "page", why: `without cookies it served the page (${type.split(";")[0]})`, finalUrl: said(url) };
      }
      const html = await readSome(response, maxBytes);
      if (signInMarkup(html)) return { state: "sign-in", why: `without cookies it showed a sign-in form at ${said(url)}`, finalUrl: said(url) };
      return { state: "page", why: `without cookies it served the page${hops ? ` at ${said(url)}` : ""}`, finalUrl: said(url) };
    }
  } catch (error) {
    if (controller.signal.aborted) return { state: "unchecked", why: `without cookies it didn't answer within ${Math.round(timeoutMs / 1000)} s`, finalUrl: said(url) };
    return { state: "unchecked", why: `without cookies conch couldn't reach it (${error instanceof Error ? error.message : String(error)})`, finalUrl: said(url) };
  } finally {
    clearTimeout(timer);
  }
}

/** The Mac app's look, from what it drew: its state, why, the picture to file when it drew the page, and what to delete. */
export interface MacLook {
  state: AccessState;
  why: string;
  snapshot?: ReviewSnapshot;
  /** Pictures of a sign-in screen or of a failure: never filed, so deleted at once. */
  discard: string[];
}

/** An address the Mac app reported, as it is said back: no query or fragment (`said`); as given when it isn't one. */
function saidAddress(address: string): string {
  try {
    return said(new URL(address));
  } catch {
    return address.slice(0, 160);
  }
}

export function macLookOf(outcome: CaptureOutcome, now: number): MacLook {
  if (outcome.ok) {
    const { shot } = outcome;
    if (shot.loginWall) return { state: "sign-in", why: `on the Mac, conch's review pane was shown a sign-in page (${saidAddress(shot.finalUrl)})`, discard: [shot.path] };
    return { state: "page", why: "on the Mac, conch's review pane drew the page", snapshot: { path: shot.path, capturedAt: now }, discard: [] };
  }
  const discard = outcome.seen?.path ? [outcome.seen.path] : [];
  if (outcome.seen?.loginWall) {
    return {
      state: "sign-in",
      why: `on the Mac, conch's review pane was shown a sign-in page${outcome.seen.finalUrl ? ` (${saidAddress(outcome.seen.finalUrl)})` : ""}`,
      discard,
    };
  }
  return { state: "unchecked", why: `conch couldn't draw it on the Mac (${outcome.error.replace(/[.\s]+$/, "")})`, discard };
}

/** Said when the Mac app isn't running, so nothing drew the page there. */
export const MAC_NOT_DRAWN = "conch's Mac app isn't running, so conch didn't draw it on the Mac";

/**
 * The one sentence an agent acts on, when either look says sign-in; none when neither does. Word for word the task's
 * own wording where it gave one, so an agent can match on it.
 */
export function accessWarning(access: Pick<PageAccess, "mac" | "anonymous">, snapshot: boolean): string | undefined {
  if (access.mac === "sign-in") {
    return "The page asked for sign-in on the Mac too, so the user will see a login page. Ask them to sign in once in"
      + " conch's review pane, or publish a capture/screenshot instead.";
  }
  if (access.anonymous !== "sign-in") return undefined;
  if (snapshot) {
    return "The page needs sign-in, so the phone (without the Mac's cookies) would show a login page. conch attached the"
      + " Mac's snapshot, so the phone shows the page as the Mac saw it.";
  }
  return "The page needs sign-in, so the phone (without the Mac's cookies) would show a login page, and conch couldn't"
    + " draw it on the Mac to attach a snapshot. Publish a capture/screenshot instead, or ask the user to sign in once in"
    + " conch's review pane and open it there.";
}

export interface AccessCheck {
  access: PageAccess;
  snapshot?: ReviewSnapshot;
  warning?: string;
}

export interface AccessCheckDependencies {
  /** Whether the Mac app is running now (`surfaces.mac !== "not-running"`): only then is it asked to draw. */
  macRunning: boolean;
  /** Ask the Mac app to draw it (`PageCaptures.ask`), with the check's own bounds. */
  capture(spec: { url: string; viewport: CaptureViewport; fullPage: false }, bounds: { ackMs: number; timeoutMs: number; renderMs: number }): Promise<CaptureOutcome>;
  /** Look without cookies (`checkAnonymously`). */
  anonymous(url: string): Promise<AnonymousLook>;
  /** Delete a picture nothing will file (`discardCapture`). */
  discard(path: string): void;
  now(): number;
  /** The whole check's bound (`ACCESS_CHECK_MS`). */
  timeoutMs?: number;
}

/**
 * Both looks at a published `url` deliverable, side by side, bounded as a whole: the access, the Mac's picture when it
 * drew the page, and the warning. Never throws, and always answers within its bound; a look that is late counts as
 * unchecked, and a picture that arrives after the bound is deleted rather than left behind.
 */
export async function checkPageAccess(url: string, deps: AccessCheckDependencies): Promise<AccessCheck> {
  const credential = oneTimeCredential(url);
  if (credential) {
    const why = `its address carries a credential (?${credential}=), so conch opened it neither on the Mac nor without cookies: it could be used up`;
    return { access: { mac: "unchecked", anonymous: "unchecked", why: `${why}.` } };
  }
  const timeoutMs = deps.timeoutMs ?? ACCESS_CHECK_MS;
  // Each look lands here when it finishes. Read once the bound is reached: a look still out then is unchecked, and a
  // picture that arrives after it is deleted rather than left behind with nothing to file it.
  let macLook: MacLook | undefined;
  let anonymousLook: AnonymousLook | undefined;
  let over = false;
  const mac = deps.macRunning
    ? deps.capture(
      { url, viewport: { ...CAPTURE_VIEWPORT_DEFAULT }, fullPage: false },
      { ackMs: Math.min(CAPTURE_ACK_MS, ACCESS_CAPTURE_MS), timeoutMs: ACCESS_CAPTURE_MS, renderMs: ACCESS_RENDER_MS },
    )
      .then((outcome) => macLookOf(outcome, deps.now()))
      .catch((error): MacLook => ({ state: "unchecked", why: `conch couldn't draw it on the Mac (${error instanceof Error ? error.message : String(error)})`, discard: [] }))
      .then((look) => {
        for (const path of [...look.discard, ...(over && look.snapshot ? [look.snapshot.path] : [])]) deps.discard(path);
        if (!over) macLook = look;
      })
    : Promise.resolve().then(() => {
      macLook = { state: "unchecked", why: MAC_NOT_DRAWN, discard: [] };
    });
  const anonymous = deps.anonymous(url)
    .catch((error): AnonymousLook => ({ state: "unchecked", why: `conch couldn't look without cookies (${String(error)})` }))
    .then((look) => {
      if (!over) anonymousLook = look;
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all([mac, anonymous]), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  clearTimeout(timer);
  over = true;
  const seconds = Math.round(timeoutMs / 1000);
  const onMac = macLook ?? { state: "unchecked" as const, why: `conch's Mac app didn't draw it within ${seconds} s`, discard: [] };
  const without = anonymousLook ?? { state: "unchecked" as const, why: `without cookies it didn't answer within ${seconds} s` };
  const access: PageAccess = { mac: onMac.state, anonymous: without.state, why: `${onMac.why}; ${without.why}.` };
  const warning = accessWarning(access, Boolean(onMac.snapshot));
  return { access, ...(onMac.snapshot ? { snapshot: onMac.snapshot } : {}), ...(warning ? { warning } : {}) };
}

/** Whether a value read off the socket is a `PageAccess` this conch can say. */
export function isPageAccess(value: unknown): value is PageAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const access = value as Record<string, unknown>;
  return ACCESS_STATES.includes(access.mac as AccessState) && ACCESS_STATES.includes(access.anonymous as AccessState)
    && (access.why === undefined || typeof access.why === "string");
}

/**
 * Whether a path is a picture of conch's own: a `<request>.png` or `<request>-seen.png` (PageCaptures' names) directly
 * in the capture folder, by the path it was stored under. Only such a path is ever deleted.
 */
export function isOwnCapture(path: string | undefined, folder: string): path is string {
  return typeof path === "string" && join(folder, basename(path)) === path && /^[a-z0-9-]{1,64}\.png$/.test(basename(path));
}

/** Delete a picture of conch's own (`isOwnCapture`); anything else is never touched. */
export function discardCapture(path: string | undefined, folder: string): void {
  if (isOwnCapture(path, folder)) rmSync(path, { force: true });
}

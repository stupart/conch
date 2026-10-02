import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFolderPath } from "../src/capture-folder.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";
import type { TurnEvent } from "../src/hook.ts";
import {
  ACCESS_CAPTURE_MS,
  ACCESS_CHECK_MS,
  ACCESS_RENDER_MS,
  accessCheckedLink,
  accessWarning,
  ANONYMOUS_CHECK_MS,
  ANONYMOUS_MAX_BYTES,
  checkAnonymously,
  checkPageAccess,
  discardCapture,
  isPageAccess,
  MAC_NOT_DRAWN,
  oneTimeCredential,
  SIGN_IN_HOST_PREFIXES,
  SIGN_IN_HOST_SUFFIXES,
  SIGN_IN_HOSTS,
  SIGN_IN_PATH,
  SIGN_IN_TITLE,
  SIGN_IN_WORDS,
  signInAddress,
  signInMarkup,
  type AccessCheckDependencies,
} from "../src/page-access.ts";
import { CAPTURE_REPLY_MS, CAPTURE_TIMEOUT_MS, CAPTURES_KEPT, PageCaptures, pruneCaptures, type CaptureOutcome } from "../src/page-capture.ts";
import { attachReviewAccess, buildPublishedState, MAX_SESSION_REVIEWS, carriedReviews, type SessionReview } from "../src/panel.ts";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";
import { isReviewVerdict, REVIEW_FILING_WAIT_MS, REVIEW_VERDICT_TIMEOUT_MS, REVIEW_VERDICT_WAIT_MS } from "../src/review-verdict.ts";
import { SessionLedger } from "../src/session-ledger.ts";

/**
 * Login walls (2026-10-03, feedback item 3): an agent published a URL behind a login, the user tapped it on the phone
 * and got a sign-in page, and nobody told the agent. A published `url` deliverable is now looked at twice while it is
 * filed (src/page-access.ts): by conch's Mac app with the review pane's sign-ins, and by the daemon with none, as the
 * phone would be. These cover the look without cookies against a real local server, how the two looks make a verdict,
 * the bounds that keep it inside the agent's wait, and the Mac's picture of the page as a deliverable holds it.
 */

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "conch-access-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ── A real server for the look without cookies: every request it got, with its headers.

interface Seen { path: string; headers: Record<string, string> }
const seen: Seen[] = [];
let hugeSent = 0;
let hugeCancelled = false;
let server: ReturnType<typeof Bun.serve>;
let base = "";

const page = (title: string, body: string) => new Response(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`, {
  headers: { "content-type": "text/html; charset=utf-8" },
});
const SIGN_IN_FORM = '<form method="post"><label for="e">Email</label><input id="e" name="email"><input type="password" name="password"><button type="submit">Log in</button></form>';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url);
      seen.push({ path: url.pathname + url.search, headers: Object.fromEntries(request.headers.entries()) });
      switch (url.pathname) {
        case "/public":
          return page("Pricing · Acme", "<h1>Pricing</h1><p>Pick the Pro plan. <a href=\"/login\">Log in</a></p><button>Log in</button>");
        case "/dashboard":
          return new Response(null, { status: 302, headers: { location: "/login?next=%2Fdashboard&token=abc" } });
        case "/login":
          return page("Log in – Acme", `<h1>Welcome back</h1>${SIGN_IN_FORM}`);
        case "/gate":
          return new Response(null, { status: 307, headers: { location: "/welcome" } });
        case "/welcome":
          // Not a sign-in path: the form itself says so.
          return page("Acme", `<h2>Sign in to continue</h2>${SIGN_IN_FORM}`);
        case "/signup":
          return page("Create your account", '<h1>Create your account</h1><form><input type="password" name="new"><button>Create account</button></form>');
        case "/private":
          return new Response("Authentication required", { status: 401, headers: { "www-authenticate": "Bearer" } });
        case "/forbidden":
          return new Response("nope", { status: 403 });
        case "/missing":
          return new Response("not here", { status: 404 });
        case "/loop-a":
          return new Response(null, { status: 302, headers: { location: "/loop-b" } });
        case "/loop-b":
          return new Response(null, { status: 302, headers: { location: "/loop-a" } });
        case "/vercel":
          return new Response(null, { status: 307, headers: { location: "https://vercel.com/sso-api?url=https%3A%2F%2Fpreview.vercel.app&nonce=1" } });
        case "/google":
          return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" } });
        case "/app-scheme":
          return new Response(null, { status: 302, headers: { location: "acme-app://callback?code=secret" } });
        case "/file-scheme":
          return new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } });
        case "/image":
          return new Response(new Uint8Array(64), { headers: { "content-type": "image/png" } });
        case "/hang":
          return new Promise<Response>(() => {});
        case "/huge": {
          // A page that never ends, and a sign-in form only past the cap: the look reads up to the cap and lets go.
          hugeSent = 0;
          hugeCancelled = false;
          const chunk = new TextEncoder().encode(`<p>${"filler ".repeat(9_000)}</p>`);
          let first = true;
          return new Response(new ReadableStream({
            pull(controller) {
              if (first) {
                first = false;
                controller.enqueue(new TextEncoder().encode("<!doctype html><title>Logs</title><h1>Build logs</h1>"));
                return;
              }
              hugeSent += chunk.byteLength;
              controller.enqueue(hugeSent > 2 * ANONYMOUS_MAX_BYTES && hugeSent < 3 * ANONYMOUS_MAX_BYTES ? new TextEncoder().encode(SIGN_IN_FORM) : chunk);
            },
            cancel() {
              hugeCancelled = true;
            },
          }), { headers: { "content-type": "text/html" } });
        }
        default:
          return new Response("?", { status: 500 });
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("the look without cookies: what a device with none of the Mac's sign-ins is shown", () => {
  test("a public page is the page, though its header has a Log in button", async () => {
    expect(await checkAnonymously(`${base}/public`)).toEqual({ state: "page", why: "without cookies it served the page", finalUrl: `${base}/public` });
  });

  test("a redirect to /login is a sign-in page, said without the query it carried, and the sign-in page is never fetched", async () => {
    const before = seen.length;
    const look = await checkAnonymously(`${base}/dashboard`);
    expect(look).toEqual({ state: "sign-in", why: `without cookies it redirected to a sign-in page (${base}/login)`, finalUrl: `${base}/login` });
    expect(look.why).not.toContain("token");
    expect(seen.slice(before).map((one) => one.path)).toEqual(["/dashboard"]);
  });

  test("a page that is a sign-in form is a sign-in page wherever it is; a sign-up form is not", async () => {
    expect(await checkAnonymously(`${base}/gate`)).toMatchObject({ state: "sign-in", why: `without cookies it showed a sign-in form at ${base}/welcome` });
    expect((await checkAnonymously(`${base}/signup`)).state).toBe("page");
  });

  test("401 and 403 are sign-in; any other failure is unchecked, since a private page can answer 404 to a stranger", async () => {
    expect(await checkAnonymously(`${base}/private`)).toMatchObject({ state: "sign-in", why: "without cookies it answered 401 (sign-in required)" });
    expect(await checkAnonymously(`${base}/forbidden`)).toMatchObject({ state: "sign-in", why: "without cookies it answered 403 (forbidden)" });
    expect(await checkAnonymously(`${base}/missing`)).toMatchObject({ state: "unchecked", why: "without cookies it answered 404" });
  });

  test("a protected Vercel preview and an identity provider are sign-in by where they send you, and are never fetched", async () => {
    const asked: string[] = [];
    const recording = (url: string, init: RequestInit) => {
      asked.push(url);
      return fetch(url, init);
    };
    expect(await checkAnonymously(`${base}/vercel`, { fetch: recording })).toMatchObject({ state: "sign-in", finalUrl: "https://vercel.com/sso-api" });
    expect(await checkAnonymously(`${base}/google`, { fetch: recording })).toMatchObject({ state: "sign-in", finalUrl: "https://accounts.google.com/o/oauth2/v2/auth" });
    expect(asked).toEqual([`${base}/vercel`, `${base}/google`]);
  });

  test("a redirect loop is unchecked rather than followed forever", async () => {
    expect(await checkAnonymously(`${base}/loop-a`)).toMatchObject({ state: "unchecked", why: "without cookies it redirected in a loop" });
  });

  test("a redirect to an app's own scheme or a file is never followed", async () => {
    const asked: string[] = [];
    const recording = (url: string, init: RequestInit) => {
      asked.push(url);
      return fetch(url, init);
    };
    expect(await checkAnonymously(`${base}/app-scheme`, { fetch: recording })).toMatchObject({
      state: "unchecked", why: "it redirected to a non-web address (acme-app:), which conch doesn't follow",
    });
    expect(await checkAnonymously(`${base}/file-scheme`, { fetch: recording })).toMatchObject({ state: "unchecked", why: expect.stringContaining("(file:)") });
    expect(asked).toEqual([`${base}/app-scheme`, `${base}/file-scheme`]);
  });

  test("a body that never ends is read to the cap and let go: the sign-in form past it is never seen", async () => {
    const started = performance.now();
    expect(await checkAnonymously(`${base}/huge`)).toMatchObject({ state: "page" });
    expect(performance.now() - started).toBeLessThan(ANONYMOUS_CHECK_MS);
    // Let go: the server stops being read, and makes no more of a page that would otherwise go on for ever.
    for (let waited = 0; !hugeCancelled && waited < 2_000; waited += 20) await Bun.sleep(20);
    const made = hugeSent;
    await Bun.sleep(200);
    expect(hugeSent).toBe(made);
    // What the server made before it was let go: the cap, and what the sockets buffered, never the whole page.
    expect(hugeSent).toBeLessThan(16 * ANONYMOUS_MAX_BYTES);
  });

  test("a server that never answers is unchecked within the bound", async () => {
    const started = performance.now();
    expect(await checkAnonymously(`${base}/hang`, { timeoutMs: 200 })).toMatchObject({ state: "unchecked", why: "without cookies it didn't answer within 0 s" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("a picture is a page; nothing listening is unchecked; neither throws", async () => {
    expect(await checkAnonymously(`${base}/image`)).toMatchObject({ state: "page", why: "without cookies it served the page (image/png)" });
    const nobody = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = nobody.port;
    nobody.stop(true);
    expect(await checkAnonymously(`http://127.0.0.1:${port}/`)).toMatchObject({ state: "unchecked", why: expect.stringMatching(/^without cookies conch couldn't reach it/) });
    expect(await checkAnonymously("not a url")).toMatchObject({ state: "unchecked" });
  });

  test("no credentials are ever sent: no cookie, no Authorization, and an address carrying a password is never fetched", async () => {
    const before = seen.length;
    const withPassword = `http://agent:hunter2@127.0.0.1:${server.port}/public`;
    expect(await checkAnonymously(withPassword)).toMatchObject({ state: "unchecked", why: "its address carries a user name or password, which conch never sends" });
    expect(seen.length).toBe(before);
    for (const request of seen) {
      expect(Object.keys(request.headers)).not.toContain("cookie");
      expect(Object.keys(request.headers)).not.toContain("authorization");
      expect(Object.keys(request.headers)).not.toContain("referer");
    }
    expect(seen.length).toBeGreaterThan(10);
  });
});

describe("what a sign-in page is: the Mac app's own rule", () => {
  test("a sign-in host or path, never a page that merely mentions one", () => {
    for (const address of ["https://accounts.google.com/x", "https://acme.okta.com/", "https://login.acme.io/", "https://vercel.com/login?next=/x", "https://github.com/login", "https://app.dev/u/login"]) {
      expect(signInAddress(new URL(address))).toBe(true);
    }
    for (const address of ["https://acme.dev/pricing", "https://app.dev/sessions/42", "https://app.dev/blog/login-tips", "file:///login"]) {
      expect(signInAddress(new URL(address))).toBe(false);
    }
  });

  test("a password field needs words or a title that say sign in; the words alone need the title; a script's words never count", () => {
    expect(signInMarkup(`<title>Acme</title>${SIGN_IN_FORM}`)).toBe(true);
    expect(signInMarkup('<title>Sign in · Acme</title><input type="password">')).toBe(true);
    expect(signInMarkup("<title>Log in to Acme</title><button>Continue with Google</button>")).toBe(true);
    expect(signInMarkup('<title>Settings</title><input type="password"><button>Change password</button>')).toBe(false);
    expect(signInMarkup("<title>Acme</title><button>Log in</button>")).toBe(false);
    expect(signInMarkup('<title>Acme</title><input type=password><script>"<button>Sign in</button>"</script>')).toBe(false);
    expect(signInMarkup('<title>Acme</title><input type="password"><input type="submit" value="Sign in">')).toBe(true);
  });

  test("the lists and patterns are the Mac app's own, word for word, so the two looks can't drift apart", () => {
    const swift = read("design/ConchDesign/Sources/ConchDesign/PageCapture.swift");
    const list = (name: string) => JSON.parse(`[${new RegExp(`static let ${name}[^=]*= \\[([\\s\\S]*?)\\]`).exec(swift)![1]!.replace(/,\s*$/, "")}]`);
    expect(list("signInHosts")).toEqual([...SIGN_IN_HOSTS]);
    expect(list("signInHostSuffixes")).toEqual([...SIGN_IN_HOST_SUFFIXES]);
    expect(list("signInHostPrefixes")).toEqual([...SIGN_IN_HOST_PREFIXES]);
    const pattern = (name: string) => new RegExp(`static let ${name} = try! NSRegularExpression\\(\\s*pattern: "((?:[^"\\\\]|\\\\.)*)"`).exec(swift)![1]!.replace(/\\\\/g, "\\");
    expect(pattern("signInPath")).toBe(SIGN_IN_PATH.source.replace(/\\\//g, "/"));
    // Bun writes a regex literal's non-ASCII as \u escapes; the same characters either way.
    const unescaped = (source: string) => source.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    expect(pattern("signInTitle")).toBe(unescaped(SIGN_IN_TITLE.source));
    const script = read("mac-app/conch-mac/PageCapturer.swift");
    const words = /const words = \/(.*)\/i;/.exec(script)![1]!.replace(/\\\\/g, "\\");
    expect(words).toBe(SIGN_IN_WORDS.source);
  });
});

// ── The two looks, made a verdict.

const shot = (path: string, loginWall: boolean): CaptureOutcome => ({
  ok: true,
  shot: { path, width: 2880, height: 1800, devicePixelRatio: 2, finalUrl: "https://acme.dev/dashboard?session=s3cr3t", title: "Dashboard", loginWall },
});

function deps(over: Partial<AccessCheckDependencies> & { mac?: CaptureOutcome | Promise<CaptureOutcome>; anonymousState?: "page" | "sign-in" | "unchecked" } = {}) {
  const captured: Array<{ spec: unknown; bounds: unknown }> = [];
  const discarded: string[] = [];
  const dependencies: AccessCheckDependencies = {
    macRunning: true,
    capture: (spec, bounds) => {
      captured.push({ spec, bounds });
      return Promise.resolve(over.mac ?? shot("/captures/a.png", false));
    },
    anonymous: async () => ({ state: over.anonymousState ?? "page", why: "without cookies it served the page" }),
    discard: (path) => void discarded.push(path),
    now: () => 5_000,
    ...over,
  };
  return { dependencies, captured, discarded };
}

describe("the verdict: what each look found, the Mac's picture, and what to do", () => {
  test("the Mac drew the page: its picture is the snapshot, drawn at a laptop's size, inside the check's bounds", async () => {
    const { dependencies, captured, discarded } = deps();
    expect(await checkPageAccess("https://acme.dev/dashboard", dependencies)).toEqual({
      access: { mac: "page", anonymous: "page", why: "on the Mac, conch's review pane drew the page; without cookies it served the page." },
      snapshot: { path: "/captures/a.png", capturedAt: 5_000 },
    });
    expect(captured).toEqual([{
      spec: { url: "https://acme.dev/dashboard", viewport: { width: 1440, height: 900 }, fullPage: false },
      bounds: { ackMs: 10_000, timeoutMs: ACCESS_CAPTURE_MS, renderMs: ACCESS_RENDER_MS },
    }]);
    expect(discarded).toEqual([]);
  });

  test("signed in on the Mac, not on the phone: the snapshot goes to the phone, and the agent is told so", async () => {
    const found = await checkPageAccess("https://acme.dev/dashboard", deps({ anonymousState: "sign-in" }).dependencies);
    expect(found.access).toMatchObject({ mac: "page", anonymous: "sign-in" });
    expect(found.snapshot?.path).toBe("/captures/a.png");
    expect(found.warning).toBe("The page needs sign-in, so the phone (without the Mac's cookies) would show a login page. conch attached the Mac's snapshot, so the phone shows the page as the Mac saw it.");
  });

  test("a sign-in screen on the Mac too is never a snapshot: its picture is deleted, and the warning says sign in once in conch", async () => {
    const { dependencies, discarded } = deps({ mac: shot("/captures/wall.png", true), anonymousState: "sign-in" });
    const found = await checkPageAccess("https://acme.dev/dashboard", dependencies);
    expect(found).toEqual({
      access: {
        mac: "sign-in",
        anonymous: "sign-in",
        why: "on the Mac, conch's review pane was shown a sign-in page (https://acme.dev/dashboard); without cookies it served the page.",
      },
      warning: "The page asked for sign-in on the Mac too, so the user will see a login page. Ask them to sign in once in conch's review pane, or publish a capture/screenshot instead.",
    });
    // Said without the session in its query.
    expect(found.access.why).not.toContain("s3cr3t");
    expect(discarded).toEqual(["/captures/wall.png"]);
  });

  test("a capture that failed on a sign-in screen is sign-in; one that failed otherwise is unchecked; neither files a picture", async () => {
    const walled = deps({ mac: { ok: false, error: "the page didn't load.", seen: { path: "/captures/a-seen.png", loginWall: true, finalUrl: "https://acme.dev/login" } } });
    expect(await checkPageAccess("https://acme.dev/x", walled.dependencies)).toMatchObject({ access: { mac: "sign-in" } });
    expect(walled.discarded).toEqual(["/captures/a-seen.png"]);
    const broken = deps({ mac: { ok: false, error: "the page didn't load." }, anonymousState: "sign-in" });
    const found = await checkPageAccess("https://acme.dev/x", broken.dependencies);
    expect(found.access).toEqual({ mac: "unchecked", anonymous: "sign-in", why: "conch couldn't draw it on the Mac (the page didn't load); without cookies it served the page." });
    expect(found.snapshot).toBeUndefined();
    expect(found.warning).toContain("conch couldn't draw it on the Mac to attach a snapshot. Publish a capture/screenshot instead");
  });

  test("the Mac app isn't running: it is never asked, and the verdict says so", async () => {
    const { dependencies, captured } = deps({ macRunning: false, anonymousState: "sign-in" });
    const found = await checkPageAccess("https://acme.dev/x", dependencies);
    expect(captured).toEqual([]);
    expect(found.access).toEqual({ mac: "unchecked", anonymous: "sign-in", why: `${MAC_NOT_DRAWN}; without cookies it served the page.` });
    expect(found.snapshot).toBeUndefined();
    expect(found.warning).toBeDefined();
  });

  test("an address carrying a credential, a magic link's token or an OAuth code, is never opened: it could be used up", async () => {
    const { dependencies, captured } = deps();
    let looked = false;
    const found = await checkPageAccess("https://acme.dev/auth/magic?token=one-time&next=/", { ...dependencies, anonymous: async () => { looked = true; return { state: "page", why: "" }; } });
    expect(found).toEqual({ access: { mac: "unchecked", anonymous: "unchecked", why: expect.stringContaining("carries a credential (?token=)") } });
    expect(captured).toEqual([]);
    expect(looked).toBe(false);
    expect(oneTimeCredential("http://localhost:3000/callback?code=abc&state=x")).toBe("code");
    expect(oneTimeCredential("https://acme.dev/pricing?plan=pro&utm_source=x")).toBeUndefined();
  });

  test("neither look said sign-in: no warning, whatever was unchecked", () => {
    for (const mac of ["page", "unchecked"] as const) {
      for (const anonymous of ["page", "unchecked"] as const) expect(accessWarning({ mac, anonymous }, mac === "page")).toBeUndefined();
    }
  });

  test("a look still out at the bound is unchecked, and a picture that comes after it is deleted, never left unfiled", async () => {
    let answer!: (outcome: CaptureOutcome) => void;
    const { dependencies, discarded } = deps({ mac: new Promise((resolve) => { answer = resolve; }), timeoutMs: 50 });
    const started = performance.now();
    const found = await checkPageAccess("https://acme.dev/x", dependencies);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(found.access).toMatchObject({ mac: "unchecked", anonymous: "page", why: "conch's Mac app didn't draw it within 0 s; without cookies it served the page." });
    expect(found.snapshot).toBeUndefined();
    answer(shot("/captures/late.png", false));
    await Bun.sleep(10);
    expect(discarded).toEqual(["/captures/late.png"]);
  });

  test("only a live page is checked: an http(s) link filed as url, not a design, an app, or a file", () => {
    expect(accessCheckedLink({ summary: "s", link: "https://acme.dev/x" })).toBe("https://acme.dev/x");
    expect(accessCheckedLink({ summary: "s", link: "http://localhost:3000/", kind: "url" })).toBe("http://localhost:3000/");
    expect(accessCheckedLink({ summary: "s", link: "https://www.figma.com/design/abc" })).toBeUndefined();
    expect(accessCheckedLink({ summary: "s", link: "https://acme.dev/x", kind: "app" })).toBeUndefined();
    expect(accessCheckedLink({ summary: "s", link: "/tmp/page.html" })).toBeUndefined();
    expect(accessCheckedLink(undefined)).toBeUndefined();
  });
});

describe("the bounds nest, innermost first, so the verdict always arrives inside the agent's wait", () => {
  test("Mac app's deadline < daemon's wait on it ≤ the check < the daemon's verdict wait < the MCP server's", () => {
    expect(ACCESS_RENDER_MS).toBeLessThan(ACCESS_CAPTURE_MS);
    expect(ACCESS_CAPTURE_MS).toBeLessThanOrEqual(ACCESS_CHECK_MS);
    expect(ANONYMOUS_CHECK_MS).toBeLessThan(ACCESS_CHECK_MS);
    // The filing keeps a wait of its own past the check.
    expect(REVIEW_VERDICT_WAIT_MS).toBe(ACCESS_CHECK_MS + REVIEW_FILING_WAIT_MS);
    // conch_capture's filing waits only the filing's own time, so a capture at its limit still answers inside the agent's.
    expect(CAPTURE_TIMEOUT_MS + REVIEW_FILING_WAIT_MS).toBeLessThan(CAPTURE_REPLY_MS);
    expect(REVIEW_VERDICT_TIMEOUT_MS).toBeGreaterThan(REVIEW_VERDICT_WAIT_MS);
    // A tool call is given about a minute; conch_capture's own wait is the longest conch asks for.
    expect(REVIEW_VERDICT_TIMEOUT_MS).toBeLessThanOrEqual(CAPTURE_REPLY_MS);
    expect(REVIEW_VERDICT_TIMEOUT_MS).toBe(25_000);
  });

  test("the Mac app is handed the check's deadline, and the broker gives up at the check's wait, not conch_capture's", async () => {
    const folder = mkdtempSync(join(scratch, "broker-"));
    const captures = new PageCaptures({ publish: () => {}, folder: () => folder, now: () => 1_000 });
    const asked = captures.ask({ url: "https://acme.dev/x", viewport: { width: 1440, height: 900 }, fullPage: false }, { ackMs: 20, timeoutMs: 60, renderMs: ACCESS_RENDER_MS });
    expect(captures.requests()[0]).toMatchObject({ deadline: 1_000 + ACCESS_RENDER_MS });
    await captures.answer({ request: captures.requests()[0]!.id, ack: true });
    expect(await asked).toMatchObject({ ok: false, error: expect.stringContaining("didn't finish drawing in 0 s") });
  });
});

describe("the verdict on the wire", () => {
  const filed = {
    kind: "review-filed",
    filing: { id: "f1", artifact: "a1", version: 1, kind: "url", link: "https://acme.dev/x" },
    surfaces: { mac: "running", phone: "connected", audio: "mac" },
  };

  test("access, warning and snapshot are read when they are well formed, and a verdict without them still is one", () => {
    expect(isReviewVerdict(filed)).toBe(true);
    expect(isReviewVerdict({ ...filed, access: { mac: "page", anonymous: "sign-in", why: "w" }, warning: "w", snapshot: "/c/a.png" })).toBe(true);
    expect(isReviewVerdict({ ...filed, access: { mac: "maybe", anonymous: "page" } })).toBe(false);
    expect(isReviewVerdict({ ...filed, warning: 3 })).toBe(false);
    expect(isPageAccess({ mac: "unchecked", anonymous: "unchecked" })).toBe(true);
  });

  test("a snapshot or an access is the daemon's finding, never a sender's; awaitAccess rides on awaitVerdict alone", () => {
    const publication: TurnEvent = { type: "review-published", sessionId: "s", label: "a", announce: "x", review: { summary: "s", link: "https://acme.dev" } };
    expect(validateSocketTurnEvent({ ...publication, review: { ...publication.review, snapshot: { path: "/etc/hosts", capturedAt: 1 } } }))
      .toEqual({ ok: false, err: "review snapshot is set by the daemon, not sent" });
    expect(validateSocketTurnEvent({ ...publication, review: { ...publication.review, access: { mac: "page", anonymous: "page" } } }))
      .toEqual({ ok: false, err: "review access is set by the daemon, not sent" });
    expect(validateSocketTurnEvent({ ...publication, awaitVerdict: true, awaitAccess: true }).ok).toBe(true);
    expect(validateSocketTurnEvent({ ...publication, awaitAccess: true })).toEqual({ ok: false, err: "awaitAccess is true, with awaitVerdict only" });
  });
});

// ── The Mac's picture, as a deliverable holds it.

describe("a snapshot is the deliverable's: held by the sweep, served to the phone, and gone with it", () => {
  const captures = captureFolderPath();
  const capture = (name: string, ageDays = 0): string => {
    mkdirSync(captures, { recursive: true, mode: 0o700 });
    const path = join(captures, name);
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    chmodSync(path, 0o600);
    if (ageDays) {
      const then = (Date.now() - ageDays * 24 * 60 * 60 * 1000) / 1000;
      utimesSync(path, then, then);
    }
    return path;
  };
  const filing = (id: string, at: number, snapshot?: string): SessionReview => ({
    summary: id, at, id, link: `https://acme.dev/${id}`, kind: "url", artifact: id, version: 1,
    ...(snapshot ? { snapshot: { path: snapshot, capturedAt: at }, access: { mac: "page" as const, anonymous: "sign-in" as const } } : {}),
  });
  const ledgerFile = () => join(mkdtempSync(join(scratch, "ledger-")), "reviews.json");

  test("attached to the filing it was of, replacing an older one, and nothing for a filing the session doesn't hold", () => {
    const held = [filing("a", 1), filing("b", 2)];
    const next = attachReviewAccess(held, "b", { access: { mac: "page", anonymous: "sign-in" }, snapshot: { path: "/c/b.png", capturedAt: 3 } });
    expect(next?.[1]).toMatchObject({ id: "b", snapshot: { path: "/c/b.png", capturedAt: 3 }, access: { mac: "page", anonymous: "sign-in" } });
    expect(next?.[0]).toEqual(held[0]!);
    const walled = attachReviewAccess(next, "b", { access: { mac: "sign-in", anonymous: "sign-in" } });
    expect(walled?.[1]?.snapshot).toBeUndefined();
    expect(attachReviewAccess(held, "nope", { access: { mac: "page", anonymous: "page" } })).toBeUndefined();
  });

  test("the capture sweep keeps a held snapshot however old, and lets go of one nothing holds", () => {
    const old = capture("held-0001.png", 30);
    const stray = capture("stray-0001.png", 30);
    const ledger = new SessionLedger(ledgerFile());
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: filing("a", 1, old), reviews: [filing("a", 1, old)] });
    expect(ledger.heldFiles().has(old)).toBe(true);
    pruneCaptures(captures, Date.now(), ledger.heldFiles());
    expect(existsSync(old)).toBe(true);
    expect(existsSync(stray)).toBe(false);
    expect(CAPTURES_KEPT).toBeGreaterThan(0);
  });

  test("saved and restored with its deliverable, and published for the apps", () => {
    const path = ledgerFile();
    const snap = capture("kept-0001.png");
    const ledger = new SessionLedger(path);
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 1, review: filing("a", 1, snap), reviews: [filing("a", 1, snap)] });
    ledger.saveReviews();
    const after = new SessionLedger(path);
    after.restoreReviews();
    expect(after.sessionStates.get("s")?.review).toMatchObject({ snapshot: { path: snap, capturedAt: 1 }, access: { mac: "page", anonymous: "sign-in" } });
    const state = buildPublishedState("mac", {
      mode: { paused: false }, live: {}, rows: [{ sessionId: "s", label: "s", status: "waiting", reviews: [filing("a", 1, snap)], review: filing("a", 1, snap) }],
    } as never, new Map(), new Set(), 1);
    expect(state.rows[0]?.review).toMatchObject({ snapshot: { path: snap, capturedAt: 1 }, access: { mac: "page", anonymous: "sign-in" } });
  });

  test("released on removal and past the cap, never while another filing names the file, and never outside the capture folder", () => {
    const removed = capture("removed-0001.png");
    const shared = capture("shared-0001.png");
    const outside = join(scratch, "outside.png");
    writeFileSync(outside, "keep me");
    const ledger = new SessionLedger(ledgerFile());
    // `c` is a conch_capture of the same picture, filed as an image: it holds the file `b` keeps as its snapshot.
    const imageOfIt: SessionReview = { summary: "c", at: 3, id: "c", link: shared, kind: "image", artifact: "c", version: 1 };
    const held = [filing("a", 1, removed), filing("b", 2, shared), imageOfIt, filing("d", 4, outside)];
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 4, review: held.at(-1)!, reviews: held });
    ledger.saveReviews();
    expect(ledger.removeDeliverables("s", { review: "a" })).toBe(true);
    expect(existsSync(removed)).toBe(false);
    expect(ledger.removeDeliverables("s", { review: "b" })).toBe(true);
    expect(existsSync(shared)).toBe(true);
    expect(ledger.removeDeliverables("s", { review: "d" })).toBe(true);
    expect(existsSync(outside)).toBe(true);

    // Past the cap: the oldest filing drops, and its snapshot with it.
    const oldest = capture("oldest-0001.png");
    let kept: SessionReview[] | undefined = [filing("f0", 10, oldest)];
    ledger.sessionStates.set("t", { label: "t", status: "waiting", at: 10, review: kept[0]!, reviews: kept });
    ledger.saveReviews();
    for (let index = 1; index <= MAX_SESSION_REVIEWS; index += 1) kept = carriedReviews(kept, filing(`f${index}`, 10 + index));
    expect(kept!.some((one) => one.id === "f0")).toBe(false);
    ledger.sessionStates.set("t", { label: "t", status: "waiting", at: 20, review: kept!.at(-1)!, reviews: kept });
    ledger.saveReviews();
    expect(existsSync(oldest)).toBe(false);
  });

  test("only a picture of conch's own is ever deleted: directly in the capture folder, by conch's name for it", () => {
    const mine = capture("abc-123.png");
    discardCapture(`${captures}/../captures/abc-123.png`, captures);
    discardCapture(join(scratch, "abc-123.png"), captures);
    discardCapture(undefined, captures);
    expect(existsSync(mine)).toBe(true);
    discardCapture(mine, captures);
    expect(existsSync(mine)).toBe(false);
  });

  test("the phone's /file serves a held snapshot from the capture folder, and nothing it doesn't hold", async () => {
    const snap = capture("served-0001.png");
    const stray = capture("unheld-0001.png");
    const token = "t".repeat(32);
    const bridge = createPhoneBridgeApplication({
      getState: () => ({ rows: [{ id: "s", cwd: scratch, reviews: [filing("a", 1, snap)] }] }),
      forwardControl: async () => "{}",
      replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      log: () => {},
    } as never, { token });
    const status = async (path: string) => ((await bridge.handle(new Request(`https://relay.invalid/file?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${token}` },
    }))) as Response).status;
    expect(await status(snap)).toBe(200);
    expect(await status(stray)).toBe(403);
  });
});

// ── The apps' halves. The iOS app has no test target and the Mac app's views none, so their wiring is read; the words
// and decisions are ConchDesign's (PageAccessTests), and the decode runs under swift (ios-stand-in-source.test.ts).

describe("the apps: the phone shows the Mac's picture first, the Mac says sign in here", () => {
  const sheet = read("mobile/conch-ios/conch-ios/DeliverableSheet.swift");
  const review = read("mac-app/conch-mac/ReviewView.swift");
  const macModels = read("mac-app/conch-mac/Models.swift");

  test("a live page with a snapshot opens on it, with its caption, the sign-in note, and the live page a tap away", () => {
    expect(sheet).toContain("guard !showLive, let snapshot = review.snapshot else { return nil }");
    expect(sheet).toContain("case .web, .macLocal: return snapshot");
    expect(sheet).toContain("note: PageAccess.phoneNote(review.access),\n                onOpenLive: { showLive = true }");
    // No Back, Reload or Safari over a picture: they act on a page.
    expect(sheet).toContain("if pageSnapshot != nil { return nil }");
    const view = sheet.slice(sheet.indexOf("struct PageSnapshotView: View {"), sheet.indexOf("struct StandInView: View {"));
    expect(view).toContain("PageAccess.snapshotCaption(capturedAt: Date(timeIntervalSince1970: snapshot.capturedAt / 1000))");
    expect(view).toContain("Label(PageAccess.openLiveTitle, systemImage: \"globe\")");
    // Over the bridge's /file, which serves a held snapshot (phone-bridge.ts `servableFile`).
    expect(view).toContain("try await bridge.fetchFile(path: snapshot.path)");
    // And back from the live page to the picture.
    expect(sheet).toContain(".accessibilityLabel(\"Snapshot from your Mac\")");
  });

  test("the Mac reads the check and draws its banner over a live page that asked conch to sign in", () => {
    expect(macModels).toContain("access = try? container.decodeIfPresent(PageAccess.Found.self, forKey: .access)");
    expect(review).toContain("signInBanner: PageAccess.macBanner(item.access)");
    expect(review).toContain("if let signInBanner, !signInBannerClosed, navigationFailure == nil, downPage == nil {");
    expect(review).toContain("SignInBanner(text: signInBanner) { signInBannerClosed = true }");
  });
});

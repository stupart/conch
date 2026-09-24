import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";
import type { PortListener } from "../src/screen-context.ts";

/**
 * A page a session serves from the Mac's localhost, read for the phone through `/dev`. Tyler,
 * 09-25: "Phone will need viewing of dev server ones". Every rule that keeps it to that one server,
 * of that one session, read-only, is pinned here, through the handler both transports call.
 */
const TOKEN = "d".repeat(32);

/** A dev server that records what reached it, and a second one that nothing should reach. */
const seen: Array<{ method: string; path: string; cookie: string | null; authorization: string | null; upgrade: string | null }> = [];
const dev = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      path: url.pathname + url.search,
      cookie: req.headers.get("cookie"),
      authorization: req.headers.get("authorization"),
      upgrade: req.headers.get("upgrade"),
    });
    if (url.pathname === "/away") return Response.redirect(`http://127.0.0.1:${elsewhere.port}/x`, 302);
    if (url.pathname === "/moved") return new Response(null, { status: 302, headers: { location: "/landed" } });
    if (url.pathname === "/events") return new Response("data: 1\n\n", { headers: { "content-type": "text/event-stream" } });
    return new Response(`page at ${url.pathname}`, {
      headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "session=secret", "x-powered-by": "dev" },
    });
  },
});
const elsewhereSeen: string[] = [];
const elsewhere = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    elsewhereSeen.push(new URL(req.url).pathname);
    return new Response("elsewhere");
  },
});
afterAll(() => {
  dev.stop(true);
  elsewhere.stop(true);
});

const SESSION_PID = 1000;
const OTHER_PID = 2000;
/** Who "lsof" says listens on the dev server's port: started by the session, by default. */
let listeners: PortListener[] = [{ pid: 4242, parents: [SESSION_PID, 1] }];

const application = createPhoneBridgeApplication({
  getState: () => ({
    v: 1,
    rows: [
      { id: "s", cwd: "/Users/t/proj", reviews: [
        { id: "rev-dev", link: `http://127.0.0.1:${dev.port}/` },
        { id: "rev-file", link: "/tmp/page.html" },
        { id: "rev-web", link: "https://example.com/" },
      ] },
      { id: "t", cwd: "/Users/t/other" },
    ],
  }),
  forwardControl: async () => "{}",
  replyFor: async () => "",
  acceptUpload: async () => ({ received: 1, total: 1 }),
  portListeners: async (port) => (port === dev.port ? listeners : []),
  sessionPid: (id) => (id === "s" ? SESSION_PID : id === "t" ? OTHER_PID : undefined),
  log: () => {},
}, { token: TOKEN });

/** `path` goes into the query exactly as written, so encoded tricks arrive as a phone could send them. */
async function read(review: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  const response = await application.handle(new Request(
    `https://relay.invalid/dev?review=${encodeURIComponent(review)}&path=${path}`,
    { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } },
  )) as Response;
  return { status: response.status, text: await response.text(), headers: response.headers };
}
const q = encodeURIComponent;

describe("the dev server a held review names, and only it", () => {
  test("the session's own server is read, at the path asked", async () => {
    seen.length = 0;
    const page = await read("rev-dev", q("/app/index.html?tab=2"));
    expect(page.status).toBe(200);
    expect(page.text).toBe("page at /app/index.html");
    expect(seen.map((one) => one.path)).toEqual(["/app/index.html?tab=2"]);
  });

  test("a port no held review names is refused: an unknown id, a file review, a web review", async () => {
    seen.length = 0;
    for (const review of ["", "rev-missing", "rev-file", "rev-web"]) {
      expect((await read(review, q("/"))).status).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  test("a listener owned by another session, by nobody, or by no one listening is refused", async () => {
    seen.length = 0;
    const restore = listeners;
    try {
      // Another session started it.
      listeners = [{ pid: 4242, parents: [OTHER_PID, 1] }];
      expect((await read("rev-dev", q("/"))).status).toBe(403);
      // Runs in the other session's folder.
      listeners = [{ pid: 4242, cwd: "/Users/t/other/web", parents: [1] }];
      expect((await read("rev-dev", q("/"))).status).toBe(403);
      // Started by nothing conch knows, somewhere no session works.
      listeners = [{ pid: 4242, cwd: "/opt/elsewhere", parents: [1] }];
      expect((await read("rev-dev", q("/"))).status).toBe(403);
      // Nothing listening at all.
      listeners = [];
      expect((await read("rev-dev", q("/"))).status).toBe(503);
      expect(seen).toEqual([]);
      // Runs in the session's own folder: that is the session's.
      listeners = [{ pid: 4242, cwd: "/Users/t/proj/web", parents: [1] }];
      expect((await read("rev-dev", q("/"))).status).toBe(200);
    } finally {
      listeners = restore;
    }
  });

  test("a path that would leave that server is refused before anything is fetched", async () => {
    seen.length = 0;
    elsewhereSeen.length = 0;
    const away = `127.0.0.1:${elsewhere.port}/x`;
    for (const path of [
      q(`//${away}`),
      q(`/\\${away}`),
      q(`http://${away}`),
      `%2F%2F${away}`,
      q("relative/page"),
      q(`\\\\${away}`),
    ]) {
      expect((await read("rev-dev", path)).status).toBe(400);
    }
    expect(seen).toEqual([]);
    expect(elsewhereSeen).toEqual([]);
    // Dot segments are resolved before the request, and stay on the server.
    expect((await read("rev-dev", q("/a/../../b"))).text).toBe("page at /b");
    expect((await read("rev-dev", "%2Fa%2F%2e%2e%2Fc")).text).toBe("page at /c");
  });

  test("a redirect is followed only on that server", async () => {
    elsewhereSeen.length = 0;
    expect((await read("rev-dev", q("/moved"))).text).toBe("page at /landed");
    expect((await read("rev-dev", q("/away"))).status).toBe(502);
    expect(elsewhereSeen).toEqual([]);
  });
});

describe("read-only, no live updates, nothing of the phone's passed on", () => {
  test("only GET and HEAD", async () => {
    seen.length = 0;
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const refused = await read("rev-dev", q("/"), { method, ...(method === "OPTIONS" ? {} : { body: "x" }) });
      expect(refused.status).toBe(405);
    }
    expect(seen).toEqual([]);
    expect((await read("rev-dev", q("/"), { method: "HEAD" })).status).toBe(200);
    expect(seen.map((one) => one.method)).toEqual(["HEAD"]);
  });

  test("a websocket upgrade is refused, and live-update endpoints and event streams too", async () => {
    seen.length = 0;
    expect((await read("rev-dev", q("/"), { headers: { upgrade: "websocket", connection: "Upgrade" } })).status).toBe(403);
    expect(seen).toEqual([]);
    for (const path of ["/__vite_ping", "/__webpack_hmr", "/_next/webpack-hmr", "/sockjs-node/info"]) {
      expect((await read("rev-dev", q(path))).status).toBe(404);
    }
    expect(seen).toEqual([]);
    expect((await read("rev-dev", q("/events"))).status).toBe(404);
  });

  test("the phone's token and cookies never reach the server, and the server's cookies never reach the phone", async () => {
    seen.length = 0;
    const page = await read("rev-dev", q("/"), { headers: { cookie: "phone=1" } });
    expect(page.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cookie).toBeNull();
    expect(seen[0]!.authorization).toBeNull();
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(page.headers.get("x-powered-by")).toBeNull();
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("without the token, nothing", async () => {
    const response = await application.handle(new Request(`https://relay.invalid/dev?review=rev-dev&path=%2F`)) as Response;
    expect(response.status).toBe(401);
  });
});

test("the daemon hands the bridge the screen context's listener lookup and the sessions' pids", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
  const bridge = daemon.slice(daemon.indexOf("phoneApplication = createPhoneBridgeApplication("));
  const deps = bridge.slice(0, bridge.indexOf("{ token"));
  expect(deps).toContain("portListeners,");
  expect(deps).toContain("sessionPid: (sessionId) => panelSessions.get(sessionId)?.pid,");
});

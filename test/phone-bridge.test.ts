import { injectTimeoutFor } from "../src/daemon.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conchHome } from "../src/home.ts";
import {
  createPhoneBridge,
  createPhoneBridgeApplication,
  ensurePhoneToken,
  forwardToDaemonSocket,
  mintPairingCode,
  readPairingBody,
  sendPhoneFrame,
  tokenMatches,
  type PhoneBridgeHandle,
} from "../src/phone-bridge.ts";

let bridge: PhoneBridgeHandle | null = null;
afterEach(() => {
  bridge?.stop();
  bridge = null;
});

const TOKEN = "a".repeat(32);

function makeApplication(
  overrides: Partial<Parameters<typeof createPhoneBridge>[0]> = {},
) {
  return createPhoneBridgeApplication(
    {
      getState: () => ({ v: 1, rows: [{ id: "r1" }] }),
      forwardControl: async (line) => JSON.stringify({ echoed: JSON.parse(line).kind }),
      replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      log: () => {},
      ...overrides,
    },
    { token: TOKEN },
  );
}

function startBridge(overrides: Partial<Parameters<typeof createPhoneBridge>[0]> = {}) {
  bridge = createPhoneBridge(
    {
      getState: () => ({ v: 1, rows: [{ id: "r1" }] }),
      forwardControl: async (line) => JSON.stringify({ echoed: JSON.parse(line).kind }),
      replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      log: () => {},
      ...overrides,
    },
    { port: 0, token: TOKEN, hostname: "127.0.0.1" },
  );
  return bridge;
}

describe("pairing token", () => {
  test("minted once, 0600, stable across reads", () => {
    const dir = mkdtempSync("/tmp/conch-phone-test-");
    const path = join(dir, "phone-token");
    const first = ensurePhoneToken(path);
    expect(first.length).toBeGreaterThanOrEqual(24);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(ensurePhoneToken(path)).toBe(first);
    expect(readFileSync(path, "utf8").trim()).toBe(first);
  });

  test("comparison is exact and null-safe", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
  });
});

describe("the auth gate", () => {
  test("every route refuses a missing or wrong token", async () => {
    const b = startBridge();
    for (const path of ["/state", "/control", "/ws", "/nope"]) {
      const bare = await fetch(`http://127.0.0.1:${b.port}${path}`);
      expect(bare.status).toBe(401);
      const wrong = await fetch(`http://127.0.0.1:${b.port}${path}`, {
        headers: { authorization: `Bearer ${"b".repeat(32)}` },
      });
      expect(wrong.status).toBe(401);
    }
  });

  test("state round-trips with the right token", async () => {
    const b = startBridge();
    const res = await fetch(`http://127.0.0.1:${b.port}/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 1, rows: [{ id: "r1" }] });
  });

  test("query tokens are accepted only where the iOS clients require them", async () => {
    const b = startBridge({
      getState: () => ({
        v: 1,
        rows: [{ id: "r1", review: { link: "/tmp/not-read", summary: "x" } }],
      }),
    });
    for (const path of ["/state", "/reply?session=r1", "/control"]) {
      const separator = path.includes("?") ? "&" : "?";
      const res = await fetch(
        `http://127.0.0.1:${b.port}${path}${separator}token=${TOKEN}`,
        path.startsWith("/control") ? { method: "POST", body: "{}" } : undefined,
      );
      expect(res.status).toBe(401);
    }
  });
});

describe("transport-independent request handler", () => {
  test("the shared handler itself owns the auth gate for every protected route", async () => {
    const application = makeApplication();
    const routes: Array<{ path: string; init?: RequestInit }> = [
      { path: "/state" },
      { path: "/reply?session=r1" },
      { path: "/file?path=%2Ftmp%2Fanything" },
      { path: "/control", init: { method: "POST", body: "{}" } },
      { path: "/ws" },
      { path: "/nope" },
    ];

    for (const { path, init } of routes) {
      const missing = await application.handle(new Request(`https://relay.invalid${path}`, init));
      expect(missing).toBeInstanceOf(Response);
      expect((missing as Response).status).toBe(401);

      const wrong = await application.handle(new Request(`https://relay.invalid${path}`, {
        ...init,
        headers: { authorization: `Bearer ${"b".repeat(32)}` },
      }));
      expect(wrong).toBeInstanceOf(Response);
      expect((wrong as Response).status).toBe(401);
    }

    const state = await application.handle(new Request("https://relay.invalid/state", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    expect(state).toBeInstanceOf(Response);
    expect(await (state as Response).json()).toEqual({ v: 1, rows: [{ id: "r1" }] });
  });

  test("a synthetic /ws upgrade subscribes through the shared state hub", () => {
    const counts: number[] = [];
    let version = 1;
    const application = makeApplication({
      getState: () => ({ v: version, rows: [] }),
      onClientsChanged: (count) => counts.push(count),
    });
    const frames: string[] = [];
    const sink = {
      send(frame: string) {
        frames.push(frame);
        return frame.length;
      },
    };

    const result = application.handle(
      new Request("https://relay.invalid/ws", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      {
        upgradeState(_request, subscribe) {
          subscribe(sink);
          return true;
        },
      },
    );

    expect(result).toBeUndefined();
    expect(application.clientCount()).toBe(1);
    expect(counts).toEqual([1]);
    expect(frames.map((frame) => JSON.parse(frame).v)).toEqual([1]);

    version = 2;
    application.publish();
    expect(frames.map((frame) => JSON.parse(frame).v)).toEqual([1, 2]);

    application.unsubscribeState(sink);
    expect(application.clientCount()).toBe(0);
    expect(counts).toEqual([1, 0]);
  });
});

describe("control forwarding", () => {
  test("POST /control relays through the injected forwarder", async () => {
    const b = startBridge();
    const res = await fetch(`http://127.0.0.1:${b.port}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ kind: "get-config" }),
    });
    expect(await res.json()).toEqual({ echoed: "get-config" });
  });

  // The phone turns the reason into a sentence, so the bridge must hand back what the
  // daemon said and not a summary of it.
  test("a delivery failure reaches the phone with its reason intact", async () => {
    const receipt = { kind: "inject-done", delivered: false, reason: "system-dialog-blocking", onClipboard: true };
    const b = startBridge({ forwardControl: async () => JSON.stringify(receipt) });
    const res = await fetch(`http://127.0.0.1:${b.port}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ type: "inject", sessionId: "s1", label: "alpha", announce: "hello", awaitDelivery: true }),
    });
    expect(await res.json()).toEqual(receipt);
  });

  test("a dead daemon is a 502, not a hang or a crash", async () => {
    const b = startBridge({
      forwardControl: async () => { throw new Error("no socket"); },
    });
    const res = await fetch(`http://127.0.0.1:${b.port}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ kind: "get-config" }),
    });
    expect(res.status).toBe(502);
  });
});

describe("websocket push", () => {
  test("connects with token, gets the state immediately and on publish", async () => {
    // The state has to actually MOVE between the two deliveries. An identical
    // frame is deliberately not resent — the phone decodes every frame as a
    // complete state on the main actor, so a redundant one is a full re-render
    // of a busy screen for no new information.
    let status = "working";
    const b = startBridge({ getState: () => ({ v: 1, rows: [{ id: "r1", status }] }) });
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        frames.push(String(event.data));
        if (frames.length === 2) resolve();
        else {
          status = "waiting";
          b.publish();
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("timed out")), 3000);
    });
    ws.close();
    expect(JSON.parse(frames[0]!).v).toBe(1);
    expect(JSON.parse(frames[1]!).v).toBe(1);
  });

  test("a tokenless upgrade is refused", async () => {
    const b = startBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.onerror = () => resolve(true);
      ws.onopen = () => resolve(false);
      setTimeout(() => resolve(true), 2000);
    });
    expect(failed).toBe(true);
  });
});

describe("socket forwarder", () => {
  test("relays one line to a unix socket and returns the reply", async () => {
    const path = `/tmp/conch-phone-fwd-${process.pid}.sock`;
    const server = Bun.listen({
      unix: path,
      socket: {
        data(sock, chunk) {
          const line = chunk.toString().trim();
          sock.write(`{"got":${JSON.stringify(line)}}\n`);
        },
      },
    });
    try {
      const reply = await forwardToDaemonSocket(path, '{"kind":"get-config"}');
      expect(JSON.parse(reply).got).toBe('{"kind":"get-config"}');
    } finally {
      server.stop(true);
    }
  });
});

describe("file serving", () => {
  test("serves only a path currently published as a review or inline material", async () => {
    const dir = mkdtempSync("/tmp/conch-phone-file-");
    const served = join(dir, "deliverable.txt");
    await Bun.write(served, "the deliverable body");
    const secret = join(dir, "secret.txt");
    await Bun.write(secret, "never served");
    const material = join(dir, "material.png");
    await Bun.write(material, "inline image bytes");

    const b = startBridge({
      getState: () => ({
        v: 1,
        rows: [{ id: "r1", review: { link: served, summary: "x" } }],
        conversations: {
          r1: { items: [{ material: { kind: "image", path: material } }] },
        },
      }),
    });
    const auth = { authorization: `Bearer ${TOKEN}` };

    const ok = await fetch(
      `http://127.0.0.1:${b.port}/file?path=${encodeURIComponent(served)}`,
      { headers: auth },
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("the deliverable body");

    const inline = await fetch(
      `http://127.0.0.1:${b.port}/file?path=${encodeURIComponent(material)}`,
      { headers: auth },
    );
    expect(inline.status).toBe(200);
    expect(await inline.text()).toBe("inline image bytes");

    const queryAuthenticated = await fetch(
      `http://127.0.0.1:${b.port}/file?path=${encodeURIComponent(served)}&token=${TOKEN}`,
    );
    expect(queryAuthenticated.status).toBe(200);
    expect(await queryAuthenticated.text()).toBe("the deliverable body");

    // The token holder may see what the dashboard shows — nothing else.
    const denied = await fetch(
      `http://127.0.0.1:${b.port}/file?path=${encodeURIComponent(secret)}`,
      { headers: auth },
    );
    expect(denied.status).toBe(403);

    const noToken = await fetch(
      `http://127.0.0.1:${b.port}/file?path=${encodeURIComponent(served)}`,
    );
    expect(noToken.status).toBe(401);
  });

  test("the synthetic handler checks the current review set at dispatch time", async () => {
    const dir = mkdtempSync("/tmp/conch-phone-handler-file-");
    const served = join(dir, "deliverable.txt");
    const secret = join(dir, "secret.txt");
    await Bun.write(served, "approved now");
    await Bun.write(secret, "never approved");
    let currentLink: string | undefined = served;
    const application = makeApplication({
      getState: () => ({
        v: 1,
        rows: currentLink
          ? [{ id: "r1", review: { link: currentLink, summary: "x" } }]
          : [{ id: "r1" }],
      }),
    });
    const request = (path: string) => new Request(
      `https://relay.invalid/file?path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );

    const approved = await application.handle(request(served));
    expect(approved).toBeInstanceOf(Response);
    expect((approved as Response).status).toBe(200);
    expect(await (approved as Response).text()).toBe("approved now");

    const sibling = await application.handle(request(secret));
    expect(sibling).toBeInstanceOf(Response);
    expect((sibling as Response).status).toBe(403);

    // A delayed relay frame is authorized against NOW, not the state from when
    // the phone first created it. Removing this current-link check must make
    // this mutation test fail over both transports.
    currentLink = undefined;
    const stale = await application.handle(request(served));
    expect(stale).toBeInstanceOf(Response);
    expect((stale as Response).status).toBe(403);
  });
});

// Tyler: "a huge improvement would be having all content viewable and interative on phone app".
// `/file` now serves every deliverable a session holds and what a published page loads from its
// own folder, so each rule that keeps it from serving anything else is pinned here, through the
// one handler both transports call.
describe("file serving: held deliverables, their folders, and nothing else", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  /** Write `body` at `path`, folders and all, 0600 unless told otherwise. */
  const put = (path: string, body = "x", mode = 0o600): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    chmodSync(path, mode);
    return path;
  };
  const scratch = (): string => {
    const root = mkdtempSync(join(tmpdir(), "conch-file-scope-"));
    made.push(root);
    return root;
  };
  type Row = { id: string; cwd?: string; review?: { link: string }; reviews?: Array<{ link: string }> };
  const appFor = (state: () => { rows: Row[]; conversations?: Record<string, unknown> }, uploadsDirectory?: string) =>
    makeApplication({ getState: state, ...(uploadsDirectory ? { uploadsDirectory } : {}) });
  /** The status for `query`, sent exactly as written — so encoded traversal arrives as a phone could send it. */
  const status = async (application: ReturnType<typeof makeApplication>, query: string): Promise<number> => {
    const response = await application.handle(new Request(`https://relay.invalid/file?path=${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }));
    return (response as Response).status;
  };
  const q = encodeURIComponent;

  test("an older deliverable the session still holds is served, not only the newest", async () => {
    const root = scratch();
    const older = put(join(root, "v1.png"));
    const newest = put(join(root, "v2.png"));
    const unpublished = put(join(root, "v3.png"));
    const application = appFor(() => ({
      rows: [{ id: "s", review: { link: newest }, reviews: [{ link: older }, { link: newest }] }],
    }));
    expect(await status(application, q(older))).toBe(200);
    expect(await status(application, q(newest))).toBe(200);
    // Same folder, same extension, never published: refused.
    expect(await status(application, q(unpublished))).toBe(403);
  });

  test("a published page brings its styles, scripts, data and pictures from its own folder", async () => {
    const root = scratch();
    const page = put(join(root, "site/index.html"), "<link rel=stylesheet href=style.css>");
    const application = appFor(() => ({ rows: [{ id: "s", review: { link: page } }] }));
    for (const asset of ["style.css", "app.js", "mod.mjs", "data.json", "img/hero.png", "fonts/inter.woff2", "logo.svg"]) {
      put(join(root, "site", asset));
      expect(await status(application, q(join(root, "site", asset)))).toBe(200);
    }
    // A markdown document's pictures, the same way.
    const doc = put(join(root, "notes/review.md"), "![shot](shots/a.png)");
    const shot = put(join(root, "notes/shots/a.png"));
    expect(await status(appFor(() => ({ rows: [{ id: "s", review: { link: doc } }] })), q(shot))).toBe(200);
    // A deliverable that is not a page or a document opens nothing beside it.
    const image = put(join(root, "renders/hero.png"));
    const beside = put(join(root, "renders/other.png"));
    const imageOnly = appFor(() => ({ rows: [{ id: "s", review: { link: image } }] }));
    expect(await status(imageOnly, q(image))).toBe(200);
    expect(await status(imageOnly, q(beside))).toBe(403);
  });

  test("beside a page: a non-asset extension, a hidden file, an executable, and anything the session does not still hold are refused", async () => {
    const root = scratch();
    const page = put(join(root, "site/index.html"));
    let held = true;
    const application = appFor(() => ({ rows: held ? [{ id: "s", review: { link: page } }] : [{ id: "s" }] }));
    for (const refused of ["notes.txt", "build.sh", "server.pem", "config.yaml", "other.html", "readme.md"]) {
      expect(await status(application, q(put(join(root, "site", refused))))).toBe(403);
    }
    for (const hidden of [".env.json", ".git/config.json", ".cache/app.js"]) {
      expect(await status(application, q(put(join(root, "site", hidden))))).toBe(403);
    }
    expect(await status(application, q(put(join(root, "site/tool.js"), "x", 0o755)))).toBe(403);
    const style = put(join(root, "site/style.css"));
    expect(await status(application, q(style))).toBe(200);
    held = false;
    expect(await status(application, q(style))).toBe(403);
    expect(await status(application, q(page))).toBe(403);
  });

  test("traversal out of the page's folder is refused however it is spelled", async () => {
    const root = scratch();
    const site = join(root, "site");
    const page = put(join(site, "index.html"));
    // Under the same temp root, so only the folder rule stands between the page and it.
    put(join(root, "outside.css"));
    const application = appFor(() => ({ rows: [{ id: "s", review: { link: page } }] }));
    expect(await status(application, q(`${site}/../outside.css`))).toBe(403);
    expect(await status(application, `${q(site)}%2F%2e%2e%2Foutside.css`)).toBe(403);
    expect(await status(application, `${q(site)}/%2e%2e/outside.css`)).toBe(403);
    expect(await status(application, `${q(site)}/..%2Foutside.css`)).toBe(403);
    expect(await status(application, `${q(site)}%2F..%252Foutside.css`)).toBe(403);
    expect(await status(application, `${q(site)}/%252e%252e/outside.css`)).toBe(403);
    expect(await status(application, q("site/style.css"))).toBe(403);
    // Climbing out and back in is the same file, and fine.
    put(join(site, "style.css"));
    expect(await status(application, q(`${site}/../site/style.css`))).toBe(200);
  });

  test("a symlink out of the folder is refused, including one swapped in after publishing", async () => {
    const root = scratch();
    const site = join(root, "site");
    const page = put(join(site, "index.html"));
    const outside = put(join(root, "outside.css"));
    const hidden = put(join(root, ".ssh/id_ed25519.json"));
    const repoFile = join(import.meta.dir, "..", "package.json");
    symlinkSync(outside, join(site, "linked.css"));
    symlinkSync(hidden, join(site, "key.json"));
    symlinkSync(repoFile, join(site, "package.json"));
    const application = appFor(() => ({ rows: [{ id: "s", review: { link: page } }] }));
    expect(await status(application, q(join(site, "linked.css")))).toBe(403);
    expect(await status(application, q(join(site, "key.json")))).toBe(403);
    expect(await status(application, q(join(site, "package.json")))).toBe(403);

    // Published as a real file, then replaced by a link to somewhere it could never be published from.
    const shot = put(join(root, "shot.png"));
    const swapped = appFor(() => ({ rows: [{ id: "s", review: { link: shot } }] }));
    expect(await status(swapped, q(shot))).toBe(200);
    unlinkSync(shot);
    symlinkSync(join(import.meta.dir, "..", "assets/conch-icon-1024.png"), shot);
    expect(await status(swapped, q(shot))).toBe(403);
    unlinkSync(shot);
    expect(await status(swapped, q(shot))).toBe(404);
  });

  test("a page directly in /tmp, the temp folder or the home folder serves only itself", async () => {
    const tag = `conch-file-scope-${process.pid}-${Date.now()}`;
    for (const folder of ["/tmp", tmpdir(), conchHome()]) {
      const page = put(join(folder, `${tag}.html`));
      const style = put(join(folder, `${tag}.css`));
      const nested = put(join(folder, `${tag}-dir/app.js`));
      made.push(page, style, dirname(nested));
      const application = appFor(() => ({ rows: [{ id: "s", review: { link: page } }] }));
      expect(await status(application, q(page))).toBe(200);
      expect(await status(application, q(style))).toBe(403);
      expect(await status(application, q(nested))).toBe(403);
    }
    // One folder down from home is an ordinary folder, and opens.
    const page = put(join(conchHome(), `${tag}-site/index.html`));
    made.push(dirname(page));
    const style = put(join(conchHome(), `${tag}-site/style.css`));
    expect(await status(appFor(() => ({ rows: [{ id: "s", review: { link: page } }] })), q(style))).toBe(200);
  });

  test("a conversation's material passes the same rule, against its own session's folder", async () => {
    const root = scratch();
    const repoImage = join(import.meta.dir, "..", "assets/conch-icon-1024.png");
    const hiddenImage = put(join(root, ".private/shot.png"));
    const tmpImage = put(join(root, "shot.png"));
    let cwd: string | undefined;
    const application = appFor(() => ({
      rows: [{ id: "s", ...(cwd ? { cwd } : {}) }],
      conversations: {
        s: { items: [repoImage, hiddenImage, tmpImage].map((path) => ({ material: { kind: "image", path } })) },
      },
    }));
    expect(await status(application, q(tmpImage))).toBe(200);
    // Any absolute image path an agent wrote on its own line used to be readable.
    expect(await status(application, q(repoImage))).toBe(403);
    expect(await status(application, q(hiddenImage))).toBe(403);
    cwd = join(import.meta.dir, "..");
    expect(await status(application, q(repoImage))).toBe(200);
  });

  test("a picture the phone sent shows back from conch's own upload folder, and nothing else in a hidden folder does", async () => {
    const root = scratch();
    const uploads = join(root, ".cache/conch/uploads");
    const sent = put(join(uploads, "abc123.jpg"));
    const deeper = put(join(uploads, "nested/abc.jpg"));
    const state = () => ({
      rows: [{ id: "s" }],
      conversations: { s: { items: [sent, deeper].map((path) => ({ material: { kind: "image", path } })) } },
    });
    expect(await status(appFor(state, uploads), q(sent))).toBe(200);
    expect(await status(appFor(state, uploads), q(deeper))).toBe(403);
    expect(await status(appFor(state), q(sent))).toBe(403);
  });
});

describe("short pairing code", () => {
  test("the body cap rejects declared and chunked oversized input before redemption", async () => {
    let readerRequests = 0;
    const declared = {
      headers: new Headers({ "content-length": "1025" }),
      body: {
        getReader() {
          readerRequests += 1;
          throw new Error("oversized declared body was read");
        },
      },
    } as unknown as Request;
    expect(await readPairingBody(declared)).toEqual({ ok: false, tooLarge: true });
    expect(readerRequests).toBe(0);

    const chunked = new Request("http://bridge/pair", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(700));
          controller.enqueue(new Uint8Array(700));
          controller.close();
        },
      }),
    });
    expect(await readPairingBody(chunked)).toEqual({ ok: false, tooLarge: true });

    const b = startBridge();
    b.offerPairingCode({ code: "123456", expiresAt: Date.now() + 60_000 });
    const oversized = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: "x".repeat(1025),
    });
    expect(oversized.status).toBe(413);
    const stillRedeemable = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(stillRedeemable.status).toBe(200);
  });

  test("exchanges once for the token, then is spent", async () => {
    const b = startBridge();
    const code = mintPairingCode();
    b.offerPairingCode(code);

    const first = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: code.code }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { token: string }).token).toBe(TOKEN);

    // Single use: a replayed code is worthless.
    const replay = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: code.code }),
    });
    expect(replay.status).toBe(403);
  });

  test("wrong codes are refused and burn the window after five tries", async () => {
    const b = startBridge();
    b.offerPairingCode({ code: "654321", expiresAt: Date.now() + 60_000 });
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`http://127.0.0.1:${b.port}/pair`, {
        method: "POST",
        body: JSON.stringify({ code: "000000" }),
      });
      expect(res.status).toBe(401);
    }
    // Sixth attempt closes the window rather than letting a guesser continue.
    const exhausted = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: "000000" }),
    });
    expect(exhausted.status).toBe(429);
  });

  test("parallel guesses share one five-attempt budget", async () => {
    const b = startBridge();
    b.offerPairingCode({ code: "654321", expiresAt: Date.now() + 60_000 });
    const statuses = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const res = await fetch(`http://127.0.0.1:${b.port}/pair`, {
        method: "POST",
        body: JSON.stringify({ code: String(index).padStart(6, "0") }),
      });
      return res.status;
    }));

    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    expect(statuses.filter((status) => status === 403)).toHaveLength(14);
  });

  test("parallel correct redemptions release the token exactly once", async () => {
    const b = startBridge();
    b.offerPairingCode({ code: "123456", expiresAt: Date.now() + 60_000 });
    const responses = await Promise.all(Array.from({ length: 12 }, () =>
      fetch(`http://127.0.0.1:${b.port}/pair`, {
        method: "POST",
        body: JSON.stringify({ code: "123456" }),
      })
    ));
    const bodies = await Promise.all(responses.map((response) => response.text()));

    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(bodies.filter((body) => body.includes(TOKEN))).toHaveLength(1);
  });

  test("an expired code cannot be redeemed", async () => {
    const b = startBridge();
    b.offerPairingCode({ code: "123456", expiresAt: Date.now() - 1 });
    const res = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(403);
  });

  test("with no window open, /pair gives nothing away", async () => {
    const b = startBridge();
    const res = await fetch(`http://127.0.0.1:${b.port}/pair`, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(TOKEN);
  });

  test("codes are six digits and not obviously biased", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { code } = mintPairingCode();
      expect(code).toMatch(/^\d{6}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(190);
  });
});

describe("on-demand replies", () => {
  test("serves a known session's reply, refuses an unknown one", async () => {
    const b = startBridge({
      getState: () => ({ v: 1, rows: [{ id: "known" }] }),
      replyFor: async (id) => `reply for ${id}`,
    });
    const auth = { authorization: `Bearer ${TOKEN}` };

    const ok = await fetch(`http://127.0.0.1:${b.port}/reply?session=known`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { markdown: string }).markdown).toBe("reply for known");

    // Only sessions the dashboard is actually showing — same scope rule as /file.
    const unknown = await fetch(`http://127.0.0.1:${b.port}/reply?session=other`, { headers: auth });
    expect(unknown.status).toBe(404);

    const bare = await fetch(`http://127.0.0.1:${b.port}/reply?session=known`);
    expect(bare.status).toBe(401);
  });
})

describe("client presence", () => {
  test("a dropped send return value evicts; backpressure does not", () => {
    expect(sendPhoneFrame({ send: () => 12 }, "frame")).toBeTrue();
    expect(sendPhoneFrame({ send: () => -1 }, "frame")).toBeTrue();
    expect(sendPhoneFrame({ send: () => 0 }, "frame")).toBeFalse();
    expect(sendPhoneFrame({ send: () => { throw new Error("closed"); } }, "frame"))
      .toBeFalse();
  });

  test("reports connect and disconnect so the Mac can reclaim audio", async () => {
    // A phone that walks out of the room must not leave the Mac permanently
    // silence — the daemon needs to know the moment the last one goes away.
    const counts: number[] = [];
    const b = startBridge({ onClientsChanged: (n: number) => counts.push(n) });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("timed out")), 3000);
    });
    expect(counts).toEqual([1]);
    ws.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    expect(counts).toEqual([1, 0]);
  });

  test("one of multiple clients closing does not release the last-client lease", async () => {
    const counts: number[] = [];
    const b = startBridge({ onClientsChanged: (n: number) => counts.push(n) });
    const connect = (ws: WebSocket) => new Promise<void>((resolve, reject) => {
      ws.onmessage = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("timed out")), 3000);
    });
    const first = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    const second = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    await Promise.all([connect(first), connect(second)]);
    expect(b.clientCount()).toBe(2);
    expect(counts.at(-1)).toBe(2);

    first.close();
    for (let i = 0; i < 20 && b.clientCount() !== 1; i++) await Bun.sleep(20);
    expect(b.clientCount()).toBe(1);
    expect(counts.at(-1)).toBe(1);

    second.close();
    for (let i = 0; i < 20 && b.clientCount() !== 0; i++) await Bun.sleep(20);
    expect(b.clientCount()).toBe(0);
    expect(counts.at(-1)).toBe(0);
  });
});

describe("the audio lease", () => {
  test("stop() reports zero clients so the Mac is never left silent", async () => {
    const counts: number[] = [];
    const b = startBridge({ onClientsChanged: (n: number) => counts.push(n) });
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("timed out")), 3000);
    });
    expect(counts.at(-1)).toBe(1);
    // Turning the bridge off must release the lease; otherwise disabling the
    // phone leaves the Mac silent with nothing left to speak for it.
    b.stop();
    expect(counts.at(-1)).toBe(0);
    bridge = null;
  });

  test("clientCount is the lease's source of truth", async () => {
    const b = startBridge();
    expect(b.clientCount()).toBe(0);
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = () => resolve();
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("timed out")), 3000);
    });
    expect(b.clientCount()).toBe(1);
    ws.close();
    await new Promise<void>((r) => setTimeout(r, 400));
    expect(b.clientCount()).toBe(0);
  });
});

describe("how long the daemon gets to answer", () => {
  // An inject focuses a pane, types, confirms the text landed and re-sends if
  // it did not. On a real send that took "1 re-send", the phone gave up two
  // seconds after the daemon had confirmed delivery — so a message that
  // arrived perfectly reported "couldn't reach your Mac". A false failure is
  // the expensive kind: it teaches you not to trust a send that worked.
  test("an inject gets a budget that matches what it does", () => {
    expect(injectTimeoutFor(JSON.stringify({ type: "inject", text: "hi" })))
      .toBeGreaterThan(20_000);
  });

  test("everything else stays fast, where a quick answer is the point", () => {
    expect(injectTimeoutFor(JSON.stringify({ kind: "audio-sink", sink: "phone" }))).toBe(4_000);
    expect(injectTimeoutFor(JSON.stringify({ type: "pause" }))).toBe(4_000);
  });

  test("a malformed line does not get the long budget by accident", () => {
    expect(injectTimeoutFor("not json")).toBe(4_000);
  });
});

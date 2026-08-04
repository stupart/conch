import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  createPhoneBridge,
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

function startBridge(overrides: Partial<Parameters<typeof createPhoneBridge>[0]> = {}) {
  bridge = createPhoneBridge(
    {
      getState: () => ({ v: 1, rows: [{ id: "r1" }] }),
      forwardControl: async (line) => JSON.stringify({ echoed: JSON.parse(line).kind }),
      replyFor: async () => "",
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

  test("POST /control preserves a daemon's inject confirmation", async () => {
    const confirmation = {
      kind: "inject-result",
      requestId: "phone-send-1",
      delivered: true,
    };
    const b = startBridge({
      forwardControl: async () => JSON.stringify(confirmation),
    });
    const res = await fetch(`http://127.0.0.1:${b.port}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        type: "inject",
        requestId: confirmation.requestId,
        sessionId: "r1",
        label: "target",
        announce: "immutable draft",
      }),
    });

    expect(await res.json()).toEqual(confirmation);
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
    const b = startBridge();
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/ws?token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (event) => {
        frames.push(String(event.data));
        if (frames.length === 2) resolve();
        else b.publish();
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
  test("serves only a path that is currently a review link", async () => {
    const dir = mkdtempSync("/tmp/conch-phone-file-");
    const served = join(dir, "deliverable.txt");
    await Bun.write(served, "the deliverable body");
    const secret = join(dir, "secret.txt");
    await Bun.write(secret, "never served");

    const b = startBridge({
      getState: () => ({
        v: 1,
        rows: [{ id: "r1", review: { link: served, summary: "x" } }],
      }),
    });
    const auth = { authorization: `Bearer ${TOKEN}` };

    const ok = await fetch(
      `http://127.0.0.1:${b.port}/file?path=${encodeURIComponent(served)}`,
      { headers: auth },
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("the deliverable body");

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
    // mute — the daemon needs to know the moment the last one goes away.
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
    // phone leaves the Mac mute with nothing left to speak for it.
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

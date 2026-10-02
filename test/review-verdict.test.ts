import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createControlServer,
  dispatchSocketTurnEvent,
  validateSocketTurnEvent,
  type ControlApplication,
  type ControlServer,
  type SocketTurnEventCallbacks,
} from "../src/control-server.ts";
import type { TurnEvent } from "../src/hook.ts";
import {
  isReviewVerdict,
  publishForVerdict,
  refusedVerdict,
  verdictWithin,
  type ReviewVerdict,
} from "../src/review-verdict.ts";

/**
 * `review_to_front` used to send its publication fire-and-forget and say "accepted" with a version it guessed; the
 * daemon could then refuse it and only log why. Now a publication asks for its verdict and the daemon answers on the
 * same connection: filed (its real id, version and link, and who can see it) or refused (the daemon's reason). These
 * run the wire both ways on real Unix sockets.
 */

const filed: ReviewVerdict = {
  kind: "review-filed",
  filing: { id: "f-1", artifact: "a1b2", version: 3, kind: "image", link: "/store/a1b2/v3-x/hero.png" },
  copiedFrom: "/tmp/hero.png",
  surfaces: { mac: "running", phone: "paired-not-connected", audio: "mac" },
};
const publication = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "review-published", sessionId: "s1", label: "alpha", announce: "alpha has work", eventAt: 1_000,
  review: { summary: "the hero", link: "/tmp/hero.png" }, ...over,
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  // A short /tmp path: a socket path must fit sockaddr_un.
  const root = mkdtempSync("/tmp/conch-verdict-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** A socket that answers each request line with `reply(line)`, or never answers when it returns undefined. */
async function fakeDaemon(reply: (line: string) => string | undefined): Promise<{ path: string; lines: string[] }> {
  const path = join(scratch(), "d.sock");
  const lines: string[] = [];
  const server: Server = createServer((sock) => {
    let data = "";
    sock.on("data", (chunk) => {
      data += chunk.toString();
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      const line = data.slice(0, newline);
      lines.push(line);
      const answer = reply(line);
      if (answer !== undefined) sock.end(answer);
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { path, lines };
}

/** The real control server, with a turn entry that answers publications as `turn` says. */
async function realServer(turn: ControlApplication["turn"], extra: { verdictWaitMs?: number; onMacApp?: () => void } = {}) {
  const socketPath = join(scratch(), "c.sock");
  const application: ControlApplication = {
    configuration: () => ({ kind: "config-error", error: "stub" }),
    session: () => ({ kind: "session-error", error: "stub" }),
    runtime: () => ({ kind: "app-error-ack" }),
    turn,
    device: () => ({ kind: "ack" }) as never,
  };
  const server: ControlServer = createControlServer({
    socketPath, ownerDeviceId: "this-mac", log: () => {},
    sessions: { resolve: (value) => value, current: () => ({ published: true }) },
    application,
    ...extra,
  });
  expect(await server.start()).toBe(true);
  cleanups.push(() => server.close());
  return socketPath;
}

describe("the publisher's side: publishForVerdict", () => {
  test("sends the publication asking for its verdict, and returns the daemon's filing", async () => {
    const daemon = await fakeDaemon(() => `${JSON.stringify(filed)}\n`);
    expect(await publishForVerdict(daemon.path, publication())).toEqual({ kind: "verdict", verdict: filed });
    expect(JSON.parse(daemon.lines[0]!)).toEqual({ ...publication(), awaitVerdict: true });
  });

  test("a refusal comes back with the daemon's own reason, and so does the socket's own check", async () => {
    const refused = refusedVerdict("link /etc/hosts is outside this session's folder");
    expect(await publishForVerdict((await fakeDaemon(() => `${JSON.stringify(refused)}\n`)).path, publication()))
      .toEqual({ kind: "verdict", verdict: refused });
    const malformed = await fakeDaemon(() => `${JSON.stringify({ kind: "session-error", error: "review focus needs a folder link" })}\n`);
    expect(await publishForVerdict(malformed.path, publication())).toEqual({
      kind: "verdict", verdict: { kind: "review-refused", reason: "review focus needs a folder link" },
    });
  });

  test("a daemon from before verdicts acks, and that is taken but unconfirmed, never filed", async () => {
    const reply = await publishForVerdict((await fakeDaemon(() => '{"kind":"ack"}\n')).path, publication());
    expect(reply).toEqual({ kind: "unconfirmed", why: "this conch daemon is older and does not say whether it filed a publication" });
  });

  test("a daemon still filing when its wait ran out, one that never answers, and none at all are each said as they are", async () => {
    expect(await publishForVerdict((await fakeDaemon(() => '{"kind":"review-pending"}\n')).path, publication()))
      .toEqual({ kind: "unconfirmed", why: "the daemon took it and was still filing it when the wait ran out" });
    expect(await publishForVerdict((await fakeDaemon(() => undefined)).path, publication(), 150))
      .toEqual({ kind: "unconfirmed", why: "the daemon took it and did not answer within 150 ms" });
    expect(await publishForVerdict(join(scratch(), "nobody.sock"), publication())).toEqual({ kind: "down" });
  });

  test("a verdict is checked before it is believed: a malformed one is not a filing", () => {
    expect(isReviewVerdict(filed)).toBe(true);
    expect(isReviewVerdict(refusedVerdict("why"))).toBe(true);
    expect(isReviewVerdict({ ...filed, filing: { ...filed.filing, version: 0 } })).toBe(false);
    expect(isReviewVerdict({ ...filed, filing: { ...filed.filing, kind: "hologram" } })).toBe(false);
    expect(isReviewVerdict({ ...filed, surfaces: { mac: "maybe", phone: "off", audio: "mac" } })).toBe(false);
    expect(isReviewVerdict({ kind: "review-refused", reason: "" })).toBe(false);
    expect(isReviewVerdict({ kind: "ack" })).toBe(false);
  });
});

describe("the daemon's side: the control server answers a publication that asks", () => {
  test("with what the filing settled as, on the same connection", async () => {
    const turns: TurnEvent[] = [];
    const socketPath = await realServer((event) => {
      turns.push(event);
      return Promise.resolve(filed);
    });
    expect(await publishForVerdict(socketPath, publication())).toEqual({ kind: "verdict", verdict: filed });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ type: "review-published", awaitVerdict: true, review: { summary: "the hero" } });
  });

  test("a publication that doesn't ask is acked at once, as every turn event is", async () => {
    const socketPath = await realServer(() => Promise.resolve(filed));
    const { connect } = await import("node:net");
    const answer = await new Promise<string>((resolve) => {
      const sock = connect({ path: socketPath });
      let data = "";
      sock.on("connect", () => sock.write(`${JSON.stringify(publication())}\n`));
      sock.on("data", (chunk) => { data += chunk; });
      sock.on("close", () => resolve(data));
    });
    expect(JSON.parse(answer)).toEqual({ kind: "ack" });
  });

  test("a filing that outlives the wait is answered review-pending, and nothing that is not a verdict is passed off as one", async () => {
    const slow = await realServer(() => new Promise(() => {}), { verdictWaitMs: 50 });
    expect(await publishForVerdict(slow, publication())).toEqual({
      kind: "unconfirmed", why: "the daemon took it and was still filing it when the wait ran out",
    });
    // A practice session's own turn answers true: not a verdict, so the publisher hears the plain ack.
    const other = await realServer(() => Promise.resolve(true));
    expect((await publishForVerdict(other, publication())).kind).toBe("unconfirmed");
    expect(await verdictWithin(Promise.resolve(filed), 10)).toEqual(filed);
    expect(await verdictWithin(Promise.reject(new Error("boom")), 10)).toBeUndefined();
    expect(await verdictWithin(new Promise(() => {}), 10)).toEqual({ kind: "review-pending" });
  });

  test("awaitVerdict is for a publication only, and is only ever true", () => {
    expect(validateSocketTurnEvent({ ...publication(), awaitVerdict: true }).ok).toBe(true);
    expect(validateSocketTurnEvent({ ...publication(), awaitVerdict: "yes" })).toEqual({ ok: false, err: "awaitVerdict is true, on review-published only" });
    expect(validateSocketTurnEvent({ type: "turn-end", sessionId: "s1", label: "a", announce: "x", awaitVerdict: true }))
      .toEqual({ ok: false, err: "awaitVerdict is true, on review-published only" });
  });

  test("a publication from a session the user dismissed is refused in words, where it used to vanish", async () => {
    const enqueued: TurnEvent[] = [];
    const callbacks: SocketTurnEventCallbacks = {
      busy: () => false,
      stopSpacebar: () => {},
      setSessionPaused: () => {},
      isDismissedSession: (sessionId) => sessionId === "s1",
      enrichAudioCommand: (event) => event,
      enqueueInstant: () => {},
      enqueue: (event) => void enqueued.push(event),
    };
    expect(await dispatchSocketTurnEvent(publication(), callbacks)).toEqual({
      kind: "review-refused",
      reason: "the user dismissed this session from conch, so nothing it publishes is shown until they restore it",
    });
    // Anything else it sends is still dropped without a word: nobody is waiting on it.
    expect(dispatchSocketTurnEvent({ type: "turn-end", sessionId: "s1", label: "a", announce: "x" }, callbacks)).toBeUndefined();
    expect(enqueued).toEqual([]);
  });

  test("the Mac app's ping and its screen reports are noted as the app being there; a ping from anyone else is only answered", async () => {
    let pings = 0;
    const socketPath = await realServer(() => {}, { onMacApp: () => { pings += 1; } });
    const { connect } = await import("node:net");
    const ask = (body: unknown) => new Promise<unknown>((resolve) => {
      const sock = connect({ path: socketPath });
      let data = "";
      sock.on("connect", () => sock.write(`${JSON.stringify(body)}\n`));
      sock.on("data", (chunk) => { data += chunk; });
      sock.on("close", () => resolve(JSON.parse(data)));
    });
    expect(await ask({ kind: "ping", from: "mac-app" })).toMatchObject({ kind: "pong" });
    // An app from before `from` sends it bare: still the app, the only thing that pinged.
    expect(await ask({ kind: "ping" })).toMatchObject({ kind: "pong" });
    expect(await ask({ kind: "ping", from: "probe" })).toMatchObject({ kind: "pong" });
    expect(pings).toBe(2);
    // A screen report is the app's alone (the phone bridge won't forward one): a valid one says it is there too.
    const observation = { v: 1, source: "front-window", at: Date.now(), surface: { kind: "unknown" } };
    expect(await ask({ kind: "screen-observation", observation })).toMatchObject({ kind: "screen-error" });
    expect(pings).toBe(3);
    expect(await ask({ kind: "screen-observation", observation: { ...observation, source: "nobody" } })).toMatchObject({ kind: "screen-error" });
    expect(pings).toBe(3);
  });
});

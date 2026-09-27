import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import { decodeNarrationRequest } from "../src/narration.ts";
import {
  createPhoneBridgeApplication,
  forwardToDaemonSocket,
  isMacAppOnlyRequest,
  MAC_APP_ONLY_DECODERS,
  MAC_APP_ONLY_KINDS,
} from "../src/phone-bridge.ts";
import { decodePracticeRequest, PRACTICE_REQUEST_KINDS } from "../src/practice.ts";
import { decodeSetupRequest, SETUP_REQUEST_KINDS } from "../src/setup.ts";

// D1 (review 2026-09-28): the phone's /control forwarded setup's and the practice's requests to the daemon, so a paired
// phone could run an agent's installer (`curl … | bash`) on the Mac, rewrite `~/.claude/settings.json`, or stop a
// practice the Mac was running. Every request the control server takes before resolving a session is either the phone's
// to send or the Mac app's alone; this file holds each one to one side, so a new one can't be left on neither.

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

/** The control server's dispatch, from the ping answer to the first session resolution: every branch that names no session. */
function earlyDispatch(): string {
  const server = source("src/control-server.ts");
  const start = server.indexOf('body.kind === "ping"');
  const end = server.indexOf("const value = await sessions.resolve(body);");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return server.slice(start, end);
}

/** What the phone may send through that part of the dispatch: a liveness ping, the envelope, history reads, the audio's handoffs. */
const PHONE_MAY_SEND = { decoders: new Set(["decodeAudioCommand"]), kinds: new Set(["ping", "control-envelope", "history-page", "history-item"]) };

/** Narration's kinds, read from its decoder: the literals it compares `kind` with. */
function narrationKinds(): string[] {
  const narration = source("src/narration.ts");
  const decoder = narration.slice(narration.indexOf("export function decodeNarrationRequest"), narration.indexOf("return { kind, canvasId };"));
  const kinds = [...decoder.matchAll(/kind !== "([^"]+)"/g)].map((match) => match[1]!);
  expect(kinds.length).toBeGreaterThan(0);
  return kinds;
}

const CANVAS = "0f3c1a2b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/** Every Mac-app-only request, each as its sender would shape it and as a malformed one: a refusal can't depend on the fields. */
function macOnlyBodies(): Array<{ kind: string; body: Record<string, unknown> }> {
  const shaped: Record<string, Record<string, unknown>> = {
    "setup-status": {},
    "setup-connect": { agent: "claude" },
    "setup-install": { agent: "codex", via: "brew" },
    "voice-sample": { voice: "heart" },
    "mic-check": { seconds: 10 },
    "setup-retry": { what: "speech" },
    "narration-start": { canvasId: CANVAS },
    "narration-stop": { canvasId: CANVAS },
    "narration-cancel": { canvasId: CANVAS },
    "screen-observation": { observation: {} },
    "review-preview": { request: "r", path: "/tmp/x.png" },
  };
  const kinds = [...SETUP_REQUEST_KINDS, ...PRACTICE_REQUEST_KINDS, ...narrationKinds(), ...MAC_APP_ONLY_KINDS];
  return kinds.flatMap((kind) => [
    { kind, body: { kind, ...(shaped[kind] ?? {}) } },
    { kind, body: { kind, agent: "gemini", seconds: -1, voice: "", what: "everything", canvasId: "nope" } },
    { kind, body: { kind: "control-envelope", body: { kind, ...(shaped[kind] ?? {}) } } },
  ]);
}

describe("every request the control server takes before a session is one side's or the other's", () => {
  test("each decoder and kind in the early dispatch is the phone's, or on the phone bridge's Mac-only list", () => {
    const dispatch = earlyDispatch();
    const decoders = new Set([...dispatch.matchAll(/\b(decode\w+)\(body\)/g)].map((match) => match[1]!));
    const kinds = new Set([...dispatch.matchAll(/body\.kind === "([^"]+)"/g)].map((match) => match[1]!));
    // Whatever is added to this part of the dispatch has to be put on one side here, or this fails.
    for (const decoder of decoders) {
      expect(PHONE_MAY_SEND.decoders.has(decoder) || decoder in MAC_APP_ONLY_DECODERS, `${decoder}: the phone's, or Mac-only?`).toBe(true);
    }
    for (const kind of kinds) {
      expect(PHONE_MAY_SEND.kinds.has(kind) || MAC_APP_ONLY_KINDS.has(kind), `${kind}: the phone's, or Mac-only?`).toBe(true);
    }
    // And the Mac-only list names nothing the dispatch doesn't have: it is the dispatch's own list.
    expect(new Set(Object.keys(MAC_APP_ONLY_DECODERS))).toEqual(new Set([...decoders].filter((decoder) => !PHONE_MAY_SEND.decoders.has(decoder))));
    expect(new Set(MAC_APP_ONLY_KINDS)).toEqual(new Set([...kinds].filter((kind) => !PHONE_MAY_SEND.kinds.has(kind))));
  });

  test("the Mac-only decoders are the ones the control server dispatches setup, the practice and narration with", () => {
    expect(MAC_APP_ONLY_DECODERS.decodeSetupRequest).toBe(decodeSetupRequest);
    expect(MAC_APP_ONLY_DECODERS.decodePracticeRequest).toBe(decodePracticeRequest);
    expect(MAC_APP_ONLY_DECODERS.decodeNarrationRequest).toBe(decodeNarrationRequest);
    // Each kind derived from a decoder is one that decoder takes.
    for (const kind of SETUP_REQUEST_KINDS) expect(decodeSetupRequest({ kind }), kind).not.toBeNull();
    for (const kind of PRACTICE_REQUEST_KINDS) expect(decodePracticeRequest({ kind }), kind).not.toBeNull();
    for (const kind of narrationKinds()) expect(decodeNarrationRequest({ kind }), kind).not.toBeNull();
  });

  test("every Mac-only request is recognised, shaped or not, bare or in an envelope; the phone's own are not", () => {
    for (const { kind, body } of macOnlyBodies()) expect(isMacAppOnlyRequest(body), `${kind} ${JSON.stringify(body)}`).toBe(true);
    for (const body of [
      { type: "pause", sessionId: "", label: "", announce: "" },
      { type: "inject", sessionId: "s", label: "a", announce: "hi" },
      { kind: "audio-take" },
      { kind: "history-page", sessionId: "s" },
      { kind: "phone-device" },
      { kind: "control-envelope", body: { type: "resume", sessionId: "", label: "", announce: "" } },
      null, "setup-install", [{ kind: "setup-install" }],
    ]) {
      expect(isMacAppOnlyRequest(body), JSON.stringify(body)).toBe(false);
    }
  });
});

describe("the phone's /control refuses them all, and forwards nothing", () => {
  const TOKEN = "t0ken-t0ken-t0ken-t0ken-t0ken";
  function bridge(forwardControl: (line: string) => Promise<string>) {
    return createPhoneBridgeApplication({
      getState: () => ({ v: 1, rows: [] }),
      forwardControl,
      replyFor: async () => "",
      acceptUpload: async () => ({ error: "no" }),
      log: () => {},
    }, { token: TOKEN });
  }
  const post = (body: unknown) => new Request("https://conch.invalid/control", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  test("403 with why for each, and the daemon never asked", async () => {
    const forwarded: string[] = [];
    const app = bridge(async (line) => { forwarded.push(line); return JSON.stringify({ kind: "ack" }); });
    const bodies = macOnlyBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(3 * 14);
    for (const { kind, body } of bodies) {
      const response = await app.handle(post(body))!;
      expect(response.status, `${kind} ${JSON.stringify(body)}`).toBe(403);
      expect(await response.json()).toEqual({ error: "only the Mac app sends that" });
    }
    expect(forwarded).toEqual([]);
    // The phone's own controls still go through.
    const pause = await app.handle(post({ type: "pause", sessionId: "", label: "", announce: "" }))!;
    expect(pause.status).toBe(200);
    expect(forwarded.map((line) => JSON.parse(line).type)).toEqual(["pause"]);
  });

  describe("through to a real control server", () => {
    const servers: ControlServer[] = [];
    const dirs: string[] = [];
    afterEach(async () => {
      for (const server of servers.splice(0)) await server.close();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    test("setup, the practice and narration are never reached from the phone; the Mac app's socket still reaches them", async () => {
      // A short private path: a Unix socket's is capped near 104 bytes, and this is nowhere near conch's own socket.
      const dir = mkdtempSync("/tmp/conch-mac-only-");
      dirs.push(dir);
      const socketPath = join(dir, "c.sock");
      const reached: string[] = [];
      const server = createControlServer({
        socketPath,
        ownerDeviceId: "this-mac",
        log: () => {},
        sessions: { resolve: (value) => value, current: () => ({ published: true, label: "a" }) },
        application: {
          configuration: () => ({ kind: "config-error", error: "stub" }),
          session: () => ({ kind: "session-error", error: "stub" }),
          runtime: () => ({ kind: "session-error", error: "stub" }),
          turn: () => {},
          device: () => ({ kind: "ack" }),
        },
        setup: {
          noteTurn: () => {},
          status: async () => [],
          handle: async (request: { kind: string }) => { reached.push(request.kind); return { kind: "setup-ack", retried: false }; },
          close: () => {},
        },
        practice: {
          handle: async (request: { kind: string }) => { reached.push(request.kind); return { kind: "practice-stopped", removed: false }; },
        } as never,
        narration: {
          start: async (canvasId: string) => { reached.push("narration-start"); return { kind: "narration-error", error: canvasId }; },
          stop: async (canvasId: string) => { reached.push("narration-stop"); return { kind: "narration-error", error: canvasId }; },
          cancel: async (canvasId: string) => { reached.push("narration-cancel"); return { kind: "narration-error", error: canvasId }; },
        } as never,
        onScreenObservation: () => { reached.push("screen-observation"); },
        onReviewPreview: async () => { reached.push("review-preview"); return { ok: true }; },
      });
      servers.push(server);
      expect(await server.start()).toBe(true);
      const app = bridge((line) => forwardToDaemonSocket(socketPath, line));
      for (const { kind, body } of macOnlyBodies()) {
        expect((await app.handle(post(body))!).status, kind).toBe(403);
      }
      expect(reached).toEqual([]);
      // The same socket, asked directly as the Mac app asks it: setup answers. The refusal is the phone bridge's.
      await forwardToDaemonSocket(socketPath, JSON.stringify({ kind: "setup-status" }));
      expect(reached).toEqual(["setup-status"]);
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createControlServer,
  type ControlApplication,
  type ControlEnvelope,
  type ControlServer,
  type ControlServerOptions,
  type LocalControlSessions,
  type RoutingRefusal,
} from "../src/control-server.ts";
import type { SessionControlResponse } from "../src/settings.ts";
import { loadDeviceId } from "../src/device-identity.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label = "socket response"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const fixtures: Array<{ root: string; servers: ControlServer[]; clients: Socket[] }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const client of f.clients) client.destroy();
    for (const server of f.servers) await within(server.close(), "server close");
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function fixture(overrides: {
  application?: Partial<ControlApplication>;
  sessions?: Partial<LocalControlSessions>;
  stale?: boolean;
  persistentIdentity?: boolean;
} = {}) {
  // A short /tmp path also fits Darwin's sockaddr_un limit.
  const root = mkdtempSync("/tmp/conch-control-");
  const socketPath = join(root, "control.sock");
  const calls: { [K in keyof ControlApplication]: Array<Parameters<ControlApplication[K]>[0]> } = {
    configuration: [], session: [], runtime: [], turn: [], device: [],
  };
  const reads: { resolve: unknown[]; current: string[] } = { resolve: [], current: [] };
  const logs: string[] = [];
  const application: ControlApplication = {
    configuration(message) {
      calls.configuration.push(message);
      return { kind: "config-error", error: "stub configuration" };
    },
    session(message) {
      calls.session.push(message);
      return { kind: "session-error", error: "stub session" };
    },
    runtime(message) {
      calls.runtime.push(message);
      return { kind: "app-error-ack" };
    },
    turn(event) { calls.turn.push(event); },
    device(message) {
      calls.device.push(message);
      return { kind: "ack" };
    },
    ...overrides.application,
  };
  const sessions: LocalControlSessions = {
    resolve(value) { reads.resolve.push(value); return value; },
    current(sessionId) {
      reads.current.push(sessionId);
      return { published: true, label: "canonical", cwd: "/local", pid: 42, transcriptPath: "/local/turn.jsonl" };
    },
    ...overrides.sessions,
  };
  const options: ControlServerOptions = {
    socketPath,
    ownerDeviceId: overrides.persistentIdentity ? await loadDeviceId(root) : "this-mac",
    log: (line) => logs.push(line), sessions, application,
  };
  if (overrides.stale) writeFileSync(socketPath, "leftover");
  const server = createControlServer(options);
  const cleanup = { root, servers: [server], clients: [] as Socket[] };
  fixtures.push(cleanup);
  expect(await server.start()).toBe(true);

  async function peer(options: { endOnReply?: boolean } = {}) {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    cleanup.clients.push(socket);
    const ready = deferred<void>();
    const finished = deferred<string>();
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.once("connect", () => ready.resolve());
    socket.once("end", () => {
      finished.resolve(data);
      if (options.endOnReply !== false) socket.end();
    });
    socket.on("error", () => {}); // oversized frames may reset the peer
    socket.once("close", () => finished.resolve(data));
    await within(ready.promise, "connect");
    return { socket, done: finished.promise };
  }
  async function request(value: unknown) {
    const p = await peer();
    p.socket.write(JSON.stringify(value) + "\n");
    return within(p.done);
  }
  return { ...cleanup, socketPath, options, server, calls, reads, logs, application, sessions, peer, request };
}

const inject = {
  type: "inject", sessionId: "local-key", label: "caller label", announce: " deliver this ",
  cwd: "/untrusted", pid: 999, transcriptPath: "/untrusted/file", eventAt: 1,
};

describe("control server over a real Unix socket", () => {
  test("persisted owner envelopes survive a server restart and foreign owners never read local state", async () => {
    const f = await fixture({ persistentIdentity: true });
    const learnedId = f.options.ownerDeviceId;
    for (let boot = 0; boot < 2; boot += 1) {
      if (boot === 1) {
        await f.server.close();
        const ownerDeviceId = await loadDeviceId(f.root);
        expect(ownerDeviceId).toBe(learnedId);
        const restarted = createControlServer({ ...f.options, ownerDeviceId });
        f.servers.push(restarted);
        expect(await restarted.start()).toBe(true);
      }
      for (const ownerDeviceId of [undefined, learnedId]) {
        expect(await f.request({ kind: "control-envelope", ownerDeviceId, body: inject })).toBe("");
      }
      expect(f.calls.turn).toHaveLength((boot + 1) * 2);
      const beforeReads = structuredClone(f.reads);
      const beforeCalls = structuredClone(f.calls);
      const refusal: RoutingRefusal = JSON.parse(await f.request({
        kind: "control-envelope", ownerDeviceId: "foreign-device", body: inject,
      }));
      expect(refusal).toMatchObject({ kind: "routing-error", code: "foreign-owner" });
      expect(f.reads).toEqual(beforeReads);
      expect(f.calls).toEqual(beforeCalls);
    }
  });

  test("newline framing waits for a complete line and ignores a second line in the frame", async () => {
    const f = await fixture();
    const p = await f.peer();
    p.socket.write('{"kind":"get-');
    await Bun.sleep(25);
    expect(f.reads.resolve).toEqual([]);
    p.socket.write('config"}\n{"kind":"system-woke"}\n');
    expect(await within(p.done)).toBe('{"kind":"config-error","error":"stub configuration"}\n');
    expect(f.calls.configuration).toEqual([{ kind: "get-config" }]);
    expect(f.calls.device).toEqual([]);
    expect(f.reads.resolve).toHaveLength(1);
  });

  test("append-before-cap destroys an oversized frame even when its final chunk contains newline", async () => {
    const f = await fixture();
    const p = await f.peer({ endOnReply: false });
    const json = JSON.stringify({ kind: "get-config" });
    const frame = json + " ".repeat(64_000 - json.length) + "\n";
    expect(frame.length).toBe(64_001);
    p.socket.write(frame);
    expect(await within(p.done)).toBe("");
    // The server destroyed its side rather than leaving an open half-connection.
    expect(p.socket.writableEnded).toBe(false);
    // Bun 1.4 emits `end` after `destroy()`. The EOF handler used to parse and
    // dispatch the refused frame from there, so an oversized mutation reached
    // the application with no acknowledgement (A16). Refused means refused.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.calls.configuration).toHaveLength(0);
    await within(f.server.close(), "destroyed connection to close");
  });

  test("a frame of exactly 64_000 characters including newline is accepted", async () => {
    const f = await fixture();
    const p = await f.peer();
    const json = JSON.stringify({ kind: "get-config" });
    const frame = json + " ".repeat(63_999 - json.length) + "\n";
    expect(frame.length).toBe(64_000);
    p.socket.write(frame);
    expect(JSON.parse(await within(p.done)).kind).toBe("config-error");
    expect(f.calls.configuration).toHaveLength(1);
  });

  test("one handled request ignores later data while its runtime result is pending", async () => {
    const entered = deferred<void>();
    const result = deferred<SessionControlResponse>();
    const f = await fixture();
    f.application.runtime = (message) => {
      f.calls.runtime.push(message);
      entered.resolve();
      return result.promise;
    };
    try {
      const p = await f.peer();
      p.socket.write('{"kind":"resumable"}\n');
      await within(entered.promise, "runtime entry");
      p.socket.write('{"kind":"get-config"}\n' + "x".repeat(64_001));
      await Bun.sleep(25);
      result.resolve({ kind: "app-error-ack" });
      expect(await within(p.done)).toBe('{"kind":"app-error-ack"}\n');
      expect(f.calls.runtime).toEqual([{ kind: "resumable" }]);
      expect(f.calls.configuration).toEqual([]);
      expect(f.reads.resolve).toHaveLength(1);
    } finally {
      result.resolve({ kind: "app-error-ack" });
    }
  });

  test("a newline request gets a reply without the client closing its write half", async () => {
    const f = await fixture();
    const p = await f.peer();
    p.socket.write('{"kind":"get-config"}\n');
    expect(p.socket.writableEnded).toBe(false);
    expect(JSON.parse(await within(p.done)).kind).toBe("config-error");
    expect(f.calls.configuration).toHaveLength(1);
  });

  test("EOF handles a trimmed request and preserves a delayed reply after the client half-closes", async () => {
    const entered = deferred<void>();
    const result = deferred<SessionControlResponse>();
    const f = await fixture();
    f.application.runtime = (message) => {
      f.calls.runtime.push(message);
      entered.resolve();
      return result.promise;
    };
    try {
      const p = await f.peer();
      p.socket.end('  {"kind":"resumable"}  ');
      await within(entered.promise, "EOF dispatch");
      await Bun.sleep(25);
      result.resolve({ kind: "resumable", sessions: [], complete: true });
      expect(await within(p.done)).toBe('{"kind":"resumable","sessions":[],"complete":true}\n');
      expect(f.calls.runtime).toEqual([{ kind: "resumable" }]);
    } finally {
      result.resolve({ kind: "app-error-ack" });
    }
  });

  test.each(["", "  \t "])("empty or whitespace EOF closes without dispatch: %j", async (frame) => {
    const f = await fixture();
    const p = await f.peer();
    p.socket.end(frame);
    expect(await within(p.done)).toBe("");
    expect(f.reads.resolve).toEqual([]);
    expect(Object.values(f.calls).flat()).toEqual([]);
  });

  test("accepted turn is delivered synchronously and replies empty without awaiting completion", async () => {
    const completion = deferred<void>();
    const f = await fixture();
    const synchronous: number[] = [];
    const current = f.sessions.current;
    f.sessions.current = (id) => {
      // Any deferred delivery runs after this checkpoint, even a microtask.
      queueMicrotask(() => synchronous.push(f.calls.turn.length));
      return current(id);
    };
    f.application.turn = (event) => {
      f.calls.turn.push(event);
      // A void consumer must ignore even an accidentally returned work promise.
      return completion.promise;
    };
    try {
      expect(await f.request(inject)).toBe("");
      expect(synchronous).toEqual([1]);
      expect(f.calls.turn).toHaveLength(1);
      expect(f.calls.turn[0]).toMatchObject({
        type: "inject", sessionId: "local-key", label: "canonical", announce: "deliver this",
        cwd: "/local", pid: 42, transcriptPath: "/local/turn.jsonl",
      });
      expect(f.calls.turn[0]!.eventAt).toBeGreaterThan(1);
    } finally {
      completion.resolve();
    }
  });

  test.each([
    inject, { kind: "get-config" }, { type: "pause" },
    { kind: "session-start", backend: "claude" }, { kind: "audio-sink", sink: "phone" },
  ])("foreign-owner envelope is refused before any local reader or application entry: %j", async (body) => {
    const f = await fixture();
    const envelope: ControlEnvelope = { kind: "control-envelope", ownerDeviceId: "other-mac", body };
    const reply: RoutingRefusal = JSON.parse(await f.request(envelope));
    expect(reply).toEqual({
      kind: "routing-error", code: "foreign-owner", ownerDeviceId: "other-mac",
      error: "this daemon cannot route to a foreign owner",
    });
    expect(f.reads).toEqual({ resolve: [], current: [] });
    expect(Object.values(f.calls).flat()).toEqual([]);
  });

  test.each([undefined, "this-mac"])("local envelope preserves the legacy body: owner %j", async (ownerDeviceId) => {
    const f = await fixture();
    const body = { kind: "get-config" } as const;
    expect(await f.request({ kind: "control-envelope", ownerDeviceId, body })).toBe(await f.request(body));
    expect(f.reads.resolve).toEqual([body, body]);
    expect(f.calls.configuration).toEqual([body, body]);
    expect(f.reads.current).toEqual([]);
  });

  test("configuration, session, runtime, turn and device are decoded before their five entries", async () => {
    const f = await fixture();
    expect(JSON.parse(await f.request({ kind: "set-config", key: "read-full", value: true, extra: 1 })).kind).toBe("config-error");
    expect(JSON.parse(await f.request({ kind: "session-command", sessionId: " local ", command: "dismiss", extra: 1 })).kind).toBe("session-error");
    expect(JSON.parse(await f.request({ kind: "resumable", query: "  project ", extra: 1 })).kind).toBe("app-error-ack");
    expect(await f.request({ type: "pause" })).toBe("");
    expect(JSON.parse(await f.request({ kind: "system-woke", extra: 1 })).kind).toBe("ack");
    expect(f.calls).toEqual({
      configuration: [{ kind: "set-config", key: "read-full", value: true }],
      session: [{ kind: "session-command", sessionId: "local", command: "dismiss" }],
      runtime: [{ kind: "resumable", query: "project" }],
      turn: [{ type: "pause", sessionId: "", label: "", announce: "" }],
      device: [{ kind: "system-woke" }],
    });
    expect(f.reads.current).toEqual([]);
  });

  test("local resolution precedes classification and canonical inject lookup", async () => {
    const f = await fixture();
    f.sessions.resolve = (value) => {
      f.reads.resolve.push(value);
      return { ...(value as object), sessionId: "window-key" };
    };
    await f.request(inject);
    expect(f.reads.current).toEqual(["window-key"]);
    expect(f.calls.turn[0]!.sessionId).toBe("window-key");
    await f.request({ kind: "session-command", sessionId: "agent-id", command: "dismiss" });
    expect(f.calls.session[0]!.sessionId).toBe("window-key");
  });

  test("malformed and unpublished requests never reach the application", async () => {
    const f = await fixture({ sessions: { current: () => ({ published: false }) } });
    for (const body of [inject, { ...inject, announce: "" }, { kind: "session-command", command: "bogus" }, { kind: "session-start", backend: "bogus" }]) {
      expect(JSON.parse(await f.request(body)).kind).toBe("session-error");
    }
    expect(JSON.parse(await f.request({ kind: "set-config", key: "bogus" })).kind).toBe("config-error");
    expect(await f.request({ type: "bogus" })).toBe("");
    const p = await f.peer();
    p.socket.end("not json");
    expect(await within(p.done)).toBe("");
    expect(Object.values(f.calls).flat()).toEqual([]);
  });

  test("auxiliary device coercions remain permissive and labels remain presentation", async () => {
    const f = await fixture();
    for (const body of [
      { kind: "audio-sink", sink: { bad: true } }, { kind: "audio-sink", sink: "phone" },
      { kind: "phone-spoke", reason: 7, text: "x".repeat(65) },
      { kind: "phone-speaking", speaking: "true", label: 7, session: { ownerDeviceId: "foreign", localSessionKey: "ignored" } },
      { kind: "phone-speaking", speaking: true, label: "l".repeat(130) },
      { kind: "phone-device", footprintMB: "12.7", battery: 0.515, batteryState: false, uptime: "121", freeGB: 2, lowPower: true, thermal: "nominal" },
      { kind: "phone-device", footprintMB: "nonsense", freeGB: "2", lowPower: "true" },
      { kind: "open-pairing" },
    ]) expect(await f.request(body)).toBe('{"kind":"ack"}\n');
    expect(f.calls.device).toEqual([
      { kind: "audio-sink", sink: "mac" }, { kind: "audio-sink", sink: "phone" },
      { kind: "phone-spoke", reason: "unknown", text: "x".repeat(60) },
      { kind: "phone-speaking", speaking: false, label: "" },
      { kind: "phone-speaking", speaking: true, label: "l".repeat(120) },
      { kind: "phone-device", summary: "phone: 13MB · battery 52% false · 2.0GB free · up 2m · LOW POWER MODE, ONLY 2.0GB FREE" },
      { kind: "phone-device", summary: "phone: NaNMB · battery unknown · up 0m · thermal undefined" },
      { kind: "open-pairing" },
    ]);
    expect(f.reads.current).toEqual([]);
  });

  test("close releases the path so a second start binds and handles requests", async () => {
    const f = await fixture();
    await f.server.close();
    expect(existsSync(f.socketPath)).toBe(false);
    const second = createControlServer(f.options);
    f.servers.push(second);
    expect(await second.start()).toBe(true);
    expect(JSON.parse(await f.request({ kind: "get-config" })).kind).toBe("config-error");
    // Closing the old handle twice must never unlink the new listener.
    await f.server.close();
    expect(existsSync(f.socketPath)).toBe(true);
    await second.close();
    expect(await f.server.start()).toBe(true);
    expect(await f.request({ type: "pause" })).toBe("");
  });

  test("start replaces a stale path, makes it private, and respects a live owner", async () => {
    const f = await fixture({ stale: true });
    expect(statSync(f.socketPath).isSocket()).toBe(true);
    expect(statSync(f.socketPath).mode & 0o777).toBe(0o600);
    const second = createControlServer(f.options);
    f.servers.push(second);
    expect(await second.start()).toBe(false);
    await second.close();
    expect(existsSync(f.socketPath)).toBe(true);
    expect(JSON.parse(await f.request({ kind: "get-config" })).kind).toBe("config-error");
  });
});

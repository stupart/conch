import { afterEach, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createControlServer,
  decodeAudioCommand,
  type ControlServer,
  type DeviceCommand,
} from "../src/control-server.ts";

const fixtures: Array<{ root: string; server: ControlServer; clients: Socket[] }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    for (const client of f.clients) client.destroy();
    await f.server.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = mkdtempSync("/tmp/conch-audio-");
  const socketPath = join(root, "control.sock");
  const device: DeviceCommand[] = [];
  const resolved: unknown[] = [];
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "this-mac",
    log: () => {},
    sessions: {
      resolve(value) { resolved.push(value); return value; },
      current: () => ({ published: false }),
    },
    application: {
      configuration: () => ({ kind: "config-error", error: "stub" }),
      session: () => ({ kind: "session-error", error: "stub" }),
      runtime: () => ({ kind: "app-error-ack" }),
      turn: () => {},
      device(message) {
        device.push(message);
        return { kind: "audio-ack", revision: 7, stopped: message.kind === "audio-yield" };
      },
    },
  });
  const f = { root, server, clients: [] as Socket[], device, resolved };
  fixtures.push(f);
  expect(await server.start()).toBe(true);
  async function request(value: unknown): Promise<string> {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    f.clients.push(socket);
    socket.on("error", () => {});
    let data = "";
    const done = new Promise<string>((resolve) => {
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.once("end", () => { resolve(data); socket.end(); });
      socket.once("close", () => resolve(data));
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(JSON.stringify(value) + "\n");
    const timer = setTimeout(() => socket.destroy(), 1_000);
    try { return await done; } finally { clearTimeout(timer); }
  }
  return { ...f, request };
}

const present = {
  kind: "audio-present", source: "mac-b", seq: 41, text: " finished the build ", voice: "af_heart",
  label: "conch", host: "studio.local", at: 1_700_000_000_000,
  session: { ownerDeviceId: "mac-b", localSessionKey: "same-key#123" },
};

describe("Cut B audio commands over a real Unix socket", () => {
  test("the four commands reach the device entry inside this daemon's envelope, before any session resolution", async () => {
    const f = await fixture();
    const commands = [
      { kind: "audio-take" },
      { kind: "audio-yield", holder: "mac-a", revision: 3, leaseMs: 90_000 },
      { kind: "audio-release" },
      present,
    ];
    const replies: unknown[] = [];
    for (const body of commands) {
      replies.push(JSON.parse(await f.request({ kind: "control-envelope", ownerDeviceId: "this-mac", body })));
    }
    expect(f.device).toEqual([
      { kind: "audio-take" },
      { kind: "audio-yield", holder: "mac-a", revision: 3, leaseMs: 90_000 },
      { kind: "audio-release" },
      {
        kind: "audio-present",
        item: {
          source: "mac-b", seq: 41, text: "finished the build", voice: "af_heart", label: "conch",
          host: "studio.local", at: 1_700_000_000_000, session: { ownerDeviceId: "mac-b", localSessionKey: "same-key#123" },
        },
      },
    ]);
    expect(replies).toEqual([
      { kind: "audio-ack", revision: 7, stopped: false },
      { kind: "audio-ack", revision: 7, stopped: true },
      { kind: "audio-ack", revision: 7, stopped: false },
      { kind: "audio-ack", revision: 7, stopped: false },
    ]);
    // Decoded BEFORE session resolution: nothing consulted the local address book.
    expect(f.resolved).toEqual([]);
    // Unwrapped, from this Mac's own app, is the same entry.
    expect(JSON.parse(await f.request({ kind: "audio-take" }))).toEqual({ kind: "audio-ack", revision: 7, stopped: false });
    expect(f.device).toHaveLength(5);
  });

  test("a foreign envelope is refused with no device call and no local read", async () => {
    const f = await fixture();
    const refusal = JSON.parse(await f.request({
      kind: "control-envelope", ownerDeviceId: "other-mac",
      body: { kind: "audio-yield", holder: "mac-a", revision: 3, leaseMs: 90_000 },
    }));
    expect(refusal).toMatchObject({ kind: "routing-error", code: "foreign-owner" });
    expect(f.device).toEqual([]);
    expect(f.resolved).toEqual([]);
  });

  test("a malformed audio command is refused as invalid rather than coerced into a grant", async () => {
    const f = await fixture();
    for (const body of [
      { kind: "audio-yield", holder: "local", revision: 3, leaseMs: 90_000 },
      { kind: "audio-yield", holder: "mac-a", revision: "3", leaseMs: 90_000 },
      { kind: "audio-yield", holder: "mac-a", revision: -1, leaseMs: 90_000 },
      { kind: "audio-yield", holder: "mac-a", revision: 3, leaseMs: 0 },
      { kind: "audio-present", source: "mac-b", seq: 1, text: "", at: 1, session: {} },
      { kind: "audio-present", source: "", seq: 1, text: "x", at: 1, session: {} },
    ]) {
      expect(JSON.parse(await f.request(body))).toMatchObject({ kind: "audio-error", code: "invalid" });
    }
    expect(f.device).toEqual([]);
    expect(f.resolved).toEqual([]);
  });

  test("decoding leaves every other kind to the legacy path", () => {
    expect(decodeAudioCommand({ kind: "audio-sink", sink: "phone" })).toBeNull();
    expect(decodeAudioCommand({ type: "wake" })).toBeNull();
    expect(decodeAudioCommand("audio-take")).toBeNull();
  });
});

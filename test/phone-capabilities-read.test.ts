import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer } from "../src/control-server.ts";
import {
  createPhoneBridgeApplication,
  forwardToDaemonSocket,
  isPhoneCapabilitiesRead,
  isPhoneRead,
  PHONE_READ_REPLY_MAX_BYTES,
} from "../src/phone-bridge.ts";

/**
 * A session's capabilities, read from the phone (2026-11-06). Tyler: "can you add my skills to / slash commands on the
 * mobile and mac app". A Claude session here reads 240 KB of skills, plugins and tools; the bridge took the daemon's
 * reply only up to a control frame (64 KiB) and the relay kept a POST's reply only up to the same, so every read from the
 * phone failed and its typeahead, Commands sheet and inspector had none of the person's skills. The Mac app reads up to
 * 1 MiB, so it had them all along.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

const read = { kind: "agent-capabilities", backend: "claude", cwd: "", sessionId: "session-1" };
const reply = JSON.stringify({ kind: "agent-capabilities", inventory: { entities: [], padding: "s".repeat(240_000) } });
const bytes = (body: unknown) => Buffer.from(JSON.stringify(body));

test("a capabilities read is told apart by its route and its validated body", () => {
  expect(isPhoneCapabilitiesRead("/control", bytes(read))).toBe(true);
  expect(isPhoneCapabilitiesRead("/control?source=phone", bytes({ kind: "control-envelope", ownerDeviceId: "o", body: read }))).toBe(true);
  expect(isPhoneRead("/control", bytes(read))).toBe(true);
  expect(isPhoneRead("/control", bytes({ kind: "history-page", session: "archived" }))).toBe(true);
  for (const [path, body] of [
    ["/history/page", read],
    ["/image", read],
    ["/control", { ...read, backend: "gemini" }],
    ["/control", { ...read, sessionId: undefined }],
    ["/control", { type: "inject", sessionId: "s", text: "/hillclimb-ui" }],
    ["/control", { kind: "session-start", backend: "claude", cwd: "/tmp" }],
  ] as const) {
    expect(isPhoneCapabilitiesRead(path, bytes(body))).toBe(false);
  }
  expect(isPhoneRead("/control", bytes({ type: "interrupt", sessionId: "s" }))).toBe(false);
});

test("the daemon's whole reply comes through the bridge's forwarder only when asked to take it", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-capabilities-read-"));
  const path = join(root, "control.sock");
  const server = createControlServer({ socketPath: path, ownerDeviceId: "owner", log() {},
    sessions: { resolve: (body) => body, current: () => ({ published: false }) },
    application: {
      configuration: () => ({ kind: "config-error", error: "unused" }), session: () => ({ kind: "session-error", error: "unused" }),
      runtime: () => JSON.parse(reply), turn() {}, device: () => ({ kind: "ack" }),
    },
  });
  cleanups.push(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  expect(await server.start()).toBe(true);

  // What the phone got before: the frame cap.
  await expect(forwardToDaemonSocket(path, JSON.stringify(read))).rejects.toThrow("exceeds 64 KiB");
  expect(await forwardToDaemonSocket(path, JSON.stringify(read), 4000, PHONE_READ_REPLY_MAX_BYTES)).toBe(reply);
  // Still a ceiling: a reply past it fails as one, rather than holding on to it.
  await expect(forwardToDaemonSocket(path, JSON.stringify(read), 4000, 128 * 1024)).rejects.toThrow("exceeds 128 KiB");
});

test("over the LAN, the bridge asks for the larger reply for a capabilities read and nothing else", async () => {
  const asked: [string, number | undefined][] = [];
  const app = createPhoneBridgeApplication({
    getState: () => ({ rows: [] }),
    forwardControl: async (line, options) => {
      asked.push([JSON.parse(line).kind ?? JSON.parse(line).type, options?.maxReplyBytes]);
      return line.includes("agent-capabilities") ? reply : JSON.stringify({ kind: "ack" });
    },
    replyFor: async () => "", acceptUpload: async () => ({ received: 1, total: 1 }), log() {},
  }, { token: "fixture-token" });
  const post = (body: unknown) => app.handle(new Request("http://fixture/control", {
    method: "POST", headers: { authorization: "Bearer fixture-token" }, body: JSON.stringify(body),
  }));

  const response = (await post(read))!;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(reply);
  expect((await post({ type: "interrupt", sessionId: "s" }))!.status).toBe(200);
  expect(asked).toEqual([["agent-capabilities", PHONE_READ_REPLY_MAX_BYTES], ["interrupt", undefined]]);
});

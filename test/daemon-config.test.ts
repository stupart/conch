import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  createConfigController,
  dispatchControlMessage,
  resolveWakeTarget,
  shouldHandleTurnAudibly,
  startsConversationByListening,
  TurnEventOrder,
} from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";
import { unsetSetting, writeSetting } from "../src/settings.ts";

const roots: string[] = [];

function fixture(settings: Record<string, unknown> = {}): { path: string } {
  const root = mkdtempSync(join(tmpdir(), "conch-daemon-config-test-"));
  roots.push(root);
  const path = join(root, "settings.json");
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return { path };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon config controller", () => {
  test("an untargeted wake after turn-end starts by listening without re-reading", () => {
    const wake: TurnEvent = { type: "wake", sessionId: "", label: "", announce: "" };
    const turnEnd: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: finished response",
      transcriptPath: "/tmp/alpha.jsonl",
      mark: 3,
    };

    const resolved = resolveWakeTarget(wake, turnEnd);

    expect(resolved).toEqual({ ...turnEnd, type: "wake" });
    expect(resolved).not.toBe(turnEnd);
    expect(startsConversationByListening(resolved!)).toBe(true);
    expect(startsConversationByListening(turnEnd)).toBe(false);
  });

  test("an explicitly targeted wake wins over lastTurn and an empty wake stays empty", () => {
    const targeted: TurnEvent = {
      type: "wake",
      sessionId: "session-b",
      label: "beta",
      announce: "",
      transcriptPath: "/tmp/beta.jsonl",
    };
    const lastTurn: TurnEvent = {
      type: "turn-end",
      sessionId: "session-a",
      label: "alpha",
      announce: "alpha: done",
    };

    expect(resolveWakeTarget(targeted, lastTurn)).toEqual(targeted);
    expect(resolveWakeTarget({ ...targeted, sessionId: "", label: "" }, null)).toBeNull();
  });

  test("working-mic only makes Stop-reclassified working events audible", () => {
    const turnEnd = { type: "turn-end" as const };
    const submitted = { type: "working" as const };
    const background = { type: "working" as const, backgroundWork: true as const };

    expect(shouldHandleTurnAudibly(turnEnd, false)).toBe(true);
    expect(shouldHandleTurnAudibly(background, false)).toBe(false);
    expect(shouldHandleTurnAudibly(background, true)).toBe(true);
    expect(shouldHandleTurnAudibly(submitted, true)).toBe(false);
  });

  test("event-time arbitration suppresses stale state and working-mic audio before LIFO handling", () => {
    const order = new TurnEventOrder();
    const newerTurnEnd = { type: "turn-end" as const, sessionId: "session", eventAt: 2_000 };
    const olderWorking = { type: "working" as const, sessionId: "session", eventAt: 1_000 };

    expect(order.accept(newerTurnEnd)).toBe(true);
    expect(order.accept(olderWorking)).toBe(false);
    expect(order.isCurrent(newerTurnEnd)).toBe(true);
    expect(order.isCurrent(olderWorking) && shouldHandleTurnAudibly({ ...olderWorking, backgroundWork: true }, true))
      .toBe(false);
  });

  test("a newer same-type event invalidates its older queued predecessor", () => {
    const order = new TurnEventOrder();
    const older = { type: "working" as const, sessionId: "session", eventAt: 1_000 };
    const newer = { type: "working" as const, sessionId: "session", eventAt: 2_000 };

    expect(order.accept(older)).toBe(true);
    expect(order.accept(newer)).toBe(true);
    expect(order.isCurrent(older)).toBe(false);
    expect(order.isCurrent(newer)).toBe(true);
    expect(order.accept({ ...older })).toBe(false); // delayed older hook cannot evict newer
  });

  test("an untimestamped legacy state cannot supersede timestamped truth", () => {
    const order = new TurnEventOrder();
    const timestamped = { type: "turn-end" as const, sessionId: "session", eventAt: 2_000 };
    expect(order.accept(timestamped)).toBe(true);
    expect(order.accept({ type: "working", sessionId: "session" })).toBe(false);
  });

  test("applies a live set by mutating the shared Config object in place", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const shared = cfg;
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "end-silence", 5.25);

    const reply = controller.handle({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    });

    expect(cfg).toBe(shared);
    expect(cfg.endSilenceSecs).toBe(5.25);
    expect(reply).toMatchObject({
      kind: "config-ack",
      key: "end-silence",
      action: "set",
      status: "applied",
      effective: 5.25,
      source: "file",
    });
  });

  test("applies and unsets working-mic live", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    expect(cfg.workingMic).toBe(false);

    writeSetting(path, "working-mic", true);
    const setReply = controller.handle({
      kind: "set-config",
      key: "working-mic",
      value: true,
    });

    expect(cfg.workingMic).toBe(true);
    expect(setReply).toMatchObject({
      kind: "config-ack",
      key: "working-mic",
      status: "applied",
      effective: true,
      source: "file",
    });

    unsetSetting(path, "working-mic");
    const unsetReply = controller.handle({ kind: "unset-config", key: "working-mic" });

    expect(cfg.workingMic).toBe(false);
    expect(unsetReply).toMatchObject({
      kind: "config-ack",
      key: "working-mic",
      action: "unset",
      status: "applied",
      effective: false,
      source: "default",
    });
  });

  test("applies and unsets interrupt-on-manual-reply live", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    expect(cfg.interruptOnManualReply).toBe(true);

    writeSetting(path, "interrupt-on-manual-reply", false);
    const setReply = controller.handle({
      kind: "set-config",
      key: "interrupt-on-manual-reply",
      value: false,
    });

    expect(cfg.interruptOnManualReply).toBe(false);
    expect(setReply).toMatchObject({
      kind: "config-ack",
      key: "interrupt-on-manual-reply",
      status: "applied",
      effective: false,
      source: "file",
    });

    unsetSetting(path, "interrupt-on-manual-reply");
    const unsetReply = controller.handle({ kind: "unset-config", key: "interrupt-on-manual-reply" });

    expect(cfg.interruptOnManualReply).toBe(true);
    expect(unsetReply).toMatchObject({
      kind: "config-ack",
      key: "interrupt-on-manual-reply",
      action: "unset",
      status: "applied",
      effective: true,
      source: "default",
    });
  });

  test("reports an env-masked set and retains the daemon's env value", () => {
    const { path } = fixture();
    const env = { CONCH_END_SILENCE_SECS: "7" };
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "end-silence", 5.25);

    const reply = controller.handle({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    });

    expect(cfg.endSilenceSecs).toBe(7);
    expect(reply).toMatchObject({
      kind: "config-ack",
      status: "masked",
      effective: 7,
      source: "env",
      env: "CONCH_END_SILENCE_SECS",
    });
  });

  test("skips an invalid daemon env and applies the valid saved value with a diagnostic", () => {
    const { path } = fixture();
    const env = { CONCH_END_SILENCE_SECS: "not-a-number" };
    const cfg = loadConfig({ env, settingsPath: path });
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "end-silence", 5.25);

    const reply = controller.handle({
      kind: "set-config",
      key: "end-silence",
      value: 5.25,
    });

    expect(cfg.endSilenceSecs).toBe(5.25);
    expect(reply).toMatchObject({
      kind: "config-ack",
      status: "applied",
      effective: 5.25,
      source: "file",
    });
    expect(reply.diagnostic).toContain("CONCH_END_SILENCE_SECS");
  });

  test("does not mutate hook-only fields and labels them for the next hook", () => {
    const { path } = fixture();
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    expect(cfg.speakSentences).toBe(2);
    const controller = createConfigController(cfg, { env, settingsPath: path });
    writeSetting(path, "announce-sentences", 5);

    const reply = controller.handle({
      kind: "set-config",
      key: "announce-sentences",
      value: 5,
    });

    expect(cfg.speakSentences).toBe(2);
    expect(reply).toMatchObject({
      kind: "config-ack",
      status: "hook-next",
      effective: 5,
      source: "file",
    });
    expect(reply.diagnostic).toContain("next hook");
  });

  test("unset re-resolves a live field to env or default", () => {
    const { path } = fixture({ "end-silence": 5.25 });
    const env = {};
    const cfg = loadConfig({ env, settingsPath: path });
    expect(cfg.endSilenceSecs).toBe(5.25);
    const controller = createConfigController(cfg, { env, settingsPath: path });
    unsetSetting(path, "end-silence");

    const reply = controller.handle({
      kind: "unset-config",
      key: "end-silence",
    });

    expect(cfg.endSilenceSecs).toBe(3.5);
    expect(reply).toMatchObject({
      kind: "config-ack",
      action: "unset",
      status: "applied",
      effective: 3.5,
      source: "default",
    });
  });

  test("snapshot uses daemon truth for live keys and file truth with a caveat for hook keys", () => {
    const { path } = fixture({
      "end-silence": 5.25,
      "announce-sentences": 4,
    });
    const env = { CONCH_SPEAK_SENTENCES: "9" };
    const cfg = loadConfig({ env, settingsPath: path });
    cfg.endSilenceSecs = 6.5; // prove live snapshot comes from current memory

    const reply = createConfigController(cfg, { env, settingsPath: path }).handle({ kind: "get-config" });
    expect(reply.kind).toBe("config-snapshot");
    if (reply.kind !== "config-snapshot") throw new Error("expected config snapshot");
    expect(reply.snapshot["end-silence"]).toMatchObject({ value: 6.5 });
    expect(reply.snapshot["announce-sentences"]).toMatchObject({ value: 4, source: "file" });
    expect(reply.snapshot["announce-sentences"].diagnostic).toContain("next hook");
    expect(reply.snapshot["announce-sentences"].diagnostic).toContain("CONCH_SPEAK_SENTENCES");
  });

  test("socket-boundary dispatch handles control candidates before TurnEvent traffic", () => {
    const { path } = fixture();
    const cfg = loadConfig({ env: {}, settingsPath: path });
    const controller = createConfigController(cfg, { env: {}, settingsPath: path });

    expect(dispatchControlMessage({
      type: "mute",
      sessionId: "",
      label: "",
      announce: "",
    }, controller)).toEqual({ handled: false });
    expect(dispatchControlMessage({
      kind: "set-config",
      key: "barge-threshold",
      value: 101,
    }, controller)).toMatchObject({
      handled: true,
      response: { kind: "config-error" },
    });
  });
});

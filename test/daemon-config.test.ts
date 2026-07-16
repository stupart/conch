import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createConfigController, dispatchControlMessage } from "../src/daemon.ts";
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

import { describe, expect, test } from "bun:test";
import { SettingsOverlay, type SettingsOverlayConfigController } from "../src/settings-overlay.ts";
import {
  SETTING_DESCRIPTORS,
  type ConfigAck,
  type ConfigControlMessage,
  type ConfigControlResponse,
  type ConfigSnapshot,
  type SettingKey,
} from "../src/settings.ts";

function snapshot(): ConfigSnapshot {
  const value = Object.create(null) as ConfigSnapshot;
  for (const descriptor of SETTING_DESCRIPTORS) {
    value[descriptor.key] = { value: descriptor.default, source: "default" };
  }
  return value;
}

class FakeController implements SettingsOverlayConfigController {
  requests: ConfigControlMessage[] = [];
  readonly order: string[];
  readonly reply?: (message: Extract<ConfigControlMessage, { kind: "set-config" }>) => ConfigAck;

  constructor(
    order: string[] = [],
    reply?: (message: Extract<ConfigControlMessage, { kind: "set-config" }>) => ConfigAck,
  ) {
    this.order = order;
    this.reply = reply;
  }

  handle(message: ConfigControlMessage): ConfigControlResponse {
    this.requests.push(message);
    if (message.kind === "get-config") return { kind: "config-snapshot", snapshot: snapshot() };
    if (message.kind === "unset-config") return { kind: "config-error", error: "not used" };
    this.order.push(`apply:${message.key}`);
    return this.reply?.(message) ?? {
      kind: "config-ack",
      key: message.key,
      action: "set",
      status: "applied",
      effective: message.value,
      source: "file",
    };
  }
}

function moveTo(overlay: SettingsOverlay, key: SettingKey): void {
  for (let count = 0; count < SETTING_DESCRIPTORS.length; count++) {
    const model = overlay.model()!;
    if (model.rows[model.selectedIndex]?.key === key) return;
    overlay.handleKey("\x1b[B");
  }
  throw new Error(`could not select ${key}`);
}

describe("SettingsOverlay", () => {
  test("loads controller provenance and traps keys until Escape", () => {
    const controller = new FakeController();
    const overlay = new SettingsOverlay({
      controller,
      settingsPath: "/tmp/settings.json",
      persist() {},
      onChange() {},
    });

    expect(overlay.handleKey("m")).toBe(false);
    overlay.open();
    expect(overlay.model()?.rows[0]).toMatchObject({
      key: "end-silence",
      value: "3.5",
      source: "default",
      selected: true,
    });
    expect(overlay.model()?.rows[0]?.help.length).toBeGreaterThan(0);
    expect(overlay.handleKey("m")).toBe(true);
    expect(overlay.handleKey("q")).toBe(true);
    expect(overlay.handleKey("\u0003")).toBe(false);
    expect(overlay.handleKey("\x1b")).toBe(true);
    expect(overlay.handleKey("m")).toBe(false);
  });

  test("persists before live-applying a boolean toggle", () => {
    const order: string[] = [];
    const controller = new FakeController(order);
    const persisted: Array<{ key: unknown; value: unknown }> = [];
    const overlay = new SettingsOverlay({
      controller,
      settingsPath: "/tmp/settings.json",
      persist(_path, key, value) {
        order.push(`persist:${key}`);
        persisted.push({ key, value });
      },
      onChange() {},
    });
    overlay.open();
    moveTo(overlay, "read-full");

    expect(overlay.handleKey(" ")).toBe(true);
    expect(order).toEqual(["persist:read-full", "apply:read-full"]);
    expect(persisted).toEqual([{ key: "read-full", value: false }]);
    expect(controller.requests.at(-1)).toEqual({ kind: "set-config", key: "read-full", value: false });
    expect(overlay.model()?.rows.find((row) => row.key === "read-full")).toMatchObject({
      value: "false",
      source: "file",
      ack: "applied",
    });
  });

  test("cycles enums and rejects out-of-bounds typed numbers through descriptor.parse", () => {
    const persisted: unknown[] = [];
    const controller = new FakeController();
    const overlay = new SettingsOverlay({
      controller,
      settingsPath: "/tmp/settings.json",
      persist(_path, key, value) { persisted.push([key, value]); },
      onChange() {},
    });
    overlay.open();
    overlay.handleKey("0");
    overlay.handleKey("\r");
    expect(persisted).toEqual([]);
    expect(overlay.model()?.rows[0]?.ack).toContain("greater than 0");

    moveTo(overlay, "handoff-order");
    overlay.handleKey("\x1b[C");
    expect(persisted).toEqual([["handoff-order", "urgency"]]);
    expect(controller.requests.at(-1)).toEqual({
      kind: "set-config",
      key: "handoff-order",
      value: "urgency",
    });
  });

  test("shows masked and next-hook acknowledgements, and never applies after a failed write", () => {
    const controller = new FakeController([], (message) => message.key === "announce-sentences"
      ? {
        kind: "config-ack",
        key: message.key,
        action: "set",
        status: "hook-next",
        effective: message.value,
        source: "file",
      }
      : {
        kind: "config-ack",
        key: message.key,
        action: "set",
        status: "masked",
        effective: 9,
        source: "env",
        env: "CONCH_END_SILENCE_SECS",
      });
    let failWrites = false;
    const overlay = new SettingsOverlay({
      controller,
      settingsPath: "/tmp/settings.json",
      persist() {
        if (failWrites) throw new Error("read-only");
      },
      onChange() {},
    });
    overlay.open();
    overlay.handleKey("\x1b[C");
    expect(overlay.model()?.rows[0]).toMatchObject({
      value: "9",
      source: "env",
      ack: "masked-by-env CONCH_END_SILENCE_SECS",
    });

    moveTo(overlay, "announce-sentences");
    overlay.handleKey("\x1b[C");
    expect(overlay.model()?.rows.find((row) => row.key === "announce-sentences")?.ack).toBe("next hook");

    failWrites = true;
    const appliedBefore = controller.requests.filter((request) => request.kind === "set-config").length;
    overlay.handleKey("\x1b[C");
    const appliedAfter = controller.requests.filter((request) => request.kind === "set-config").length;
    expect(appliedAfter).toBe(appliedBefore);
    expect(overlay.model()?.rows.find((row) => row.key === "announce-sentences")?.ack).toContain("not saved");
  });
});

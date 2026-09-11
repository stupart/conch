import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StartSessionRequest } from "../src/session-lifecycle.ts";
import { SessionStartOverlay } from "../src/session-start-overlay.ts";

const ESC = String.fromCharCode(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;
const ENTER = String.fromCharCode(13);
const BACKSPACE = String.fromCharCode(127);

/** An opened overlay whose starts are recorded, with the persisted bypass setting as given. */
function overlayWith(persisted: () => boolean = () => false) {
  const starts: StartSessionRequest[] = [];
  const overlay = new SessionStartOverlay({
    controller: { start: async (request) => { starts.push(request); } },
    defaultCwd: "/w",
    bypassDefault: persisted,
    onChange() {},
  });
  overlay.open();
  const press = (...keys: string[]) => { for (const key of keys) overlay.handleKey(key); };
  const row = (key: string) => overlay.model()?.rows.find((candidate) => candidate.key === key);
  const keys = () => overlay.model()?.rows.map((candidate) => candidate.key);
  const select = (key: string) => {
    for (let step = 0; step < 20; step++) {
      const model = overlay.model()!;
      if (model.rows[model.selectedIndex]?.key === key) return;
      press(DOWN);
    }
    throw new Error(`no row ${key}`);
  };
  return { overlay, starts, press, row, keys, select };
}

describe("SessionStartOverlay", () => {
  test("chooses an agent and working folder before starting a fresh session", async () => {
    const starts: unknown[] = [];
    const lifecycle: string[] = [];
    const overlay = new SessionStartOverlay({
      controller: { start: async (request) => { starts.push(request); } },
      defaultCwd: "/Users/tyler",
      bypassDefault: () => false,
      onOpen: () => lifecycle.push("open"),
      onClose: () => lifecycle.push("close"),
      onChange() {},
    });
    overlay.open();
    overlay.handleKey(RIGHT);
    expect(overlay.model()?.rows[0]?.value).toBe("codex");
    overlay.handleKey(DOWN);
    overlay.handleKey(ENTER);
    for (let index = 0; index < "/Users/tyler".length; index++) overlay.handleKey(BACKSPACE);
    overlay.handleKey("/Users/tyler/conch");
    overlay.handleKey(ENTER);
    // Up twice: past the agent, wrapping to Start below the options.
    overlay.handleKey(UP);
    overlay.handleKey(UP);
    overlay.handleKey(ENTER);
    expect(overlay.model()?.starting).toBeTrue();
    await Bun.sleep(0);

    expect(starts).toEqual([{ backend: "codex", cwd: "/Users/tyler/conch", options: { "bypass-permissions": false } }]);
    expect(overlay.isOpen()).toBeFalse();
    expect(lifecycle).toEqual(["open", "close"]);
  });

  test("a launch failure stays visible and the modal traps global keys", async () => {
    const overlay = new SessionStartOverlay({
      controller: { start: async () => { throw new Error("Terminal unavailable"); } },
      defaultCwd: "/tmp",
      bypassDefault: () => false,
      onChange() {},
    });
    expect(overlay.handleKey("q")).toBeFalse();
    overlay.open();
    expect(overlay.handleKey("q")).toBeTrue();
    overlay.handleKey(UP);
    overlay.handleKey(ENTER);
    await Bun.sleep(0);
    expect(overlay.model()?.error).toBe("Terminal unavailable");
    expect(overlay.isOpen()).toBeTrue();
  });
});

describe("SessionStartOverlay start options (C1)", () => {
  test("offers exactly the chosen agent's fresh-start options, bypass seeded from the setting at each open", () => {
    let persisted = true;
    const { overlay, press, row, keys } = overlayWith(() => persisted);
    // No --fork-session: it applies only to a resume, and this overlay only starts fresh.
    expect(keys()).toEqual(["backend", "cwd", "model", "permission-mode", "bypass-permissions", "effort", "start"]);
    expect(row("bypass-permissions")?.value).toBe("on");
    expect(row("permission-mode")?.value).toBe("default");
    press(RIGHT);
    expect(keys()).toEqual(["backend", "cwd", "model", "sandbox", "ask-for-approval", "bypass-permissions", "profile", "start"]);

    overlay.close();
    persisted = false;
    overlay.open();
    expect(row("backend")?.value).toBe("claude");
    expect(row("bypass-permissions")?.value).toBe("off");
  });

  test("cycles an enum, toggles a bool, edits a string, and sends exactly those", async () => {
    const { starts, press, row, select } = overlayWith(() => true);
    select("model");
    press(ENTER, "opus", ENTER);
    expect(row("model")?.value).toBe("opus");
    select("permission-mode");
    press(RIGHT, RIGHT);
    expect(row("permission-mode")?.value).toBe("auto");
    select("bypass-permissions");
    press(ENTER);
    expect(row("bypass-permissions")?.value).toBe("off");
    select("effort");
    // Left from the default wraps to the last choice; right from there is the default again.
    press(LEFT);
    expect(row("effort")?.value).toBe("max");
    press(RIGHT);
    expect(row("effort")?.value).toBe("default");
    press(LEFT);
    select("start");
    press(ENTER);
    await Bun.sleep(0);

    expect(starts).toEqual([{
      backend: "claude",
      cwd: "/w",
      options: { model: "opus", "permission-mode": "auto", "bypass-permissions": false, effort: "max" },
    }]);
  });

  test("a refused value stays in the overlay in the CLI's words, and nothing leaves", async () => {
    const { overlay, starts, press, row, select } = overlayWith();
    select("model");
    press(ENTER, "opus 4", ENTER);
    select("start");
    press(ENTER);
    await Bun.sleep(0);
    expect(starts).toEqual([]);
    expect(overlay.isOpen()).toBeTrue();
    expect(overlay.model()?.starting).toBeFalse();
    expect(overlay.model()?.error).toStartWith("--model must be letters, digits");
    expect(overlay.model()?.error).toContain("Model for the current session.");

    // Emptied, the field is the agent's default again and is not sent.
    select("model");
    press(ENTER, ..."opus 4".split("").map(() => BACKSPACE), ENTER);
    expect(row("model")?.value).toBe("default");
    select("start");
    press(ENTER);
    await Bun.sleep(0);
    expect(starts).toEqual([{ backend: "claude", cwd: "/w", options: { "bypass-permissions": false } }]);
  });

  test("switching agent sends only the new agent's options", async () => {
    const { starts, press, select } = overlayWith(() => true);
    select("effort");
    press(LEFT);
    select("backend");
    press(RIGHT);
    select("start");
    press(ENTER);
    await Bun.sleep(0);
    expect(starts).toEqual([{ backend: "codex", cwd: "/w", options: { "bypass-permissions": true } }]);
  });

  test("the dashboard seeds the overlay from the persisted setting", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    const from = daemon.indexOf("sessionStartOverlay = new SessionStartOverlay({");
    expect(from).toBeGreaterThan(-1);
    const end = daemon.indexOf("terminalComposer = new TerminalComposer({", from);
    expect(end).toBeGreaterThan(from);
    expect(daemon.slice(from, end)).toContain("bypassDefault: () => cfg.bypassPermissions");
  });
});

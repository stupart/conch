import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionHostFor } from "../src/daemon.ts";
import { applyRuntimeControlMessage, type RuntimeControlDispatchOptions } from "../src/control-server.ts";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";
import { loadConfig } from "../src/config.ts";
import { validateControlMessage, validateControlResponse } from "../src/settings.ts";

// Where a new session runs: a Terminal window (today's behaviour, and the default) or conch's own tmux ("In conch").

const hosted = { tmux: "/opt/homebrew/bin/tmux", socket: "/private/tmp/tmux-501/conch", session: "claude-conch-7k2f", pane: "%3" };

describe("where a start runs", () => {
  test("what it asks for; else the run-in-conch setting; a teleport always in Terminal", () => {
    expect(sessionHostFor({}, false)).toBe("terminal");
    expect(sessionHostFor({}, true)).toBe("conch");
    expect(sessionHostFor({ host: "conch" }, false)).toBe("conch");
    expect(sessionHostFor({ host: "terminal" }, true)).toBe("terminal");
    expect(sessionHostFor({ host: "conch", teleportSessionId: "abc" }, true)).toBe("terminal");
  });

  test("run-in-conch ships off, so nothing changes until Tyler turns it on", () => {
    const root = process.env.CONCH_TEST_ROOT!;
    const cfg = loadConfig({ env: {}, settingsPath: join(root, "no-such-settings.json") });
    expect(cfg.runInConch).toBe(false);
    expect(loadConfig({ env: { CONCH_RUN_IN_CONCH: "1" }, settingsPath: join(root, "no-such-settings.json") }).runInConch).toBe(true);
  });

  test("the wire carries it, and refuses anything else", () => {
    for (const host of ["terminal", "conch"]) {
      const parsed = validateControlMessage({ kind: "session-start", backend: "claude", host });
      expect(parsed).toEqual({ ok: true, value: { kind: "session-start", backend: "claude", host } });
    }
    expect(validateControlMessage({ kind: "session-start", backend: "claude" }))
      .toEqual({ ok: true, value: { kind: "session-start", backend: "claude" } });
    expect(validateControlMessage({ kind: "session-start", backend: "claude", host: "iterm" }).ok).toBe(false);
    expect(validateControlMessage({ kind: "session-start", backend: "claude", host: "conch", teleportSessionId: "abc", cwd: "/p" }).ok).toBe(false);
  });

  test("the reply says where it runs, and where in conch's tmux, only in shapes conch makes", () => {
    const reply = { kind: "session-started", backend: "claude", resumed: false, host: "conch", hosted };
    expect(validateControlResponse(reply)).toEqual({ ok: true, value: reply });
    for (const bad of [
      { ...hosted, session: "a;b" },
      { ...hosted, pane: "3" },
      { ...hosted, socket: "conch" },
      { ...hosted, tmux: "tmux" },
    ]) {
      expect(validateControlResponse({ ...reply, hosted: bad })).toEqual({
        ok: true,
        value: { kind: "session-started", backend: "claude", resumed: false, host: "conch" },
      });
    }
  });

  test("the dispatcher hands the start's answer back to the app", async () => {
    const started: unknown[] = [];
    const options = {
      listResumable: () => ({ sessions: [], complete: true }),
      start: async (message: unknown) => { started.push(message); return { host: "conch" as const, hosted }; },
      close: () => {},
      report: () => {},
    } as unknown as RuntimeControlDispatchOptions;
    const reply = await applyRuntimeControlMessage({ kind: "session-start", backend: "claude", cwd: "/p", host: "conch" }, options);
    expect(reply).toEqual({ kind: "session-started", backend: "claude", resumed: false, host: "conch", hosted });
    expect(started).toEqual([{ kind: "session-start", backend: "claude", cwd: "/p", host: "conch" }]);
  });
});

describe("a hosted session on the wire", () => {
  test("its row says so, with where to attach; every other row doesn't", () => {
    const model = buildPanelModel({
      sessions: [
        { sessionId: "in-conch", name: "In conch", pid: 5000 },
        { sessionId: "in-terminal", name: "In Terminal", pid: 6000 },
      ],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      hostedBySessionId: new Map([["in-conch", hosted]]),
    });
    expect(model.rows.find((row) => row.sessionId === "in-conch")?.hosted).toEqual(hosted);
    expect(model.rows.find((row) => row.sessionId === "in-terminal")?.hosted).toBeUndefined();
    const published = buildPublishedState("device", model, new Map(), new Set(), 1);
    expect(published.rows.find((row) => row.id === "in-conch")?.hosted).toEqual(hosted);
    expect(published.rows.find((row) => row.id === "in-terminal")).not.toHaveProperty("hosted");
  });
});

describe("the daemon's wiring, as source", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
  const between = (from: string, to: string) => {
    const at = daemon.indexOf(from);
    expect(at, from).toBeGreaterThan(-1);
    return daemon.slice(at, daemon.indexOf(to, at));
  };

  test("the app's start and the terminal's start both ask the setting at start time", () => {
    expect(between("start: async (message) =>", "folderTrusted:")).toContain("host: sessionHostFor(message, cfg.runInConch),");
    expect(between("sessionStartOverlay = new SessionStartOverlay({", "defaultCwd:"))
      .toContain("host: sessionHostFor(request, cfg.runInConch)");
  });

  test("a hosted start goes to conch's tmux; everything else to Terminal, as before", () => {
    const launch = between("async function launchSession(", "\n}\n");
    expect(launch).toContain('if (request.host === "conch") {');
    expect(launch).toContain("const hosted = await startHostedSession(request);");
    expect(launch.indexOf("startHostedSession(")).toBeLessThan(launch.indexOf("startTerminalSession("));
  });

  test("the rows publish what conch hosts, read from tmux on every build (cached), adopted again after a restart", () => {
    expect(daemon).toContain("const hostedTerminals = new HostedTerminalCache(defaultHostedReadDeps());");
    expect(between('breadcrumb("panel: sessions conch hosts");', 'breadcrumb("panel: context usage')).toContain("await hostedTerminals.refresh(live);");
    expect(between("const model = buildPanelModel({", "});")).toContain("hostedBySessionId,");
  });

  test("Open in Terminal on a hosted row attaches a Terminal window to the same tmux session", () => {
    const attach = between("    attach: (target) => {", "    setSettings:");
    expect(attach).toContain("const hosted = hostedTerminals.get(target.sessionId);");
    expect(attach).toContain("return attachHostedInTerminal(hosted, session?.cwd)");
    expect(attach.indexOf("attachHostedInTerminal(")).toBeLessThan(attach.indexOf("if (!session?.jobId)"));
  });
});

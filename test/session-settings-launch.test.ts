import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";
import { restartRequest, startRequestFromArgv, startOptionsError, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { AGENT_SESSION_SETTINGS, type SessionSettingsCatalog } from "../src/session-settings.ts";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("a new session gets model and effort only when the person picked them", () => {
  test("no pick, no flag: the agent's own config decides", () => {
    for (const backend of ["claude", "codex"] as const) {
      const command = terminalSessionCommand({ backend, cwd: "/w" });
      expect(command).toBe(`cd -- '/w' && exec ${backend}`);
      expect(command).not.toMatch(/--model|--effort|model=|model_reasoning_effort/);
      // Other choices do not bring a model along with them.
      const withSandbox = terminalSessionCommand({ backend, cwd: "/w", options: backend === "codex" ? { sandbox: "read-only" } : { "permission-mode": "plan" } });
      expect(withSandbox).not.toMatch(/--model|--effort|model=|model_reasoning_effort/);
    }
  });

  test("Claude: --model and --effort, as its --help spells them", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w", options: { model: "fable", effort: "max" } }))
      .toBe("cd -- '/w' && exec claude --model 'fable' --effort 'max'");
  });

  test("Codex: -c overrides for this launch, never --model and never config.toml", () => {
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", options: { model: "gpt-6-luna", "reasoning-effort": "max" } }))
      .toBe(`cd -- '/w' && exec codex -c 'model="gpt-6-luna"' -c 'model_reasoning_effort="max"'`);
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", options: { "reasoning-effort": "xhigh" } }))
      .toBe(`cd -- '/w' && exec codex -c 'model_reasoning_effort="xhigh"'`);
    // After `resume <id>`, like every other option.
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", resumeSessionId: "t1", options: { model: "gpt-6-sol" } }))
      .toBe(`cd -- '/w' && exec codex resume 't1' -c 'model="gpt-6-sol"'`);
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", options: { model: "gpt-6-sol" } })).not.toContain("--model");
  });

  test("a value that could break out of the override is refused before anything runs", () => {
    for (const model of ['gpt"; rm -rf ~', "gpt 6", "-c", "a'b", "x=y"]) {
      expect(startOptionsError({ backend: "codex", options: { model } })).toBeDefined();
      expect(() => terminalSessionCommand({ backend: "codex", cwd: "/w", options: { model } })).toThrow();
    }
    expect(startOptionsError({ backend: "codex", options: { "reasoning-effort": "turbo" } }))
      .toContain('"turbo" is not one of none, minimal, low, medium, high, xhigh, max, ultra, persistent');
    expect(startOptionsError({ backend: "claude", options: { effort: "ultra" } })).toContain('"ultra" is not one of low, medium, high, xhigh, max');
  });

  test("conch start takes them by name", () => {
    expect(startRequestFromArgv(["codex", "--model", "gpt-6-luna", "--reasoning-effort", "high"]))
      .toEqual({ backend: "codex", options: { model: "gpt-6-luna", "reasoning-effort": "high" } });
  });

  test("a restart carries a picked model and effort over, and nothing else from -c", () => {
    const session = { sessionId: "t1", backend: "codex" as const, cwd: "/w" };
    const { request, notCarriedOver } = restartRequest(session, [
      "-c", 'projects."/w".trust_level="trusted"', "-c", 'model="gpt-6-luna"', "--config", 'model_reasoning_effort="max"',
      // `ps` splits on whitespace, so a value with a space arrives in two pieces.
      "-c", 'model="bad', 'value"', "--sandbox", "read-only",
    ]);
    expect(request.options).toEqual({ "bypass-permissions": false, model: "gpt-6-luna", "reasoning-effort": "max", sandbox: "read-only" });
    expect(notCarriedOver).toEqual(['-c projects."/w".trust_level="trusted"', '-c model="bad']);
    // What it renders is what it started with.
    expect(terminalSessionCommand(request)).toBe(
      `cd -- '/w' && exec codex resume 't1' -c 'model="gpt-6-luna"' -c 'model_reasoning_effort="max"' --sandbox 'read-only'`,
    );
    expect(restartRequest({ sessionId: "s1", backend: "claude", cwd: "/w" }, ["--model", "fable", "--effort", "max"]).request.options)
      .toEqual({ "bypass-permissions": false, model: "fable", effort: "max" });
  });

  test("each setting in the typed list names a real start option of its agent", () => {
    for (const [backend, agent] of Object.entries(AGENT_SESSION_SETTINGS)) {
      const table = backend === "codex"
        ? ["model", "reasoning-effort", "sandbox", "ask-for-approval", "bypass-permissions", "profile"]
        : ["model", "permission-mode", "bypass-permissions", "effort", "fork-session"];
      for (const setting of agent.settings) expect(table).toContain(setting.startOption);
      expect(agent.settings.map((setting) => setting.key)).toEqual(["model", "effort"]);
    }
  });
});

describe("what the published state carries", () => {
  const catalog: SessionSettingsCatalog = {
    claude: { settings: [{ key: "model", label: "Model", readFrom: "t" }], models: [{ id: "opus", label: "Opus" }], efforts: ["high"], defaults: { model: "opus" } },
    codex: { settings: [], models: [{ id: "gpt-6-astra", label: "GPT-6-Astra" }], efforts: [], defaults: {} },
  };
  const model = buildPanelModel({
    sessions: [
      { sessionId: "c1", name: "Claude one", backend: "claude", status: "idle", statusUpdatedAt: 10 },
      { sessionId: "x1", name: "Codex one", backend: "codex", status: "idle", statusUpdatedAt: 20 },
      { sessionId: "agent-1", name: "helper", backend: "claude", parentSessionId: "c1", status: "busy", statusUpdatedAt: 30 },
    ],
    sessionStates: new Map(),
    pausedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
    now: 100,
  });

  test("each session's settings on its row, the catalog beside them, and the feature flag", () => {
    const asked: Array<[string, string]> = [];
    const published = buildPublishedState("device", model, new Map(), new Set(), 100, {
      sessionSettings: catalog,
      settingsForSessionId: (sessionId, backend) => {
        asked.push([sessionId, backend]);
        return sessionId === "x1" ? { model: "gpt-6-astra", modelLabel: "GPT-6-Astra", effort: "xhigh" } : undefined;
      },
    });
    expect(published.features).toEqual({ deliverables: 4, viewedState: 1, sessionHosts: 1, sessionSettings: 1 });
    expect(published.sessionSettings).toEqual(catalog);
    expect(published.rows.find((row) => row.id === "x1")?.settings).toEqual({ model: "gpt-6-astra", modelLabel: "GPT-6-Astra", effort: "xhigh" });
    expect(published.rows.find((row) => row.id === "c1")?.settings).toBeUndefined();
    // A subagent runs inside its parent: it is never asked, and never carries settings.
    expect(asked.map(([id]) => id).sort()).toEqual(["c1", "x1"]);
    expect(asked).toContainEqual(["x1", "codex"]);
  });

  test("an older caller publishes none of it", () => {
    const published = buildPublishedState("device", model, new Map(), new Set(), 100);
    expect(published.features).toEqual({ deliverables: 4, viewedState: 1, sessionHosts: 1 });
    expect(published.sessionSettings).toBeUndefined();
    expect(published.rows.every((row) => row.settings === undefined)).toBe(true);
  });

  test("the daemon reads settings from the same tail as the context meter, and publishes both", () => {
    const daemon = read("src/daemon.ts");
    const block = daemon.slice(daemon.indexOf('breadcrumb("panel: context usage, model and effort");'));
    expect(block).toContain("const tail = path ? await readTranscriptTailLines(path).catch(() => null) : null;");
    expect(block).toContain("noteSessionSettings(session, tail && format ? sessionSettingsFromLines(tail, format) : null);");
    expect(daemon).toContain("        publishedSessionSettingsFor(),\n      );");
    expect(daemon).toContain("sessionSettingsCatalog = accountModelCatalog({ claudeDir: cfg.claudeDir, codexHome: codexHomeDir() },");
    // A tail with no turn in it keeps what an earlier read found; the agent's own record is asked once.
    const note = daemon.slice(daemon.indexOf("const noteSessionSettings = "), daemon.indexOf("// Keyed by executable path,"));
    expect(note).toContain("if (sample || known || sessionSettingsAsked.has(session.sessionId)) return;");
    expect(note).toContain('AGENT_SESSION_SETTINGS[session.backend ?? "claude"].readRecorded?.(session.agentSessionId ?? session.sessionId,');
    expect(note).toContain("session.codexAccountId ? requireCodexAccount(session.codexAccountId).configDir : undefined");
  });
});

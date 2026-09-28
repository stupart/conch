import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerKey } from "../src/agent-adapter.ts";
import type { Config } from "../src/config.ts";
import { injectKeys, type OsaRunner } from "../src/inject.ts";
import {
  AGENT_SESSION_SETTINGS,
  claudeDefaultsFromSettings,
  claudeModelLabel,
  codexComposerText,
  codexDefaultsFromConfig,
  codexModelsFromCache,
  driveSessionSettings,
  FAILED_CHANGE_SHOWN_MS,
  planClaudePicker,
  planCodexPicker,
  publishedSessionSettings,
  readCodexThreadSettings,
  readSessionSettingsCatalog,
  sessionSettingsFromLines,
  withCarriedEffort,
  type PickerStep,
  type SessionSettingsCatalog,
  type SessionSettingsChange,
} from "../src/session-settings.ts";

/** Screens captured from the real TUIs in a throwaway tmux lab (Claude Code 2.1.280, codex-cli 0.157.1). */
const screen = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "session-settings", `${name}.txt`), "utf8");
const line = (value: unknown) => JSON.stringify(value);

describe("reading what a Claude session runs, from its transcript", () => {
  // Shapes as Claude Code 2.1.280 writes them: a reply carries `message.model` and `effort`
  // (and `perTurnEffort`); a confirmed /model or /effort is a `user` record or a `system`
  // `local_command` record around `<local-command-stdout>`.
  const reply = (model: string, effort: string | undefined, at: string, extra: Record<string, unknown> = {}) => line({
    type: "assistant", timestamp: at, ...(effort ? { effort, perTurnEffort: effort } : {}), message: { model, role: "assistant", content: [] }, ...extra,
  });
  const stdout = (text: string, at: string, system = false) => system
    ? line({ type: "system", subtype: "local_command", timestamp: at, content: `<local-command-stdout>${text}</local-command-stdout>` })
    : line({ type: "user", timestamp: at, message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } });

  test("the newest reply names the model and effort", () => {
    expect(sessionSettingsFromLines([
      reply("claude-opus-5", "high", "2026-09-28T01:00:00.000Z"),
      reply("claude-opus-5-5", "xhigh", "2026-09-28T02:00:00.000Z"),
    ], "claude")).toEqual({ model: "claude-opus-5-5", effort: "xhigh", at: Date.parse("2026-09-28T02:00:00.000Z") });
  });

  test("a session-only change the session confirmed since its last reply wins", () => {
    expect(sessionSettingsFromLines([
      reply("claude-opus-5-5", "xhigh", "2026-09-28T02:00:00.000Z"),
      stdout("Set model to `Sonnet 5` for this session only with `max` effort", "2026-09-28T02:01:00.000Z"),
    ], "claude")).toEqual({ model: "Sonnet 5", effort: "max", at: Date.parse("2026-09-28T02:01:00.000Z") });
    // The `system` / `local_command` form, and the picker's "(default)" suffix dropped.
    expect(sessionSettingsFromLines([
      stdout("Set model to `Opus 5.5 (1M context) (default)` for this session only", "2026-09-28T02:02:00.000Z", true),
    ], "claude")).toEqual({ model: "Opus 5.5 (1M context)", at: Date.parse("2026-09-28T02:02:00.000Z") });
  });

  test("an effort set alone keeps the model before it; a model set without one does not borrow an older effort", () => {
    expect(sessionSettingsFromLines([
      reply("claude-opus-5-5", "xhigh", "2026-09-28T02:00:00.000Z"),
      stdout("Set effort level to max (this session only): Maximum capability", "2026-09-28T02:03:00.000Z", true),
    ], "claude")).toEqual({ model: "claude-opus-5-5", effort: "max", at: Date.parse("2026-09-28T02:03:00.000Z") });
    expect(sessionSettingsFromLines([
      reply("claude-opus-5-5", "xhigh", "2026-09-28T02:00:00.000Z"),
      stdout("Set model to `Haiku 4.5` for this session only", "2026-09-28T02:04:00.000Z"),
    ], "claude")).toEqual({ model: "Haiku 4.5", at: Date.parse("2026-09-28T02:04:00.000Z") });
  });

  test("ignores what isn't the session's own choice: a subagent's reply, a synthetic one, a kept model, a torn line", () => {
    expect(sessionSettingsFromLines([
      reply("claude-opus-5-5", "xhigh", "2026-09-28T02:00:00.000Z"),
      reply("claude-haiku-4-5", "low", "2026-09-28T02:05:00.000Z", { isSidechain: true }),
      reply("<synthetic>", undefined, "2026-09-28T02:06:00.000Z"),
      stdout("Kept model as `Opus 5.5 (1M context)`", "2026-09-28T02:07:00.000Z", true),
      '{"type":"assistant","message":{"model":"claude-fab',
    ], "claude")).toEqual({ model: "claude-opus-5-5", effort: "xhigh", at: Date.parse("2026-09-28T02:00:00.000Z") });
  });

  test("nothing to go on is unknown, never a guess", () => {
    expect(sessionSettingsFromLines([], "claude")).toBeNull();
    expect(sessionSettingsFromLines([line({ type: "user", message: { content: "hello" } })], "claude")).toBeNull();
    // An older reply with no effort field: the model alone.
    expect(sessionSettingsFromLines([reply("claude-opus-5", undefined, "2026-09-01T00:00:00.000Z")], "claude"))
      .toEqual({ model: "claude-opus-5", at: Date.parse("2026-09-01T00:00:00.000Z") });
  });
});

describe("reading what a Codex session runs, from its rollout", () => {
  const turn = (model: string, effort: string | null, at: string) =>
    line({ timestamp: at, type: "turn_context", payload: { model, effort, summary: "none", cwd: "/w" } });
  const applied = (model: string, effort: string, at: string) => line({
    timestamp: at, type: "event_msg",
    payload: { type: "thread_settings_applied", thread_id: "t", thread_settings: { model, reasoning_effort: effort, approval_policy: "never" } },
  });

  test("the newest turn context or settings change wins", () => {
    expect(sessionSettingsFromLines([
      turn("gpt-6-astra", "xhigh", "2026-09-28T06:07:47.000Z"),
      line({ timestamp: "2026-09-28T06:08:00.000Z", type: "event_msg", payload: { type: "token_count" } }),
      applied("gpt-6-luna", "max", "2026-09-28T06:34:15.773Z"),
    ], "codex")).toEqual({ model: "gpt-6-luna", effort: "max", at: Date.parse("2026-09-28T06:34:15.773Z") });
    expect(sessionSettingsFromLines([
      applied("gpt-6-luna", "max", "2026-09-28T06:34:15.773Z"),
      turn("gpt-6-sol", "high", "2026-09-28T06:40:00.000Z"),
    ], "codex")).toEqual({ model: "gpt-6-sol", effort: "high", at: Date.parse("2026-09-28T06:40:00.000Z") });
  });

  test("a model with no effort has none; a rollout with no turn is unknown", () => {
    expect(sessionSettingsFromLines([turn("gpt-5.5", null, "2026-09-28T01:00:00.000Z")], "codex"))
      .toEqual({ model: "gpt-5.5", at: Date.parse("2026-09-28T01:00:00.000Z") });
    expect(sessionSettingsFromLines([line({ type: "session_meta", payload: { id: "t" } })], "codex")).toBeNull();
  });

  test("the thread record is the fallback, read-only", () => {
    const home = mkdtempSync(join(tmpdir(), "conch-settings-"));
    try {
      const db = new Database(join(home, "state_5.sqlite"));
      db.run("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT, reasoning_effort TEXT, updated_at_ms INTEGER)");
      db.run("INSERT INTO threads VALUES ('t1', 'gpt-6-astra', 'xhigh', 1790000000000), ('t2', NULL, NULL, 1)");
      db.close();
      expect(readCodexThreadSettings(home, "t1")).toEqual({ model: "gpt-6-astra", effort: "xhigh", at: 1790000000000 });
      expect(readCodexThreadSettings(home, "t2")).toBeNull();
      expect(readCodexThreadSettings(home, "missing")).toBeNull();
      expect(readCodexThreadSettings(join(home, "nowhere"), "t1")).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("what each agent offers, and its own defaults", () => {
  // The shape of Codex's own `models_cache.json`, trimmed to the fields read.
  const cache = JSON.stringify({
    fetched_at: "2026-09-28T06:26:11Z",
    models: [
      { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list", priority: 2, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43, supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 1, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 12, default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }] },
    ],
  });

  test("Codex's listed models, in its priority order, with the efforts each takes", () => {
    expect(codexModelsFromCache(cache)).toEqual([
      { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
      { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
      { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    ]);
  });

  test("each agent's defaults, from its own file", () => {
    expect(claudeDefaultsFromSettings(JSON.stringify({
      theme: "dark",
      modelSettings: { "claude-opus-5-5": { effortLevel: "xhigh" }, "claude-fable-5-1": { effortLevel: "high" }, bogus: 3 },
    }), "/h/.claude/settings.json")).toEqual({
      source: "/h/.claude/settings.json",
      perModelEffort: { "claude-opus-5-5": "xhigh", "claude-fable-5-1": "high" },
    });
    expect(claudeDefaultsFromSettings(JSON.stringify({ model: "sonnet", effortLevel: "high" }), "s"))
      .toEqual({ source: "s", model: "sonnet", effort: "high" });
    expect(codexDefaultsFromConfig('model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n\n[projects."/w"]\ntrust_level = "trusted"\n', "c"))
      .toEqual({ source: "c", model: "gpt-6-astra", effort: "xhigh" });
    expect(codexDefaultsFromConfig('profile = "work"\n', "c")).toEqual({ source: "c", profile: "work" });
  });

  test("the catalog reads both homes, and reads no Codex home when conch's state is redirected", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-settings-"));
    try {
      const claudeDir = join(root, ".claude");
      const codexHome = join(root, ".codex");
      mkdirSync(claudeDir);
      mkdirSync(codexHome);
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "fable" }));
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-sol"\n');
      writeFileSync(join(codexHome, "models_cache.json"), cache);
      const catalog = readSessionSettingsCatalog({ claudeDir, codexHome });
      expect(catalog.claude.defaults).toEqual({ source: join(claudeDir, "settings.json"), model: "fable" });
      expect(catalog.claude.models.map((model) => model.id)).toEqual(["default", "opus", "fable", "sonnet", "haiku"]);
      expect(catalog.claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(catalog.claude.settings.map((setting) => setting.key)).toEqual(["model", "effort"]);
      expect(catalog.codex.defaults).toEqual({ source: join(codexHome, "config.toml"), model: "gpt-6-sol" });
      expect(catalog.codex.models.map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.5"]);
      // A file that changes is read again.
      writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "max"\n# longer\n');
      expect(readSessionSettingsCatalog({ claudeDir, codexHome }).codex.defaults)
        .toEqual({ source: join(codexHome, "config.toml"), model: "gpt-6-astra", effort: "max" });
      const redirected = readSessionSettingsCatalog({ claudeDir, codexHome: null });
      expect(redirected.codex.models).toEqual([]);
      expect(redirected.codex.defaults).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what a row publishes", () => {
  const catalog = {
    claude: { settings: [], models: [], efforts: [], defaults: {} },
    codex: {
      settings: [], efforts: [], defaults: {},
      models: [{ id: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "high", "xhigh"] }, { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"] }],
    },
  } satisfies SessionSettingsCatalog;

  test("a Claude id reads as a name, and names its choice", () => {
    expect(claudeModelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(claudeModelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(claudeModelLabel("claude-opus-5")).toBe("Opus 5");
    expect(claudeModelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5 (1M context)");
    expect(claudeModelLabel("Sonnet 5")).toBe("Sonnet 5");
    expect(publishedSessionSettings("claude", { model: "claude-opus-5-5", effort: "xhigh", at: 5 }, undefined, catalog))
      .toEqual({ model: "claude-opus-5-5", modelLabel: "Opus 5.5", modelChoice: "opus", effort: "xhigh", at: 5 });
  });

  test("a Codex slug takes its catalog name; nothing known publishes nothing", () => {
    expect(publishedSessionSettings("codex", { model: "gpt-6-astra", effort: "xhigh" }, undefined, catalog))
      .toEqual({ model: "gpt-6-astra", modelLabel: "GPT-6-Astra", modelChoice: "gpt-6-astra", effort: "xhigh" });
    expect(publishedSessionSettings("codex", { model: "gpt-9" }, undefined, catalog)).toEqual({ model: "gpt-9", modelLabel: "gpt-9" });
    expect(publishedSessionSettings("codex", null, undefined, catalog)).toBeUndefined();
  });

  test("a change the session confirmed stands until the session records something newer than its start", () => {
    const applied = { state: "applied" as const, model: "gpt-5.5", effort: "high", at: 200, startedAt: 100 };
    // No record at all yet (a new session without a rollout): the confirmed change is what it runs.
    expect(publishedSessionSettings("codex", null, applied, catalog))
      .toMatchObject({ model: "gpt-5.5", modelLabel: "GPT-5.5", effort: "high", change: applied });
    // A record from before the change started: the change is newer.
    expect(publishedSessionSettings("codex", { model: "gpt-6-astra", effort: "xhigh", at: 50 }, applied, catalog))
      .toMatchObject({ model: "gpt-5.5", effort: "high" });
    // The session's own record of the change (written as it happened): the record wins.
    expect(publishedSessionSettings("codex", { model: "gpt-5.5", effort: "low", at: 150 }, applied, catalog))
      .toMatchObject({ model: "gpt-5.5", effort: "low" });
    // Applying or failed changes nothing about what it runs.
    const failed = { ...applied, state: "failed" as const };
    expect(publishedSessionSettings("codex", { model: "gpt-6-astra", at: 50 }, failed, catalog, 200 + FAILED_CHANGE_SHOWN_MS))
      .toMatchObject({ model: "gpt-6-astra", change: { state: "failed" } });
    // Said for ten minutes, then no longer.
    expect(publishedSessionSettings("codex", { model: "gpt-6-astra", at: 50 }, failed, catalog, 201 + FAILED_CHANGE_SHOWN_MS))
      .toEqual({ model: "gpt-6-astra", modelLabel: "GPT-6-Astra", modelChoice: "gpt-6-astra", at: 50 });
    // A confirmed change is never dropped for age: it may be the only record of what it runs.
    expect(publishedSessionSettings("codex", null, applied, catalog, 10 * FAILED_CHANGE_SHOWN_MS)).toMatchObject({ model: "gpt-5.5" });
  });

  test("switching a Codex model keeps the session's effort when the new model takes it", () => {
    const current = { model: "gpt-6-astra", effort: "xhigh" };
    expect(withCarriedEffort("codex", { model: "gpt-6-astra" }, current, catalog)).toEqual({ model: "gpt-6-astra", effort: "xhigh" });
    expect(withCarriedEffort("codex", { model: "gpt-5.5" }, current, catalog)).toEqual({ model: "gpt-5.5" });
    expect(withCarriedEffort("codex", { model: "gpt-5.5", effort: "low" }, current, catalog)).toEqual({ model: "gpt-5.5", effort: "low" });
    // Claude's own picker carries it; nothing is added.
    expect(withCarriedEffort("claude", { model: "sonnet" }, { effort: "max" }, catalog)).toEqual({ model: "sonnet" });
  });
});

/** Named keys a planner may press, and the one letter: never a digit, which picks AND saves a default. */
function expectSafeKeys(step: PickerStep): void {
  if (step.kind !== "keys") return;
  for (const key of step.keys) {
    if (typeof key === "object") expect("press" in key && key.press).toBe("s");
  }
}

describe("Claude's /model picker, planned from its real screen", () => {
  test("moves to the model, then presses s for this session only", () => {
    const picker = screen("claude-picker"); // row 1 (Default ✔) highlighted, Max effort
    expect(planClaudePicker(picker, { model: "sonnet" }, false)).toEqual({ kind: "keys", keys: ["Down", "Down", "Down"] });
    expect(planClaudePicker(picker, { model: "default" }, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
    // No model asked for: the ✔ row, which is already highlighted.
    expect(planClaudePicker(picker, { effort: "max" }, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
    for (const change of [{ model: "sonnet" }, { model: "opus", effort: "low" }, { effort: "high" }] as SessionSettingsChange[]) {
      expectSafeKeys(planClaudePicker(picker, change, false));
    }
  });

  test("cycles effort the short way round the measured cycle", () => {
    const picker = screen("claude-picker"); // Max
    expect(planClaudePicker(picker, { effort: "xhigh" }, false)).toEqual({ kind: "keys", keys: ["Left"] });
    expect(planClaudePicker(picker, { effort: "low" }, false)).toEqual({ kind: "keys", keys: ["Right", "Right"] });
    expect(planClaudePicker(picker, { effort: "medium" }, false)).toEqual({ kind: "keys", keys: ["Right", "Right", "Right"] });
    expect(planClaudePicker(picker, { effort: "high" }, false)).toEqual({ kind: "keys", keys: ["Left", "Left"] });
  });

  test("the narrow layout parses the same", () => {
    // 90 columns: descriptions wrap; row 2 (Opus ✔) highlighted, High effort.
    const narrow = screen("claude-picker-90");
    expect(planClaudePicker(narrow, { model: "haiku" }, false)).toEqual({ kind: "keys", keys: ["Down", "Down", "Down"] });
    expect(planClaudePicker(narrow, { effort: "xhigh" }, false)).toEqual({ kind: "keys", keys: ["Right"] });
    expect(planClaudePicker(narrow, { model: "opus[1m]" }, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
  });

  test("refuses what the picker doesn't offer", () => {
    expect(planClaudePicker(screen("claude-picker-haiku"), { model: "haiku", effort: "high" }, false))
      .toEqual({ kind: "fail", reason: "Haiku takes no effort level" });
    expect(planClaudePicker(screen("claude-picker"), { model: "gpt-5" }, false)).toMatchObject({ kind: "fail" });
    expect(planClaudePicker(screen("claude-picker"), { effort: "ultra" }, false))
      .toEqual({ kind: "fail", reason: 'Claude Code has no "ultra" effort' });
  });

  test("waits for it to open, and knows a session-only confirmation from a saved default", () => {
    expect(planClaudePicker(screen("claude-typed-model"), { model: "opus" }, false)).toMatchObject({ kind: "wait" });
    expect(planClaudePicker(screen("claude-picker"), { model: "opus" }, true)).toMatchObject({ kind: "wait" });
    expect(planClaudePicker("❯ /model\n  ⎿  Set model to Sonnet 5 for this session only with max effort\n", {}, true))
      .toEqual({ kind: "done", message: "Set model to Sonnet 5 for this session only with max effort" });
    expect(planClaudePicker("  ⎿  Set model to Haiku 4.5 and saved as your default for new sessions\n", {}, true))
      .toMatchObject({ kind: "fail" });
  });
});

describe("Codex's /model picker, planned from its real screens", () => {
  test("models: move to the model, then Enter opens its efforts (which chooses nothing)", () => {
    const models = screen("codex-models"); // row 3 (GPT-6-Luna, current) highlighted
    expect(planCodexPicker(models, { model: "gpt-6-astra" }, false)).toEqual({ kind: "keys", keys: ["Up", "Up"] });
    expect(planCodexPicker(models, { model: "gpt-5.5" }, false)).toEqual({ kind: "keys", keys: ["Down", "Down", "Down", "Down"] });
    expect(planCodexPicker(models, { model: "GPT-6-Luna" }, false)).toEqual({ kind: "keys", keys: ["Enter"] });
    expect(planCodexPicker(models, { effort: "high" }, false)).toEqual({ kind: "keys", keys: ["Enter"] });
    expect(planCodexPicker(models, { model: "gpt-9" }, false)).toMatchObject({ kind: "fail" });
  });

  test("efforts: move to the effort and press s — never Enter or a digit, which write config.toml", () => {
    const levels = screen("codex-levels-current"); // GPT-6-Astra, row 3 High (current) highlighted
    expect(planCodexPicker(levels, { effort: "xhigh" }, false)).toEqual({ kind: "keys", keys: ["Down"] });
    expect(planCodexPicker(levels, { effort: "low" }, false)).toEqual({ kind: "keys", keys: ["Up", "Up"] });
    expect(planCodexPicker(levels, { effort: "high" }, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
    // No effort asked for: the one it has on this model.
    expect(planCodexPicker(levels, { model: "gpt-6-astra" }, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
    // Max and Ultra: to "More reasoning…", where Enter only opens them.
    expect(planCodexPicker(levels, { effort: "max" }, false)).toEqual({ kind: "keys", keys: ["Down", "Down"] });
    expect(planCodexPicker(screen("codex-levels-astra"), { effort: "persistent" }, false))
      .toEqual({ kind: "keys", keys: ["Down", "Down", "Down", "Down"] });
    // No effort asked for on a model it isn't using: the one the picker offers.
    expect(planCodexPicker(screen("codex-levels-astra"), {}, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
    // The picker opened some other model than the one asked for.
    expect(planCodexPicker(levels, { model: "gpt-6-sol", effort: "high" }, false))
      .toEqual({ kind: "fail", reason: "the picker opened GPT-6-Astra, not gpt-6-sol" });
  });

  test("advanced: Max and Ultra, and a level no model offers", () => {
    const advanced = screen("codex-advanced-astra"); // Max highlighted
    expect(planCodexPicker(advanced, { effort: "ultra" }, false)).toEqual({ kind: "keys", keys: ["Down"] });
    expect(planCodexPicker(advanced, { effort: "max" }, false)).toEqual({ kind: "keys", keys: [{ press: "s" }], commit: true });
    expect(planCodexPicker(advanced, { effort: "persistent" }, false)).toMatchObject({ kind: "fail" });
  });

  test("done only on the session-only confirmation", () => {
    expect(planCodexPicker(screen("codex-after-escape"), { effort: "high" }, true))
      .toEqual({ kind: "done", message: "Model changed to gpt-6-astra high for this session only" });
    expect(planCodexPicker(screen("codex-typed-model"), { effort: "high" }, false)).toMatchObject({ kind: "wait" });
  });

  test("the composer is the last › line; a picker's rows are not it", () => {
    expect(codexComposerText(screen("codex-typed-model"))).toBe("/model");
    expect(codexComposerText(screen("codex-after-escape"))).toBe("Ask Codex to do anything");
    expect(codexComposerText("» Ask Codex to do anything\n  GPT-6-Astra ultra")).toBe("Ask Codex to do anything");
    expect(codexComposerText("no prompt here")).toBeNull();
    expect(AGENT_SESSION_SETTINGS.codex.pickerDepth(screen("codex-models"))).toBe(1);
    expect(AGENT_SESSION_SETTINGS.codex.pickerDepth(screen("codex-levels-current"))).toBe(2);
    expect(AGENT_SESSION_SETTINGS.codex.pickerDepth(screen("codex-advanced-astra"))).toBe(3);
    expect(AGENT_SESSION_SETTINGS.codex.pickerDepth(screen("codex-after-escape"))).toBe(0);
    expect(AGENT_SESSION_SETTINGS.claude.pickerDepth(screen("claude-picker"))).toBe(1);
    expect(AGENT_SESSION_SETTINGS.claude.pickerDepth(screen("claude-kept"))).toBe(0);
  });
});

// ── the driver, against simulated TUIs that behave as the real ones were measured to ──

interface Simulated {
  screen(): string;
  press(key: AnswerKey): void;
  type(words: string): void;
  /** Anything that would have written the agent's defaults. */
  savedDefault: boolean;
  /** Anything submitted to the model as a message. */
  sentMessage: string | null;
  session: { model: string; effort?: string };
  prompt: string;
}

/** Claude Code 2.1.280's prompt and /model picker, as measured in the lab. */
function simulatedClaude(start: { model?: string; effort?: string; prompt?: string; busy?: boolean } = {}): Simulated {
  const rows = [
    { label: "Default (recommended)", model: "Opus 5.5 (1M context)", effort: true },
    { label: "Opus (1M context)", model: "Opus 5.5 (1M context)", effort: true },
    { label: "Fable", model: "Fable 5.1", effort: true },
    { label: "Sonnet", model: "Sonnet 5", effort: true },
    { label: "Haiku", model: "Haiku 4.5", effort: false },
  ];
  const cycle = ["low", "medium", "high", "xhigh", "max", "ultracode"];
  const state: Simulated = {
    savedDefault: false,
    sentMessage: null,
    session: { model: start.model ?? "Opus (1M context)", effort: start.effort ?? "xhigh" },
    prompt: start.prompt ?? "",
    screen: () => "",
    press: () => {},
    type: () => {},
  };
  let picker: { at: number; effort: string } | null = null;
  const history: string[] = [];
  const currentRow = () => rows.findIndex((row) => row.label === state.session.model);
  state.screen = () => {
    const top = [...history, ""];
    if (picker) {
      return [...top, "─".repeat(60), "  Select model", "  Switch between Claude models.", "",
        ...rows.map((row, index) => `  ${index === picker!.at ? "❯" : " "} ${index + 1}. ${row.label}${index === currentRow() ? " ✔" : ""}    desc`),
        "", rows[picker.at]!.effort ? `  ● ${picker.effort === "xhigh" ? "xHigh" : picker.effort[0]!.toUpperCase() + picker.effort.slice(1)} effort ←/→ to adjust` : `  ○ Effort not supported for ${rows[picker.at]!.label}`,
        "", "  Enter to set as default · s to use this session only · Esc to cancel"].join("\n");
    }
    return [...top, "─".repeat(60), `❯ ${state.prompt}`, "─".repeat(60),
      `  ⏸ manual mode on${start.busy ? " · esc to interrupt" : ""}`].join("\n");
  };
  state.type = (words) => { if (!picker) state.prompt += words; };
  state.press = (key) => {
    if (!picker) {
      if (key === "Backspace") state.prompt = state.prompt.slice(0, -1);
      else if (key === "Enter") {
        if (state.prompt === "/model") picker = { at: currentRow(), effort: state.session.effort ?? "medium" };
        else if (state.prompt) state.sentMessage = state.prompt;
        state.prompt = "";
      } else if (typeof key === "object") state.prompt += "press" in key ? key.press : key.type;
      return;
    }
    const row = rows[picker.at]!;
    if (key === "Up") picker.at = (picker.at + rows.length - 1) % rows.length;
    else if (key === "Down") picker.at = (picker.at + 1) % rows.length;
    else if ((key === "Right" || key === "Left") && row.effort) {
      picker.effort = cycle[(cycle.indexOf(picker.effort) + (key === "Right" ? 1 : cycle.length - 1)) % cycle.length]!;
    } else if (key === "Escape") {
      history.push(`  ⎿  Kept model as ${rows[currentRow()]!.model}`);
      picker = null;
    } else if (key === "Enter" || (typeof key === "object" && "press" in key && /^\d$/.test(key.press))) {
      state.savedDefault = true;
      picker = null;
    } else if (typeof key === "object" && "press" in key && key.press === "s") {
      state.session = { model: row.label, ...(row.effort ? { effort: picker.effort } : {}) };
      history.push(`  ⎿  Set model to ${row.model} for this session only${row.effort ? ` with ${picker.effort} effort` : ""}`);
      picker = null;
    }
  };
  return state;
}

/** codex-cli 0.157.1's composer and /model picker, as measured in the lab. */
function simulatedCodex(start: { model?: string; effort?: string; prompt?: string; busy?: boolean } = {}): Simulated {
  const models = [
    { slug: "gpt-6-astra", label: "GPT-6-Astra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], def: "low" },
    { slug: "gpt-6-sol", label: "GPT-6-Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], def: "medium" },
    { slug: "gpt-6-luna", label: "GPT-6-Luna", efforts: ["low", "medium", "high", "xhigh", "max"], def: "medium" },
    { slug: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], def: "medium" },
  ];
  const names: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
  const state: Simulated = {
    savedDefault: false,
    sentMessage: null,
    session: { model: start.model ?? "gpt-6-astra", effort: start.effort ?? "xhigh" },
    prompt: start.prompt ?? "",
    screen: () => "",
    press: () => {},
    type: () => {},
  };
  let stage: null | { kind: "models" | "levels" | "advanced"; at: number; model: number } = null;
  const history: string[] = [];
  const current = () => models.findIndex((model) => model.slug === state.session.model);
  const levelRows = (model: number) => {
    const basic = models[model]!.efforts.filter((effort) => !["max", "ultra"].includes(effort));
    return models[model]!.efforts.some((effort) => ["max", "ultra"].includes(effort)) ? [...basic, "more"] : basic;
  };
  const advancedRows = (model: number) => models[model]!.efforts.filter((effort) => ["max", "ultra"].includes(effort));
  const tag = (model: number, effort: string) =>
    model === current() && effort === state.session.effort ? " (current)" : effort === models[model]!.def ? " (default)" : "";
  state.screen = () => {
    const top = history.join("\n");
    if (!stage) {
      return `${top}\n› ${state.prompt || "Ask Codex to do anything"}\n  ${models[current()]!.label} ${state.session.effort ?? ""}${start.busy ? "\n◦ Working (3s • esc to interrupt)" : ""}`;
    }
    if (stage.kind === "models") {
      return `${top}\n  Select Model and Effort\n${models.map((model, index) =>
        `${index === stage!.at ? "›" : " "} ${index + 1}. ${model.label}${index === current() ? " (current)" : ""}  desc`).join("\n")}\n  enter select · esc back`;
    }
    const rows = stage.kind === "levels" ? levelRows(stage.model) : advancedRows(stage.model);
    const title = stage.kind === "levels" ? `  Select Reasoning Level for ${models[stage.model]!.label}` : "  Advanced Reasoning";
    return `${top}\n${title}\n${rows.map((effort, index) =>
      `${index === stage!.at ? "›" : " "} ${index + 1}. ${effort === "more" ? "More reasoning…" : names[effort] + tag(stage!.model, effort)}  desc`).join("\n")}\n  enter default · s session · esc back`;
  };
  state.type = (words) => { if (!stage) state.prompt += words; };
  const apply = (model: number, effort: string, session: boolean) => {
    state.session = { model: models[model]!.slug, effort };
    if (session) history.push(`• Model changed to ${models[model]!.slug} ${effort} for this session only`);
    else state.savedDefault = true;
    stage = null;
  };
  state.press = (key) => {
    const digit = typeof key === "object" && "press" in key && /^\d$/.test(key.press) ? Number(key.press) - 1 : null;
    if (!stage) {
      if (key === "Backspace") state.prompt = state.prompt.slice(0, -1);
      else if (key === "Enter") {
        if (state.prompt === "/model") stage = { kind: "models", at: current(), model: current() };
        else if (state.prompt) state.sentMessage = state.prompt;
        state.prompt = "";
      } else if (typeof key === "object") state.prompt += "press" in key ? key.press : key.type;
      return;
    }
    const size = stage.kind === "models" ? models.length : stage.kind === "levels" ? levelRows(stage.model).length : advancedRows(stage.model).length;
    if (key === "Up") stage.at = (stage.at + size - 1) % size;
    else if (key === "Down") stage.at = (stage.at + 1) % size;
    else if (key === "Escape") {
      stage = stage.kind === "advanced" ? { kind: "levels", at: levelRows(stage.model).length - 1, model: stage.model }
        : stage.kind === "levels" ? { kind: "models", at: stage.model, model: stage.model } : null;
    } else if (stage.kind === "models" && (key === "Enter" || digit !== null)) {
      const model = digit ?? stage.at;
      const rows = levelRows(model);
      const effort = model === current() ? state.session.effort! : models[model]!.def;
      stage = { kind: "levels", at: Math.max(0, rows.indexOf(effort)), model };
    } else if (stage.kind !== "models") {
      const rows = stage.kind === "levels" ? levelRows(stage.model) : advancedRows(stage.model);
      const effort = rows[digit ?? stage.at]!;
      if (effort === "more") {
        if (key === "Enter" || digit !== null) stage = { kind: "advanced", at: 0, model: stage.model };
      } else if (key === "Enter" || digit !== null) apply(stage.model, effort, false);
      else if (typeof key === "object" && "press" in key && key.press === "s") apply(stage.model, effort, true);
    }
  };
  return state;
}

function depsFor(sim: Simulated, pressed: AnswerKey[][] = []) {
  return {
    read: async () => sim.screen(),
    press: async (keys: readonly AnswerKey[]) => {
      pressed.push([...keys]);
      for (const key of keys) sim.press(key);
      return true;
    },
    type: async (words: string) => {
      sim.type(words);
      return true;
    },
    sleep: async () => {},
  };
}

describe("driving a running session's own picker", () => {
  test.each([
    ["Claude: model and effort", "claude", { model: "sonnet", effort: "max" }, { model: "Sonnet", effort: "max" }],
    ["Claude: effort alone", "claude", { effort: "low" }, { model: "Opus (1M context)", effort: "low" }],
    ["Claude: model alone keeps the effort", "claude", { model: "fable" }, { model: "Fable", effort: "xhigh" }],
    ["Claude: the default model", "claude", { model: "default" }, { model: "Default (recommended)", effort: "xhigh" }],
    ["Codex: model and effort", "codex", { model: "gpt-6-sol", effort: "high" }, { model: "gpt-6-sol", effort: "high" }],
    ["Codex: effort alone", "codex", { effort: "medium" }, { model: "gpt-6-astra", effort: "medium" }],
    ["Codex: Max, one level down", "codex", { model: "gpt-6-luna", effort: "max" }, { model: "gpt-6-luna", effort: "max" }],
    ["Codex: Ultra", "codex", { effort: "ultra" }, { model: "gpt-6-astra", effort: "ultra" }],
    ["Codex: a model alone takes the picker's effort", "codex", { model: "gpt-5.5" }, { model: "gpt-5.5", effort: "medium" }],
  ] as const)("%s, for this session only", async (_, backend, change, after) => {
    const sim = backend === "claude" ? simulatedClaude() : simulatedCodex();
    const outcome = await driveSessionSettings(backend, change, depsFor(sim));
    expect(outcome.ok).toBe(true);
    expect(sim.session).toEqual(after);
    expect(sim.savedDefault).toBe(false);
    expect(sim.sentMessage).toBeNull();
    expect(sim.screen()).not.toMatch(/Select model|Select Model|Reasoning Level|Advanced Reasoning/);
  });

  test.each(["claude", "codex"] as const)("%s: words in the prompt are left exactly as they were", async (backend) => {
    const sim = backend === "claude" ? simulatedClaude({ prompt: "half a thought" }) : simulatedCodex({ prompt: "half a thought" });
    const before = { ...sim.session };
    const outcome = await driveSessionSettings(backend, { effort: "high" }, depsFor(sim));
    expect(outcome).toEqual({ ok: false, reason: "its prompt holds unsent words, so conch took back what it typed and left them alone" });
    expect(sim.prompt).toBe("half a thought");
    expect(sim.sentMessage).toBeNull();
    expect(sim.session).toEqual(before);
  });

  test.each(["claude", "codex"] as const)("%s: a working session is refused before anything is typed", async (backend) => {
    const sim = backend === "claude" ? simulatedClaude({ busy: true }) : simulatedCodex({ busy: true });
    const typed: string[] = [];
    const outcome = await driveSessionSettings(backend, { effort: "high" }, {
      ...depsFor(sim),
      type: async (words) => (typed.push(words), true),
    });
    expect(outcome).toEqual({ ok: false, reason: "the session is working; change it when its turn is over" });
    expect(typed).toEqual([]);
  });

  test.each([
    ["claude", { model: "haiku", effort: "high" }, "Haiku takes no effort level"],
    ["claude", { model: "gpt-5" }, undefined],
    ["codex", { model: "gpt-5.5", effort: "max" }, 'GPT-5.5 doesn\'t offer "max" effort'],
    ["codex", { model: "gpt-9" }, undefined],
  ] as const)("%s: %j is refused, and the picker is closed again", async (backend, change, reason) => {
    const sim = backend === "claude" ? simulatedClaude() : simulatedCodex();
    const before = { ...sim.session };
    const outcome = await driveSessionSettings(backend, change, depsFor(sim));
    expect(outcome.ok).toBe(false);
    if (reason) expect(outcome).toEqual({ ok: false, reason });
    expect(sim.session).toEqual(before);
    expect(sim.savedDefault).toBe(false);
    expect(AGENT_SESSION_SETTINGS[backend].pickerDepth(sim.screen())).toBe(0);
    // Backed out exactly: an Escape more would reach the prompt (Codex: edit the previous message).
    expect(sim.screen()).toMatch(/Ask Codex to do anything|❯ $/m);
  });

  test("an unreadable screen is refused, and nothing is typed", async () => {
    const typed: string[] = [];
    const outcome = await driveSessionSettings("claude", { model: "opus" }, {
      read: async () => null,
      press: async () => true,
      type: async (words) => (typed.push(words), true),
      sleep: async () => {},
    });
    expect(outcome).toEqual({ ok: false, reason: "conch can't read the session's screen, so it won't drive its picker" });
    expect(typed).toEqual([]);
  });

  test.each(["claude", "codex"] as const)("%s: a picker that never opens is given up on, and /model is taken back out of the prompt", async (backend) => {
    const sim = backend === "claude" ? simulatedClaude() : simulatedCodex();
    const pressed: AnswerKey[][] = [];
    // A TUI that swallows Enter: the prompt keeps "/model" and no picker appears.
    const outcome = await driveSessionSettings(backend, { effort: "high" }, {
      ...depsFor(sim, pressed),
      press: async (keys) => {
        pressed.push([...keys]);
        for (const key of keys) if (key !== "Enter") sim.press(key);
        return true;
      },
    }, { maxWaits: 2 });
    expect(outcome).toEqual({ ok: false, reason: "the picker didn't do what conch expected, so conch backed out" });
    expect(pressed).toEqual([["Enter"], Array(6).fill("Backspace")]);
    expect(sim.prompt).toBe("");
    expect(sim.sentMessage).toBeNull();
  });

  test("nothing to change is refused", async () => {
    expect(await driveSessionSettings("codex", {}, depsFor(simulatedCodex()))).toEqual({ ok: false, reason: "nothing to change" });
  });
});

describe("the picker's keys reach the session by their real names", () => {
  // Every key the drive presses: the arrows, Escape to back out, Backspace to take `/model` back, Enter, and `s`.
  const keys: AnswerKey[] = ["Up", "Down", "Left", "Right", "Escape", "Backspace", "Enter", { press: "s" }];
  const cfg = { keystrokeFallback: true } as Config;

  test("tmux: its own key names, `s` literal", async () => {
    const sent: Array<[string, boolean]> = [];
    const result = await injectKeys(cfg, 4242, keys, undefined, {
      findTmuxPane: async () => "%1",
      sendTmuxKeys: async (_pane, text, literal) => { sent.push([text, literal]); return { exitCode: 0 }; },
      sleep: async () => {},
    });
    expect(result).toEqual({ via: "tmux" });
    expect(sent).toEqual([
      ["Up", false], ["Down", false], ["Left", false], ["Right", false], ["Escape", false], ["BSpace", false], ["Enter", false], ["s", true],
    ]);
  });

  test("Terminal: macOS virtual key codes, in order, `s` typed", async () => {
    const scripts: Array<{ lines: string[]; argv: string[] }> = [];
    const osa: OsaRunner = async (lines, argv = []) => {
      scripts.push({ lines, argv });
      return { text: "ok", timedOut: false, exitCode: 0 };
    };
    const result = await injectKeys(cfg, 4242, keys, undefined, {
      osa, findTmuxPane: async () => null, ttyForPid: async () => "ttys007", sleep: async () => {},
    });
    expect(result).toEqual({ via: "osascript-focused" });
    const typing = scripts.at(-1)!;
    const codes = [...typing.lines.join("\n").matchAll(/key code (\d+)/g)].map((match) => Number(match[1]));
    // ↑ 126, ↓ 125, ← 123, → 124, Escape 53, Delete (Backspace) 51, Return 36.
    expect(codes).toEqual([126, 125, 123, 124, 53, 51, 36]);
    expect(typing.argv[0]).toBe("s");
  });
});

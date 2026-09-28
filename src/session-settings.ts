/**
 * Per-session agent settings: which model a session runs, at what reasoning effort, and how
 * conch reads and changes that for one session without touching anyone's defaults.
 *
 * The list is typed per agent (`AGENT_SESSION_SETTINGS`), each setting saying where its
 * current value is read from, which start option carries it into a new session, and how a
 * running session is changed. Model and effort ship first; the next ones (Claude's permission
 * mode, Codex's sandbox) are a row each, not a redesign.
 *
 * What was measured, in a throwaway tmux lab with a temp home and a fake key, never in a real
 * session (Claude Code 2.1.280, codex-cli 0.157.1, 2026-09-28):
 *
 * - Claude's `/model <name>` and `/effort <level>` SAVE the choice as the default for new
 *   sessions (`model` / `modelSettings.<id>.effortLevel` in settings.json); only `/effort max`
 *   is session-only. Its `/model` picker says "Enter to set as default · s to use this session
 *   only": ↑/↓ move between models (wrapping), ←/→ cycle effort (low → medium → high → xhigh →
 *   max → ultracode, wrapping), a digit picks AND saves as default. `s` records
 *   "Set model to `Opus 5.5 (1M context)` for this session only with `xhigh` effort".
 * - Codex's `/model <name>` is not a command at all: it goes to the model as a message. Its
 *   `/model` picker lists models (↑/↓ wrap, Enter selects, a digit selects), then "Select
 *   Reasoning Level for X" with "enter default · s session · esc back": a digit or Enter there
 *   WRITES `model` and `model_reasoning_effort` into config.toml; `s` says "Model changed to
 *   gpt-6-luna xhigh for this session only" and writes nothing. Max and Ultra sit behind a
 *   "More reasoning…" row (Enter opens it, writes nothing). The rollout records the change at
 *   once, as `event_msg` `thread_settings_applied`, even while idle.
 *
 * So a running session is only ever changed through the picker's own session-only key, driven
 * by reading its screen between keys — never by the one-line commands, which rewrite defaults.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeInputBoxText, type AnswerKey, type SessionBackend } from "./agent-adapter.ts";
import { codexHomeDir, codexThreadDbPaths, openReadOnly } from "./codex-threads.ts";
import type { ConversationFormat } from "./conversation.ts";

export type SessionSettingKey = "model" | "effort";

/** What the session's own record says it runs: the newest record that carries each value. */
export interface SessionSettingsSample {
  /** As the agent recorded it: `claude-opus-5-5`, `Opus 5.5 (1M context)`, `gpt-6-astra`. */
  model?: string;
  effort?: string;
  /** Epoch-ms of the newest record used. */
  at?: number;
}

/** What a person picked in conch for one session. At least one of the two. */
export interface SessionSettingsChange {
  model?: string;
  effort?: string;
}

/** A change conch typed, as the apps are told about it. */
export interface SessionSettingsChangeState {
  state: "applying" | "applied" | "failed";
  model?: string;
  effort?: string;
  /** Epoch-ms it started (applying) or settled. */
  at: number;
  /** Epoch-ms conch began driving the picker: a record at or after it is the session's own word on the change. */
  startedAt: number;
  /** The agent's own confirmation, or why nothing changed. */
  message?: string;
}

/** One row's settings on the wire (`rows[].settings`). Absent fields are unknown: say "default". */
export interface PublishedSessionSettings {
  model?: string;
  /** How a person reads it: "Opus 5.5", "GPT-6-Astra". */
  modelLabel?: string;
  /** The catalog choice this model is (`opus`, `gpt-6-astra`), when it matches one. */
  modelChoice?: string;
  effort?: string;
  at?: number;
  change?: SessionSettingsChangeState;
}

export interface AgentModelChoice {
  /** What conch sends: a Claude alias (`opus`), a Codex slug (`gpt-6-astra`). */
  id: string;
  label: string;
  /** The efforts this model takes, in the agent's order; empty means none; absent means the agent's list. */
  efforts?: string[];
  defaultEffort?: string;
}

/** The agent's own defaults for a new session, read from its config. Read-only in conch. */
export interface AgentSettingsDefaults {
  /** Absent: the agent's built-in default. */
  model?: string;
  effort?: string;
  /** Claude keeps effort per model (`modelSettings.<id>.effortLevel`). */
  perModelEffort?: Record<string, string>;
  /** Codex layers a profile over the base config; the model may come from it. */
  profile?: string;
  /** The file it was read from, absent when there was none to read. */
  source?: string;
}

/** One agent's half of `sessionSettings` on the wire: the typed list, its choices and defaults. */
export interface AgentSettingsCatalog {
  settings: Array<{ key: SessionSettingKey; label: string; readFrom: string }>;
  models: AgentModelChoice[];
  efforts: string[];
  defaults: AgentSettingsDefaults;
}

export type SessionSettingsCatalog = Record<SessionBackend, AgentSettingsCatalog>;

/**
 * One setting conch can set per session: how it is read, how a new session gets it, how a
 * running one does. `startOption` names the adapter's start-option row, which renders the
 * flag; `running` names the drive that changes a live session.
 */
export interface SessionSettingSpec {
  readonly key: SessionSettingKey;
  readonly label: string;
  /** Where the current value comes from, in words, for a tooltip and for whoever adds the next one. */
  readonly readFrom: string;
  readonly startOption: string;
  readonly running: "model-picker";
}

export interface AgentSessionSettings {
  readonly settings: readonly SessionSettingSpec[];
  /** What conch types to open the picker a running session is changed through. */
  readonly pickerCommand: string;
  readonly plan: (screen: string, change: SessionSettingsChange, committed: boolean) => PickerStep;
  /** Refuses to open the picker on a screen that could not take it; null when it can. */
  readonly precheck: (screen: string) => string | null;
  /** The words in the agent's prompt on this screen: "" when empty, null when no prompt is shown. */
  readonly promptText: (screen: string) => string | null;
  /** How many Escapes close the picker on this screen: 0 when none is open. */
  readonly pickerDepth: (screen: string) => number;
  /** How a person reads a recorded model. */
  readonly modelLabel: (model: string, catalog: AgentSettingsCatalog | undefined) => string;
  /** Which catalog choice a recorded model is, when it plainly is one. */
  readonly modelChoice: (model: string, catalog: AgentSettingsCatalog | undefined) => string | undefined;
  /** The picker keeps the session's effort when the model changes (Claude's does; Codex's resets it). */
  readonly pickerKeepsEffort: boolean;
  /** What the agent recorded for the session outside its transcript, when the transcript has no turn yet. */
  readonly readRecorded?: (agentSessionId: string) => SessionSettingsSample | null;
}

/**
 * The typed list, per agent. A third agent is a row; a third setting is an entry here, a start
 * option on the adapter, a reader in `sessionSettingsFromLines`, and a planner case.
 * Next candidates: Claude's permission mode (start `--permission-mode`, read from the
 * transcript's `permission-mode` records, changed live with Shift+Tab), Codex's sandbox and
 * approvals (start `--sandbox` / `--ask-for-approval`, read from `turn_context`, changed live
 * through `/permissions`).
 */
export const AGENT_SESSION_SETTINGS: Record<SessionBackend, AgentSessionSettings> = {
  claude: {
    settings: [
      {
        key: "model",
        label: "Model",
        readFrom: "the transcript: the newest reply's model, or a /model the session confirmed since",
        startOption: "model",
        running: "model-picker",
      },
      {
        key: "effort",
        label: "Effort",
        readFrom: "the transcript: the newest reply's effort, or an effort the session confirmed since",
        startOption: "effort",
        running: "model-picker",
      },
    ],
    pickerCommand: "/model",
    plan: planClaudePicker,
    precheck: claudePrecheck,
    promptText: claudeInputBoxText,
    pickerDepth: (screen) => (pickerBlock(screen, CLAUDE_TITLES, CLAUDE_FOOTER) ? 1 : 0),
    modelLabel: (model) => claudeModelLabel(model),
    modelChoice: (model) => CLAUDE_FAMILY.exec(model)?.[1]?.toLowerCase(),
    pickerKeepsEffort: true,
  },
  codex: {
    settings: [
      {
        key: "model",
        label: "Model",
        readFrom: "the rollout: the newest turn context or settings change, else Codex's thread record",
        startOption: "model",
        running: "model-picker",
      },
      {
        key: "effort",
        label: "Effort",
        readFrom: "the rollout: the newest turn context or settings change, else Codex's thread record",
        startOption: "reasoning-effort",
        running: "model-picker",
      },
    ],
    pickerCommand: "/model",
    plan: planCodexPicker,
    precheck: codexPrecheck,
    promptText: codexComposerText,
    pickerDepth: codexPickerDepth,
    modelLabel: (model, catalog) => codexCatalogModel(model, catalog)?.label ?? model,
    modelChoice: (model, catalog) => codexCatalogModel(model, catalog)?.id,
    pickerKeepsEffort: false,
    readRecorded: (threadId) => {
      const home = codexHomeDir();
      return home ? readCodexThreadSettings(home, threadId) : null;
    },
  },
};

// ── reading what a session runs ─────────────────────────────────────────────

function epochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

const CLAUDE_SET_MODEL = /Set model to `?([^`\n]+?)`?(?= and saved| for this session| with |<|$)(?:[^\n<]*?with `?([A-Za-z]+)`? effort)?/;
const CLAUDE_SET_EFFORT = /Set effort level to `?([A-Za-z]+)`?/;

/** What one Claude record says, if anything: a reply carries both, a confirmed command one or both. */
function claudeRecord(entry: any): { model?: string; effort?: string; setsModel: boolean } | null {
  if (entry?.isSidechain === true) return null;
  if (entry?.type === "assistant") {
    const model = entry.message?.model;
    if (typeof model !== "string" || !model || model === "<synthetic>") return null;
    const effort = typeof entry.effort === "string" ? entry.effort
      : typeof entry.perTurnEffort === "string" ? entry.perTurnEffort : undefined;
    return { model, ...(effort ? { effort } : {}), setsModel: true };
  }
  // A confirmed slash command: a `user` record in some sessions, `system` / `local_command` in others (2.1.280).
  const local = entry?.type === "system" && entry.subtype === "local_command";
  if (entry?.type !== "user" && !local) return null;
  const text = textOf(local ? entry.content : entry.message?.content);
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)?.[1];
  if (!stdout) return null;
  const model = CLAUDE_SET_MODEL.exec(stdout);
  if (model) {
    const name = model[1]!.replace(/\s*\(default\)\s*$/, "").trim();
    return { model: name, ...(model[2] ? { effort: model[2].toLowerCase() } : {}), setsModel: true };
  }
  const effort = CLAUDE_SET_EFFORT.exec(stdout);
  if (effort) return { effort: effort[1]!.toLowerCase(), setsModel: false };
  return null;
}

/** What one Codex record says: a turn's context, or a settings change the session applied. */
function codexRecord(entry: any): { model?: string; effort?: string } | null {
  if (entry?.type === "turn_context") {
    const { model, effort } = entry.payload ?? {};
    return typeof model === "string" && model
      ? { model, ...(typeof effort === "string" && effort ? { effort } : {}) }
      : null;
  }
  if (entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied") {
    const settings = entry.payload.thread_settings ?? {};
    return typeof settings.model === "string" && settings.model
      ? {
        model: settings.model,
        ...(typeof settings.reasoning_effort === "string" && settings.reasoning_effort
          ? { effort: settings.reasoning_effort }
          : {}),
      }
      : null;
  }
  return null;
}

/**
 * Newest wins, and nothing older than the record that set the model: a model switched to one
 * without an effort must not borrow the effort of the model before it. Unknown stays absent.
 */
export function sessionSettingsFromLines(
  lines: readonly string[],
  format: ConversationFormat,
): SessionSettingsSample | null {
  let effort: string | undefined;
  let effortAt: number | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a live transcript's last line can be torn mid-append
    }
    const at = epochMs(entry?.timestamp);
    if (format === "codex") {
      const record = codexRecord(entry);
      if (!record) continue;
      return { ...record, ...(at === undefined ? {} : { at }) };
    }
    const record = claudeRecord(entry);
    if (!record) continue;
    if (!record.setsModel) {
      effort ??= record.effort;
      effortAt ??= at;
      continue;
    }
    const newest = effortAt ?? at;
    return {
      ...(record.model ? { model: record.model } : {}),
      ...((effort ?? record.effort) ? { effort: effort ?? record.effort } : {}),
      ...(newest === undefined ? {} : { at: newest }),
    };
  }
  return effort ? { effort, ...(effortAt === undefined ? {} : { at: effortAt }) } : null;
}

/** Codex's thread record: the fallback when the rollout's tail holds no turn yet. */
export function readCodexThreadSettings(codexHome: string, threadId: string): SessionSettingsSample | null {
  const { state } = codexThreadDbPaths(codexHome);
  if (!existsSync(state)) return null;
  let db: ReturnType<typeof openReadOnly> | undefined;
  try {
    db = openReadOnly(state);
    const row = db.query("SELECT model, reasoning_effort, updated_at_ms FROM threads WHERE id = ? LIMIT 1")
      .get(threadId) as { model?: unknown; reasoning_effort?: unknown; updated_at_ms?: unknown } | null;
    if (!row || typeof row.model !== "string" || !row.model) return null;
    return {
      model: row.model,
      ...(typeof row.reasoning_effort === "string" && row.reasoning_effort ? { effort: row.reasoning_effort } : {}),
      ...(typeof row.updated_at_ms === "number" ? { at: row.updated_at_ms } : {}),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// ── what each agent offers, and its own defaults ────────────────────────────

/** `claude --help` 2.1.280: `--effort <level>`. The picker also offers "ultracode", which no flag can start. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** The `/model` picker's rows as measured (2.1.280, API key), by the alias `--model` takes. */
export const CLAUDE_MODELS: readonly AgentModelChoice[] = [
  { id: "default", label: "Default" },
  { id: "opus", label: "Opus" },
  { id: "fable", label: "Fable" },
  { id: "sonnet", label: "Sonnet" },
  // "Effort not supported for Haiku", in the picker.
  { id: "haiku", label: "Haiku", efforts: [] },
];

/** Codex's config reference; each model narrows it (`supported_reasoning_levels`). */
export const CODEX_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"] as const;

const catalogCache = new Map<string, { stamp: string; value: unknown }>();

function fileStamp(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Parsed once per change of the file: the Codex cache is ~350 KB and the publisher runs often. */
function cachedRead<T>(path: string, parse: (text: string) => T): T | null {
  const stamp = fileStamp(path);
  if (stamp === null) return null;
  const cached = catalogCache.get(path);
  if (cached?.stamp === stamp) return cached.value as T;
  let value: T | null = null;
  try {
    value = parse(readFileSync(path, "utf8"));
  } catch {
    value = null;
  }
  catalogCache.set(path, { stamp, value });
  return value;
}

/** The models Codex's own `/model` lists: its cache of the account's catalog, listed ones, by priority. */
export function codexModelsFromCache(text: string): AgentModelChoice[] {
  const parsed = JSON.parse(text) as { models?: unknown };
  if (!Array.isArray(parsed.models)) return [];
  return parsed.models
    .filter((model: any) => typeof model?.slug === "string" && model.visibility === "list")
    .sort((a: any, b: any) => (Number(a.priority) || 0) - (Number(b.priority) || 0))
    .map((model: any): AgentModelChoice => {
      const efforts = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
          .map((level: any) => (typeof level === "string" ? level : level?.effort))
          .filter((level: unknown): level is string => typeof level === "string" && level.length > 0)
        : undefined;
      return {
        id: model.slug,
        label: typeof model.display_name === "string" && model.display_name ? model.display_name : model.slug,
        ...(efforts ? { efforts } : {}),
        ...(typeof model.default_reasoning_level === "string" ? { defaultEffort: model.default_reasoning_level } : {}),
      };
    });
}

export function claudeDefaultsFromSettings(text: string, source: string): AgentSettingsDefaults {
  const settings = JSON.parse(text) as Record<string, unknown>;
  const perModelEffort: Record<string, string> = {};
  const models = settings.modelSettings;
  if (models && typeof models === "object" && !Array.isArray(models)) {
    for (const [model, value] of Object.entries(models as Record<string, unknown>)) {
      const level = (value as { effortLevel?: unknown } | null)?.effortLevel;
      if (typeof level === "string" && level) perModelEffort[model] = level;
    }
  }
  return {
    source,
    ...(typeof settings.model === "string" && settings.model ? { model: settings.model } : {}),
    ...(typeof settings.effortLevel === "string" && settings.effortLevel ? { effort: settings.effortLevel } : {}),
    ...(Object.keys(perModelEffort).length ? { perModelEffort } : {}),
  };
}

export function codexDefaultsFromConfig(text: string, source: string): AgentSettingsDefaults {
  const config = Bun.TOML.parse(text) as Record<string, unknown>;
  return {
    source,
    ...(typeof config.model === "string" && config.model ? { model: config.model } : {}),
    ...(typeof config.model_reasoning_effort === "string" && config.model_reasoning_effort
      ? { effort: config.model_reasoning_effort }
      : {}),
    ...(typeof config.profile === "string" && config.profile ? { profile: config.profile } : {}),
  };
}

/**
 * Both agents' lists and defaults, from their own files, read-only. `codexHome` null means
 * conch's state is redirected (tests): no real home is read.
 */
export function readSessionSettingsCatalog(homes: { claudeDir: string; codexHome: string | null }): SessionSettingsCatalog {
  const claudeSettings = join(homes.claudeDir, "settings.json");
  const claudeDefaults = cachedRead(claudeSettings, (text) => claudeDefaultsFromSettings(text, claudeSettings));
  const codexConfig = homes.codexHome ? join(homes.codexHome, "config.toml") : null;
  const codexDefaults = codexConfig ? cachedRead(codexConfig, (text) => codexDefaultsFromConfig(text, codexConfig)) : null;
  const codexModels = homes.codexHome
    ? cachedRead(join(homes.codexHome, "models_cache.json"), codexModelsFromCache) ?? []
    : [];
  return {
    claude: {
      settings: AGENT_SESSION_SETTINGS.claude.settings.map(({ key, label, readFrom }) => ({ key, label, readFrom })),
      models: CLAUDE_MODELS.map((model) => ({ ...model, ...(model.efforts ? { efforts: [...model.efforts] } : {}) })),
      efforts: [...CLAUDE_EFFORTS],
      defaults: claudeDefaults ?? {},
    },
    codex: {
      settings: AGENT_SESSION_SETTINGS.codex.settings.map(({ key, label, readFrom }) => ({ key, label, readFrom })),
      models: codexModels,
      efforts: [...CODEX_EFFORTS],
      defaults: codexDefaults ?? {},
    },
  };
}

// ── naming a model for people ───────────────────────────────────────────────

const CLAUDE_FAMILY = /\b(opus|fable|sonnet|haiku)\b/i;

/** `claude-opus-5-5` → "Opus 5.5"; a name the agent already wrote for people stays as it is. */
export function claudeModelLabel(model: string): string {
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(\[1m\])?$/i.exec(model.trim());
  if (!id) return model;
  const family = id[1]!.charAt(0).toUpperCase() + id[1]!.slice(1).toLowerCase();
  return `${family} ${id[2]}${id[3] ? `.${id[3]}` : ""}${id[4] ? " (1M context)" : ""}`;
}

function codexCatalogModel(model: string, catalog: AgentSettingsCatalog | undefined): AgentModelChoice | undefined {
  const wanted = model.trim().toLowerCase();
  return catalog?.models.find((choice) => choice.id.toLowerCase() === wanted);
}

/** How long a change that didn't happen stays said on the row: long enough to be seen, not forever. */
export const FAILED_CHANGE_SHOWN_MS = 10 * 60_000;

/**
 * A row's settings as published: what it runs, how to say it, and a change in flight. A change
 * the session confirmed after its newest record is what it runs now: a Codex session with no
 * rollout yet, or a Claude reply still to come, has no record of it anywhere else.
 */
export function publishedSessionSettings(
  backend: SessionBackend,
  sample: SessionSettingsSample | null | undefined,
  latest: SessionSettingsChangeState | undefined,
  catalog: SessionSettingsCatalog | undefined,
  now = Date.now(),
): PublishedSessionSettings | undefined {
  const change = latest?.state === "failed" && now - latest.at > FAILED_CHANGE_SHOWN_MS ? undefined : latest;
  const agent = AGENT_SESSION_SETTINGS[backend];
  const agentCatalog = catalog?.[backend];
  const confirmed = change?.state === "applied" && (sample?.at === undefined || sample.at < change.startedAt);
  const model = (confirmed ? change.model : undefined) ?? sample?.model;
  const effort = (confirmed ? change.effort : undefined) ?? sample?.effort;
  const label = model === undefined ? undefined : agent.modelLabel(model, agentCatalog);
  const choice = model === undefined ? undefined : agent.modelChoice(model, agentCatalog);
  const published: PublishedSessionSettings = {
    ...(model ? { model } : {}),
    ...(label ? { modelLabel: label } : {}),
    ...(choice ? { modelChoice: choice } : {}),
    ...(effort ? { effort } : {}),
    ...(sample?.at !== undefined ? { at: sample.at } : {}),
    ...(change ? { change: { ...change } } : {}),
  };
  return Object.keys(published).length ? published : undefined;
}

/**
 * Switching model keeps the effort the session has when the new model takes it, rather than
 * the new model's default: Claude's picker carries it over by itself, Codex's resets it.
 */
export function withCarriedEffort(
  backend: SessionBackend,
  change: SessionSettingsChange,
  current: SessionSettingsSample | null | undefined,
  catalog: SessionSettingsCatalog | undefined,
): SessionSettingsChange {
  if (AGENT_SESSION_SETTINGS[backend].pickerKeepsEffort || !change.model || change.effort || !current?.effort) return change;
  const model = catalog?.[backend].models.find((choice) => choice.id.toLowerCase() === change.model!.toLowerCase());
  return model?.efforts?.includes(current.effort) ? { ...change, effort: current.effort } : change;
}

// ── driving the agent's own picker ──────────────────────────────────────────

/** What to do next on this screen of the picker. */
export type PickerStep =
  | { kind: "wait"; why: string }
  | { kind: "keys"; keys: AnswerKey[]; commit?: true }
  | { kind: "done"; message: string }
  /** The driver backs out of whatever is open (`pickerDepth` Escapes), so nothing is left half-chosen. */
  | { kind: "fail"; reason: string };

interface PickerRow {
  number: number;
  label: string;
  tag?: "current" | "default";
  highlighted: boolean;
}

interface PickerBlock {
  title: string;
  lines: string[];
}

/**
 * The picker on screen now: its last title, with a footer below it. A picker closes by
 * vanishing from the screen, so a title with no footer under it is not open.
 */
function pickerBlock(screen: string, titles: readonly RegExp[], footer: RegExp): PickerBlock | null {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!titles.some((title) => title.test(line))) continue;
    const rest = lines.slice(index + 1);
    const end = rest.findIndex((candidate) => footer.test(candidate));
    if (end < 0) return null;
    return { title: line.trim(), lines: rest.slice(0, end + 1) };
  }
  return null;
}

const ROW = /^\s*([❯›>])?\s*(\d+)\.\s+(.*\S)\s*$/;

function pickerRows(block: PickerBlock): PickerRow[] {
  const rows: PickerRow[] = [];
  for (const line of block.lines) {
    const match = ROW.exec(line);
    if (!match) continue;
    // Label, then the description after a gap of two or more spaces.
    let label = match[3]!.split(/\s{2,}/)[0]!.trim();
    let tag: PickerRow["tag"];
    if (/\s*✔$/.test(label)) {
      label = label.replace(/\s*✔$/, "");
      tag = "current";
    }
    const tagged = /\s+\((current|default)\)$/.exec(label);
    if (tagged) {
      label = label.slice(0, tagged.index);
      tag = tagged[1] === "current" ? "current" : tag ?? "default";
    }
    rows.push({ number: Number(match[2]), label, ...(tag ? { tag } : {}), highlighted: Boolean(match[1]) });
  }
  return rows;
}

/** Up or Down, from the highlighted row to the target, never wrapping. Null when already there. */
function moveKeys(rows: readonly PickerRow[], target: PickerRow): AnswerKey[] | null {
  const from = rows.findIndex((row) => row.highlighted);
  const to = rows.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  return Array.from({ length: Math.abs(to - from) }, (): AnswerKey => (to > from ? "Down" : "Up"));
}

/** Both agents say it while a turn runs. */
const BUSY = /esc to interrupt/i;

/** The last line a closed picker left behind that matches, if any. */
function lastResult(screen: string, pattern: RegExp): string | null {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!);
    if (match) return match[0]!.trim();
  }
  return null;
}

// Claude Code 2.1.280.
const CLAUDE_TITLES = [/^\s*Select model\s*$/];
const CLAUDE_FOOTER = /s to use this session only/;
/** The picker's ←/→ cycle, as measured; it wraps. */
const CLAUDE_EFFORT_CYCLE = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
const CLAUDE_EFFORT_LINE = /\b(Low|Medium|High|xHigh|Max|Ultracode) effort\b/;

function claudePrecheck(screen: string): string | null {
  if (BUSY.test(screen)) return "the session is working; change it when its turn is over";
  if (pickerBlock(screen, CLAUDE_TITLES, CLAUDE_FOOTER)) return "a picker is already open in the session";
  if (claudeInputBoxText(screen) === null) return "its prompt isn't on screen (a dialog may be open)";
  return null;
}

function claudeRowFor(rows: readonly PickerRow[], model: string): PickerRow | undefined {
  const wanted = model.trim().toLowerCase();
  if (wanted === "default") return rows.find((row) => /^default\b/i.test(row.label));
  const family = CLAUDE_FAMILY.exec(wanted)?.[1]?.toLowerCase() ?? wanted;
  const matching = rows.filter((row) => row.label.split(/[\s(]/)[0]!.toLowerCase() === family);
  const oneM = /\[1m\]|1m context/.test(wanted);
  return matching.find((row) => (oneM ? /1M context/i.test(row.label) : row.label.toLowerCase() === family))
    ?? matching[0];
}

export function planClaudePicker(screen: string, change: SessionSettingsChange, committed: boolean): PickerStep {
  const block = pickerBlock(screen, CLAUDE_TITLES, CLAUDE_FOOTER);
  if (!block) {
    if (!committed) return { kind: "wait", why: "the picker has not opened" };
    const result = lastResult(screen, /Set model to .*$/);
    if (result && /this session only/.test(result)) return { kind: "done", message: result };
    if (result && /saved as your default/.test(result)) {
      return { kind: "fail", reason: `Claude Code saved it as the default instead: ${result}` };
    }
    return { kind: "wait", why: "the picker has not confirmed" };
  }
  if (committed) return { kind: "wait", why: "the picker is closing" };
  const rows = pickerRows(block);
  const target = change.model ? claudeRowFor(rows, change.model) : rows.find((row) => row.tag === "current");
  if (!target) {
    return {
      kind: "fail",
      reason: change.model
        ? `"${change.model}" is not in this session's model list (${rows.map((row) => row.label).join(", ")})`
        : "the picker marks no model as current",
    };
  }
  const move = moveKeys(rows, target);
  if (move) return { kind: "keys", keys: move };
  if (change.effort) {
    const wanted = CLAUDE_EFFORT_CYCLE.indexOf(change.effort.toLowerCase() as (typeof CLAUDE_EFFORT_CYCLE)[number]);
    if (wanted < 0) return { kind: "fail", reason: `Claude Code has no "${change.effort}" effort` };
    const text = block.lines.join("\n");
    if (/Effort not supported/i.test(text)) return { kind: "fail", reason: `${target.label} takes no effort level` };
    const shown = CLAUDE_EFFORT_CYCLE.indexOf(
      CLAUDE_EFFORT_LINE.exec(text)?.[1]?.toLowerCase() as (typeof CLAUDE_EFFORT_CYCLE)[number],
    );
    if (shown < 0) return { kind: "fail", reason: "the picker shows no effort to adjust" };
    if (shown !== wanted) {
      const size = CLAUDE_EFFORT_CYCLE.length;
      const right = (wanted - shown + size) % size;
      const left = size - right;
      return {
        kind: "keys",
        keys: right <= left
          ? Array.from({ length: right }, (): AnswerKey => "Right")
          : Array.from({ length: left }, (): AnswerKey => "Left"),
      };
    }
  }
  // `s`: "use this session only". Enter or a digit would save it as the default for new sessions.
  return { kind: "keys", keys: [{ press: "s" }], commit: true };
}

// codex-cli 0.157.1.
const CODEX_MODEL_TITLE = /^\s*Select Model and Effort\s*$/;
const CODEX_LEVEL_TITLE = /^\s*Select Reasoning Level for (.+?)\s*$/;
const CODEX_ADVANCED_TITLE = /^\s*Advanced Reasoning\s*$/;
const CODEX_TITLES = [CODEX_MODEL_TITLE, CODEX_LEVEL_TITLE, CODEX_ADVANCED_TITLE];
const CODEX_FOOTER = /esc back/;

/** How Codex 0.157.1's picker names each effort. */
export const CODEX_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
  persistent: "Persistent",
};

function codexName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Escapes to close it: each one steps back a level (advanced → efforts → models → closed). */
function codexPickerDepth(screen: string): number {
  const block = pickerBlock(screen, CODEX_TITLES, CODEX_FOOTER);
  if (!block) return 0;
  return CODEX_ADVANCED_TITLE.test(block.title) ? 3 : CODEX_LEVEL_TITLE.test(block.title) ? 2 : 1;
}

/**
 * Codex's composer: the last `›` (or `»`) line on screen. Its empty placeholder ("Ask Codex to
 * do anything") reads as words in plain text, which is why the driver checks the prompt only
 * after typing into it, never before.
 */
export function codexComposerText(screen: string): string | null {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*[›»](?:\s(.*))?$/.exec(lines[index]!);
    if (match) return (match[1] ?? "").trim();
  }
  return null;
}

function codexPrecheck(screen: string): string | null {
  if (BUSY.test(screen)) return "the session is working; change it when its turn is over";
  if (codexPickerDepth(screen) > 0) return "a picker is already open in the session";
  if (codexComposerText(screen) === null) return "its prompt isn't on screen (a dialog may be open)";
  return null;
}

function codexEffortRow(rows: readonly PickerRow[], effort: string): PickerRow | undefined {
  const label = CODEX_EFFORT_LABELS[effort.toLowerCase()] ?? effort;
  return rows.find((row) => row.label.toLowerCase() === label.toLowerCase());
}

export function planCodexPicker(screen: string, change: SessionSettingsChange, committed: boolean): PickerStep {
  const block = pickerBlock(screen, CODEX_TITLES, CODEX_FOOTER);
  if (!block) {
    if (!committed) return { kind: "wait", why: "the picker has not opened" };
    const result = lastResult(screen, /Model changed to .*$/);
    if (result && /for this session only/.test(result)) return { kind: "done", message: result };
    return { kind: "wait", why: "the picker has not confirmed" };
  }
  if (committed) return { kind: "wait", why: "the picker is closing" };
  const rows = pickerRows(block);
  if (CODEX_MODEL_TITLE.test(block.title)) {
    const target = change.model
      ? rows.find((row) => codexName(row.label) === codexName(change.model!))
      : rows.find((row) => row.tag === "current");
    if (!target) {
      return {
        kind: "fail",
        reason: change.model
          ? `"${change.model}" is not in this session's model list (${rows.map((row) => row.label).join(", ")})`
          : "the picker marks no model as current",
      };
    }
    // Enter here only opens the model's efforts; nothing is chosen until `s` there.
    return { kind: "keys", keys: moveKeys(rows, target) ?? ["Enter"] };
  }
  const advanced = CODEX_ADVANCED_TITLE.test(block.title);
  const opened = CODEX_LEVEL_TITLE.exec(block.title)?.[1];
  if (opened && change.model && codexName(opened) !== codexName(change.model)) {
    return { kind: "fail", reason: `the picker opened ${opened}, not ${change.model}` };
  }
  // No effort asked for: the one the session has on this model, else what the picker offers first.
  const wanted = change.effort
    ?? rows.find((row) => row.tag === "current")?.label
    ?? rows.find((row) => row.highlighted)?.label;
  if (!wanted) return { kind: "fail", reason: "the picker shows no effort" };
  const target = codexEffortRow(rows, wanted);
  if (!target && !advanced) {
    // Max and Ultra sit one level down; Enter on "More reasoning…" opens them and chooses nothing.
    const more = rows.find((row) => /^More reasoning/i.test(row.label));
    if (more) return { kind: "keys", keys: moveKeys(rows, more) ?? ["Enter"] };
  }
  if (!target) return { kind: "fail", reason: `${opened ?? "this model"} doesn't offer "${wanted}" effort` };
  const move = moveKeys(rows, target);
  if (move) return { kind: "keys", keys: move };
  // `s`: "session". Enter or a digit here writes model and effort into config.toml.
  return { kind: "keys", keys: [{ press: "s" }], commit: true };
}

export interface SettingsDriverDeps {
  /** The session's screen now, or null when it can't be read. */
  read(): Promise<string | null>;
  /** Keys into the session; false when they did not go. */
  press(keys: readonly AnswerKey[]): Promise<boolean>;
  /** Words typed into the session's prompt and NOT submitted; false when they did not go. */
  type(words: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export type SettingsDriveOutcome = { ok: true; message: string } | { ok: false; reason: string };

/**
 * Change a running session through its own picker, reading the screen before every key.
 *
 * The opener is typed and checked before it is submitted: a prompt holding a draft would have
 * made `/model` part of a message, so anything but exactly `/model` in the prompt is backspaced
 * away and the draft is left as it was. Refuses rather than guesses — an unreadable screen, a
 * busy session, a choice the picker doesn't list — and backs out of anything it opened.
 */
export async function driveSessionSettings(
  backend: SessionBackend,
  change: SessionSettingsChange,
  deps: SettingsDriverDeps,
  limits: { settleMs?: number; maxSteps?: number; maxWaits?: number } = {},
): Promise<SettingsDriveOutcome> {
  if (!change.model && !change.effort) return { ok: false, reason: "nothing to change" };
  const agent = AGENT_SESSION_SETTINGS[backend];
  const settleMs = limits.settleMs ?? 350;
  const maxSteps = limits.maxSteps ?? 30;
  const maxWaits = limits.maxWaits ?? 12;
  const backOut = async (screen: string | null): Promise<void> => {
    const depth = screen === null ? 0 : agent.pickerDepth(screen);
    if (depth > 0) await deps.press(Array.from({ length: depth }, (): AnswerKey => "Escape"));
  };

  const before = await deps.read();
  if (before === null) return { ok: false, reason: "conch can't read the session's screen, so it won't drive its picker" };
  const refused = agent.precheck(before);
  if (refused) return { ok: false, reason: refused };

  const opener = agent.pickerCommand;
  if (!(await deps.type(opener))) return { ok: false, reason: `couldn't type ${opener} into the session` };
  await deps.sleep(settleMs);
  const typed = await deps.read();
  if (typed === null || agent.promptText(typed) !== opener) {
    // Whatever was there before is left exactly as it was.
    await deps.press(Array.from({ length: opener.length }, (): AnswerKey => "Backspace"));
    return {
      ok: false,
      reason: typed === null
        ? "lost sight of the session's screen, so conch took back what it typed"
        : "its prompt holds unsent words, so conch took back what it typed and left them alone",
    };
  }
  if (!(await deps.press(["Enter"]))) return { ok: false, reason: `couldn't open the session's ${opener} picker` };

  let committed = false;
  let waits = 0;
  let screen: string | null = typed;
  for (let step = 0; step < maxSteps; step += 1) {
    await deps.sleep(settleMs);
    screen = await deps.read();
    if (screen === null) return { ok: false, reason: "lost sight of the session's screen partway" };
    const next = agent.plan(screen, change, committed);
    if (next.kind === "done") return { ok: true, message: next.message };
    if (next.kind === "fail") {
      await backOut(screen);
      return { ok: false, reason: next.reason };
    }
    if (next.kind === "wait") {
      waits += 1;
      if (waits > maxWaits) break;
      continue;
    }
    waits = 0;
    if (!(await deps.press(next.keys))) return { ok: false, reason: "the keys didn't reach the session" };
    if (next.commit) committed = true;
  }
  if (!committed) {
    await backOut(screen);
    // The picker never opened: take back the `/model` still sitting in the prompt.
    if (screen !== null && agent.pickerDepth(screen) === 0 && agent.promptText(screen) === opener) {
      await deps.press(Array.from({ length: opener.length }, (): AnswerKey => "Backspace"));
    }
  }
  return {
    ok: false,
    reason: committed
      ? "the session didn't confirm the change; check its model before relying on it"
      : "the picker didn't do what conch expected, so conch backed out",
  };
}

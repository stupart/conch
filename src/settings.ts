import { connect } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import type { ResumableSession } from "./resumable.ts";
import { normalizeSessionLabel } from "./sessions.ts";
import { isValidVoiceName } from "./speak.ts";

export const DEFAULT_CONCH_CONFIG_DIR = join(homedir(), ".config", "conch");
export const SETTINGS_FILE = "settings.json";

export const SETTING_KEYS = [
  "end-silence",
  "mic-gain",
  "hold-submit-delay",
  "listen-window",
  "typing-grace",
  "away-after",
  "barge-threshold",
  "voice-speed",
  "keystroke-fallback",
  "bypass-permissions",
  "phone",
  "phone-port",
  "phone-relay-url",
  "read-full",
  "interrupt-on-manual-reply",
  "handoff-order",
  "reveal-on-turn",
  "reveal-typing-grace",
  "working-mic",
  "voice-qa",
  "announce-summary",
  "haiku-timeout",
  "meeting-autopause",
  "announce-sentences",
  "announce-max-chars",
  "say-rate",
] as const;

export type SettingKey = typeof SETTING_KEYS[number];
export type SettingField =
  | "bypassPermissions"
  | "endSilenceSecs"
  | "micGainDb"
  | "holdSubmitSecs"
  | "listenWindowSecs"
  | "typingGraceSecs"
  | "awayAfterSecs"
  | "bargeThresholdPct"
  | "ttsSpeed"
  | "keystrokeFallback"
  | "phoneEnabled"
  | "phonePort"
  | "phoneRelayURL"
  | "readFull"
  | "interruptOnManualReply"
  | "handoffOrder"
  | "revealOnTurn"
  | "revealTypingGraceSecs"
  | "workingMic"
  | "voiceQa"
  | "announceSummary"
  | "haikuTimeoutSecs"
  | "meetingAutopause"
  | "speakSentences"
  | "speakMaxChars"
  | "sayRate";
export type HandoffOrder = "newest" | "oldest" | "urgency";
export type SettingValue = number | boolean | string;
export type SettingApply = "live" | "hook";
export type SettingSource = "env" | "file" | "default";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; err: string };

export interface SettingBounds {
  min?: number;
  max?: number;
  minInclusive?: boolean;
  maxInclusive?: boolean;
  integer?: boolean;
}

export interface SettingDescriptor {
  key: SettingKey;
  field: SettingField;
  env: string;
  kind: "number" | "integer" | "boolean" | "enum" | "string";
  default: SettingValue;
  parse(raw: unknown): ParseResult<SettingValue>;
  bounds: SettingBounds | null;
  choices?: readonly SettingValue[];
  apply: SettingApply;
  help: string;
}

function parseBoolean(raw: unknown): ParseResult<boolean> {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return { ok: true, value: true };
    if (normalized === "false" || normalized === "0") return { ok: true, value: false };
  }
  return { ok: false, err: "expected true/false or 1/0" };
}

function parseHandoffOrder(raw: unknown): ParseResult<HandoffOrder> {
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "newest" || normalized === "oldest" || normalized === "urgency") {
      return { ok: true, value: normalized };
    }
  }
  return { ok: false, err: "expected newest, oldest, or urgency" };
}

function parseRelayURL(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string") return { ok: false, err: "expected an https or wss URL" };
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "wss:")
      || !url.hostname || url.username || url.password || url.hash || url.search) {
      return { ok: false, err: "expected an https or wss URL without credentials, query, or fragment" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, err: "expected an https or wss URL" };
  }
}

function numberParser(bounds: SettingBounds, description: string): (raw: unknown) => ParseResult<number> {
  return (raw) => {
    if (typeof raw !== "number" && typeof raw !== "string") {
      return { ok: false, err: `expected ${description}` };
    }
    if (typeof raw === "string" && !raw.trim()) return { ok: false, err: `expected ${description}` };
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) return { ok: false, err: `expected ${description}` };
    if (bounds.integer && !Number.isInteger(value)) return { ok: false, err: `expected ${description}` };
    if (bounds.min !== undefined) {
      const valid = bounds.minInclusive === false ? value > bounds.min : value >= bounds.min;
      if (!valid) return { ok: false, err: `expected ${description}` };
    }
    if (bounds.max !== undefined) {
      const valid = bounds.maxInclusive === false ? value < bounds.max : value <= bounds.max;
      if (!valid) return { ok: false, err: `expected ${description}` };
    }
    return { ok: true, value };
  };
}

const positive = { min: 0, minInclusive: false } satisfies SettingBounds;
const zeroable = { min: 0, minInclusive: true } satisfies SettingBounds;
const percentage = { min: 0, max: 100, minInclusive: true, maxInclusive: true } satisfies SettingBounds;
const micGain = { min: -20, max: 30, minInclusive: true, maxInclusive: true } satisfies SettingBounds;
const haikuTimeout = { min: 1, max: 60, minInclusive: true, maxInclusive: true } satisfies SettingBounds;
const positiveInteger = { min: 1, minInclusive: true, integer: true } satisfies SettingBounds;
const zeroableInteger = { min: 0, minInclusive: true, integer: true } satisfies SettingBounds;

export const SETTING_DESCRIPTORS = [
  {
    key: "end-silence",
    field: "endSilenceSecs",
    env: "CONCH_END_SILENCE_SECS",
    kind: "number",
    default: 3.5,
    parse: numberParser(positive, "a number greater than 0"),
    bounds: positive,
    apply: "live",
    help: "pause that ends an utterance, in seconds",
  },
  {
    key: "mic-gain",
    field: "micGainDb",
    env: "CONCH_MIC_GAIN_DB",
    kind: "number",
    default: 0,
    parse: numberParser(micGain, "a number from -20 to 30"),
    bounds: micGain,
    apply: "live",
    help: "software gain in dB added to mic capture (sox); lifts a quiet mic without touching the system input; 0 = off",
  },
  {
    key: "hold-submit-delay",
    field: "holdSubmitSecs",
    env: "CONCH_HOLD_SUBMIT_SECS",
    kind: "number",
    default: 8,
    parse: numberParser(positive, "a number greater than 0"),
    bounds: positive,
    apply: "live",
    help: "silence before held dictation submits, in seconds",
  },
  {
    key: "listen-window",
    field: "listenWindowSecs",
    env: "CONCH_LISTEN_WINDOW_SECS",
    kind: "number",
    default: 30,
    parse: numberParser(positive, "a number greater than 0"),
    bounds: positive,
    apply: "live",
    help: "time to start speaking before the mic closes, in seconds",
  },
  {
    key: "typing-grace",
    field: "typingGraceSecs",
    env: "CONCH_TYPING_GRACE_SECS",
    kind: "number",
    default: 2,
    parse: numberParser(zeroable, "a number at least 0"),
    bounds: zeroable,
    apply: "live",
    help: "recent-input window that keeps an automatic turn visual; 0 disables",
  },
  {
    key: "barge-threshold",
    field: "bargeThresholdPct",
    env: "CONCH_BARGE_THRESHOLD_PCT",
    kind: "number",
    default: 0,
    parse: numberParser(percentage, "a number from 0 to 100"),
    bounds: percentage,
    apply: "live",
    help: "mic level that interrupts speech; 0 disables barge-in",
  },
  {
    key: "voice-speed",
    field: "ttsSpeed",
    env: "CONCH_TTS_SPEED",
    kind: "number",
    default: 1.35,
    parse: numberParser(positive, "a number greater than 0"),
    bounds: positive,
    apply: "live",
    help: "Kokoro/voice synthesis speed",
  },
  {
    key: "bypass-permissions",
    field: "bypassPermissions",
    env: "CONCH_BYPASS_PERMISSIONS",
    kind: "boolean",
    // Off, and it ships off. conch starts sessions on someone else's machine
    // from a list they can scroll; a tool that quietly removes every
    // confirmation from those sessions is not a default anyone should inherit.
    // Turning it on has to be a thing you did.
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "start sessions with all permission prompts skipped (claude --dangerously-skip-permissions, codex --dangerously-bypass-approvals-and-sandbox)",
  },
  {
    key: "keystroke-fallback",
    field: "keystrokeFallback",
    env: "CONCH_KEYSTROKE_FALLBACK",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "type into the session's window when it isn't in a tmux pane",
  },
  {
    key: "away-after",
    field: "awayAfterSecs",
    env: "CONCH_AWAY_AFTER_SECS",
    kind: "number",
    // ON by default. With this at 0 the away check is skipped entirely, and
    // conch opened the mic and injected what the ROOM said into a live session
    // while Tyler was not there — a stray conversation became a prompt an agent
    // then acted on. Five minutes with no keyboard or mouse means you are not
    // at this machine. `conch wake` and the spacebar are exempt, so deliberately
    // talking always works, and 0 remains the documented "never".
    default: 300,
    parse: numberParser(zeroable, "a number of seconds (0 disables)"),
    bounds: zeroable,
    apply: "live",
    help: "stay quiet after this many seconds away from the Mac (0 never)",
  },
  {
    key: "phone",
    field: "phoneEnabled",
    env: "CONCH_PHONE",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "let the conch iPhone app connect over Wi-Fi (run `conch pair`)",
  },
  {
    key: "phone-port",
    field: "phonePort",
    env: "CONCH_PHONE_PORT",
    kind: "number",
    default: 8674,
    parse: numberParser(positive, "a number greater than 0"),
    bounds: positive,
    apply: "live",
    help: "port the phone bridge listens on",
  },
  {
    key: "phone-relay-url",
    field: "phoneRelayURL",
    env: "CONCH_PHONE_RELAY_URL",
    kind: "string",
    default: "",
    parse: parseRelayURL,
    bounds: null,
    apply: "live",
    help: "deployed relay Worker URL; empty disables internet relay while LAN pairing stays available",
  },
  {
    key: "read-full",
    field: "readFull",
    env: "CONCH_READ_FULL",
    kind: "boolean",
    default: true,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "read the full final response aloud",
  },
  {
    key: "interrupt-on-manual-reply",
    field: "interruptOnManualReply",
    env: "CONCH_INTERRUPT_ON_MANUAL_REPLY",
    kind: "boolean",
    default: true,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "stop reading/listening when you reply to that session by text",
  },
  {
    key: "handoff-order",
    field: "handoffOrder",
    env: "CONCH_HANDOFF_ORDER",
    kind: "enum",
    default: "oldest",
    parse: parseHandoffOrder,
    bounds: null,
    choices: ["newest", "oldest", "urgency"],
    apply: "live",
    help: "choose queued sessions by newest, oldest, or urgency",
  },
  {
    key: "reveal-on-turn",
    field: "revealOnTurn",
    env: "CONCH_REVEAL_ON_TURN",
    kind: "boolean",
    default: true,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "raise a session window when conch starts talking to it",
  },
  {
    key: "reveal-typing-grace",
    field: "revealTypingGraceSecs",
    env: "CONCH_REVEAL_TYPING_GRACE_SECS",
    kind: "number",
    default: 2,
    parse: numberParser(zeroable, "a number at least 0"),
    bounds: zeroable,
    apply: "live",
    help: "don't raise a window if you touched the keyboard/mouse within this many seconds — never yank a window to the front mid-keystroke; 0 = always raise",
  },
  {
    key: "working-mic",
    field: "workingMic",
    env: "CONCH_WORKING_MIC",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "announce and open the mic while background work remains",
  },
  {
    key: "voice-qa",
    field: "voiceQa",
    env: "CONCH_VOICE_QA",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "answer conch-prefixed questions from the current session without injecting them",
  },
  {
    key: "announce-summary",
    field: "announceSummary",
    env: "CONCH_ANNOUNCE_SUMMARY",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "hook",
    help: "summarize long replies in one spoken sentence for the next hook announcement",
  },
  {
    key: "haiku-timeout",
    field: "haikuTimeoutSecs",
    env: "CONCH_HAIKU_TIMEOUT_SECS",
    kind: "number",
    default: 10,
    parse: numberParser(haikuTimeout, "a number from 1 to 60"),
    bounds: haikuTimeout,
    apply: "live",
    help: "seconds the fast model (Haiku) may take for a spoken summary or voice answer before falling back",
  },
  {
    key: "meeting-autopause",
    field: "meetingAutopause",
    env: "CONCH_MEETING_AUTOPAUSE",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "pause while another app is using the default microphone",
  },
  {
    key: "announce-sentences",
    field: "speakSentences",
    env: "CONCH_SPEAK_SENTENCES",
    kind: "integer",
    default: 2,
    parse: numberParser(positiveInteger, "an integer at least 1"),
    bounds: positiveInteger,
    apply: "hook",
    help: "leading sentences spoken by the next hook announcement",
  },
  {
    key: "announce-max-chars",
    field: "speakMaxChars",
    env: "CONCH_SPEAK_MAX_CHARS",
    kind: "integer",
    default: 350,
    parse: numberParser(positiveInteger, "an integer greater than 0"),
    bounds: positiveInteger,
    apply: "hook",
    help: "character cap for the next hook announcement",
  },
  {
    key: "say-rate",
    field: "sayRate",
    env: "CONCH_SAY_RATE",
    kind: "integer",
    default: 210,
    parse: numberParser(zeroableInteger, "an integer at least 0"),
    bounds: zeroableInteger,
    apply: "live",
    help: "macOS say words per minute; 0 uses the system default",
  },
] as const satisfies readonly SettingDescriptor[];

export const SETTING_REGISTRY: ReadonlyMap<string, SettingDescriptor> = new Map(
  SETTING_DESCRIPTORS.map((descriptor) => [descriptor.key, descriptor]),
);

/** Accepted for migration, but deliberately absent from descriptors/presentation. */
const SETTING_ALIASES: ReadonlyMap<string, SettingKey> = new Map([
  ["kokoro-speed", "voice-speed"],
]);

const FILE_ALIASES: Partial<Record<SettingKey, readonly string[]>> = {
  "voice-speed": ["kokoro-speed"],
};

function aliasesFor(descriptor: SettingDescriptor): readonly string[] {
  return FILE_ALIASES[descriptor.key] ?? [];
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor"]);

export function getSettingDescriptor(key: unknown): ParseResult<SettingDescriptor> {
  if (typeof key !== "string") return { ok: false, err: "setting key must be a string" };
  if (FORBIDDEN_KEYS.has(key)) return { ok: false, err: `setting key "${key}" is not allowed` };
  const canonical = SETTING_ALIASES.get(key) ?? key;
  const descriptor = SETTING_REGISTRY.get(canonical);
  if (!descriptor) return { ok: false, err: `unknown setting "${key}"` };
  return { ok: true, value: descriptor };
}

export type ParsedSetting = { descriptor: SettingDescriptor; value: SettingValue };

export function parseSetting(key: unknown, raw: unknown): ParseResult<ParsedSetting> {
  const found = getSettingDescriptor(key);
  if (!found.ok) return found;
  const parsed = found.value.parse(raw);
  if (!parsed.ok) return { ok: false, err: `${found.value.key}: ${parsed.err}` };
  return { ok: true, value: { descriptor: found.value, value: parsed.value } };
}

export interface LoadedSettings {
  path: string;
  exists: boolean;
  values: Record<string, unknown>;
  error?: string;
}

function emptySettings(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function settingsPathFor(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(env.CONCH_CONFIG_DIR ?? DEFAULT_CONCH_CONFIG_DIR, SETTINGS_FILE);
}

export function loadSettingsFile(path = settingsPathFor()): LoadedSettings {
  if (!existsSync(path)) return { path, exists: false, values: emptySettings() };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { path, exists: true, values: emptySettings(), error: `invalid settings file ${path}: expected a JSON object` };
    }
    const values = emptySettings();
    for (const key of Object.keys(parsed)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return { path, exists: true, values: emptySettings(), error: `invalid settings file ${path}: forbidden key "${key}"` };
      }
      values[key] = (parsed as Record<string, unknown>)[key];
    }
    return { path, exists: true, values };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { path, exists: true, values: emptySettings(), error: `invalid settings file ${path}: ${detail}` };
  }
}

export class SettingsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsFileError";
  }
}

/**
 * Same-directory rename keeps readers atomic. Callers are intentionally
 * single-writer: concurrent CLI writers are last-writer-wins.
 */
export function writeSettingsFileAtomic(path: string, values: Readonly<Record<string, unknown>>): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${SETTINGS_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(values, null, 2) + "\n", "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {}
  }
}

function settingsForWrite(path: string): Record<string, unknown> {
  const loaded = loadSettingsFile(path);
  if (loaded.error) throw new SettingsFileError(`${loaded.error}; file left unchanged`);
  return loaded.values;
}

export function writeSetting(path: string, key: unknown, raw: unknown): ParsedSetting {
  const parsed = parseSetting(key, raw);
  if (!parsed.ok) throw new SettingsFileError(parsed.err);
  const values = settingsForWrite(path);
  values[parsed.value.descriptor.key] = parsed.value.value;
  for (const alias of aliasesFor(parsed.value.descriptor)) delete values[alias];
  writeSettingsFileAtomic(path, values);
  return parsed.value;
}

export function unsetSetting(path: string, key: unknown): { descriptor: SettingDescriptor; changed: boolean } {
  const found = getSettingDescriptor(key);
  if (!found.ok) throw new SettingsFileError(found.err);
  const values = settingsForWrite(path);
  const keys = [found.value.key, ...aliasesFor(found.value)];
  const changed = keys.some((candidate) => Object.hasOwn(values, candidate));
  if (changed) {
    for (const candidate of keys) delete values[candidate];
    writeSettingsFileAtomic(path, values);
  }
  return { descriptor: found.value, changed };
}

export interface SettingResolution {
  value: SettingValue;
  source: SettingSource;
  diagnostic?: string;
}

export interface ResolveSettingOptions {
  env?: Readonly<Record<string, string | undefined>>;
  settingsPath?: string;
  loaded?: LoadedSettings;
  includeEnv?: boolean;
  includeFile?: boolean;
}

export function resolveSettingFromLoaded(
  descriptor: SettingDescriptor,
  env: Readonly<Record<string, string | undefined>>,
  loaded: LoadedSettings,
  includeEnv = true,
  includeFile = true,
): SettingResolution {
  const diagnostics: string[] = [];
  if (includeEnv && env[descriptor.env] !== undefined) {
    const parsed = descriptor.parse(env[descriptor.env]);
    if (parsed.ok) return { value: parsed.value, source: "env" };
    diagnostics.push(`invalid ${descriptor.env}: ${parsed.err}`);
  }
  if (includeFile) {
    if (loaded.error) {
      diagnostics.push(loaded.error);
    } else {
      const fileKey = Object.hasOwn(loaded.values, descriptor.key)
        ? descriptor.key
        : aliasesFor(descriptor).find((alias) => Object.hasOwn(loaded.values, alias));
      if (!fileKey) {
        return {
          value: descriptor.default,
          source: "default",
          ...(diagnostics.length ? { diagnostic: diagnostics.join("; ") } : {}),
        };
      }
      const parsed = descriptor.parse(loaded.values[fileKey]);
      if (parsed.ok) {
        return {
          value: parsed.value,
          source: "file",
          ...(diagnostics.length ? { diagnostic: diagnostics.join("; ") } : {}),
        };
      }
      diagnostics.push(`invalid file value for ${fileKey}: ${parsed.err}`);
    }
  }
  return {
    value: descriptor.default,
    source: "default",
    ...(diagnostics.length ? { diagnostic: diagnostics.join("; ") } : {}),
  };
}

export function resolveSetting(key: unknown, options: ResolveSettingOptions = {}): ParseResult<SettingResolution> {
  const found = getSettingDescriptor(key);
  if (!found.ok) return found;
  const env = options.env ?? process.env;
  const loaded = options.loaded ?? loadSettingsFile(options.settingsPath ?? settingsPathFor(env));
  return {
    ok: true,
    value: resolveSettingFromLoaded(
      found.value,
      env,
      loaded,
      options.includeEnv ?? true,
      options.includeFile ?? true,
    ),
  };
}

export type SettingResolutions = Record<SettingKey, SettingResolution>;

export function loadSettingResolutions(options: Omit<ResolveSettingOptions, "loaded"> = {}): SettingResolutions {
  const env = options.env ?? process.env;
  const loaded = loadSettingsFile(options.settingsPath ?? settingsPathFor(env));
  const resolutions = Object.create(null) as SettingResolutions;
  for (const descriptor of SETTING_DESCRIPTORS) {
    resolutions[descriptor.key] = resolveSettingFromLoaded(
      descriptor,
      env,
      loaded,
      options.includeEnv ?? true,
      options.includeFile ?? true,
    );
  }
  return resolutions;
}

export type ConfigControlMessage =
  | { kind: "set-config"; key: SettingKey; value: SettingValue }
  | { kind: "get-config" }
  | { kind: "unset-config"; key: SettingKey };

export const SESSION_COMMANDS = [
  "rename",
  "set-voice",
  "reset-voice",
  "prioritize",
  "dismiss",
  "restore",
] as const;

export type SessionCommand = typeof SESSION_COMMANDS[number];

export type SessionControlMessage =
  | { kind: "session-command"; sessionId: string; command: "rename"; label: string }
  | { kind: "session-command"; sessionId: string; command: "set-voice"; voice: string }
  | { kind: "session-command"; sessionId: string; command: "reset-voice" }
  | { kind: "session-command"; sessionId: string; command: "prioritize"; value: boolean }
  | { kind: "session-command"; sessionId: string; command: "dismiss" }
  | { kind: "session-command"; sessionId: string; command: "restore" };

export type RuntimeControlMessage =
  | { kind: "resumable"; query?: string; limit?: number }
  | {
    kind: "session-start";
    backend: "claude" | "codex";
    resumeSessionId?: string;
    /** Optional because a phone has no meaningful Mac filesystem picker. */
    cwd?: string;
  }
  | { kind: "session-close"; sessionId: string }
  | {
    kind: "app-error";
    source: "ios" | "mac";
    operation: string;
    message: string;
    sessionId?: string;
    state: Record<string, unknown>;
  };

export type ControlMessage = ConfigControlMessage | SessionControlMessage;
export type AnyControlMessage = ControlMessage | RuntimeControlMessage;

export interface ConfigSnapshotEntry extends SettingResolution {
  kind: SettingDescriptor["kind"];
  bounds: SettingBounds | null;
  choices?: readonly SettingValue[];
  default: SettingValue;
  help: string;
}
export type ConfigSnapshot = Record<SettingKey, ConfigSnapshotEntry>;

/** Attach presentation metadata from the registry to one resolved wire value. */
export function configSnapshotEntry(
  descriptor: SettingDescriptor,
  resolution: SettingResolution,
): ConfigSnapshotEntry {
  return {
    ...resolution,
    kind: descriptor.kind,
    bounds: descriptor.bounds,
    ...(descriptor.choices === undefined ? {} : { choices: descriptor.choices }),
    default: descriptor.default,
    help: descriptor.help,
  };
}

export type ConfigAck = {
  kind: "config-ack";
  key: SettingKey;
  action: "set" | "unset";
  status: "applied" | "masked" | "hook-next";
  effective: SettingValue;
  source: SettingSource;
  env?: string;
  diagnostic?: string;
};

export type ConfigControlResponse =
  | ConfigAck
  | { kind: "config-snapshot"; snapshot: ConfigSnapshot; diagnostic?: undefined }
  | { kind: "config-error"; error: string; diagnostic?: undefined };

export type SessionAck = {
  kind: "session-ack";
  sessionId: string;
  command: SessionCommand;
  label?: string;
  changed: boolean;
};

export type SessionError = { kind: "session-error"; error: string };
/// The daemon's answer to `open-pairing`.
///
/// This was missing from the response union, so every reply to `conch pair`
/// failed validation and surfaced as "couldn't open a pairing window — is the
/// daemon running?" while the daemon was running perfectly and answering
/// correctly. The workaround was handing over the raw 32-char token by hand,
/// which is why pairing felt like typing a hash.
export interface PairingOpen {
  kind: "pairing-open";
  code: string;
  expiresAt: number;
  port: number;
  relay?: {
    version: 1;
    endpoint: string;
    roomId: string;
    secret: string;
    createdAt: number;
  };
}

export type RuntimeControlResponse =
  | { kind: "resumable"; sessions: ResumableSession[]; complete: boolean }
  | {
    kind: "session-started";
    backend: "claude" | "codex";
    resumed: boolean;
    /** The terminal will ask you to trust this folder before the agent starts. */
    awaitingTrust?: boolean;
  }
  | { kind: "session-closed"; sessionId: string }
  | { kind: "app-error-ack" };

export type SessionControlResponse = SessionAck | SessionError | PairingOpen | RuntimeControlResponse;
export type ControlResponse = ConfigControlResponse | SessionControlResponse;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSettingKind(value: unknown): value is SettingDescriptor["kind"] {
  return value === "number" || value === "integer" || value === "boolean"
    || value === "enum" || value === "string";
}

function validateSnapshotBounds(value: unknown): ParseResult<SettingBounds | null> {
  if (value === null) return { ok: true, value: null };
  if (!record(value)) return { ok: false, err: "bounds must be an object or null" };
  for (const key of ["min", "max"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
      return { ok: false, err: `${key} bound must be a finite number` };
    }
  }
  for (const key of ["minInclusive", "maxInclusive", "integer"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return { ok: false, err: `${key} bound must be boolean` };
    }
  }
  return {
    ok: true,
    value: {
      ...(value.min === undefined ? {} : { min: value.min as number }),
      ...(value.max === undefined ? {} : { max: value.max as number }),
      ...(value.minInclusive === undefined ? {} : { minInclusive: value.minInclusive as boolean }),
      ...(value.maxInclusive === undefined ? {} : { maxInclusive: value.maxInclusive as boolean }),
      ...(value.integer === undefined ? {} : { integer: value.integer as boolean }),
    },
  };
}

export function isControlMessageCandidate(value: unknown): boolean {
  if (!record(value) || !Object.hasOwn(value, "kind")) return false;
  return value.kind === "set-config"
    || value.kind === "get-config"
    || value.kind === "unset-config"
    || value.kind === "session-command"
    || value.kind === "resumable"
    || value.kind === "session-start"
    || value.kind === "session-close"
    || value.kind === "app-error";
}

const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_LABEL_INPUT_LENGTH = 4_096;
const MAX_ERROR_OPERATION_LENGTH = 200;
const MAX_ERROR_MESSAGE_LENGTH = 8_192;
const MAX_ERROR_STATE_LENGTH = 32 * 1024;
const SESSION_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

function validateSessionId(value: unknown): ParseResult<string> {
  if (typeof value !== "string") return { ok: false, err: "session id must be a string" };
  const id = value.trim();
  if (!id) return { ok: false, err: "session id cannot be empty" };
  if (id.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, err: `session id cannot exceed ${MAX_SESSION_ID_LENGTH} characters` };
  }
  if (SESSION_CONTROL_CHARS.test(id)) {
    return { ok: false, err: "session id cannot contain control characters" };
  }
  if (FORBIDDEN_KEYS.has(id)) return { ok: false, err: `session id "${id}" is not allowed` };
  return { ok: true, value: id };
}

function validateSessionLabel(value: unknown): ParseResult<string> {
  if (typeof value !== "string") return { ok: false, err: "session label must be a string" };
  if (value.length > MAX_SESSION_LABEL_INPUT_LENGTH) {
    return { ok: false, err: `session label cannot exceed ${MAX_SESSION_LABEL_INPUT_LENGTH} characters` };
  }
  try {
    const label = normalizeSessionLabel(value);
    if (SESSION_CONTROL_CHARS.test(value)) {
      return { ok: false, err: "session label cannot contain control characters" };
    }
    return { ok: true, value: label };
  } catch (error) {
    return {
      ok: false,
      err: error instanceof Error ? error.message : String(error),
    };
  }
}

function validSessionCommand(value: unknown): value is SessionCommand {
  return SESSION_COMMANDS.some((command) => value === command);
}

export function validateSessionControlMessage(value: unknown): ParseResult<SessionControlMessage> {
  if (!record(value)) return { ok: false, err: "session command must be a JSON object" };
  if (value.kind !== "session-command") return { ok: false, err: "session command kind is required" };
  const sessionId = validateSessionId(value.sessionId);
  if (!sessionId.ok) return sessionId;
  if (!validSessionCommand(value.command)) {
    return { ok: false, err: `unknown session command "${String(value.command)}"` };
  }

  switch (value.command) {
    case "rename": {
      if (!Object.hasOwn(value, "label")) return { ok: false, err: "rename: label is required" };
      const label = validateSessionLabel(value.label);
      if (!label.ok) return label;
      return { ok: true, value: { kind: "session-command", sessionId: sessionId.value, command: "rename", label: label.value } };
    }
    case "set-voice": {
      if (!Object.hasOwn(value, "voice") || typeof value.voice !== "string") {
        return { ok: false, err: "set-voice: voice is required" };
      }
      const voice = value.voice.trim();
      if (!isValidVoiceName(voice)) return { ok: false, err: `invalid TTS voice: ${value.voice}` };
      return { ok: true, value: { kind: "session-command", sessionId: sessionId.value, command: "set-voice", voice } };
    }
    case "prioritize":
      if (!Object.hasOwn(value, "value") || typeof value.value !== "boolean") {
        return { ok: false, err: "prioritize: value must be boolean" };
      }
      return { ok: true, value: { kind: "session-command", sessionId: sessionId.value, command: "prioritize", value: value.value } };
    case "reset-voice":
    case "dismiss":
    case "restore":
      return { ok: true, value: { kind: "session-command", sessionId: sessionId.value, command: value.command } };
  }
}

function boundedPrintable(value: unknown, name: string, max: number): ParseResult<string> {
  if (typeof value !== "string") return { ok: false, err: `${name} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, err: `${name} cannot be empty` };
  if (trimmed.length > max) return { ok: false, err: `${name} cannot exceed ${max} characters` };
  if (SESSION_CONTROL_CHARS.test(trimmed)) return { ok: false, err: `${name} cannot contain control characters` };
  return { ok: true, value: trimmed };
}

/** Runtime actions are validated separately because they perform process/UI side effects. */
export function validateRuntimeControlMessage(value: unknown): ParseResult<RuntimeControlMessage> {
  if (!record(value) || typeof value.kind !== "string") {
    return { ok: false, err: "runtime control message must be a JSON object with a kind" };
  }
  if (value.kind === "resumable") {
    let query: string | undefined;
    if (value.query !== undefined) {
      if (typeof value.query !== "string") return { ok: false, err: "resumable query must be a string" };
      const trimmed = value.query.trim();
      if (trimmed.length > 1_000) return { ok: false, err: "resumable query cannot exceed 1000 characters" };
      if (SESSION_CONTROL_CHARS.test(trimmed)) {
        return { ok: false, err: "resumable query cannot contain control characters" };
      }
      query = trimmed || undefined;
    }
    let limit: number | undefined;
    if (value.limit !== undefined) {
      if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 500) {
        return { ok: false, err: "resumable limit must be an integer from 1 to 500" };
      }
      limit = value.limit as number;
    }
    return {
      ok: true,
      value: {
        kind: "resumable",
        ...(query ? { query } : {}),
        ...(limit === undefined ? {} : { limit }),
      },
    };
  }
  if (value.kind === "session-close") {
    const sessionId = validateSessionId(value.sessionId);
    return sessionId.ok
      ? { ok: true, value: { kind: "session-close", sessionId: sessionId.value } }
      : sessionId;
  }
  if (value.kind === "session-start") {
    if (value.backend !== "claude" && value.backend !== "codex") {
      return { ok: false, err: "session backend must be claude or codex" };
    }
    let resumeSessionId: string | undefined;
    if (value.resumeSessionId !== undefined) {
      const validated = validateSessionId(value.resumeSessionId);
      if (!validated.ok) return validated;
      resumeSessionId = validated.value;
    }
    let cwd: string | undefined;
    if (value.cwd !== undefined) {
      const validated = boundedPrintable(value.cwd, "cwd", 4_096);
      if (!validated.ok) return validated;
      if (!validated.value.startsWith("/")) return { ok: false, err: "cwd must be an absolute path" };
      cwd = validated.value;
    }
    return {
      ok: true,
      value: {
        kind: "session-start",
        backend: value.backend,
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(cwd ? { cwd } : {}),
      },
    };
  }
  if (value.kind === "app-error") {
    if (value.source !== "ios" && value.source !== "mac") {
      return { ok: false, err: "app error source must be ios or mac" };
    }
    const operation = boundedPrintable(value.operation, "operation", MAX_ERROR_OPERATION_LENGTH);
    if (!operation.ok) return operation;
    const message = boundedPrintable(value.message, "message", MAX_ERROR_MESSAGE_LENGTH);
    if (!message.ok) return message;
    let sessionId: string | undefined;
    if (value.sessionId !== undefined) {
      const validated = validateSessionId(value.sessionId);
      if (!validated.ok) return validated;
      sessionId = validated.value;
    }
    if (!record(value.state)) return { ok: false, err: "app error state must be an object" };
    let stateLength: number;
    try {
      stateLength = JSON.stringify(value.state).length;
    } catch {
      return { ok: false, err: "app error state must be JSON serializable" };
    }
    if (stateLength > MAX_ERROR_STATE_LENGTH) {
      return { ok: false, err: `app error state cannot exceed ${MAX_ERROR_STATE_LENGTH} characters` };
    }
    return {
      ok: true,
      value: {
        kind: "app-error",
        source: value.source,
        operation: operation.value,
        message: message.value,
        ...(sessionId ? { sessionId } : {}),
        state: value.state,
      },
    };
  }
  return { ok: false, err: `unknown runtime control message kind "${value.kind}"` };
}

export function validateControlMessage(value: unknown): ParseResult<AnyControlMessage> {
  if (!record(value)) return { ok: false, err: "control message must be a JSON object" };
  if (!Object.hasOwn(value, "kind") || typeof value.kind !== "string") {
    return { ok: false, err: "control message kind is required" };
  }
  if (value.kind === "session-command") return validateSessionControlMessage(value);
  if (
    value.kind === "resumable"
    || value.kind === "session-start"
    || value.kind === "session-close"
    || value.kind === "app-error"
  ) {
    return validateRuntimeControlMessage(value);
  }
  if (value.kind === "get-config") return { ok: true, value: { kind: "get-config" } };
  if (value.kind !== "set-config" && value.kind !== "unset-config") {
    return { ok: false, err: `unknown control message kind "${value.kind}"` };
  }
  const found = getSettingDescriptor(value.key);
  if (!found.ok) return found;
  if (value.kind === "unset-config") {
    return { ok: true, value: { kind: "unset-config", key: found.value.key } };
  }
  if (!Object.hasOwn(value, "value")) return { ok: false, err: `${found.value.key}: value is required` };
  const parsed = found.value.parse(value.value);
  if (!parsed.ok) return { ok: false, err: `${found.value.key}: ${parsed.err}` };
  return { ok: true, value: { kind: "set-config", key: found.value.key, value: parsed.value } };
}

export function validateControlResponse(value: unknown): ParseResult<ControlResponse> {
  if (!record(value) || typeof value.kind !== "string") return { ok: false, err: "invalid control response" };
  if (value.kind === "resumable") {
    if (!Array.isArray(value.sessions) || value.sessions.length > 500 || typeof value.complete !== "boolean") {
      return { ok: false, err: "invalid resumable sessions response" };
    }
    const sessions: ResumableSession[] = [];
    for (const raw of value.sessions) {
      if (!record(raw) || (raw.backend !== "claude" && raw.backend !== "codex")) {
        return { ok: false, err: "invalid resumable session" };
      }
      const sessionId = validateSessionId(raw.sessionId);
      if (!sessionId.ok) return { ok: false, err: `invalid resumable session: ${sessionId.err}` };
      const label = boundedPrintable(raw.label, "resumable label", 4_096);
      if (!label.ok) return { ok: false, err: label.err };
      const cwd = boundedPrintable(raw.cwd, "resumable cwd", 4_096);
      if (!cwd.ok) return { ok: false, err: cwd.err };
      if (!Number.isSafeInteger(raw.updatedAt) || (raw.updatedAt as number) < 0) {
        return { ok: false, err: "resumable updatedAt must be a non-negative epoch millisecond integer" };
      }
      sessions.push({
        sessionId: sessionId.value,
        backend: raw.backend,
        label: label.value,
        cwd: cwd.value,
        updatedAt: raw.updatedAt as number,
      });
    }
    return { ok: true, value: { kind: "resumable", sessions, complete: value.complete } };
  }
  if (value.kind === "app-error-ack") return { ok: true, value: { kind: "app-error-ack" } };
  if (value.kind === "session-started") {
    if ((value.backend !== "claude" && value.backend !== "codex") || typeof value.resumed !== "boolean") {
      return { ok: false, err: "invalid session started response" };
    }
    return {
      ok: true,
      value: {
        kind: "session-started",
        backend: value.backend,
        resumed: value.resumed,
        ...(value.awaitingTrust === true ? { awaitingTrust: true } : {}),
      },
    };
  }
  if (value.kind === "session-closed") {
    const sessionId = validateSessionId(value.sessionId);
    return sessionId.ok
      ? { ok: true, value: { kind: "session-closed", sessionId: sessionId.value } }
      : { ok: false, err: `invalid session closed response: ${sessionId.err}` };
  }
  if (value.kind === "session-error") {
    return typeof value.error === "string"
      ? { ok: true, value: { kind: "session-error", error: value.error } }
      : { ok: false, err: "invalid session error response" };
  }
  if (value.kind === "session-ack") {
    const sessionId = validateSessionId(value.sessionId);
    if (!sessionId.ok) return { ok: false, err: `invalid session ack: ${sessionId.err}` };
    if (!validSessionCommand(value.command)) return { ok: false, err: "invalid session ack command" };
    if (typeof value.changed !== "boolean") return { ok: false, err: "invalid session ack changed" };
    let label: string | undefined;
    if (value.label !== undefined) {
      const validated = validateSessionLabel(value.label);
      if (!validated.ok) return { ok: false, err: `invalid session ack label: ${validated.err}` };
      label = validated.value;
    }
    return {
      ok: true,
      value: {
        kind: "session-ack",
        sessionId: sessionId.value,
        command: value.command,
        ...(label === undefined ? {} : { label }),
        changed: value.changed,
      },
    };
  }
  if (value.kind === "pairing-open") {
    if (typeof value.code !== "string" || !/^[0-9]{6}$/.test(value.code)) {
      return { ok: false, err: "invalid pairing code" };
    }
    if (!Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0) {
      return { ok: false, err: "invalid pairing expiry" };
    }
    if (!Number.isSafeInteger(value.port) || (value.port as number) <= 0 || (value.port as number) > 65535) {
      return { ok: false, err: "invalid pairing port" };
    }
    let relay: PairingOpen["relay"];
    if (value.relay !== undefined) {
      const r = value.relay;
      if (
        !record(r) || r.version !== 1
        || typeof r.endpoint !== "string" || !/^wss:\/\/[^\s]+$/.test(r.endpoint)
        || typeof r.roomId !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(r.roomId)
        || typeof r.secret !== "string" || !/^[A-Za-z0-9_-]{16,}$/.test(r.secret)
        || !Number.isSafeInteger(r.createdAt)
      ) return { ok: false, err: "invalid relay pairing" };
      relay = {
        version: 1,
        endpoint: r.endpoint,
        roomId: r.roomId,
        secret: r.secret,
        createdAt: r.createdAt as number,
      };
    }
    return {
      ok: true,
      value: {
        kind: "pairing-open",
        code: value.code,
        expiresAt: value.expiresAt as number,
        port: value.port as number,
        ...(relay === undefined ? {} : { relay }),
      },
    };
  }
  if (value.kind === "config-error") {
    return typeof value.error === "string"
      ? { ok: true, value: { kind: "config-error", error: value.error } }
      : { ok: false, err: "invalid config error response" };
  }
  if (value.kind === "config-ack") {
    const found = getSettingDescriptor(value.key);
    if (!found.ok) return found;
    if (value.action !== "set" && value.action !== "unset") return { ok: false, err: "invalid config ack action" };
    if (value.status !== "applied" && value.status !== "masked" && value.status !== "hook-next") {
      return { ok: false, err: "invalid config ack status" };
    }
    if (value.source !== "env" && value.source !== "file" && value.source !== "default") {
      return { ok: false, err: "invalid config ack source" };
    }
    const parsed = found.value.parse(value.effective);
    if (!parsed.ok) return { ok: false, err: `invalid config ack value: ${parsed.err}` };
    if (value.env !== undefined && typeof value.env !== "string") return { ok: false, err: "invalid config ack env" };
    if (value.diagnostic !== undefined && typeof value.diagnostic !== "string") {
      return { ok: false, err: "invalid config ack diagnostic" };
    }
    return {
      ok: true,
      value: {
        kind: "config-ack",
        key: found.value.key,
        action: value.action,
        status: value.status,
        effective: parsed.value,
        source: value.source,
        ...(value.env === undefined ? {} : { env: value.env }),
        ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
      },
    };
  }
  if (value.kind !== "config-snapshot" || !record(value.snapshot)) {
    return { ok: false, err: "invalid config snapshot response" };
  }
  const snapshot = Object.create(null) as ConfigSnapshot;
  for (const descriptor of SETTING_DESCRIPTORS) {
    if (!Object.hasOwn(value.snapshot, descriptor.key)) {
      return { ok: false, err: `config snapshot is missing ${descriptor.key}` };
    }
    const entry = value.snapshot[descriptor.key];
    if (!record(entry) || (entry.source !== "env" && entry.source !== "file" && entry.source !== "default")) {
      return { ok: false, err: `invalid config snapshot entry for ${descriptor.key}` };
    }
    const parsed = descriptor.parse(entry.value);
    if (!parsed.ok) return { ok: false, err: `invalid config snapshot value for ${descriptor.key}` };
    if (entry.diagnostic !== undefined && typeof entry.diagnostic !== "string") {
      return { ok: false, err: `invalid config snapshot diagnostic for ${descriptor.key}` };
    }
    const kind = entry.kind === undefined ? descriptor.kind : entry.kind;
    if (!validSettingKind(kind)) {
      return { ok: false, err: `invalid config snapshot kind for ${descriptor.key}` };
    }
    const bounds = entry.bounds === undefined
      ? { ok: true, value: descriptor.bounds } as const
      : validateSnapshotBounds(entry.bounds);
    if (!bounds.ok) return { ok: false, err: `invalid config snapshot bounds for ${descriptor.key}: ${bounds.err}` };
    const parsedDefault = descriptor.parse(entry.default === undefined ? descriptor.default : entry.default);
    if (!parsedDefault.ok) return { ok: false, err: `invalid config snapshot default for ${descriptor.key}` };
    const help = entry.help === undefined ? descriptor.help : entry.help;
    if (typeof help !== "string") {
      return { ok: false, err: `invalid config snapshot help for ${descriptor.key}` };
    }
    let choices: SettingValue[] | undefined = "choices" in descriptor
      ? [...descriptor.choices]
      : undefined;
    if (entry.choices !== undefined) {
      if (!Array.isArray(entry.choices)) {
        return { ok: false, err: `invalid config snapshot choices for ${descriptor.key}` };
      }
      choices = [];
      for (const choice of entry.choices) {
        const parsedChoice = descriptor.parse(choice);
        if (!parsedChoice.ok) {
          return { ok: false, err: `invalid config snapshot choice for ${descriptor.key}` };
        }
        choices.push(parsedChoice.value);
      }
    }
    snapshot[descriptor.key] = {
      value: parsed.value,
      source: entry.source,
      ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic }),
      kind,
      bounds: bounds.value,
      ...(choices === undefined ? {} : { choices }),
      default: parsedDefault.value,
      help,
    };
  }
  return { ok: true, value: { kind: "config-snapshot", snapshot } };
}

export type ConfigControlResult =
  | { ok: true; response: ConfigControlResponse }
  | { ok: false; reason: "daemon-down" | "ack-unknown"; diagnostic?: string };

export type SessionControlResult =
  | { ok: true; response: SessionControlResponse }
  | { ok: false; reason: "daemon-down" | "ack-unknown"; diagnostic?: string };

export type ControlResult =
  | { ok: true; response: ControlResponse }
  | { ok: false; reason: "daemon-down" | "ack-unknown"; diagnostic?: string };

/** Newline-framed request/reply client for daemon control messages. */
export function sendControlMessage(
  socketPath: string,
  message: ConfigControlMessage,
  timeoutMs?: number,
): Promise<ConfigControlResult>;
export function sendControlMessage(
  socketPath: string,
  message: SessionControlMessage,
  timeoutMs?: number,
): Promise<SessionControlResult>;
export function sendControlMessage(
  socketPath: string,
  message: RuntimeControlMessage,
  timeoutMs?: number,
): Promise<SessionControlResult>;
export function sendControlMessage(
  socketPath: string,
  message: AnyControlMessage,
  timeoutMs?: number,
): Promise<ControlResult>;
export function sendControlMessage(
  socketPath: string,
  message: AnyControlMessage,
  timeoutMs = 500,
): Promise<ControlResult> {
  return new Promise((resolve) => {
    const sock = connect({ path: socketPath, allowHalfOpen: true });
    let connected = false;
    let settled = false;
    let buffer = "";

    const finish = (result: ControlResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };

    const parseLine = (line: string): void => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        finish({ ok: false, reason: "ack-unknown", diagnostic: `invalid JSON reply: ${detail}` });
        return;
      }
      const validated = validateControlResponse(raw);
      if (!validated.ok) finish({ ok: false, reason: "ack-unknown", diagnostic: validated.err });
      else finish({ ok: true, response: validated.value });
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: connected ? "ack-unknown" : "daemon-down", diagnostic: "control reply timed out" });
    }, timeoutMs);

    sock.on("connect", () => {
      connected = true;
      // Keep the readable half alive for the reply. Bun's net.Socket can close
      // both halves on end(), even with allowHalfOpen, so request/reply uses a
      // complete newline frame without a client FIN.
      sock.write(JSON.stringify(message) + "\n");
    });
    sock.on("data", (data) => {
      buffer += data.toString();
      const newline = buffer.indexOf("\n");
      if (newline !== -1) parseLine(buffer.slice(0, newline));
    });
    sock.on("end", () => {
      if (!settled && buffer.trim()) parseLine(buffer.trim());
      else if (!settled) finish({ ok: false, reason: "ack-unknown", diagnostic: "daemon closed without a reply" });
    });
    sock.on("error", (error) => {
      finish({
        ok: false,
        reason: connected ? "ack-unknown" : "daemon-down",
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    });
    sock.on("close", () => {
      if (!settled) finish({ ok: false, reason: connected ? "ack-unknown" : "daemon-down" });
    });
  });
}

/** Compile-time assertion that registry fields stay assignable to Config. */
const _settingFields: ReadonlyArray<keyof Config> = SETTING_DESCRIPTORS.map((descriptor) => descriptor.field);
void _settingFields;

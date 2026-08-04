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
  "barge-threshold",
  "voice-speed",
  "keystroke-fallback",
  "read-full",
  "interrupt-on-manual-reply",
  "handoff-order",
  "reveal-on-turn",
  "reveal-typing-grace",
  "working-mic",
  "voice-qa",
  "resume-digest",
  "announce-summary",
  "haiku-timeout",
  "meeting-autopause",
  "announce-sentences",
  "announce-max-chars",
  "say-rate",
] as const;

export type SettingKey = typeof SETTING_KEYS[number];
export type SettingField =
  | "endSilenceSecs"
  | "micGainDb"
  | "holdSubmitSecs"
  | "listenWindowSecs"
  | "typingGraceSecs"
  | "bargeThresholdPct"
  | "ttsSpeed"
  | "keystrokeFallback"
  | "readFull"
  | "interruptOnManualReply"
  | "handoffOrder"
  | "revealOnTurn"
  | "revealTypingGraceSecs"
  | "workingMic"
  | "voiceQa"
  | "resumeDigest"
  | "announceSummary"
  | "haikuTimeoutSecs"
  | "meetingAutopause"
  | "speakSentences"
  | "speakMaxChars"
  | "sayRate";
export type HandoffOrder = "newest" | "oldest" | "urgency";
export type SettingValue = number | boolean | HandoffOrder;
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
  kind: "number" | "integer" | "boolean" | "enum";
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
    key: "resume-digest",
    field: "resumeDigest",
    env: "CONCH_RESUME_DIGEST",
    kind: "boolean",
    default: false,
    parse: parseBoolean,
    bounds: null,
    apply: "live",
    help: "on resume, speak one composed briefing instead of replaying each held turn",
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
    help: "seconds the fast model (Haiku) may take for a spoken summary, voice answer, or resume briefing before falling back",
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

export type ControlMessage = ConfigControlMessage | SessionControlMessage;

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
export type SessionControlResponse = SessionAck | SessionError;
export type ControlResponse = ConfigControlResponse | SessionControlResponse;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validSettingKind(value: unknown): value is SettingDescriptor["kind"] {
  return value === "number" || value === "integer" || value === "boolean" || value === "enum";
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
    || value.kind === "session-command";
}

const MAX_SESSION_ID_LENGTH = 256;
const MAX_SESSION_LABEL_INPUT_LENGTH = 4_096;
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

export function validateControlMessage(value: unknown): ParseResult<ControlMessage> {
  if (!record(value)) return { ok: false, err: "control message must be a JSON object" };
  if (!Object.hasOwn(value, "kind") || typeof value.kind !== "string") {
    return { ok: false, err: "control message kind is required" };
  }
  if (value.kind === "session-command") return validateSessionControlMessage(value);
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
  message: ControlMessage,
  timeoutMs?: number,
): Promise<ControlResult>;
export function sendControlMessage(
  socketPath: string,
  message: ControlMessage,
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

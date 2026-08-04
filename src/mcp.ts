import { stat } from "node:fs/promises";
import { loadConfig, type Config } from "./config.ts";
import { CONCH_VERSION } from "./version.ts";
import { sendToDaemon, type TurnEvent } from "./hook.ts";
import { registryToPanel } from "./panel.ts";
import {
  findSessionByName,
  findTranscript,
  registrySnapshot,
  renameSessionLabel,
  sessionLabel,
  type RegistrySnapshot,
  type SessionInfo,
} from "./sessions.ts";
import {
  getSettingDescriptor,
  parseSetting,
  sendControlMessage,
  type ConfigAck,
  type ConfigSnapshot,
  type ControlMessage,
  type ControlResponse,
  type ControlResult,
  type SettingKey,
} from "./settings.ts";
import {
  lastAssistantText,
  sanitizeReviewSummary,
  splitSentences,
  transcriptMark,
} from "./snippet.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SESSIONS_FILE = "/tmp/conch-sessions.json";

type PublishedSessionStatus = "working" | "waiting" | "needs";
type PublishedLiveState =
  | "idle"
  | "muted"
  | "paused"
  | "speaking"
  | "listening"
  | "recording"
  | "transcribing";

export interface ReviewRequest {
  summary: string;
  link?: string;
  at: number;
}

export interface PublishedSessionRow {
  id: string;
  label: string;
  cwd?: string;
  status: PublishedSessionStatus | null;
  /** Epoch-ms for the status currently visible on this row. */
  at?: number;
  transcriptPath?: string;
  voice?: string;
  prioritized?: boolean;
  navSelected?: boolean;
  needsResponse: boolean;
  detail?: string;
  review?: ReviewRequest;
  paused: boolean;
  muted: boolean;
  live: PublishedLiveState | null;
  active: boolean;
  snippet?: string;
}

/**
 * The G2 external state model, including the cwd/review additions reserved by
 * the plugin design. A valid daemon-published object is returned unchanged so
 * newer optional fields survive an older MCP server.
 */
export interface PublishedState {
  v: 1;
  ts: number;
  mode: {
    muted: boolean;
    paused: boolean;
    holding: number;
  };
  live: {
    state: PublishedLiveState;
    label: string;
    partial?: string;
    transcriptPrefix?: string;
    reading?: { text: string; spokenChars: number };
  };
  reply?: { sessionId: string; text: string; spokenChars: number } | null;
  preview?: { sessionId: string; text: string; spokenChars: number } | null;
  rows: PublishedSessionRow[];
  dismissed: string[];
  /** Added in v1 without removing the legacy id-only list. */
  dismissedRows?: Array<{ id: string; label: string }>;
}

interface JsonSchema {
  type?: string | readonly string[];
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean | null)[];
  anyOf?: readonly JsonSchema[];
  minLength?: number;
  minimum?: number;
  default?: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const MCP_TOOLS = [
  {
    name: "conch_sessions",
    description: "Return conch's current versioned session state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "conch_wake",
    description: "Open conch's microphone for the last session or a named live session.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          minLength: 1,
          description: "Live session id or name. Omit to use conch's last session.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "conch_recite",
    description: "Read the latest response from the last session or a named live session.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          minLength: 1,
          description: "Live session id or name. Omit to use conch's last session.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "conch_speak",
    description: "Speak text through the running conch daemon.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1 },
        voice: {
          type: "string",
          minLength: 1,
          description: "Optional explicit Kokoro voice.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "conch_mode",
    description: "Mute, unmute, pause, or resume conch.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["mute", "unmute", "pause", "resume"],
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "conch_rename",
    description: "Persist a display label for a live conch session.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", minLength: 1 },
        label: { type: "string", minLength: 1 },
      },
      required: ["session", "label"],
      additionalProperties: false,
    },
  },
  {
    name: "conch_config",
    description: "Get, set, or unset a curated conch daemon setting.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", minLength: 1 },
        value: {
          anyOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
          ],
        },
        unset: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: "conch_transcript_tail",
    description: "Return the last sentences from a live session's latest assistant response.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", minLength: 1 },
        sentences: {
          type: "integer",
          minimum: 1,
          default: 3,
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "review_to_front",
    description: "Surface YOUR finished deliverable for the user's review. Defaults to the calling session; a session may only surface its own work. Latches it as needs-review in conch's dashboard, announces it, and opens an optional safe link.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1 },
        link: { type: "string", minLength: 1 },
        session: {
          type: "string",
          minLength: 1,
          description: "Optional. Defaults to YOUR session. A session may only surface its own work; naming another session is refused.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
] as const satisfies readonly McpToolDefinition[];

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];
export type McpToolHandler = (argumentsValue: unknown) => Promise<unknown>;
export type McpToolHandlers = Record<McpToolName, McpToolHandler>;

export interface McpRuntimeConfig {
  claudeDir: string;
  socketPath: string;
  sessionsPath?: string;
}

export interface McpDependencies {
  readSessionsFile(path: string): Promise<string | null>;
  registrySnapshot(claudeDir: string): Promise<RegistrySnapshot | null>;
  findSessionByName(claudeDir: string, query: string): Promise<SessionInfo | null>;
  findTranscript(claudeDir: string, sessionId: string): string | undefined;
  sessionLabel(session: SessionInfo | null, cwd: string | undefined): string;
  renameSessionLabel(
    sessionId: string,
    oldLabel: string,
    newLabel: string,
  ): { label: string; voiceMigrated: boolean };
  sendToDaemon(socketPath: string, event: TurnEvent): Promise<boolean>;
  sendControlMessage(
    socketPath: string,
    message: ControlMessage,
    timeoutMs?: number,
  ): Promise<ControlResult>;
  getSettingDescriptor: typeof getSettingDescriptor;
  parseSetting: typeof parseSetting;
  transcriptMark(transcriptPath: string): Promise<number>;
  lastAssistantText(transcriptPath: string): Promise<string>;
  splitSentences(text: string): string[];
  openLink(link: string): void;
  now(): number;
}

export const defaultMcpDependencies: McpDependencies = {
  async readSessionsFile(path) {
    const file = Bun.file(path);
    return await file.exists() ? file.text() : null;
  },
  registrySnapshot,
  findSessionByName,
  findTranscript,
  sessionLabel,
  renameSessionLabel,
  sendToDaemon,
  sendControlMessage,
  getSettingDescriptor,
  parseSetting,
  transcriptMark,
  lastAssistantText,
  splitSentences,
  openLink(link) {
    Bun.spawn(["open", "--", link], { stdout: "ignore", stderr: "ignore" });
  },
  now: Date.now,
};

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ToolInputError("tool arguments must be a JSON object");
  return value;
}

function allowOnly(
  argumentsValue: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(argumentsValue).find((key) => !allowedKeys.has(key));
  if (extra) throw new ToolInputError(`unknown argument "${extra}"`);
}

function requiredString(
  argumentsValue: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = argumentsValue[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  argumentsValue: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(argumentsValue, key)) return undefined;
  return requiredString(argumentsValue, key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishedStateFromRegistry(
  snapshot: RegistrySnapshot | null,
  dependencies: McpDependencies,
): PublishedState {
  return {
    v: 1,
    ts: dependencies.now(),
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "" },
    rows: (snapshot?.infos ?? []).map((session) => {
      const status = registryToPanel(session.status);
      return {
        id: session.sessionId,
        label: dependencies.sessionLabel(session, session.cwd),
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        status,
        needsResponse: status === "needs",
        paused: false,
        muted: false,
        live: null,
        active: false,
      };
    }),
    dismissed: [],
    dismissedRows: [],
  };
}

async function sendTurn(
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
  event: TurnEvent,
): Promise<{ sent: true; event: TurnEvent }> {
  if (!(await dependencies.sendToDaemon(config.socketPath, event))) {
    throw new Error("conch daemon is not running");
  }
  return { sent: true, event };
}

async function resolveSession(
  query: string,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
): Promise<SessionInfo> {
  const session = await dependencies.findSessionByName(config.claudeDir, query.trim());
  if (!session) throw new Error(`no live session matching "${query.trim()}"`);
  return session;
}

/**
 * The session that OWNS this MCP server.
 *
 * Claude Code spawns the plugin's MCP server as a direct child of the session
 * process, so the parent pid identifies the caller. That is what lets a review
 * default to "mine" and lets us refuse to file one under somebody else's name.
 * Returns null when the parent isn't a known session (a bare `conch mcp` run).
 */
async function callerSession(
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
): Promise<SessionInfo | null> {
  const parentPid = typeof process.ppid === "number" ? process.ppid : 0;
  if (!parentPid) return null;
  const infos = (await dependencies.registrySnapshot(config.claudeDir))?.infos ?? [];
  return infos.find((session) => session.pid === parentPid) ?? null;
}

/**
 * A session may only surface its OWN deliverable.
 *
 * Nothing used to stop one session filing a review under another's name, and
 * the dashboard attributes it to the named session — so a caller could put
 * words in a sibling's mouth. Reviews are an approval gate; misattributing one
 * is worse than failing to file it.
 */
async function requiredReviewSession(
  argumentsValue: Readonly<Record<string, unknown>>,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
): Promise<string> {
  const caller = await callerSession(config, dependencies);
  const value = argumentsValue.session;
  const named = typeof value === "string" ? value.trim() : "";

  if (caller) {
    // Naming yourself is fine and is the normal case; naming anyone else is not.
    if (!named) return caller.sessionId;
    const requested = await dependencies.findSessionByName(config.claudeDir, named);
    if (requested && requested.sessionId !== caller.sessionId) {
      throw new ToolInputError(
        `a session can only surface its own work — you are "`
          + `${dependencies.sessionLabel(caller, caller.cwd)}", not "${named}". `
          + "Omit `session` to surface your own deliverable.",
      );
    }
    return caller.sessionId;
  }

  if (named) return named;
  const infos = (await dependencies.registrySnapshot(config.claudeDir))?.infos ?? [];
  const labels = Array.from(new Set(
    infos.map((session) => dependencies.sessionLabel(session, session.cwd)),
  ));
  throw new ToolInputError(
    "session is required and must name the worker whose deliverable this is"
      + `; live sessions: ${labels.length ? labels.join(", ") : "(none)"}`,
  );
}

const SAFE_REVIEW_LINK =
  "link must be an http(s) URL or an existing, non-executable regular file";

async function validateReviewLink(link: string): Promise<void> {
  let url: URL | undefined;
  try {
    url = new URL(link);
  } catch {
    // A non-URL may still be a filesystem path.
  }
  if (url) {
    if (
      (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.hostname)
    ) {
      return;
    }
    throw new ToolInputError(SAFE_REVIEW_LINK);
  }

  let file;
  try {
    file = await stat(link);
  } catch {
    throw new ToolInputError(SAFE_REVIEW_LINK);
  }
  if (!file.isFile() || (file.mode & 0o111) !== 0) {
    throw new ToolInputError(SAFE_REVIEW_LINK);
  }
}

function unwrapControlResult(result: ControlResult): ControlResponse {
  if (!result.ok) {
    const diagnostic = result.diagnostic ? `: ${result.diagnostic}` : "";
    throw new Error(`${result.reason}${diagnostic}`);
  }
  if (
    result.response.kind === "config-error"
    || result.response.kind === "session-error"
  ) {
    throw new Error(result.response.error);
  }
  return result.response;
}

function mutationControlResult(
  result: ControlResult,
  key: SettingKey,
  action: "set" | "unset",
): ConfigAck {
  const response = unwrapControlResult(result);
  if (
    response.kind !== "config-ack"
    || response.key !== key
    || response.action !== action
  ) {
    throw new Error("ack-unknown: daemon reply did not match the config request");
  }
  return response;
}

function snapshotControlResult(result: ControlResult): ConfigSnapshot {
  const response = unwrapControlResult(result);
  if (response.kind !== "config-snapshot") {
    throw new Error("ack-unknown: daemon did not return a config snapshot");
  }
  return response.snapshot;
}

export function createMcpToolHandlers(
  config: McpRuntimeConfig,
  dependencies: McpDependencies = defaultMcpDependencies,
): McpToolHandlers {
  const sessionsPath = config.sessionsPath ?? MCP_SESSIONS_FILE;

  return {
    async conch_sessions(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, []);

      try {
        const raw = await dependencies.readSessionsFile(sessionsPath);
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) throw new Error("published state is not a JSON object");
          return parsed as unknown as PublishedState;
        }
      } catch {
        // The daemon snapshot is advisory. A missing, unreadable, or malformed file
        // falls through to Claude's registry so the plugin remains useful.
      }
      return publishedStateFromRegistry(
        await dependencies.registrySnapshot(config.claudeDir),
        dependencies,
      );
    },

    async conch_wake(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session"]);
      const query = optionalString(argumentsObject, "session");
      if (!query) {
        return sendTurn(config, dependencies, {
          type: "wake",
          sessionId: "",
          label: "",
          announce: "",
        });
      }
      const session = await resolveSession(query, config, dependencies);
      return sendTurn(config, dependencies, {
        type: "wake",
        sessionId: session.sessionId,
        label: dependencies.sessionLabel(session, session.cwd),
        pid: session.pid,
        cwd: session.cwd,
        transcriptPath: dependencies.findTranscript(
          config.claudeDir,
          session.sessionId,
        ),
        announce: "",
      });
    },

    async conch_recite(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session"]);
      const query = optionalString(argumentsObject, "session");
      if (!query) {
        return sendTurn(config, dependencies, {
          type: "recite",
          sessionId: "",
          label: "",
          announce: "",
        });
      }
      const session = await resolveSession(query, config, dependencies);
      const label = dependencies.sessionLabel(session, session.cwd);
      const transcriptPath = dependencies.findTranscript(
        config.claudeDir,
        session.sessionId,
      );
      if (!transcriptPath) {
        throw new Error(`nothing to recite for "${label}" — transcript not found`);
      }
      return sendTurn(config, dependencies, {
        type: "recite",
        sessionId: session.sessionId,
        label,
        pid: session.pid,
        cwd: session.cwd,
        transcriptPath,
        mark: await dependencies.transcriptMark(transcriptPath),
        announce: "",
      });
    },

    async conch_speak(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["text", "voice"]);
      const text = requiredString(argumentsObject, "text");
      const voice = optionalString(argumentsObject, "voice");
      return sendTurn(config, dependencies, {
        type: "speak",
        sessionId: "",
        label: "",
        announce: text,
        ...(voice === undefined ? {} : { voice }),
      });
    },

    async conch_mode(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["action"]);
      const action = requiredString(argumentsObject, "action");
      if (
        action !== "mute"
        && action !== "unmute"
        && action !== "pause"
        && action !== "resume"
      ) {
        throw new ToolInputError("action must be mute, unmute, pause, or resume");
      }
      return sendTurn(config, dependencies, {
        type: action,
        sessionId: "",
        label: "",
        announce: "",
      });
    },

    async conch_rename(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session", "label"]);
      const query = requiredString(argumentsObject, "session");
      const newLabel = requiredString(argumentsObject, "label");
      const session = await resolveSession(query, config, dependencies);
      const oldLabel = dependencies.sessionLabel(session, session.cwd);
      const result = await dependencies.sendControlMessage(
        config.socketPath,
        {
          kind: "session-command",
          sessionId: session.sessionId,
          command: "rename",
          label: newLabel,
        },
      );
      if (!result.ok && result.reason === "daemon-down") {
        const renamed = dependencies.renameSessionLabel(
          session.sessionId,
          oldLabel,
          newLabel,
        );
        return {
          kind: "session-ack",
          sessionId: session.sessionId,
          command: "rename",
          label: renamed.label,
          changed: renamed.label !== oldLabel,
        };
      }
      const response = unwrapControlResult(result);
      if (
        response.kind !== "session-ack"
        || response.sessionId !== session.sessionId
        || response.command !== "rename"
        || response.label === undefined
      ) {
        throw new Error("ack-unknown: daemon reply did not match the rename request");
      }
      return response;
    },

    async conch_config(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["key", "value", "unset"]);
      const hasKey = Object.hasOwn(argumentsObject, "key");
      const hasValue = Object.hasOwn(argumentsObject, "value");
      const hasUnset = Object.hasOwn(argumentsObject, "unset");

      if (hasUnset && typeof argumentsObject.unset !== "boolean") {
        throw new ToolInputError("unset must be a boolean");
      }
      const shouldUnset = argumentsObject.unset === true;
      if (shouldUnset && hasValue) {
        throw new ToolInputError("value and unset cannot be used together");
      }
      if ((hasValue || shouldUnset) && !hasKey) {
        throw new ToolInputError("key is required when setting or unsetting a value");
      }

      let canonicalKey: SettingKey | undefined;
      if (hasKey) {
        const found = dependencies.getSettingDescriptor(argumentsObject.key);
        if (!found.ok) throw new ToolInputError(found.err);
        canonicalKey = found.value.key;
      }

      if (shouldUnset) {
        const result = await dependencies.sendControlMessage(
          config.socketPath,
          { kind: "unset-config", key: canonicalKey! },
        );
        return mutationControlResult(result, canonicalKey!, "unset");
      }

      if (hasValue) {
        const parsed = dependencies.parseSetting(
          canonicalKey!,
          argumentsObject.value,
        );
        if (!parsed.ok) throw new ToolInputError(parsed.err);
        const result = await dependencies.sendControlMessage(
          config.socketPath,
          {
            kind: "set-config",
            key: parsed.value.descriptor.key,
            value: parsed.value.value,
          },
        );
        return mutationControlResult(
          result,
          parsed.value.descriptor.key,
          "set",
        );
      }

      const result = await dependencies.sendControlMessage(
        config.socketPath,
        { kind: "get-config" },
      );
      const snapshot = snapshotControlResult(result);
      if (!hasKey) return { kind: "config-snapshot", snapshot };
      const { kind: settingKind, ...entry } = snapshot[canonicalKey!];
      return {
        kind: "config-value",
        key: canonicalKey!,
        settingKind,
        ...entry,
      };
    },

    async conch_transcript_tail(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session", "sentences"]);
      const query = requiredString(argumentsObject, "session");
      const countValue = argumentsObject.sentences ?? 3;
      if (
        typeof countValue !== "number"
        || !Number.isInteger(countValue)
        || countValue < 1
      ) {
        throw new ToolInputError("sentences must be an integer at least 1");
      }
      const session = await resolveSession(query, config, dependencies);
      const transcriptPath = dependencies.findTranscript(
        config.claudeDir,
        session.sessionId,
      );
      if (!transcriptPath) {
        throw new Error(
          `transcript not found for "${dependencies.sessionLabel(session, session.cwd)}"`,
        );
      }
      const text = await dependencies.lastAssistantText(transcriptPath);
      return dependencies.splitSentences(text).slice(-countValue).join(" ");
    },

    async review_to_front(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["summary", "link", "session"]);
      const summary = sanitizeReviewSummary(
        requiredString(argumentsObject, "summary"),
      );
      if (!summary) {
        throw new ToolInputError("summary must be a non-empty string");
      }
      const query = await requiredReviewSession(
        argumentsObject,
        config,
        dependencies,
      );
      const rawLink = optionalString(argumentsObject, "link");
      const link = rawLink?.trim();
      if (link) await validateReviewLink(link);
      const session = await resolveSession(query, config, dependencies);
      const label = dependencies.sessionLabel(session, session.cwd);
      const transcriptPath = dependencies.findTranscript(
        config.claudeDir,
        session.sessionId,
      );
      const result = await sendTurn(config, dependencies, {
        type: "turn-end",
        sessionId: session.sessionId,
        label,
        cwd: session.cwd,
        pid: session.pid,
        announce: `${label} has work ready for your review: ${summary}`,
        ...(transcriptPath
          ? {
            transcriptPath,
            mark: await dependencies.transcriptMark(transcriptPath),
          }
          : {}),
        eventAt: dependencies.now(),
        review: { summary, ...(link ? { link } : {}) },
      });
      if (link) dependencies.openLink(link);
      return result;
    },
  };
}

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export function parseJsonRpcLine(line: string): unknown {
  return JSON.parse(line);
}

export function serializeJsonRpcLine(message: unknown): string {
  return JSON.stringify(message);
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || typeof value === "number";
}

function toolResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const encoded = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2) ?? "null";
  return { content: [{ type: "text", text: encoded }] };
}

function toolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: errorMessage(error) }],
    isError: true,
  };
}

/**
 * Dispatch one already-parsed JSON-RPC message. All failures are converted to
 * JSON-RPC errors or MCP isError tool results; this function never rejects.
 */
export async function dispatchJsonRpc(
  message: unknown,
  handlers: McpToolHandlers,
): Promise<JsonRpcResponse | null> {
  let requestId: JsonRpcId = null;
  let shouldReply = true;
  try {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return jsonRpcError(null, -32600, "Invalid Request");
    }
    const hasId = Object.hasOwn(message, "id");
    shouldReply = hasId;
    if (hasId) {
      if (!validId(message.id)) return jsonRpcError(null, -32600, "Invalid Request");
      requestId = message.id;
    }

    switch (message.method) {
      case "initialize": {
        return shouldReply
          ? jsonRpcResult(requestId, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "conch", version: CONCH_VERSION },
          })
          : null;
      }

      case "notifications/initialized":
        return null;

      case "tools/list":
        return shouldReply
          ? jsonRpcResult(requestId, { tools: MCP_TOOLS })
          : null;

      case "tools/call": {
        if (!isRecord(message.params) || typeof message.params.name !== "string") {
          return shouldReply
            ? jsonRpcError(requestId, -32602, "Invalid params")
            : null;
        }
        const name = message.params.name;
        if (!Object.hasOwn(handlers, name)) {
          return shouldReply
            ? jsonRpcError(requestId, -32602, `Unknown tool "${name}"`)
            : null;
        }
        const argumentsValue = Object.hasOwn(message.params, "arguments")
          ? message.params.arguments
          : {};
        if (!isRecord(argumentsValue)) {
          return shouldReply
            ? jsonRpcError(requestId, -32602, "Tool arguments must be an object")
            : null;
        }
        try {
          const value = await handlers[name as McpToolName](argumentsValue);
          return shouldReply
            ? jsonRpcResult(requestId, toolResult(value))
            : null;
        } catch (error) {
          return shouldReply
            ? jsonRpcResult(requestId, toolError(error))
            : null;
        }
      }

      default:
        return shouldReply
          ? jsonRpcError(requestId, -32601, "Method not found")
          : null;
    }
  } catch (error) {
    return shouldReply
      ? jsonRpcError(requestId, -32603, "Internal error", errorMessage(error))
      : null;
  }
}

export interface RunMcpServerOptions {
  config?: McpRuntimeConfig;
  dependencies?: McpDependencies;
  handlers?: McpToolHandlers;
  input?: ReadableStream<Uint8Array>;
  /** Receives exactly one serialized object without its framing newline. */
  writeLine?(line: string): void | Promise<void>;
  diagnostic?(message: string): void;
}

/**
 * Newline-delimited JSON-RPC 2.0 over stdio. stdout is used only by writeLine;
 * all local diagnostics go to stderr.
 */
export async function runMcpServer(options: RunMcpServerOptions = {}): Promise<void> {
  let handlers = options.handlers;
  if (!handlers) {
    const loaded: Config | McpRuntimeConfig = options.config ?? loadConfig();
    handlers = createMcpToolHandlers(
      loaded,
      options.dependencies ?? defaultMcpDependencies,
    );
  }
  const input = options.input ?? Bun.stdin.stream();
  const writeLine = options.writeLine
    ?? ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const diagnostic = options.diagnostic
    ?? ((message: string) => {
      process.stderr.write(`[conch:mcp] ${message}\n`);
    });

  const writeResponse = async (response: JsonRpcResponse): Promise<void> => {
    await writeLine(serializeJsonRpcLine(response));
  };
  const processLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = parseJsonRpcLine(line);
    } catch {
      await writeResponse(jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    const response = await dispatchJsonRpc(message, handlers);
    if (response) await writeResponse(response);
  };

  const reader = input.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        await processLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processLine(buffer.replace(/\r$/, ""));
  } catch (error) {
    diagnostic(`stdio failure: ${errorMessage(error)}`);
  } finally {
    reader.releaseLock();
  }
}

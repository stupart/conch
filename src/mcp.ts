import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AudioControl } from "./audio-holder.ts";
import { audioTimeoutMs } from "./audio-watchdog.ts";
import { loadConfig, type Config } from "./config.ts";
import { CONCH_VERSION } from "./version.ts";
import { sendToDaemon, type TurnEvent } from "./hook.ts";
import { artifactOf, nextVersion, reconcileStatus } from "./panel.ts";
import {
  renameProviderSession as deliverProviderRename,
  type ProviderRenameResult,
} from "./provider-rename.ts";
import {
  findSessionByName,
  findTranscript,
  registrySnapshot,
  renameSessionLabel,
  sessionLabel,
  setWorkingFolders,
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
import { AGENT_INSTRUCTIONS, MAX_SPEAK_CHARS, type AgentInstructions } from "./agent-instructions.ts";

/** A session works in a few folders, not a filesystem. */
const WORKING_FOLDERS_MAX = 8;
import {
  checkReviewLink,
  checkReviewScene,
  markImagesRefusal,
  REVIEW_INSPECT_MAX,
  REVIEW_MARK_FRAME_MAX,
  REVIEW_MARK_KINDS,
  REVIEW_MARK_LABEL_MAX,
  REVIEW_MARK_POINTS_MAX,
  REVIEW_MARKS_MAX,
  REVIEW_MARKS_MAX_BYTES,
  REVIEW_SCENE_KINDS,
  type ReviewScene,
  REVIEW_SUMMARY_MAX,
  sanitizeReviewSummary,
  splitSentences,
  transcriptMark,
} from "./snippet.ts";
import { lastAssistantReply, readConversationTail } from "./conversation.ts";
import {
  ARTIFACT_KEY_MAX,
  DELIVERABLE_KINDS,
  deliverableFacts,
  deliverableKindRefusal,
  isDeliverableKind,
  LINKLESS_DELIVERABLE_KINDS,
} from "./deliverables.ts";
import { reviewIdentity } from "./records-receipts.ts";
import { windowKey } from "./window-key.ts";
import { appServerNoTerminal } from "./codex-threads.ts";
import { transcriptFormatFor } from "./agent-adapter.ts";
import {
  HISTORY_CURSOR_MAX_BYTES, HISTORY_DEFAULT_LIMIT, HISTORY_ID_MAX_BYTES, HISTORY_MAX_LIMIT,
  historyError, parseHistoryItemRequest, parseHistoryPageRequest, validateHistoryResponse,
  type HistoryRequest, type HistoryResponse,
} from "./history.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SESSIONS_FILE = "/tmp/conch-sessions.json";
export const MCP_HISTORY_MAX_BYTES = 64 * 1024;

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
  scene?: ReviewScene;
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
  /** C9b Cut B: who makes this daemon's sound. Absent from older daemons means local. */
  audioControl?: AudioControl;
}

/**
 * The settings an agent may CHANGE. Voice and timing only — topology (`phone`,
 * `phone-port`, `phone-relay-url`) and security (`bypass-permissions`) are the
 * user's, by name, forever; the tool used to say "curated" and accept every
 * key the registry knew. Reads stay unbounded, like the other read-only tools.
 */
export const AGENT_TUNABLE_SETTINGS = [
  "end-silence",
  "voice-speed",
  "haiku-timeout",
  "read-full",
  "announce-summary",
  "whisper-idle-unload",
] as const satisfies readonly SettingKey[];

export { MAX_SPEAK_CHARS };

interface JsonSchema {
  type?: string | readonly string[];
  description?: string;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean | null)[];
  anyOf?: readonly JsonSchema[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  const?: unknown;
  not?: JsonSchema;
  default?: unknown;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** The nine tools. Descriptions come from the one instruction source, `agent-instructions.ts`. */
export function buildMcpTools(text: AgentInstructions = AGENT_INSTRUCTIONS) {
  return [
    {
      name: "conch_sessions",
      description: text.tools.conch_sessions,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "conch_wake",
      description: text.tools.conch_wake,
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            minLength: 1,
            description: "Live session id or label. Omit for your own verified session; a name that matches several sessions is refused.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "conch_recite",
      description: text.tools.conch_recite,
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            minLength: 1,
            description: "Live session id or label. Omit for your own verified session; a name that matches several sessions is refused.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "conch_speak",
      description: text.tools.conch_speak,
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: MAX_SPEAK_CHARS },
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
      description: text.tools.conch_mode,
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["pause", "resume"],
            description: "`pause` is manual: nothing is read aloud and the mic never opens on its own, while everything else keeps working. `resume` is auto.",
          },
          session: {
            type: "string",
            minLength: 1,
            description: "Live session id or name to switch instead of your own.",
          },
          scope: {
            type: "string",
            enum: ["all"],
            description: "\"all\" switches every session — the whole daemon. Only when the user asked for that.",
          },
        },
        required: ["action"],
        // `scope` with `session` is refused by the handler, not the schema: conditional keywords aren't
        // reliably accepted in a tool's input_schema, and a rejected schema would hide every conch tool.
        additionalProperties: false,
      },
    },
    {
      name: "conch_rename",
      description: text.tools.conch_rename,
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
      description: text.tools.conch_config,
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            minLength: 1,
            description: `Any setting can be read. Only ${AGENT_TUNABLE_SETTINGS.join(", ")} can be set or unset; any other key is refused with the \`conch set\` command the user can run themselves.`,
          },
          value: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
            ],
          },
          unset: { type: "boolean", default: false },
        },
        // A change names its key, and a value never comes with `unset: true`: the handler refuses both,
        // for the same reason as conch_mode.
        additionalProperties: false,
      },
    },
    {
      name: "conch_transcript_tail",
      description: text.tools.conch_transcript_tail,
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
      description: text.tools.review_to_front,
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1 },
          link: { type: "string", minLength: 1 },
          kind: {
            type: "string",
            enum: DELIVERABLE_KINDS,
            description: `Optional. What the user will look at; inferred from the link when omitted. page is a local html file, url a live web page or dev server, app a Mac app window, simulator the iOS Simulator or a device build, design Figma and the like, document Keynote, Word, Pages and the like. Only ${LINKLESS_DELIVERABLE_KINDS.join(", ")} may omit link; the summary then says where to look.`,
          },
          key: {
            type: "string",
            minLength: 1,
            maxLength: ARTIFACT_KEY_MAX,
            description: "Optional. Names the artifact, so publishing it again is its next version. Defaults to the link (a file's real path, a URL without its fragment), else the summary. Use the same key for each version of a thing with no link, or whose link changes.",
          },
          session: {
            type: "string",
            minLength: 1,
            description: "Optional. Defaults to YOUR session. A session may only surface its own work; naming another session is refused.",
          },
          scene: {
            type: "object",
            description: "Optional. What the pill click brings forward, v1. auto (the same as no scene): the link, else conch's window, else the terminal. link: the link; needs `link`. conversation: conch's window on your session, even with a link. terminal: your terminal, else conch's window. `target.ref` is reserved for conch-issued surface references and not accepted yet.",
            properties: {
              v: { type: "integer", enum: [1] },
              target: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: REVIEW_SCENE_KINDS },
                },
                required: ["kind"],
                additionalProperties: false,
              },
              inspect: {
                type: "string",
                minLength: 1,
                maxLength: REVIEW_INSPECT_MAX,
                description: "One short line naming what to check, e.g. \"Check that Save stays reachable at phone width\".",
              },
              marks: {
                type: "array",
                minItems: 1,
                maxItems: REVIEW_MARKS_MAX,
                description: `Optional agent ink: marks conch draws over what you published, where the user is looking, each pointing at one thing you changed or want checked. frame is what a mark is drawn on: selector or quote, an element or text in the linked page, which conch finds and marks itself (no at, to, rect or pts); canvas, the user's canvas you are answering, by the id conch gave you with it; image, an absolute path to an image file (it passes the same check as link). On a canvas or an image, numbers are 0-1 of it from the top left: arrow takes at (its tail) and to (its head), box, ellipse and highlight take rect [x, y, width, height], pin and text take at, stroke takes 2-${REVIEW_MARK_POINTS_MAX} pts. text needs a label; any mark may have one, the note beside it. conch colours marks itself. At most ${REVIEW_MARKS_MAX_BYTES} bytes in all.`,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 32, description: "Letters, digits, - or _; unique among these marks." },
                    kind: { type: "string", enum: REVIEW_MARK_KINDS },
                    frame: {
                      type: "object",
                      description: "Exactly one of canvas, image, selector or quote.",
                      properties: {
                        canvas: { type: "string", minLength: 1, maxLength: REVIEW_MARK_FRAME_MAX.canvas },
                        image: { type: "string", minLength: 1, maxLength: REVIEW_MARK_FRAME_MAX.image },
                        selector: { type: "string", minLength: 1, maxLength: REVIEW_MARK_FRAME_MAX.selector },
                        quote: { type: "string", minLength: 1, maxLength: REVIEW_MARK_FRAME_MAX.quote },
                      },
                      additionalProperties: false,
                    },
                    at: { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 },
                    to: { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 },
                    rect: { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, minItems: 4, maxItems: 4 },
                    pts: {
                      type: "array",
                      items: { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2 },
                      minItems: 2,
                      maxItems: REVIEW_MARK_POINTS_MAX,
                    },
                    label: { type: "string", minLength: 1, maxLength: REVIEW_MARK_LABEL_MAX },
                  },
                  required: ["id", "kind", "frame"],
                  additionalProperties: false,
                },
              },
            },
            required: ["v", "target"],
            additionalProperties: false,
          },
        },
        // `kind: "link"` without `link` is refused by the handler, for the same reason as conch_mode.
        required: ["summary"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_history",
      description: text.tools.conch_history,
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", minLength: 1, maxLength: HISTORY_ID_MAX_BYTES,
            description: "Recorded session ID or exact live session ID. Use self only for your verified caller. Labels are not IDs." },
          branch: { type: "string", minLength: 1, maxLength: HISTORY_ID_MAX_BYTES,
            description: "Optional ancestry tip whose branch to read: a recorded Claude item ID, or that message's own provider UUID. Omit for all indexed items; keep it unchanged while following a page cursor. A tip that cannot be proven reads every branch and reports coverage.branch as all." },
          before: { type: "string", minLength: 1, maxLength: HISTORY_CURSOR_MAX_BYTES,
            description: "Opaque previousCursor from an earlier page for this session and branch." },
          limit: { type: "integer", minimum: 1, maximum: HISTORY_MAX_LIMIT, default: HISTORY_DEFAULT_LIMIT },
        },
        required: ["session"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_item",
      description: text.tools.conch_item,
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", minLength: 1, maxLength: HISTORY_ID_MAX_BYTES,
            description: "Recorded session ID or exact live session ID. Use self only for your verified caller. Labels are not IDs." },
          item: { type: "string", minLength: 1, maxLength: HISTORY_ID_MAX_BYTES,
            description: "Item ID returned by conch_history." },
          bodyCursor: { type: "string", minLength: 1, maxLength: HISTORY_CURSOR_MAX_BYTES,
            description: "Opaque nextBodyCursor returned for this item. Omit to begin reading." },
        },
        required: ["session", "item"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_working_folders",
      description: text.tools.conch_working_folders,
      inputSchema: {
        type: "object",
        properties: {
          folders: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            maxItems: WORKING_FOLDERS_MAX,
            description: "The folder(s) you are actually working in, absolute or relative to your cwd. Each must exist. The first is where conch's file tree opens.",
          },
        },
        required: ["folders"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_on_screen",
      description: text.tools.conch_on_screen,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "conch_deliverables",
      description: text.tools.conch_deliverables,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "review_remove",
      description: text.tools.review_remove,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, description: "One filing's id, from review_to_front or conch_deliverables." },
          artifact: { type: "string", minLength: 1, description: "An artifact, removing every version of it you hold." },
        },
        // Exactly one of the two is refused by the handler, for the same reason as conch_mode.
        additionalProperties: false,
      },
    },
  ] as const satisfies readonly McpToolDefinition[];
}

export const MCP_TOOLS = buildMcpTools();

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];
/** `meta` is the call's `params._meta`, which a Codex client fills with the calling thread. */
export type McpToolHandler = (argumentsValue: unknown, meta?: unknown) => Promise<unknown>;
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
  renameProviderSession?(
    session: Readonly<SessionInfo>,
    label: string,
  ): Promise<ProviderRenameResult>;
  setWorkingFolders(sessionId: string, folders: readonly string[]): void;
  sendToDaemon(socketPath: string, event: TurnEvent): Promise<boolean>;
  sendControlMessage(
    socketPath: string,
    message: ControlMessage | HistoryRequest,
    timeoutMs?: number,
  ): Promise<ControlResult>;
  getSettingDescriptor: typeof getSettingDescriptor;
  parseSetting: typeof parseSetting;
  transcriptMark(transcriptPath: string): Promise<number>;
  lastAssistantText(transcriptPath: string, session: Readonly<SessionInfo>): Promise<string>;
  splitSentences(text: string): string[];
  now(): number;
  /** The process that spawned this server: the calling session, when it is one. */
  parentPid(): number;
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
  renameProviderSession(session, label) {
    return deliverProviderRename(loadConfig(), session, label);
  },
  setWorkingFolders,
  sendToDaemon,
  sendControlMessage,
  getSettingDescriptor,
  parseSetting,
  transcriptMark,
  // The loader the apps' panes read through, so a window of a shared session
  // answers from its own branch of the transcript (A8).
  async lastAssistantText(transcriptPath, session) {
    const conversation = await readConversationTail(
      transcriptPath,
      session.sessionId,
      transcriptFormatFor(transcriptPath),
      { window: session },
    );
    return lastAssistantReply(conversation);
  },
  splitSentences,
  now: Date.now,
  parentPid: () => process.ppid,
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
      // No daemon, so no latch: the same reconcile the daemon publishes through.
      const status = reconcileStatus(session, undefined, dependencies.now());
      return {
        id: session.sessionId,
        label: dependencies.sessionLabel(session, session.cwd),
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.workDirs === undefined ? {} : { workDirs: session.workDirs }),
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

/**
 * Where a wake or recite lands, in words.
 *
 * `sendToDaemon` is fire-and-forget, so the daemon's own refusal ("wake
 * refused — <holder> has the audio", C9b Cut B) reaches only its log. The
 * published `audioControl` is the same fact, and this reads it so the agent is
 * told instead of retrying. The phone's claim is not published, so it can only
 * be named as a possibility.
 */
async function audioWhere(
  sessionsPath: string,
  dependencies: McpDependencies,
): Promise<string> {
  let control: AudioControl | undefined;
  try {
    const raw = await dependencies.readSessionsFile(sessionsPath);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.audioControl)) {
      control = parsed.audioControl as unknown as AudioControl;
    }
  } catch {
    // No readable published state: an older daemon, which is local.
  }
  if (
    control
    && control.holder !== "local"
    && (control.expiresAt === null || control.expiresAt > dependencies.now())
  ) {
    return `refused: this Mac has yielded its audio to ${control.holder}, so nothing`
      + " opens or speaks here until that Mac's app releases it or the lease expires";
  }
  return "this Mac, or the phone when it holds the audio";
}

/**
 * Why an agent's `conch_speak` will not be heard, or null when it will.
 *
 * The daemon holds it while conch is paused by anyone but an agent — the same
 * test as A17's (`pause.paused && !pauseOrigin.agentOwns("")`) — and drops
 * it, but `sendToDaemon` cannot say so. The published `mode` carries both
 * halves of that test.
 */
async function speechHeld(
  sessionsPath: string,
  dependencies: McpDependencies,
): Promise<string | null> {
  let mode: unknown;
  try {
    const raw = await dependencies.readSessionsFile(sessionsPath);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (isRecord(parsed)) mode = parsed.mode;
  } catch {
    // No readable published state: nothing says conch is paused.
  }
  if (!isRecord(mode) || mode.paused !== true || mode.pausedByAgent === true) return null;
  return "not spoken: conch is in manual mode and no agent put it there (the user, a meeting,"
    + " or a manual mode restored at start), so an agent's speech is held — dropped, not"
    + " queued. Put it in your reply instead.";
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

/** Whether conch could tell which session is calling this server, and why not when it could not. */
export type CallerBinding =
  | { status: "verified"; session: SessionInfo }
  | { status: "unverified"; reason: string };

/**
 * The session that OWNS this MCP server, verified or not.
 *
 * Claude Code spawns the plugin's MCP server as a direct child of the session
 * process, so the parent pid identifies the caller when exactly one row has
 * it. A pid more than one row carries says only "one of these", and so does a
 * Codex app-server's: it hosts every thread it has open under one pid, which
 * conch withholds from those rows. Neither is a binding.
 *
 * A background session's row carries no pid (`BG_NO_TERMINAL`), so the pid
 * match misses it. Claude Code names each registry file after its process,
 * though, so the parent's own file still says which session is asking.
 */
async function callerBinding(
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
  meta?: unknown,
): Promise<CallerBinding> {
  const unverified = (reason: string): CallerBinding => ({ status: "unverified", reason });
  const parentPid = dependencies.parentPid();
  const threadId = codexCallingThread(meta);
  const hasParent = Number.isSafeInteger(parentPid) && parentPid > 1;
  if (!hasParent && threadId === undefined) {
    return unverified("this server has no parent session process");
  }
  const infos = (await dependencies.registrySnapshot(config.claudeDir))?.infos ?? [];
  const appServer = hasParent && infos.some((session) => session.noTerminal === appServerNoTerminal(parentPid));
  if (threadId !== undefined || appServer) {
    if (threadId === undefined) {
      return unverified(
        `its parent (pid ${parentPid}) is a Codex app-server, which hosts many threads under one pid,`
          + " and there is no thread identity in the request to say which thread is calling",
      );
    }
    // Only a live Codex row's own thread id binds: a forged id can claim no more
    // than a session the agent could name anyway, and a subagent never binds to
    // its parent's thread.
    const thread = infos.filter((session) => session.backend === "codex" && session.sessionId === threadId);
    return thread.length === 1
      ? { status: "verified", session: thread[0]! }
      : unverified(`codex thread ${threadId} not found among the live Codex sessions conch knows`);
  }
  const byPid = infos.filter((session) => session.pid === parentPid);
  if (byPid.length === 1) return { status: "verified", session: byPid[0]! };
  if (byPid.length > 1) {
    return unverified(
      `its parent (pid ${parentPid}) runs ${byPid.length} sessions`
        + ` (${byPid.map((session) => session.sessionId).join(", ")}), so the pid cannot say which one is calling`,
    );
  }
  const own = await readFile(join(config.claudeDir, "sessions", `${parentPid}.json`), "utf8")
    .then((raw) => JSON.parse(raw)?.sessionId)
    .catch(() => undefined);
  const window = typeof own === "string" && own ? windowKey(own, parentPid, true) : undefined;
  const found = window === undefined
    ? undefined
    : infos.find((session) => session.sessionId === window)
      ?? infos.find((session) => session.sessionId === own);
  return found
    ? { status: "verified", session: found }
    : unverified(`its parent (pid ${parentPid}) is not a live session conch knows`);
}

/**
 * The thread a Codex client says is calling, or undefined.
 *
 * Codex puts its turn metadata on every tools/call as
 * `_meta["x-codex-turn-metadata"]` (`mcp_tool_call.rs`
 * `build_mcp_tool_call_request_meta`), with the calling thread's `thread_id`.
 * The client sets it, not the model. Older builds send none, and it may arrive
 * as an object or as a JSON string, so anything unreadable is simply absent.
 */
function codexCallingThread(meta: unknown): string | undefined {
  let turn = isRecord(meta) ? meta["x-codex-turn-metadata"] : undefined;
  if (typeof turn === "string") {
    try {
      turn = JSON.parse(turn);
    } catch {
      return undefined;
    }
  }
  return isRecord(turn) && typeof turn.thread_id === "string" && turn.thread_id ? turn.thread_id : undefined;
}

/** Your own session, for a tool whose `session` was omitted; refused when conch can't verify it. */
async function ownSession(
  tool: string,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
  meta: unknown,
): Promise<SessionInfo> {
  const binding = await callerBinding(config, dependencies, meta);
  if (binding.status === "verified") return binding.session;
  throw new ToolInputError(
    `${tool} without \`session\` means your own session, and conch cannot verify which session is`
      + ` calling: ${binding.reason}. Pass \`session\` with an id from conch_sessions.`,
  );
}

/**
 * A session may only surface its OWN deliverable, and only a verified one.
 *
 * The dashboard attributes a review to the session it is filed under, so a
 * misattributed one puts words in a sibling's mouth, which is worse than not
 * filing at all. A `session` string is not proof of who is asking: an
 * unverified caller used to be able to name any session.
 */
async function requiredReviewSession(
  argumentsValue: Readonly<Record<string, unknown>>,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
  meta: unknown,
): Promise<SessionInfo> {
  const value = argumentsValue.session;
  const named = typeof value === "string" ? value.trim() : "";
  const binding = await callerBinding(config, dependencies, meta);
  if (binding.status !== "verified") {
    throw new ToolInputError(
      `conch cannot verify which session is calling (${binding.reason}), so it will not attribute`
        + " a publication to any session, including one you name. Leave the result in your reply,"
        + " or end your final reply with its own line: `conch:review <one-line summary> | <link-or-path>`.",
    );
  }
  const caller = binding.session;
  if (!named) return caller;
  // Naming yourself is fine; a name that is anyone else, or not only you, is not.
  const requested = await dependencies.findSessionByName(config.claudeDir, named).catch(() => null);
  if (requested?.sessionId === caller.sessionId) return caller;
  throw new ToolInputError(
    `a session can only surface its own work — you are "`
      + `${dependencies.sessionLabel(caller, caller.cwd)}" (${caller.sessionId}), and "${named}" `
      + (requested ? `is "${dependencies.sessionLabel(requested, requested.cwd)}"` : "does not name you alone")
      + ". Omit `session` to surface your own deliverable.",
  );
}

/** Your own verified session, for a tool that only ever acts on its caller; refused when conch can't tell. */
async function verifiedCaller(
  what: string,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
  meta: unknown,
): Promise<SessionInfo> {
  const binding = await callerBinding(config, dependencies, meta);
  if (binding.status === "verified") return binding.session;
  throw new ToolInputError(`refused: conch cannot verify which session is calling (${binding.reason}), so it will not ${what}`);
}

/** One held filing as the daemon publishes it (`rows[].reviews`), read defensively: the file is not ours. */
interface HeldDeliverable {
  id: string;
  artifact?: string;
  version?: number;
  kind?: string;
  summary: string;
  link?: string;
  at?: number;
  viewedAt?: number;
}

/**
 * What a session holds, oldest first, from the published state rather than the socket: the
 * same file `conch_sessions` returns, which the daemon rewrites on every change. Null when
 * there is no readable published state.
 */
async function heldDeliverables(
  sessionsPath: string,
  sessionId: string,
  dependencies: McpDependencies,
): Promise<HeldDeliverable[] | null> {
  let parsed: unknown;
  try {
    const raw = await dependencies.readSessionsFile(sessionsPath);
    parsed = raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) return null;
  const row = parsed.rows.find((candidate) => isRecord(candidate) && candidate.id === sessionId);
  if (!isRecord(row)) return [];
  const held = Array.isArray(row.reviews) ? row.reviews : row.review === undefined ? [] : [row.review];
  return held.filter((one): one is HeldDeliverable => isRecord(one) && typeof one.summary === "string" && typeof one.id === "string");
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
  // One pending speak per calling session. This server is the session's own
  // child process, so one variable IS per session.
  // ponytail: the window is audioTimeoutMs's estimate, because sendToDaemon
  // never reads a reply; upgrade to the daemon's ack if speak ever gets one.
  let speakingUntil = 0;

  async function readHistory(request: HistoryRequest, meta: unknown): Promise<HistoryResponse> {
    if (request.session === "self") {
      const binding = await callerBinding(config, dependencies, meta);
      if (binding.status !== "verified") {
        throw new ToolInputError("conch cannot verify which session is calling; pass an explicit recorded session ID or exact live ID from conch_sessions");
      }
      // The daemon maps this exact live/window ID to its indexed record. No transcript read here.
      request = { ...request, session: binding.session.sessionId };
    }
    let result: ControlResult;
    try { result = await dependencies.sendControlMessage(config.socketPath, request, 5_000); }
    catch { return historyError("unavailable", "recorded history is unavailable; the daemon did not answer"); }
    if (!result.ok) return historyError("unavailable", "recorded history is unavailable; the daemon did not answer");
    const parsed = validateHistoryResponse(result.response);
    if (!parsed.ok) return historyError("unavailable", "daemon returned an invalid recorded history response");
    if (parsed.value.kind !== request.kind && parsed.value.kind !== "history-off" && parsed.value.kind !== "history-error") {
      return historyError("unavailable", "daemon reply did not match the recorded history request");
    }
    return parsed.value;
  }

  return {
    async conch_history(argumentsValue, meta) {
      const parsed = parseHistoryPageRequest(argumentsValue);
      if (!parsed.ok) throw new ToolInputError(parsed.err);
      return readHistory({ kind: "history-page", ...parsed.value }, meta);
    },

    async conch_item(argumentsValue, meta) {
      const parsed = parseHistoryItemRequest(argumentsValue);
      if (!parsed.ok) throw new ToolInputError(parsed.err);
      return readHistory({ kind: "history-item", ...parsed.value }, meta);
    },

    async conch_sessions(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, []);
      const binding = await callerBinding(config, dependencies, meta);
      const caller = binding.status === "verified"
        ? {
          status: binding.status,
          sessionId: binding.session.sessionId,
          label: dependencies.sessionLabel(binding.session, binding.session.cwd),
        }
        : binding;

      try {
        const raw = await dependencies.readSessionsFile(sessionsPath);
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (!isRecord(parsed)) throw new Error("published state is not a JSON object");
          return { ...(parsed as unknown as PublishedState), caller };
        }
      } catch {
        // The daemon snapshot is advisory. A missing, unreadable, or malformed file
        // falls through to Claude's registry so the plugin remains useful.
      }
      return {
        ...publishedStateFromRegistry(await dependencies.registrySnapshot(config.claudeDir), dependencies),
        caller,
      };
    },

    async conch_wake(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session"]);
      const query = optionalString(argumentsObject, "session");
      // No global "last session" for an agent: omitted means the verified caller.
      const session = query
        ? await resolveSession(query, config, dependencies)
        : await ownSession("conch_wake", config, dependencies, meta);
      const audio = await audioWhere(sessionsPath, dependencies);
      const sent = await sendTurn(config, dependencies, {
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
        origin: "agent",
      });
      return { ...sent, audio };
    },

    async conch_recite(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session"]);
      const query = optionalString(argumentsObject, "session");
      const session = query
        ? await resolveSession(query, config, dependencies)
        : await ownSession("conch_recite", config, dependencies, meta);
      const audio = await audioWhere(sessionsPath, dependencies);
      const label = dependencies.sessionLabel(session, session.cwd);
      const transcriptPath = dependencies.findTranscript(
        config.claudeDir,
        session.sessionId,
      );
      if (!transcriptPath) {
        throw new Error(`nothing to recite for "${label}" — transcript not found`);
      }
      const sent = await sendTurn(config, dependencies, {
        type: "recite",
        sessionId: session.sessionId,
        label,
        pid: session.pid,
        cwd: session.cwd,
        transcriptPath,
        mark: await dependencies.transcriptMark(transcriptPath),
        announce: "",
      });
      return { ...sent, audio };
    },

    async conch_speak(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["text", "voice"]);
      const text = requiredString(argumentsObject, "text");
      const voice = optionalString(argumentsObject, "voice");
      if (text.length > MAX_SPEAK_CHARS) {
        throw new ToolInputError(
          `text is ${text.length} characters and conch_speak reads at most `
            + `${MAX_SPEAK_CHARS} — it is not cut for you. Say the short version and `
            + "leave the rest in your reply.",
        );
      }
      if (dependencies.now() < speakingUntil) {
        throw new ToolInputError(
          "already speaking for this session — wait for it to finish, or put "
            + "the words in your reply instead.",
        );
      }
      // Read before sending: the daemon decides on the pause as it stands now.
      const held = await speechHeld(sessionsPath, dependencies);
      const sent = await sendTurn(config, dependencies, {
        type: "speak",
        sessionId: "",
        label: "",
        announce: text,
        ...(voice === undefined ? {} : { voice }),
        // An agent asked, not the person: a manual mode you set holds this.
        origin: "agent",
      });
      // Dropped, so nothing is being spoken for a second call to wait on.
      if (held) return { ...sent, held };
      speakingUntil = dependencies.now() + audioTimeoutMs(text);
      return sent;
    },

    async conch_mode(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["action", "session", "scope"]);
      const action = requiredString(argumentsObject, "action");
      if (action !== "pause" && action !== "resume") {
        throw new ToolInputError("action must be pause or resume");
      }
      const scope = optionalString(argumentsObject, "scope");
      const query = optionalString(argumentsObject, "session");
      if (scope !== undefined && scope !== "all") {
        throw new ToolInputError(
          'scope must be "all" — omit it to switch only your own session',
        );
      }
      if (scope === "all") {
        // The whole daemon, the same bare event the Mac's global button sends.
        if (query) {
          throw new ToolInputError('session and scope: "all" cannot be used together');
        }
        return sendTurn(config, dependencies, {
          type: action,
          sessionId: "",
          label: "",
          announce: "",
          origin: "agent",
        });
      }
      // One session, the same scoped event the Mac's per-row control sends:
      // the daemon routes a pause/resume that names a session to
      // setSessionPaused, never to the global flip.
      const binding = query ? undefined : await callerBinding(config, dependencies, meta);
      if (binding?.status === "unverified") {
        throw new ToolInputError(
          `${action} needs a session and this server has no calling session it can verify`
            + ` (${binding.reason}) — pass \`session\` to name one, or \`scope: "all"\` to switch every `
            + `session (which the user can also do with \`conch ${action}\`)`,
        );
      }
      const session = binding?.status === "verified"
        ? binding.session
        : await resolveSession(query!, config, dependencies);
      return sendTurn(config, dependencies, {
        type: action,
        sessionId: session.sessionId,
        label: dependencies.sessionLabel(session, session.cwd),
        announce: "",
        // The daemon refuses an agent's resume while YOUR pause holds.
        origin: "agent",
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
        await dependencies.renameProviderSession?.(session, renamed.label);
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

    async conch_working_folders(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["folders"]);
      const raw = argumentsObject.folders;
      if (
        !Array.isArray(raw) || !raw.length || raw.length > WORKING_FOLDERS_MAX
        || !raw.every((folder) => typeof folder === "string" && folder.trim())
      ) {
        throw new ToolInputError(`refused: folders must be 1 to ${WORKING_FOLDERS_MAX} non-empty strings`);
      }
      // Its own session only, verified: where a session works is not something another
      // session gets to say.
      const binding = await callerBinding(config, dependencies, meta);
      if (binding.status !== "verified") {
        throw new ToolInputError(
          `refused: conch cannot verify which session is calling (${binding.reason}), so it will not record where any session works`,
        );
      }
      // Absolute by the time it leaves here, like a review link: resolved against this
      // process's cwd, which is the session's.
      const folders: string[] = [];
      for (const folder of raw as string[]) {
        const path = resolve(process.cwd(), folder.trim());
        const found = await stat(path).catch(() => null);
        if (!found?.isDirectory()) throw new ToolInputError(`refused: ${folder} is not a folder that exists`);
        if (!folders.includes(path)) folders.push(path);
      }
      dependencies.setWorkingFolders(binding.session.sessionId, folders);
      // ponytail: the daemon reads the file at its next render (any hook event, or its 20s
      // timer); a socket nudge if that ever feels slow.
      return { outcome: "recorded", sessionId: binding.session.sessionId, folders };
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
      // The allowlist, before the registry lookup: a key the registry knows
      // but an agent may not touch is refused by name, with the command the
      // user runs instead.
      if (
        (hasValue || shouldUnset)
        && !(AGENT_TUNABLE_SETTINGS as readonly unknown[]).includes(argumentsObject.key)
      ) {
        const key = String(argumentsObject.key);
        throw new ToolInputError(
          `"${key}" is not a setting an agent may change; agents may set only `
            + `${AGENT_TUNABLE_SETTINGS.join(", ")}. Ask the user to run `
            + `\`conch ${shouldUnset ? `unset ${key}` : `set ${key} <value>`}\` themselves.`,
        );
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
      const text = await dependencies.lastAssistantText(transcriptPath, session);
      // Which session answered, since a name can resolve to one you didn't spell out.
      return {
        sessionId: session.sessionId,
        label: dependencies.sessionLabel(session, session.cwd),
        text: dependencies.splitSentences(text).slice(-countValue).join(" "),
      };
    },

    async conch_deliverables(argumentsValue, meta) {
      allowOnly(toolArguments(argumentsValue), []);
      const session = await verifiedCaller("say which deliverables are yours", config, dependencies, meta);
      const held = await heldDeliverables(sessionsPath, session.sessionId, dependencies);
      if (!held) throw new Error("failed: conch has no readable published state, so the daemon is not running");
      // Your own, newest first, and only what names and tells them apart: not conch_sessions' dump.
      return {
        sessionId: session.sessionId,
        deliverables: held.map((one, index) => ({
          id: one.id,
          ...(one.artifact ? { artifact: one.artifact } : {}),
          ...(one.version !== undefined ? { version: one.version } : {}),
          ...(one.kind ? { kind: one.kind } : {}),
          summary: one.summary,
          ...(one.link ? { link: one.link } : {}),
          ...(one.at !== undefined ? { at: one.at } : {}),
          ...(one.viewedAt !== undefined ? { viewedAt: one.viewedAt } : {}),
          superseded: held.slice(index + 1).some((later) => artifactOf(later) === artifactOf(one)),
        })).reverse(),
      };
    },

    async review_remove(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["id", "artifact"]);
      const id = optionalString(argumentsObject, "id")?.trim();
      const artifact = optionalString(argumentsObject, "artifact")?.trim();
      if ((id === undefined) === (artifact === undefined)) {
        throw new ToolInputError("refused: pass exactly one of id (one filing) or artifact (every version of it)");
      }
      // Your own session only: the command names the caller, so an id another session holds
      // matches nothing and is refused by the daemon.
      const session = await verifiedCaller("remove any session's deliverables", config, dependencies, meta);
      const result = await dependencies.sendControlMessage(config.socketPath, {
        kind: "session-command",
        sessionId: session.sessionId,
        command: "review-remove",
        ...(id !== undefined ? { review: id } : { artifact }),
      });
      if (!result.ok && result.reason === "daemon-down") {
        throw new Error("failed: conch daemon is not running, so nothing was removed");
      }
      const response = unwrapControlResult(result);
      if (response.kind !== "session-ack" || response.command !== "review-remove" || !response.changed) {
        throw new Error("ack-unknown: daemon reply did not match the remove request");
      }
      return { outcome: "removed", sessionId: session.sessionId, ...(id !== undefined ? { id } : { artifact }) };
    },

    async review_to_front(argumentsValue, meta) {
      // Accepted, refused or failed, and each says which. A refusal names its
      // reason and nothing reaches the daemon.
      const { summary, truncatedFrom, link, scene, kind, key, session } = await (async () => {
        const argumentsObject = toolArguments(argumentsValue);
        allowOnly(argumentsObject, ["summary", "link", "kind", "key", "session", "scene"]);
        const cleaned = sanitizeReviewSummary(requiredString(argumentsObject, "summary"), Infinity);
        if (!cleaned) throw new ToolInputError("summary must be a non-empty string");
        const scene = Object.hasOwn(argumentsObject, "scene")
          ? checkReviewScene(argumentsObject.scene, Object.hasOwn(argumentsObject, "link"))
          : undefined;
        if (scene && !scene.ok) throw new ToolInputError(scene.reason);
        const kind = optionalString(argumentsObject, "kind");
        if (kind !== undefined && !isDeliverableKind(kind)) {
          throw new ToolInputError(`kind must be one of ${DELIVERABLE_KINDS.join(", ")}`);
        }
        const kindRefusal = kind && deliverableKindRefusal(kind, Object.hasOwn(argumentsObject, "link"));
        if (kindRefusal) throw new ToolInputError(kindRefusal);
        const rawKey = optionalString(argumentsObject, "key");
        const key = rawKey === undefined ? undefined : sanitizeReviewSummary(rawKey, Infinity);
        if (key !== undefined && (!key || key.length > ARTIFACT_KEY_MAX)) {
          throw new ToolInputError(`key must be 1 to ${ARTIFACT_KEY_MAX} printable characters; it names the artifact, it does not describe it`);
        }
        const session = await requiredReviewSession(argumentsObject, config, dependencies, meta);
        const rawLink = optionalString(argumentsObject, "link");
        // Absolute by the time it leaves here, resolved against this process's
        // cwd (the session's): the raw relative string reached the Mac app,
        // which resolved it against its own cwd and previewed a missing file.
        const checked = rawLink === undefined ? undefined : await checkReviewLink(rawLink, process.cwd());
        if (checked && !checked.ok) throw new ToolInputError(checked.reason);
        const images = await markImagesRefusal(scene?.ok ? scene.scene : undefined, process.cwd());
        if (images) throw new ToolInputError(images);
        return {
          summary: cleaned.slice(0, REVIEW_SUMMARY_MAX),
          truncatedFrom: cleaned.length > REVIEW_SUMMARY_MAX ? cleaned.length : undefined,
          link: checked?.link,
          scene: scene?.scene,
          kind,
          key,
          session,
        };
      })().catch((error) => {
        throw new ToolInputError(`refused: ${errorMessage(error)}`);
      });
      const label = dependencies.sessionLabel(session, session.cwd);
      // What the daemon will file, computed by the same rules it files with, so the agent gets
      // its handles back from a send that has no reply (`sendToDaemon` is fire-and-forget).
      const at = dependencies.now();
      const review = { summary, ...(link ? { link } : {}), ...(scene ? { scene } : {}), ...(kind ? { kind } : {}), ...(key ? { key } : {}) };
      const facts = deliverableFacts(review);
      // ponytail: the version is predicted from the published state by the daemon's own rule
      // (`nextVersion`); a publication still queued behind speech isn't published yet, so it can
      // read one low. conch_deliverables says what was filed. A reply from the daemon if it bites.
      const version = nextVersion(await heldDeliverables(sessionsPath, session.sessionId, dependencies) ?? [], facts.artifact);
      const sent = await (async () => {
        const transcriptPath = dependencies.findTranscript(config.claudeDir, session.sessionId);
        // Not a turn-end: publishing happens mid-turn, and the turn's own Stop
        // says when it finished.
        return dependencies.sendToDaemon(config.socketPath, {
          type: "review-published",
          sessionId: session.sessionId,
          label,
          cwd: session.cwd,
          pid: session.pid,
          announce: `${label} has work ready for your review: ${summary}`,
          ...(transcriptPath
            ? { transcriptPath, mark: await dependencies.transcriptMark(transcriptPath) }
            : {}),
          eventAt: at,
          review,
        });
      })().catch((error) => {
        throw new Error(`failed: ${errorMessage(error)}`);
      });
      if (!sent) throw new Error("failed: conch daemon is not running, so nothing was published");
      return {
        outcome: "accepted",
        sessionId: session.sessionId,
        label,
        // This filing's own id, the artifact it is a version of, and which version: what
        // conch_deliverables lists and review_remove takes.
        id: reviewIdentity(session.sessionId, { summary, link, at }),
        artifact: facts.artifact,
        version,
        kind: facts.kind,
        summary,
        ...(link ? { link } : {}),
        ...(scene ? { scene } : {}),
        ...(truncatedFrom === undefined
          ? {}
          : { summaryTruncated: { from: truncatedFrom, to: REVIEW_SUMMARY_MAX } }),
      };
    },

    // Anyone may ask, verified or not: it names what is on screen, and changes nothing.
    async conch_on_screen(argumentsValue) {
      allowOnly(toolArguments(argumentsValue), []);
      let published: unknown;
      try {
        const raw = await dependencies.readSessionsFile(sessionsPath);
        published = raw === null ? null : JSON.parse(raw);
      } catch {
        // Unreadable is the same answer as absent: nothing is known.
      }
      const showing = isRecord(published) && isRecord(published.showing) ? published.showing : null;
      if (!showing) {
        return { showing: null, reason: "conch has seen nothing on screen since its daemon started, or the daemon is not running" };
      }
      const rows = isRecord(published) && Array.isArray(published.rows) ? published.rows : [];
      const row = rows.find((candidate: unknown) => isRecord(candidate) && candidate.id === showing.sessionId);
      return { showing, ...(isRecord(row) && typeof row.label === "string" ? { label: row.label } : {}) };
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

function historyRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  const response = jsonRpcResult(id, result);
  const fits = (value: JsonRpcResponse) => Buffer.byteLength(serializeJsonRpcLine(value), "utf8") + 1 <= MCP_HISTORY_MAX_BYTES;
  if (fits(response)) return response;
  const refused = jsonRpcResult(id, toolResult(JSON.stringify(historyError("response-too-large", "recorded history response exceeds its wire limit"))));
  return fits(refused) ? refused : jsonRpcError(null, -32600, "history request ID exceeds its wire limit");
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
          const value = await handlers[name as McpToolName](argumentsValue, message.params._meta);
          if (name === "conch_history" || name === "conch_item") {
            if (!shouldReply) return null;
            // A text content block escapes the JSON again. Budget the final UTF-8 wire frame.
            return historyRpcResult(requestId, toolResult(JSON.stringify(value)));
          }
          return shouldReply
            ? jsonRpcResult(requestId, toolResult(value))
            : null;
        } catch (error) {
          if (name === "conch_history" || name === "conch_item") {
            return shouldReply ? historyRpcResult(requestId, toolError(error)) : null;
          }
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

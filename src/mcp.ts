import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AudioControl } from "./audio-holder.ts";
import { audioTimeoutMs } from "./audio-watchdog.ts";
import { loadConfig, type Config } from "./config.ts";
import { CONCH_VERSION } from "./version.ts";
import { sendToDaemon, type TurnEvent } from "./hook.ts";
import { artifactOf, nextVersion, reconcileStatus } from "./panel.ts";
import { APPROVAL_LABEL_MAX, checkApprovalRequest } from "./review-approval.ts";
import {
  renameProviderSession as deliverProviderRename,
  type ProviderRenameResult,
} from "./provider-rename.ts";
import {
  AmbiguousSessionError,
  findSessionByName,
  findTranscript,
  registrySnapshot,
  renameSessionLabel,
  sessionLabel,
  setWorkingFolders,
  sessionLabelSource,
  type RegistrySnapshot,
  type SessionInfo,
} from "./sessions.ts";
import {
  getSettingDescriptor,
  parseSetting,
  sendControlMessage,
  SETTING_KEYS,
  type ConfigAck,
  type ConfigSnapshot,
  type ControlMessage,
  type ControlResponse,
  type ControlResult,
  type RuntimeControlMessage,
  type SettingKey,
} from "./settings.ts";
import { AGENT_COMMANDS, AGENT_INSTRUCTIONS, MAX_SPEAK_CHARS, movedToolDescription, type AgentInstructions } from "./agent-instructions.ts";
import { AgentUsageError, cliWorded, cliWording, parseAgentCommand, renderAgentAnswer, splitCommandLine, usageErrorText } from "./agent-commands.ts";
import { checkBugReport, requestBugReport, bugRecord, BUG_REPORT_KIND, BUG_REPORT_REPLY_MS, type BugReportRequest } from "./bug-report.ts";
import { appendConchError } from "./app-errors.ts";
import { publishForVerdict, REVIEW_VERDICT_TIMEOUT_MS, type PublishReply } from "./review-verdict.ts";
import { NOTICE_BODY_MAX, NOTICE_TITLE_MAX, noticeLinkError, noticeText, requestNotice, type NoticeRequest } from "./notice-wire.ts";
import { isPageAccess } from "./page-access.ts";
import { MARK_UNITS, scenePixelsToFractions } from "./mark-pixels.ts";
import { RelabelHints, type LabelSource } from "./label-drift.ts";
import { backendOfClient, McpCallLog, type McpCaller, type McpCallObservation, type McpCallOutcome } from "./mcp-usage.ts";
import { compactSessionList, detailedSession, rowMatches, type SessionsView } from "./mcp-sessions.ts";
import { assistantTail, TAIL_WAIT_MAX_S, waitForTail, type AssistantTail } from "./transcript-tail.ts";
import { readSessionSignIns, signInForStart, type ClaudeSessionSignIn } from "./claude-session-sign-ins.ts";
import { adapterFor } from "./agent-adapter.ts";
import { startOptionsError, startPromptError, START_PROMPT_MAX } from "./session-lifecycle.ts";

/** A session works in a few folders, not a filesystem. */
const WORKING_FOLDERS_MAX = 8;

/**
 * How long `conch_fork` waits for the daemon: its Terminal or background start, then up to `FORK_WAIT_MS` (25 s,
 * session-fork.ts, not imported so this server stays light) for the fork to be seen running. Under Codex's 60 s tool
 * timeout.
 */
export const CONCH_FORK_REPLY_MS = 45_000;

/** How long `conch_start` waits for the daemon: the same start and the same wait for it to be seen (`startLiveSession`). */
export const CONCH_START_REPLY_MS = CONCH_FORK_REPLY_MS;
/** How long `conch_notify` waits: the Mac app's word (a few seconds) and Apple's answer for each phone. */
export const NOTIFY_REPLY_MS = 30_000;
import {
  checkLocalFile,
  checkReviewLink,
  checkReviewScene,
  markImagesRefusal,
  resolveReviewFocus,
  REVIEW_INSPECT_MAX,
  REVIEW_MARK_FRAME_MAX,
  REVIEW_MARK_KINDS,
  REVIEW_MARK_LABEL_MAX,
  REVIEW_MARKS_MAX,
  REVIEW_SCENE_KINDS,
  type ReviewScene,
  REVIEW_SUMMARY_MAX,
  SAFE_REVIEW_LINK,
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
  FOCUS_MAX,
  folderRefusal,
  isDeliverableKind,
  LINKLESS_DELIVERABLE_KINDS,
  readDeliverableKind,
} from "./deliverables.ts";
import { reviewLinkScope, transcriptFolder, type LinkScope } from "./review-roots.ts";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_MARK_KINDS,
  CAPTURE_REPLY_MS,
  CAPTURE_VIEWPORT_DEFAULT,
  CAPTURE_VIEWPORT_MAX,
  CAPTURE_VIEWPORT_MIN,
  parseCaptureMark,
  parseCaptureTarget,
  parseCaptureViewport,
  requestPageCapture,
  type CaptureMarkSpec,
  type CaptureTarget,
  type CaptureViewport,
  type PageCaptureMessage,
  type PageCaptureReply,
  type PageCaptureSend,
} from "./page-capture.ts";
import { sessionOfProcess, unverified, type CallerBinding, type ShellCaller } from "./caller-session.ts";
import {
  BROWSER_ASK_REASON_MAX,
  BROWSER_REPLY_MS,
  BROWSER_TARGET_MAX,
  BROWSER_TEXT_MAX,
  BROWSER_URL_MAX,
  askReason,
  isBrowserTabId,
  parseBrowserTarget,
  requestBrowser,
  webUrl,
  type BrowserMessage,
  type BrowserReply,
  type BrowserSend,
  type BrowserTarget,
} from "./browser-workbench.ts";
import { compactRead, READ_SELECTOR_MAX, READ_WORDS_MAX, readView, ReadViewError } from "./browser-read.ts";
import { appServerNoTerminal } from "./codex-threads.ts";
import { ATLAS_MARKDOWN_MAX_BYTES, ATLAS_PATH_MAX, atlasCopiesFolder, atlasFiling, atlasPagePath, writeAtlasCopy } from "./atlas-copies.ts";
import {
  HANDOFF_FROM_ENV,
  HANDOFF_LISTED_ENV,
  HANDOFF_PARENT_ENV,
  handoffParentPid,
  McpHandoff,
  processParent,
  streamLines,
  type McpHandoffOptions,
} from "./mcp-handoff.ts";
import { MCP_TOOLSET } from "./mcp-toolset.ts";
import { mcpServersDir, removeMcpServerReport, writeMcpServerReport, type McpServerReport } from "./mcp-servers.ts";
import { transcriptFormatFor } from "./agent-adapter.ts";
import {
  HISTORY_CURSOR_MAX_BYTES, HISTORY_DEFAULT_LIMIT, HISTORY_ID_MAX_BYTES, HISTORY_MAX_LIMIT,
  historyError, parseHistoryItemRequest, parseHistoryPageRequest, validateHistoryResponse,
  type HistoryRequest, type HistoryResponse,
} from "./history.ts";

/**
 * The MCP revisions this server speaks, newest first. `initialize` answers the client's own when
 * it is one of these, else the newest (the spec's negotiation): Claude Code 2.1.280 asks for
 * 2025-11-25 and takes 2025-06-18; it used to be told 2024-11-05 whatever it asked. A tools-only
 * server meets each of these as it is, and 2025-03-26's JSON-RPC batches are answered
 * (`runMcpServer`).
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];

/** The revision to answer a client's `initialize` with: its own when this server speaks it, else the newest. */
export function negotiateProtocolVersion(requested: unknown): string {
  return MCP_PROTOCOL_VERSIONS.find((version) => version === requested) ?? MCP_PROTOCOL_VERSION;
}
/**
 * The daemon's published state, by the name the daemon and the Mac app read (status.ts
 * `SESSIONS_FILE`): an MCP server started beside a daemon in a temp home reads that daemon's, not
 * the live one's.
 */
export const MCP_SESSIONS_FILE = process.env.CONCH_SESSIONS_FILE || "/tmp/conch-sessions.json";
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

/**
 * Every tool this server answers, listed or not. Descriptions come from the one instruction source,
 * `agent-instructions.ts`: a listed tool's (`text.tools`), or, for one that moved to `conch agent`, where it went
 * (`movedToolDescription`), which is what a session started before the move still sees (`listedMcpTools`).
 */
export function buildMcpToolDefinitions(text: AgentInstructions = AGENT_INSTRUCTIONS) {
  const describe = (name: string): string => (text.tools as Record<string, string>)[name] ?? movedToolDescription(name);
  return [
    {
      name: "conch_sessions",
      description: describe("conch_sessions"),
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            minLength: 1,
            description: "Optional. Only the sessions this names: an id, the first 4+ characters of one, or part of a label (any case).",
          },
          detail: {
            type: "boolean",
            default: false,
            description: "Optional, with session naming exactly one: that session's full row (its deliverables, last line, settings, context), instead of the short entry.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "conch_wake",
      description: describe("conch_wake"),
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
      description: describe("conch_recite"),
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
      description: describe("conch_speak"),
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
      description: describe("conch_mode"),
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
      description: describe("conch_rename"),
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
      description: describe("conch_config"),
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
      description: describe("conch_transcript_tail"),
      inputSchema: {
        type: "object",
        properties: {
          session: { type: "string", minLength: 1 },
          sentences: {
            type: "integer",
            minimum: 1,
            default: 3,
          },
          since: {
            type: "string",
            minLength: 1,
            description: "Optional. The cursor an earlier call returned: the reply says unchanged, \"no new text\", instead of the same words again.",
          },
          wait: {
            type: "number",
            minimum: 0,
            maximum: TAIL_WAIT_MAX_S,
            description: `Optional. Seconds (at most ${TAIL_WAIT_MAX_S}) to wait for text newer than since (or than what the session shows now), returning as soon as there is some. Your other conch calls wait behind it.`,
          },
        },
        required: ["session"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_fork",
      description: describe("conch_fork"),
      inputSchema: {
        type: "object",
        properties: {
          session: {
            type: "string",
            minLength: 1,
            description: "Optional. The live session to fork, by id or label; your own verified session when omitted.",
          },
          label: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "Optional. The fork's label in conch, e.g. \"Marketing pass\"; else \"<its label> · fork\".",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "conch_start",
      description: describe("conch_start"),
      inputSchema: {
        type: "object",
        properties: {
          backend: { type: "string", enum: ["claude", "codex"], description: "Optional. claude (Claude Code, the default) or codex." },
          folder: { type: "string", minLength: 1, description: "Optional. The folder it works in, absolute or relative to your cwd; your own cwd when omitted." },
          signIn: {
            type: "string",
            minLength: 1,
            description: "Optional, Claude only. One of conch's Claude sign-ins, by its label (any case) or id, as conch_sessions lists them in claudeSignIns. Omitted: Default's own, rotating login.",
          },
          model: { type: "string", minLength: 1, description: "Optional. A model alias or name, e.g. \"fable\", \"opus\" or \"claude-fable-5\"; else the agent's default." },
          effort: { type: "string", minLength: 1, description: "Optional. Claude: low, medium, high, xhigh or max. Codex: its reasoning effort (none, minimal, low, medium, high, xhigh, max…)." },
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: START_PROMPT_MAX,
            description: `Optional. Its first message, one line of at most ${START_PROMPT_MAX} characters, not starting with "-": it starts working on it at once.`,
          },
          host: { type: "string", enum: ["terminal", "background"], description: "Optional. terminal (a Terminal window, the default) or background (conch's background host, no window)." },
          label: { type: "string", minLength: 1, maxLength: 80, description: "Optional. Its label in conch, e.g. \"Fable · research\"." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "review_to_front",
      description: describe("review_to_front"),
      // 2026-11-11: a line a parameter; what each does in full is `conch agent help publish` (AGENT_COMMANDS) and the
      // skill. The schema was 2,009 tokens, 27% of the whole tool list, 4,660 characters of it the parameters' prose;
      // ToolSearch loaded it 71 times in 7 days, and Codex carries it in every session. The marks' own schema (a third
      // of it) went with their prose: 3 of 1,057 calls in 30 days drew any, and the handler checks each one in full
      // (snippet.ts `checkReviewScene`), naming what to fix.
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            minLength: 1,
            maxLength: REVIEW_SUMMARY_MAX,
            description: `One line: what it is, what to check. Over ${REVIEW_SUMMARY_MAX} characters is cut.`,
          },
          link: {
            type: "string",
            minLength: 1,
            description: "Optional. An http(s) URL, or a file or folder under this session's folders or a temp folder (conch keeps a copy).",
          },
          kind: { type: "string", enum: DELIVERABLE_KINDS, description: "Optional; read off the link. Only these may have no link: " + LINKLESS_DELIVERABLE_KINDS.join(", ") + "." },
          focus: {
            type: "array",
            minItems: 1,
            maxItems: FOCUS_MAX,
            items: { type: "string", minLength: 1 },
            description: "Optional, with a folder link: the paths in it to point at.",
          },
          key: {
            type: "string",
            minLength: 1,
            maxLength: ARTIFACT_KEY_MAX,
            description: "Optional. Names the artifact, so publishing it again is its next version; the link when omitted.",
          },
          session: { type: "string", minLength: 1, description: "Omit it: you publish as your own session only." },
          approval: {
            type: "object",
            description: "Optional, and only when you are waiting on the user's yes to proceed: never by default. Their Approve sends you \"Approved: <label>.\"",
            properties: {
              label: { type: "string", minLength: 1, maxLength: APPROVAL_LABEL_MAX },
            },
            additionalProperties: false,
          },
          scene: {
            type: "object",
            description: "Optional. What the pill click brings forward.",
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
              inspect: { type: "string", minLength: 1, maxLength: REVIEW_INSPECT_MAX, description: "One line: what to check." },
              marks: {
                type: "array",
                minItems: 1,
                maxItems: REVIEW_MARKS_MAX,
                items: { type: "object" },
                description: "Optional ink: [{id, kind, frame: {selector|quote|image|canvas}, rect|at|to|pts, label}]; `conch agent help publish` says how.",
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
      description: describe("conch_history"),
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
      description: describe("conch_item"),
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
      description: describe("conch_working_folders"),
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
      description: describe("conch_on_screen"),
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "conch_deliverables",
      description: describe("conch_deliverables"),
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "review_remove",
      description: describe("review_remove"),
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
    {
      name: "conch_capture",
      description: describe("conch_capture"),
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            minLength: 1,
            description: "The page: an http(s) URL (a live site, a preview deployment, a dev server on localhost), or a local .html file under this session's folders or /tmp, absolute or relative to your cwd.",
          },
          target: {
            type: "object",
            description: `Optional. The one part of the page to capture, exactly one of: selector (CSS, querySelector's first match) or quote (words as they appear on the page; the first place they are visible), at most ${REVIEW_MARK_FRAME_MAX.selector} characters. conch scrolls it to the middle of the view, waits for it to settle, and captures it with a margin round it. Omit to capture the top of the page.`,
            properties: {
              selector: { type: "string", minLength: 1, maxLength: REVIEW_MARK_FRAME_MAX.selector },
              quote: { type: "string", minLength: 1, maxLength: REVIEW_MARK_FRAME_MAX.quote },
            },
            additionalProperties: false,
          },
          viewport: {
            type: "object",
            description: `Optional. The window the page is drawn in, in CSS pixels: width ${CAPTURE_VIEWPORT_MIN.width}-${CAPTURE_VIEWPORT_MAX.width}, height ${CAPTURE_VIEWPORT_MIN.height}-${CAPTURE_VIEWPORT_MAX.height}. Defaults to ${CAPTURE_VIEWPORT_DEFAULT.width} by ${CAPTURE_VIEWPORT_DEFAULT.height}; a phone is about 390 by 844.`,
            properties: {
              width: { type: "integer", minimum: CAPTURE_VIEWPORT_MIN.width, maximum: CAPTURE_VIEWPORT_MAX.width },
              height: { type: "integer", minimum: CAPTURE_VIEWPORT_MIN.height, maximum: CAPTURE_VIEWPORT_MAX.height },
            },
            required: ["width", "height"],
            additionalProperties: false,
          },
          fullPage: {
            type: "boolean",
            default: false,
            description: "Optional. The whole page top to bottom rather than one view of it (drawn at its full height, so a section sized to the window grows with it). With a target, the target is boxed where it is on the page.",
          },
          mark: {
            anyOf: [
              { type: "string", enum: ["box", "highlight"] },
              {
                type: "object",
                properties: {
                  kind: { type: "string", enum: CAPTURE_MARK_KINDS },
                  label: { type: "string", minLength: 1, maxLength: REVIEW_MARK_LABEL_MAX },
                },
                required: ["kind"],
                additionalProperties: false,
              },
            ],
            description: "Optional, with target: a mark round it on the capture, \"box\" or \"highlight\", or {kind, label} with kind box, highlight, ellipse, arrow, pin or text (text needs its label). Returned as review_to_front scene marks on the image, and drawn on it when publish files it.",
          },
          publish: {
            type: "object",
            description: "Optional. File the capture as your deliverable (kind image, with the mark) in one step, as review_to_front would: summary is its one line, key names the artifact (defaults to the page and the target, so capturing the same part again is its next version). Not filed when the page showed a sign-in screen.",
            properties: {
              summary: { type: "string", minLength: 1, maxLength: REVIEW_SUMMARY_MAX, description: `One line, at most ${REVIEW_SUMMARY_MAX} characters.` },
              key: { type: "string", minLength: 1, maxLength: ARTIFACT_KEY_MAX },
            },
            required: ["summary"],
            additionalProperties: false,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_open",
      description: describe("browser_open"),
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            minLength: 1,
            maxLength: BROWSER_URL_MAX,
            description: "An http(s) URL: a live site, a preview deployment, a dev server on localhost.",
          },
          profile: {
            type: "string",
            minLength: 1,
            maxLength: 80,
            description: "Optional. The browser profile to sign in with, by name or id; Default when omitted. A tab keeps the profile it was opened with.",
          },
          tab: { ...BROWSER_TAB_SCHEMA, description: "Optional. One of your tabs to go to url in, instead of opening a new one." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_read",
      description: describe("browser_read"),
      inputSchema: {
        type: "object",
        // 2026-11-11: one page of the words by default (browser-read.ts says why); these ask for another part, or all.
        properties: {
          tab: BROWSER_TAB_SCHEMA,
          page: { type: "integer", minimum: 1, description: "Optional. That page of the words; the answer's page says how many." },
          find: { type: "string", minLength: 1, maxLength: READ_WORDS_MAX, description: "Optional. Only the lines and elements that say these words." },
          section: { type: "string", minLength: 1, maxLength: READ_WORDS_MAX, description: "Optional. The words under the heading that says this." },
          selector: { type: "string", minLength: 1, maxLength: READ_SELECTOR_MAX, description: "Optional. A CSS selector: read only that part of the page." },
          full: { type: "boolean", description: "Optional. The whole read: every word, link, button and field." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_click",
      description: describe("browser_click"),
      inputSchema: {
        type: "object",
        properties: { tab: BROWSER_TAB_SCHEMA, target: BROWSER_TARGET_SCHEMA },
        required: ["target"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_type",
      description: describe("browser_type"),
      inputSchema: {
        type: "object",
        properties: {
          tab: BROWSER_TAB_SCHEMA,
          target: BROWSER_TARGET_SCHEMA,
          text: { type: "string", maxLength: BROWSER_TEXT_MAX, description: "What to type; it replaces what the field holds. Never a password." },
          submit: { type: "boolean", default: false, description: "Optional. Press Return afterwards, submitting the field's form." },
        },
        required: ["target", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_screenshot",
      description: describe("browser_screenshot"),
      inputSchema: {
        type: "object",
        properties: { tab: BROWSER_TAB_SCHEMA },
        additionalProperties: false,
      },
    },
    {
      name: "browser_tabs",
      description: describe("browser_tabs"),
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_ask",
      description: describe("browser_ask"),
      inputSchema: {
        type: "object",
        properties: {
          tab: { ...BROWSER_TAB_SCHEMA, description: "Optional. The tab to ask in: one of your tab ids (browser_tabs); your most recent tab when omitted." },
          reason: {
            type: "string",
            minLength: 1,
            maxLength: BROWSER_ASK_REASON_MAX,
            description: `What the user is to do in the tab, as one short line they read on it: "Sign in to Mobbin", "Approve the Google consent screen". At most ${BROWSER_ASK_REASON_MAX} characters.`,
          },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_close",
      description: describe("browser_close"),
      inputSchema: {
        type: "object",
        properties: { tab: { ...BROWSER_TAB_SCHEMA, description: "The tab to close: one of your tab ids (browser_tabs)." } },
        required: ["tab"],
        additionalProperties: false,
      },
    },
    {
      name: "atlas_show",
      description: describe("atlas_show"),
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            maxLength: ATLAS_PATH_MAX,
            description: "The page's Atlas path, as your Atlas tools name it: projects/conch/direction-2026-10-16.md, work/<org>/notes. .md is added to the copy's name when the path has none.",
          },
          markdown: {
            type: "string",
            minLength: 1,
            description: "The page's Markdown, exactly as you read it or as you wrote it to Atlas. At most 2 MB.",
          },
          summary: {
            type: "string",
            minLength: 1,
            description: "Optional. One line on what the page is and what to look at; conch adds the Atlas path when it isn't in it. Defaults to \"Atlas page <path>\".",
          },
        },
        required: ["path", "markdown"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_notify",
      description: describe("conch_notify"),
      inputSchema: {
        type: "object",
        properties: {
          body: {
            type: "string",
            minLength: 1,
            maxLength: NOTICE_BODY_MAX,
            description: "What the user needs to know, in a sentence or two: \"The deploy finished and the smoke tests pass.\"",
          },
          title: {
            type: "string",
            minLength: 1,
            maxLength: NOTICE_TITLE_MAX,
            description: "Optional. The notification's first line; your session's name when omitted.",
          },
          session: {
            type: "string",
            minLength: 1,
            description: "Optional. The session a tap opens, by id or label; your own verified session when omitted.",
          },
          link: {
            type: "string",
            minLength: 1,
            description: "Optional. An http(s) URL the notification offers to open (a PR, a deployed page).",
          },
        },
        required: ["body"],
        additionalProperties: false,
      },
    },
    {
      name: "conch_run",
      description: describe("conch_run"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            minLength: 1,
            maxLength: CONCH_RUN_COMMAND_MAX,
            description: "The words after `conch agent`, quoted as in a shell: `tail 1a2b --wait 30`.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  ] as const satisfies readonly McpToolDefinition[];
}

/** A mark's field names (snippet.ts `checkReviewScene`), which review_to_front's schema no longer spells out. */
const REVIEW_MARK_VOCABULARY = ["id", "kind", "frame", "canvas", "image", "selector", "quote", "at", "to", "rect", "pts", "units", "size", "label"] as const;

/** The longest command line `conch_run` takes: a publish's marks or a bug's words, not a file's contents (`--file`). */
export const CONCH_RUN_COMMAND_MAX = 16 * 1024;

/**
 * The tools a session's `tools/list` holds: `text.tools`', in its order. 2026-11-11: two, where there were 28 (the
 * reasons are agent-instructions.ts'); every other tool is a `conch agent` command, and still answered when called.
 */
export function buildMcpTools(text: AgentInstructions = AGENT_INSTRUCTIONS): McpToolDefinition[] {
  const all: readonly McpToolDefinition[] = buildMcpToolDefinitions(text);
  return Object.keys(text.tools).map((name) => {
    const tool = all.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`agent-instructions.ts lists ${name}, which mcp.ts doesn't define`);
    return tool;
  });
}

/** A Workbench tab, by the id `browser_open` and `browser_tabs` give. */
const BROWSER_TAB_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 40,
  description: "Optional. One of your tab ids (browser_tabs); your most recent tab when omitted.",
} as const;

/** What a click or a type is aimed at. */
const BROWSER_TARGET_SCHEMA = {
  anyOf: [
    { type: "string", minLength: 1, maxLength: BROWSER_TARGET_MAX },
    {
      type: "object",
      properties: {
        ref: { type: "string", minLength: 1, maxLength: BROWSER_TARGET_MAX },
        selector: { type: "string", minLength: 1, maxLength: BROWSER_TARGET_MAX },
        text: { type: "string", minLength: 1, maxLength: BROWSER_TARGET_MAX },
      },
      additionalProperties: false,
    },
  ],
  description: "A ref from browser_read (e12), a CSS selector, or the visible text of the element (a link's or button's words, a field's label). A string is tried as each in that order; {ref}, {selector} or {text} names which.",
} as const;

/** Every tool this server answers: the listed ones and the ones that moved to `conch agent`, schemas and all. */
export const MCP_TOOLS = buildMcpToolDefinitions();
/** What a session started now is given: `review_to_front` and `conch_run`. */
export const MCP_LISTED_TOOLS = buildMcpTools();
/** The tools that moved to `conch agent`, still answered for a session that has them (`listedMcpTools`). */
export const MCP_MOVED_TOOL_NAMES: readonly string[] = MCP_TOOLS
  .map((tool) => tool.name)
  .filter((name) => !MCP_LISTED_TOOLS.some((listed) => listed.name === name));

/**
 * What this server lists. A session started now gets the listed tools alone. One a hand-off started (mcp-handoff.ts)
 * serves a session that began on an older server, with the moved tools in its list, and maybe mid-task calling one:
 * it keeps them (with their new descriptions, which say where they went), so nothing it was about to call is gone. Only
 * the ones it had: `inherited` is the handing-over server's list when it said (`HANDOFF_LISTED_ENV`), and every moved
 * tool for a server older than that, which listed them all. A restart leaves the session with the CLI.
 */
export function listedMcpTools(handoff?: { inherited?: readonly string[] }): McpToolDefinition[] {
  if (!handoff) return [...MCP_LISTED_TOOLS];
  const inherited = handoff.inherited ? new Set(handoff.inherited) : undefined;
  return MCP_TOOLS.filter((tool) =>
    MCP_LISTED_TOOLS.some((listed) => listed.name === tool.name) || !inherited || inherited.has(tool.name));
}

/**
 * The tools' own words — their names, argument names, enum values, setting keys. An argument holding one of these is
 * not the user's text, so the call log leaves it in an error message rather than scrubbing "url" out of "url must be…".
 */
export function mcpToolVocabulary(tools: readonly McpToolDefinition[] = MCP_TOOLS): Set<string> {
  const words = new Set<string>([...SETTING_KEYS, ...AGENT_TUNABLE_SETTINGS]);
  const walk = (schema: JsonSchema | undefined) => {
    if (!schema) return;
    for (const value of schema.enum ?? []) if (typeof value === "string") words.add(value);
    if (typeof schema.const === "string") words.add(schema.const);
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      words.add(name);
      walk(child);
    }
    for (const child of schema.anyOf ?? []) walk(child);
    walk(schema.items);
  };
  for (const tool of tools) {
    words.add(tool.name);
    walk(tool.inputSchema);
  }
  // 2026-11-11: review_to_front's marks are one line of its schema now, and their words still conch's own.
  for (const word of [...REVIEW_MARK_VOCABULARY, ...REVIEW_MARK_KINDS, ...MARK_UNITS]) words.add(word);
  return words;
}

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];
/** `meta` is the call's `params._meta`, which a Codex client fills with the calling thread. */
export type McpToolHandler = (argumentsValue: unknown, meta?: unknown) => Promise<unknown>;
export type McpToolHandlers = Record<McpToolName, McpToolHandler>;

/**
 * Commands that are `conch agent`'s alone (`AGENT_COMMANDS`), never an MCP tool: `conch bug` (2026-11-11, Tyler: "Also
 * tool for them to submit bugs if possible"), reached from a shell or `conch_run`, and `whoami`.
 */
export const AGENT_ONLY_HANDLERS = ["conch_bug", "conch_whoami"] as const;
export type AgentHandlerName = McpToolName | (typeof AGENT_ONLY_HANDLERS)[number];
export type AgentHandlers = Record<AgentHandlerName, McpToolHandler>;

/** The names `tools/call` answers: every tool this server defines, listed or moved, and never a CLI-only command. */
const MCP_CALLABLE = new Set<string>(MCP_TOOLS.map((tool) => tool.name));

/** What `conch_run` answers: the command's own text, and the value it came from, which the call log judges. */
export class RunAnswer {
  constructor(readonly text: string, readonly value: unknown) {}
}

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
  /**
   * Send a publication and wait for the daemon's verdict (review-verdict.ts). Absent, a
   * publication goes by `sendToDaemon` and is reported taken but unconfirmed, as an older
   * daemon's is.
   */
  publishForVerdict?(socketPath: string, event: TurnEvent, timeoutMs?: number): Promise<PublishReply>;
  /** Who chose a session's label (`sessionLabelSource`); absent, no relabel hint is offered. */
  labelSource?(session: Readonly<SessionInfo>): LabelSource;
  sendControlMessage(
    socketPath: string,
    message: ControlMessage | HistoryRequest | Extract<RuntimeControlMessage, { kind: "session-fork" | "session-start" }>,
    timeoutMs?: number,
  ): Promise<ControlResult>;
  /** conch's Claude sign-ins, ids and labels only (claude-session-sign-ins.ts): `conch_start`'s, and `conch_sessions`' list. */
  readSessionSignIns?(): readonly ClaudeSessionSignIn[];
  getSettingDescriptor: typeof getSettingDescriptor;
  parseSetting: typeof parseSetting;
  transcriptMark(transcriptPath: string): Promise<number>;
  lastAssistantText(transcriptPath: string, session: Readonly<SessionInfo>): Promise<string>;
  splitSentences(text: string): string[];
  now(): number;
  /** The process that spawned this server: the calling session, when it is one. */
  parentPid(): number;
  /** `conch_capture`'s request to the daemon, held open for its answer (`requestPageCapture`). */
  capturePage?(socketPath: string, message: PageCaptureMessage, timeoutMs?: number): Promise<PageCaptureSend>;
  /** The browser tools' commands to the daemon, held open for their answer (`requestBrowser`). */
  browser?(socketPath: string, message: BrowserMessage, timeoutMs?: number): Promise<BrowserSend>;
  /** `conch_notify`'s request to the daemon, held open for where it went (`requestNotice`). */
  notify?(socketPath: string, message: NoticeRequest, timeoutMs?: number): ReturnType<typeof requestNotice>;
  /** `atlas_show`'s copy of a page, written into the copies folder (`writeAtlasCopy`); its absolute path. */
  writeAtlasCopy?(file: string, markdown: string, folder: string): Promise<string>;
  /** A session's newest assistant text and its id (`assistantTail`); absent, `lastAssistantText` is read and has no id. */
  assistantTail?(transcriptPath: string, session: Readonly<SessionInfo>): Promise<AssistantTail>;
  /** How a waiting `conch_transcript_tail` sleeps between reads; Bun.sleep when absent. */
  sleep?(ms: number): Promise<void>;
  /**
   * The caller, for handlers run from an agent's shell (`conch agent`, agent-cli.ts): its process tree up to a session
   * (caller-session.ts `sessionForShell`), in place of this server's parent and a Codex call's thread id.
   */
  shellCaller?(): Promise<ShellCaller>;
  /** `conch bug`'s report to the daemon, held open for its ticket (`requestBugReport`). */
  fileBug?(socketPath: string, request: BugReportRequest, timeoutMs?: number): ReturnType<typeof requestBugReport>;
  /** A report written straight to the records, when the daemon isn't running to file it (`appendConchError`). */
  recordBugOffline?(record: ReturnType<typeof bugRecord>): void;
  /** Which agent this server serves, as its `initialize` said: the backend a bug report names. */
  clientBackend?(): "claude" | "codex" | undefined;
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
  publishForVerdict,
  labelSource: (session) => sessionLabelSource(session, session.cwd),
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
  // The same loader and window, for the tail's cursor: the newest assistant item, mid-turn too (transcript-tail.ts).
  async assistantTail(transcriptPath, session) {
    return assistantTail(await readConversationTail(
      transcriptPath,
      session.sessionId,
      transcriptFormatFor(transcriptPath),
      { window: session },
    ));
  },
  splitSentences,
  readSessionSignIns: () => readSessionSignIns(),
  now: Date.now,
  parentPid: () => sessionParentPid(),
  capturePage: requestPageCapture,
  browser: requestBrowser,
};

type ErrorOutcome = Exclude<McpCallOutcome, "ok">;

/**
 * An error the agent is told as a refusal or a bad argument rather than conch breaking. `outcome` is only what the call
 * log counts it as (mcp-usage.ts): `input-error`, fix the arguments; `refused`, conch understood and declined — the
 * caller unverified, another session's, not an agent's to change — so the same arguments could succeed from elsewhere
 * or later. A pre-flight that says every error as `refused: …` keeps each one's own (`asRefusal`), which is how a
 * broken registry read there still counts as `failed`.
 */
class ToolInputError extends Error {
  constructor(message: string, readonly outcome: ErrorOutcome = "input-error") {
    super(message);
    this.name = "ToolInputError";
  }
}

/** A refusal, as the call log counts it. */
const refusal = (message: string) => new ToolInputError(message, "refused");

/** Any error said as a refusal (`refused: …`), as the browser, capture and publish pre-flights say theirs. */
function asRefusal(error: unknown): ToolInputError {
  const said = errorMessage(error);
  return new ToolInputError(said.startsWith("refused:") ? said : `refused: ${said}`, callOutcome(error));
}

/** How a call that threw ended, for the call log. */
export function callOutcome(error: unknown): ErrorOutcome {
  if (error instanceof ToolInputError) return error.outcome;
  // A name that matches several sessions is the agent's to narrow.
  if (error instanceof AmbiguousSessionError) return "input-error";
  return "failed";
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
  /** What to use instead of a name agents guess, said with the refusal. */
  instead: Readonly<Record<string, string>> = {},
): void {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(argumentsValue).find((key) => !allowedKeys.has(key));
  if (extra) {
    throw new ToolInputError(Object.hasOwn(instead, extra) ? `unknown argument "${extra}": use ${instead[extra]}` : `unknown argument "${extra}"`);
  }
}

/**
 * Names agents give review_to_front's arguments that it doesn't take, and the one it does. 2026-10-18 review: a Codex
 * agent passed `artifactKey`, was told only "unknown argument", and moved on without publishing.
 */
export const REVIEW_ARGUMENTS_INSTEAD: Readonly<Record<string, string>> = {
  artifactKey: "key (it names the artifact: the same key again files its next version)",
  artifactId: "key (it names the artifact: the same key again files its next version)",
  artifact: "key (it names the artifact: the same key again files its next version)",
  url: "link (a URL, or a path to a file or folder)",
  path: "link (a URL, or a path to a file or folder)",
  file: "link (a URL, or a path to a file or folder)",
  href: "link (a URL, or a path to a file or folder)",
  title: "summary (one line, at most 200 characters)",
  description: "summary (one line, at most 200 characters)",
  message: "summary (one line, at most 200 characters)",
  text: "summary (one line, at most 200 characters)",
  type: "kind",
  files: "focus (paths inside a folder link)",
  paths: "focus (paths inside a folder link)",
  sessionId: "session, or leave it out: it is your own session",
};

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

/**
 * A name no live session has, with the ones that are live, for an answer to name them. 2026-11-11: 13 calls of
 * conch_transcript_tail failed on a name in 30 days (failure ticket #17), each told only that it matched nothing. The
 * message stays the bare refusal, as the call log keeps it; `conch agent` and `conch_run` print the live ones under it.
 */
export class NoSuchSessionError extends ToolInputError {
  constructor(query: string, readonly live: ReadonlyArray<{ id: string; label: string }>) {
    super(`no live session matching "${query}"`);
    this.name = "NoSuchSessionError";
  }
}

/** A refusal as `conch agent` says it: a missing session's message with the live sessions under it. */
export function errorWithCandidates(error: unknown): string {
  const message = errorMessage(error);
  if (!(error instanceof NoSuchSessionError) || !error.live.length) return message;
  return `${message}; live sessions: ${error.live.map((one) => `${one.id} "${one.label}"`).join(", ")}`;
}

async function resolveSession(
  query: string,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
): Promise<SessionInfo> {
  const session = await dependencies.findSessionByName(config.claudeDir, query.trim());
  if (!session) {
    const infos = (await dependencies.registrySnapshot(config.claudeDir).catch(() => null))?.infos ?? [];
    throw new NoSuchSessionError(query.trim(), infos.slice(0, 8).map((one) => ({ id: one.sessionId, label: dependencies.sessionLabel(one, one.cwd) })));
  }
  return session;
}

/** Whether conch could tell which session is calling this server, and why not when it could not. */
export type { CallerBinding } from "./caller-session.ts";

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
  // From a shell, the shell's own process tree says (agent-cli.ts), never this process's parent.
  if (dependencies.shellCaller) return (await dependencies.shellCaller()).binding;
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
  // The pid, then its registry file: the rule the Workbench's `browser-open` walks a process tree with (caller-session.ts).
  const who = `its parent (pid ${parentPid})`;
  return await sessionOfProcess(parentPid, infos, config.claudeDir, who)
    ?? unverified(`${who} is not a live session conch knows`);
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

/**
 * Who a call came from, for the call log: the session `callerBinding` verifies and its backend, else the thread a Codex
 * client names. Asked after the call is answered and kept for `ttlMs`, so the log costs at most one registry read a
 * minute; a /clear inside that minute is logged under the session it left.
 */
export function mcpCallCaller(
  config: () => McpRuntimeConfig,
  dependencies: McpDependencies = defaultMcpDependencies,
  ttlMs = 60_000,
): (meta: unknown) => Promise<McpCaller> {
  const cache = new Map<string, { at: number; caller: Promise<McpCaller> }>();
  return (meta) => {
    const thread = codexCallingThread(meta);
    const claimed: McpCaller = thread ? { session: thread, backend: "codex" } : {};
    const key = thread ?? "";
    const now = dependencies.now();
    const hit = cache.get(key);
    if (hit && now - hit.at < ttlMs) return hit.caller;
    const caller = (async (): Promise<McpCaller> => {
      const binding = await callerBinding(config(), dependencies, meta);
      return binding.status === "verified"
        ? { session: binding.session.sessionId, backend: binding.session.backend ?? "claude" }
        : claimed;
    })().catch(() => claimed);
    cache.set(key, { at: now, caller });
    // An app-server's threads come and go; the oldest goes first.
    if (cache.size > 64) cache.delete(cache.keys().next().value!);
    return caller;
  };
}

/** Your own session, for a tool whose `session` was omitted; refused when conch can't verify it. */
/**
 * The Claude sign-ins `conch_start` can start a session on, for `conch_sessions`' list: label and id, nothing more, and
 * nothing when there are none or the list can't be read (a sessions list must not fail over it).
 */
function claudeSignInsListed(dependencies: McpDependencies): { claudeSignIns?: Array<{ label: string; id: string }> } {
  try {
    const signIns = (dependencies.readSessionSignIns ?? readSessionSignIns)();
    return signIns.length ? { claudeSignIns: signIns.map(({ label, id }) => ({ label, id })) } : {};
  } catch {
    return {};
  }
}

async function ownSession(
  tool: string,
  config: McpRuntimeConfig,
  dependencies: McpDependencies,
  meta: unknown,
): Promise<SessionInfo> {
  const binding = await callerBinding(config, dependencies, meta);
  if (binding.status === "verified") return binding.session;
  throw refusal(
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
    throw refusal(
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
  throw refusal(
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
  throw refusal(`refused: conch cannot verify which session is calling (${binding.reason}), so it will not ${what}`);
}

/** One held filing as the daemon publishes it (`rows[].reviews`), read defensively: the file is not ours. */
interface HeldDeliverable {
  id: string;
  artifact?: string;
  version?: number;
  kind?: string;
  summary: string;
  link?: string;
  focus?: string[];
  at?: number;
  viewedAt?: number;
  /** Why the link a `conch:review` line gave was not published (`SessionReview.linkRefused`). */
  linkRefused?: string;
  /** A live page's login-wall check, and the Mac's picture of it (`SessionReview.access`, `.snapshot`). */
  access?: unknown;
  snapshot?: { path?: unknown };
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

/**
 * A link refused for being hidden, with the way to show it anyway: a copy in /tmp, which conch files as its own copy. Not
 * for a key or certificate, which should not be shown at all. 2026-10-18 review: a hidden-folder refusal left the agent
 * with nothing to try.
 */
async function hiddenLinkHint(reason: string, path: string): Promise<string> {
  if (!/is a hidden (?:file|folder)/.test(reason) || /\.(pem|key|p8|p12|pfx|keychain|keychain-db)$/i.test(path)) return reason;
  const real = await realpath(path).catch(() => path);
  const hidden = real.split("/").some((part) => part.startsWith(".") && part !== ".worktrees" && part !== "." && part !== "..");
  if (!hidden) return reason;
  return `${reason}. To show it, copy it to /tmp first (cp -R ${shellWord(real)} /tmp/) and link the copy: conch files a temp folder's file as its own copy`;
}

const shellWord = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`);

/** `conch_capture`'s `publish`: a summary as review_to_front takes one, and a key by its rule. */
function capturePublishArguments(value: unknown): { summary: string; key?: string } {
  if (!isRecord(value)) throw new ToolInputError("publish must be {summary, key?}");
  allowOnly(value, ["summary", "key"]);
  const summary = sanitizeReviewSummary(requiredString(value, "summary"), Infinity);
  if (!summary) throw new ToolInputError("publish.summary must be a non-empty string");
  const rawKey = optionalString(value, "key");
  const key = rawKey === undefined ? undefined : sanitizeReviewSummary(rawKey, Infinity);
  if (key !== undefined && (!key || key.length > ARTIFACT_KEY_MAX)) {
    throw new ToolInputError(`publish.key must be 1 to ${ARTIFACT_KEY_MAX} printable characters; it names the artifact, it does not describe it`);
  }
  return { summary: summary.slice(0, REVIEW_SUMMARY_MAX), ...(key ? { key } : {}) };
}

/**
 * The page `conch_capture` is to draw: an http(s) URL as given, or a local .html file made absolute and held to the
 * publish rule against the session's folders (`checkLocalFile`), as a linked page is. A `file://` URL is its path.
 */
async function capturePageUrl(raw: string, scope: LinkScope): Promise<string> {
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL; it may be a path.
  }
  let path = raw;
  if (url) {
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) return raw;
    if (url.protocol !== "file:") {
      throw new ToolInputError(`url must be an http(s) URL or a local .html file, not a ${url.protocol} link (a dev server is http://localhost:<port>)`);
    }
    path = fileURLToPath(url);
  }
  const absolute = resolve(scope.cwd, path);
  if (!/\.html?$/i.test(absolute)) {
    throw new ToolInputError(`url ${absolute} is not an .html page; conch_capture draws web pages: an http(s) URL or a local .html file`);
  }
  const checked = await checkLocalFile(absolute, scope.roots);
  if (!checked.ok) {
    throw new ToolInputError(checked.reason === SAFE_REVIEW_LINK ? `url ${absolute} can't be drawn: ${checked.why}` : checked.reason.replace(/^link /, "url "));
  }
  return absolute;
}

/**
 * What a sign-in screen in place of the page means, and the one fix, said wherever conch saw one. 2026-10-16: the fix is
 * a tab of conch's browser on the Default profile, which shares the review pane's store, so the user signs in where
 * they watch the agent work, in the Workdesk. 2026-10-18: asked in the tab itself (`browser_ask`), so it can't be missed.
 */
const CAPTURE_SIGN_IN_NOTE = "the page showed a sign-in screen, not the page itself. conch draws pages with the sign-ins of its"
  + " own review pane, not your browser's: open the URL with browser_open (the Default profile shares them) and ask the"
  + " user to sign in in that tab of their Workdesk once (browser_ask), then capture again";

/** The daemon's answer as the agent reads it: the capture and what to do with it, or why there is none, in words. */
function captureToolResult(reply: PageCaptureReply): Record<string, unknown> {
  if (reply.kind === "page-capture-error") {
    const seen = reply.seen;
    const parts = [reply.error.replace(/[.\s]+$/, "")];
    if (seen?.title || seen?.finalUrl) {
      parts.push(`What conch got: ${seen.title ? `"${seen.title}"` : "a page"}${seen.finalUrl ? ` at ${seen.finalUrl}` : ""}`);
    }
    if (seen?.headings?.length) parts.push(`Its headings: ${seen.headings.map((heading) => `"${heading}"`).join(", ")}`);
    if (seen?.loginWall) parts.push(CAPTURE_SIGN_IN_NOTE.replace(/^the page/, "It"));
    if (seen?.path) parts.push(`A picture of what it showed: ${seen.path}`);
    throw new Error(`failed: ${parts.join(". ")}.`);
  }
  const { capture, marks, filed, notFiled } = reply;
  const notes = [
    ...(capture.loginWall ? [CAPTURE_SIGN_IN_NOTE] : []),
    ...(capture.clipped ? ["the target is larger than the view, so only what the view held of it is in the picture; capture it with fullPage, or a taller viewport"] : []),
    ...(capture.unsettled ? ["the page was still moving when conch's wait ran out (images loading, or the layout shifting), so look at the picture before you rely on it"] : []),
    ...(notFiled ? [notFiled] : []),
  ];
  return {
    outcome: "captured",
    path: capture.path,
    width: capture.width,
    height: capture.height,
    devicePixelRatio: capture.devicePixelRatio,
    ...(capture.element ? { element: capture.element } : {}),
    finalUrl: capture.finalUrl,
    title: capture.title,
    ...(capture.loginWall ? { loginWall: true } : {}),
    ...(capture.clipped ? { clipped: true } : {}),
    ...(capture.unsettled ? { unsettled: true } : {}),
    ...(marks?.length ? { marks } : {}),
    ...(filed ? { filed } : {}),
    ...(notes.length ? { note: notes.join("; ") } : {}),
  };
}

/** A browser tool's `target`, as the daemon takes it (`parseBrowserTarget`). */
function browserTarget(args: Readonly<Record<string, unknown>>): BrowserTarget {
  if (!Object.hasOwn(args, "target")) throw new ToolInputError("target is required: a ref from browser_read, a CSS selector, or visible text");
  const parsed = parseBrowserTarget(args.target);
  if ("error" in parsed) throw new ToolInputError(parsed.error);
  return parsed;
}

export function createMcpToolHandlers(
  config: McpRuntimeConfig,
  dependencies: McpDependencies = defaultMcpDependencies,
): AgentHandlers {
  const sessionsPath = config.sessionsPath ?? MCP_SESSIONS_FILE;
  // One pending speak per calling session. This server is the session's own
  // child process, so one variable IS per session.
  // ponytail: the window is audioTimeoutMs's estimate, because sendToDaemon
  // never reads a reply; upgrade to the daemon's ack if speak ever gets one.
  let speakingUntil = 0;
  // A relabel is offered once per label (label-drift.ts); this server lives as long as its session.
  const relabelHints = new RelabelHints();

  /**
   * One browser tool's command: its arguments checked, the caller verified (a tab is its session's), sent to the daemon
   * and held open until the Mac app has run it. A refusal is this server's or the daemon's; a failure says which part
   * of conch wasn't there.
   */
  async function browserCommand(
    tool: string,
    argumentsValue: unknown,
    meta: unknown,
    allowed: readonly string[],
    build: (args: Record<string, unknown>) => Omit<Extract<BrowserMessage, { kind: "browser-command" }>, "kind" | "sessionId" | "tab">,
  ): Promise<Extract<BrowserReply, { kind: "browser-result" }>> {
    const message = await (async () => {
      const args = toolArguments(argumentsValue);
      allowOnly(args, allowed);
      const tab = optionalString(args, "tab")?.trim();
      if (tab !== undefined && !isBrowserTabId(tab)) throw new ToolInputError(`tab must be a tab's id, as browser_tabs lists them`);
      const command = build(args);
      const session = await verifiedCaller(`use conch's browser for any session (${tool} tabs are their session's own)`, config, dependencies, meta);
      return { kind: "browser-command", sessionId: session.sessionId, ...command, ...(tab ? { tab } : {}) } as BrowserMessage;
    })().catch((error) => {
      throw asRefusal(error);
    });
    const sent = await (dependencies.browser ?? requestBrowser)(config.socketPath, message, BROWSER_REPLY_MS);
    if (!sent.ok) {
      throw new Error(sent.reason === "daemon-down"
        ? "failed: conch daemon is not running, so its browser isn't either"
        : `failed: conch's daemon didn't answer the browser${sent.diagnostic ? ` (${sent.diagnostic})` : ""}`);
    }
    if (sent.reply.kind === "browser-error") throw new Error(`failed: ${sent.reply.error}`);
    if (sent.reply.kind !== "browser-result") throw new Error("ack-unknown: the daemon's reply wasn't the browser's");
    return sent.reply;
  }

  async function readHistory(request: HistoryRequest, meta: unknown): Promise<HistoryResponse> {
    if (request.session === "self") {
      const binding = await callerBinding(config, dependencies, meta);
      if (binding.status !== "verified") {
        throw refusal("conch cannot verify which session is calling; pass an explicit recorded session ID or exact live ID from conch_sessions");
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

  /** Who is calling and how conch knows, for `whoami` and a bug report's `via`. */
  async function whoCalls(meta: unknown): Promise<ShellCaller> {
    if (dependencies.shellCaller) return dependencies.shellCaller();
    const binding = await callerBinding(config, dependencies, meta);
    if (binding.status !== "verified") return { binding };
    return { binding, via: codexCallingThread(meta) ? "the Codex thread id on this MCP call" : "this MCP server's parent process, which is the session" };
  }

  const handlers: AgentHandlers = {
    // 2026-11-11: `conch agent <command>`, run here, for a shell that can't reach conch's socket (Codex's sandbox allows
    // no unix socket by default) or can't show which session it is (an app-server's thread without CODEX_THREAD_ID). The
    // same words, the same handlers and the same answer as the CLI, with this server's verified caller.
    async conch_run(argumentsValue, meta) {
      const args = toolArguments(argumentsValue);
      allowOnly(args, ["command"], { args: "command, one line: the words after `conch agent`", cmd: "command" });
      const line = requiredString(args, "command");
      let invocation: ReturnType<typeof parseAgentCommand>;
      try {
        invocation = parseAgentCommand(splitCommandLine(line), {
          // Relative to where this server runs, the folder the session started in; there is no stdin to read.
          readFile: (path) => readFileSync(resolve(process.cwd(), path), "utf8"),
        });
      } catch (error) {
        if (error instanceof AgentUsageError) throw new ToolInputError(usageErrorText(error));
        throw error;
      }
      if (invocation.kind === "help") return new RunAnswer(invocation.text, invocation.text);
      const handler = handlers[invocation.tool as AgentHandlerName];
      if (!handler || invocation.tool === "conch_run") throw new ToolInputError(`conch agent ${invocation.command.name} can't run here`);
      try {
        const value = await handler(invocation.args, meta);
        return new RunAnswer(renderAgentAnswer(invocation.command, value, invocation.json, dependencies.now()), value);
      } catch (error) {
        // The command's own outcome, in the CLI's words.
        const said = cliWording(errorWithCandidates(error));
        if (error instanceof ToolInputError) throw new ToolInputError(said, error.outcome);
        if (error instanceof AmbiguousSessionError) throw new ToolInputError(said);
        throw new Error(said);
      }
    },

    // A bug about conch (bug-report.ts): filed by the daemon as a failure ticket, private to this Mac, and answered with
    // its number. Anyone may file one; only a verified session's carries its session.
    async conch_bug(argumentsValue, meta) {
      const args = toolArguments(argumentsValue);
      allowOnly(args, ["title", "happened", "expected", "area", "evidence"], { description: "happened", body: "happened", what: "happened" });
      const checked = checkBugReport(args);
      if (!checked.ok) throw new ToolInputError(checked.error);
      const { binding, via } = await whoCalls(meta);
      const session = binding.status === "verified" ? binding.session : undefined;
      const said = via ?? (binding.status === "unverified" ? `unverified: ${binding.reason}` : undefined);
      const backend = session?.backend ?? dependencies.clientBackend?.();
      const request: BugReportRequest = {
        kind: BUG_REPORT_KIND,
        report: checked.report,
        from: session?.sessionId ?? "unverified",
        ...(said ? { via: said.slice(0, 300) } : {}),
        ...(backend ? { backend } : {}),
        version: CONCH_VERSION,
      };
      const sent = await (dependencies.fileBug ?? requestBugReport)(config.socketPath, request, BUG_REPORT_REPLY_MS);
      if (!sent.ok && sent.reason === "daemon-down") {
        // The daemon files it from the records when it next starts; the records are written here, as a hook's are.
        try {
          (dependencies.recordBugOffline ?? ((record) => void appendConchError(record, null)))(bugRecord(request));
        } catch (error) {
          throw new Error(`failed: conch's daemon isn't reachable, and its records can't be written from here either (${errorMessage(error)}); a sandbox does both. Run it through the conch_run tool, or tell the user`);
        }
        return {
          outcome: "recorded",
          said: "conch's daemon isn't running, so there is no ticket number yet: the report is in conch's private records, and becomes a ticket in Settings › Failures when conch starts",
        };
      }
      if (!sent.ok && sent.reason === "older") {
        // Not written to the records either: an older desk drops a record of an origin it doesn't know, for good.
        throw new Error("failed: conch's daemon is older than conch bug and can't file it, so nothing was filed. Once conch is updated and restarted, file it again; tell the user what you saw meanwhile");
      }
      if (!sent.ok) {
        throw new Error(`failed: conch's daemon didn't answer the report${sent.diagnostic ? ` (${sent.diagnostic})` : ""}. It may have been filed: \`conch failures\` lists the tickets`);
      }
      const reply = sent.reply;
      if (reply.kind === "bug-error") throw reply.refused ? refusal(reply.error) : new Error(reply.error);
      const { kind: _kind, ...filed } = reply;
      return {
        ...filed,
        ...(session
          ? { session: session.sessionId }
          : { note: `filed under no session: conch couldn't tell which session filed it (${binding.status === "unverified" ? binding.reason : ""})` }),
      };
    },

    // Which session conch takes the caller to be, and how it knows: the question every refusal of an unverified caller raises.
    async conch_whoami(argumentsValue, meta) {
      allowOnly(toolArguments(argumentsValue), []);
      const { binding, via } = await whoCalls(meta);
      if (binding.status !== "verified") {
        return { caller: "unverified", reason: binding.reason, means: "commands on your own session (publish, folders, browser, deliverables, atlas) are refused; ones that name a session still work" };
      }
      const session = binding.session;
      return {
        caller: "verified",
        session: session.sessionId,
        label: dependencies.sessionLabel(session, session.cwd),
        backend: session.backend ?? "claude",
        ...(session.cwd ? { cwd: session.cwd } : {}),
        ...(via ? { via } : {}),
      };
    },

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

    // One small entry per session, never the published state itself (mcp-sessions.ts says why).
    async conch_sessions(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session", "detail"]);
      const query = optionalString(argumentsObject, "session")?.trim();
      if (Object.hasOwn(argumentsObject, "detail") && typeof argumentsObject.detail !== "boolean") {
        throw new ToolInputError("detail must be true or false");
      }
      const detail = argumentsObject.detail === true;
      if (detail && !query) throw new ToolInputError("detail shows one session in full: pass session with its id or label too");
      const binding = await callerBinding(config, dependencies, meta);
      const caller = binding.status === "verified"
        ? {
          status: binding.status,
          sessionId: binding.session.sessionId,
          label: dependencies.sessionLabel(binding.session, binding.session.cwd),
        }
        : binding;
      const snapshot = await dependencies.registrySnapshot(config.claudeDir).catch(() => null);

      let published: Record<string, unknown> | undefined;
      try {
        const raw = await dependencies.readSessionsFile(sessionsPath);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        if (isRecord(parsed) && Array.isArray(parsed.rows)) published = parsed;
      } catch {
        // The daemon snapshot is advisory. A missing, unreadable, or malformed file
        // falls through to Claude's registry so the plugin remains useful.
      }
      const state = published ?? publishedStateFromRegistry(snapshot, dependencies) as unknown as Record<string, unknown>;
      const view: SessionsView = {
        rows: state.rows as unknown[],
        ...(published && typeof published.ts === "number" ? { publishedAt: published.ts } : {}),
        ...(snapshot ? { liveIds: snapshot.liveIds } : {}),
        ...(binding.status === "verified" ? { callerId: binding.session.sessionId } : {}),
        now: dependencies.now(),
      };
      const mode = isRecord(state.mode) ? { paused: state.mode.paused === true, muted: state.mode.muted === true } : undefined;
      const extra = { caller, ...(mode ? { mode } : {}), ...(published ? {} : { source: "the registry: conch's daemon is not running" }) };
      if (!detail) return compactSessionList(view, query, { ...extra, ...claudeSignInsListed(dependencies) });
      const rows = view.rows.filter((row): row is Record<string, unknown> => isRecord(row) && typeof row.id === "string");
      const exact = rows.filter((row) => row.id === query);
      const matches = exact.length ? exact : rows.filter((row) => rowMatches(row, query!));
      if (matches.length !== 1) {
        throw new ToolInputError(matches.length
          ? `"${query}" names ${matches.length} sessions (${matches.slice(0, 6).map((row) => `${String(row.label ?? row.id)} ${String(row.id)}`).join("; ")}); pass one id for detail`
          : `no session's id or label matches "${query}"`);
      }
      return detailedSession(matches[0]!, extra);
    },

    // The daemon's own fork (session-fork.ts, `forkLiveSession`): the account, folder and flags carry over, and the answer
    // waits until conch has seen the fork running, or says why it didn't start.
    async conch_fork(argumentsValue, meta) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session", "label"]);
      const query = optionalString(argumentsObject, "session");
      const label = optionalString(argumentsObject, "label")?.trim();
      if (label !== undefined && label.length > 80) throw new ToolInputError("label must be at most 80 characters");
      const session = query
        ? await resolveSession(query, config, dependencies)
        : await ownSession("conch_fork", config, dependencies, meta);
      const from = { sessionId: session.sessionId, label: dependencies.sessionLabel(session, session.cwd) };
      const result = await dependencies.sendControlMessage(
        config.socketPath,
        { kind: "session-fork", sessionId: session.sessionId, ...(label ? { label } : {}), wait: true },
        CONCH_FORK_REPLY_MS,
      );
      if (!result.ok) {
        throw new Error(result.reason === "daemon-down"
          ? "failed: conch daemon is not running, so nothing was forked"
          : `failed: conch's daemon didn't answer the fork in time${result.diagnostic ? ` (${result.diagnostic})` : ""}. It may still have started: check conch_sessions before forking again`);
      }
      let response: ControlResponse;
      try {
        response = unwrapControlResult(result);
      } catch (error) {
        throw new Error(`failed: the fork didn't start: ${errorMessage(error)}`);
      }
      if (response.kind !== "session-forked") throw new Error("ack-unknown: daemon reply did not match the fork request");
      const dropped = response.notCarriedOver?.length ? { notCarriedOver: response.notCarriedOver } : {};
      if (response.forkId) {
        return {
          outcome: "forked",
          from,
          forkId: response.forkId,
          ...(response.label ? { label: response.label } : {}),
          ...dropped,
          note: "conch sees the fork running, under the same account and in the same folder, holding the original's deliverables; it is a session of its own in conch's Mac app and phone",
        };
      }
      return {
        outcome: "started",
        from,
        running: response.running ?? "a new window",
        ...dropped,
        note: "the fork's agent is running, but hasn't yet given conch an id it can see (Claude Code may wait for its first message); it appears in conch_sessions once it has. Don't fork again",
      };
    },

    // 2026-11-10, Tyler, on choosing which account a session runs on: "one session [uses] another account to create a
    // fable agent using conch for me since [this one is] out of credits". The daemon's own start (`startLiveSession`),
    // answered once conch sees the session running, as conch_fork is; its reply is then conch_transcript_tail's to wait on.
    async conch_start(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["backend", "folder", "signIn", "model", "effort", "prompt", "host", "label"], {
        account: "signIn, one of conch's Claude sign-ins by label or id", cwd: "folder", message: "prompt",
      });
      const backend = optionalString(argumentsObject, "backend")?.trim() ?? "claude";
      if (backend !== "claude" && backend !== "codex") throw new ToolInputError("backend must be claude or codex");
      const adapter = adapterFor(backend);
      const host = optionalString(argumentsObject, "host")?.trim();
      if (host !== undefined && host !== "terminal" && host !== "background") throw new ToolInputError("host must be terminal or background");
      const label = optionalString(argumentsObject, "label")?.trim();
      if (label !== undefined && label.length > 80) throw new ToolInputError("label must be at most 80 characters");
      // Your own cwd unless you name another: this process's cwd is the calling session's.
      const folder = resolve(process.cwd(), optionalString(argumentsObject, "folder")?.trim() ?? ".");
      if (!(await stat(folder).catch(() => null))?.isDirectory()) throw new ToolInputError(`refused: ${folder} is not a folder that exists`);
      // A sign-in by its label or id; one conch doesn't have is refused with those it has, never started on the
      // rotating login instead. Only its id goes to the daemon, and only ids and labels come back.
      const askedSignIn = optionalString(argumentsObject, "signIn")?.trim();
      let signIn: ClaudeSessionSignIn | undefined;
      if (askedSignIn !== undefined) {
        let unreadable: unknown;
        const signIns = () => {
          try {
            return (dependencies.readSessionSignIns ?? readSessionSignIns)();
          } catch (error) {
            unreadable = error;
            throw error;
          }
        };
        try {
          signIn = signInForStart(backend, askedSignIn, signIns);
        } catch (error) {
          if (unreadable) throw new Error(`failed: conch couldn't read its Claude sign-ins (${errorMessage(unreadable)}), so nothing was started`);
          throw refusal(`refused: ${errorMessage(error)}`);
        }
      }
      const options: Record<string, string> = {};
      const model = optionalString(argumentsObject, "model")?.trim();
      if (model !== undefined) options.model = model;
      const effort = optionalString(argumentsObject, "effort")?.trim();
      if (effort !== undefined) {
        // The agent's own effort option: Claude Code's `effort`, Codex's `reasoning-effort`.
        const entry = adapter.startOptions.find((option) => /(^|-)effort$/.test(option.name));
        if (!entry?.choices?.includes(effort)) throw new ToolInputError(`effort for ${adapter.displayName} is one of ${entry?.choices?.join(", ") ?? "nothing: it takes none"}`);
        options[entry.name] = effort;
      }
      const prompt = optionalString(argumentsObject, "prompt")?.trim();
      const invalid = startOptionsError({ backend, options }) ?? startPromptError({ prompt });
      if (invalid) throw new ToolInputError(`refused: ${invalid}`);
      const result = await dependencies.sendControlMessage(
        config.socketPath,
        {
          kind: "session-start",
          backend,
          cwd: folder,
          ...(host ? { host: host as "terminal" | "background" } : {}),
          ...(signIn ? { claudeSignInId: signIn.id } : {}),
          ...(Object.keys(options).length ? { options } : {}),
          ...(prompt ? { prompt } : {}),
          ...(label ? { label } : {}),
          wait: true,
        },
        CONCH_START_REPLY_MS,
      );
      if (!result.ok) {
        throw new Error(result.reason === "daemon-down"
          ? "failed: conch daemon is not running, so nothing was started"
          : `failed: conch's daemon didn't answer the start in time${result.diagnostic ? ` (${result.diagnostic})` : ""}. It may still have started: check conch_sessions before starting another`);
      }
      let response: ControlResponse;
      try {
        response = unwrapControlResult(result);
      } catch (error) {
        throw new Error(`failed: the session didn't start: ${errorMessage(error)}`);
      }
      if (response.kind === "session-needs-trust") {
        throw refusal(`refused: ${adapter.displayName} doesn't trust ${response.cwd} yet, so conch started nothing there. Ask the user to start`
          + " it from conch's New session sheet, which asks them whether to trust the folder, or name a folder it trusts");
      }
      if (response.kind !== "session-started") throw new Error("ack-unknown: daemon reply did not match the start request");
      const started = {
        backend,
        folder,
        // Which account, by the name the Mac shows it under.
        account: signIn ? signIn.label : "Default (its rotating login)",
        ...(model ? { model } : {}),
      };
      if (response.sessionId) {
        return {
          outcome: "started",
          sessionId: response.sessionId,
          ...(response.label ? { label: response.label } : {}),
          ...started,
          note: "conch sees it running, as a session of its own in conch's Mac app and phone",
          ...(prompt ? {
            // 2026-11-11: in the CLI's words, which every session has (the tool moved to `conch agent tail`).
            next: `to bring back its answer: conch agent tail ${response.sessionId} --wait 30, then again with --since <the cursor it printed>, until its status is waiting (needs: it is asking the user something). Its text then is the answer; --sentences gives more of it`,
          } : {}),
        };
      }
      return {
        outcome: "running",
        running: response.running ?? "a new window",
        ...started,
        note: "its agent is running, but conch can't see it as a session yet; it appears in conch_sessions once it does. Don't start another",
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
        throw refusal(
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
        throw refusal(
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
        throw refusal(
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
        throw refusal(
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

    // A cursor, and a wait, so a session waiting on another doesn't poll (transcript-tail.ts says why).
    async conch_transcript_tail(argumentsValue) {
      const argumentsObject = toolArguments(argumentsValue);
      allowOnly(argumentsObject, ["session", "sentences", "since", "wait"]);
      const query = requiredString(argumentsObject, "session");
      const countValue = argumentsObject.sentences ?? 3;
      if (
        typeof countValue !== "number"
        || !Number.isInteger(countValue)
        || countValue < 1
      ) {
        throw new ToolInputError("sentences must be an integer at least 1");
      }
      const since = optionalString(argumentsObject, "since")?.trim();
      const waitValue = argumentsObject.wait ?? 0;
      if (typeof waitValue !== "number" || !Number.isFinite(waitValue) || waitValue < 0 || waitValue > TAIL_WAIT_MAX_S) {
        throw new ToolInputError(`wait must be 0 to ${TAIL_WAIT_MAX_S} seconds`);
      }
      const session = await resolveSession(query, config, dependencies);
      const transcriptPath = dependencies.findTranscript(
        config.claudeDir,
        session.sessionId,
      );
      const label = dependencies.sessionLabel(session, session.cwd);
      if (!transcriptPath) {
        throw new Error(
          `transcript not found for "${label}"`,
        );
      }
      const read = async (): Promise<AssistantTail> => dependencies.assistantTail
        ? dependencies.assistantTail(transcriptPath, session)
        : { text: await dependencies.lastAssistantText(transcriptPath, session), midTurn: false };
      const { tail, cursor, waitedMs, unchanged } = await waitForTail(read, {
        ...(since ? { since } : {}),
        waitMs: waitValue * 1000,
        sleep: dependencies.sleep ?? Bun.sleep,
        now: dependencies.now,
      });
      // Its status as it is now: a wait may have outlived the one it had when the call came.
      const current = waitedMs > 0 ? await dependencies.findSessionByName(config.claudeDir, session.sessionId).catch(() => null) ?? session : session;
      // Which session answered, since a name can resolve to one you didn't spell out.
      const said = {
        sessionId: session.sessionId,
        label,
        status: reconcileStatus(current, undefined, dependencies.now()),
        cursor,
        ...(waitValue > 0 ? { waitedSeconds: Math.round(waitedMs / 100) / 10 } : {}),
      };
      if (unchanged) {
        const how = since !== undefined ? "since your cursor" : "since this call came";
        return { ...said, unchanged: true, note: `no new text ${how}${waitValue > 0 ? `, after waiting ${said.waitedSeconds} s` : ""}` };
      }
      if (!tail.text) {
        return { ...said, note: `no reply text yet: "${label}" has written none in its transcript's recent entries (it may be mid-turn, in tool calls)` };
      }
      return {
        ...said,
        text: dependencies.splitSentences(tail.text).slice(-countValue).join(" "),
        ...(tail.midTurn ? { midTurn: true, note: "it has moved on since (a tool call, or a new prompt): this is its newest text, from before that" } : {}),
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
          ...(typeof one.linkRefused === "string" && one.linkRefused ? { linkRefused: one.linkRefused } : {}),
          ...(Array.isArray(one.focus) && one.focus.length ? { focus: one.focus } : {}),
          ...(isPageAccess(one.access) ? { access: { mac: one.access.mac, anonymous: one.access.anonymous } } : {}),
          ...(typeof one.snapshot?.path === "string" ? { snapshot: one.snapshot.path } : {}),
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
      // Filed, refused or failed, and each says which. A refusal names its reason: this server's,
      // before anything reaches the daemon, or the daemon's own, which it used to only log.
      const { summary, truncatedFrom, link, givenLink, scene, kind, key, focus, approval, kindAlias, session, transcriptPath } = await (async () => {
        const argumentsObject = toolArguments(argumentsValue);
        allowOnly(argumentsObject, ["summary", "link", "kind", "key", "session", "scene", "focus", "approval"], REVIEW_ARGUMENTS_INSTEAD);
        const cleaned = sanitizeReviewSummary(requiredString(argumentsObject, "summary"), Infinity);
        if (!cleaned) throw new ToolInputError("summary must be a non-empty string");
        // Marks measured in pixels become fractions first (mark-pixels.ts): everything after this, the
        // socket and the apps included, sees 0 to 1.
        const pixels = Object.hasOwn(argumentsObject, "scene") ? await scenePixelsToFractions(argumentsObject.scene) : undefined;
        if (pixels && !pixels.ok) throw new ToolInputError(pixels.reason);
        const scene = pixels?.ok
          ? checkReviewScene(pixels.scene, Object.hasOwn(argumentsObject, "link"))
          : undefined;
        if (scene && !scene.ok) throw new ToolInputError(scene.reason);
        // A kind, an alias agents use for one ("link", "web"), or refused with the nearest kind (deliverables.ts).
        const rawKind = optionalString(argumentsObject, "kind");
        const readKind = rawKind === undefined ? undefined : readDeliverableKind(rawKind);
        if (readKind && !readKind.ok) throw new ToolInputError(readKind.reason);
        const kind = readKind?.ok ? readKind.kind : undefined;
        const kindAlias = readKind?.ok && readKind.alias !== undefined
          ? { given: readKind.alias, used: kind ?? "the link's own kind" }
          : undefined;
        const kindRefusal = kind && deliverableKindRefusal(kind, Object.hasOwn(argumentsObject, "link"));
        if (kindRefusal) throw new ToolInputError(kindRefusal);
        const rawKey = optionalString(argumentsObject, "key");
        const key = rawKey === undefined ? undefined : sanitizeReviewSummary(rawKey, Infinity);
        if (key !== undefined && (!key || key.length > ARTIFACT_KEY_MAX)) {
          throw new ToolInputError(`key must be 1 to ${ARTIFACT_KEY_MAX} printable characters; it names the artifact, it does not describe it`);
        }
        // The agent is waiting on the user's yes (2026-10-05): only then does the result offer Approve, and approving it
        // sends this session `Approved: <label>.` (review-approval.ts). The label trimmed, and 40 characters at most.
        const asked = Object.hasOwn(argumentsObject, "approval") ? checkApprovalRequest(argumentsObject.approval) : undefined;
        if (asked && !asked.ok) throw new ToolInputError(asked.reason);
        const session = await requiredReviewSession(argumentsObject, config, dependencies, meta);
        const transcriptPath = dependencies.findTranscript(config.claudeDir, session.sessionId);
        // The folders the hook and the daemon check a link against (review-roots.ts): where the
        // session is now, as its transcript last says, where it started, and what it declared.
        // This process's own cwd is where the session started, and stands in for either unknown.
        const scope = await reviewLinkScope({
          now: await transcriptFolder(transcriptPath) ?? process.cwd(),
          started: session.cwd ?? process.cwd(),
          workDirs: session.workDirs,
        }, process.cwd());
        const rawLink = optionalString(argumentsObject, "link");
        // Absolute by the time it leaves here, resolved against the folder the session is in:
        // the raw relative string reached the Mac app, which resolved it against its own cwd
        // and previewed a missing file.
        const checked = rawLink === undefined ? undefined : await checkReviewLink(rawLink, scope.cwd, scope.roots);
        if (checked && !checked.ok) throw new ToolInputError(await hiddenLinkHint(checked.reason, resolve(scope.cwd, rawLink!.trim())));
        const hasFocus = Object.hasOwn(argumentsObject, "focus");
        const mismatch = folderRefusal({ kind, isFolder: checked?.ok === true && checked.folder === true, hasFocus });
        if (mismatch) throw new ToolInputError(mismatch);
        // Inside the folder on the disk as it is now, and published relative to it: never a listing.
        const focus = hasFocus && checked?.ok ? await resolveReviewFocus(checked.link, argumentsObject.focus) : undefined;
        if (focus && !focus.ok) throw new ToolInputError(focus.reason);
        const images = await markImagesRefusal(scene?.ok ? scene.scene : undefined, scope.roots);
        if (images) throw new ToolInputError(images);
        return {
          summary: cleaned.slice(0, REVIEW_SUMMARY_MAX),
          truncatedFrom: cleaned.length > REVIEW_SUMMARY_MAX ? cleaned.length : undefined,
          link: checked?.link,
          givenLink: rawLink,
          scene: scene?.scene,
          kind,
          key,
          focus: focus?.ok ? focus.focus : undefined,
          approval: asked?.ok ? asked.approval : undefined,
          kindAlias,
          session,
          transcriptPath,
        };
      })().catch((error) => {
        throw asRefusal(error);
      });
      const label = dependencies.sessionLabel(session, session.cwd);
      const at = dependencies.now();
      const review = {
        summary,
        ...(link ? { link } : {}),
        ...(scene ? { scene } : {}),
        ...(kind ? { kind } : {}),
        ...(key ? { key } : {}),
        ...(focus ? { focus } : {}),
        ...(approval ? { approval } : {}),
      };
      const facts = deliverableFacts(review);
      // What it already holds, oldest first: the version an older daemon will give it (`nextVersion`, its own
      // rule), and the summaries a drifting label is judged against.
      const held = await heldDeliverables(sessionsPath, session.sessionId, dependencies) ?? [];
      const event: TurnEvent = {
        // Not a turn-end: publishing happens mid-turn, and the turn's own Stop
        // says when it finished.
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
      };
      const reply = await (dependencies.publishForVerdict
        ? dependencies.publishForVerdict(config.socketPath, event, REVIEW_VERDICT_TIMEOUT_MS)
        : dependencies.sendToDaemon(config.socketPath, event).then((sent): PublishReply => sent
          ? { kind: "unconfirmed", why: "this conch daemon does not say whether it filed a publication" }
          : { kind: "down" })
      ).catch((error): never => {
        throw new Error(`failed: ${errorMessage(error)}`);
      });
      if (reply.kind === "down") throw new Error("failed: conch daemon is not running, so nothing was published");
      const verdict = reply.kind === "verdict" ? reply.verdict : undefined;
      if (verdict?.kind === "review-refused") {
        throw refusal(`refused: conch's daemon did not file it: ${verdict.reason}`);
      }
      // Offered once per label, and only for a label the agent's side chose (label-drift.ts).
      const relabel = dependencies.labelSource
        ? relabelHints.take(session.sessionId, label, dependencies.labelSource(session), [summary, ...held.map((one) => one.summary).reverse()])
        : undefined;
      // 2026-11-11: what the agent acts on, and nothing it passed in. 278 replies in 7 days averaged 0.86 KB pretty-printed:
      // the summary it had sent was the largest part (19%), then the filing's id (17%, a 130-character record key no
      // call in 23 days used: the 5 removals went by artifact, and `conch agent deliverables` lists ids), the link
      // (13%), the session's id, and the scene, focus and approval it passed. What stays: where it landed (surfaces),
      // which artifact and version it is, its session's label, what conch changed (the link it copied or made absolute,
      // the kind it read off the link, a summary it cut, a kind alias it read), and what to act on (warning, with the
      // login-wall look and the Mac's picture behind it; notCopied; relabel).
      const changed = (filedLink: string | undefined, filedKind: string) => ({
        ...(kind === undefined ? { kind: filedKind } : {}),
        ...(filedLink && filedLink !== givenLink?.trim() ? { link: filedLink } : {}),
        ...(truncatedFrom === undefined
          ? {}
          : { summaryTruncated: { from: truncatedFrom, to: REVIEW_SUMMARY_MAX } }),
        // An alias conch read as a kind: the next call can say it as one.
        ...(kindAlias ? { kindAlias } : {}),
      });
      if (verdict) {
        const { filing, notCopied, surfaces, access, warning, snapshot } = verdict;
        return {
          outcome: "filed",
          label,
          // The artifact it is a version of, and which version, as the daemon filed them: what `conch agent
          // deliverables` lists and `unpublish --artifact` takes.
          artifact: filing.artifact,
          version: filing.version,
          ...(surfaces ? { surfaces } : {}),
          ...changed(filing.link, filing.kind),
          ...(notCopied ? { notCopied } : {}),
          // A live page's login-wall check (page-access.ts): what to do about a sign-in page, who was shown one, and
          // the Mac's picture the phone shows first. A page both looks found is nothing to act on.
          ...(warning ? { warning, ...(access ? { access } : {}), ...(snapshot ? { snapshot } : {}) } : {}),
          ...(relabel ? { relabel } : {}),
        };
      }
      // Taken, with no word on the filing: an older daemon, or one that didn't answer in time. The version is predicted
      // by the daemon's own rule, and said to be.
      return {
        outcome: "accepted",
        unconfirmed: `${reply.kind === "unconfirmed" ? reply.why : "the daemon said nothing"}; the version below is predicted, and conch_deliverables says what was filed`,
        label,
        artifact: facts.artifact,
        version: nextVersion(held, facts.artifact),
        ...changed(link, facts.kind),
        ...(relabel ? { relabel } : {}),
      };
    },

    async conch_capture(argumentsValue, meta) {
      const { message } = await (async () => {
        const argumentsObject = toolArguments(argumentsValue);
        allowOnly(argumentsObject, ["url", "target", "viewport", "fullPage", "mark", "publish"]);
        const rawUrl = requiredString(argumentsObject, "url").trim();
        const target = Object.hasOwn(argumentsObject, "target") ? parseCaptureTarget(argumentsObject.target) : undefined;
        if (target && !target.ok) throw new ToolInputError(target.reason);
        const viewport = Object.hasOwn(argumentsObject, "viewport")
          ? parseCaptureViewport(argumentsObject.viewport)
          : { ok: true as const, value: { ...CAPTURE_VIEWPORT_DEFAULT } };
        if (!viewport.ok) throw new ToolInputError(viewport.reason);
        if (Object.hasOwn(argumentsObject, "fullPage") && typeof argumentsObject.fullPage !== "boolean") {
          throw new ToolInputError("fullPage must be true or false");
        }
        const mark = Object.hasOwn(argumentsObject, "mark") ? parseCaptureMark(argumentsObject.mark) : undefined;
        if (mark && !mark.ok) throw new ToolInputError(mark.reason);
        if (mark && !target) throw new ToolInputError("mark is drawn round the target; pass target ({selector} or {quote}) too");
        const publish = Object.hasOwn(argumentsObject, "publish") ? capturePublishArguments(argumentsObject.publish) : undefined;
        // Whose folders a local page is checked against, and whose deliverable a published capture is. A capture alone
        // needs no verified caller: an unverified one is checked against the folder this server started in.
        const binding = await callerBinding(config, dependencies, meta);
        if (publish && binding.status !== "verified") {
          throw refusal(
            `conch cannot verify which session is calling (${binding.reason}), so it will not file a capture as any`
              + " session's deliverable. Capture without publish, and leave the picture's path in your reply.",
          );
        }
        const session = binding.status === "verified" ? binding.session : undefined;
        const transcriptPath = session ? dependencies.findTranscript(config.claudeDir, session.sessionId) : undefined;
        const scope = await reviewLinkScope({
          now: await transcriptFolder(transcriptPath) ?? process.cwd(),
          started: session?.cwd ?? process.cwd(),
          workDirs: session?.workDirs,
        }, process.cwd());
        const url = await capturePageUrl(rawUrl, scope);
        const message: PageCaptureMessage = {
          kind: "page-capture",
          url,
          roots: scope.roots,
          ...(target?.ok ? { target: target.value as CaptureTarget } : {}),
          viewport: viewport.value as CaptureViewport,
          fullPage: argumentsObject.fullPage === true,
          ...(mark?.ok ? { mark: mark.value as CaptureMarkSpec } : {}),
          ...(publish && session
            ? {
              publish: {
                sessionId: session.sessionId,
                label: dependencies.sessionLabel(session, session.cwd),
                ...(session.cwd ? { cwd: session.cwd } : {}),
                ...(session.pid !== undefined ? { pid: session.pid } : {}),
                ...(transcriptPath ? { transcriptPath, transcriptMark: await dependencies.transcriptMark(transcriptPath) } : {}),
                summary: publish.summary,
                ...(publish.key ? { key: publish.key } : {}),
              },
            }
            : {}),
        };
        return { message };
      })().catch((error) => {
        throw asRefusal(error);
      });
      const sent = await (dependencies.capturePage ?? requestPageCapture)(config.socketPath, message, CAPTURE_REPLY_MS);
      if (!sent.ok) {
        throw new Error(sent.reason === "daemon-down"
          ? "failed: conch daemon is not running, so nothing was captured"
          : `failed: conch's daemon didn't answer the capture${sent.diagnostic ? ` (${sent.diagnostic})` : ""}`);
      }
      return captureToolResult(sent.reply);
    },

    // conch's in-app browser (browser-workbench.ts): every tab is its caller's, so each needs a verified one.
    async browser_open(argumentsValue, meta) {
      const reply = await browserCommand("browser_open", argumentsValue, meta, ["url", "profile", "tab"], (args) => {
        const url = webUrl(requiredString(args, "url").trim());
        if (!url) throw new ToolInputError("url must be an http(s) URL (a dev server is http://localhost:<port>)");
        const profile = optionalString(args, "profile");
        return { op: "open", url, ...(profile ? { profile: profile.trim() } : {}) };
      });
      const signedIn = reply.tab?.signedIn;
      return {
        tab: reply.tab?.id,
        ...reply.result,
        profile: reply.tab?.profileName,
        ...(signedIn === undefined ? {} : { signedIn }),
        ...(reply.tab?.signedInOn ? { signedInOn: reply.tab.signedInOn } : {}),
      };
    },

    // 2026-11-11: compact unless asked for all of it (browser-read.ts); `full` is the answer as it was.
    async browser_read(argumentsValue, meta) {
      let view: Exclude<ReturnType<typeof readView>, { error: string }> = {};
      const reply = await browserCommand("browser_read", argumentsValue, meta, ["tab", "page", "find", "section", "selector", "full"], (args) => {
        const asked = readView(args);
        if ("error" in asked) throw new ToolInputError(asked.error);
        view = asked;
        return { op: "read", ...(asked.selector ? { target: { selector: asked.selector } } : {}) };
      });
      try {
        return compactRead({ tab: reply.tab?.id, ...reply.result }, view);
      } catch (error) {
        throw error instanceof ReadViewError ? new ToolInputError(error.message) : error;
      }
    },

    async browser_click(argumentsValue, meta) {
      const reply = await browserCommand("browser_click", argumentsValue, meta, ["tab", "target"], (args) => ({
        op: "click",
        target: browserTarget(args),
      }));
      return { tab: reply.tab?.id, ...reply.result };
    },

    async browser_type(argumentsValue, meta) {
      const reply = await browserCommand("browser_type", argumentsValue, meta, ["tab", "target", "text", "submit"], (args) => {
        const text = args.text;
        if (typeof text !== "string" || text.length > BROWSER_TEXT_MAX) {
          throw new ToolInputError(`text must be a string of up to ${BROWSER_TEXT_MAX} characters`);
        }
        if (Object.hasOwn(args, "submit") && typeof args.submit !== "boolean") throw new ToolInputError("submit must be true or false");
        return { op: "type", target: browserTarget(args), text, ...(args.submit === true ? { submit: true } : {}) };
      });
      return { tab: reply.tab?.id, ...reply.result };
    },

    async browser_screenshot(argumentsValue, meta) {
      const reply = await browserCommand("browser_screenshot", argumentsValue, meta, ["tab"], () => ({ op: "screenshot" }));
      return { tab: reply.tab?.id, ...reply.result };
    },

    async browser_tabs(argumentsValue, meta) {
      const reply = await browserCommand("browser_tabs", argumentsValue, meta, [], () => ({ op: "tabs" }));
      return { tabs: reply.tabs ?? [] };
    },

    async browser_ask(argumentsValue, meta) {
      const reply = await browserCommand("browser_ask", argumentsValue, meta, ["tab", "reason"], (args) => {
        const parsed = askReason(args.reason);
        if ("error" in parsed) throw new ToolInputError(parsed.error);
        return { op: "ask", reason: parsed.reason };
      });
      const site = reply.result?.answersOnSignIn as string | undefined;
      const notes = [
        ...(reply.result?.appClosed ? ["conch's Mac app isn't open, so the user sees it when they open it"] : []),
        `wait for them: when they press Done${site ? `, or conch sees this tab's profile sign in to ${site}` : ""}, you get a message saying so, and browser_tabs shows it; your own click, type or open in the tab withdraws it`,
      ];
      return { tab: reply.tab?.id, asked: reply.result?.asked, note: notes.join("; ") };
    },

    async browser_close(argumentsValue, meta) {
      const reply = await browserCommand("browser_close", argumentsValue, meta, ["tab"], (args) => {
        if (!Object.hasOwn(args, "tab")) throw new ToolInputError("tab is required: the id of the tab to close (browser_tabs)");
        return { op: "close" };
      });
      return { closed: (reply.result?.closed as string | undefined) ?? undefined };
    },

    // An Atlas page in the Workdesk (atlas-copies.ts): its copy saved where Tyler keeps them, and filed as a markdown
    // deliverable keyed by its path, through review_to_front's own checks. conch never talks to Atlas.
    async atlas_show(argumentsValue, meta) {
      const { page, markdown, summary } = (() => {
        try {
          const args = toolArguments(argumentsValue);
          allowOnly(args, ["path", "markdown", "summary"]);
          const page = atlasPagePath(args.path);
          if (!page.ok) throw new ToolInputError(page.reason);
          const markdown = args.markdown;
          if (typeof markdown !== "string" || !markdown.trim()) {
            throw new ToolInputError("markdown must be the page's Markdown, as you read it or wrote it");
          }
          if (Buffer.byteLength(markdown, "utf8") > ATLAS_MARKDOWN_MAX_BYTES) {
            throw new ToolInputError(`markdown is over ${ATLAS_MARKDOWN_MAX_BYTES / 1024 / 1024} MB; show the part that matters`);
          }
          const summary = optionalString(args, "summary");
          if (summary !== undefined && !summary.trim()) throw new ToolInputError("summary must be a non-empty line");
          return { page, markdown, summary };
        } catch (error) {
          throw asRefusal(error);
        }
      })();
      // Verified before anything is written: a copy is saved only for a session conch can file it for.
      await verifiedCaller("show an Atlas page for any session", config, dependencies, meta);
      const copy = await (dependencies.writeAtlasCopy ?? writeAtlasCopy)(page.file, markdown, atlasCopiesFolder()).catch((error): never => {
        throw new Error(`failed: conch couldn't save the page's copy: ${errorMessage(error)}`);
      });
      const filing = atlasFiling(page.path, summary);
      const filed = await handlers.review_to_front({ summary: filing.summary, link: copy, kind: "markdown", key: filing.key }, meta);
      return { atlasPath: page.path, copy, ...(filed as Record<string, unknown>), source: "Atlas is the source; this is conch's copy of it" };
    },

    // A notification to the user's phone and Mac (notify-user.ts). Its limits are the daemon's: a few per calling
    // session an hour, kept by who is calling (`from`), not by the session a tap opens, and no repeats.
    async conch_notify(argumentsValue, meta) {
      const args = toolArguments(argumentsValue);
      allowOnly(args, ["body", "title", "session", "link"]);
      const body = noticeText(requiredString(args, "body"));
      const title = optionalString(args, "title");
      const query = optionalString(args, "session");
      const link = optionalString(args, "link");
      if (!body || [...body].length > NOTICE_BODY_MAX) {
        throw new ToolInputError(`body must be 1–${NOTICE_BODY_MAX} characters; it is not cut for you. Say the short version and leave the rest in your reply.`);
      }
      if (title !== undefined && (!noticeText(title) || [...noticeText(title)].length > NOTICE_TITLE_MAX)) {
        throw new ToolInputError(`title must be 1–${NOTICE_TITLE_MAX} characters`);
      }
      if (link !== undefined) {
        const linkError = noticeLinkError(link);
        if (linkError) throw new ToolInputError(linkError);
      }
      const binding = await callerBinding(config, dependencies, meta);
      const caller = binding.status === "verified" ? binding.session : undefined;
      const session = query ? await resolveSession(query, config, dependencies) : caller;
      const named = session ? noticeText(dependencies.sessionLabel(session, session.cwd)) : "";
      const sent = await (dependencies.notify ?? requestNotice)(config.socketPath, {
        kind: "notify-user",
        title: title === undefined ? [...(named || "conch")].slice(0, NOTICE_TITLE_MAX).join("") : noticeText(title),
        body,
        from: caller?.sessionId ?? "unverified",
        ...(session ? { sessionId: session.sessionId } : {}),
        ...(link ? { link } : {}),
      }, NOTIFY_REPLY_MS);
      if (!sent.ok) {
        throw new Error(sent.reason === "daemon-down"
          ? "failed: conch daemon is not running, so nothing was sent"
          : `failed: conch's daemon didn't answer${sent.diagnostic ? ` (${sent.diagnostic})` : ""}. It may still have gone: don't send it again`);
      }
      const reply = sent.reply;
      if (reply.kind === "notice-error") throw refusal(`refused: ${String(reply.error)}`);
      if (reply.kind !== "notify-result") throw new Error("ack-unknown: daemon reply did not match the notification");
      if (reply.outcome === "duplicate" || reply.outcome === "rate-limited") throw refusal(`refused: ${String(reply.said)}`);
      const { kind: _kind, ...result } = reply;
      return result;
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
  return handlers;
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

/**
 * An answer as the agent reads it. 2026-11-11: compact JSON, where it was indented two spaces: the indentation was 19%
 * of 201 browser_read replies (1.69 MB as sent, 1.37 MB compact) and 10% of 278 review_to_front ones, and an agent
 * reads JSON the same either way. mcp-sessions.ts still budgets its list by the indented length, which is longer.
 */
function toolResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const encoded = typeof value === "string"
    ? value
    : JSON.stringify(value) ?? "null";
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
 * The UTF-8 bytes of the text a tools/call reply hands the agent: its content blocks' text, or an error's message.
 * What the agent reads, so what it pays for; the JSON-RPC envelope around it never reaches its context.
 */
export function replyTextBytes(response: JsonRpcResponse): number {
  if (response.error) return Buffer.byteLength(response.error.message, "utf8");
  const content = isRecord(response.result) && Array.isArray(response.result.content) ? response.result.content : [];
  let bytes = 0;
  for (const block of content) if (isRecord(block) && typeof block.text === "string") bytes += Buffer.byteLength(block.text, "utf8");
  return bytes;
}

function historyRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  const response = jsonRpcResult(id, result);
  const fits = (value: JsonRpcResponse) => Buffer.byteLength(serializeJsonRpcLine(value), "utf8") + 1 <= MCP_HISTORY_MAX_BYTES;
  if (fits(response)) return response;
  const refused = jsonRpcResult(id, toolResult(JSON.stringify(historyError("response-too-large", "recorded history response exceeds its wire limit"))));
  return fits(refused) ? refused : jsonRpcError(null, -32600, "history request ID exceeds its wire limit");
}

/**
 * The answer to `initialize`: the revision negotiated from the client's (`negotiateProtocolVersion`),
 * and `instructions`, which tell every session that loads the plugin that conch is watching and what
 * to do about it, from the one source (agent-instructions.ts). A Claude Code session used to hear it
 * only from a skill it had to think of loading.
 */
export function initializeResult(params: unknown, text: AgentInstructions = AGENT_INSTRUCTIONS) {
  const client = isRecord(params) && isRecord(params.clientInfo) ? params.clientInfo.name : undefined;
  return {
    protocolVersion: negotiateProtocolVersion(isRecord(params) ? params.protocolVersion : undefined),
    // listChanged: a server that hands over to a newer conch's says so (mcp-handoff.ts).
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "conch", version: CONCH_VERSION },
    // Not to Codex (2026-10-18 review): it showed the instructions in front of every conch tool's own description, so a
    // skim of its tool list read 25 identical entries, and it carries the same words always-on from the plugin's AGENTS.md.
    ...(backendOfClient(client) === "codex" ? {} : { instructions: text.serverInstructions }),
  };
}

/** Told about every tools/call once it has its answer (the call log, mcp-usage.ts). Must return at once. */
export type McpCallObserver = (call: McpCallObservation) => void;

/**
 * How a call that returned ended: ok, except the answers that are a refusal or an error said as a value — a history
 * reply's code (history.ts), a wake or recite whose audio this Mac has yielded (`audioWhere`), and speech the user's
 * manual mode drops (`speechHeld`) — so the agent reads them as a result but the log counts what happened.
 */
export function resultOutcome(value: unknown): { outcome: McpCallOutcome; error?: string } {
  if (!isRecord(value)) return { outcome: "ok" };
  if (typeof value.audio === "string" && value.audio.startsWith("refused:")) return { outcome: "refused", error: value.audio };
  if (typeof value.held === "string" && value.held) return { outcome: "refused", error: value.held };
  if (value.kind === "history-off") return { outcome: "refused", error: "history is off" };
  if (value.kind !== "history-error" || typeof value.code !== "string") return { outcome: "ok" };
  const error = `${value.code}: ${typeof value.error === "string" ? value.error : ""}`;
  if (value.code === "unauthorized") return { outcome: "refused", error };
  const input = ["invalid-request", "session-not-found", "ambiguous-session", "item-not-found", "invalid-cursor", "stale-cursor", "stale-item"];
  return { outcome: input.includes(value.code) ? "input-error" : "failed", error };
}

/** What one server answers beyond its handlers: the tools it lists, and whether it says where a moved one went. */
export interface McpDispatchContext {
  /** What `tools/list` answers; the listed tools (`MCP_LISTED_TOOLS`) when absent. */
  listed?: readonly McpToolDefinition[];
  /**
   * The moved tools this server has told its session about, once each: present on a server that still lists them (a
   * session started before the move), so the first call of each says the command it is now. Absent, none is told.
   */
  movedHinted?: Set<string>;
}

/** The command a `conch_run` call ran, for the call log: the tool it is, and its arguments, so the log is the tool's. */
function runForLog(argumentsValue: unknown): { tool: string; args: Record<string, unknown> } | undefined {
  if (!isRecord(argumentsValue) || typeof argumentsValue.command !== "string") return undefined;
  try {
    // No file is read for this: the log keeps argument names, and an atlas page's words are no part of it.
    const invocation = parseAgentCommand(splitCommandLine(argumentsValue.command), { readFile: () => "", readStdin: () => "" });
    return invocation.kind === "run" ? { tool: invocation.tool, args: invocation.args } : undefined;
  } catch {
    return undefined;
  }
}

/** What the first call of a moved tool adds, on a server that still lists it. */
function movedHint(tool: string): string | undefined {
  const command = AGENT_COMMANDS.find((candidate) => candidate.tool === tool);
  return command
    ? `${tool} is \`conch agent ${command.name}\` in your shell now (\`conch agent help ${command.name}\`); this tool keeps working here until the session restarts.`
    : undefined;
}

/**
 * Dispatch one already-parsed JSON-RPC message. All failures are converted to
 * JSON-RPC errors or MCP isError tool results; this function never rejects.
 * `observe` hears each tools/call, unknown tools and bad arguments included, and cannot break one.
 */
export async function dispatchJsonRpc(
  message: unknown,
  handlers: McpToolHandlers,
  observe?: McpCallObserver,
  context: McpDispatchContext = {},
): Promise<JsonRpcResponse | null> {
  let requestId: JsonRpcId = null;
  let shouldReply = true;
  const tell = (call: McpCallObservation) => {
    try { observe?.(call); } catch {}
  };
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
        return shouldReply ? jsonRpcResult(requestId, initializeResult(message.params)) : null;
      }

      case "notifications/initialized":
        return null;

      case "tools/list":
        return shouldReply
          ? jsonRpcResult(requestId, { tools: context.listed ?? MCP_LISTED_TOOLS })
          : null;

      case "tools/call": {
        if (!isRecord(message.params) || typeof message.params.name !== "string") {
          return shouldReply
            ? jsonRpcError(requestId, -32602, "Invalid params")
            : null;
        }
        const name = message.params.name;
        const meta = message.params._meta;
        const ts = Date.now();
        const started = performance.now();
        if (!MCP_CALLABLE.has(name) || !Object.hasOwn(handlers, name)) {
          tell({ ts, tool: name, ms: 0, outcome: "input-error", error: "unknown tool", meta });
          return shouldReply
            ? jsonRpcError(requestId, -32602, `Unknown tool "${name}"`)
            : null;
        }
        const argumentsValue = Object.hasOwn(message.params, "arguments")
          ? message.params.arguments
          : {};
        if (!isRecord(argumentsValue)) {
          tell({ ts, tool: name, ms: 0, outcome: "input-error", error: "Tool arguments must be an object", meta });
          return shouldReply
            ? jsonRpcError(requestId, -32602, "Tool arguments must be an object")
            : null;
        }
        // A `conch_run` is logged as the command's own tool, marked `via: "run"`, so the log counts what agents do.
        const run = name === "conch_run" ? runForLog(argumentsValue) : undefined;
        const logged = { tool: run?.tool ?? name, arguments: run?.args ?? argumentsValue, meta, ...(run ? { via: "run" as const } : {}) };
        // review_to_front's answers name conch's other tools, which are `conch agent` commands now (agent-commands.ts).
        const worded = name === "review_to_front";
        try {
          const answered = await handlers[name as McpToolName](argumentsValue, meta);
          const value = answered instanceof RunAnswer ? answered.text : worded ? cliWorded(answered) : answered;
          const ms = performance.now() - started;
          // A text content block escapes the JSON again. Budget the final UTF-8 wire frame.
          const history = name === "conch_history" || name === "conch_item";
          const result = toolResult(history ? JSON.stringify(value) : value);
          const hint = !history && context.movedHinted && !context.movedHinted.has(name) ? movedHint(name) : undefined;
          if (hint) {
            context.movedHinted!.add(name);
            result.content.push({ type: "text", text: hint });
          }
          const response = history ? historyRpcResult(requestId, result) : jsonRpcResult(requestId, result);
          // 2026-11-11, `bytes`: what the call put in the agent's context, so result sizes are a distribution in the
          // log (`conch mcp-usage`, `conch evals`) rather than a guess from transcripts.
          tell({ ts, ms, ...resultOutcome(answered instanceof RunAnswer ? answered.value : answered), ...logged, bytes: replyTextBytes(response) });
          return shouldReply ? response : null;
        } catch (error) {
          const ms = performance.now() - started;
          const response = name === "conch_history" || name === "conch_item"
            ? historyRpcResult(requestId, toolError(error))
            : jsonRpcResult(requestId, toolError(worded ? new Error(cliWording(errorMessage(error))) : error));
          tell({ ts, ms, outcome: callOutcome(error), error: errorMessage(error), ...logged, bytes: replyTextBytes(response) });
          return shouldReply ? response : null;
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

/**
 * A JSON-RPC batch, which MCP 2025-03-26 lets a client send: each message dispatched in order, the
 * answers in one array, and nothing at all for a batch of notifications. An empty batch is an
 * invalid request, as JSON-RPC says.
 */
export async function dispatchJsonRpcBatch(
  messages: readonly unknown[],
  handlers: McpToolHandlers,
  observe?: McpCallObserver,
  context: McpDispatchContext = {},
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (!messages.length) return jsonRpcError(null, -32600, "Invalid Request");
  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    const response = await dispatchJsonRpc(message, handlers, observe, context);
    if (response) responses.push(response);
  }
  return responses.length ? responses : null;
}

export interface RunMcpServerOptions {
  config?: McpRuntimeConfig;
  dependencies?: McpDependencies;
  handlers?: McpToolHandlers;
  input?: ReadableStream<Uint8Array>;
  /** Receives exactly one serialized object without its framing newline. */
  writeLine?(line: string): void | Promise<void>;
  diagnostic?(message: string): void;
  /**
   * Hand over to a newer conch's server when one is installed (mcp-handoff.ts): its options, less the lines this server
   * writes. On by default for the real stdio server, off when `input` is given (tests) unless passed; false is off.
   */
  handoff?: Omit<McpHandoffOptions, "writeLine" | "diagnostic"> | false;
  /** The per-call log (mcp-usage.ts); on by default, at `mcpUsagePath()`; false is off. */
  callLog?: McpCallLog | false;
  /**
   * This server's report of its tools to the daemon (mcp-servers.ts), in `dir`: on by default for the real stdio server,
   * off when `input` is given (tests) unless passed; false is off.
   */
  report?: { dir?: string; pid?: number; sessionPid?: number } | false;
  /** What `tools/list` answers (tests); else what this server's start says (`listedMcpTools`). */
  listed?: readonly McpToolDefinition[];
}

/** How often an idle server looks for a newer conch to hand over to, besides after each message. */
export const MCP_HANDOFF_IDLE_CHECK_MS = 5 * 60_000;

/**
 * The real server's hand-off: the daemon's toolset off the sessions file, and a fresh `conch mcp` of what is installed,
 * told what this one lists (`HANDOFF_LISTED_ENV`), so it lists those and no more.
 */
function stdioHandoff(sessionsPath: string, listed: readonly string[]): Omit<McpHandoffOptions, "writeLine" | "diagnostic"> {
  return {
    ownToolset: MCP_TOOLSET,
    async publishedToolset() {
      const raw = await defaultMcpDependencies.readSessionsFile(sessionsPath);
      const published = raw === null ? null : JSON.parse(raw) as unknown;
      return isRecord(published) && typeof published.mcpToolset === "string" ? published.mcpToolset : undefined;
    },
    async spawn() {
      const { conchArgv } = await import("./install.ts");
      const fresh = Bun.spawn([...conchArgv(), "mcp"], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        env: {
          ...process.env,
          [HANDOFF_FROM_ENV]: String(process.pid),
          [HANDOFF_PARENT_ENV]: String(sessionParentPid()),
          [HANDOFF_LISTED_ENV]: listed.join(","),
        },
      });
      return {
        write(line: string) {
          // A fresh server that has gone takes nothing more; its going is `exited`'s to say.
          try {
            fresh.stdin.write(`${line}\n`);
            void Promise.resolve(fresh.stdin.flush()).catch(() => {});
          } catch {}
        },
        lines: streamLines(fresh.stdout),
        exited: fresh.exited,
        kill: () => fresh.kill(),
      };
    },
    now: Date.now,
  };
}

/**
 * The session this server serves: its parent, or, for a server a hand-off started, the parent of the server that handed
 * over (`handoffParentPid`, which checks it against the process table). Read once.
 */
let sessionParent: number | undefined;
function sessionParentPid(): number {
  sessionParent ??= handoffParentPid(process.env, process.ppid, processParent) ?? process.ppid;
  return sessionParent;
}

/**
 * What a real server lists: the listed tools, or, for one a hand-off started (its session began on an older server),
 * those and the moved tools the session had (`listedMcpTools`).
 */
function stdioListedTools(): McpToolDefinition[] {
  if (!process.env[HANDOFF_FROM_ENV] || handoffParentPid(process.env, process.ppid, processParent) === undefined) return listedMcpTools();
  const inherited = process.env[HANDOFF_LISTED_ENV];
  return listedMcpTools(inherited === undefined ? {} : { inherited: inherited.split(",").filter(Boolean) });
}

/**
 * Newline-delimited JSON-RPC 2.0 over stdio. stdout is used only by writeLine;
 * all local diagnostics go to stderr.
 */
export async function runMcpServer(options: RunMcpServerOptions = {}): Promise<void> {
  let loaded: Config | McpRuntimeConfig | undefined = options.config;
  const runtimeConfig = () => (loaded ??= loadConfig());
  // Which agent this server serves, as its `initialize` said: the backend of a call whose session conch can't tell.
  let clientBackend: ReturnType<typeof backendOfClient>;
  const handlers = options.handlers ?? createMcpToolHandlers(
    runtimeConfig(),
    { ...(options.dependencies ?? defaultMcpDependencies), clientBackend: () => clientBackend },
  );
  const listed = options.listed ?? (options.input ? listedMcpTools() : stdioListedTools());
  // A server that still lists moved tools says, the first time each is called, which command it is now.
  const context: McpDispatchContext = {
    listed,
    ...(listed.some((tool) => MCP_MOVED_TOOL_NAMES.includes(tool.name)) ? { movedHinted: new Set<string>() } : {}),
  };
  const callLog = options.callLog === false
    ? undefined
    : options.callLog ?? new McpCallLog({
      caller: mcpCallCaller(runtimeConfig, options.dependencies ?? defaultMcpDependencies),
      backendHint: () => clientBackend,
      vocabulary: mcpToolVocabulary(),
    });
  const input = options.input ?? Bun.stdin.stream();
  const writeLine = options.writeLine
    ?? ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const diagnostic = options.diagnostic
    ?? ((message: string) => {
      process.stderr.write(`[conch:mcp] ${message}\n`);
    });

  const writeResponse = async (response: JsonRpcResponse | JsonRpcResponse[]): Promise<void> => {
    await writeLine(serializeJsonRpcLine(response));
  };
  // A server a hand-off started is the installed conch already: it never hands over again, or each would start another.
  const handoffOptions = options.handoff === false
    ? undefined
    : options.handoff ?? (options.input || process.env[HANDOFF_FROM_ENV] ? undefined : stdioHandoff(options.config?.sessionsPath ?? MCP_SESSIONS_FILE, listed.map((tool) => tool.name)));
  const handoff = handoffOptions ? new McpHandoff({ ...handoffOptions, writeLine, diagnostic }) : undefined;
  // What this server has, for the daemon to tell which sessions can't get conch's current tools (mcp-servers.ts).
  const reportOptions = options.report === false ? undefined : options.report ?? (options.input ? undefined : {});
  const report = reportOptions
    ? {
      dir: reportOptions.dir ?? mcpServersDir(),
      body: {
        v: 1 as const,
        pid: reportOptions.pid ?? process.pid,
        sessionPid: reportOptions.sessionPid ?? sessionParentPid(),
        toolset: MCP_TOOLSET,
        tools: listed.map((tool) => tool.name),
        handoff: handoff !== undefined,
        version: CONCH_VERSION,
        startedAt: Date.now(),
      } satisfies McpServerReport as McpServerReport,
    }
    : undefined;
  if (report) writeMcpServerReport(report.body, report.dir);
  const processLine = async (line: string): Promise<void> => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = parseJsonRpcLine(line);
    } catch {
      if (handoff?.forward(line)) return;
      await writeResponse(jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    for (const one of Array.isArray(message) ? message : [message]) {
      handoff?.observe(one);
      if (isRecord(one) && one.method === "initialize" && isRecord(one.params) && isRecord(one.params.clientInfo)) {
        clientBackend = backendOfClient(one.params.clientInfo.name) ?? clientBackend;
        if (report && clientBackend) writeMcpServerReport({ ...report.body, client: clientBackend }, report.dir);
      }
    }
    // Handed over to a newer conch's server: every line is its to answer.
    if (handoff?.forward(line)) return;
    const response = Array.isArray(message)
      ? await dispatchJsonRpcBatch(message, handlers, callLog?.observe, context)
      : await dispatchJsonRpc(message, handlers, callLog?.observe, context);
    if (response) await writeResponse(response);
  };
  // One thing at a time, a line or a look for a newer conch, so a hand-off never starts while a call is half-answered.
  let turn: Promise<void> = Promise.resolve();
  const serially = (work: () => Promise<void>): Promise<void> =>
    (turn = turn.then(work).catch((error) => diagnostic(`server failure: ${errorMessage(error)}`)));
  const idleCheck = handoff ? setInterval(() => void serially(() => handoff.check()), MCP_HANDOFF_IDLE_CHECK_MS) : undefined;
  idleCheck?.unref?.();
  const handle = (line: string) => serially(async () => {
    await processLine(line);
    await handoff?.check();
  });

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
        await handle(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await handle(buffer.replace(/\r$/, ""));
  } catch (error) {
    diagnostic(`stdio failure: ${errorMessage(error)}`);
  } finally {
    clearInterval(idleCheck);
    handoff?.close();
    if (report) removeMcpServerReport(report.body.pid, report.dir);
    reader.releaseLock();
    // The last calls' lines, before `conch mcp` exits with stdin.
    await callLog?.flush();
  }
}

/**
 * One table row per agent (E8).
 *
 * Everything conch has to do differently for Claude Code and Codex — how to
 * start or resume one, which flag skips its permission prompts, whether it
 * has a rename command, which transcript reader its files need, where its
 * plugin manifest sits, how to inventory its capabilities — used to be a
 * `backend === "codex"` branch wherever it came up. Each of those branch
 * bodies now lives here, on the adapter for its agent, and the site that held
 * the branch asks `adapterFor(backend)` instead. A third backend is one union
 * member and one row; the `Record` below fails the typecheck until both exist.
 *
 * Where an agent has no implementation of a concern, its row returns exactly
 * what the branch returned (`null`, `""`, `[]`) — parity is not invented here.
 *
 * Every row's method references the module it came from lazily: those modules
 * import `adapterFor` back, and an ES module cycle only bites when a binding
 * is read before its module has run.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { liveBackgroundAgents, subagentRowId } from "./agent-activity.ts";
import {
  readClaude,
  readCodex,
  readCodexThreadConfiguration,
  type AgentCapabilityHomes,
  type Collector,
  type AgentProjectTrust,
  type AgentThreadConfiguration,
  type ReadAgentCapabilitiesOptions,
} from "./agent-capabilities.ts";
import { findCodexTranscript, type CodexSessionRegistryOptions } from "./codex-sessions.ts";
import { codexFolderTrusted } from "./codex-threads.ts";
import type { ConversationFormat } from "./conversation.ts";
import {
  readClaudeCandidates,
  readClaudeSessionHead,
  readCodexCandidates,
  type ClaudeResumableCandidate,
  type ReadResumableSessionsOptions,
  type ResumableCandidate,
  type ResumableSession,
} from "./resumable.ts";
import { claudeFolderTrusted, type SessionInfo } from "./sessions.ts";
import { isCodexTranscriptPath } from "./snippet.ts";

/** The closed set of agents conch can attach to. Adding one means adding a row to `ADAPTERS`. */
export type SessionBackend = "claude" | "codex";

export interface TranscriptLookupOptions extends CodexSessionRegistryOptions {
  claudeDir: string;
}

export interface AgentAdapter {
  readonly backend: SessionBackend;
  /** How a person hears the agent named in a message: "Claude Code", "Codex". */
  readonly displayName: string;

  // ── starting and resuming (session-lifecycle.ts) ──────────────────────────
  /** The binary `startTerminalSession` preflights on PATH and `exec`s. */
  readonly executable: string;
  /** The agent's own spelling of "resume this id"; the id arrives shell-quoted. */
  resumeArgs(quotedSessionId: string): string;
  /** `--teleport <cloud id>` where the agent can open a cloud session locally; null where it cannot. */
  readonly teleportArgs: ((quotedSessionId: string) => string) | null;
  /**
   * The verified flag for skipping permission prompts, spelled the way the
   * agent spells it. Read from `--help` on the installed binaries rather than
   * from memory: Codex has renamed this more than once, and there is no
   * `--yolo` alias in the current build despite the name people use for it.
   */
  readonly bypassPermissionsFlag: string;
  /** A per-launch "trust this folder" override, or "" where the agent takes none on its command line. */
  trustFolderArgs(cwd: string): string;
  /** Has the agent already been told it trusts this folder? Null when unreadable — say nothing. */
  folderTrusted(cwd: string): boolean | null;

  // ── labels (provider-rename.ts) ───────────────────────────────────────────
  /** The agent's own rename command, typed into its prompt; null where it has none. */
  renameCommand(label: string): string | null;

  // ── transcripts and rows (daemon.ts, sessions.ts) ─────────────────────────
  /** Which reader this agent's transcript files need. */
  readonly transcriptFormat: ConversationFormat;
  /** Recognises the agent's own transcript files. Claude has none: anything unclaimed is read as Claude's. */
  ownsTranscriptPath?(path: string): boolean;
  /** Where this agent keeps the transcript for a session id, if it can be found from the id alone. */
  findTranscript(sessionId: string, options: TranscriptLookupOptions): string | undefined;
  /** Live subagents nested under a session; `[]` where the agent writes none conch can read. */
  subagentSessions(parent: SessionInfo, transcriptPath: string): SessionInfo[];
  /** Rows can be observed without a process to talk to (read from a database, not a hook). */
  readonly rowsMayLackPid: boolean;

  // ── the resume picker (resumable.ts) ──────────────────────────────────────
  /** Everything this agent's history offers to resume, cheapest read first. */
  resumableCandidates(options: ReadResumableSessionsOptions): {
    candidates: ResumableCandidate[];
    complete: boolean;
  };
  /** Finishes one row this adapter's own `resumableCandidates` produced. */
  resolveResumable(candidate: ResumableCandidate): {
    session: ResumableSession | null;
    complete: boolean;
  };

  // ── capabilities (agent-capabilities.ts) ──────────────────────────────────
  /** The directory a plugin manifest sits in, checked before the other agents'. */
  readonly pluginManifestDir: string;
  /** What an MCP server's `enabled` means when unset: Codex runs it, Claude's state is unknown. */
  readonly mcpEnabledDefault: boolean | null;
  /** The agent's half of `readAgentCapabilities`, given the resolved homes. */
  readCapabilities(
    options: ReadAgentCapabilitiesOptions,
    collector: Collector,
    homes: AgentCapabilityHomes,
  ): { projectTrust?: AgentProjectTrust; threadConfiguration?: AgentThreadConfiguration };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const claudeAdapter: AgentAdapter = {
  backend: "claude",
  displayName: "Claude Code",
  executable: "claude",
  resumeArgs: (id) => ` --resume ${id}`,
  teleportArgs: (id) => ` --teleport ${id}`,
  bypassPermissionsFlag: "--dangerously-skip-permissions",
  // Claude Code's trust decision cannot be supplied on the command line, which
  // is why conch checks it beforehand (`folderTrusted`) and explains instead.
  trustFolderArgs: () => "",
  folderTrusted: (cwd) => claudeFolderTrusted(cwd),
  renameCommand: (label) => `/rename ${label}`,
  transcriptFormat: "claude",
  findTranscript: (sessionId, { claudeDir }) => {
    const projects = join(claudeDir, "projects");
    try {
      for (const dir of readdirSync(projects)) {
        const candidate = join(projects, dir, `${sessionId}.jsonl`);
        try {
          statSync(candidate);
          return candidate;
        } catch {}
      }
    } catch {}
    return undefined;
  },
  subagentSessions: (parent, transcriptPath) =>
    liveBackgroundAgents(transcriptPath).map((agent) => ({
      sessionId: subagentRowId(agent.agentId),
      parentSessionId: parent.sessionId,
      backend: "claude" as const,
      name: agent.description ?? `agent ${agent.agentId.slice(0, 7)}`,
      cwd: parent.cwd,
      // In flight by construction; a finished one is not listed at all.
      status: "busy",
      ...(agent.startedAt !== undefined
        ? { startedAt: agent.startedAt, statusUpdatedAt: agent.startedAt }
        : {}),
      transcriptPath: agent.transcriptPath,
    })),
  rowsMayLackPid: false,
  resumableCandidates: (options) => readClaudeCandidates(options),
  resolveResumable: (candidate) => readClaudeSessionHead(candidate as ClaudeResumableCandidate),
  pluginManifestDir: ".claude-plugin",
  mcpEnabledDefault: null,
  readCapabilities: (options, collector, homes) =>
    homes.claudeHome && homes.claudeStatePath
      ? { projectTrust: readClaude(options, collector, homes.claudeHome, homes.claudeStatePath) }
      : {},
};

export const codexAdapter: AgentAdapter = {
  backend: "codex",
  displayName: "Codex",
  executable: "codex",
  resumeArgs: (id) => ` resume ${id}`,
  teleportArgs: null,
  bypassPermissionsFlag: "--dangerously-bypass-approvals-and-sandbox",
  trustFolderArgs: (cwd) => ` -c ${shellQuote(`projects."${cwd}".trust_level="trusted"`)}`,
  folderTrusted: (cwd) => codexFolderTrusted(cwd),
  // Codex has no equivalent command (provider-rename.ts returned `unsupported`).
  renameCommand: () => null,
  transcriptFormat: "codex",
  ownsTranscriptPath: (path) => isCodexTranscriptPath(path),
  findTranscript: (sessionId, options) => findCodexTranscript(sessionId, options),
  subagentSessions: () => [],
  rowsMayLackPid: true,
  resumableCandidates: (options) => readCodexCandidates(options),
  // A Codex row is complete as read: the database already carries its label and cwd.
  resolveResumable: (candidate) => ({ session: candidate as ResumableSession, complete: true }),
  pluginManifestDir: ".codex-plugin",
  mcpEnabledDefault: true,
  readCapabilities: (options, collector, homes) =>
    homes.codexHome
      ? {
        projectTrust: readCodex(options, collector, homes.codexHome, homes.agentsHome),
        threadConfiguration: readCodexThreadConfiguration(options, collector, homes.codexHome),
      }
      : {},
};

/** The table. Typed over the closed union so a new member without a row does not compile. */
const ADAPTERS: Record<SessionBackend, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

const table = new Map<string, AgentAdapter>(Object.entries(ADAPTERS));

/** Legacy Claude registry projections carry no `backend` (see `SessionInfo`); absent reads as Claude. */
export function adapterFor(backend: SessionBackend | undefined): AgentAdapter {
  const adapter = table.get(backend ?? "claude");
  if (!adapter) throw new Error(`no agent adapter for backend ${JSON.stringify(backend)}`);
  return adapter;
}

/** Every row, in table order — Claude first, as every "then fall back to Codex" read was. */
export function agentAdapters(): AgentAdapter[] {
  return [...table.values()];
}

/** The reader for a transcript path: the agent that recognises the file, else Claude's. */
export function transcriptFormatFor(transcriptPath: string): ConversationFormat {
  return (agentAdapters().find((adapter) => adapter.ownsTranscriptPath?.(transcriptPath))
    ?? claudeAdapter).transcriptFormat;
}

/**
 * A row added at runtime. Returns its remover.
 *
 * The shipped rows are the `ADAPTERS` literal above; this exists so a test can
 * build a third agent and drive every generic path through it without the
 * union growing. Nothing outside tests calls it.
 */
export function registerAgentAdapter(adapter: AgentAdapter): () => void {
  table.set(adapter.backend, adapter);
  return () => {
    table.delete(adapter.backend);
  };
}

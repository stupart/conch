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
import { codexFolderTrusted, readCodexHelperThreads } from "./codex-threads.ts";
import type { AgentQuestion, ConversationFormat, QuestionAnswer } from "./conversation.ts";
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

/**
 * One per-session choice the agent's own CLI takes at start (C1). `name` is
 * the key a request's `options` uses; `flag` is the CLI's spelling; `help` is
 * the CLI's own help line, verbatim, so a refusal can quote it. Read from
 * `--help` on the installed binaries, like `bypassPermissionsFlag`.
 */
export interface StartOption {
  readonly name: string;
  readonly flag: string;
  readonly kind: "enum" | "bool" | "string";
  /** `kind: "enum"` only: the CLI's own list, in its order. */
  readonly choices?: readonly string[];
  readonly help: string;
  /** Meaningful only with a resume; refused on a fresh start. */
  readonly resumeOnly?: boolean;
  /**
   * Option names this CLI refuses alongside this one, from its own
   * `conflicts_with`. Codex exits 2 before it starts on
   * `--dangerously-bypass-approvals-and-sandbox --ask-for-approval never`,
   * and what conch's launch shows for that is a raw usage dump in a Terminal
   * nobody is watching, so the pair is refused here instead.
   */
  readonly conflictsWith?: readonly string[];
}

/** The `options` key both agents spell their bypass toggle under; its flag is the row's `bypassPermissionsFlag`. */
export const BYPASS_OPTION = "bypass-permissions";

export interface AgentAdapter {
  readonly backend: SessionBackend;
  /** How a person hears the agent named in a message: "Claude Code", "Codex". */
  readonly displayName: string;

  // ── starting and resuming (session-lifecycle.ts) ──────────────────────────
  /** The binary `startTerminalSession` preflights on PATH and `exec`s. */
  readonly executable: string;
  /**
   * How many Ctrl-D presses `closeTerminalSession` types for a clean exit.
   * Claude Code 2.1.266 treats Ctrl-D like Ctrl-C: one press shows "Press
   * Ctrl-D again to exit" and a second within 800ms leaves — measured on the
   * installed binary, and conch's single press was the close that "did not
   * exit cleanly after Ctrl-D". Codex 0.155.1 leaves on one, and its tab's
   * process has completed within 200ms, so a second press there would land in
   * whatever the finished tab gives way to: per agent, never a default of two.
   */
  readonly exitKeystrokes: number;
  /**
   * The keys that answer a pending question in the agent's own picker, one
   * answer per question; a string is why these answers can't be typed. Null
   * where the picker isn't known, and the answer goes in as a message.
   */
  readonly questionKeys: ((questions: readonly AgentQuestion[], answers: readonly QuestionAnswer[]) => AnswerKey[] | string) | null;
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
  /**
   * What a person chooses per session, from the agent's own `--help`, in the
   * order the sheets show them. Free-form lists (`--allowedTools`, `--add-dir`,
   * `-c key=value`) are deliberately absent: nothing conch cannot validate is
   * passed through.
   */
  readonly startOptions: readonly StartOption[];
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
  /**
   * Live subagents nested under a session; `[]` where the agent writes none
   * conch can read. May be async: Codex's answer comes from a lock probe, which
   * must not block the daemon's one thread.
   */
  subagentSessions(parent: SessionInfo, transcriptPath: string): SessionInfo[] | Promise<SessionInfo[]>;
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

/** One step of a picker answer: a key typed as itself, words typed out, or a named key. */
export type AnswerKey = { press: string } | { type: string } | "Right" | "Enter";

/**
 * Claude Code's AskUserQuestion picker, measured on 2.1.280 by driving a
 * real session in a pseudo-terminal and reading the recorded answer:
 * - a question's option number picks it and moves to the next question;
 * - a multiSelect question's numbers toggle, and → moves on;
 * - the number after the last option is "Type something": the words, then
 *   Return, record them and move on;
 * - every picker ends on "Review your answers … 1. Submit answers", except a
 *   lone single-choice question, which a number submits outright.
 * A question whose options carry previews is laid out side by side (measured
 * the same way, 2026-09-23): a number only moves the highlight and Return picks,
 * and there is no "Type something" row: `n` opens the question's notes.
 * Assumes the picker is on its first question, as a new one opens.
 */
export function claudeQuestionKeys(
  questions: readonly AgentQuestion[],
  answers: readonly QuestionAnswer[],
): AnswerKey[] | string {
  if (!questions.length || answers.length !== questions.length) {
    return `the session is asking ${questions.length} question${questions.length === 1 ? "" : "s"}, and ${answers.length} answer${answers.length === 1 ? " was" : "s were"} sent`;
  }
  const keys: AnswerKey[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]!;
    if ("text" in answer) {
      if (question.multiSelect) return `"${question.header || question.question}" takes options, not words`;
      // With previews there is no "Type something" row: words go in as the question's notes,
      // which Claude Code records as "(notes only)" with the words beside it.
      keys.push(question.previews ? { press: "n" } : { press: String(question.options.length + 1) }, { type: answer.text }, "Enter");
      continue;
    }
    const { choices } = answer;
    if (!choices.length || (!question.multiSelect && choices.length !== 1)
      || choices.some((choice) => !Number.isInteger(choice) || choice < 0 || choice >= question.options.length)) {
      return `the answer to "${question.header || question.question}" doesn't match its options`;
    }
    keys.push(...choices.map((choice) => ({ press: String(choice + 1) })));
    if (question.multiSelect) keys.push("Right");
    // With previews a number only moves the highlight; Return picks it and moves on. Typing
    // numbers alone is how Tyler's answer to "The ring" went nowhere (2026-09-23).
    else if (question.previews) keys.push("Enter");
  }
  if (questions.length > 1 || questions[0]!.multiSelect) keys.push({ press: "1" });
  return keys;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const claudeAdapter: AgentAdapter = {
  backend: "claude",
  displayName: "Claude Code",
  executable: "claude",
  exitKeystrokes: 2,
  questionKeys: claudeQuestionKeys,
  resumeArgs: (id) => ` --resume ${id}`,
  teleportArgs: (id) => ` --teleport ${id}`,
  bypassPermissionsFlag: "--dangerously-skip-permissions",
  // `claude --help`, 2.1.266.
  startOptions: [
    {
      name: "model",
      flag: "--model",
      kind: "string",
      help: "Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').",
    },
    {
      name: "permission-mode",
      flag: "--permission-mode",
      kind: "enum",
      choices: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
      help: "Permission mode to use for the session",
    },
    {
      name: BYPASS_OPTION,
      flag: "--dangerously-skip-permissions",
      kind: "bool",
      help: "Bypass all permission checks. Recommended only for sandboxes with no internet access.",
    },
    {
      name: "effort",
      flag: "--effort",
      kind: "enum",
      choices: ["low", "medium", "high", "xhigh", "max"],
      help: "Effort level for the current session (low, medium, high, xhigh, max)",
    },
    {
      name: "fork-session",
      flag: "--fork-session",
      kind: "bool",
      resumeOnly: true,
      help: "When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)",
    },
  ],
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
  exitKeystrokes: 1,
  // Codex's request_user_input picker hasn't been measured; its answer stays a message.
  questionKeys: null,
  resumeArgs: (id) => ` resume ${id}`,
  teleportArgs: null,
  bypassPermissionsFlag: "--dangerously-bypass-approvals-and-sandbox",
  // `codex --help` and `codex resume --help`, codex-cli 0.154.0: the same
  // options on both, so they parse after `resume <id>` too (verified: an
  // invalid `--sandbox` there is rejected by name). Re-read on this Mac when
  // the bypass/sandbox conflict below was found; the option set is unchanged.
  startOptions: [
    // No `--model` row, deliberately: codex takes its model from its own config, and a row here is an
    // invitation to override it from the sheet. conch never passed the flag itself; offering it was the
    // same thing one click later.
    {
      name: "sandbox",
      flag: "--sandbox",
      kind: "enum",
      choices: ["read-only", "workspace-write", "danger-full-access"],
      help: "Select the sandbox policy to use when executing model-generated shell commands",
    },
    {
      name: "ask-for-approval",
      flag: "--ask-for-approval",
      kind: "enum",
      choices: ["on-request", "never"],
      help: "Configure when the model requires human approval before executing a command",
    },
    {
      name: BYPASS_OPTION,
      flag: "--dangerously-bypass-approvals-and-sandbox",
      kind: "bool",
      // `codex --dangerously-bypass-approvals-and-sandbox --sandbox danger-full-access
      // --ask-for-approval never` exits 2 with "the argument ... cannot be used
      // with ...", verified on codex-cli 0.154.0. The bypass already implies
      // both, so it is the one coherent form.
      conflictsWith: ["sandbox", "ask-for-approval"],
      help: "Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS. Intended solely for running in environments that are externally sandboxed",
    },
    {
      name: "profile",
      flag: "--profile",
      kind: "string",
      help: "Layer $CODEX_HOME/<name>.config.toml on top of the base user config",
    },
  ],
  trustFolderArgs: (cwd) => ` -c ${shellQuote(`projects."${cwd}".trust_level="trusted"`)}`,
  folderTrusted: (cwd) => codexFolderTrusted(cwd),
  // Codex has no equivalent command (provider-rename.ts returned `unsupported`).
  renameCommand: () => null,
  transcriptFormat: "codex",
  ownsTranscriptPath: (path) => isCodexTranscriptPath(path),
  findTranscript: (sessionId, options) => findCodexTranscript(sessionId, options),
  // Helpers from Codex's own edge table, live by writer lock (codex-threads.ts).
  // A helper runs inside its parent's process, so it gets no pid of its own:
  // nested, never active, never announced — C4's shape.
  subagentSessions: async (parent, transcriptPath) =>
    (await readCodexHelperThreads(parent.sessionId, transcriptPath)).map((helper) => ({
      sessionId: helper.threadId,
      parentSessionId: parent.sessionId,
      backend: "codex" as const,
      ...(helper.name ? { name: helper.name } : {}),
      cwd: helper.cwd || parent.cwd,
      status: helper.status,
      statusUpdatedAt: helper.updatedAt,
      transcriptPath: helper.transcriptPath,
    })),
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
  return adapterForTranscript(transcriptPath).transcriptFormat;
}

/** The agent that writes this transcript. */
export function adapterForTranscript(transcriptPath: string): AgentAdapter {
  return agentAdapters().find((adapter) => adapter.ownsTranscriptPath?.(transcriptPath)) ?? claudeAdapter;
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

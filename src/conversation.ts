/**
 * The conversation, as a thing both apps can render.
 *
 * Everything conch showed until now was ONE string: `lastAssistantText` flattened
 * a whole turn into the latest reply, and the apps replaced it wholesale every
 * turn. That single decision is why long answers arrive as fragments, why the
 * previous reply vanishes when a new turn starts, and why "show work" is a list
 * of dead links rather than the tool calls it describes.
 *
 * Shape (Tyler's, and it is the right one): an ordered stack of keys plus a map
 * from key to content.
 *
 *     order: ["a", "b", "c"]          items: { a: …, b: …, c: … }
 *
 * Two operations, and the second is the one an append-only log cannot express:
 *   - APPEND a new key when a message starts
 *   - MUTATE the value at the last key while it streams
 *
 * Stable keys are not merely convenient. SwiftUI's `ForEach` re-measures and
 * rebuilds any row whose identity changes, so identity IS the scroll-jank fix:
 * with stable ids, appending to the end leaves every existing row untouched.
 *
 * The same shape serves the wire. Sending `order` plus only the items whose
 * `rev` changed is what stops a growing conversation being re-sent to the phone
 * over a metered relay on every render.
 */

export type ConversationItemKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "review";

export interface ConversationToolDetail {
  /** What sort of operation this was, so a viewer can render it as one. */
  kind?: ToolKind;
  name: string;
  status: "running" | "done" | "error";
  /** Tool output, kept separate so a viewer can collapse it. */
  result?: string;
}

export interface ConversationItem {
  /** Stable across renders. Both formats supply one; index is the fallback. */
  id: string;
  /** Bumped whenever content changes, so the wire can send only what moved. */
  rev: number;
  kind: ConversationItemKind;
  /** Markdown, never flattened for speech — viewers render, the speaker strips. */
  text: string;
  at?: number;
  tool?: ConversationToolDetail;
  /** Present when this row IS a plan, so viewers render a checklist. */
  plan?: PlanStep[];
  /** Present when the agent is WAITING on you to choose. */
  question?: AgentQuestion;
  /** Present when this row changed a file, so viewers can show the lines. */
  change?: FileChange;
  review?: { summary: string; link?: string };
}

export interface Conversation {
  sessionId: string;
  /** The key stack, oldest first. */
  order: string[];
  items: Record<string, ConversationItem>;
}

export function emptyConversation(sessionId = ""): Conversation {
  return { sessionId, order: [], items: {} };
}

export type ConversationFormat = "claude" | "codex";

/** Put an item in, preserving `rev` semantics: a changed value is a new revision. */
export function upsertConversationItem(
  conversation: Conversation,
  item: Omit<ConversationItem, "rev">,
): void {
  const existing = conversation.items[item.id];
  if (!existing) {
    conversation.order.push(item.id);
    conversation.items[item.id] = { ...item, rev: 1 };
    return;
  }
  const unchanged = existing.text === item.text
    && existing.kind === item.kind
    && existing.tool?.status === item.tool?.status
    && existing.tool?.result === item.tool?.result;
  if (unchanged) return;
  conversation.items[item.id] = { ...item, rev: existing.rev + 1 };
}

function textFromClaudeParts(parts: any[], type: string): string {
  return parts
    .filter((part) => part?.type === type)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

/**
 * Machine-written content that Claude Code files under `type: "user"`.
 *
 * The same disguise as tool results, and just as misleading: a
 * `<task-notification>` telling you a background command was killed rendered as
 * a message YOU had sent — Tyler: "why is it showing that I'm sending messages
 * like <task-notification> ... when im not??"
 *
 * Returns what the row should be: a tool-shaped record for a task notification,
 * which is real information worth keeping, or null for the injected wrappers
 * that are pure plumbing.
 */
export function classifyInjectedUserText(
  text: string,
): { kind: "task"; name: string; summary: string; status: "done" | "error" } | { kind: "drop" } | null {
  const head = text.trimStart();
  if (head.startsWith("<task-notification>")) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim() ?? "";
    const status = /<status>([\s\S]*?)<\/status>/.exec(text)?.[1]?.trim() ?? "";
    return {
      kind: "task",
      name: "background task",
      summary: summary || status || "background task finished",
      // "killed" and "failed" are not successes; anything else reads as done.
      status: /kill|fail|error/i.test(status) ? "error" : "done",
    };
  }
  // Wrappers with no conversational content of their own.
  if (/^<(system-reminder|local-command-stdout|local-command-stderr|command-name|command-message)>/.test(head)) {
    return { kind: "drop" };
  }
  // Claude Code writes this itself when you interrupt; it is an artifact of the
  // interruption, not a thing you said.
  if (/^\[Request interrupted by user/.test(head)) return { kind: "drop" };
  return null;
}

/**
 * Fold one Claude transcript line into the conversation.
 *
 * The trap this exists to avoid: Claude Code records TOOL RESULTS as entries of
 * `type: "user"`. In a live transcript sampled while building this, 75 of 80
 * "user" entries were tool results and only 5 were things Tyler actually typed.
 * Treating them alike turns a conversation into machine noise, and treating one
 * as a turn boundary is the bug that made a backward scan stop immediately.
 */
export function reduceClaudeLine(conversation: Conversation, entry: any): void {
  if (!entry || typeof entry !== "object") return;
  const id = typeof entry.uuid === "string" ? entry.uuid : undefined;
  const at = Date.parse(entry.timestamp ?? "") || undefined;
  const parts: any[] = Array.isArray(entry.message?.content) ? entry.message.content : [];

  if (entry.type === "user") {
    const results = parts.filter((part) => part?.type === "tool_result");
    if (results.length) {
      // Attach output to the call it answers, rather than emitting a row that
      // reads as the user saying something.
      for (const result of results) {
        const callId = typeof result.tool_use_id === "string" ? result.tool_use_id : null;
        const target = callId ? conversation.items[`tool:${callId}`] : undefined;
        if (!target?.tool) continue;
        upsertConversationItem(conversation, {
          ...target,
          tool: {
            ...target.tool,
            status: result.is_error ? "error" : "done",
            result: claudeResultText(result.content),
          },
        });
      }
      return;
    }
    // Attachments you sent. Found by indexing every transcript on the machine
    // rather than by noticing one missing: 14 `image` and 2 `document` parts
    // were being dropped, so a turn where you sent a screenshot rendered as
    // whatever text happened to accompany it — or as nothing at all.
    const attachments = parts.filter((part) =>
      part?.type === "image" || part?.type === "document"
    );
    const text = typeof entry.message?.content === "string"
      ? entry.message.content
      : textFromClaudeParts(parts, "text");
    if (!text && attachments.length) {
      upsertConversationItem(conversation, {
        id: id ?? `user:${conversation.order.length}`,
        kind: "user",
        text: attachments.length === 1
          ? `[${attachments[0]!.type}]`
          : `[${attachments.length} attachments]`,
        at,
      });
      return;
    }
    if (!text) return;
    const injected = classifyInjectedUserText(text);
    if (injected?.kind === "drop") return;
    if (injected?.kind === "task") {
      upsertConversationItem(conversation, {
        id: id ?? `task:${conversation.order.length}`,
        kind: "tool",
        text: injected.summary,
        at,
        tool: { name: injected.name, status: injected.status },
      });
      return;
    }
    upsertConversationItem(conversation, { id: id ?? `user:${conversation.order.length}`, kind: "user", text, at });
    return;
  }

  if (entry.type !== "assistant") return;

  const thinking = textFromClaudeParts(parts, "thinking");
  if (thinking) {
    upsertConversationItem(conversation, {
      id: `${id ?? conversation.order.length}:thinking`,
      kind: "thinking",
      text: thinking,
      at,
    });
  }
  const text = textFromClaudeParts(parts, "text");
  if (text) {
    upsertConversationItem(conversation, {
      id: id ?? `assistant:${conversation.order.length}`,
      kind: "assistant",
      text,
      at,
    });
  }
  for (const call of parts.filter((part) => part?.type === "tool_use")) {
    const callId = typeof call.id === "string" ? call.id : `${id}:${call.name}`;
    const steps = planSteps(call.input);
    const asked = agentQuestion(call.input);
    const changed = toolKind(String(call.name ?? ""), call.input) === "file_change"
      ? fileChange(call.input)
      : null;
    upsertConversationItem(conversation, {
      id: `tool:${callId}`,
      kind: "tool",
      // The question itself, not "AskUserQuestion(...)" — this row is the one
      // thing on screen a person has to act on, so it says what it is asking.
      text: asked ? asked.question : summariseToolInput(call.input),
      at,
      tool: {
        name: toolDisplayName(String(call.name ?? "tool")),
        kind: toolKind(String(call.name ?? ""), call.input),
        status: "running",
      },
      ...(steps.length ? { plan: steps } : {}),
      ...(asked ? { question: asked } : {}),
      ...(changed ? { change: changed } : {}),
    });
  }
}

function claudeResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * A tool's name as a person should read it.
 *
 * MCP tools arrive wire-named — `mcp__claude-in-chrome__computer` — which is
 * fine in a protocol and hostile in a conversation. The server is kept because
 * it is the useful half (figma vs linear vs chrome tells you what happened),
 * just separated from the plumbing.
 */
/**
 * What KIND of thing a tool call is, independent of which agent ran it.
 *
 * conch filed every tool call under one `tool` kind, so a session rendered as
 * an undifferentiated stripe of rows — Tyler's "i just see a string of tools
 * calls on them". A shell command, a file edit and a web search are not the
 * same event and should not look the same: only once they are told apart can an
 * edit render as a diff and a command as a terminal line.
 *
 * The vocabulary is t3code's `CanonicalItemType`, which is worth adopting
 * verbatim — it is the same set of distinctions any agent UI converges on, and
 * sharing the names makes their handling of each a usable reference.
 *
 * Claude and Codex name their tools differently for identical operations
 * (`Bash` vs `exec_command`, `Edit` vs `apply_patch`), which is exactly why the
 * mapping belongs here rather than in a renderer: one table, both backends, and
 * the apps never learn either vocabulary.
 */
export type ToolKind =
  | "command_execution"
  | "file_change"
  | "file_read"
  | "search"
  | "web_search"
  | "subagent"
  | "plan"
  | "question"
  | "mcp_tool_call"
  | "unknown";

const TOOL_KINDS: ReadonlyArray<readonly [ToolKind, RegExp]> = [
  ["command_execution", /^(bash|shell|exec_command|run_command|local_shell)$/i],
  ["file_change", /^(edit|write|multiedit|notebookedit|apply_patch|str_replace\w*)$/i],
  ["file_read", /^(read|notebookread|view|cat_file)$/i],
  ["search", /^(glob|grep|ls|find|list_dir|codebase_search)$/i],
  ["web_search", /^(websearch|webfetch|web_search|fetch|browse)$/i],
  ["subagent", /^(task|agent|workflow|dispatch_agent)$/i],
  ["plan", /^(todowrite|update_plan|exit_plan_mode|todoread)$/i],
  ["question", /^(askuserquestion|ask_user_question|user_input)$/i],
];

/**
 * Codex calls almost everything `exec`.
 *
 * Where Claude names the tool it is using, Codex sends one `exec` call whose
 * argument is a line of JavaScript — `await tools.update_plan({...})`,
 * `await tools.exec_command({...})`, `await tools.apply_patch(...)`. Classifying
 * on the name alone therefore files every Codex action under one label, which
 * is most of why a Codex session looked like undifferentiated noise.
 */
const CODEX_INNER_TOOL = /\btools\.([a-z_]+)\s*\(/i;

export function toolKind(name: string, input?: unknown): ToolKind {
  // MCP first: an MCP server may expose a tool called `read` or `search`, and
  // it is still someone else's integration rather than the agent touching this
  // machine. Where it came from matters more than what it is called.
  if (name.startsWith("mcp__")) return "mcp_tool_call";

  if (typeof input === "string") {
    const inner = CODEX_INNER_TOOL.exec(input);
    if (inner) {
      const resolved = classifyName(inner[1]!);
      // `exec` running something we have no rule for is still code execution,
      // which is more honest than "unknown".
      if (resolved !== "unknown") return resolved;
      return "command_execution";
    }
    // A raw patch envelope with no tools.* wrapper is still a file change.
    if (input.includes("*** Begin Patch")) return "file_change";
  }

  const named = classifyName(name);
  if (named !== "unknown") return named;
  // `exec` with an argument shape we could not read is code running.
  return /^(exec|custom_tool_call)$/i.test(name) ? "command_execution" : "unknown";
}

function classifyName(name: string): ToolKind {
  if (!name) return "unknown";
  for (const [kind, pattern] of TOOL_KINDS) {
    if (pattern.test(name)) return kind;
  }
  return "unknown";
}

/**
 * A question an agent is waiting on you to answer.
 *
 * This is the one place conch's interaction model beats a screen outright. A
 * multiple-choice question is exactly the shape a voice loop answers well —
 * it can be read aloud with its options and answered by saying one, from
 * across the room, which is the whole point of the thing.
 *
 * The shape is Claude Code's `AskUserQuestion` and t3code's
 * `UserInputQuestion`, which agree: a header, the question, and options that
 * each carry a label and an explanation of what choosing it means.
 */
export interface AgentQuestion {
  /** A few words naming the decision, for a row that must stay one line. */
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  /** More than one answer may be chosen. */
  multiSelect: boolean;
}

/**
 * Pull the questions out of an `AskUserQuestion` call.
 *
 * Returns the FIRST question only. The tool accepts an array, but a person
 * being read a queue of questions aloud cannot answer the third one first, and
 * every real call observed carries exactly one.
 */
export function agentQuestion(input: unknown): AgentQuestion | null {
  if (!input || typeof input !== "object") return null;
  const questions = (input as any).questions;
  const first = Array.isArray(questions) ? questions[0] : questions;
  if (!first || typeof first !== "object") return null;
  const question = typeof first.question === "string" ? first.question.trim() : "";
  if (!question) return null;
  const options = Array.isArray(first.options)
    ? first.options
      .map((option: any) => ({
        label: String(option?.label ?? "").trim(),
        ...(typeof option?.description === "string" && option.description.trim()
          ? { description: option.description.trim() }
          : {}),
      }))
      .filter((option: { label: string }) => option.label)
    : [];
  if (!options.length) return null;
  return {
    header: typeof first.header === "string" ? first.header.trim() : "",
    question,
    options,
    multiSelect: first.multiSelect === true,
  };
}

/**
 * A question, as something to say out loud.
 *
 * Read as written, an option list is unusable by ear: descriptions are written
 * for a screen and are far too long to hold in your head while the next one is
 * being read. So only the labels are spoken, joined the way a person would say
 * them, with the header first because it names the decision before you are
 * asked to make one.
 */
export function spokenQuestion(asked: AgentQuestion): string {
  const labels = asked.options.map((option) => option.label);
  const choices = labels.length > 1
    ? `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`
    : labels[0] ?? "";
  const lead = asked.header ? `${asked.header}. ` : "";
  const plural = asked.multiSelect ? "You can pick more than one." : "";
  return `${lead}${asked.question} Your options are: ${choices}.${plural ? ` ${plural}` : ""}`;
}

/**
 * What a file change actually changed.
 *
 * A row reading `Edit /Users/.../deliverable-card.tsx` tells you a file was
 * touched and nothing about what happened to it, which is the least useful
 * summary of the most consequential thing an agent does. The edit payload
 * already carries both sides, so the lines are right there to be counted and
 * shown.
 *
 * Deliberately not a unified diff with context. On a phone, and in a stack you
 * are scanning rather than reviewing, the changed lines ARE the story — and
 * carrying context lines would multiply what crosses the relay for something
 * nobody reads in that position.
 */
export interface FileChange {
  /** The basename. The full path is already the row's title. */
  file: string;
  removed: string[];
  added: string[];
  /** True when the payload was too large to carry whole. */
  truncated: boolean;
}

/** Enough to read a change; far short of what a big refactor would send. */
const DIFF_MAX_LINES = 40;

export function fileChange(input: unknown): FileChange | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const path = typeof record.file_path === "string" ? record.file_path : "";
  if (!path) return null;

  const asLines = (value: unknown): string[] =>
    typeof value === "string" && value.length ? value.split("\n") : [];

  // A Write has no old side: the whole file is the addition.
  const removed = asLines(record.old_string);
  const added = asLines(record.new_string ?? record.content);
  if (!removed.length && !added.length) return null;

  // Trim the common head and tail. An edit usually restates several unchanged
  // lines on both sides to anchor itself, and showing those as both removed
  // and added is noise that hides the one line that moved.
  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
  let tail = 0;
  while (
    tail < removed.length - head
    && tail < added.length - head
    && removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  ) tail++;

  const trimmedRemoved = removed.slice(head, removed.length - tail);
  const trimmedAdded = added.slice(head, added.length - tail);
  const truncated = trimmedRemoved.length > DIFF_MAX_LINES
    || trimmedAdded.length > DIFF_MAX_LINES;

  return {
    file: path.split("/").pop() || path,
    removed: trimmedRemoved.slice(0, DIFF_MAX_LINES),
    added: trimmedAdded.slice(0, DIFF_MAX_LINES),
    truncated,
  };
}

/** One line of a plan, in the only two states that matter to a reader. */
export interface PlanStep {
  text: string;
  status: "pending" | "running" | "done";
}

const PLAN_STEP = /["']?step["']?\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*["']?status["']?\s*:\s*"([^"]*)"/g;

function planStatus(raw: unknown): PlanStep["status"] {
  const value = String(raw ?? "").toLowerCase();
  if (value === "completed" || value === "done") return "done";
  if (value === "in_progress" || value === "inprogress" || value === "running") return "running";
  return "pending";
}

/**
 * The steps of a plan, from either agent's way of writing one down.
 *
 * Claude sends `TodoWrite` with a `todos` array of objects; Codex sends a line
 * of JavaScript with the plan inline, and its object keys are sometimes quoted
 * and sometimes not. Extracting the pairs with a pattern rather than parsing
 * the argument as JSON is what survives both spellings.
 *
 * Agents emit these constantly. Rendered as a generic tool row they were pure
 * noise; rendered as a checklist they are the single most useful thing on
 * screen for "what is it actually doing".
 */
export function planSteps(input: unknown): PlanStep[] {
  if (input && typeof input === "object") {
    const todos = (input as any).todos ?? (input as any).plan;
    if (Array.isArray(todos)) {
      return todos
        .map((entry: any) => ({
          text: String(entry?.content ?? entry?.step ?? entry?.text ?? "").trim(),
          status: planStatus(entry?.status),
        }))
        .filter((step) => step.text);
    }
  }
  if (typeof input === "string" && input.includes("update_plan")) {
    const steps: PlanStep[] = [];
    PLAN_STEP.lastIndex = 0;
    for (let match = PLAN_STEP.exec(input); match; match = PLAN_STEP.exec(input)) {
      const text = match[1]!.replace(/\\(["'\\])/g, "$1").trim();
      if (text) steps.push({ text, status: planStatus(match[2]) });
    }
    return steps;
  }
  return [];
}

export function toolDisplayName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!mcp) return name;
  // Server names arrive with plumbing on both ends: a `plugin_`/`claude_`
  // prefix, and the plugin's own name repeated inside the server's
  // (`plugin_figma_figma`). Strip the prefix and collapse the repeat, or the
  // label reads "figma-figma".
  const segments = mcp[1]!.split(/[-_]/).filter((part) => part && part !== "plugin");
  const deduped = segments.filter((part, index) => part !== segments[index - 1]);
  const server = (deduped.length > 1 && deduped[0] === "claude" ? deduped.slice(1) : deduped)
    .join("-");
  return server ? `${server} · ${mcp[2]!}` : mcp[2]!;
}

/** Undo one level of source-string escaping, for a command lifted out of code. */
function unescapeInner(text: string): string {
  return text.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
}

/** A one-line gist of a tool's arguments — the row's title, not its payload. */
export function summariseToolInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") {
    // Codex's dominant tool takes a JavaScript snippet, so the raw first line
    // is the wrapper rather than the work: every shell row in a real rollout
    // read `const r = await tools.exec_command({cmd:"rg -n …`. Lift the command
    // out so the row says what actually ran.
    // `(?:\\.|(?!\1)[\s\S])*` rather than a lazy `[\s\S]*?`: a lazy match stops
    // at the first ESCAPED quote, so `cmd: "grep -n \"needle\" file"` was
    // truncated to `grep -n \"`. Escapes have to be consumed as units.
    const embedded = /exec_command\(\s*\{\s*cmd\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/.exec(input);
    if (embedded?.[2]) return unescapeInner(embedded[2]).split("\n")[0]!.slice(0, 160);
    return input.split("\n")[0]!.slice(0, 160);
  }
  if (typeof input !== "object") return String(input);
  const record = input as Record<string, unknown>;
  // The argument a human would recognise, in the order they would look for it.
  //
  // `description` leads deliberately: a tool that supplies one has already
  // written the human-facing label. Taking `command` first made every shell row
  // in a real transcript read "cd ~/conch" — the first line of the script, not
  // what it was for.
  for (const key of ["description", "cmd", "command", "file_path", "path", "pattern", "query", "url"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.split("\n")[0]!.slice(0, 160);
    }
  }
  // Nothing recognised: take the first short string argument rather than
  // nothing. Every MCP tool names its arguments differently, so the known-key
  // list can never be complete — on a real transcript this left rows for
  // `mcp__claude-in-chrome__computer` and `SendUserFile` with a bare tool name
  // and no indication of what they did. Long values are skipped because they
  // are payloads, not labels.
  for (const value of Object.values(record)) {
    if (typeof value !== "string") continue;
    const line = value.split("\n")[0]!.trim();
    if (line && line.length <= 160) return line;
  }
  return "";
}

/**
 * Fold one Codex rollout line into the conversation.
 *
 * Codex says the same things in a different vocabulary: `response_item` carries
 * agent_message / reasoning / function_call / custom_tool_call and their
 * outputs, where Claude uses content parts on a message.
 */
/**
 * One id for one thing Codex said, wherever it says it.
 *
 * A rollout records the same message twice: once as `response_item:message`
 * and again as `event_msg:agent_message`. Keying those on their position in
 * the file gave them two different ids, so every Codex reply and every one of
 * Tyler's own messages rendered TWICE in the stack — visible on screen as the
 * same paragraph repeated back to back.
 *
 * Deriving the id from the text collapses the mirror without having to pick a
 * winning stream, which matters because neither stream is complete: some turns
 * carry `message` and no `agent_message`, and the index counted more replies in
 * the event stream than the response stream. Reading both and de-duplicating
 * gets every message exactly once.
 *
 * The tradeoff is that two identical messages in one session become one row.
 * Sending the same words twice is rare; seeing everything twice was constant.
 */
function codexMessageId(kind: string, text: string): string {
  // Trimmed, because the two streams are not byte-identical: the response item
  // carries a trailing newline the event does not. Hashing raw text left every
  // message still doubled, differing only in that one character.
  const normalized = text.trim();
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${kind}:${hash.toString(36)}`;
}

export function reduceCodexLine(conversation: Conversation, entry: any): void {
  if (!entry || typeof entry !== "object") return;
  const at = Date.parse(entry.timestamp ?? "") || undefined;
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return;
  const ordinal = entry.ordinal ?? conversation.order.length;

  if (entry.type === "event_msg") {
    // Codex says the same thing in three places. The index counted 286
    // `event_msg:agent_message` against 165 `response_item:agent_message`, so
    // the stream this did NOT read carried more replies than the one it did.
    if (
      payload.type === "agent_message"
      && payload.phase !== "commentary"
      && typeof payload.message === "string"
      && payload.message.trim()
    ) {
      upsertConversationItem(conversation, {
        id: codexMessageId("assistant", payload.message),
        kind: "assistant",
        text: payload.message,
        at,
      });
      return;
    }
    if (payload.type === "user_message" && typeof payload.message === "string") {
      upsertConversationItem(conversation, {
        id: codexMessageId("user", payload.message),
        kind: "user",
        text: payload.message,
        at,
      });
    }
    return;
  }
  if (entry.type !== "response_item") return;

  const id = typeof payload.id === "string" ? payload.id : String(ordinal);
  switch (payload.type) {
    case "agent_message": {
      const text = typeof payload.text === "string"
        ? payload.text
        : Array.isArray(payload.content)
          ? payload.content.map((part: any) => part?.text ?? "").join("")
          : "";
      if (text) {
        upsertConversationItem(conversation, {
          id: codexMessageId("assistant", text),
          kind: "assistant",
          text,
          at,
        });
      }
      return;
    }
    // The one that carries what Codex actually SAID. Sampled on a live rollout,
    // a Codex turn contains `message` items and often no `agent_message` at all
    // — so ignoring this type left a session rendering as nothing but a string
    // of tool calls, which is exactly what Tyler saw.
    case "message": {
      const role = payload.role === "user" ? "user" : "assistant";
      const text = Array.isArray(payload.content)
        ? payload.content
          .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim()
        : typeof payload.text === "string"
          ? payload.text
          : "";
      if (text) {
        upsertConversationItem(conversation, {
          id: codexMessageId(role, text),
          kind: role,
          text,
          at,
        });
      }
      return;
    }
    case "reasoning": {
      // `summary` is usually EMPTY and the real content sits in
      // `encrypted_content`, which is exactly what it sounds like. Emitting a
      // blank thinking row for every one of those is noise, so only a reasoning
      // item that actually carries readable text becomes a row.
      const text = typeof payload.text === "string"
        ? payload.text
        : Array.isArray(payload.summary)
          ? payload.summary
            .map((part: any) => (typeof part === "string" ? part : part?.text ?? ""))
            .join("\n")
            .trim()
          : "";
      if (text) upsertConversationItem(conversation, { id, kind: "thinking", text, at });
      return;
    }
    case "function_call":
    case "custom_tool_call": {
      const callId = typeof payload.call_id === "string" ? payload.call_id : id;
      // The RAW argument, not the parsed one: Codex's is a line of JavaScript
      // whose text is what identifies the operation and carries the plan.
      const raw = payload.arguments ?? payload.input;
      const steps = planSteps(raw);
      upsertConversationItem(conversation, {
        id: `tool:${callId}`,
        kind: "tool",
        text: summariseToolInput(parseMaybeJson(raw)),
        at,
        tool: {
          name: toolDisplayName(String(payload.name ?? "tool")),
          kind: toolKind(String(payload.name ?? ""), raw),
          status: "running",
        },
        ...(steps.length ? { plan: steps } : {}),
      });
      return;
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = typeof payload.call_id === "string" ? payload.call_id : id;
      const target = conversation.items[`tool:${callId}`];
      if (!target?.tool) return;
      const output = typeof payload.output === "string"
        ? payload.output
        : typeof payload.output?.content === "string"
          ? payload.output.content
          : "";
      upsertConversationItem(conversation, {
        ...target,
        tool: {
          ...target.tool,
          status: payload.output?.success === false ? "error" : "done",
          result: output,
        },
      });
      return;
    }
    default:
      return;
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Fold a whole transcript's lines, in order, into a conversation. */
export function buildConversation(
  sessionId: string,
  lines: readonly string[],
  format: ConversationFormat,
): Conversation {
  const conversation = emptyConversation(sessionId);
  const reduce = format === "codex" ? reduceCodexLine : reduceClaudeLine;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      reduce(conversation, JSON.parse(trimmed));
    } catch {
      // A torn or half-written final line is normal on a live transcript.
    }
  }
  return conversation;
}

/** The newest `count` items — what a bottom-anchored view actually shows. */
export function conversationWindow(
  conversation: Conversation,
  count: number,
): ConversationItem[] {
  return conversation.order
    .slice(Math.max(0, conversation.order.length - count))
    .map((id) => conversation.items[id])
    .filter((item): item is ConversationItem => item !== undefined);
}

/**
 * Read the end of a transcript as a conversation.
 *
 * Only the tail, always. Claude transcripts run to megabytes and Codex rollouts
 * reach 732 MB (openai/codex#24948); this is called on every render, so reading
 * a whole file was never an option. A window of items is all any viewer shows,
 * and the tail is where they are.
 *
 * A tail read starts mid-line, so the first fragment is dropped — it is not
 * valid JSON, and a half-entry would parse as a different shape if it parsed at
 * all. The cost is losing at most one item at the far edge of the window.
 */
export async function readConversationTail(
  transcriptPath: string,
  sessionId: string,
  format: ConversationFormat,
  tailBytes = 512 * 1024,
): Promise<Conversation> {
  const file = Bun.file(transcriptPath);
  let size = 0;
  try {
    size = file.size;
  } catch {
    return emptyConversation(sessionId);
  }
  if (!size) return emptyConversation(sessionId);
  const start = Math.max(0, size - tailBytes);
  let text: string;
  try {
    text = await file.slice(start).text();
  } catch {
    return emptyConversation(sessionId);
  }
  const lines = text.split("\n");
  if (start > 0) lines.shift();
  return buildConversation(sessionId, lines, format);
}

/** A conversation trimmed to what is worth putting on a wire. */
export interface PublishedConversation {
  sessionId: string;
  items: ConversationItem[];
  /** True when older items exist above the window, so a viewer can say so. */
  truncated: boolean;
}

const DEFAULT_WINDOW = 40;
const DEFAULT_ITEM_CHARS = 4_000;
/** Tool rows are titles; their output belongs behind a tap, not in every frame. */
const DEFAULT_TOOL_RESULT_CHARS = 400;
/** Messages always carried, even when tool calls have pushed them out of the window. */
const MIN_SPOKEN_ITEMS = 6;

/**
 * Bound a conversation for publishing.
 *
 * Two independent caps, because they fail differently. The WINDOW bounds how
 * many items ride along — without it, a long session's every render would push
 * the whole history over a metered phone relay. The per-item cap bounds a single
 * enormous item, which one pasted file or one `cat` of a large file produces on
 * its own regardless of how few items there are.
 */
export function publishedConversation(
  conversation: Conversation,
  options: {
    windowSize?: number;
    itemChars?: number;
    toolResultChars?: number;
  } = {},
): PublishedConversation {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW;
  const itemChars = options.itemChars ?? DEFAULT_ITEM_CHARS;
  const toolResultChars = options.toolResultChars ?? DEFAULT_TOOL_RESULT_CHARS;
  // Guarantee the window contains what was SAID, not only what was done.
  //
  // A plain "last N items" window is wrong for an agent mid-task: one Codex
  // session ran a Playwright loop that filled the entire window with tool
  // calls, so the pane showed a wall of commands and none of the replies —
  // Tyler: "i just see a string of tools calls on them". The newest few
  // messages are pulled in even when they have scrolled past N, so a session
  // always shows its conversation and its work, not just its work.
  const recent = conversationWindow(conversation, windowSize);
  const inWindow = new Set(recent.map((item) => item.id));
  const spoken = conversation.order
    .map((id) => conversation.items[id])
    .filter((item): item is ConversationItem =>
      item !== undefined && (item.kind === "assistant" || item.kind === "user")
    )
    .slice(-MIN_SPOKEN_ITEMS)
    .filter((item) => !inWindow.has(item.id));
  const ordered = conversation.order
    .filter((id) => inWindow.has(id) || spoken.some((item) => item.id === id))
    .map((id) => conversation.items[id]!)
    .filter(Boolean);
  const items = ordered.map((item) => {
    // Keep the TAIL of a long message: the end is what was just said, and the
    // beginning is what has already scrolled past. Say so, though — an
    // unmarked cut lands mid-word and reads as a rendering bug rather than a
    // trim ("Serene digital vault…" arrived on screen as "erene digital").
    const text = item.text.length > itemChars
      ? `…${item.text.slice(item.text.length - itemChars)}`
      : item.text;
    const result = item.tool?.result;
    return {
      ...item,
      text,
      ...(item.tool
        ? {
          tool: {
            ...item.tool,
            ...(result && result.length > toolResultChars
              ? { result: result.slice(0, toolResultChars) }
              : {}),
          },
        }
        : {}),
    };
  });
  return {
    sessionId: conversation.sessionId,
    items,
    truncated: conversation.order.length > items.length,
  };
}

export interface ConversationDelta {
  sessionId: string;
  /** The full key stack for the published window: cheap, and it encodes order. */
  order: string[];
  /** Only the items whose revision moved since the peer's last known state. */
  changed: ConversationItem[];
}

/**
 * What to send a viewer that already knows `known`.
 *
 * Re-sending every item on every render is the same "replace wholesale" mistake
 * one level up, and over the phone relay it is the one that would be felt.
 */
export function conversationDelta(
  conversation: Conversation,
  known: Readonly<Record<string, number>>,
  windowSize: number,
): ConversationDelta {
  const items = conversationWindow(conversation, windowSize);
  return {
    sessionId: conversation.sessionId,
    order: items.map((item) => item.id),
    changed: items.filter((item) => known[item.id] !== item.rev),
  };
}

/** Apply a delta to a viewer's copy. Mirrors what each app will do natively. */
export function applyConversationDelta(
  conversation: Conversation,
  delta: ConversationDelta,
): Conversation {
  const items = { ...conversation.items };
  for (const item of delta.changed) items[item.id] = item;
  // Drop anything no longer referenced, so a long session cannot grow forever.
  const order = delta.order;
  const kept: Record<string, ConversationItem> = {};
  for (const id of order) if (items[id]) kept[id] = items[id]!;
  return { sessionId: delta.sessionId, order, items: kept };
}

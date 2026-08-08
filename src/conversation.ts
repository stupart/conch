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
    const text = typeof entry.message?.content === "string"
      ? entry.message.content
      : textFromClaudeParts(parts, "text");
    if (!text) return;
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
    upsertConversationItem(conversation, {
      id: `tool:${callId}`,
      kind: "tool",
      text: summariseToolInput(call.input),
      at,
      tool: { name: String(call.name ?? "tool"), status: "running" },
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
export function reduceCodexLine(conversation: Conversation, entry: any): void {
  if (!entry || typeof entry !== "object") return;
  const at = Date.parse(entry.timestamp ?? "") || undefined;
  const payload = entry.payload;
  if (!payload || typeof payload !== "object") return;
  const ordinal = entry.ordinal ?? conversation.order.length;

  if (entry.type === "event_msg") {
    if (payload.type === "user_message" && typeof payload.message === "string") {
      upsertConversationItem(conversation, {
        id: `user:${ordinal}`,
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
        upsertConversationItem(conversation, { id, kind: "assistant", text, at });
      }
      return;
    }
    case "reasoning": {
      const text = typeof payload.text === "string"
        ? payload.text
        : Array.isArray(payload.summary)
          ? payload.summary.map((part: any) => part?.text ?? part ?? "").join("\n")
          : "";
      if (text) upsertConversationItem(conversation, { id, kind: "thinking", text, at });
      return;
    }
    case "function_call":
    case "custom_tool_call": {
      const callId = typeof payload.call_id === "string" ? payload.call_id : id;
      upsertConversationItem(conversation, {
        id: `tool:${callId}`,
        kind: "tool",
        text: summariseToolInput(parseMaybeJson(payload.arguments ?? payload.input)),
        at,
        tool: { name: String(payload.name ?? "tool"), status: "running" },
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
  const items = conversationWindow(conversation, windowSize).map((item) => {
    // Keep the TAIL of a long message: the end is what was just said, and the
    // beginning is what has already scrolled past.
    const text = item.text.length > itemChars
      ? item.text.slice(item.text.length - itemChars)
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

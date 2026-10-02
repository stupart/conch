/**
 * What a working session is doing right now, as one line under its name in both apps' sidebars (2026-10-03).
 *
 * Tyler: "Could also be cool to see an agent work live in the side bar." A working row was a blue dot and a name, so
 * the only way to see whether an agent was running its tests, editing a file or thinking aloud was to open it. Each
 * working row (and each live sub-agent) now carries `activity`: the step its agent is running, phrased the way a
 * person would say it ("Running the test suite", "Editing src/voice-loop.ts", "Reading 3 files"), else the newest
 * line of its running commentary from the last minute, else nothing. Idle, waiting and blocked rows carry none.
 *
 * Built from the conversation reader's own items (`readConversationTail`, `summariseToolInput`, `toolDisplayName`),
 * so a line never says more than the conversation already publishes to the phone: a command shows only when no
 * description named it, as the step row in the conversation does.
 *
 * Cost: one `stat` per working row per render, and a bounded tail read (256 KB, 1 MB when that holds nothing whole)
 * only when the transcript's size or mtime moved. Measured on 14 live transcripts (2.1-327 MB, Claude and Codex,
 * 2026-10-03): a read and parse took 0.9 ms median and 2.9 ms at worst, and a render that found nothing new cost about
 * 1 µs a row. The line changes at most once a second per row
 * (`ActivityThrottle`), so a burst of parallel tool calls can't make the state churn, and the published state is
 * patched from what is cached (`withLiveActivity`) rather than by another registry scan.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, sep } from "node:path";
import {
  readConversationTail,
  type Conversation,
  type ConversationFormat,
  type ConversationItem,
  type WindowIdentity,
} from "./conversation.ts";
import type { PublishedSessionRow, PublishedState } from "./panel.ts";
import { splitSentences } from "./snippet.ts";

/** What a working row's second line says, on the wire as `rows[].activity`. */
export interface RowActivity {
  /** One line, at most `ACTIVITY_MAX_CHARS`, no markdown. */
  text: string;
  /** A step (running, or the turn's last), or the agent's own words between steps. */
  kind: "step" | "commentary";
  /** Epoch-ms the step started or the words were written. */
  at: number;
}

/** A sidebar's second line at a sidebar's width: anything longer is cut on a word, with an ellipsis. */
export const ACTIVITY_MAX_CHARS = 90;
/** A row's line changes at most this often. */
export const ACTIVITY_MIN_INTERVAL_MS = 1_000;
/**
 * How much of a transcript's end is read. Measured on Tyler's live transcripts (2026-10-03): the last 40 entries
 * took 47-252 KB in 12 of 14, and single lines run to 1.3 MB (a screenshot read back). A running step and the newest
 * words are within the last few entries, so the deep read is only for a tail one image line swallowed.
 */
export const ACTIVITY_TAIL_BYTES = 256 * 1024;
export const ACTIVITY_DEEP_TAIL_BYTES = 1024 * 1024;

/** `text` as one line of at most `max` characters, cut on a word near the end when it can be. */
export function oneLine(text: string, max = ACTIVITY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > cut.length * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** Markdown as the lines of words it shows: no fences, markers, emphasis or link syntax. Paths and URLs stay as written. */
export function plainLines(markdown: string): string[] {
  const kept: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|~~|`/g, "")
      // Single-star emphasis only. Underscores are left alone: `snake_case` names are words here, not markup.
      .replace(/(^|[\s(])\*(\S(?:[^*]*\S)?)\*(?=$|[\s).,;:!?])/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim();
    if (plain) kept.push(plain);
  }
  return kept;
}

/**
 * The sentence of a block of commentary that says what comes next: its last with three words or more. Each line is
 * its own run of sentences, so a heading or a list item never runs into the next one.
 */
export function commentaryLine(markdown: string): string {
  const sentences = plainLines(markdown)
    .flatMap((line) => splitSentences(line))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const said = [...sentences].reverse().find((sentence) => sentence.split(" ").length >= 3) ?? sentences.at(-1) ?? "";
  return oneLine(said);
}

/**
 * A path as a sidebar line can hold it: relative to the folder the agent works in when it is inside one (the deepest
 * that holds it), `~` for home, and its last two parts when still long.
 */
export function displayPath(raw: string, places: readonly string[] = [], home: string = homedir()): string {
  const path = raw.trim();
  let shown = path;
  if (isAbsolute(path)) {
    const within = places
      .filter((folder) => folder && isAbsolute(folder))
      .sort((a, b) => b.length - a.length)
      .find((folder) => path.startsWith(folder.endsWith(sep) ? folder : folder + sep));
    if (within) shown = relative(within, path);
    else if (home && path.startsWith(home + sep)) shown = `~${path.slice(home.length)}`;
  }
  if (shown.length <= 48) return shown;
  const parts = shown.split("/").filter(Boolean);
  // Its folder only when the folder says something: a temp dir's `T/` or `tmp/` is noise beside the name.
  const tail = parts.slice(-2).join("/");
  const folder = parts.at(-2) ?? "";
  return tail.length <= 48 && folder.length > 3 ? tail : (parts.at(-1) ?? basename(shown));
}

/**
 * Imperative verbs a Bash description starts with, and so can be said as what is happening: "Run the test suite" is
 * "Running the test suite". An allowlist, so "Git status" is never "Gitting status".
 */
const VERBS = new Set(
  ("add analyse analyze apply archive audit benchmark boot build bump cache call capture check checkout clean clear "
    + "clone close collect commit compare compile compress compute configure confirm convert copy count create crop "
    + "debug decode delete deploy describe detect determine diff disable download drop dump edit emit enable encode "
    + "ensure estimate examine explore export extract fetch fill filter find fix flip format gather generate get grab "
    + "grep group hash identify import index inspect install investigate kill launch lint link list load locate log look "
    + "make map mark match measure merge migrate mount move notarize open package parse patch pin ping plan plot poll "
    + "post prepare preview print probe profile prune publish pull push query read rebase rebuild record redo refresh "
    + "regenerate reinstall reload remove rename render reorder repair replace replay reproduce request rerun reset resize "
    + "resolve restart restore retry review revert rewrite run sample save scan scrape search seed send serve set ship "
    + "show sign simulate skip snapshot sort split stage start stash stop strip stub submit summarise summarize swap "
    + "symlink sync tag tail take test tidy tile time touch trace track train transcode transcribe translate trigger trim "
    + "try type uninstall unpack unpin unstage unzip update upgrade upload use validate verify view wait walk watch wipe "
    + "wire write zip").split(" "),
);
/** The ones whose last consonant doubles: running, not runing. */
const DOUBLED = new Set(
  "commit debug drop emit flip grab grep log map pin plan plot rerun reset run scan set ship skip split stop strip stub submit swap tag trim unpin unzip zip"
    .split(" "),
);

/** "Run" as "Running", or null when `word` is not a verb this knows. Keeps the first letter's case. */
export function gerund(word: string): string | null {
  const hyphen = word.lastIndexOf("-");
  if (hyphen > 0) {
    const tail = gerund(word.slice(hyphen + 1));
    return tail ? `${word.slice(0, hyphen + 1)}${tail.toLowerCase()}` : null;
  }
  const lower = word.toLowerCase();
  if (!VERBS.has(lower)) return null;
  const inflected = DOUBLED.has(lower)
    ? `${lower}${lower.at(-1)}ing`
    : lower.endsWith("ie")
      ? `${lower.slice(0, -2)}ying`
      : lower.endsWith("e") && !/[eoy]e$/.test(lower)
        ? `${lower.slice(0, -1)}ing`
        : `${lower}ing`;
  return word[0] === word[0]!.toUpperCase() ? inflected[0]!.toUpperCase() + inflected.slice(1) : inflected;
}

/**
 * The words of a command's first segment, quotes removed, and whether that segment is the whole command: no pipe,
 * `;`, `&&` or redirect outside quotes. Enough to find a program, its flags and its files; not a shell parser.
 */
export function shellWords(line: string): { words: string[]; whole: boolean } {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) word += line[++index];
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      word += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else if ("|;&<>".includes(char)) {
      if (started) words.push(word);
      return { words, whole: false };
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return { words, whole: true };
}

/** rg and grep flags that take the next word as their value, so it is not mistaken for the pattern. */
const SEARCH_VALUE_FLAGS = new Set(["-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count", "-f", "--file"]);

/**
 * A raw shell command as what it does, for the commands an agent runs most: reading a file (`cat`, `sed -n`, `head`),
 * searching (`rg`, `grep`), writing a file from a heredoc. Anything else is "Running" and the command, with a leading
 * `cd … &&` and a heredoc's `<<'PY'` left off: Codex names no description, so its step rows show the command too.
 */
export function shellPhrase(command: string, places: readonly string[] = []): string {
  let line = command.replace(/\s+/g, " ").trim();
  const cd = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;
  for (let match = cd.exec(line); match; match = cd.exec(line)) line = line.slice(match[0].length);
  // Codex's `exec` running JavaScript that is not a shell command at all.
  if (/^(?:const|let|var|await|return|text\()\b/.test(line)) return "Running a script";
  const written = /^(?:cat\s*>>?|tee\s+(?:-a\s+)?)\s*(['"]?)([^\s'"<>|;&]+)\1\s*<</.exec(line);
  if (written) return `Writing ${displayPath(written[2]!, places)}`;
  const heredoc = /\s*<<-?\s*['"]?\w+['"]?\s*$/.exec(line);
  if (heredoc) line = line.slice(0, heredoc.index);
  // A program named by its whole path is named by its name: `…/node/22/bin/node --test` is `node --test`.
  line = line.replace(/^(?:~|\.{0,2})?\/(?:[^\s/]+\/)*([^\s/]+)(?=\s|$)/, "$1");
  const { words, whole } = shellWords(line);
  const [program = "", ...args] = words;
  const name = basename(program);
  const operands = args.filter((arg) => !arg.startsWith("-"));
  if (heredoc && operands.length === 0) return `Running a ${name} script`;
  if (whole && ["cat", "head", "tail", "less", "nl", "bat"].includes(name) && operands.length === 1) {
    return `Reading ${displayPath(operands[0]!, places)}`;
  }
  if (whole && name === "sed" && args.includes("-n") && operands.length === 2) {
    return `Reading ${displayPath(operands[1]!, places)}`;
  }
  if (name === "rg" || name === "grep") {
    if (args.includes("--files")) return "Listing files";
    let pattern: string | undefined;
    for (let index = 0; index < args.length && pattern === undefined; index += 1) {
      const arg = args[index]!;
      if (arg === "-e" || arg === "--regexp") pattern = args[index + 1];
      else if (SEARCH_VALUE_FLAGS.has(arg)) index += 1;
      else if (!arg.startsWith("-")) pattern = arg;
    }
    if (pattern) return `Searching for “${pattern}”`;
  }
  return `Running ${line}`;
}

/** Whether a command step's text is a description a person wrote rather than the command itself. */
function isDescription(text: string): boolean {
  return /^[A-Z]/.test(text) && /\s/.test(text) && !/[|;&$<>`=\\]/.test(text) && !/^\S*\//.test(text);
}

/**
 * A description an agent wrote ("Run the test suite") said as what is happening ("Running the test suite"), or null
 * when it does not start with a verb this knows. The rest of a list of steps reads the same way: "Commit, push and
 * open the PR" is "Committing, pushing and opening the PR" — only words known as verbs, after a comma, "and" or "then".
 */
export function saidAsDoing(text: string): string | null {
  const verb = /^([A-Za-z]+(?:-[A-Za-z]+)?)\b(.*)$/s.exec(text.trim());
  if (!verb || !/^[A-Z]/.test(verb[1]!)) return null;
  const said = gerund(verb[1]!);
  if (!said) return null;
  return `${said}${verb[2]!.replace(/(,\s*(?:and\s+|then\s+)?|\s+(?:and|then)\s+)([a-z]+)\b/g,
    (whole, joint: string, word: string) => {
      const next = gerund(word);
      return next ? `${joint}${next}` : whole;
    })}`;
}

/** A command step: its description said as what is happening, else what the command does. */
export function commandPhrase(text: string, places: readonly string[] = []): string {
  const line = text.trim();
  if (!line) return "Running a command";
  return saidAsDoing(line) ?? (isDescription(line) ? line : shellPhrase(line, places));
}

const looksLikePath = (text: string): boolean => /^(~|\.{1,2}\/|\/)/.test(text) || (!/\s/.test(text) && /[/.]/.test(text));
/** Code where a label would be: a Codex `js` call, an MCP tool handed a script. */
const looksLikeCode = (text: string): boolean => /[;{}]|\bawait\b|=>/.test(text);

/** A running step as a person would say it. */
export function stepPhrase(item: ConversationItem, places: readonly string[] = []): string {
  const tool = item.tool;
  const name = tool?.name ?? "tool";
  const wire = (tool?.wireName ?? name).toLowerCase();
  const text = item.text.replace(/\s+/g, " ").trim();
  switch (tool?.kind) {
    case "file_read":
      return text ? `Reading ${looksLikePath(text) ? displayPath(text, places) : text}` : "Reading a file";
    case "file_change": {
      const path = item.change?.path ?? (looksLikePath(text) ? text : undefined);
      const verb = wire === "write" ? "Writing" : "Editing";
      return path ? `${verb} ${displayPath(path, places)}` : "Editing files";
    }
    case "search":
      if (wire === "glob") return text ? `Finding ${text}` : "Finding files";
      if (wire === "ls" || wire === "list_dir") return text ? `Listing ${displayPath(text, places)}` : "Listing files";
      return text ? `Searching for “${text}”` : "Searching";
    case "web_search":
      if (/^https?:\/\//i.test(text)) {
        try {
          return `Reading ${new URL(text).hostname.replace(/^www\./, "")}`;
        } catch {
          return "Reading a web page";
        }
      }
      return text ? `Searching the web for “${text}”` : "Searching the web";
    case "command_execution":
      return commandPhrase(text, places);
    case "subagent":
      // Codex polling a command it started (`write_stdin` with nothing to type) is waiting on it, not an agent.
      if (wire === "write_stdin" || /\bwrite_stdin\b/.test(text)) {
        return /\bchars\s*:\s*(""|'')/.test(text) || !/\bchars\b/.test(text)
          ? "Waiting on a running command"
          : "Typing into a running command";
      }
      // Codex's `exec` wrapper filed here whose command was lifted out is that command.
      if (wire === "exec" && text && !looksLikeCode(text)) return commandPhrase(text, places);
      return text && !looksLikeCode(text) ? `Running an agent: ${text}` : "Running an agent";
    case "plan":
      return "Updating the plan";
    default: {
      const named = NAMED_STEPS[wire.replace(/[^a-z]/g, "")];
      if (named) return named(text);
      if (!text || looksLikeCode(text)) return `Using ${name}`;
      // A tool handed a description of its own (Codex's `js` calls carry one) is said like a command's, or as written:
      // "js: Recover and inspect the credential visibility state safely" named a tool where the words said the work.
      return saidAsDoing(text) ?? `${text[0]!.toUpperCase()}${text.slice(1)}`;
    }
  }
}

/** The agents' own housekeeping tools, said as what they are for rather than by their wire names. */
const NAMED_STEPS: Record<string, (text: string) => string> = {
  toolsearch: () => "Loading tools",
  skill: (text) => (text ? `Using the ${text} skill` : "Using a skill"),
  sendmessage: () => "Messaging an agent",
  // Claude Code's Monitor waits on something running in the background; its description says what.
  monitor: (text) => saidAsDoing(text) ?? (text ? `Watching ${text}` : "Watching a background task"),
};

/** Which steps say "N of them" together when several run at once. */
function stepGroup(item: ConversationItem): string {
  switch (item.tool?.kind) {
    case "file_read": return "read";
    case "file_change": return "edit";
    case "command_execution": return "command";
    case "search": return "search";
    case "web_search": return "web";
    case "subagent": return "agent";
    default: return `tool:${item.tool?.name ?? ""}`;
  }
}

function groupPhrase(group: string, count: number): string {
  switch (group) {
    case "read": return `Reading ${count} files`;
    case "edit": return `Editing ${count} files`;
    case "command": return `Running ${count} commands`;
    case "search": return `Running ${count} searches`;
    case "web": return `Running ${count} web lookups`;
    case "agent": return `Running ${count} agents`;
    default: return `Running ${count} steps`;
  }
}

/**
 * A step the agent is in the middle of. Not a question (the row is blocked on you, and says so), and not a background
 * agent: its block stays "running" for the agent's whole life (its result arrived at launch), while the session that
 * started it has moved on to other things. Its own row says what it is doing.
 */
function isLiveStep(item: ConversationItem): boolean {
  const tool = item.tool;
  if (item.kind !== "tool" || tool?.status !== "running" || tool.kind === "question") return false;
  return !(tool.kind === "subagent" && (tool.subagent || tool.result));
}

/** What a transcript says about now, with no clock in it: read once per change and kept. */
export interface ActivityFacts {
  /** The current turn's running steps, oldest first, each already phrased. */
  steps: Array<{ text: string; group: string; at?: number }>;
  /**
   * With no step running: the newest thing the current turn holds, its last step or its last words, whichever came
   * later. It stands until the turn moves on, however old: the row shows a line only while the session works.
   */
  latest?: { text: string; kind: "step" | "commentary"; at: number };
}

/**
 * The facts of the current turn: everything after the last thing you said. A step from an earlier turn whose result
 * never came (an interrupted turn) reads "running" for good, and is not what the agent is doing now. A message queued
 * while the agent worked (`queued:`) does not start a turn: the agent is still in the one it interrupted.
 */
export function activityFacts(conversation: Conversation, places: readonly string[] = []): ActivityFacts {
  const items = conversation.order
    .map((id) => conversation.items[id])
    .filter((item): item is ConversationItem => item !== undefined);
  let start = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if ((item.kind === "user" && !item.id.startsWith("queued:")) || item.material?.kind === "interruption") {
      start = index + 1;
      break;
    }
  }
  const turn = items.slice(start);
  const steps = turn.filter(isLiveStep).map((item) => ({
    text: stepPhrase(item, places),
    group: stepGroup(item),
    ...(item.at ? { at: item.at } : {}),
  }));
  // Newest first, the turn's last step or last words. On 2026-10-03 a busy Codex session showed no line at all: its
  // commands each finished inside a second, so none was ever caught running, and a 60-second limit on its last words
  // ("I'm fixing that limit and testing against the observed response…", three minutes old and still true) hid those.
  for (let index = turn.length - 1; index >= 0; index -= 1) {
    const item = turn[index]!;
    if (item.kind === "tool" && item.tool && item.tool.kind !== "question" && item.tool.kind !== "subagent") {
      const text = stepPhrase(item, places);
      if (text) return { steps, latest: { text, kind: "step", at: item.at ?? 0 } };
      continue;
    }
    if (item.kind !== "assistant" && item.kind !== "thinking") continue;
    const text = commentaryLine(item.text);
    if (text) return { steps, latest: { text, kind: "commentary", at: item.at ?? 0 } };
  }
  return { steps };
}

/**
 * The line a row shows: its running step (several of one kind as "Reading 3 files"), else the turn's newest step or
 * words (`ActivityFacts.latest`), else none. Nothing here expires on a clock; the turn moving on, or ending, changes it.
 */
export function activityAt(facts: ActivityFacts, now: number): { activity: RowActivity | null } {
  const newest = facts.steps.at(-1);
  if (newest) {
    const together = facts.steps.length > 1 && facts.steps.every((step) => step.group === newest.group);
    const text = together ? groupPhrase(newest.group, facts.steps.length) : newest.text;
    return { activity: { text: oneLine(text), kind: "step", at: newest.at ?? now } };
  }
  const latest = facts.latest;
  if (latest) return { activity: { text: oneLine(latest.text), kind: latest.kind, at: latest.at || now } };
  return { activity: null };
}

const sameLine = (a: RowActivity | null | undefined, b: RowActivity | null | undefined): boolean =>
  (a ?? null) === (b ?? null) || (!!a && !!b && a.text === b.text && a.kind === b.kind);

/**
 * At most one new line per row per interval. The first line a row shows goes out at once; a change inside the
 * interval waits for its end (`dueAt`), and only the newest waiting value is ever shown, so three files read in a
 * burst are never three frames. Going blank is a change like any other, so a step ending and the next starting a
 * moment later never flashes the row back to one line.
 */
export class ActivityThrottle {
  readonly #rows = new Map<string, { shown: RowActivity | null; changedAt: number }>();

  constructor(readonly minIntervalMs = ACTIVITY_MIN_INTERVAL_MS) {}

  settle(id: string, candidate: RowActivity | null, now: number): { shown: RowActivity | null; dueAt?: number } {
    const state = this.#rows.get(id);
    if (!state) {
      if (candidate) this.#rows.set(id, { shown: candidate, changedAt: now });
      return { shown: candidate };
    }
    if (sameLine(state.shown, candidate)) return { shown: state.shown };
    if (now - state.changedAt >= this.minIntervalMs) {
      state.shown = candidate;
      state.changedAt = now;
      return { shown: candidate };
    }
    return { shown: state.shown, dueAt: state.changedAt + this.minIntervalMs };
  }

  /** Forget every row but these: one that stopped working starts fresh when it works again. */
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.#rows.keys()) if (!ids.has(id)) this.#rows.delete(id);
  }
}

/** A working row's transcript, and what its paths are shown relative to. */
export interface ActivitySource {
  id: string;
  transcriptPath: string;
  format: ConversationFormat;
  /** The folders the agent works in, then where it started: a step's path is shown relative to the one holding it. */
  places?: readonly string[];
  /** One window of a shared transcript reads its own branch (A8), as the conversation does. */
  window?: WindowIdentity;
}

interface TranscriptVersion {
  size: number;
  mtimeMs: number;
  ino: number;
}

type ReadTail = (
  path: string,
  sessionId: string,
  format: ConversationFormat,
  window: WindowIdentity | undefined,
  tailBytes: number,
) => Promise<Conversation>;

const defaultReadTail: ReadTail = (path, sessionId, format, window, tailBytes) =>
  readConversationTail(path, sessionId, format, { window, tailBytes });

function defaultStat(path: string): TranscriptVersion | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
  } catch {
    return null;
  }
}

/**
 * Each working transcript's facts, read only when the file moved: keyed on its size, mtime and inode, so a render
 * with nothing new costs one `stat` per row. `reads` counts the tail reads, for the tests and the measurement.
 */
export class ActivityReader {
  readonly #cache = new Map<string, TranscriptVersion & { places: string; facts: ActivityFacts }>();
  readonly #readTail: ReadTail;
  readonly #stat: (path: string) => TranscriptVersion | null;
  readonly #tailBytes: number;
  readonly #deepTailBytes: number;
  reads = 0;

  constructor(options: {
    readTail?: ReadTail;
    stat?: (path: string) => TranscriptVersion | null;
    tailBytes?: number;
    deepTailBytes?: number;
  } = {}) {
    this.#readTail = options.readTail ?? defaultReadTail;
    this.#stat = options.stat ?? defaultStat;
    this.#tailBytes = options.tailBytes ?? ACTIVITY_TAIL_BYTES;
    this.#deepTailBytes = Math.max(this.#tailBytes, options.deepTailBytes ?? ACTIVITY_DEEP_TAIL_BYTES);
  }

  static key(source: Pick<ActivitySource, "id" | "transcriptPath">): string {
    return `${source.id}\u0000${source.transcriptPath}`;
  }

  async facts(source: ActivitySource): Promise<ActivityFacts | null> {
    const version = this.#stat(source.transcriptPath);
    if (!version) return null;
    const key = ActivityReader.key(source);
    const places = (source.places ?? []).join("\u0000");
    const cached = this.#cache.get(key);
    if (cached && cached.size === version.size && cached.mtimeMs === version.mtimeMs
      && cached.ino === version.ino && cached.places === places) {
      return cached.facts;
    }
    this.reads += 1;
    let conversation = await this.#readTail(source.transcriptPath, source.id, source.format, source.window, this.#tailBytes);
    // One line longer than the tail (a screenshot read back) leaves nothing whole to read: look once, deeper.
    if (conversation.order.length === 0 && version.size > this.#tailBytes && this.#deepTailBytes > this.#tailBytes) {
      conversation = await this.#readTail(source.transcriptPath, source.id, source.format, source.window, this.#deepTailBytes);
    }
    const facts = activityFacts(conversation, source.places ?? []);
    this.#cache.set(key, { ...version, places, facts });
    return facts;
  }

  /** Forget every transcript but these. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.#cache.keys()) if (!keys.has(key)) this.#cache.delete(key);
  }
}

/** The daemon's whole activity state: what each working row's transcript says, and what each row is showing. */
export class LiveActivity {
  readonly reader: ActivityReader;
  readonly throttle: ActivityThrottle;
  #facts = new Map<string, ActivityFacts>();

  constructor(options: { reader?: ActivityReader; throttle?: ActivityThrottle } = {}) {
    this.reader = options.reader ?? new ActivityReader();
    this.throttle = options.throttle ?? new ActivityThrottle();
  }

  /** Read what changed for every working row; a row not among them has nothing to say. */
  async observe(sources: readonly ActivitySource[]): Promise<void> {
    const next = new Map<string, ActivityFacts>();
    await Promise.all(sources.map(async (source) => {
      const facts = await this.reader.facts(source).catch(() => null);
      if (facts) next.set(source.id, facts);
    }));
    this.#facts = next;
    this.reader.retain(new Set(sources.map((source) => ActivityReader.key(source))));
  }

  /**
   * What each of `ids` shows at `now`, through the throttle, and the earliest time any of them is due to change on
   * its own: a held line's interval ending.
   */
  select(ids: Iterable<string>, now: number): { activities: Map<string, RowActivity>; dueAt: number | null } {
    const activities = new Map<string, RowActivity>();
    const seen = new Set<string>();
    let dueAt: number | null = null;
    const due = (at: number | undefined) => {
      if (at !== undefined && at > now && (dueAt === null || at < dueAt)) dueAt = at;
    };
    for (const id of ids) {
      seen.add(id);
      const facts = this.#facts.get(id);
      const { activity } = facts ? activityAt(facts, now) : { activity: null };
      const settled = this.throttle.settle(id, activity, now);
      if (settled.shown) activities.set(id, settled.shown);
      due(settled.dueAt);
    }
    this.throttle.retain(seen);
    return { activities, dueAt };
  }
}

/** The rows that carry a line: working on their own turn. One whose own turn is over and only its agents run does not. */
export function activityRowIds(rows: readonly Pick<PublishedSessionRow, "id" | "status" | "waitingOnAgents">[]): string[] {
  return rows.filter((row) => row.status === "working" && !row.waitingOnAgents).map((row) => row.id);
}

const sameActivity = (a: RowActivity | undefined, b: RowActivity | undefined): boolean =>
  a === b || (!!a && !!b && a.text === b.text && a.kind === b.kind && a.at === b.at);

/**
 * `state` with each working row's `activity` as `live` shows it at `now`, and every other row's removed. `changed`
 * says whether any row's line moved, so a timer that finds nothing new writes nothing.
 */
export function withLiveActivity(
  state: PublishedState,
  live: LiveActivity,
  now: number,
): { state: PublishedState; changed: boolean; dueAt: number | null } {
  const { activities, dueAt } = live.select(activityRowIds(state.rows), now);
  let changed = false;
  const rows = state.rows.map((row) => {
    const next = activities.get(row.id);
    if (sameActivity(row.activity, next)) return row;
    changed = true;
    const { activity: _previous, ...rest } = row;
    return next ? { ...rest, activity: { ...next } } : rest;
  });
  return { state: changed ? { ...state, rows } : state, changed, dueAt };
}

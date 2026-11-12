import { isAbsolute, resolve } from "node:path";
import { AGENT_COMMANDS, AGENT_INSTRUCTIONS, renderAgentCommandHelp, renderAgentHelp, type AgentCommandText } from "./agent-instructions.ts";

/**
 * `conch agent …`'s words, to the arguments of the handler it runs, and its answer back to words.
 *
 * 2026-11-11, Tyler: "I would also like to add a cli cause I think it might be better to put all our stuff in for agents
 * to use without killing context and then the mcp can be more minimal?" The handlers are the MCP server's own
 * (mcp.ts `createMcpToolHandlers`): one implementation, two ways in. This module is only the words, and imports no part
 * of the server, so the server's `conch_run` (the same CLI, run through it) reads a command the way the shell does.
 *
 * What it answers is short on purpose: a line a field, a list a line an item, and `--json` for the whole answer, so an
 * agent pays for what it reads, not for pretty-printed JSON. 25 of the 47 open failure tickets were agents calling a tool
 * wrong; a mistake here says what was wrong and prints the command's usage with it.
 */

/** A command line conch_agent couldn't read: said with the command's usage, and counted as the agent's input error. */
export class AgentUsageError extends Error {
  constructor(message: string, readonly command?: AgentCommandText) {
    super(message);
    this.name = "AgentUsageError";
  }
}

type FlagKind = "value" | "bool" | "list";

/** A command line, read: its words, and its flags by kind. */
export interface ParsedFlags {
  words: string[];
  values: Map<string, string>;
  lists: Map<string, string[]>;
  bools: Set<string>;
}

/** Where a command's paths are resolved, and how a file is read for one that takes the contents of one. */
export interface BuildContext {
  /** The shell's folder: relative paths become absolute against it. Undefined leaves them for the handler to resolve. */
  cwd?: string;
  readFile?(path: string): string;
  readStdin?(): string;
}

interface CommandParser {
  flags: Readonly<Record<string, FlagKind>>;
  build(parsed: ParsedFlags, context: BuildContext, command: AgentCommandText): Record<string, unknown>;
}

/** A command the words name, with the arguments its handler takes, or help to print. */
export type AgentInvocation =
  | { kind: "run"; command: AgentCommandText; tool: string; args: Record<string, unknown>; json: boolean }
  | { kind: "help"; text: string };

const URL_LIKE = /^[a-z][a-z\d+.-]*:\/\//i;

const usage = (command: AgentCommandText) => `usage: conch agent ${command.usage}`;

function fail(command: AgentCommandText, message: string): never {
  throw new AgentUsageError(message, command);
}

/** A path as the handler should get it: absolute against the shell's folder, or as given. A URL stays a URL. */
function pathArg(value: string, context: BuildContext): string {
  if (!context.cwd || URL_LIKE.test(value) || isAbsolute(value) || value.startsWith("~")) return value;
  return resolve(context.cwd, value);
}

function words(parsed: ParsedFlags, command: AgentCommandText, min: number, max: number, what: string): string[] {
  if (parsed.words.length < min) fail(command, `${what} is missing`);
  if (parsed.words.length > max) {
    fail(command, `unexpected ${JSON.stringify(parsed.words[max])}: quote an argument that has spaces in it`);
  }
  return parsed.words;
}

/** Every word as one text, for an argument that is the rest of the line (a reason, a body). */
function rest(parsed: ParsedFlags, command: AgentCommandText, what: string): string {
  if (!parsed.words.length) fail(command, `${what} is missing`);
  return parsed.words.join(" ");
}

function integer(command: AgentCommandText, flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) fail(command, `--${flag} takes a whole number, not ${JSON.stringify(value)}`);
  return Number(value);
}

function number(command: AgentCommandText, flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed)) fail(command, `--${flag} takes a number, not ${JSON.stringify(value)}`);
  return parsed;
}

const defined = (entries: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

const noArguments: CommandParser = {
  flags: {},
  build: (parsed, _context, command) => {
    words(parsed, command, 0, 0, "");
    return {};
  },
};

const sessionOnly: CommandParser = {
  flags: {},
  build: (parsed) => (parsed.words.length ? { session: parsed.words.join(" ") } : {}),
};

/** A browser command's target: a bare word, or exactly one of the flags that say what kind of target it is. */
function browserTarget(parsed: ParsedFlags, command: AgentCommandText, bare: string | undefined, textFlag: string): unknown {
  const named = (["ref", "selector", textFlag] as const).filter((flag) => parsed.values.has(flag));
  if (named.length > 1) fail(command, `pass one of --ref, --selector or --${textFlag}, not ${named.map((flag) => `--${flag}`).join(" and ")}`);
  if (named.length && bare !== undefined) fail(command, `a target and --${named[0]} name two targets; pass one`);
  if (named.length) {
    const flag = named[0]!;
    return { [flag === textFlag ? "text" : flag]: parsed.values.get(flag) };
  }
  if (bare === undefined) fail(command, "the target is missing: a ref from browser read (e12), a CSS selector, or the words on it");
  return bare;
}

/** `--size 390x844`, as capture's viewport. */
function viewportOf(command: AgentCommandText, value: string | undefined): unknown {
  if (value === undefined) return undefined;
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value);
  if (!match) fail(command, `--size is WIDTHxHEIGHT in CSS pixels (390x844), not ${JSON.stringify(value)}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function jsonFlag(command: AgentCommandText, flag: string, value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return fail(command, `--${flag} takes JSON (${flag === "marks" ? `[{"id":"cta","kind":"box","frame":{"selector":".cta"}}]` : "an object"}), and that didn't parse`);
  }
}

/** The parsers, by command name. A test holds them to `AGENT_COMMANDS`: one each, and every flag a usage names. */
export const AGENT_COMMAND_PARSERS: Readonly<Record<string, CommandParser>> = {
  publish: {
    flags: { kind: "value", key: "value", focus: "list", scene: "value", inspect: "value", marks: "value", approve: "value" },
    build(parsed, context, command) {
      const [summary, link] = words(parsed, command, 1, 2, "the summary");
      const sceneKind = parsed.values.get("scene");
      const inspect = parsed.values.get("inspect");
      const marks = jsonFlag(command, "marks", parsed.values.get("marks"));
      const scene = sceneKind !== undefined || inspect !== undefined || marks !== undefined
        ? defined({ v: 1, target: { kind: sceneKind ?? "auto" }, inspect, marks })
        : undefined;
      const approve = parsed.values.get("approve");
      return defined({
        summary,
        link: link === undefined ? undefined : pathArg(link, context),
        kind: parsed.values.get("kind"),
        key: parsed.values.get("key"),
        focus: parsed.lists.get("focus"),
        scene,
        approval: approve === undefined ? undefined : approve.trim() ? { label: approve } : {},
      });
    },
  },
  capture: {
    flags: { selector: "value", quote: "value", size: "value", full: "bool", mark: "value", "mark-label": "value", publish: "value", key: "value" },
    build(parsed, context, command) {
      const [url] = words(parsed, command, 1, 1, "the url");
      const selector = parsed.values.get("selector");
      const quote = parsed.values.get("quote");
      if (selector !== undefined && quote !== undefined) fail(command, "pass one of --selector or --quote, not both");
      const markKind = parsed.values.get("mark");
      const markLabel = parsed.values.get("mark-label");
      if (markLabel !== undefined && markKind === undefined) fail(command, "--mark-label labels a mark: pass --mark too");
      const summary = parsed.values.get("publish");
      const key = parsed.values.get("key");
      if (key !== undefined && summary === undefined) fail(command, "--key names the published capture: pass --publish too");
      return defined({
        url: pathArg(url!, context),
        target: selector !== undefined ? { selector } : quote !== undefined ? { quote } : undefined,
        viewport: viewportOf(command, parsed.values.get("size")),
        fullPage: parsed.bools.has("full") ? true : undefined,
        mark: markKind === undefined ? undefined : markLabel === undefined ? markKind : { kind: markKind, label: markLabel },
        publish: summary === undefined ? undefined : defined({ summary, key }),
      });
    },
  },
  deliverables: noArguments,
  unpublish: {
    flags: { artifact: "value" },
    build(parsed, _context, command) {
      const artifact = parsed.values.get("artifact");
      const [id] = words(parsed, command, artifact === undefined ? 1 : 0, artifact === undefined ? 1 : 0, "the filing's id (deliverables lists them)");
      return artifact === undefined ? { id } : { artifact };
    },
  },
  folders: {
    flags: {},
    build(parsed, context, command) {
      words(parsed, command, 1, Infinity, "a folder");
      return { folders: parsed.words.map((folder) => pathArg(folder, context)) };
    },
  },
  atlas: {
    flags: { file: "value", summary: "value" },
    build(parsed, context, command) {
      const [path] = words(parsed, command, 1, 1, "the Atlas path");
      const file = parsed.values.get("file");
      if (file === undefined) fail(command, "--file names the file that holds the page's Markdown (- reads it from stdin)");
      let markdown: string;
      try {
        if (file === "-") {
          if (!context.readStdin) fail(command, "--file - reads stdin, which this way in has none: name a file");
          markdown = context.readStdin();
        } else {
          if (!context.readFile) fail(command, "this way in can't read a file");
          markdown = context.readFile(pathArg(file, context));
        }
      } catch (error) {
        if (error instanceof AgentUsageError) throw error;
        return fail(command, `couldn't read ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return defined({ path, markdown, summary: parsed.values.get("summary") });
    },
  },
  "browser open": {
    flags: { profile: "value", tab: "value" },
    build(parsed, _context, command) {
      const [url] = words(parsed, command, 1, 1, "the url");
      return defined({ url, profile: parsed.values.get("profile"), tab: parsed.values.get("tab") });
    },
  },
  "browser read": {
    flags: { tab: "value" },
    build(parsed, _context, command) {
      words(parsed, command, 0, 0, "");
      return defined({ tab: parsed.values.get("tab") });
    },
  },
  "browser click": {
    flags: { tab: "value", ref: "value", selector: "value", text: "value" },
    build(parsed, _context, command) {
      const [bare] = words(parsed, command, 0, 1, "the target");
      return defined({ tab: parsed.values.get("tab"), target: browserTarget(parsed, command, bare, "text") });
    },
  },
  "browser type": {
    flags: { tab: "value", ref: "value", selector: "value", label: "value", submit: "bool" },
    build(parsed, _context, command) {
      const flagged = ["ref", "selector", "label"].some((flag) => parsed.values.has(flag));
      const given = words(parsed, command, flagged ? 1 : 2, flagged ? 1 : 2, flagged ? "the text to type" : "the target and the text to type");
      const target = browserTarget(parsed, command, flagged ? undefined : given[0], "label");
      return defined({
        tab: parsed.values.get("tab"),
        target,
        text: flagged ? given[0] : given[1],
        submit: parsed.bools.has("submit") ? true : undefined,
      });
    },
  },
  "browser screenshot": {
    flags: { tab: "value" },
    build(parsed, _context, command) {
      words(parsed, command, 0, 0, "");
      return defined({ tab: parsed.values.get("tab") });
    },
  },
  "browser tabs": noArguments,
  "browser ask": {
    flags: { tab: "value" },
    build: (parsed, _context, command) => defined({ tab: parsed.values.get("tab"), reason: rest(parsed, command, "the reason") }),
  },
  "browser close": {
    flags: {},
    build(parsed, _context, command) {
      const [tab] = words(parsed, command, 1, 1, "the tab's id (browser tabs lists them)");
      return { tab };
    },
  },
  sessions: {
    flags: { detail: "bool" },
    build(parsed, _context, command) {
      const detail = parsed.bools.has("detail");
      if (detail && !parsed.words.length) fail(command, "--detail shows one session in full: name it too");
      return defined({ session: parsed.words.length ? parsed.words.join(" ") : undefined, detail: detail ? true : undefined });
    },
  },
  tail: {
    flags: { wait: "value", since: "value", sentences: "value" },
    build(parsed, _context, command) {
      return defined({
        session: rest(parsed, command, "the session (an id from sessions, or its label)"),
        wait: number(command, "wait", parsed.values.get("wait")),
        since: parsed.values.get("since"),
        sentences: integer(command, "sentences", parsed.values.get("sentences")),
      });
    },
  },
  history: {
    flags: { branch: "value", before: "value", limit: "value" },
    build(parsed, _context, command) {
      const [session] = words(parsed, command, 1, 1, "the session (a recorded or live id, or self)");
      return defined({
        session,
        branch: parsed.values.get("branch"),
        before: parsed.values.get("before"),
        limit: integer(command, "limit", parsed.values.get("limit")),
      });
    },
  },
  item: {
    flags: { cursor: "value" },
    build(parsed, _context, command) {
      const [session, item] = words(parsed, command, 2, 2, "the session and the item (from history)");
      return defined({ session, item, bodyCursor: parsed.values.get("cursor") });
    },
  },
  start: {
    flags: { backend: "value", folder: "value", "sign-in": "value", model: "value", effort: "value", prompt: "value", host: "value", label: "value" },
    build(parsed, context, command) {
      words(parsed, command, 0, 0, "");
      const folder = parsed.values.get("folder");
      return defined({
        backend: parsed.values.get("backend"),
        folder: folder === undefined ? context.cwd : pathArg(folder, context),
        signIn: parsed.values.get("sign-in"),
        model: parsed.values.get("model"),
        effort: parsed.values.get("effort"),
        prompt: parsed.values.get("prompt"),
        host: parsed.values.get("host"),
        label: parsed.values.get("label"),
      });
    },
  },
  fork: {
    flags: { label: "value" },
    build: (parsed) => defined({ session: parsed.words.length ? parsed.words.join(" ") : undefined, label: parsed.values.get("label") }),
  },
  rename: {
    flags: {},
    build(parsed, _context, command) {
      words(parsed, command, 2, Infinity, "the session and its new label");
      return { session: parsed.words[0], label: parsed.words.slice(1).join(" ") };
    },
  },
  notify: {
    flags: { title: "value", session: "value", link: "value" },
    build: (parsed, _context, command) => defined({
      body: rest(parsed, command, "the body"),
      title: parsed.values.get("title"),
      session: parsed.values.get("session"),
      link: parsed.values.get("link"),
    }),
  },
  speak: {
    flags: { voice: "value" },
    build: (parsed, _context, command) => defined({ text: rest(parsed, command, "the text"), voice: parsed.values.get("voice") }),
  },
  wake: sessionOnly,
  recite: sessionOnly,
  mode: {
    flags: { session: "value", all: "bool" },
    build(parsed, _context, command) {
      const [action] = words(parsed, command, 1, 1, "pause or resume");
      if (action !== "pause" && action !== "resume") fail(command, `mode is pause (manual) or resume (automatic), not ${JSON.stringify(action)}`);
      return defined({ action, session: parsed.values.get("session"), scope: parsed.bools.has("all") ? "all" : undefined });
    },
  },
  "on-screen": noArguments,
  config: {
    flags: { unset: "bool" },
    build(parsed, _context, command) {
      const [key, value] = words(parsed, command, 0, 2, "");
      const unset = parsed.bools.has("unset");
      if (unset && key === undefined) fail(command, "--unset needs the key to unset");
      if (unset && value !== undefined) fail(command, "--unset takes a key, not a value");
      return defined({ key, value, unset: unset ? true : undefined });
    },
  },
  bug: {
    flags: { happened: "value", expected: "value", area: "value", evidence: "list" },
    build: (parsed, _context, command) => defined({
      title: rest(parsed, command, "the title (one line: what went wrong)"),
      happened: parsed.values.get("happened"),
      expected: parsed.values.get("expected"),
      area: parsed.values.get("area"),
      evidence: parsed.lists.get("evidence"),
    }),
  },
  whoami: noArguments,
};

/** Names a command is also known by: what an agent might type for it. */
export const AGENT_COMMAND_ALIASES: Readonly<Record<string, string>> = {
  "browser shot": "browser screenshot",
  "browser list": "browser tabs",
  "tab open": "browser open",
  "tab read": "browser read",
  "tab click": "browser click",
  "tab type": "browser type",
  "tab shot": "browser screenshot",
  "tab screenshot": "browser screenshot",
  "tab ask": "browser ask",
  "tab close": "browser close",
  tabs: "browser tabs",
  screenshot: "browser screenshot",
  review: "publish",
  review_to_front: "publish",
  remove: "unpublish",
  pause: "mode pause",
  resume: "mode resume",
};

/** The command the first words name: the longest name that fits, an alias's, or none. */
function findCommand(argv: readonly string[]): { command: AgentCommandText; used: number; prefix: string[] } | undefined {
  for (const length of [2, 1]) {
    if (argv.length < length) continue;
    const said = argv.slice(0, length).join(" ");
    const command = AGENT_COMMANDS.find((candidate) => candidate.name === said);
    if (command) return { command, used: length, prefix: [] };
    const alias = AGENT_COMMAND_ALIASES[said];
    if (alias) {
      // `pause` is `mode pause`: the alias's own words after the command's name become its first words.
      const aliasWords = alias.split(" ");
      const target = AGENT_COMMANDS.find((candidate) => candidate.name === alias)
        ?? AGENT_COMMANDS.find((candidate) => candidate.name === aliasWords[0]);
      if (target) return { command: target, used: length, prefix: target.name === alias ? [] : aliasWords.slice(target.name.split(" ").length) };
    }
  }
  return undefined;
}

/** The commands whose names start like `word`, for "did you mean". */
function nearCommands(word: string): string[] {
  const lower = word.toLowerCase();
  return AGENT_COMMANDS.map((command) => command.name)
    .filter((name) => name.startsWith(lower) || name.split(" ").some((part) => part.startsWith(lower.slice(0, 3))))
    .slice(0, 4);
}

/** Read a command's flags off its words: `--name value`, `--name=value`, `--flag`, and `--` before words that start with a dash. */
export function readFlags(argv: readonly string[], flags: Readonly<Record<string, FlagKind>>, command: AgentCommandText): ParsedFlags & { help: boolean; json: boolean } {
  const parsed = { words: [] as string[], values: new Map<string, string>(), lists: new Map<string, string[]>(), bools: new Set<string>(), help: false, json: false };
  let onlyWords = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (onlyWords || arg === "-" || !arg.startsWith("-")) {
      parsed.words.push(arg);
      continue;
    }
    if (arg === "--") {
      onlyWords = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = (equals > 0 ? arg.slice(0, equals) : arg).replace(/^--?/, "");
    const kind = flags[name];
    if (!kind) {
      const known = Object.keys(flags);
      fail(command, `unknown option --${name}${known.length ? `; it takes ${known.map((flag) => `--${flag}`).join(", ")}` : "; it takes none"}`);
    }
    if (kind === "bool") {
      if (equals > 0) fail(command, `--${name} takes no value`);
      parsed.bools.add(name);
      continue;
    }
    let value: string | undefined;
    if (equals > 0) value = arg.slice(equals + 1);
    else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined) fail(command, `--${name} needs a value`);
    if (kind === "list") parsed.lists.set(name, [...(parsed.lists.get(name) ?? []), value]);
    else if (parsed.values.has(name)) fail(command, `--${name} is given twice`);
    else parsed.values.set(name, value);
  }
  return parsed;
}

/**
 * `conch agent <argv>` as the handler call it means, or the help it asks for. Throws `AgentUsageError` (with the
 * command, when one was named) for words it can't read.
 */
export function parseAgentCommand(argv: readonly string[], context: BuildContext = {}): AgentInvocation {
  const first = argv[0];
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    const asked = argv.slice(1).filter((word) => word !== "--json");
    if (!asked.length) return { kind: "help", text: renderAgentHelp() };
    const found = findCommand(asked);
    if (!found) throw new AgentUsageError(`no conch agent command ${JSON.stringify(asked.join(" "))}${nearHint(asked[0]!)}`);
    return { kind: "help", text: renderAgentCommandHelp(found.command) };
  }
  const found = findCommand(argv);
  if (!found) {
    // `conch agent browser` alone, or a command it doesn't have: the group's commands, or the near ones.
    if (first === "browser" || first === "tab") {
      throw new AgentUsageError(`browser takes a command: ${AGENT_COMMANDS.filter((command) => command.name.startsWith("browser ")).map((command) => command.name.slice(8)).join(", ")}`);
    }
    throw new AgentUsageError(`no conch agent command ${JSON.stringify(first)}${nearHint(first)}; conch agent help lists them`);
  }
  const { command, used, prefix } = found;
  const parser = AGENT_COMMAND_PARSERS[command.name];
  if (!parser) throw new AgentUsageError(`conch agent ${command.name} has no parser`, command);
  const flags = readFlags([...prefix, ...argv.slice(used)], parser.flags, command);
  if (flags.help) return { kind: "help", text: renderAgentCommandHelp(command) };
  return { kind: "run", command, tool: command.tool, args: parser.build(flags, context, command), json: flags.json };
}

function nearHint(word: string): string {
  const near = nearCommands(word);
  return near.length ? ` (did you mean ${near.map((name) => `\`${name}\``).join(", ")}?)` : "";
}

/** What an error says, with the command's usage under it when the mistake was in the words. */
export function usageErrorText(error: AgentUsageError): string {
  return error.command ? `${error.message}\n${usage(error.command)}` : error.message;
}

/**
 * A command line for `conch_run`: words split as a shell would, with single and double quotes and backslashes, and no
 * expansion of anything. A leading `conch agent` (or `conch`) is dropped, since agents copy the whole line.
 */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | "\"" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") quote = undefined;
      else if (char === "\\" && index + 1 < line.length && "\"\\$`".includes(line[index + 1]!)) current += line[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new AgentUsageError(`the command has an unclosed ${quote === "'" ? "single" : "double"} quote`);
  if (started) words.push(current);
  if (words[0] === "conch") words.shift();
  if (words[0] === "agent") words.shift();
  return words;
}

// ---- What an answer says ----

/** The tools that moved to the CLI, by name, and the command each is now: the words conch's answers use for them. */
const MOVED: ReadonlyArray<[string, string]> = AGENT_COMMANDS
  .filter((command) => !Object.hasOwn(AGENT_INSTRUCTIONS.tools, command.tool) && /^[a-z]+_[a-z_]+$/.test(command.tool))
  .map((command): [string, string] => [command.tool, `conch agent ${command.name}`])
  .sort(([a], [b]) => b.length - a.length);
const MOVED_PATTERN = new RegExp(`(?<![\\w-])(${MOVED.map(([tool]) => tool).join("|")})(?![\\w-])`, "g");
const MOVED_BY_TOOL = new Map(MOVED);

/**
 * conch's words for a tool that is a command now: "close one (browser_close) first" says `conch agent browser close`.
 * The daemon and the Mac app answer the MCP server and the CLI alike, and still name tools.
 */
export function cliWording(text: string): string {
  return text.replace(MOVED_PATTERN, (tool) => MOVED_BY_TOOL.get(tool) ?? tool);
}

/** Every string in an answer in the CLI's words; keys left alone. */
export function cliWorded(value: unknown): unknown {
  if (typeof value === "string") return cliWording(value);
  if (Array.isArray(value)) return value.map(cliWorded);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cliWorded(item)]));
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isScalar = (value: unknown) => value === null || (typeof value !== "object" && typeof value !== "function");

/** A scalar as a line shows it: a string as it is, unless it is empty or has a line break, then quoted. */
function scalar(value: unknown): string {
  if (typeof value === "string") return value === "" || /[\n\r]/.test(value) ? JSON.stringify(value) : value;
  return String(value);
}

/** An object on one line: `key=value` for each scalar, compact JSON for anything deeper. */
function inline(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => {
      if (isScalar(item)) {
        const said = scalar(item);
        return `${key}=${/\s/.test(said) && typeof item === "string" && !said.startsWith("\"") ? JSON.stringify(item) : said}`;
      }
      return `${key}=${JSON.stringify(item)}`;
    })
    .join(" ");
}

/** Any answer as short lines: a field a line, a list an item a line, a long text as a block. */
export function renderLines(value: unknown, indent = ""): string[] {
  if (isScalar(value)) return [`${indent}${scalar(value)}`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}(none)`];
    return value.map((item) => `${indent}- ${isRecord(item) ? inline(item) : isScalar(item) ? scalar(item) : JSON.stringify(item)}`);
  }
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    if (typeof item === "string" && /\n/.test(item)) {
      lines.push(`${indent}${key}:`, ...item.split("\n").map((line) => `${indent}  ${line}`));
    } else if (isScalar(item)) {
      lines.push(`${indent}${key}: ${scalar(item)}`);
    } else if (Array.isArray(item)) {
      if (item.every(isScalar)) lines.push(`${indent}${key}: ${item.length ? item.map(scalar).join(", ") : "(none)"}`);
      else lines.push(`${indent}${key}:`, ...renderLines(item, `${indent}  `));
    } else if (isRecord(item)) {
      const one = inline(item);
      if (one.length <= 110 && Object.values(item).every((entry) => isScalar(entry) || JSON.stringify(entry).length < 60)) lines.push(`${indent}${key}: ${one}`);
      else lines.push(`${indent}${key}:`, ...renderLines(item, `${indent}  `));
    }
  }
  return lines;
}

const ago = (iso: unknown, now: number): string => {
  const at = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

/** `sessions`: who you are, then a session a line. */
function renderSessions(value: Record<string, unknown>, now: number): string[] {
  const lines: string[] = [];
  const caller = isRecord(value.caller) ? value.caller : undefined;
  if (caller?.status === "verified") lines.push(`you: ${String(caller.sessionId)} "${String(caller.label ?? "")}" (verified)`);
  else if (caller) lines.push(`you: unverified (${String(caller.reason ?? "")})`);
  if (isRecord(value.mode) && (value.mode.paused || value.mode.muted)) lines.push(`conch: ${value.mode.paused ? "manual mode" : ""}${value.mode.paused && value.mode.muted ? ", " : ""}${value.mode.muted ? "muted" : ""}`);
  for (const session of Array.isArray(value.sessions) ? value.sessions.filter(isRecord) : []) {
    const where = [session.backend, session.account].filter(Boolean).join(", ");
    const flags = [
      session.you ? "← you" : "",
      session.alive === false ? "not running" : "",
      typeof session.agents === "number" && session.agents ? `${session.agents} subagents` : "",
      isRecord(session.toolsStale) && Array.isArray(session.toolsStale.missing) ? `tools stale (missing ${session.toolsStale.missing.join(", ")})` : "",
    ].filter(Boolean);
    lines.push([
      String(session.id),
      String(session.status ?? "-").padEnd(7),
      `"${String(session.label ?? "")}"`,
      `(${where})`,
      typeof session.cwd === "string" ? session.cwd : "",
      ago(session.lastActivity, now),
      ...flags,
    ].filter(Boolean).join("  "));
  }
  if (Array.isArray(value.claudeSignIns) && value.claudeSignIns.length) {
    lines.push(`claude sign-ins (start --sign-in): ${value.claudeSignIns.filter(isRecord).map((one) => `${String(one.label)} (${String(one.id)})`).join(", ")}`);
  }
  for (const key of ["source", "note", "stale", "truncated"]) if (typeof value[key] === "string") lines.push(`${key}: ${value[key]}`);
  if (!Array.isArray(value.sessions) || !value.sessions.length) lines.push("no live sessions");
  return lines;
}

/** `browser read`: the page as an agent reads one, its refs a line each. */
function renderPage(value: Record<string, unknown>): string[] {
  const lines = [`tab ${String(value.tab ?? "?")}: ${String(value.title ?? "")}`, String(value.url ?? "")];
  if (typeof value.text === "string" && value.text) lines.push("", value.text, "");
  const quoted = (text: unknown) => JSON.stringify(String(text ?? ""));
  for (const link of Array.isArray(value.links) ? value.links.filter(isRecord) : []) lines.push(`link ${String(link.ref)} ${quoted(link.text)}${link.href ? ` ${String(link.href)}` : ""}`);
  for (const button of Array.isArray(value.buttons) ? value.buttons.filter(isRecord) : []) lines.push(`button ${String(button.ref)} ${quoted(button.text)}`);
  for (const field of Array.isArray(value.fields) ? value.fields.filter(isRecord) : []) {
    const named = field.label ?? field.name;
    lines.push(`field ${String(field.ref)} ${String(field.type ?? "text")}${named ? ` ${quoted(named)}` : ""}${field.value !== undefined ? ` = ${quoted(field.value)}` : ""}${field.checked !== undefined ? ` checked=${String(field.checked)}` : ""}${field.disabled ? " disabled" : ""}`);
  }
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !["tab", "title", "url", "text", "links", "buttons", "fields"].includes(key)));
  return [...lines, ...renderLines(extra)];
}

/** An answer as `conch agent` prints it: JSON with --json, else short lines, both in the CLI's words. */
export function renderAgentAnswer(command: AgentCommandText, value: unknown, json: boolean, now = Date.now()): string {
  const worded = cliWorded(value);
  if (json) return JSON.stringify(worded);
  if (typeof worded === "string") return worded;
  if (isRecord(worded) && command.name === "sessions" && Array.isArray(worded.sessions)) return renderSessions(worded, now).join("\n");
  if (isRecord(worded) && command.name === "browser read") return renderPage(worded).join("\n");
  return renderLines(worded).join("\n");
}

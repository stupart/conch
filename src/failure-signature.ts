import { createHash } from "node:crypto";

/**
 * What makes two failures the same failure (docs/failure-tickets.md): where it came from, what conch was doing, and
 * what went wrong, said without anything that changes from one occurrence to the next.
 *
 * A record's message names the things it happened to: a session's label, a file, a folder, a conversation id, how many
 * seconds it waited. Grouped on the raw text, Tyler's 30 "Couldn't find <file>" records from the review pane were 14
 * tickets, one per file, and the 32 recovered drafts were 32. Grouped on what is left once those are taken out, each is
 * one ticket that says how often.
 *
 * The rest of a message after its first sentence is usually what conch saw at the time (a page's headings, the words
 * left in a draft): evidence for the ticket's example, never part of its identity.
 */

/** Where a failure record came from: the daemon, an app, a hook process, or an agent's call to one of conch's tools. */
export type FailureOrigin = "daemon" | "mac" | "ios" | "hook" | "mcp";
export const FAILURE_ORIGINS: readonly FailureOrigin[] = ["daemon", "mac", "ios", "hook", "mcp"];

/** The longest normalized message a signature keeps: one sentence, as a ticket's title shows it. */
export const SIGNATURE_MESSAGE_MAX = 160;

/** Folders a path in a message starts at: the home folder and the system's, never a word that only has a slash in it. */
const PATH = /(?:~|\/(?:Users|private|tmp|var|Volumes|Applications|opt|dev|Library|System|usr|etc|bin|nix))(?:\/[^\s"'“”‘’()<>,;]+(?: [^\s/"'“”()<>,;:]+(?=\/))*)+\/?|~(?=\s|$)/g;
const URL = /\b(?:https?|file|conch):\/\/[^\s"'“”<>)]+/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Anything quoted: a session's label, a page's words, a draft. Straight, curly or guillemet quotes, kept on one line. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|‹[^›\n]*›|«[^»\n]*»/g;
/** A file named on its own ("Couldn't find v0.4.0.md"): a name, a dot, a short extension that has a letter in it. */
const FILE = /(?<![\w<])[\w][\w.@+-]*\.(?=[A-Za-z0-9]{1,6}\b)(?=[0-9]*[A-Za-z])[A-Za-z0-9]{1,6}\b/g;
/** An id that isn't a UUID: a hash, a tmux session's suffix, a pid-like run of hex with a digit in it. */
const HEX_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;

/**
 * A failure's message as its ticket names it: URLs, paths, ids, quoted words, file names and numbers replaced by what
 * they are, whitespace collapsed, and only its first sentence, at most `SIGNATURE_MESSAGE_MAX` characters.
 *
 * Order matters: a URL holds a path and a file name, a path holds a file name and a UUID, and a quoted label may hold
 * any of them, so each goes whole before anything inside it could be taken apart.
 */
export function normalizeFailureMessage(message: string): string {
  let text = message.replace(/\s+/g, " ").trim();
  // A stop or a comma right after one ends the sentence, not the path.
  const keepingPunctuation = (name: string) => (found: string) => `<${name}>${/[.,;:!?]+$/.exec(found)?.[0] ?? ""}`;
  text = text.replace(URL, keepingPunctuation("url"));
  text = text.replace(PATH, keepingPunctuation("path"));
  text = text.replace(UUID, "<id>");
  text = text.replace(/\bconch-<id>/g, "<id>");
  text = text.replace(QUOTED, (quote) => quote.length > 2 ? `${quote[0]}…${quote[quote.length - 1]}` : quote);
  text = text.replace(FILE, "<file>");
  text = text.replace(HEX_ID, "<id>");
  text = text.replace(NUMBER, "<n>");
  // A list of quoted things ("…", "…", "…") is one thing however long it was.
  text = text.replace(/(["“‘‹«]…["”’›»])(?:,\s*\1)+/g, "$1");
  text = firstSentence(text);
  return text.length > SIGNATURE_MESSAGE_MAX ? `${text.slice(0, SIGNATURE_MESSAGE_MAX - 1).trimEnd()}…` : text;
}

/**
 * Up to the end of the first sentence: a stop, a question or an exclamation followed by a space and what starts a
 * new one. A stop inside a version or a file name was taken out above, so it can't end one early.
 */
function firstSentence(text: string): string {
  const end = /[.!?](?=\s+["“‘‹«<A-Z])/.exec(text);
  return end ? text.slice(0, end.index + 1) : text;
}

/**
 * An MCP tool's error begins with how the call ended ("failed: …", "refused: …"), which the ticket says already;
 * dropped, so a tool's failure reads as its message rather than "failed: failed: …".
 */
export function stripOutcomePrefix(message: string): string {
  return message.replace(/^\s*(?:failed|refused|input-error|error)\s*:\s*/i, "");
}

export interface FailureIdentity {
  origin: FailureOrigin;
  /** What conch was doing: the record's operation, or for an MCP call its tool and how the call ended. */
  operation: string;
  /** The normalized message: the ticket's title. */
  title: string;
  /** `origin · operation · title`, the grouping key, readable. */
  signature: string;
  /** A stable short id for the signature: the same failure gets the same ticket across restarts and rebuilds. */
  key: string;
}

/** A record's identity, from where it came from, what conch was doing, and its raw message. */
export function failureIdentity(origin: FailureOrigin, operation: string, message: string): FailureIdentity {
  const op = operation.replace(/\s+/g, " ").trim().slice(0, 80) || "unknown";
  const title = normalizeFailureMessage(origin === "mcp" ? stripOutcomePrefix(message) : message) || "(no message)";
  const signature = `${origin} · ${op} · ${title}`;
  const key = createHash("sha256").update(signature).digest("hex").slice(0, 12);
  return { origin, operation: op, title, signature, key };
}

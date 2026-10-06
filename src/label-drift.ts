/**
 * A session label that no longer says what the session is doing.
 *
 * Feedback (2026-10-03): a session stayed "Remove Rowan from the Morrow site" in the sidebar
 * long after its work had moved on to a headline and a photo edit, so the user looked for that work
 * under the wrong name. Labels come from the first prompt (Claude Code's own title, Codex's thread
 * name), and nothing moved them on. conch never renames a session itself: it tells the agent, in
 * `review_to_front`'s result, that what it publishes no longer matches its label, and the agent
 * decides. Only for a label the agent's side chose (`LabelSource`): one a person gave (the Mac
 * app, `conch rename`, `conch_rename` at their request, a `/rename`) is theirs, and a folder's name
 * was never a topic to drift from.
 */

/** Who chose a session's label: a person, the agent (its generated title), or nobody (the folder's name): `sessionLabelSource`. */
export type LabelSource = "user" | "agent" | "folder";

/** How many of the newest summaries are compared: "the last two or three". */
export const RELABEL_RECENT = 3;
/** Fewer than this many summaries say nothing about drift: one publication is not a trend. */
export const RELABEL_MIN_SUMMARIES = 2;

/**
 * Words that say nothing about WHAT the work is: grammar, and the words every deliverable uses
 * ("updated the page", "fixed the new version"). Sharing one of these is not sharing a topic.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "this", "that", "these", "those", "its", "it's", "are", "was",
  "were", "has", "have", "had", "now", "not", "but", "all", "any", "out", "our", "your", "you", "they", "them", "can",
  "will", "just", "more", "less", "than", "then", "when", "what", "which", "who", "how", "why", "also", "via", "per",
  "page", "pages", "file", "files", "update", "updated", "updates", "fix", "fixed", "fixes", "new", "change", "changed",
  "changes", "add", "added", "adds", "remove", "removed", "make", "made", "work", "working", "done", "review", "result",
  "results", "version", "draft", "ready", "check", "look", "here", "there", "one", "two", "first", "second", "final",
]);

/** The meaningful words of a label or a summary: lower case, three characters or more, no stopwords. */
export function topicWords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return new Set(words);
}

/** Two words for one topic: the same, or one the other's stem ("photo", "photos"; "edit", "editing"). */
function sameTopic(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * Whether a label has drifted from the work: there are at least `RELABEL_MIN_SUMMARIES` recent
 * summaries (newest first; the newest `RELABEL_RECENT` are read) and none of them shares a
 * meaningful word with the label. A label with no meaningful words of its own ("misc") is not
 * judged: there is nothing in it to drift from.
 */
export function labelDrifted(label: string, summaries: readonly string[]): boolean {
  const recent = summaries.slice(0, RELABEL_RECENT);
  if (recent.length < RELABEL_MIN_SUMMARIES) return false;
  const named = [...topicWords(label)];
  if (!named.length) return false;
  return recent.every((summary) => ![...topicWords(summary)].some((word) => named.some((own) => sameTopic(word, own))));
}

export interface RelabelHint {
  label: string;
  hint: string;
}

/**
 * The hint `review_to_front` returns as `relabel`, or undefined: when the label drifted and the
 * agent's side chose it, not a person (`LabelSource` "user") and not a folder's name.
 */
export function relabelHint(label: string, source: LabelSource, summaries: readonly string[]): RelabelHint | undefined {
  if (source !== "agent" || !labelDrifted(label, summaries)) return undefined;
  const newest = summaries[0]!;
  return {
    label,
    hint: `Your session is still labelled '${label}' but your recent work is about '${newest}'. If the focus has moved,`
      + " call conch_rename with a short new label.",
  };
}

/**
 * At most one hint per label per session: once said, not again on every publish, and a new label
 * (after a rename, or a new title) starts afresh.
 */
export class RelabelHints {
  readonly #said = new Map<string, string>();

  /** The hint to give now, or undefined; remembers it as given. */
  take(sessionId: string, label: string, source: LabelSource, summaries: readonly string[]): RelabelHint | undefined {
    if (this.#said.get(sessionId) === label) return undefined;
    const hint = relabelHint(label, source, summaries);
    if (hint) this.#said.set(sessionId, label);
    return hint;
  }
}

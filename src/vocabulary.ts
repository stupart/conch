import { homedir } from "node:os";
import { basename, sep } from "node:path";
import type { Config } from "./config.ts";

/**
 * Whisper's initial prompt: the names conch's world is full of, so dictation
 * spells them the way they are written. Whisper reads the prompt as text that
 * came just before the audio, so a name in it is a name it expects to hear.
 *
 * Measured on 90 synthetic dictations through conch's capture recipe: names
 * spelled right went from 75.4% to 80.4% ("Ask codecs to fix…" became "Ask
 * Codex to fix…") and word error from 5.2% to 4.1%. On 73 LibriSpeech
 * utterances, which share none of these words, word error stayed level. On 25
 * noise-only clips it produced no text, with or without a prompt —
 * whisper-server's VAD drops them before decoding.
 *
 * The form matters. A bare comma list scored worse than a sentence, and a
 * CamelCase name in it taught whisper to glue words ("SeaShellworkTree",
 * "BunTest"), so the prompt is one plain sentence and folder names are split
 * into the words they are said as.
 *
 * Three sources, in order: conch's own names, the user's `vocabulary` setting,
 * and the projects the live sessions work in (a session in ~/Projects/Seashell
 * adds "Seashell"), so a project's name is spelled right while it is open.
 */
const LEAD = "Dictating to Claude Code and Codex about";
const BUILT_IN_TERMS = ["conch"] as const;

/** Whisper keeps at most half its 448-token context for the prompt; stay well inside. */
const MAX_PROMPT_CHARS = 600;

/** Folder names that say where a project lives, not what it is called. */
const GENERIC_FOLDERS = new Set([
  "desktop", "documents", "downloads", "projects", "repos", "src", "code", "dev", "work", "tmp", "temp", "private", "var",
]);

let sessionTerms: readonly string[] = [];

/** The user's `vocabulary` setting: comma- or newline-separated words and names. */
export function parseVocabularyTerms(raw: string): string[] {
  return raw.split(/[,\n]/).map((term) => term.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * The project a session works in, named by its folder. A worktree
 * (`…/Conch/.worktrees/fix-x`) is its repository's project, not its branch.
 */
export function projectName(path: string, home = homedir()): string | undefined {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (!trimmed || trimmed === home.replace(/[/\\]+$/, "")) return undefined;
  const worktree = trimmed.split(sep).lastIndexOf(".worktrees");
  const root = worktree > 0 ? trimmed.split(sep).slice(0, worktree).join(sep) : trimmed;
  const name = basename(root);
  if (!name || name.startsWith(".") || GENERIC_FOLDERS.has(name.toLowerCase())) return undefined;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,39}$/u.test(name)) return undefined;
  return spoken(name);
}

/** A folder name as it is said: "HomebrewTap" is "Homebrew Tap", "linear-pulse" is "linear pulse". */
function spoken(name: string): string {
  return name
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The daemon reports the live sessions' folders whenever its session snapshot changes. */
export function setSessionVocabulary(
  sessions: readonly { cwd?: string; workDirs?: readonly string[] }[],
  home = homedir(),
): void {
  const names = new Set<string>();
  for (const session of sessions) {
    for (const path of [session.cwd, ...(session.workDirs ?? [])]) {
      const name = path ? projectName(path, home) : undefined;
      if (name) names.add(name);
    }
  }
  sessionTerms = [...names].sort((a, b) => a.localeCompare(b));
}

/** The prompt for this config: "Dictating to Claude Code and Codex about conch, Seashell and Humain." */
export function transcriptionPrompt(cfg: Pick<Config, "vocabulary">): string {
  const seen = new Set(["claude code", "codex"]);
  const terms: string[] = [];
  let length = LEAD.length + 2;
  for (const term of [...BUILT_IN_TERMS, ...parseVocabularyTerms(cfg.vocabulary ?? ""), ...sessionTerms]) {
    const key = term.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    // Stop at the cap rather than cut a name in half.
    if (length + term.length + 2 > MAX_PROMPT_CHARS) break;
    seen.add(key);
    terms.push(term);
    length += term.length + 2;
  }
  const list = terms.length > 1 ? `${terms.slice(0, -1).join(", ")} and ${terms.at(-1)}` : terms[0];
  return `${LEAD} ${list}.`;
}

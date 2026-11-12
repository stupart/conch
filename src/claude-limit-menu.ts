import { claudeInputBoxText } from "./agent-adapter.ts";

/**
 * What an agent shows when its account runs out, word for word, in one place (2026-11-12, Tyler: "it didn't autoswitch
 * cause it got stuck on a terminal message"). Claude Code may reword any of it; test/claude-limit-menu.test.ts holds
 * the screens these are read from, so a change shows up there first.
 *
 * Claude Code 2.1.322's usage-limit menu (`rate_limit_options_menu`), read from its bundle, as it stopped every Default
 * session on 2026-11-12:
 *
 *     ❯ 1. Stop and wait for limit to reset
 *       2. Wait here, then continue automatically at <reset time>
 *       3. Add funds to continue with usage credits
 *
 * Its rows change with the plan and the account (an "Upgrade your plan", an "Ask your admin for more usage", the stop
 * row first or last), so the stop row is found by its words, never by its number.
 */
export const CLAUDE_LIMIT_STOP = "Stop and wait for limit to reset";

/**
 * The menu's other rows, by how each starts. One of them beside the stop row is what tells the menu from a reply that
 * merely mentions it. conch never chooses any of these: waiting on the account that ran out, or paying, is yours.
 */
export const CLAUDE_LIMIT_OTHER_ROWS = [
  "Wait here, then continue automatically",
  "Add funds to continue with",
  "Switch to usage credits",
  "Ask your admin for more usage",
  "Upgrade your plan",
  "Don’t continue automatically",
] as const;

/** The line above the menu, and the synthetic reply in the transcript: "You've hit your weekly limit · resets …". */
export const CLAUDE_LIMIT_LINE = /You['’]ve (?:hit|reached) your ([^·\n.]{1,40}?) limit\b/;

/**
 * What Claude Code puts in the prompt when "Stop and wait" closes the menu on a session it had armed to carry on by
 * itself (2.1.322 `prefillRateLimitAutoContinue`). It is Claude Code's own placeholder, replaced by whatever is typed
 * next (`consumeRateLimitAutoContinuePrefill`), so a prompt holding only this counts as empty.
 */
export const CLAUDE_LIMIT_PREFILL = "continue";

/** Codex's status line when a /goal stops on the account's usage (codex-cli 0.167.1). Codex's limits are its own. */
export const CODEX_GOAL_LIMIT = "Goal hit usage limits (/goal resume)";

export interface LimitMenuRow {
  number: number;
  label: string;
  highlighted: boolean;
}

export interface ClaudeLimitMenu {
  rows: LimitMenuRow[];
  /** Index into `rows` of "Stop and wait for limit to reset". */
  stop: number;
  /** Index into `rows` of the highlighted row. */
  highlighted: number;
  /** "weekly", "session", "Fable": what ran out, when the screen says. */
  limit?: string;
}

const ROW = /^\s*(❯)?\s*(\d{1,2})\.\s+(\S.*?)\s*$/;

function row(line: string | undefined): LimitMenuRow | undefined {
  const match = line === undefined ? null : ROW.exec(line);
  return match ? { number: Number(match[2]), label: match[3]!, highlighted: match[1] !== undefined } : undefined;
}

/**
 * Claude Code's usage-limit menu, when it is what the screen is asking: numbered rows 1…n in one block, exactly one
 * highlighted, the stop row and at least one other of the menu's own rows among them, and no input box under them (a
 * reply quoting the menu sits above the prompt; the menu takes the prompt's place, as every Claude Code picker does).
 * Null for anything else, which is left alone.
 */
export function readClaudeLimitMenu(screen: string): ClaudeLimitMenu | null {
  const lines = screen.split("\n");
  let stopAt = -1;
  for (let index = lines.length - 1; index >= 0 && stopAt < 0; index -= 1) {
    if (row(lines[index])?.label.startsWith(CLAUDE_LIMIT_STOP)) stopAt = index;
  }
  if (stopAt < 0) return null;
  let first = stopAt;
  while (row(lines[first - 1])) first -= 1;
  let last = stopAt;
  while (row(lines[last + 1])) last += 1;
  const rows = lines.slice(first, last + 1).map((line) => row(line)!);
  if (rows.some((one, index) => one.number !== index + 1)) return null;
  if (!rows.some((one) => CLAUDE_LIMIT_OTHER_ROWS.some((start) => one.label.startsWith(start)))) return null;
  const highlighted = rows.flatMap((one, index) => one.highlighted ? [index] : []);
  if (highlighted.length !== 1) return null;
  if (claudeInputBoxText(lines.slice(last + 1).join("\n")) !== null) return null;
  let limit: string | undefined;
  for (const line of lines.slice(0, first)) limit = CLAUDE_LIMIT_LINE.exec(line)?.[1]?.trim() ?? limit;
  return { rows, stop: stopAt - first, highlighted: highlighted[0]!, ...(limit ? { limit } : {}) };
}

/**
 * The one key that moves the menu toward "Stop and wait": Up or Down to reach it, then Enter, and Enter only once the
 * stop row has been highlighted on `stopLooks` looks running (two), so a Down that lands late can't turn it into
 * another row's Enter. Undefined: look again first. Never a number key, which would choose a row outright.
 */
export function limitMenuKey(menu: ClaudeLimitMenu, stopLooks: number): "Up" | "Down" | "Enter" | undefined {
  if (menu.highlighted > menu.stop) return "Up";
  if (menu.highlighted < menu.stop) return "Down";
  return stopLooks >= 2 ? "Enter" : undefined;
}

/** Claude's prompt, ready for a message: shown, and empty but for Claude Code's own "continue". */
export function claudePromptReady(screen: string): "empty" | "holds words" | "not shown" {
  const box = claudeInputBoxText(screen);
  if (box === null) return "not shown";
  return box === "" || box === CLAUDE_LIMIT_PREFILL ? "empty" : "holds words";
}

/** A Codex screen whose /goal stopped on the account's usage limits. */
export function codexGoalLimited(screen: string): boolean {
  return screen.includes(CODEX_GOAL_LIMIT);
}

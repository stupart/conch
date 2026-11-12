/**
 * What a session's screen shows when Ctrl-D didn't end it, read as text from its tmux pane or its Terminal tab.
 *
 * Ctrl-D asks Claude Code to leave, and it doesn't always go. 2026-10-23, Claude Code 2.1.280: three closes of one
 * background session and a restart of another each reported "still running after 15 s. It may be finishing up."
 * Neither was finishing anything. One was asking whether to stop the background work an exit would end (a three-week-old
 * `until grep …; do sleep 3; done` that could never finish); the other was in its background-sessions view, where Ctrl-D
 * does nothing. The screens below are those panes, as `tmux capture-pane -p` printed them.
 */

/**
 * Claude Code asking before it stops background work, or its background-sessions view: the two places a close's Ctrl-D
 * was seen to land without leaving.
 */
export type ExitBlocker = StopTasksQuestion | { kind: "background-view"; quitsOnCtrlC: boolean };

/**
 * ```
 *   Background work is running
 *   The following will stop when you exit:
 *   shell · Wait for WebKit run to finish and show tail
 *   ❯ 1. Exit and stop tasks
 *     2. Move to background and exit
 *     3. Stay
 *   Enter to confirm · Esc to cancel
 * ```
 */
export interface StopTasksQuestion {
  kind: "stop-tasks";
  /** Each task as the screen names it, without its kind: "Wait for WebKit run to finish and show tail". */
  tasks: string[];
  /** Tasks the screen counts without naming ("… and 3 more"). */
  more: number;
  /** False when the list's heading has gone off the top of the screen, so there may be more above. */
  complete: boolean;
  /** "Exit and stop tasks" is the highlighted choice, so Return takes it. */
  exitHighlighted: boolean;
}

/** A line without the frame round it: a dialog's `│` sides, a rule's `─` runs, the spaces either side. */
function unframed(line: string): string {
  return line.replace(/^[\s│┃║╭╮╰╯┌┐└┘─━═]+|[\s│┃║╭╮╰╯┌┐└┘─━═]+$/g, "");
}

/** One of the question's numbered choices, highlighted or not: `❯ 1. Exit and stop tasks`. */
const CHOICE = /^(?:❯\s*)?\d+\.\s/;
/** A count the list gives in place of names: `… and 3 more`, `+3 more`. */
const MORE = /^(?:…|\.\.\.)?\s*(?:and\s+|\+\s*)?(\d+)\s+more\b/i;

/**
 * Which of the two a Claude Code screen shows, if either. The question is known by its two exit choices together, never
 * by "Exit" alone, and only with no input box drawn below them: the question takes the input box's place, so choices
 * above one are words in the conversation (a capture of this very screen, pasted into a turn), and Return there would
 * send whatever the box holds. The view is known by its own first line; mistaking a quote of it costs an Escape and the
 * Ctrl-C twice that leaves a conversation as Ctrl-D does.
 */
export function claudeExitBlocker(screen: string): ExitBlocker | null {
  const raw = screen.split("\n");
  const lines = raw.map(unframed);
  const exitAt = lines.findLastIndex((line) => /\bExit and stop tasks\b/.test(line));
  const boxBelow = exitAt >= 0 && raw.some((line, index) => index > exitAt && /^\s*❯/.test(line) && /^\s*─{3,}/.test(raw[index - 1]!));
  if (exitAt >= 0 && !boxBelow && lines.some((line) => /\bMove to background and exit\b/.test(line))) {
    const headingAt = lines.slice(0, exitAt).findLastIndex((line) => /will stop when you exit/i.test(line));
    // The heading scrolled away (a long list): the lines just above the choices, up to a gap.
    let start = headingAt + 1;
    if (headingAt < 0) {
      start = exitAt;
      while (start > 0 && lines[start - 1] && !/Background work is running/i.test(lines[start - 1]!)) start -= 1;
    }
    const tasks: string[] = [];
    let more = 0;
    for (const line of lines.slice(start, exitAt)) {
      if (!line || CHOICE.test(line)) continue;
      const counted = MORE.exec(line);
      if (counted) {
        more += Number(counted[1]);
        continue;
      }
      // `shell · Wait for …`: the kind before the dot, the task's own words after it.
      const dot = line.indexOf(" · ");
      const named = (dot >= 0 ? line.slice(dot + 3) : line).replace(/^[∙•·⎿-]\s*/, "").trim();
      if (named) tasks.push(named);
    }
    return { kind: "stop-tasks", tasks, more, complete: headingAt >= 0, exitHighlighted: lines[exitAt]!.includes("❯") };
  }
  // Wrapped or not: a narrow Terminal tab breaks the view's first line where the pane didn't.
  const flat = lines.join(" ").replace(/\s+/g, " ");
  if (/conversation moved to the background/i.test(flat) && /esc returns to it/i.test(flat)) {
    return { kind: "background-view", quitsOnCtrlC: /ctrl\+c twice quits/i.test(flat) };
  }
  return null;
}

/** What two questions have in common when they ask about the same work. */
export function stopTasksSignature(question: StopTasksQuestion): string {
  return JSON.stringify([question.tasks, question.more]);
}

/** At most this much of one line goes into a message. */
const QUOTE_MAX = 120;

/** Screen text in a message, one line of it, short: a tab or other control character would have the app's error
 * report refused (settings.ts, `boundedPrintable`). */
function quoted(text: string, max = QUOTE_MAX): string {
  const plain = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return `"${plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain}"`;
}

/**
 * What a close says when Claude Code asks before stopping background work, and what a second press will do. The answer
 * conch gives on that press is "Exit and stop tasks", never "Move to background and exit": that one leaves the work
 * running out of anyone's sight, which is a choice for the person at the screen, not for a Close button.
 */
export function stopTasksMessage(question: StopTasksQuestion, restart = false): string {
  const count = question.tasks.length + question.more;
  const them = count === 1 ? "it" : "them";
  const again = restart ? `Restart again to stop ${them} and restart.` : `Close again to stop ${them} and exit.`;
  if (!count) return `Claude Code is asking before it stops its background work. ${again}`;
  const noun = `${question.complete ? "" : "at least "}${count} background task${count === 1 ? "" : "s"}`;
  const shown = question.tasks.slice(0, 3).map((task) => quoted(task, 80));
  const unnamed = count - shown.length;
  if (!shown.length) return `Claude Code is asking before it stops ${noun}. ${again}`;
  const named = unnamed > 0
    ? `${shown.join(", ")} and ${unnamed} more`
    : shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `Claude Code is asking before it stops ${noun}: ${named}. ${again}`;
}

/** The last line of a screen that says something: not blank, not a rule or a frame, not a bare prompt. */
export function lastScreenLine(screen: string): string | undefined {
  return screen.split("\n").map(unframed).reverse()
    .find((text) => (text.match(/\p{L}/gu)?.length ?? 0) >= 2 && text !== "[Process completed]");
}

/**
 * Why a session is still running after a close's keys, from what its screen shows at the end of the wait: the view it is
 * still in, the words that keep Ctrl-D from leaving, or simply the last thing it says. Never "it may be finishing up",
 * which was the guess every one of these got.
 */
export function stillRunningReason(
  screen: string | null,
  blocker: ExitBlocker | null,
  inputBox: string | null,
): string {
  if (screen === null) return "Its screen couldn't be read.";
  if (blocker?.kind === "background-view") {
    const view = screen.split("\n").map(unframed).find((line) => /moved to the background/i.test(line));
    return `It is still in Claude Code's background-sessions view${view ? `: ${quoted(view)}` : ""}.`;
  }
  if (inputBox) return `Its input box holds ${quoted(inputBox, 80)}, and Ctrl-D leaves only from an empty one.`;
  const last = lastScreenLine(screen);
  return last ? `Its screen ends: ${quoted(last)}.` : "Its screen is blank.";
}

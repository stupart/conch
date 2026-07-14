import { $ } from "bun";
import type { Config } from "./config.ts";

export type InjectRoute = "tmux" | "osascript-focused" | "osascript-blind" | "clipboard" | "none";

/**
 * Deliver a transcript into the session's prompt.
 *
 * Routes, best first:
 *  - tmux send-keys at the pane hosting the session's pid — exact, works unfocused
 *  - osascript keystrokes AFTER focusing the session's Terminal window
 *    (matched by tty) — reliable for plain-terminal users
 *  - osascript keystrokes blind into the frontmost window — last typing resort
 *  - clipboard — when typing would go into the void, the words are at least
 *    one Cmd-V away ("injected via osascript" that lands nowhere loses the
 *    user's whole utterance; observed live)
 */
export async function injectText(
  cfg: Config,
  sessionPid: number | undefined,
  text: string,
): Promise<{ via: InjectRoute }> {
  const submit = cfg.autoSubmit;
  if (sessionPid) {
    const pane = await findTmuxPane(sessionPid);
    if (pane) {
      // `-l --`: -l sends the text as literal keys, -- stops flag parsing so a
      // transcript starting with "-" isn't read as an option (which both fails
      // AND used to throw, killing the daemon). nothrow + exit check so any
      // send-keys refusal falls through to clipboard instead of crashing.
      const r = await $`tmux send-keys -t ${pane} -l -- ${text}`.quiet().nothrow();
      if (r.exitCode === 0) {
        if (submit) await $`tmux send-keys -t ${pane} Enter`.quiet().nothrow();
        return { via: "tmux" };
      }
    }
  }

  if (cfg.keystrokeFallback) {
    const focused = sessionPid ? await focusSessionWindow(sessionPid) : false;
    if (!focused && sessionPid) {
      // We know which session this is for but can't put its window in
      // front — typing would land somewhere unknowable. Clipboard instead.
      await toClipboard(text);
      return { via: "clipboard" };
    }
    if (focused) await Bun.sleep(300); // let the window raise settle
    await Bun.spawn(
      ["osascript", "-e", "on run argv", "-e", 'tell application "System Events" to keystroke (item 1 of argv)', "-e", "end run", "--", text],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    if (submit) {
      // separate, delayed Return: bundling it with the text occasionally
      // arrived before the terminal finished ingesting the keystrokes
      await Bun.sleep(250);
      // Re-assert focus first: in the gap between typing and this Return, the
      // frontmost window can drift (a notification, the window losing front), and
      // a bare `key code 36` goes to whatever's in front — the text lands but the
      // submit doesn't ("typed but didn't send", observed rarely). Re-focusing the
      // session's window makes the Return land where the text went.
      if (focused && sessionPid) await focusSessionWindow(sessionPid);
      await osa('tell application "System Events" to key code 36');
    }
    return { via: focused ? "osascript-focused" : "osascript-blind" };
  }

  await toClipboard(text);
  return { via: "clipboard" };
}

/** Run osascript with one or more `-e` statements, output discarded. */
function osa(...lines: string[]): Promise<number> {
  return Bun.spawn(["osascript", ...lines.flatMap((l) => ["-e", l])], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** Press a single key in the session — Enter accepts a permission dialog's highlighted option, Escape dismisses it. */
export async function injectKey(
  cfg: Config,
  sessionPid: number | undefined,
  key: "Enter" | "Escape",
): Promise<{ via: InjectRoute }> {
  if (sessionPid) {
    const pane = await findTmuxPane(sessionPid);
    if (pane) {
      const r = await $`tmux send-keys -t ${pane} ${key}`.quiet().nothrow();
      if (r.exitCode === 0) return { via: "tmux" };
    }
  }
  if (cfg.keystrokeFallback) {
    const focused = sessionPid ? await focusSessionWindow(sessionPid) : false;
    if (!focused && sessionPid) return { via: "none" }; // never press keys in an unknown window
    if (focused) await Bun.sleep(300);
    const keyCode = key === "Enter" ? 36 : 53;
    await osa(`tell application "System Events" to key code ${keyCode}`);
    return { via: focused ? "osascript-focused" : "osascript-blind" };
  }
  return { via: "none" };
}

/**
 * Bring the Terminal window/tab hosting the session's tty to the front.
 * The session pid's controlling tty (ps) matches Terminal's per-tab `tty`
 * property — that's an exact address for "the window this session lives in".
 */
async function focusSessionWindow(sessionPid: number): Promise<boolean> {
  try {
    const tty = (await $`ps -o tty= -p ${sessionPid}`.quiet().text()).trim();
    if (!tty || tty === "??") return false;
    const script = `
tell application "Terminal"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/${tty}" then
        set index of w to 1
        set selected tab of w to t
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "notfound"`;
    const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim() === "ok";
  } catch {
    return false;
  }
}

async function toClipboard(text: string): Promise<void> {
  const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
  proc.stdin.write(text);
  await proc.stdin.end();
  await proc.exited;
}

/** Find the tmux pane whose shell is an ancestor of the session's pid. */
async function findTmuxPane(sessionPid: number): Promise<string | null> {
  let panes: Array<{ pid: number; id: string }>;
  try {
    const out = await $`tmux list-panes -a -F "#{pane_pid} #{pane_id}"`.quiet().text();
    panes = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, id] = line.split(" ");
        return { pid: Number(pid), id: id ?? "" };
      });
  } catch {
    return null; // no tmux server
  }
  if (!panes.length) return null;

  const ancestors = await ancestorPids(sessionPid);
  for (const pane of panes) {
    if (ancestors.has(pane.pid)) return pane.id;
  }
  return null;
}

async function ancestorPids(pid: number): Promise<Set<number>> {
  const seen = new Set<number>([pid]);
  let current = pid;
  for (let i = 0; i < 20 && current > 1; i++) {
    try {
      const out = await $`ps -o ppid= -p ${current}`.quiet().text();
      const ppid = Number(out.trim());
      if (!ppid || ppid <= 1 || seen.has(ppid)) break;
      seen.add(ppid);
      current = ppid;
    } catch {
      break;
    }
  }
  return seen;
}

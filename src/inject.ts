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
      // Separate, delayed Return: bundling it with the text arrived before the
      // terminal finished ingesting the keystrokes. Scale the settle to the
      // transcript length — a long dictation's keystrokes can still be landing
      // when a fixed 250ms Return fires, so the submit is dropped ("typed but
      // didn't send", observed on long messages). Capped so short prompts stay snappy.
      await Bun.sleep(250 + Math.min(text.length * 3, 1000));
      // Re-assert focus first: in that gap the frontmost window can drift (a
      // notification, the window losing front), and a bare `key code 36` goes to
      // whatever's in front. Re-focusing makes the Return land where the text went.
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
 * Reveal the session's Terminal window/tab WITHOUT stealing keyboard focus.
 *
 * Selecting the tab is a background-safe scriptable write; raising is the
 * Accessibility `AXRaise` action, which surfaces the window WITHOUT activating
 * Terminal (your keystrokes keep flowing to whatever you're typing in) and
 * WITHOUT switching Spaces. The one thing it can't do — because macOS layers
 * windows per-app — is lift the terminal above a *different* frontmost app that's
 * covering it; there it silently no-ops, and the caller should lean on the audio
 * cue instead of a focus-stealing `activate`. Uses the same Accessibility grant
 * conch already needs for keystroke injection — no new permission.
 */
export async function revealSessionWindow(sessionPid: number): Promise<boolean> {
  try {
    const tty = (await $`ps -o tty= -p ${sessionPid}`.quiet().text()).trim();
    if (!tty || tty === "??") return false;
    const script = `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/${tty}" then
        set selected tab of w to t
        set winName to name of w
        try
          tell application "System Events" to perform action "AXRaise" of (first window of process "Terminal" whose name is winName)
        end try
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

/**
 * Bring the Terminal window/tab hosting the session's tty to the front, ACTIVATING
 * it (steals focus) — only for injection, where keystrokes must land in it. The
 * session pid's controlling tty (ps) matches Terminal's per-tab `tty` property.
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

export async function toClipboard(text: string): Promise<void> {
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

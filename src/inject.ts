import { $ } from "bun";
import { appendFileSync } from "node:fs";
import type { Config } from "./config.ts";

export type InjectRoute = "tmux" | "osascript-focused" | "osascript-blind" | "clipboard" | "none";
export interface InjectTextResult {
  via: InjectRoute;
  interrupted?: true;
  /** Why we fell back to the clipboard — the two causes need different fixes. */
  reason?:
    | "keystroke-fallback-off"
    | "window-not-focusable"
    | "session-not-routable"
    /** A modal dialog on the Mac is swallowing every AppleScript call. */
    | "system-dialog-blocking";
}

export interface InjectTextOptions {
  /** Phone traffic must never type into whichever unrelated app happens to be frontmost. */
  allowBlindFallback?: boolean;
  /** Test seam for proving the no-blind-route branch without mutating the real clipboard. */
  copyToClipboard?(text: string): Promise<void>;
}

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
  beforeInject?: () => boolean | Promise<boolean>,
  options: InjectTextOptions = {},
): Promise<InjectTextResult> {
  const submit = cfg.autoSubmit;
  // Step-level timing, because three plausible theories about why an inject
  // stalls were all wrong when checked against data — a pause gate injects
  // never reach, an event loop that was never blocked, and a keystroke cost
  // that does not correlate with length (1414 chars succeeded; 49 failed).
  // The path has several awaits that can each hang for their own reasons, and
  // nothing said which one. CONCH_DEBUG_INJECT=1 makes it say.
  // Always on, not behind an env var. The supervisor respawns the daemon with
  // its own command, so an env-gated probe silently never activates — which is
  // exactly what happened, wasting a whole retry. A handful of appends per
  // inject is nothing next to another round of guessing.
  const debugInject = process.env.CONCH_DEBUG_INJECT !== "0";
  const startedAt = Date.now();
  const step = (name: string): void => {
    if (!debugInject) return;
    // Straight to a file, never console.error: the daemon owns an alt-screen
    // TUI and its stderr goes nowhere visible, so the first attempt at this
    // produced an empty log and looked like "the code never ran" when it had.
    try {
      appendFileSync(
        "/tmp/conch-inject-debug.log",
        `[${new Date().toISOString().slice(11, 23)} +${Date.now() - startedAt}ms] ${name}\n`,
      );
    } catch {}
  };
  step(`begin pid=${sessionPid ?? "none"} chars=${text.length}`);
  const copyToClipboard = options.copyToClipboard ?? toClipboard;
  const mayInject = async (): Promise<boolean> => beforeInject ? await beforeInject() : true;
  const interrupted = (): InjectTextResult => ({ via: "none", interrupted: true });
  if (sessionPid) {
    const pane = await findTmuxPane(sessionPid);
    step(`findTmuxPane -> ${pane ?? "none"}`);
    if (pane) {
      if (!(await mayInject())) return interrupted();
      // `-l --`: -l sends the text as literal keys, -- stops flag parsing so a
      // transcript starting with "-" isn't read as an option (which both fails
      // AND used to throw, killing the daemon). nothrow + exit check so any
      // send-keys refusal falls through to clipboard instead of crashing.
      const r = await $`tmux send-keys -t ${pane} -l -- ${text}`.quiet().nothrow();
      step(`tmux send-keys exit=${r.exitCode}`);
      if (r.exitCode === 0) {
        if (submit) {
          if (!(await mayInject())) return interrupted();
          await $`tmux send-keys -t ${pane} Enter`.quiet().nothrow();
        }
        return { via: "tmux" };
      }
    }
  }

  if (cfg.keystrokeFallback) {
    if (!sessionPid && options.allowBlindFallback === false) {
      if (!(await mayInject())) return interrupted();
      await copyToClipboard(text);
      return { via: "clipboard", reason: "session-not-routable" };
    }
    const focused = sessionPid ? await focusSessionWindow(sessionPid) : false;
    step(`focusSessionWindow -> ${focused}`);
    if (!focused && sessionPid) {
      // We know which session this is for but can't put its window in
      // front — typing would land somewhere unknowable. Clipboard instead.
      if (!(await mayInject())) return interrupted();
      await copyToClipboard(text);
      // "Not focusable" and "a dialog ate the request" look identical from
      // here but mean completely different things to the person holding the
      // phone: one is a session conch cannot reach, the other is a popup on
      // the Mac that will keep blocking every send until it is dismissed.
      return {
        via: "clipboard",
        reason: osaLastTimedOut() ? "system-dialog-blocking" : "window-not-focusable",
      };
    }
    if (focused) await Bun.sleep(300); // let the window raise settle
    if (!(await mayInject())) return interrupted();
    const typist = Bun.spawn(
      ["osascript", "-e", "on run argv", "-e", 'tell application "System Events" to keystroke (item 1 of argv)', "-e", "end run", "--", text],
      { stdout: "ignore", stderr: "ignore" },
    );
    const typed = await Promise.race([
      typist.exited.then(() => "done" as const),
      Bun.sleep(OSA_TIMEOUT_MS).then(() => "timeout" as const),
    ]);
    if (typed === "timeout") {
      try {
        typist.kill();
      } catch {}
      step("osascript keystroke TIMED OUT — something modal is in front");
      await copyToClipboard(text);
      return { via: "clipboard", reason: "system-dialog-blocking" };
    }
    step("osascript keystroke returned");
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
      if (!(await mayInject())) return interrupted();
      if (focused && sessionPid) await focusSessionWindow(sessionPid);
      if (!(await mayInject())) return interrupted();
      await osa('tell application "System Events" to key code 36');
    }
    return { via: focused ? "osascript-focused" : "osascript-blind" };
  }

  if (!(await mayInject())) return interrupted();
  await copyToClipboard(text);
  return { via: "clipboard", reason: "keystroke-fallback-off" };
}

/** Run osascript with one or more `-e` statements, output discarded. */
/**
 * How long any AppleScript may take before we give up on it.
 *
 * A modal system dialog — a TCC permission prompt, a security agent — freezes
 * every System Events call for as long as it is on screen. Measured on Tyler's
 * Mac while a permission popup was showing: `focusSessionWindow` took 122,891
 * milliseconds and then failed anyway, three sends in a row, with the daemon's
 * whole queue stacked up behind it ("blocked behind inject:conch"). From the
 * phone that looked like conch silently refusing to send.
 *
 * Nothing here is worth two minutes. Focusing a window either works in about a
 * second or something is in the way, and knowing that quickly is what lets the
 * caller say something useful instead of hanging.
 */
const OSA_TIMEOUT_MS = 4_000;

/** True when the last AppleScript gave up rather than finished. */
let lastOsaTimedOut = false;

export function osaLastTimedOut(): boolean {
  return lastOsaTimedOut;
}

/**
 * Run an AppleScript and read its output, but never wait forever.
 *
 * Reading the child's stdout is precisely where a blocked System Events call
 * parks: a stack sample of the wedged daemon sat in `__read_nocancel`, which is
 * this read waiting on an osascript that a modal dialog had frozen.
 */
async function osaText(script: string): Promise<{ text: string; timedOut: boolean }> {
  const child = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "ignore" });
  const read = new Response(child.stdout).text().then((text) => ({ text, timedOut: false }));
  const timeout = Bun.sleep(OSA_TIMEOUT_MS).then(() => ({ text: "", timedOut: true }));
  const result = await Promise.race([read, timeout]);
  if (result.timedOut) {
    lastOsaTimedOut = true;
    try {
      child.kill();
    } catch {}
    return result;
  }
  lastOsaTimedOut = false;
  return result;
}

async function osa(...lines: string[]): Promise<number> {
  const child = Bun.spawn(["osascript", ...lines.flatMap((l) => ["-e", l])], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const timeout = Bun.sleep(OSA_TIMEOUT_MS).then(() => "timeout" as const);
  const result = await Promise.race([child.exited, timeout]);
  if (result === "timeout") {
    lastOsaTimedOut = true;
    // Kill it, or the stuck osascript outlives the daemon's interest in it and
    // a long session accumulates one blocked process per attempt.
    try {
      child.kill();
    } catch {}
    return 1;
  }
  lastOsaTimedOut = false;
  return result;
}

/** Press a single key in the session — Enter accepts a permission dialog's highlighted option, Escape dismisses it. */
export async function injectKey(
  cfg: Config,
  sessionPid: number | undefined,
  key: "Enter" | "Escape",
  beforeInject?: () => boolean | Promise<boolean>,
): Promise<InjectTextResult> {
  const mayInject = async (): Promise<boolean> => beforeInject ? await beforeInject() : true;
  const interrupted = (): InjectTextResult => ({ via: "none", interrupted: true });
  if (sessionPid) {
    const pane = await findTmuxPane(sessionPid);
    if (pane) {
      if (!(await mayInject())) return interrupted();
      const r = await $`tmux send-keys -t ${pane} ${key}`.quiet().nothrow();
      if (r.exitCode === 0) return { via: "tmux" };
    }
  }
  if (cfg.keystrokeFallback) {
    const focused = sessionPid ? await focusSessionWindow(sessionPid) : false;
    if (!focused && sessionPid) {
      if (!(await mayInject())) return interrupted();
      return { via: "none" }; // never press keys in an unknown window
    }
    if (focused) await Bun.sleep(300);
    if (!(await mayInject())) return interrupted();
    const keyCode = key === "Enter" ? 36 : 53;
    await osa(`tell application "System Events" to key code ${keyCode}`);
    return { via: focused ? "osascript-focused" : "osascript-blind" };
  }
  if (!(await mayInject())) return interrupted();
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
    const { text: out } = await osaText(script);
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

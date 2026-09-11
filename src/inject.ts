import { $ } from "bun";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";

export type InjectRoute = "tmux" | "osascript-focused" | "clipboard" | "none";
export interface InjectTextResult {
  via: InjectRoute;
  interrupted?: true;
  /** Why we fell back to the clipboard — the causes need different fixes. */
  reason?:
    | "keystroke-fallback-off"
    | "window-not-focusable"
    | "session-not-routable"
    /** A modal dialog on the Mac is swallowing every AppleScript call. */
    | "system-dialog-blocking"
    /** macOS is refusing to let conch drive other apps. Needs a person. */
    | "automation-permission-denied"
    /** Something else came to the front between the raise and the typing. */
    | "front-window-changed";
}

/** Run an AppleScript (`-e` lines, then `--` argv) and read its stdout, bounded. */
export type OsaRunner = (lines: string[], argv?: string[]) => Promise<{ text: string; timedOut: boolean }>;

export interface InjectTextOptions {
  /** Test seam for proving the clipboard branches without mutating the real clipboard. */
  copyToClipboard?(text: string): Promise<void>;
  /** Test seam: every AppleScript the route runs goes through here. */
  osa?: OsaRunner;
  /** Test seam: the controlling tty of a pid, as `ps -o tty=` prints it. */
  ttyForPid?(pid: number): Promise<string>;
}

/**
 * Where the step log goes. Beside the daemon log, so a suite that redirects
 * `CONCH_LOG_FILE` (test/preload.ts) never writes into the live file — every
 * `bun test` used to leave three `pid=none` ghosts in /tmp (audit 5a).
 */
export const INJECT_DEBUG_LOG = process.env.CONCH_INJECT_DEBUG_LOG
  || join(dirname(process.env.CONCH_LOG_FILE || "/tmp/conch-daemon.log"), "conch-inject-debug.log");

/**
 * Deliver a transcript into the session's prompt.
 *
 * Routes, best first:
 *  - tmux send-keys at the pane hosting the session's pid — exact, works unfocused
 *  - osascript keystrokes AFTER focusing the session's Terminal window
 *    (matched by tty) and confirming it is still in front — for plain-terminal users
 *  - clipboard — when typing would go into the void, the words are at least
 *    one Cmd-V away ("injected via osascript" that lands nowhere loses the
 *    user's whole utterance; observed live)
 *
 * There is no blind route. A turn with no pid used to be typed into whatever
 * app was frontmost (audit 3c); nothing ever wanted that.
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
        INJECT_DEBUG_LOG,
        `[${new Date().toISOString().slice(11, 23)} +${Date.now() - startedAt}ms] ${name}\n`,
      );
    } catch {}
  };
  step(`begin pid=${sessionPid ?? "none"} chars=${text.length}`);
  const copyToClipboard = options.copyToClipboard ?? toClipboard;
  const osa = options.osa ?? runOsa;
  const ttyForPid = options.ttyForPid ?? ttyOf;
  const mayInject = async (): Promise<boolean> => beforeInject ? await beforeInject() : true;
  const interrupted = (): InjectTextResult => ({ via: "none", interrupted: true });
  const clipboard = async (reason: NonNullable<InjectTextResult["reason"]>): Promise<InjectTextResult> => {
    if (!(await mayInject())) return interrupted();
    await copyToClipboard(text);
    step(`clipboard (${reason})`);
    return { via: "clipboard", reason };
  };
  if (!sessionPid) return clipboard("session-not-routable");

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

  if (!cfg.keystrokeFallback) return clipboard("keystroke-fallback-off");

  const tty = await ttyForPid(sessionPid);
  const focused = tty ? await focusSessionWindow(tty, osa) : false;
  step(`focusSessionWindow -> ${focused}`);
  if (!focused) {
    // We know which session this is for but can't put its window in
    // front — typing would land somewhere unknowable. Clipboard instead.
    // "Not focusable" and "a dialog ate the request" look identical from
    // here but mean completely different things to the person holding the
    // phone: one is a session conch cannot reach, the other is a popup on
    // the Mac that will keep blocking every send until it is dismissed.
    return clipboard(
      osaLastDenied()
        ? "automation-permission-denied"
        : osaLastTimedOut()
          ? "system-dialog-blocking"
          : "window-not-focusable",
    );
  }
  await Bun.sleep(300); // let the window raise settle
  if (!(await mayInject())) return interrupted();
  // The raise returned seconds ago in wall-clock terms once a long dictation
  // is queued behind it; a Cmd-Tab, a click or a notification in that gap
  // would have put the rest of the sentence into some other app. Look before
  // typing: the front window's selected tab must be this session's tty.
  if (!(await targetInFront(tty, osa))) {
    step("front window is not the session's — not typing");
    return clipboard("front-window-changed");
  }
  const typed = await osa(
    ["on run argv", 'tell application "System Events" to keystroke (item 1 of argv)', "end run"],
    [text],
  );
  if (typed.timedOut) {
    step("osascript keystroke TIMED OUT — something modal is in front");
    return clipboard("system-dialog-blocking");
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
    await focusSessionWindow(tty, osa);
    if (!(await mayInject())) return interrupted();
    // The text is already in the right window; a Return into the wrong one is
    // the only thing left to get wrong. The caller's confirm-by-transcript
    // loop re-presses through `injectKey`, which looks again.
    if (await targetInFront(tty, osa)) await osa(['tell application "System Events" to key code 36']);
    else step("front window changed before Return — not pressing it");
  }
  return { via: "osascript-focused" };
}

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
 * True when macOS is refusing to let conch drive other apps at all.
 *
 * This is not a transient failure and no retry touches it: someone has to
 * grant the permission. It became reachable the day the daemon moved inside
 * the Mac app — TCC decides per responsible process, so conch.app was asked
 * fresh for permission it had never needed while launchd was its parent, and
 * the answer that came back was no.
 */
let lastOsaDenied = false;

export function osaLastDenied(): boolean {
  return lastOsaDenied;
}

/** macOS: "Not authorized to send Apple events to <app>". */
const OSA_NOT_AUTHORIZED = /-1743|not authori[sz]ed|Not allowed to send Apple events/i;

/**
 * The one osascript spawn. Reading the child's stdout is precisely where a
 * blocked System Events call parks: a stack sample of the wedged daemon sat in
 * `__read_nocancel`, which is this read waiting on an osascript that a modal
 * dialog had frozen — so every call races the timeout and kills the loser.
 */
async function runOsa(lines: string[], argv: string[] = []): Promise<{ text: string; timedOut: boolean }> {
  const args = [...lines.flatMap((line) => ["-e", line]), ...(argv.length ? ["--", ...argv] : [])];
  const child = Bun.spawn(["osascript", ...args], { stdout: "pipe", stderr: "pipe" });
  const read = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([text, err]) => {
    lastOsaDenied = OSA_NOT_AUTHORIZED.test(err);
    return { text, timedOut: false };
  });
  const timeout = Bun.sleep(OSA_TIMEOUT_MS).then(() => ({ text: "", timedOut: true }));
  const result = await Promise.race([read, timeout]);
  if (result.timedOut) {
    lastOsaTimedOut = true;
    // Kill it, or the stuck osascript outlives the daemon's interest in it and
    // a long session accumulates one blocked process per attempt.
    try {
      child.kill();
    } catch {}
    return result;
  }
  lastOsaTimedOut = false;
  return result;
}

/** The controlling tty of a pid (`ttys003`), or "" when it has none. */
async function ttyOf(pid: number): Promise<string> {
  try {
    const tty = (await $`ps -o tty= -p ${pid}`.quiet().text()).trim();
    return !tty || tty === "??" ? "" : tty;
  } catch {
    return "";
  }
}

/** Press a single key in the session — Enter accepts a permission dialog's highlighted option, Down moves to the next one, Escape dismisses it. */
export async function injectKey(
  cfg: Config,
  sessionPid: number | undefined,
  key: "Enter" | "Escape" | "Down",
  beforeInject?: () => boolean | Promise<boolean>,
  options: Pick<InjectTextOptions, "osa" | "ttyForPid"> = {},
): Promise<InjectTextResult> {
  const osa = options.osa ?? runOsa;
  const ttyForPid = options.ttyForPid ?? ttyOf;
  const mayInject = async (): Promise<boolean> => beforeInject ? await beforeInject() : true;
  const interrupted = (): InjectTextResult => ({ via: "none", interrupted: true });
  if (!sessionPid) return { via: "none" }; // never press keys in an unknown window
  const pane = await findTmuxPane(sessionPid);
  if (pane) {
    if (!(await mayInject())) return interrupted();
    const r = await $`tmux send-keys -t ${pane} ${key}`.quiet().nothrow();
    if (r.exitCode === 0) return { via: "tmux" };
  }
  if (!cfg.keystrokeFallback) {
    if (!(await mayInject())) return interrupted();
    return { via: "none" };
  }
  const tty = await ttyForPid(sessionPid);
  const focused = tty ? await focusSessionWindow(tty, osa) : false;
  if (!focused) {
    if (!(await mayInject())) return interrupted();
    return { via: "none" };
  }
  await Bun.sleep(300);
  if (!(await mayInject())) return interrupted();
  if (!(await targetInFront(tty, osa))) return { via: "none" };
  const keyCode = key === "Enter" ? 36 : key === "Down" ? 125 : 53;
  await osa([`tell application "System Events" to key code ${keyCode}`]);
  return { via: "osascript-focused" };
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
export async function revealSessionWindow(sessionPid: number, osa: OsaRunner = runOsa): Promise<boolean> {
  try {
    const tty = await ttyOf(sessionPid);
    if (!tty) return false;
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
    const { text: out } = await osa([script]);
    return out.trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Bring the Terminal window/tab hosting this tty to the front, ACTIVATING it
 * (steals focus) — only for injection, where keystrokes must land in it. The
 * session pid's controlling tty (ps) matches Terminal's per-tab `tty` property.
 */
async function focusSessionWindow(tty: string, osa: OsaRunner): Promise<boolean> {
  try {
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
    const { text: out } = await osa([script]);
    return out.trim() === "ok";
  } catch {
    return false;
  }
}

/** The AppleScript that names what a keystroke would land in right now. */
export const FRONT_TTY_SCRIPT = `
tell application "System Events" to set frontName to name of first application process whose frontmost is true
if frontName is not "Terminal" then return "front:" & frontName
tell application "Terminal" to return tty of selected tab of front window`;

/**
 * Is the session's tab what a keystroke would land in right now? Asked right
 * before every synthesized key: the same tty match that selected the tab,
 * read back from the front window. Anything else — another app in front, a
 * different tab, an unreadable answer — is a no, and no means the clipboard.
 */
async function targetInFront(tty: string, osa: OsaRunner): Promise<boolean> {
  try {
    const { text, timedOut } = await osa([FRONT_TTY_SCRIPT]);
    return !timedOut && text.trim() === `/dev/${tty}`;
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

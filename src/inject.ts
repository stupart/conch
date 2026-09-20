import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { createPasteboard, hasUnreapedUIChild, pasteboardRefusal, runUICommand, type Pasteboard, type PasteboardLease } from "./pasteboard.ts";

export type InjectRoute = "tmux" | "osascript-focused" | "clipboard" | "none";
export interface InjectTextResult {
  via: InjectRoute;
  interrupted?: true;
  failed?: true;
  /** Why delivery failed or used the clipboard fallback. */
  reason?:
    | "keystroke-fallback-off"
    | "window-not-focusable"
    | "session-not-routable"
    /** A modal dialog on the Mac is swallowing every AppleScript call. */
    | "system-dialog-blocking"
    /** macOS is refusing to let conch drive other apps. Needs a person. */
    | "automation-permission-denied"
    /** Something else came to the front between the raise and the typing. */
    | "front-window-changed"
    | "automation-failed"
    | "clipboard-changed"
    | "clipboard-unavailable"
    /** The clipboard holds something conch could not put back, so it left it alone. */
    | "clipboard-unpreservable"
    | "submit-failed";
}

/**
 * A delivery that did not land, as the caller waiting on it is told.
 *
 * The reasons above were known here and nowhere else: the daemon spoke them aloud on the
 * Mac and told the phone only "failed". A dialog open on Tyler's Mac ate three sends from
 * his phone on 2026-09-16 and nothing he could see said so. This is how the cause leaves
 * the Mac — an `InjectTextResult["reason"]`, or a delivery-level code from the voice loop
 * (`delivery-unconfirmed`, `delivery-unattributed`, `transport-error`), whichever named
 * the failure. Absent when conch cannot name one; the apps then say only "Not delivered".
 */
export interface SendFailure {
  delivered: false;
  reason?: string;
  /** The text is on the Mac's clipboard, so it is a paste away rather than lost. */
  onClipboard?: true;
}

/** Run an AppleScript (`-e` lines, then `--` argv) and read its stdout, bounded. */
export interface OsaResult { text: string; timedOut: boolean; exitCode?: number; stderr?: string }
export type OsaRunner = (lines: string[], argv?: string[]) => Promise<OsaResult>;

export interface InjectTextOptions {
  /** Set false to skip failure-only clipboard fallback; successful paste still uses it. */
  clipboardFallback?: boolean;
  /** Test seam for proving the clipboard branches without mutating the real clipboard. */
  copyToClipboard?(text: string): Promise<void>;
  /** Test seam: every AppleScript the route runs goes through here. */
  osa?: OsaRunner;
  /** Test seam: the controlling tty of a pid, as `ps -o tty=` prints it. */
  ttyForPid?(pid: number): Promise<string>;
  /** Test seam: resolve a tmux route without probing real processes or panes. */
  findTmuxPane?(pid: number): Promise<string | null>;
  sleep?(ms: number): Promise<void>;
  pasteboard?: Pasteboard;
  sendTmuxKeys?(pane: string, text: string, literal: boolean): Promise<{ exitCode: number }>;
}

// Keyboard focus and the pasteboard are global resources. This FIFO is separate
// from the daemon's audio queue; rejecting one action never poisons later work.
let uiQueue = Promise.resolve();
/** Wrap raw UI work only; calling another serialized injector here would nest the lock. */
export function withUITransaction<T>(work: () => Promise<T>): Promise<T> {
  const result = uiQueue.then(() => {
    if (hasUnreapedUIChild()) throw new Error("Previous UI child has not exited; input is suspended");
    return work();
  });
  uiQueue = result.then(() => {}, () => {});
  return result;
}

export function injectText(
  cfg: Config, sessionPid: number | undefined, text: string,
  beforeInject?: () => boolean | Promise<boolean>, options: InjectTextOptions = {},
): Promise<InjectTextResult> {
  return withUITransaction(() => injectTextInTransaction(cfg, sessionPid, text, beforeInject, options));
}

export function injectKey(
  cfg: Config, sessionPid: number | undefined, key: "Enter" | "Escape" | "Down",
  beforeInject?: () => boolean | Promise<boolean>, options: InjectTextOptions = {},
): Promise<InjectTextResult> {
  return withUITransaction(() => injectKeyInTransaction(cfg, sessionPid, key, beforeInject, options));
}

export function revealSessionWindow(sessionPid: number, osa: OsaRunner = runOsa, ttyForPid = ttyOf): Promise<boolean> {
  return withUITransaction(() => revealSessionWindowInTransaction(sessionPid, osa, ttyForPid));
}

const failed = (reason: NonNullable<InjectTextResult["reason"]>): InjectTextResult => ({ via: "none", failed: true, reason });
const osaSucceeded = (result: OsaResult): boolean => !result.timedOut && (result.exitCode ?? 0) === 0
  && !["front-window-changed", "clipboard-changed"].includes(result.text.trim());
function osaFailure(result: OsaResult): NonNullable<InjectTextResult["reason"]> {
  if (result.timedOut) return "system-dialog-blocking";
  if (/-1743|not authori[sz]ed|Not allowed to send Apple events/i.test(result.stderr ?? "")) return "automation-permission-denied";
  if (result.text.trim() === "front-window-changed") return "front-window-changed";
  return result.text.trim() === "clipboard-changed" ? "clipboard-changed" : "automation-failed";
}
function safeOsa(run: OsaRunner): OsaRunner {
  return async (lines, argv) => {
    try { return await run(lines, argv); }
    catch { return { text: "", timedOut: false, exitCode: -1 }; }
  };
}
const sendTmuxKeys = (pane: string, text: string, literal: boolean) => runUICommand([
  "tmux", "send-keys", "-t", pane, ...(literal ? ["-l", "--"] : []), text,
]);

/**
 * Longer than this, or across lines, words are pasted rather than typed.
 *
 * System Events types one keystroke at a time. A long message outlives the AppleScript bound, and a timed-out
 * `keystroke` carries on typing after conch has given up, into whatever is in front, beeping at every character
 * nothing takes: Tyler sent a long reply to a Codex session and had to force-quit out of the noise (2026-09-14). A
 * typed newline is also a Return, which sent multi-line messages in pieces. A paste arrives whole, in one event.
 */
export const PASTE_OVER_CHARS = 280;

const PASTE_KEYSTROKE = 'tell application "System Events" to keystroke "v" using command down';

/**
 * The general pasteboard's version, read straight after conch writes its own text onto it.
 *
 * The paste script compares it at the instant it presses Cmd-V, so a copy landing in between —
 * the user's, in the seconds conch spends raising a window — stops the paste instead of
 * submitting their clipboard into the session.
 *
 * ponytail: the sliver between pbcopy exiting and this read is unguarded; closing it needs the
 * whole text back out of the board to compare, and the race that bites is the long one.
 */
const CLIPBOARD_VERSION_SCRIPT = [
  'use framework "AppKit"',
  "use scripting additions",
  "set pasteboard to current application's NSPasteboard's generalPasteboard()",
  "return (pasteboard's changeCount()) as integer",
];

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
async function injectTextInTransaction(
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
  const copyToClipboard = options.copyToClipboard ?? writeClipboard;
  const pasteboard = options.pasteboard ?? createPasteboard();
  const osa = safeOsa(options.osa ?? runOsa);
  const ttyForPid = options.ttyForPid ?? ttyOf;
  const sleep = options.sleep ?? Bun.sleep;
  const mayInject = async (): Promise<boolean> => beforeInject ? await beforeInject() : true;
  const interrupted = (): InjectTextResult => ({ via: "none", interrupted: true });
  const clipboard = async (reason: NonNullable<InjectTextResult["reason"]>): Promise<InjectTextResult> => {
    if (!(await mayInject())) return interrupted();
    if (options.clipboardFallback === false) return failed(reason);
    try { await copyToClipboard(text); } catch { return failed("clipboard-unavailable"); }
    step(`clipboard (${reason})`);
    return { via: "clipboard", reason };
  };
  if (!sessionPid) return clipboard("session-not-routable");

  const pane = await (options.findTmuxPane ?? findTmuxPane)(sessionPid);
  step(`findTmuxPane -> ${pane ?? "none"}`);
  if (pane) {
    if (!(await mayInject())) return interrupted();
    // `-l --`: -l sends the text as literal keys, -- stops flag parsing so a
    // transcript starting with "-" isn't read as an option (which both fails
    // AND used to throw, killing the daemon). nothrow + exit check so any
    // send-keys refusal falls through to clipboard instead of crashing.
    const r = await (options.sendTmuxKeys ?? sendTmuxKeys)(pane, text, true);
    step(`tmux send-keys exit=${r.exitCode}`);
    if (r.exitCode === 0) {
      if (submit) {
        if (!(await mayInject())) return interrupted();
        const submitted = await (options.sendTmuxKeys ?? sendTmuxKeys)(pane, "Enter", false);
        if (submitted.exitCode !== 0) return failed("submit-failed");
      }
      return { via: "tmux" };
    }
  }

  if (!cfg.keystrokeFallback) return clipboard("keystroke-fallback-off");

  const tty = await ttyForPid(sessionPid);
  const focus = tty ? await focusSessionWindow(tty, osa) : null;
  step(`focusSessionWindow -> ${focus?.text.trim() ?? "none"}`);
  if (!focus || !osaSucceeded(focus) || focus.text.trim() !== "ok") {
    return clipboard(focus && !osaSucceeded(focus) ? osaFailure(focus) : "window-not-focusable");
  }
  await sleep(300); // let the window raise settle
  if (!(await mayInject())) return interrupted();
  // The raise returned seconds ago in wall-clock terms once a long dictation
  // is queued behind it; a Cmd-Tab, a click or a notification in that gap
  // would have put the rest of the sentence into some other app. Look before
  // typing: the front window's selected tab must be this session's tty.
  const front = await osa([FRONT_TTY_SCRIPT]);
  if (!osaSucceeded(front) || front.text.trim() !== `/dev/${tty}`) {
    step("front window is not the session's — not typing");
    return clipboard(!osaSucceeded(front) ? osaFailure(front) : "front-window-changed");
  }
  let typed: OsaResult;
  if (text.length > PASTE_OVER_CHARS || text.includes("\n")) {
    // A broken helper must not cost the message. Preserving the clipboard is a courtesy;
    // delivering the words is the job. When the JXA program refused every ordinary
    // clipboard (its size guard concatenated bridged strings), this path returned
    // clipboard-unavailable and NOTHING was sent — every paste-length send failed while a
    // normal Chrome copy sat on the board. So a failure here drops the capture, not the send.
    let lease: PasteboardLease | undefined;
    let refused: NonNullable<InjectTextResult["reason"]> | undefined;
    try { lease = await pasteboard.prepare(text); } catch (error) { refused = pasteboardRefusal(error); }
    // A refusal is not a broken helper. The helper declines a clipboard it cannot put back, and
    // copying over that one anyway is the single outcome it exists to prevent. It says so
    // instead; the words go back to the draft, where they were already going.
    if (refused) return failed(refused);
    if (lease) {
      try {
        // Approval/request validity is checked after every awaited setup step.
        if (!(await mayInject())) return interrupted();
        typed = await focusedAction(tty, osa, [PASTE_KEYSTROKE], [], lease.changeCount);
        step(`osascript paste returned (${text.length} chars)`);
        await sleep(150);
      } finally {
        // A restore that throws must not turn a paste that LANDED into a reported failure.
        try { await pasteboard.restore(lease); } catch { step("clipboard restore failed"); }
      }
    } else {
      if (!(await mayInject())) return interrupted();
      try { await copyToClipboard(text); } catch { return failed("clipboard-unavailable"); }
      // The capture never happened, but ownership still has to be proven. Take the board's
      // version right after writing and the paste refuses if anything moved it: without this,
      // a copy made while the window was being raised was what got submitted.
      const version = await osa(CLIPBOARD_VERSION_SCRIPT);
      step(`clipboard version -> ${version.text.trim() || "none"}`);
      if (!osaSucceeded(version) || !/^\d+$/.test(version.text.trim())) return failed("clipboard-unavailable");
      // Every await is a place the send can be cancelled or superseded, here as on the guarded path.
      if (!(await mayInject())) return interrupted();
      typed = await focusedAction(tty, osa, [PASTE_KEYSTROKE], [], Number(version.text.trim()));
      step(`osascript paste returned, clipboard NOT preserved (${text.length} chars)`);
      await sleep(150);
    }
  } else {
    if (!(await mayInject())) return interrupted();
    typed = await focusedAction(tty, osa, ['tell application "System Events" to keystroke (item 1 of argv)'], [text]);
    step("osascript keystroke returned");
  }
  if (!osaSucceeded(typed)) return failed(osaFailure(typed));
  if (submit) {
    // Separate, delayed Return: bundling it with the text arrived before the
    // terminal finished ingesting the keystrokes. Scale the settle to the
    // transcript length — a long dictation's keystrokes can still be landing
    // when a fixed 250ms Return fires, so the submit is dropped ("typed but
    // didn't send", observed on long messages). Capped so short prompts stay snappy.
    await sleep(250 + Math.min(text.length * 3, 1000));
    // Re-assert focus first: in that gap the frontmost window can drift (a
    // notification, the window losing front), and a bare `key code 36` goes to
    // whatever's in front. Re-focusing makes the Return land where the text went.
    if (!(await mayInject())) return interrupted();
    const refocused = await focusSessionWindow(tty, osa);
    if (!osaSucceeded(refocused) || refocused.text.trim() !== "ok") return failed(osaFailure(refocused));
    if (!(await mayInject())) return interrupted();
    const submitted = await focusedAction(tty, osa, ['tell application "System Events" to key code 36']);
    if (!osaSucceeded(submitted)) return failed(osaFailure(submitted));
  }
  return { via: "osascript-focused" };
}

/** The process deadline covers stdout, stderr, and exit, with per-call errors. */
async function runOsa(lines: string[], argv: string[] = []): Promise<OsaResult> {
  return runUICommand(["osascript", ...lines.flatMap((line) => ["-e", line]), ...(argv.length ? ["--", ...argv] : [])]);
}

/** The controlling tty of a pid (`ttys003`), or "" when it has none. */
async function ttyOf(pid: number): Promise<string> {
  try {
    const result = await runUICommand(["ps", "-o", "tty=", "-p", String(pid)]);
    if (result.timedOut || result.exitCode !== 0) return "";
    const tty = result.text.trim();
    return !tty || tty === "??" ? "" : tty;
  } catch {
    return "";
  }
}

/** Press a single key in the session — Enter accepts a permission dialog's highlighted option, Down moves to the next one, Escape dismisses it. */
async function injectKeyInTransaction(
  cfg: Config,
  sessionPid: number | undefined,
  key: "Enter" | "Escape" | "Down",
  beforeInject?: () => boolean | Promise<boolean>,
  options: InjectTextOptions = {},
): Promise<InjectTextResult> {
  const osa = safeOsa(options.osa ?? runOsa);
  const ttyForPid = options.ttyForPid ?? ttyOf;
  const mayInject = async (): Promise<boolean> => beforeInject ? await beforeInject() : true;
  const interrupted = (): InjectTextResult => ({ via: "none", interrupted: true });
  if (!sessionPid) return { via: "none" }; // never press keys in an unknown window
  const pane = await (options.findTmuxPane ?? findTmuxPane)(sessionPid);
  if (pane) {
    if (!(await mayInject())) return interrupted();
    const r = await (options.sendTmuxKeys ?? sendTmuxKeys)(pane, key, false);
    if (r.exitCode === 0) return { via: "tmux" };
  }
  if (!cfg.keystrokeFallback) {
    if (!(await mayInject())) return interrupted();
    return { via: "none" };
  }
  const tty = await ttyForPid(sessionPid);
  const focused = tty ? await focusSessionWindow(tty, osa) : null;
  if (!focused || !osaSucceeded(focused) || focused.text.trim() !== "ok") {
    if (!(await mayInject())) return interrupted();
    return failed(focused ? osaFailure(focused) : "window-not-focusable");
  }
  await (options.sleep ?? Bun.sleep)(300);
  if (!(await mayInject())) return interrupted();
  const keyCode = key === "Enter" ? 36 : key === "Down" ? 125 : 53;
  const pressed = await focusedAction(tty, osa, [`tell application "System Events" to key code ${keyCode}`]);
  return osaSucceeded(pressed)
    ? { via: "osascript-focused" } : failed(osaFailure(pressed));
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
async function revealSessionWindowInTransaction(sessionPid: number, osa: OsaRunner, ttyForPid: (pid: number) => Promise<string>): Promise<boolean> {
  try {
    const tty = await ttyForPid(sessionPid);
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
    const result = await osa([script]);
    return osaSucceeded(result) && result.text.trim() === "ok";
  } catch {
    return false;
  }
}

/**
 * Bring the Terminal window/tab hosting this tty to the front, ACTIVATING it
 * (steals focus) — only for injection, where keystrokes must land in it. The
 * session pid's controlling tty (ps) matches Terminal's per-tab `tty` property.
 */
export async function focusSessionWindow(tty: string, osa: OsaRunner): Promise<OsaResult> {
  try {
    const script = `
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/${tty}" then
        activate
        set index of w to 1
        set selected tab of w to t
        return "ok"
      end if
    end repeat
  end repeat
end tell
return "notfound"`;
    return await osa([script]);
  } catch {
    return { text: "", timedOut: false, exitCode: -1 };
  }
}

/** The AppleScript that names what a keystroke would land in right now. */
export const FRONT_TTY_SCRIPT = `
tell application "System Events" to set frontName to name of first application process whose frontmost is true
if frontName is not "Terminal" then return "front:" & frontName
tell application "Terminal" to return tty of selected tab of front window`;

/**
 * The question `focusedAction` asks inside the script, right before a key: is
 * Terminal still in front, and is its front tab still this session's (the tty
 * travels as the last argv item)? Exported so an action that presses more than
 * once can ask it again between presses.
 */
export const FOCUS_GUARD_LINES: readonly string[] = [
  "-- conch-focus-guard",
  'tell application "System Events" to set frontName to name of first application process whose frontmost is true',
  'if frontName is not "Terminal" then return "front-window-changed"',
  'tell application "Terminal" to set frontTty to tty of selected tab of front window',
  'if frontTty is not (last item of argv) then return "front-window-changed"',
];

/** Check focus and issue the key in one script, without an inter-process gap. */
export function focusedAction(tty: string, osa: OsaRunner, action: string[], argv: string[] = [], clipboardVersion?: number): Promise<OsaResult> {
  return osa([
    ...(clipboardVersion === undefined ? [] : ['use framework "AppKit"', "use scripting additions"]),
    "on run argv",
    ...FOCUS_GUARD_LINES,
    ...(clipboardVersion === undefined ? [] : [
      "set pasteboard to current application's NSPasteboard's generalPasteboard()",
      'if (pasteboard\'s changeCount() as integer) is not (item 1 of argv as integer) then return "clipboard-changed"',
    ]),
    ...action,
    'return "ok"',
    "end run",
  ], [...argv, ...(clipboardVersion === undefined ? [] : [String(clipboardVersion)]), `/dev/${tty}`]);
}

export function toClipboard(text: string): Promise<void> {
  return withUITransaction(() => writeClipboard(text));
}
async function writeClipboard(text: string): Promise<void> {
  const result = await runUICommand(["pbcopy"], text);
  if (result.timedOut || result.exitCode !== 0) throw new Error("Clipboard write failed");
}

/** Find the tmux pane whose shell is an ancestor of the session's pid. */
async function findTmuxPane(sessionPid: number): Promise<string | null> {
  let panes: Array<{ pid: number; id: string }>;
  try {
    const result = await runUICommand(["tmux", "list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]);
    if (result.timedOut || result.exitCode !== 0) return null;
    const out = result.text;
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
      const result = await runUICommand(["ps", "-o", "ppid=", "-p", String(current)]);
      if (result.timedOut || result.exitCode !== 0) break;
      const out = result.text;
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

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { createConfigController } from "../src/daemon.ts";
import { dispatchSocketTurnEvent, validateSocketTurnEvent } from "../src/control-server.ts";
import { appendHookTrace } from "../src/hook.ts";
import { FRONT_TTY_SCRIPT, INJECT_DEBUG_LOG, injectKey, injectText, type OsaRunner } from "../src/inject.ts";
import { narrationSoxArgs, soxCaptureArgs } from "../src/listen.ts";
import { MIC_CHECK_FILE } from "../src/setup.ts";
import { anyInputDeviceRunning } from "../src/mic-claim.ts";
import { PauseOriginLedger } from "../src/pause-origin.ts";
import { forgetSox, isConchSox, readSoxRecord, reapOrphanedSox, recordSpawnedSox } from "../src/sox-orphan.ts";

/**
 * A17 — what the daemon does to the rest of the Mac (docs/daemon-side-effects.md).
 *
 * Nothing here touches a real window, clipboard, microphone or process: the
 * inject paths run through their seams and the reaper over a fake process table.
 */

/** No process has this pid, so tmux finds no pane and `ps` finds no tty. */
const DEAD_PID = 0x7ffffffe;
const cfg = (keystrokeFallback: boolean, autoSubmit = true): Config =>
  ({ autoSubmit, keystrokeFallback } as Config);

/** An AppleScript runner over fakes: Terminal focuses fine; `front` answers the front-window query. */
function fakeOsa(front: () => string) {
  const calls: Array<{ lines: string[]; argv: string[] }> = [];
  const osa: OsaRunner = async (lines, argv = []) => {
    const script = lines.join("\n");
    if (script.includes("conch-focus-guard") && front().trim() !== argv.at(-1)) {
      return { text: "front-window-changed", timedOut: false };
    }
    calls.push({ lines, argv });
    if (script === FRONT_TTY_SCRIPT) return { text: front() + "\n", timedOut: false };
    if (script.includes("activate")) return { text: "ok\n", timedOut: false };
    return { text: "", timedOut: false };
  };
  const typed = () => calls.filter((c) => c.lines.some((l) => l.includes("keystroke"))).map((c) => c.argv[0]);
  const returns = () => calls.filter((c) => c.lines.some((l) => l.includes("key code 36"))).length;
  return { osa, calls, typed, returns };
}

function fakePasteboard(initial: string, copied: string[]) {
  let value = initial;
  let changeCount = 0;
  return {
    prepare: async (text: string) => {
      const items = value ? [{ text: value }] : [];
      copied.push(text); value = text; changeCount++;
      return { items, changeCount };
    },
    restore: async (lease: { items: Array<Record<string, string>>; changeCount: number }) => {
      if (changeCount !== lease.changeCount) return false;
      value = lease.items[0]?.text ?? ""; copied.push(value); changeCount++;
      return true;
    },
  };
}

describe("1. there is no blind typing route", () => {
  test("a turn with no pid goes to the clipboard with a reason, whatever the caller says", async () => {
    const copied: string[] = [];
    const f = fakeOsa(() => "/dev/ttys001");
    const result = await injectText(cfg(true), undefined, "words", undefined, {
      copyToClipboard: async (t) => { copied.push(t); },
      osa: f.osa,
    });
    expect(result).toEqual({ via: "clipboard", reason: "session-not-routable" });
    expect(copied).toEqual(["words"]);
    expect(f.calls).toEqual([]); // not one AppleScript
    expect(await injectKey(cfg(true), undefined, "Enter", undefined, { osa: f.osa })).toEqual({ via: "none" });
    expect(f.calls).toEqual([]);
  });

});

describe("2. keystroke-fallback is a real setting", () => {

  test("`conch set keystroke-fallback false` applies live now that no env sits over it", () => {
    const settingsPath = join(mkdtempSync(join(tmpdir(), "conch-a17-")), "settings.json");
    const live = loadConfig({ env: {}, settingsPath });
    expect(live.keystrokeFallback).toBe(true);
    const reply = createConfigController(live, { env: {}, settingsPath })
      .handle({ kind: "set-config", key: "keystroke-fallback", value: false });
    expect(reply).toMatchObject({ kind: "config-ack", status: "applied", effective: false, source: "file" });
    expect(live.keystrokeFallback).toBe(false);

    // The old hosts' export is exactly what made the setting dead: with it, the same set is masked.
    const env = { CONCH_KEYSTROKE_FALLBACK: "1" };
    const forced = loadConfig({ env, settingsPath });
    createConfigController(forced, { env, settingsPath })
      .handle({ kind: "set-config", key: "keystroke-fallback", value: false });
    expect(forced.keystrokeFallback).toBe(true);
  });

  test("off means clipboard, not typing", async () => {
    const copied: string[] = [];
    const f = fakeOsa(() => "/dev/ttys001");
    const result = await injectText(cfg(false), DEAD_PID, "words", undefined, {
      copyToClipboard: async (t) => { copied.push(t); },
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "clipboard", reason: "keystroke-fallback-off" });
    expect(copied).toEqual(["words"]);
    expect(f.calls).toEqual([]);
  });

  test("the focused route types only after the front window's selected tab is the session's tty", async () => {
    const copied: string[] = [];
    const f = fakeOsa(() => "/dev/ttys001");
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async (t) => { copied.push(t); },
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "osascript-focused" });
    expect(copied).toEqual([]);
    expect(f.typed()).toEqual(["hi"]);
    expect(f.returns()).toBe(1);
    // focus, look, type, focus again, look again, Return — the look comes before every key.
    const kinds = f.calls.map((c) => c.lines.join("\n") === FRONT_TTY_SCRIPT ? "look"
      : c.lines.some((l) => l.includes("activate")) ? "focus"
        : c.lines.some((l) => l.includes("keystroke")) ? "type" : "return");
    expect(kinds).toEqual(["focus", "look", "type", "focus", "return"]);
  });

  test("another app in front aborts to the clipboard with its own reason, and nothing is typed", async () => {
    const copied: string[] = [];
    const f = fakeOsa(() => "front:Safari");
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async (t) => { copied.push(t); },
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "clipboard", reason: "front-window-changed" });
    expect(copied).toEqual(["hi"]);
    expect(f.typed()).toEqual([]);
    expect(f.returns()).toBe(0);
  });

  test("a different Terminal tab in front is not the target either", async () => {
    const f = fakeOsa(() => "/dev/ttys009");
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async () => {},
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "clipboard", reason: "front-window-changed" });
    expect(f.typed()).toEqual([]);
  });

  test("focus drifting after the text landed skips the Return rather than pressing it elsewhere", async () => {
    let looks = 0;
    const f = fakeOsa(() => (++looks <= 2 ? "/dev/ttys001" : "front:Slack"));
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async () => {},
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "none", failed: true, reason: "front-window-changed" });
    expect(f.typed()).toEqual(["hi"]);
    expect(f.returns()).toBe(0);
  });

  test("a single key looks before it presses too", async () => {
    const drifted = fakeOsa(() => "front:Finder");
    expect(await injectKey(cfg(true), DEAD_PID, "Enter", undefined, { osa: drifted.osa, findTmuxPane: async () => null, sleep: async () => {}, ttyForPid: async () => "ttys001" }))
      .toEqual({ via: "none", failed: true, reason: "front-window-changed" });
    expect(drifted.returns()).toBe(0);
    const held = fakeOsa(() => "/dev/ttys001");
    expect(await injectKey(cfg(true), DEAD_PID, "Enter", undefined, { osa: held.osa, findTmuxPane: async () => null, sleep: async () => {}, ttyForPid: async () => "ttys001" }))
      .toEqual({ via: "osascript-focused" });
    expect(held.returns()).toBe(1);
  });

  // Tyler sent a long reply to a Codex session: the keystroke outlived the AppleScript bound, System Events kept
  // typing after conch gave up, and every character nothing took was a beep, until he force-quit (2026-09-14).
  test("a long or multi-line message is pasted in one event and the clipboard given back; short lines are still typed", async () => {
    const pasteCalls = (calls: Array<{ lines: string[] }>) =>
      calls.filter((c) => c.lines.some((l) => l.includes('keystroke "v" using command down'))).length;
    const long = "word ".repeat(80);
    const f = fakeOsa(() => "/dev/ttys001");
    const copied: string[] = [];
    const result = await injectText(cfg(true, false), DEAD_PID, long, undefined, {
      copyToClipboard: async (t) => { copied.push(t); },
      pasteboard: fakePasteboard("what was on the clipboard", copied),
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "osascript-focused" });
    expect(f.calls.some((c) => c.argv[0] === long)).toBe(false); // never typed a keystroke at a time
    expect(pasteCalls(f.calls)).toBe(1);
    expect(copied).toEqual([long, "what was on the clipboard"]);

    // Across lines, even short: a typed newline is a Return that sends half the message.
    const g = fakeOsa(() => "/dev/ttys001");
    const copiedLines: string[] = [];
    await injectText(cfg(true, false), DEAD_PID, "first line\nsecond line", undefined, {
      copyToClipboard: async (t) => { copiedLines.push(t); },
      pasteboard: fakePasteboard("", copiedLines),
      osa: g.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(pasteCalls(g.calls)).toBe(1);
    expect(copiedLines).toEqual(["first line\nsecond line", ""]);

    // A failed paste restores the clipboard and reports an unsuccessful transport.
    const m = fakeOsa(() => "/dev/ttys001");
    const modal: OsaRunner = async (lines, argv) =>
      lines.some((l) => l.includes("command down")) ? { text: "", timedOut: true } : m.osa(lines, argv);
    const copiedModal: string[] = [];
    expect(await injectText(cfg(true, false), DEAD_PID, long, undefined, {
      copyToClipboard: async (t) => { copiedModal.push(t); },
      pasteboard: fakePasteboard("prior", copiedModal),
      osa: modal,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    })).toEqual({ via: "none", failed: true, reason: "system-dialog-blocking" });
    expect(copiedModal.at(-1)).toBe("prior");

    // A short single line is still typed.
    const h = fakeOsa(() => "/dev/ttys001");
    await injectText(cfg(true, false), DEAD_PID, "hi", undefined, {
      copyToClipboard: async () => {},
      osa: h.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "ttys001",
    });
    expect(h.typed()).toEqual(["hi"]);
    expect(pasteCalls(h.calls)).toBe(0);
  }, 15_000);

  test("undelivered ordinary injections return an explicit failure or interruption", async () => {
    const results: Array<Awaited<ReturnType<typeof injectText>>> = [];
    const run = async (config: Config, pid: number | undefined, front: string, o: { tty?: string; modal?: boolean; allow?: number } = {}) => {
      const f = fakeOsa(() => front);
      const osa: OsaRunner = o.modal
        ? async (lines, argv) => lines.some((l) => l.includes("keystroke")) ? { text: "", timedOut: true } : f.osa(lines, argv)
        : f.osa;
      let asked = 0;
      results.push(await injectText(config, pid, "hi", o.allow === undefined ? undefined : () => ++asked <= o.allow!, {
        copyToClipboard: async () => {},
        osa,
        findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => o.tty ?? "ttys001",
      }));
    };
    await run(cfg(true), undefined, "/dev/ttys001"); // no pid
    await run(cfg(false), DEAD_PID, "/dev/ttys001"); // fallback off
    await run(cfg(true), DEAD_PID, "/dev/ttys001", { tty: "" }); // not focusable
    await run(cfg(true), DEAD_PID, "front:Safari"); // another app in front
    await run(cfg(true), DEAD_PID, "/dev/ttys001", { modal: true }); // a dialog ate the keystroke
    await run(cfg(true), DEAD_PID, "/dev/ttys001"); // typed and submitted
    await run(cfg(true, false), DEAD_PID, "/dev/ttys001"); // typed, no Return
    await run(cfg(true), undefined, "/dev/ttys001", { allow: 0 }); // stopped before the clipboard
    for (const allow of [0, 1, 2]) await run(cfg(true), DEAD_PID, "/dev/ttys001", { allow }); // stopped at each look
    expect(results.filter((r) => r.via === "none" && !r.interrupted && !r.failed)).toEqual([]);
    // Not vacuous: every route was reached, the stop included.
    expect(new Set(results.map((r) => r.via))).toEqual(new Set(["clipboard", "osascript-focused", "none"]));
    expect(results.filter((r) => r.interrupted)).toHaveLength(4);
  }, 15_000);

  test("a session with no tty cannot be focused, so it is the clipboard", async () => {
    const f = fakeOsa(() => "/dev/ttys001");
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async () => {},
      osa: f.osa,
      findTmuxPane: async () => null,
      sleep: async () => {},
      ttyForPid: async () => "",
    });
    expect(result).toEqual({ via: "clipboard", reason: "window-not-focusable" });
    expect(f.calls).toEqual([]);
  });

});

describe("3. an agent cannot undo a person's manual mode", () => {
  const globally = { globalPaused: true, sessionPaused: false };
  const running = { globalPaused: false, sessionPaused: false };
  const sessionOnly = { globalPaused: false, sessionPaused: true };

  test("the ledger: a person's pause holds against an agent, an agent's does not", () => {
    const ledger = new PauseOriginLedger();
    ledger.paused("", undefined, false); // the p key, the Mac's toggle, `conch pause`: no origin is you
    expect(ledger.refusal("", "agent", globally)).toBe("user-paused");
    expect(ledger.refusal("session-a", "agent", globally)).toBe("user-paused"); // no exempting one session
    expect(ledger.refusal("", "user", globally)).toBeNull();
    expect(ledger.refusal("", undefined, globally)).toBeNull();
    ledger.resumed("");
    expect(ledger.refusal("", "agent", running)).toBeNull();

    ledger.paused("", "agent", false);
    expect(ledger.agentOwns("")).toBe(true);
    expect(ledger.refusal("", "agent", globally)).toBeNull(); // an agent may undo an agent
    ledger.resumed("");

    ledger.paused("session-a", "user", false); // the app's per-row control
    expect(ledger.refusal("session-a", "agent", sessionOnly)).toBe("user-paused");
    expect(ledger.refusal("session-b", "agent", running)).toBeNull();
    ledger.paused("session-b", "agent", false);
    expect(ledger.refusal("session-b", "agent", sessionOnly)).toBeNull();
  });

  test("an agent cannot launder a person's pause, and unknown pauses are the person's", () => {
    const ledger = new PauseOriginLedger();
    // An agent pausing on top of your pause changes nothing it can then undo.
    ledger.paused("", undefined, false);
    ledger.paused("", "agent", true);
    expect(ledger.agentOwns("")).toBe(false);
    expect(ledger.refusal("", "agent", globally)).toBe("user-paused");
    // A person pausing on top of an agent's takes it over.
    const taken = new PauseOriginLedger();
    taken.paused("", "agent", false);
    taken.paused("", undefined, true);
    expect(taken.refusal("", "agent", globally)).toBe("user-paused");
    // Manual mode restored from state.json at boot, or a meeting autopause:
    // nothing recorded, and paused all the same — not the agent's to undo.
    expect(new PauseOriginLedger().refusal("", "agent", globally)).toBe("user-paused");
  });

  test("the origin rides the wire and reaches the scoped pause with the event", () => {
    expect(validateSocketTurnEvent({ type: "resume", origin: "agent" }).ok).toBe(true);
    expect(validateSocketTurnEvent({ type: "speak", sessionId: "", label: "", announce: "x", origin: "agent" }).ok).toBe(true);
    expect(validateSocketTurnEvent({ type: "resume", origin: "robot" }).ok).toBe(false);

    const scoped: unknown[] = [];
    dispatchSocketTurnEvent(
      { type: "resume", sessionId: "session-a", label: "A", announce: "", origin: "agent" },
      {
        busy: () => false,
        stopSpacebar: () => {},
        setSessionPaused: (...args) => scoped.push(args),
        enrichAudioCommand: (event) => event,
        enqueueInstant: () => {},
        enqueue: () => {},
      },
    );
    expect(scoped).toEqual([["session-a", false, "agent"]]);
  });

});

describe("4. meeting-autopause watches every input device", () => {
  const reads = (devices: number[] | null, input: number[], running: Record<number, boolean | null>) => ({
    devices: () => devices,
    hasInput: (d: number) => input.includes(d),
    running: (d: number) => running[d] ?? null,
  });

  test("a running non-default input device counts; a running output-only device does not", () => {
    expect(anyInputDeviceRunning(reads([80, 90], [80, 90], { 80: false, 90: true }))).toBe(true);
    expect(anyInputDeviceRunning(reads([80, 73], [80], { 80: false, 73: true }))).toBe(false);
    expect(anyInputDeviceRunning(reads([80], [80], { 80: false }))).toBe(false);
  });

  test("unknown stays unknown so an owned pause is kept", () => {
    expect(anyInputDeviceRunning(reads(null, [], {}))).toBeNull();
    expect(anyInputDeviceRunning(reads([], [], {}))).toBeNull();
    expect(anyInputDeviceRunning(reads([80], [80], { 80: null }))).toBeNull();
    expect(anyInputDeviceRunning(reads([80, 90], [80, 90], { 80: null, 90: true }))).toBe(true);
  });

});

describe("6. files", () => {
  test("the hook log is 0600 and rolls over like the daemon log", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-a17-hook-")), "conch-hook.log");
    appendHookTrace({ hookTracePath: path }, { event: "Stop", head: "secret" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain('"head":"secret"');

    writeFileSync(path, "x".repeat(1024 * 1024 + 1));
    appendHookTrace({ hookTracePath: path }, { event: "Stop", head: "after" });
    expect(existsSync(`${path}.1`)).toBe(true);
    const fresh = readFileSync(path, "utf8");
    expect(fresh).toContain('"head":"after"');
    expect(fresh.length).toBeLessThan(1000);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("under test, the inject step log is the override, never the live file", async () => {
    expect(INJECT_DEBUG_LOG).not.toBe("/tmp/conch-inject-debug.log");
    expect(INJECT_DEBUG_LOG).toBe(process.env.CONCH_INJECT_DEBUG_LOG ?? "");
    await injectText(cfg(true), undefined, "a17 marker 9c2e", undefined, { copyToClipboard: async () => {} });
    expect(readFileSync(INJECT_DEBUG_LOG, "utf8")).toContain("begin pid=none chars=15");
  });

});

describe("7. a dead daemon's sox is reaped", () => {
  const ARGV = soxCaptureArgs({ micGainDb: 0, endSilenceSecs: 3.5 }, "/tmp/conch-normal-1-2.raw", 2).join(" ");
  const identityFor = (pid: number) => ({ pid, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/opt/bin/sox", ttyDevice: null });
  const recordAt = (record: object): string => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-a17-sox-")), "sox-recorders.json");
    writeFileSync(path, JSON.stringify(record));
    return path;
  };
  function reaper(pids: Set<number>, argv: Record<number, string>) {
    const kills: number[] = [];
    return {
      kills,
      deps: {
        alive: (pid: number) => pids.has(pid),
        identity: (pid: number) => pids.has(pid) ? identityFor(pid) : null,
        command: (pid: number) => (pids.has(pid) ? argv[pid] ?? null : null),
        kill: (pid: number) => { kills.push(pid); pids.delete(pid); },
      },
    };
  }

  test("the record names the writing daemon, grows per spawn and shrinks per exit", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-a17-sox-")), "nested", "sox-recorders.json");
    recordSpawnedSox(101, path, identityFor);
    recordSpawnedSox(102, path, identityFor);
    expect(readSoxRecord(path)).toEqual({ daemonPid: process.pid, pids: [101, 102], identities: { 101: identityFor(101), 102: identityFor(102) } });
    forgetSox(101, path);
    expect(readSoxRecord(path)).toEqual({ daemonPid: process.pid, pids: [102], identities: { 102: identityFor(102) } });
    // Another daemon's record is replaced, not merged: its pids are not ours to keep.
    writeFileSync(path, JSON.stringify({ daemonPid: 1, pids: [7] }));
    recordSpawnedSox(103, path, identityFor);
    expect(readSoxRecord(path)).toEqual({ daemonPid: process.pid, pids: [103], identities: { 103: identityFor(103) } });
  });

  test("only conch's own capture argv qualifies", () => {
    expect(isConchSox(ARGV)).toBe(true);
    expect(isConchSox("/opt/homebrew/bin/" + ARGV)).toBe(true);
    expect(isConchSox(soxCaptureArgs({ micGainDb: 6, endSilenceSecs: 3.5 }, "/tmp/conch-diag-1-2/normal.raw", 2).join(" "))).toBe(true);
    expect(isConchSox("sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t raw /tmp/other.raw silence -l 1 0.15 2% 1 3.5 2%")).toBe(false);
    // A daemon from before the pre-roll may have left its recorder behind.
    expect(isConchSox("sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t raw /tmp/conch-normal-1-2.raw silence -l 1 0.15 2% 1 3.5 2%")).toBe(true);
    expect(isConchSox("sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t raw /tmp/conch-normal-1-2.raw gain 6 silence -l 1 0.15 2% 1 3.5 2%")).toBe(true);
    expect(isConchSox("sox song.mp3 out.wav")).toBe(false);
    expect(isConchSox("whisper-server --port 8642")).toBe(false);
  });

  test("setup's microphone check, recording into $TMPDIR, qualifies; another WAV never does", () => {
    const wav = join("/var/folders/ab/cd1234/T", "conch-mic-check-4242-1794540000000.wav");
    expect(MIC_CHECK_FILE.test(basename(wav))).toBe(true);
    expect(isConchSox(narrationSoxArgs({ micGainDb: 0 }, wav, 6).join(" "))).toBe(true);
    expect(isConchSox(narrationSoxArgs({ micGainDb: 6, soxBin: "/Applications/conch.app/Contents/Helpers/sox" }, wav, 2.5).join(" "))).toBe(true);
    expect(isConchSox(narrationSoxArgs({ micGainDb: 0 }, "/var/folders/ab/cd1234/T/song.wav", 6).join(" "))).toBe(false);
    expect(isConchSox(narrationSoxArgs({ micGainDb: 0 }, "/tmp/conch-mic-check-notes.wav", 6).join(" "))).toBe(false);
    expect(isConchSox("/Applications/conch.app/Contents/Helpers/conch-microphone --sample-rate 16000 --no-disclaim --seconds 2.5")).toBe(true);
  });

  test("conch Microphone, as listen.ts runs it, qualifies; seashell's own recorder never does", () => {
    const app = "/Applications/conch.app/Contents/Helpers/conch-microphone";
    expect(isConchSox(`${app} --sample-rate 16000 --no-disclaim`)).toBe(true);
    expect(isConchSox(`${app} --sample-rate 16000 --no-disclaim --seconds 150`)).toBe(true);
    const copy = "/Users/someone/Library/Application Support/conch/Runtime/conch Microphone";
    expect(isConchSox(`${copy} --sample-rate 16000`)).toBe(true);
    expect(isConchSox(`${copy} --sample-rate 16000 --seconds 150`)).toBe(true);
    expect(isConchSox(`${copy} --status`)).toBe(false);
    expect(isConchSox(`${app} --request-permission`)).toBe(false);
    expect(isConchSox("/Users/someone/Library/Application Support/Sea Shell/Runtime/Seashell Microphone --sample-rate 16000")).toBe(false);
    expect(isConchSox("/opt/homebrew/opt/seashell/libexec/native/bin/seashell-microphone --sample-rate 16000")).toBe(false);
  });

  test("kills exactly the recorded sox pids once their daemon is dead", async () => {
    const path = recordAt({ daemonPid: 999, pids: [4242, 4243, 4244], identities: Object.fromEntries([4242, 4243, 4244].map((pid) => [pid, identityFor(pid)])) });
    const r = reaper(new Set([4242, 4243, 4244]), { 4242: ARGV, 4243: "node server.js", 4244: ARGV });
    expect(await reapOrphanedSox(path, r.deps)).toEqual([4242, 4244]);
    expect(r.kills).toEqual([4242, 4244]);
  });

  test("never kills a stranger: live daemon, reused pid, gone pid, no record", async () => {
    const cases: Array<[string, object, Set<number>, Record<number, string>]> = [
      ["its daemon is alive", { daemonPid: 999, pids: [4242] }, new Set([4242, 999]), { 4242: ARGV }],
      ["pid reused by another sox", { daemonPid: 999, pids: [4242] }, new Set([4242]), { 4242: "sox song.mp3 out.wav" }],
      ["pid gone", { daemonPid: 999, pids: [4242] }, new Set(), {}],
      ["record malformed", { daemonPid: "999", pids: [4242] }, new Set([4242]), { 4242: ARGV }],
    ];
    for (const [name, record, pids, argv] of cases) {
      const r = reaper(pids, argv);
      expect(await reapOrphanedSox(recordAt(record), r.deps), name).toEqual([]);
      expect(r.kills, name).toEqual([]);
    }
    expect(await reapOrphanedSox(join(tmpdir(), "conch-no-such-sox-record.json"), reaper(new Set(), {}).deps)).toEqual([]);
  });

});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { createConfigController } from "../src/daemon.ts";
import { dispatchSocketTurnEvent, validateSocketTurnEvent } from "../src/control-server.ts";
import { appendHookTrace } from "../src/hook.ts";
import { FRONT_TTY_SCRIPT, INJECT_DEBUG_LOG, injectKey, injectText, type OsaRunner } from "../src/inject.ts";
import { renderServicePlist } from "../src/install.ts";
import { soxCaptureArgs } from "../src/listen.ts";
import { anyInputDeviceRunning } from "../src/mic-claim.ts";
import { PauseOriginLedger } from "../src/pause-origin.ts";
import { SETTING_REGISTRY } from "../src/settings.ts";
import { forgetSox, isConchSox, readSoxRecord, reapOrphanedSox, recordSpawnedSox } from "../src/sox-orphan.ts";

/**
 * A17 — what the daemon does to the rest of the Mac (docs/daemon-side-effects.md).
 *
 * Nothing here touches a real window, clipboard, microphone or process: the
 * inject paths run through their seams, the reaper over a fake process table,
 * and the daemon's wiring is pinned as source where `runDaemon` cannot run.
 */

const src = (name: string) => readFileSync(join(import.meta.dir, "..", name), "utf8");
const daemon = src("src/daemon.ts");

/** No process has this pid, so tmux finds no pane and `ps` finds no tty. */
const DEAD_PID = 0x7ffffffe;
const cfg = (keystrokeFallback: boolean, autoSubmit = true): Config =>
  ({ autoSubmit, keystrokeFallback } as Config);

/** An AppleScript runner over fakes: Terminal focuses fine; `front` answers the front-window query. */
function fakeOsa(front: () => string) {
  const calls: Array<{ lines: string[]; argv: string[] }> = [];
  const osa: OsaRunner = async (lines, argv = []) => {
    calls.push({ lines, argv });
    const script = lines.join("\n");
    if (script === FRONT_TTY_SCRIPT) return { text: front() + "\n", timedOut: false };
    if (script.includes("activate")) return { text: "ok\n", timedOut: false };
    return { text: "", timedOut: false };
  };
  const typed = () => calls.filter((c) => c.lines.some((l) => l.includes("keystroke"))).map((c) => c.argv[0]);
  const returns = () => calls.filter((c) => c.lines.some((l) => l.includes("key code 36"))).length;
  return { osa, calls, typed, returns };
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

  test("the route and its opt-out are gone from the source", () => {
    const inject = src("src/inject.ts");
    expect(inject).not.toContain("osascript-blind");
    expect(inject).not.toContain("allowBlindFallback");
    expect(daemon).not.toContain("allowBlindFallback");
  });
});

describe("2. keystroke-fallback is a real setting", () => {
  test("it defaults on, says what it does, and neither host exports it over the file", () => {
    const descriptor = SETTING_REGISTRY.get("keystroke-fallback")!;
    expect(descriptor.default).toBe(true);
    expect(descriptor.help).toContain("clipboard");
    expect(src("mac-app/conch-mac/DaemonHost.swift")).not.toContain('environment["CONCH_KEYSTROKE_FALLBACK"]');
    const plist = renderServicePlist({ daemonArgv: ["conch", "daemon"], conchRoot: "/c", path: "/bin", carriedEnv: "" });
    expect(plist).not.toContain("CONCH_KEYSTROKE_FALLBACK");
    expect(plist).toContain("CONCH_STARTED_BY"); // the rest of the block is untouched
  });

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
    expect(kinds).toEqual(["focus", "look", "type", "focus", "look", "return"]);
  });

  test("another app in front aborts to the clipboard with its own reason, and nothing is typed", async () => {
    const copied: string[] = [];
    const f = fakeOsa(() => "front:Safari");
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async (t) => { copied.push(t); },
      osa: f.osa,
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
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "clipboard", reason: "front-window-changed" });
    expect(f.typed()).toEqual([]);
  });

  test("focus drifting after the text landed skips the Return rather than pressing it elsewhere", async () => {
    let looks = 0;
    const f = fakeOsa(() => (++looks === 1 ? "/dev/ttys001" : "front:Slack"));
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async () => {},
      osa: f.osa,
      ttyForPid: async () => "ttys001",
    });
    expect(result).toEqual({ via: "osascript-focused" });
    expect(f.typed()).toEqual(["hi"]);
    expect(f.returns()).toBe(0);
  });

  test("a single key looks before it presses too", async () => {
    const drifted = fakeOsa(() => "front:Finder");
    expect(await injectKey(cfg(true), DEAD_PID, "Enter", undefined, { osa: drifted.osa, ttyForPid: async () => "ttys001" }))
      .toEqual({ via: "none" });
    expect(drifted.returns()).toBe(0);
    const held = fakeOsa(() => "/dev/ttys001");
    expect(await injectKey(cfg(true), DEAD_PID, "Enter", undefined, { osa: held.osa, ttyForPid: async () => "ttys001" }))
      .toEqual({ via: "osascript-focused" });
    expect(held.returns()).toBe(1);
  });

  test("a session with no tty cannot be focused, so it is the clipboard", async () => {
    const f = fakeOsa(() => "/dev/ttys001");
    const result = await injectText(cfg(true), DEAD_PID, "hi", undefined, {
      copyToClipboard: async () => {},
      osa: f.osa,
      ttyForPid: async () => "",
    });
    expect(result).toEqual({ via: "clipboard", reason: "window-not-focusable" });
    expect(f.calls).toEqual([]);
  });

  test("the look is the same tty match that selected the tab", () => {
    expect(FRONT_TTY_SCRIPT).toContain("frontmost is true");
    expect(FRONT_TTY_SCRIPT).toContain("tty of selected tab of front window");
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

  test("the daemon records every pause's origin and refuses before it flips the mode", () => {
    const enqueueAt = daemon.indexOf("  function enqueue(incoming: TurnEvent): void {");
    expect(enqueueAt).toBeGreaterThan(-1);
    const enqueue = daemon.slice(enqueueAt, daemon.indexOf("void eventQueue.submit(event);", enqueueAt));
    const refuseAt = enqueue.indexOf('pauseOrigin.refusal("", event.origin, { globalPaused: pause.paused, sessionPaused: false })');
    const recordAt = enqueue.indexOf('pauseOrigin.paused("", event.origin, pause.paused)');
    const flipAt = enqueue.indexOf("instantControls.applyGlobal(");
    expect(refuseAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(-1);
    expect(flipAt).toBeGreaterThan(refuseAt);
    expect(enqueue).toContain("if (refusal) return log(`manual — refused resume (");

    // Both scoped doors — the socket's and the TUI's — go through the ledger.
    expect(daemon.split("setSessionPaused: setSessionPausedFrom,").length - 1).toBe(2);
    expect(daemon).not.toContain("setSessionPaused: (sessionId, paused) => instantControls.setSessionPaused(sessionId, paused)");
    const helper = daemon.slice(daemon.indexOf("const setSessionPausedFrom = "), daemon.indexOf("instantControls.setSessionPaused(sessionId, paused);"));
    expect(helper).toContain("pauseOrigin.refusal(sessionId, origin, {");
    expect(helper).toContain("if (refusal) return log(`manual — refused resume for");
    expect(helper).toContain("pauseOrigin.paused(sessionId, origin, pausedSessionIds.has(sessionId))");
  });

  test("an agent's speak is held at the funnel while any pause but an agent's holds", () => {
    const at = daemon.indexOf('if (event.type === "speak") {');
    expect(at).toBeGreaterThan(-1);
    const handler = daemon.slice(at, at + 900);
    expect(handler).toContain('const volunteered = !(event.origin === "agent" && pause.paused && !pauseOrigin.agentOwns(""));');
    expect(handler).toContain("event.label, volunteered, event.sessionId)");
  });

  test("the published mode carries the same test, so conch_speak can say it was held", () => {
    const at = daemon.indexOf("model.mode = {");
    expect(at).toBeGreaterThan(-1);
    const mode = daemon.slice(at, daemon.indexOf("lastPanelModel = model;", at));
    expect(mode).toContain("paused: pause.paused,");
    expect(mode).toContain('...(pause.paused && pauseOrigin.agentOwns("") ? { pausedByAgent: true } : {}),');
  });

  test("the contract says so", () => {
    const doc = src("docs/conch-control-skill.md");
    expect(doc).toContain("A `resume` from an agent is refused while the user put conch in manual themselves");
    expect(doc).toContain("its result carries `held` saying so");
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

  test("the daemon still samples through readMicInUse and the help text says every device", () => {
    expect(daemon).toContain("inUse: readMicInUse,");
    expect(SETTING_REGISTRY.get("meeting-autopause")!.help).toContain("any microphone");
  });
});

describe("5. reveal-on-turn is opt-in and every raise is logged", () => {
  test("off by default, and the help says how to raise a window instead", () => {
    const descriptor = SETTING_REGISTRY.get("reveal-on-turn")!;
    expect(descriptor.default).toBe(false);
    expect(descriptor.help).toContain("off by default");
    expect(descriptor.help).toContain("click");
  });

  test("the daemon raises through one door that logs", () => {
    // The import and the one call inside raiseWindow; every other site goes through it.
    expect(daemon.split("revealSessionWindow(").length - 1).toBe(1);
    const at = daemon.indexOf("const raiseWindow = async (pid: number, why: string)");
    expect(at).toBeGreaterThan(-1);
    expect(daemon.slice(at, at + 300)).toContain("log(`raised Terminal window of pid ${pid} (${why})`)");
    // turn-end, wake, recite, permission (the voice loop, through its dep) and app (the daemon).
    const voice = src("src/voice-loop.ts");
    expect(voice).not.toContain("revealSessionWindow(");
    expect(daemon.split("raiseWindow(").length - 1 + voice.split("raiseWindow(").length - 1).toBe(5);
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
    const live = "/tmp/conch-inject-debug.log";
    const liveBytes = existsSync(live) ? statSync(live).size : 0;
    await injectText(cfg(true), undefined, "a17 marker 9c2e", undefined, { copyToClipboard: async () => {} });
    expect(readFileSync(INJECT_DEBUG_LOG, "utf8")).toContain("begin pid=none chars=15");
    expect(existsSync(live) ? statSync(live).size : 0).toBe(liveBytes);
  });

  test("without an override the step log follows the daemon log's directory", () => {
    const inject = src("src/inject.ts");
    expect(inject).toContain('process.env.CONCH_INJECT_DEBUG_LOG\n  || join(dirname(process.env.CONCH_LOG_FILE || "/tmp/conch-daemon.log"), "conch-inject-debug.log")');
  });
});

describe("7. a dead daemon's sox is reaped", () => {
  const ARGV = soxCaptureArgs({ micGainDb: 0, endSilenceSecs: 3.5, endThresholdPct: 2 }, "/tmp/conch-normal-1-2.raw", 2).join(" ");
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
        command: (pid: number) => (pids.has(pid) ? argv[pid] ?? null : null),
        kill: (pid: number) => { kills.push(pid); pids.delete(pid); },
      },
    };
  }

  test("the record names the writing daemon, grows per spawn and shrinks per exit", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conch-a17-sox-")), "nested", "sox-recorders.json");
    recordSpawnedSox(101, path);
    recordSpawnedSox(102, path);
    expect(readSoxRecord(path)).toEqual({ daemonPid: process.pid, pids: [101, 102] });
    forgetSox(101, path);
    expect(readSoxRecord(path)).toEqual({ daemonPid: process.pid, pids: [102] });
    // Another daemon's record is replaced, not merged: its pids are not ours to keep.
    writeFileSync(path, JSON.stringify({ daemonPid: 1, pids: [7] }));
    recordSpawnedSox(103, path);
    expect(readSoxRecord(path)).toEqual({ daemonPid: process.pid, pids: [103] });
  });

  test("only conch's own capture argv qualifies", () => {
    expect(isConchSox(ARGV)).toBe(true);
    expect(isConchSox("/opt/homebrew/bin/" + ARGV)).toBe(true);
    expect(isConchSox(soxCaptureArgs({ micGainDb: 6, endSilenceSecs: 3.5, endThresholdPct: 2 }, "/tmp/conch-diag-1-2/normal.raw", 2).join(" "))).toBe(true);
    expect(isConchSox("sox -d -q -r 16000 -c 1 -b 16 -e signed-integer -t raw /tmp/other.raw silence -l 1 0.15 2% 1 3.5 2%")).toBe(false);
    expect(isConchSox("sox song.mp3 out.wav")).toBe(false);
    expect(isConchSox("whisper-server --port 8642")).toBe(false);
  });

  test("kills exactly the recorded sox pids once their daemon is dead", async () => {
    const path = recordAt({ daemonPid: 999, pids: [4242, 4243, 4244] });
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

  test("every spawn is recorded and forgotten on exit; the daemon reaps after winning the socket", () => {
    const listen = src("src/listen.ts");
    const spawnAt = listen.indexOf("activeRecorders.add(proc);");
    expect(spawnAt).toBeGreaterThan(-1);
    const block = listen.slice(spawnAt, listen.indexOf("return capture;", spawnAt));
    expect(block).toContain("recordSpawnedSox(proc.pid);");
    expect(block).toContain("forgetSox(proc.pid);");
    expect(block.indexOf("recordSpawnedSox")).toBeLessThan(block.indexOf("proc.exited.then"));

    const socketAt = daemon.indexOf("if (!await controlServer.start()) {");
    const reapAt = daemon.indexOf("void reapOrphanedSox()");
    expect(socketAt).toBeGreaterThan(-1);
    expect(reapAt).toBeGreaterThan(socketAt);
    expect(daemon.slice(reapAt, reapAt + 400)).toContain("orphans of a dead conch daemon");
  });
});

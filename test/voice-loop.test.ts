import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import type { TurnEvent } from "../src/hook.ts";
import { AudioHolder } from "../src/audio-holder.ts";
import { AudioSinkLease } from "../src/daemon.ts";
import { SessionLedger } from "../src/session-ledger.ts";
import { PauseController } from "../src/pause-controller.ts";
import { SpeechManager, type SpeechBackend } from "../src/speech-manager.ts";
import type { WatchdogProcess } from "../src/audio-watchdog.ts";
import type { DictationEvent } from "../src/dictation-controller.ts";
import type { InjectTextResult } from "../src/inject.ts";
import type { ProviderCommandResult } from "../src/provider-rename.ts";
import type { ListenHooks, ListenResult, RuntimeDictationSession } from "../src/listen.ts";
import type { SessionInfo } from "../src/sessions.ts";
import { voiceFor } from "../src/speak.ts";
import { getLiveState, setState } from "../src/status.ts";
import {
  APPROVAL_KEYBOARD,
  APPROVAL_REASK,
  approvalAnnounce,
  approvalDetail,
  confirmAlwaysPrompt,
} from "../src/approval.ts";
import { createVoiceLoop, type VoiceLoop, type VoiceLoopDeps } from "../src/voice-loop.ts";

/**
 * The voice loop, executed. `runDaemon` still runs in no test, but since cut
 * four the loop is a function of its dependencies: a real SpeechManager over
 * a backend that records every utterance, a real ledger, lease, holder and
 * PauseController, and a terminal and an ear that touch nothing. No sox, no
 * osascript, no daemon. Most of these were exact-text guards on daemon.ts.
 */

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(what: string, condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

/** A dictation session that hears what its script says and nothing else. */
class FakeSession {
  state: "idle" | "running" | "draining" = "idle";
  readonly micOpen = false;
  started = 0;
  readonly #queued: DictationEvent[] = [];
  readonly #waiting: Array<(event: DictationEvent) => void> = [];
  #barriers = 0;

  constructor(private readonly heard: string[], private readonly order: string[]) {}

  start(): void {
    this.started++;
    this.state = "running";
    this.order.push("start");
    for (const text of this.heard) {
      this.#deliver({ kind: "transcript", text, rawPath: "", finalBytes: 0 } as DictationEvent);
    }
  }
  resume(): void {
    this.state = "running";
  }
  nextEvent(): Promise<DictationEvent> {
    const next = this.#queued.shift();
    return next ? Promise.resolve(next) : new Promise((resolve) => this.#waiting.push(resolve));
  }
  acknowledge(): void {
    this.state = "idle";
  }
  requestBarrier(reason: string) {
    const id = ++this.#barriers;
    this.#deliver({ kind: "barrier", id, reason });
    return { id, reason, done: Promise.resolve() };
  }
  requestTimeout() {
    return this.requestBarrier("timeout");
  }
  setIdleWindowSecs(): void {}
  async abort(): Promise<void> {
    this.state = "idle";
  }
  #deliver(event: DictationEvent): void {
    const waiter = this.#waiting.shift();
    if (waiter) waiter(event);
    else this.#queued.push(event);
  }
}

interface Options {
  cfg?: Partial<Config>;
  paused?: boolean;
  /** Utterances play until the test finishes them. */
  holdSpeech?: boolean;
  /** Cues play until the test ends them. */
  holdCues?: boolean;
  sessionGone?: (sessionId: string) => boolean | Promise<boolean>;
  window?: (sessionId: string) => SessionInfo | undefined;
  inject?: (text: string) => InjectTextResult;
  key?: (key: string) => InjectTextResult;
  command?: (line: string) => ProviderCommandResult;
  /** One script per mic window, in order. */
  heard?: string[][];
  gap?: () => ListenResult;
}

function harness(options: Options = {}) {
  setState("idle");
  const cfg: Config = {
    ...loadConfig({ env: {}, settingsPath: `/tmp/conch-voice-loop-test-${process.pid}/settings.json` }),
    bargeThresholdPct: 0,
    readFull: false,
    bell: false,
    micCues: false,
    revealOnTurn: false,
    awayAfterSecs: 0,
    typingGraceSecs: 0,
    voiceQa: false,
    ...options.cfg,
  };
  const order: string[] = [];
  const said: string[] = [];
  const playing = new Map<string, { finish(): void; cancelled: boolean }>();
  const backend: SpeechBackend = {
    speakCancellable: (_cfg, text) => {
      said.push(text);
      order.push(`said:${text}`);
      const done = deferred();
      const entry = { finish: () => done.resolve(), cancelled: false };
      playing.set(text, entry);
      if (!options.holdSpeech) done.resolve();
      return { done: done.promise, cancel: () => { entry.cancelled = true; done.resolve(); } };
    },
    stopSpeaking() {},
  };
  const cues: string[] = [];
  const cueExits: Array<(code: number) => void> = [];
  const spawnAudio = (command: string[]): WatchdogProcess => {
    const path = command.at(-1)!;
    cues.push(path);
    order.push(`cue:${path}`);
    const exited = deferred<number>();
    cueExits.push(exited.resolve);
    if (!options.holdCues) exited.resolve(0);
    return { exited: exited.promise, kill: () => exited.resolve(137) };
  };
  // The daemon's gate throws on an open mic; recording lets a test read the verdict.
  const violations: string[] = [];
  let voice!: VoiceLoop;
  const speech = new SpeechManager(backend, async (operation, task) => {
    if (voice.capturing()) violations.push(operation);
    return task();
  }, { spawnAudio, warn: () => {} });
  const ledger = new SessionLedger();
  const lease = new AudioSinkLease();
  const holder = new AudioHolder();
  const pause = new PauseController({
    initialPaused: options.paused ?? false,
    pending: ledger.pending,
    currentTurn: () => null,
    activeSession: () => null,
    cancelCurrentSpeech: () => {},
    cancelPendingAudio: () => {},
    persist: () => {},
    render: () => {},
    setModeState: () => {},
    log: () => {},
    speak: async () => {},
    liveSessionIds: async () => null,
    userRespondedSince: async () => false,
    enqueue: () => {},
  });
  const logs: string[] = [];
  const presented: unknown[][] = [];
  const latch: Array<string | undefined> = [];
  const errors: unknown[][] = [];
  const texts: string[] = [];
  const keys: string[] = [];
  const commands: string[] = [];
  const gone: string[] = [];
  const sessions: FakeSession[] = [];
  const hooks: ListenHooks[] = [];
  const heard = [...(options.heard ?? [])];
  let barges = 0;
  const deps: VoiceLoopDeps = {
    cfg,
    log: (message) => void logs.push(message),
    ledger,
    pause,
    queue: { consumeCancellation: () => false },
    speech,
    audio: { lease, holder },
    quietOverrideBlocked: () => false,
    window: options.window ?? (() => undefined),
    sessionGone: async (sessionId) => {
      gone.push(sessionId);
      return options.sessionGone ? await options.sessionGone(sessionId) : false;
    },
    render: () => {},
    presentElsewhere: (...args) => void presented.push(args),
    phoneLatch: { arm: (text) => void latch.push(text), clear: () => void latch.push("clear") },
    raiseWindow: async () => true,
    reportError: (...args) => void errors.push(args),
    prewarmEar: () => void order.push("prewarm"),
    control: async () => {},
    terminal: {
      injectText: async (_cfg, _pid, text, beforeInject) => {
        texts.push(text);
        order.push(`text:${text}`);
        if (beforeInject && !(await beforeInject())) return { via: "none", interrupted: true };
        return options.inject?.(text) ?? { via: "tmux" };
      },
      injectKey: async (_cfg, _pid, key) => {
        keys.push(key);
        order.push(`key:${key}`);
        return options.key?.(key) ?? { via: "tmux" };
      },
      injectProviderCommand: async (_cfg, _target, line) => {
        commands.push(line);
        return options.command?.(line) ?? { kind: "delivered", via: "tmux" };
      },
      toClipboard: async () => {},
    },
    ear: {
      createDictationSession: (_cfg, listenHooks = {}) => {
        hooks.push(listenHooks);
        const session = new FakeSession(heard.shift() ?? [], order);
        sessions.push(session);
        return session as unknown as RuntimeDictationSession;
      },
      listenGap: async () => options.gap?.() ?? { text: "" },
      armBargeRecorder: () => {
        barges++;
        throw new Error("these tests never arm a barge recorder");
      },
      killActiveRecorders: () => undefined,
    },
  };
  voice = createVoiceLoop(deps);
  return {
    voice, cfg, ledger, lease, holder, speech, said, playing, cues, cueExits, violations, order,
    logs, presented, latch, errors, texts, keys, commands, gone, sessions, hooks,
    barges: () => barges,
  };
}

type Harness = ReturnType<typeof harness>;

/** State events reach the loop only after intake accepted them (`eventOrder.accept`). */
function accepted(h: Harness, event: TurnEvent): TurnEvent {
  h.ledger.eventOrder.accept(event);
  return event;
}

const turnEnd = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "turn-end", sessionId: "s1", label: "alpha", announce: "alpha: the build is green.", eventAt: 1, ...over,
});
const wake = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "wake", sessionId: "s1", label: "alpha", announce: "", origin: "user", ...over,
});
const interrupt = (): TurnEvent => ({ type: "interrupt", sessionId: "s1", label: "alpha", announce: "", origin: "user" });
const inject = (text: string, over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "inject", sessionId: "s1", label: "alpha", announce: text, origin: "user", ...over,
});

function transcript(...lines: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "conch-voice-loop-")), "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });
const user = (...content: unknown[]) => ({ type: "user", message: { role: "user", content } });
const bash = { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "git push origin main", description: "Push" } };
const ask = { name: "Bash", summary: "git push origin main" };
const pendingBash = () => transcript(user({ type: "text", text: "push it" }), assistant(bash));
const permission = (path: string, over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "needs-you", ntype: "permission_prompt", sessionId: "s1", label: "alpha", announce: "", transcriptPath: path, eventAt: 1, ...over,
});
const busy = () => ({ sessionId: "s1", status: "busy" }) as SessionInfo;

/**
 * A14. Immediate `handle` calls (the inject/interrupt path that skips the
 * drain) used to reset the shared `stopKey` and `micOpen` under a queued
 * exchange mid-await. Cut four pinned that as it behaved; these are the
 * flipped pins. Only events that start an exchange reset them now.
 */
describe("A14: an immediate interrupt leaves the running exchange's stop and mic alone", () => {
  test("A: a stop followed by an immediate interrupt still stops — the announcement does not play", async () => {
    const registry = deferred<boolean>();
    let checks = 0;
    const h = harness({
      sessionGone: () => (++checks === 1 ? registry.promise : true),
      key: () => ({ via: "tmux" }),
    });
    const event = accepted(h, turnEnd());
    const turn = h.voice.handle(event); // parks at the registry check
    await waitFor("the registry check", () => h.gone.length === 1);
    h.voice.stop("spacebar");
    void h.voice.handle(interrupt());
    await waitFor("the Escape", () => h.keys.length === 1);
    registry.resolve(false);
    await turn;
    expect(h.keys).toEqual(["Escape"]); // the interrupt itself still ran
    expect(h.said).toEqual([]);
  });

  test("B: an interrupt under a live dictation keeps the gate shut — its failure line is held and logged, not spoken over the mic", async () => {
    const h = harness({ key: () => ({ via: "none" }) });
    void h.voice.handle(wake({ compose: true }));
    await waitFor("the dictation to start", () => h.sessions[0]?.started === 1);
    expect(h.voice.capturing()).toBe(true);
    await h.voice.handle(interrupt());
    // The session itself reports micOpen false; the loop's own flag is what holds.
    expect(h.voice.capturing()).toBe(true);
    expect(h.said).toEqual([]);
    expect(h.logs).toContain('⚠ could not reach "alpha" to stop it');
    expect(h.logs).toContain('held "alpha" — the mic is open');
    await h.voice.close();

    // A14's first finding stands: with no mic open, an interrupt failure speaks.
    const idle = harness({ key: () => ({ via: "none" }) });
    await idle.voice.handle(interrupt());
    expect(idle.said).toEqual(["Couldn't reach alpha to stop it."]);
  });
});

// SessionLedger.forget() deliberately keeps lastTurn. Clearing it passed the
// whole suite and would turn this line into "Nothing to wake."
test("a bare wake after the last session to speak closed and was forgotten says the session is closed", async () => {
  let checks = 0;
  const h = harness({ sessionGone: () => ++checks > 1 }); // live for its turn, gone from then on
  await h.voice.handle(accepted(h, turnEnd({ sessionId: "x1", label: "xray", announce: "xray: done." })));
  expect(h.ledger.lastTurn?.sessionId).toBe("x1");
  h.ledger.forgetGone(new Set()); // the registry no longer lists it
  expect(h.ledger.isKnown("x1")).toBe(false);
  await h.voice.handle(wake({ sessionId: "", label: "" }));
  expect(h.said).toEqual(["xray: done.", "That session is closed."]);
});

describe("inject and interrupt", () => {
  // Sending IS the interruption: you have moved on, and no answer to the
  // previous turn is worth hearing over your own next question.
  test("sending a message stops whatever is being read", async () => {
    const h = harness({ holdSpeech: true });
    void h.voice.speak(h.cfg, "a long reply being read", "alpha", true);
    await waitFor("the reading", () => h.said.length === 1);
    await h.voice.handle(inject("next question please"));
    expect(h.playing.get("a long reply being read")?.cancelled).toBe(true);
    expect(h.texts).toEqual(["next question please"]);
  });

  // B4: a slash line is the agent's own command. The message route would
  // match it against a question, offer it to voice Q&A and re-press Return
  // into the picker a bare `/model` opens.
  test("a slash line takes the provider door, never the message route", async () => {
    const h = harness();
    await h.voice.handle(inject("/model opus"));
    expect(h.commands).toEqual(["/model opus"]);
    expect(h.texts).toEqual([]);

    const failing = harness({ command: () => ({ kind: "unroutable", reason: "session has no routable pid" }) });
    await failing.voice.handle(inject("/compact"));
    expect(failing.errors).toEqual([
      ["session-command", "Could not type /compact into the session: session has no routable pid", "s1", { line: "/compact" }],
    ]);
    expect(failing.texts).toEqual([]);
  });

  // Both agents queue typed input mid-turn but write it to the transcript only
  // when that turn starts, so confirming by transcript growth re-pressed Return
  // into a working session and reported a queued message as failed.
  test("a message to a busy session counts as queued, without re-pressing Return", async () => {
    const h = harness({ window: busy });
    await h.voice.handle(inject("and another thing", { transcriptPath: pendingBash() }));
    expect(h.keys).toEqual([]);
    expect(h.logs).toContain('injected into "alpha" via tmux — queued behind the running turn');
  });

  test("only real keystrokes in a real pane count as queued; a clipboard landing does not", async () => {
    const path = pendingBash();
    const clipped = harness({ window: busy, inject: () => ({ via: "clipboard", reason: "window-not-focusable" }) });
    await clipped.voice.handle(inject("words that never landed", { transcriptPath: path }));
    expect(clipped.logs.some((line) => line.includes("queued behind"))).toBe(false);
    expect(clipped.said).toEqual(["Couldn't reach the session's window — your words are on the clipboard, just paste."]);

    const focused = harness({ window: busy, inject: () => ({ via: "osascript-focused" }) });
    await focused.voice.handle(inject("typed into the pane", { transcriptPath: path }));
    expect(focused.keys).toEqual([]);
    expect(focused.logs).toContain('injected into "alpha" via osascript-focused — queued behind the running turn');
  });

  // The app clears its draft when the daemon ACCEPTS a send (A8), so an inject
  // that stops, or lands on the clipboard, must hand the words back.
  test("undelivered text goes back to the composer: an interrupted inject says nothing, a clipboard landing says where the words are", async () => {
    const before = getLiveState().dictated?.id ?? 0;
    const stopped = harness({ inject: () => ({ via: "none", interrupted: true }) });
    await stopped.voice.handle(inject("half a thought"));
    expect(getLiveState().dictated).toEqual({ text: "half a thought", id: before + 1, sessionId: "s1" });
    expect(stopped.said).toEqual([]);

    const clipped = harness({ inject: () => ({ via: "clipboard" }) });
    await clipped.voice.handle(inject("the whole message"));
    expect(getLiveState().dictated).toEqual({ text: "the whole message", id: before + 2, sessionId: "s1" });
    expect(clipped.said).toEqual(["Couldn't reach the session's window — your words are on the clipboard, just paste."]);
  });
});

describe("the speech funnel", () => {
  // Tyler was mid-dictation when another session's turn ended and conch read it
  // over the top of him. Dropped, not deferred: the turn stays latched.
  test("speech does not start while a mic is open, and the state never claims it does", async () => {
    const h = harness();
    void h.voice.handle(wake({ compose: true }));
    await waitFor("the dictation", () => h.sessions[0]?.started === 1);
    setState("listening", "alpha");
    await h.voice.speak(h.cfg, "another session's turn", "beta", true);
    expect(h.said).toEqual([]);
    expect(getLiveState().state).toBe("listening");
    expect(h.logs).toContain('held "beta" — the mic is open');
    await h.voice.close();
  });

  // The queue was gated, but every direct speak() went around it: failure
  // lines, acknowledgements, error fallbacks.
  test("manual mode holds what conch volunteers, before the state is set", async () => {
    const h = harness({ paused: true });
    await h.voice.speak(h.cfg, "a dialog is blocking me", "alpha");
    expect(h.said).toEqual([]);
    expect(getLiveState().state).toBe("idle");
    expect(h.logs).toContain('held "alpha" — manual mode');
  });

  // Manual is about conch volunteering; a recite or a wake's confirmation is
  // a person asking for sound.
  test("what a person asked for still plays in manual mode: a line, a recite's heading, a wake's courtesy line", async () => {
    const h = harness({ paused: true });
    await h.voice.speak(h.cfg, "you asked for this", "alpha", true);
    await h.voice.handle({
      type: "recite", sessionId: "s1", label: "alpha", announce: "", origin: "user",
      transcriptPath: transcript(assistant({ type: "text", text: "Here is the whole reply." })),
    });
    void h.voice.handle(wake());
    await waitFor("the courtesy line", () => h.said.includes("Mic open for alpha."));
    expect(h.said.slice(0, 3)).toEqual(["you asked for this", "alpha:", "Here is the whole reply."]);
    await waitFor("the mic", () => h.sessions[0]?.started === 1);
    await h.voice.close();
  });

  test("the phone owning the voice: the state names the session, the bound is armed, nothing is synthesised here", async () => {
    const h = harness();
    h.lease.request("phone", 1);
    await h.voice.speak(h.cfg, "read on the phone", "alpha", true);
    expect(h.said).toEqual([]);
    expect(getLiveState()).toMatchObject({ state: "speaking", label: "alpha" });
    expect(h.latch).toEqual(["read on the phone"]);

    h.lease.request("mac", 1);
    await h.voice.speak(h.cfg, "read here", "alpha", true);
    expect(h.latch).toEqual(["read on the phone", "clear"]);
    expect(h.said).toEqual(["read here"]);
  });

  // C9b Cut B, outbox site 2 (F3, F6).
  test("another Mac holding the audio: only a line a person asked for is handed over, and no state is set", async () => {
    const h = harness();
    h.holder.yield("mac-b-owner", 1, 60_000);
    await h.voice.speak(h.cfg, "you asked", "alpha", true, "s1");
    await h.voice.speak(h.cfg, "conch volunteered", "alpha", false, "s1");
    expect(h.presented).toEqual([["mac-b-owner", "you asked", voiceFor(h.cfg, "alpha"), "alpha", "s1"]]);
    expect(h.said).toEqual([]);
    expect(getLiveState().state).toBe("idle");
  });
});

describe("turns and the audio holder", () => {
  // C9b Cut B, F1 and outbox site 1 (F6): audible somewhere, voiced elsewhere.
  test("a yielded turn keeps its checks and hands the announcement over: no bell, no reading, no mic", async () => {
    const h = harness({ cfg: { bell: true } });
    h.holder.yield("mac-b-owner", 1, 60_000);
    const event = accepted(h, turnEnd());
    await h.voice.handle(event);
    expect(h.gone).toEqual(["s1"]);
    expect(h.ledger.sessionStates.get("s1")?.status).toBe("waiting");
    expect(h.presented).toEqual([["mac-b-owner", event.announce, voiceFor(h.cfg, "alpha"), "alpha", "s1"]]);
    expect(h.ledger.lastTurn).toBe(event);
    expect(h.cues).toEqual([]);
    expect(h.said).toEqual([]);
    expect(h.sessions).toEqual([]);
  });

  test("a wake is refused before its courtesy line while another Mac holds the audio", async () => {
    const h = harness();
    h.holder.yield("mac-b-owner", 1, 60_000);
    await h.voice.handle(wake());
    expect(h.said).toEqual([]);
    expect(h.presented).toEqual([]);
    expect(h.gone).toEqual([]);
    expect(h.sessions).toEqual([]);
    expect(h.logs).toContain("wake refused — mac-b-ow has the audio");
  });

  // D2: reload an idle-unloaded whisper-server under whatever plays first.
  test("a wake prewarms before its courtesy line; a finished turn prewarms before the bell", async () => {
    const w = harness();
    void w.voice.handle(wake());
    await waitFor("the mic", () => w.sessions[0]?.started === 1);
    expect(w.order.slice(0, 2)).toEqual(["prewarm", "said:Mic open for alpha."]);
    await w.voice.close();

    let checks = 0;
    const t = harness({ cfg: { bell: true }, sessionGone: () => ++checks > 1 });
    await t.voice.handle(accepted(t, turnEnd()));
    expect(t.order.slice(0, 3)).toEqual(["prewarm", `cue:${t.cfg.bellSound}`, "said:alpha: the build is green."]);
  });

  // The phone owns the ear as well as the voice.
  test("the phone holding the audio: no barge recorder, no speaking state, no open cue, no mic", async () => {
    const h = harness({ cfg: { bargeThresholdPct: 10, micCues: true } });
    h.lease.request("phone", 1);
    await h.voice.handle(accepted(h, turnEnd()));
    expect(h.barges()).toBe(0);
    expect(getLiveState().state).toBe("idle");
    expect(h.said).toEqual([]);
    expect(h.cues).toEqual([]);
    expect(h.sessions.map((session) => session.started)).toEqual([0]);
    expect(h.logs).toContain('mic held — the phone has the ear ("alpha")');
  });

  // The claim landed and the Mac opened its mic in the same second, then both
  // machines transcribed Tyler and both injected.
  test("the phone claiming the audio during the announcement keeps the Mac's mic shut", async () => {
    const h = harness({ holdSpeech: true, cfg: { micCues: true } });
    const turn = h.voice.handle(accepted(h, turnEnd()));
    await waitFor("the announcement", () => h.said.length === 1);
    h.lease.request("phone", 1);
    h.playing.get("alpha: the build is green.")!.finish();
    await turn;
    expect(h.cues).toEqual([]);
    expect(h.sessions.map((session) => session.started)).toEqual([0]);
    expect(h.logs).toContain('mic held — the phone has the ear ("alpha")');
  });

  test("another Mac taking the audio during the announcement keeps this Mac's mic shut", async () => {
    const h = harness({ holdSpeech: true, cfg: { micCues: true } });
    const turn = h.voice.handle(accepted(h, turnEnd()));
    await waitFor("the announcement", () => h.said.length === 1);
    h.holder.yield("mac-b-owner", 1, 60_000);
    h.playing.get("alpha: the build is green.")!.finish();
    await turn;
    expect(h.cues).toEqual([]);
    expect(h.sessions.map((session) => session.started)).toEqual([0]);
    expect(h.logs).toContain('mic held — the other Mac has the ear ("alpha")');
  });

  test("the mic reservation re-checks the holder after waiting for the lane to go quiet", async () => {
    const h = harness({ holdSpeech: true });
    void h.speech.speak(h.cfg, "the lane is busy");
    await waitFor("the lane", () => h.said.length === 1);
    void h.voice.handle(wake({ compose: true }));
    await waitFor("the reservation", () => h.voice.capturing());
    h.holder.yield("mac-b-owner", 1, 60_000);
    h.playing.get("the lane is busy")!.finish();
    await waitFor("the reservation to give up", () => !h.voice.capturing());
    await Bun.sleep(30);
    expect(h.sessions.map((session) => session.started)).toEqual([0]);
  });

  test("the barge path re-checks the holder after the lane goes quiet, before arming a recorder", async () => {
    const h = harness({ holdSpeech: true, cfg: { bargeThresholdPct: 10 } });
    void h.speech.speak(h.cfg, "the lane is busy");
    await waitFor("the lane", () => h.said.length === 1);
    const turn = h.voice.handle(accepted(h, turnEnd()));
    await waitFor("the announcement to wait for quiet", () => getLiveState().state === "speaking");
    h.holder.yield("mac-b-owner", 1, 60_000);
    h.playing.get("the lane is busy")!.finish();
    await turn;
    expect(h.barges()).toBe(0);
    expect(h.said).toEqual(["the lane is busy"]);
  });
});

/** B5: the four-way decision, by voice. */
describe("permission by voice", () => {
  test("only a permission prompt, with bypass off, for a tool still waiting, gets a voice — and the row says what", async () => {
    const h = harness({ heard: [["yes"]] });
    const event = accepted(h, permission(pendingBash()));
    await h.voice.handle(event);
    expect(event.approval).toMatchObject(ask);
    expect(h.gone).toEqual(["s1"]); // treated as the announced turn it is
    expect(h.ledger.sessionStates.get("s1")?.detail).toBe(approvalDetail(ask));
    expect(h.said[0]).toBe(approvalAnnounce("alpha", ask));
    expect(h.keys).toEqual(["Enter"]);

    const bypassed = harness({ cfg: { bypassPermissions: true } });
    await bypassed.voice.handle(accepted(bypassed, permission(pendingBash())));
    expect(bypassed.ledger.sessionStates.get("s1")?.detail).toBe("needs an answer");
    const idle = harness();
    await idle.voice.handle(accepted(idle, permission(pendingBash(), { ntype: "idle_prompt" })));
    const answered = harness();
    await answered.voice.handle(accepted(answered, permission(transcript(
      assistant(bash), user({ type: "tool_result", tool_use_id: "tu_1", content: "ok" }),
    ))));
    for (const quiet of [bypassed, idle, answered]) {
      expect(quiet.said).toEqual([]);
      expect(quiet.sessions).toEqual([]);
    }
  });

  test("a permission announcement is held by manual mode like any announced turn", async () => {
    const h = harness({ paused: true });
    const event = accepted(h, permission(pendingBash()));
    await h.voice.handle(event);
    expect(h.said).toEqual([]);
    expect(h.sessions).toEqual([]);
    expect(h.ledger.pending.get("s1")).toBe(event);
    expect(h.ledger.lastTurn).toBe(event);
  });

  test("announce, then listen — and the mic is held while the ear is elsewhere", async () => {
    const here = harness({ heard: [["no"]] });
    await here.voice.handle(accepted(here, permission(pendingBash())));
    const announced = here.order.indexOf(`said:${approvalAnnounce("alpha", ask)}`);
    expect(announced).toBeGreaterThan(-1);
    expect(here.order.indexOf("start")).toBeGreaterThan(announced);
    expect(here.keys).toEqual(["Escape"]);

    const phone = harness({ heard: [["yes"]] });
    phone.lease.request("phone", 1);
    await phone.voice.handle(accepted(phone, permission(pendingBash())));
    expect(phone.latch).toEqual([approvalAnnounce("alpha", ask)]);
    expect(phone.sessions).toEqual([]);
    expect(phone.logs).toContain('mic held — the phone has the ear ("alpha")');

    const other = harness({ heard: [["yes"]] });
    other.holder.yield("mac-b-owner", 1, 60_000);
    await other.voice.handle(accepted(other, permission(pendingBash())));
    expect(other.said).toEqual([]);
    expect(other.sessions).toEqual([]);
    expect(other.logs).toContain('mic held — the other Mac has the ear ("alpha")');
  });

  test("unclear is re-asked once, then left for the keyboard", async () => {
    const h = harness({ heard: [["banana split"], ["purple monkey dishwasher"]] });
    await h.voice.handle(accepted(h, permission(pendingBash())));
    expect(h.said).toEqual([approvalAnnounce("alpha", ask), APPROVAL_REASK, APPROVAL_KEYBOARD]);
    expect(h.keys).toEqual([]);
    expect(h.sessions).toHaveLength(2);
  });

  test("always is confirmed by a second yes before any key is pressed", async () => {
    const refused = harness({ heard: [["always"], ["no"]] });
    await refused.voice.handle(accepted(refused, permission(pendingBash())));
    expect(refused.said).toEqual([approvalAnnounce("alpha", ask), confirmAlwaysPrompt(ask), `Not confirmed. ${APPROVAL_KEYBOARD}`]);
    expect(refused.keys).toEqual([]);

    const confirmed = harness({ heard: [["always"], ["yes"]] });
    await confirmed.voice.handle(accepted(confirmed, permission(pendingBash())));
    expect(confirmed.keys).toEqual(["Down", "Enter"]);
  });

  test("instead is Escape, then the alternative typed as the next prompt", async () => {
    const h = harness({ heard: [["no, use main instead"]] });
    await h.voice.handle(accepted(h, permission(pendingBash())));
    expect(h.order.filter((step) => step.startsWith("key:") || step.startsWith("text:")))
      .toEqual(["key:Escape", "text:use main instead"]);
    expect(h.ledger.injectedAt.has("s1")).toBe(true);
  });

  // reserveNormalMic is the invariant: no mic while TTS speaks.
  test("the permission mic waits for the lane to go quiet before it opens", async () => {
    const h = harness({ holdSpeech: true, heard: [["yes"]] });
    const announce = approvalAnnounce("alpha", ask);
    const turn = h.voice.handle(accepted(h, permission(pendingBash())));
    await waitFor("the announcement", () => h.said.includes(announce));
    void h.speech.speak(h.cfg, "something queued behind it");
    h.playing.get(announce)!.finish();
    await waitFor("the queued line", () => h.said.includes("something queued behind it"));
    await Bun.sleep(30);
    expect(h.sessions.map((session) => session.started)).toEqual([0]);
    expect(h.voice.capturing()).toBe(true); // reserved, waiting for quiet
    h.playing.get("something queued behind it")!.finish();
    await turn;
    expect(h.sessions.map((session) => session.started)).toEqual([1]);
    expect(h.keys).toEqual(["Enter"]);
  });
});

describe("the mic, the cue and the composer", () => {
  // Tyler: "clicking it turns it on (but it says reading first for some reason)".
  // A dictation into the composer is visual; a voice wake still announces.
  test("a composer dictation opens the mic without announcing or cueing first", async () => {
    const h = harness({ cfg: { micCues: true } });
    void h.voice.handle(wake({ compose: true }));
    await waitFor("the mic", () => h.sessions[0]?.started === 1);
    expect(h.said).toEqual([]);
    expect(h.cues).toEqual([]);
    await h.voice.close();
  });

  // `mic cue took 3.9s` on a 3.9s open: the cue was the wait. It is fired, and
  // the audio gate still keeps the mic shut until it has finished sounding.
  test("a voice wake fires its open cue without waiting for it, and the mic still waits for the cue to end", async () => {
    const h = harness({ holdCues: true, cfg: { micCues: true } });
    void h.voice.handle(wake());
    await waitFor("the decision to listen", () => h.logs.some((line) => line.startsWith('listening → "alpha"')));
    expect(h.said).toEqual(["Mic open for alpha."]);
    expect(h.cues).toEqual(["/System/Library/Sounds/Tink.aiff"]);
    await Bun.sleep(30);
    expect(h.sessions.map((session) => session.started)).toEqual([0]);
    h.cueExits[0]!(0);
    await waitFor("the mic", () => h.sessions[0]?.started === 1);
    await h.voice.close();
  });

  // "0.0s after the press" measured the daemon agreeing with itself; the arm
  // is the moment a person can talk.
  test("press-to-open is measured at the arm, once, and the decision line claims no timing", async () => {
    const h = harness();
    void h.voice.handle(wake({ compose: true }));
    await waitFor("the mic", () => h.sessions[0]?.started === 1);
    expect(h.logs.find((line) => line.startsWith("listening → "))).not.toContain("after the press");
    h.hooks[0]!.onState?.("armed");
    h.hooks[0]!.onState?.("armed");
    expect(h.logs.filter((line) => /^mic armed \d+\.\ds after the press$/.test(line))).toHaveLength(1);
    await h.voice.close();
  });

  test("a composer dictation heard mid-read goes back to the composer, never into the session", async () => {
    const path = transcript(assistant({ type: "text", text: "First part of the reply. Second part follows. A third closes it." }));
    const h = harness({ cfg: { readFull: true }, gap: () => ({ text: "please also add a regression test" }) });
    const before = getLiveState().dictated?.id ?? 0;
    await h.voice.handle(accepted(h, turnEnd({ compose: true, transcriptPath: path, announce: "alpha: First part of the reply." })));
    expect(getLiveState().dictated).toEqual({ text: "please also add a regression test", id: before + 1, sessionId: "s1" });
    expect(h.texts).toEqual([]);
  });
});

describe("the daemon's wiring of the loop", () => {
  // runDaemon still runs in no test, so what it hands the loop is pinned as text.
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

  test("every dependency is the daemon's own, and production keeps the real terminal and ear", () => {
    const at = daemon.indexOf("const voice = createVoiceLoop({");
    expect(at).toBeGreaterThan(-1);
    const end = daemon.indexOf("\n  });\n", at);
    expect(end).toBeGreaterThan(at);
    const wiring = daemon.slice(at, end);
    for (const line of [
      "ledger,",
      "pause,",
      "queue: eventQueue,",
      "speech,",
      "audio: { lease: audioLease, holder: audioHolder },",
      "quietOverrideBlocked: explicitQuietOverrideBlocked,",
      "window: (sessionId) => panelSessions.get(sessionId),",
      "sessionGone: async (sessionId) => sessionGoneFromSnapshot(await registrySnapshot(cfg.claudeDir), sessionId),",
      "render: () => void renderSessionPanel(),",
      "presentElsewhere,",
      "phoneLatch: { arm: armPhoneSpeechLatch, clear: clearPhoneSpeechLatch },",
      "raiseWindow,",
      "reportError: recordDaemonError,",
      "prewarmEar: () => whisperSupervisor?.prewarm(),",
      "control: handleControl,",
    ]) expect(wiring).toContain(line);
    expect(wiring).not.toContain("\n    terminal:");
    expect(wiring).not.toContain("\n    ear:");
  });

  test("the daemon's dispatcher waits for the voice engine only for events that speak, then hands everything to the loop", () => {
    const at = daemon.indexOf("  async function handle(event: TurnEvent): Promise<void> {");
    expect(at).toBeGreaterThan(-1);
    const end = daemon.indexOf("\n  }\n", at);
    const handle = daemon.slice(at, end);
    const wait = handle.indexOf('if (event.type !== "inject" && event.type !== "interrupt") await ttsStartup;');
    expect(wait).toBeGreaterThan(-1);
    expect(handle.indexOf("return voice.handle(event);")).toBeGreaterThan(wait);
  });
});

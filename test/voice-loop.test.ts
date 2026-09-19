import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { DictationController, type CapturedAudio, type DictationEvent, type RecorderHandle } from "../src/dictation-controller.ts";
import type { InjectTextResult } from "../src/inject.ts";
import type { ProviderCommandResult } from "../src/provider-rename.ts";
import { collectContinuousResult, createDictationSession, type ListenHooks, type ListenResult, type RuntimeDictationSession } from "../src/listen.ts";
import { addressParkedWindow, registrySnapshot, type SessionInfo } from "../src/sessions.ts";
import { buildPanelModel, buildPublishedState, reviewReady } from "../src/panel.ts";
import { reviewIdentity } from "../src/records-receipts.ts";

/** A filed deliverable as the daemon stamps it: the same identity, from the same recipe. */
const filedAs = <R extends { summary: string; link?: string; at: number }>(sessionId: string, review: R) =>
  ({ ...review, id: reviewIdentity(sessionId, review) });
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
import type { RecordObservation } from "../src/records-receipts.ts";

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
  hear(text: string): void {
    this.#deliver({ kind: "transcript", text, rawPath: "", finalBytes: 32_000 } as DictationEvent);
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
  readonly windows: number[] = [];
  setIdleWindowSecs(seconds: number): void { this.windows.push(seconds); }
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
  observeRecords?: VoiceLoopDeps["observeRecords"];
  cfg?: Partial<Config>;
  paused?: boolean;
  /** Utterances play until the test finishes them. */
  holdSpeech?: boolean;
  failSpeech?: (text: string) => boolean;
  /** Cues play until the test ends them. */
  holdCues?: boolean;
  sessionGone?: (sessionId: string) => boolean | Promise<boolean>;
  window?: (sessionId: string) => SessionInfo | undefined;
  inject?: (text: string) => InjectTextResult;
  key?: (key: string) => InjectTextResult;
  beforeKey?: (key: string) => void | Promise<void>;
  command?: (line: string) => ProviderCommandResult;
  /** One script per mic window, in order. */
  heard?: string[][];
  gap?: (...args: Parameters<NonNullable<VoiceLoopDeps["ear"]>["listenGap"]>) => ListenResult | Promise<ListenResult>;
  dictationSession?: () => RuntimeDictationSession;
  /** The ledger to run over: a restarted daemon's, restored from its reviews file. */
  ledger?: SessionLedger;
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
      if (options.failSpeech?.(text)) throw new Error("synthetic speech failure");
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
  }, { spawnAudio, warn: () => {}, observeRecords: options.observeRecords });
  const ledger = options.ledger ?? new SessionLedger();
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
  const keyPids: Array<number | undefined> = [];
  const commands: string[] = [];
  const gone: string[] = [];
  const sessions: FakeSession[] = [];
  const hooks: ListenHooks[] = [];
  const heard = [...(options.heard ?? [])];
  let barges = 0;
  const deps: VoiceLoopDeps = {
    observeRecords: options.observeRecords,
    cfg,
    sleep: async () => {},
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
      injectKey: async (_cfg, pid, key, beforeInject) => {
        await options.beforeKey?.(key);
        if (beforeInject && !(await beforeInject())) return { via: "none", interrupted: true };
        keys.push(key);
        keyPids.push(pid);
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
        if (options.dictationSession) return options.dictationSession();
        const session = new FakeSession(heard.shift() ?? [], order);
        sessions.push(session);
        return session as unknown as RuntimeDictationSession;
      },
      listenGap: async (...args) => options.gap?.(...args) ?? { text: "" },
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
    logs, presented, latch, errors, texts, keys, keyPids, commands, gone, sessions, hooks,
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

describe("operation-owned record observations", () => {
  test("delivery captures the original native owner and reports transport evidence without prompt content", async () => {
    const events: RecordObservation[] = [];
    let nativeId = "native-before";
    const h = harness({
      observeRecords: (event) => events.push(event),
      window: () => ({ ...busy(), backend: "codex", agentSessionId: nativeId }),
      inject: () => { nativeId = "native-after"; return { via: "tmux" }; },
    });
    expect(await h.voice.handle(inject("sensitive message"))).toBe(true);
    const delivery = events.filter(({ kind }) => kind === "delivery");
    expect(delivery.map(({ state }) => state)).toEqual(["accepted", "delivered"]);
    expect(delivery.at(-1)?.code).toBe("transport-submitted");
    expect(delivery.map(({ nativeId }) => nativeId)).toEqual(["native-before", "native-before"]);
    expect(new Set(delivery.map(({ actionId }) => actionId)).size).toBe(1);
    expect(JSON.stringify(delivery)).not.toContain("sensitive message");
  });

  test("staging, known transport failure and thrown transport remain distinct receipts", async () => {
    // The code the receipt keeps IS the reason the sender is told, so the journal and
    // the sentence on the phone can never disagree about the same send.
    const scenarios: Array<{
      options: Options;
      result: boolean | "staged" | { delivered: false; reason: string };
      state: RecordObservation["state"];
      code: string;
    }> = [
      { options: { cfg: { autoSubmit: false } }, result: "staged", state: "staged", code: "staged-not-submitted" },
      { options: { inject: () => ({ via: "none", failed: true, reason: "automation-failed" }) }, result: { delivered: false, reason: "automation-failed" }, state: "failed", code: "automation-failed" },
      { options: { inject: () => { throw Error("synthetic uncertainty"); } }, result: { delivered: false, reason: "transport-error" }, state: "unknown", code: "transport-error" },
    ];
    for (const scenario of scenarios) {
      const events: RecordObservation[] = [];
      const h = harness({ ...scenario.options, observeRecords: (event) => events.push(event) });
      expect(await h.voice.handle(inject("test"))).toEqual(scenario.result);
      const delivery = events.filter(({ kind }) => kind === "delivery");
      expect(delivery.map(({ state }) => state)).toEqual(["accepted", scenario.state]);
      expect(delivery.at(-1)?.code).toBe(scenario.code);
    }
  });

  test("busy provider queuing and exhausted transcript confirmation record their actual evidence", async () => {
    const path = transcript(user({ type: "text", text: "prior" }));
    try {
      for (const busyNow of [true, false]) {
        const events: RecordObservation[] = [];
        const h = harness({ window: busyNow ? busy : undefined, observeRecords: (event) => events.push(event) });
        expect(await h.voice.handle(inject("next", { transcriptPath: path })))
          .toEqual(busyNow ? true : { delivered: false, reason: "delivery-unconfirmed", onClipboard: true });
        const delivery = events.filter(({ kind }) => kind === "delivery");
        expect(delivery.map(({ state }) => state)).toEqual(["accepted", busyNow ? "delivered" : "unknown"]);
        expect(delivery.at(-1)?.code).toBe(busyNow ? "provider-input-queued" : "delivery-unconfirmed");
      }
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });

  test("a failed Return retry cannot disprove that the original submission landed", async () => {
    const path = transcript(user({ type: "text", text: "prior" }));
    try {
      for (const retry of [
        { via: "none", failed: true, reason: "front-window-changed" },
        { via: "none" },
      ] as const) {
        const events: RecordObservation[] = [];
        const h = harness({ key: () => retry, observeRecords: (event) => events.push(event) });
        expect(await h.voice.handle(inject("possibly submitted", { transcriptPath: path })))
          .toEqual({ delivered: false, reason: "reason" in retry ? retry.reason : "delivery-failed" });
        expect(h.texts).toEqual(["possibly submitted"]);
        expect(h.keys).toEqual(["Enter"]);
        const delivery = events.filter(({ kind }) => kind === "delivery");
        expect(delivery.map(({ state }) => state)).toEqual(["accepted", "unknown"]);
        expect(delivery.at(-1)?.code).toBe("reason" in retry ? retry.reason : "delivery-failed");
        expect(new Set(delivery.map(({ actionId }) => actionId)).size).toBe(1);
      }
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });

  test("provider commands have their own action and publication receipts follow accepted state only", async () => {
    const events: RecordObservation[] = [];
    const h = harness({ paused: true, observeRecords: (event) => events.push(event) });
    expect(await h.voice.handle(inject("/model"))).toBe(true);
    expect(events.map(({ state }) => state)).toEqual(["accepted", "delivered"]);
    events.length = 0;
    const published = (at: number): TurnEvent => ({
      type: "review-published", sessionId: "s1", label: "alpha", announce: "private announcement",
      eventAt: at, review: { summary: "private result", link: "https://example.test/private" },
    });
    await h.voice.handle(accepted(h, published(2_000)));
    await h.voice.handle(accepted(h, published(1_000)));
    expect(events.map(({ state }) => state)).toEqual(["published"]);
    expect(events[0]?.observedAt).toBe(2_000);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(h.said).toEqual([]);
  });

  test("speech gets the event session and a broken receipt observer cannot change a send", async () => {
    const events: RecordObservation[] = [];
    const h = harness({ observeRecords: (event) => events.push(event) });
    await h.voice.speak(h.cfg, "read this", "display-only", true, "s1");
    expect(events.map(({ state }) => state)).toEqual(["queued", "started", "unknown"]);
    expect(events.every(({ sessionId }) => sessionId === "s1")).toBeTrue();
    const broken = harness({ observeRecords: () => { throw Error("optional journal unavailable"); } });
    expect(await broken.voice.handle(inject("still delivered"))).toBe(true);
  });
});

/**
 * A14. Immediate `handle` calls (the inject/interrupt path that skips the
 * drain) used to reset the shared `stopKey` and `micOpen` under a queued
 * exchange mid-await. Cut four pinned that as it behaved; these are the
 * flipped pins. Only events that start an exchange reset them now.
 */
describe("a shared transcript confirms only this window's send (finding 9)", () => {
  const KEY = "4eb30ede-6c1e-4f5a-9d2b-1f0c2a3b4c5d#39889";
  const preamble = (bridge: string | undefined, leafUuid: string) => [
    { type: "last-prompt", leafUuid },
    ...(bridge ? [{ type: "bridge-session", bridgeSessionId: `cse_${bridge}` }] : []),
  ];
  const prompt = (uuid: string, parentUuid: string | null, text: string) =>
    ({ type: "user", uuid, parentUuid, message: { role: "user", content: text } });
  const reply = (uuid: string, parentUuid: string) =>
    ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
  const windowA = (bridge?: string) => () => ({ sessionId: KEY, status: "idle", ...(bridge ? { bridgeSessionId: `session_${bridge}` } : {}) }) as SessionInfo;

  async function send(options: { sessionId: string; window?: () => SessionInfo; bridges: boolean; lands: "A" | "B" }) {
    const bridge = (name: string) => (options.bridges ? name : undefined);
    const path = transcript(...preamble(bridge("A"), "u1"), prompt("u1", null, "shared"), ...preamble(bridge("A"), "u1"), reply("a1", "u1"));
    const events: RecordObservation[] = [];
    try {
      const h = harness({
        window: options.window,
        observeRecords: (event) => events.push(event),
        inject: () => {
          const landed = options.lands === "A"
            ? [...preamble(bridge("A"), "a1"), prompt("u3", "a1", "A sends")]
            : [...preamble(bridge("B"), "a1"), prompt("u2", "a1", "B sends")];
          appendFileSync(path, landed.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
          return { via: "tmux" };
        },
      });
      const result = await h.voice.handle(inject("hello", { sessionId: options.sessionId, transcriptPath: path }));
      const last = events.filter(({ kind }) => kind === "delivery").at(-1);
      return { result, state: last?.state, code: last?.code, said: h.said, keys: h.keys };
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  }

  test("the other window's prompt does not confirm this window's send", async () => {
    expect(await send({ sessionId: KEY, window: windowA("A"), bridges: true, lands: "B" }))
      .toMatchObject({
        result: { delivered: false, reason: "delivery-unconfirmed", onClipboard: true },
        state: "unknown",
        code: "delivery-unconfirmed",
      });
  });

  test("this window's own prompt still confirms its send", async () => {
    expect(await send({ sessionId: KEY, window: windowA("A"), bridges: true, lands: "A" }))
      .toMatchObject({ result: true, state: "delivered", code: "transcript-advanced" });
  });

  test("a prompt nothing attributes reports unconfirmed, not delivered and not failed", async () => {
    for (const scenario of [
      { window: windowA(), bridges: true },
      { window: windowA("A"), bridges: false },
      { window: undefined, bridges: true },
    ]) {
      const outcome = await send({ sessionId: KEY, ...scenario, lands: "A" });
      // Nothing about the clipboard here: these words were not put on one.
      expect(outcome).toMatchObject({
        result: { delivered: false, reason: "delivery-unattributed" },
        state: "unknown",
        code: "delivery-unattributed",
      });
      expect(outcome.said.some((line) => line.includes("didn't send"))).toBe(false);
    }
  });

  /**
   * Rank 7's tail. An unattributable prompt is not a failure to retry: a prompt DID land,
   * and conch cannot tell whose it is. Pressing Return again types into a session that may
   * already have taken the words — so the keys stop the moment attribution comes back
   * unknown, and conch reports the uncertainty instead of acting on it.
   */
  test("an unattributable prompt stops the keys at once instead of re-pressing Return", async () => {
    const outcome = await send({ sessionId: KEY, window: windowA(), bridges: true, lands: "A" });
    expect(outcome.code).toBe("delivery-unattributed");
    expect(outcome.keys).toEqual([]);
  });

  test("a lone session confirms on any new prompt, as before", async () => {
    expect(await send({ sessionId: "s1", bridges: true, lands: "B" }))
      .toMatchObject({ result: true, state: "delivered", code: "transcript-advanced" });
  });
});

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

describe("an inject says whether it landed", () => {
  // The phone waits on this (`awaitDelivery` → inject-done `delivered`) to show
  // "delivered" or "not delivered" instead of guessing from the ack.
  test("true only when the words reached the session", async () => {
    expect(await harness().voice.handle(inject("typed into a pane"))).toBe(true);
    // Not just "no": what stopped it, and whether the words survived on the Mac's
    // clipboard — the phone shows that as a sentence instead of a shrug.
    expect(await harness({ inject: () => ({ via: "clipboard" }) }).voice.handle(inject("on the clipboard")))
      .toEqual({ delivered: false, reason: "clipboard-fallback", onClipboard: true });
    expect(await harness({ inject: () => ({ via: "none", interrupted: true }) }).voice.handle(inject("cut off")))
      .toEqual({ delivered: false, reason: "delivery-interrupted" });
    expect(await harness().voice.handle(inject("/model opus"))).toBe(true);
    const unroutable = harness({ command: () => ({ kind: "unroutable", reason: "session has no routable pid" }) });
    expect(await unroutable.voice.handle(inject("/compact"))).toBe(false);
  });

  /**
   * The send that started this: 2026-09-16, three messages from the phone, a modal dialog
   * open on the Mac swallowing every AppleScript call. conch fell back to the clipboard,
   * refused to claim delivery, said why out loud on the Mac — and told the phone "failed".
   * Tyler, in another room, had no way to learn that a popup was eating his messages.
   */
  test("a dialog blocking the Mac says so, and says where the words are", async () => {
    const events: RecordObservation[] = [];
    const h = harness({
      inject: () => ({ via: "clipboard", reason: "system-dialog-blocking" }),
      observeRecords: (event) => events.push(event),
    });
    expect(await h.voice.handle(inject("the message that never arrived")))
      .toEqual({ delivered: false, reason: "system-dialog-blocking", onClipboard: true });
    expect(events.filter(({ kind }) => kind === "delivery").at(-1)?.code).toBe("system-dialog-blocking");
    // The daemon log names it too — it used to read "phone inject into … failed" and stop there.
    expect(h.logs).toContain('phone inject into "alpha" failed (system-dialog-blocking)');
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

describe("the dashboard latch", () => {
  test("only a Stop reclassified as background work latches the flag the registry cannot correct", async () => {
    const h = harness({ cfg: { workingMic: false } });
    const working = (sessionId: string, over: Partial<TurnEvent> = {}): TurnEvent =>
      ({ type: "working", sessionId, label: sessionId, announce: "", eventAt: 1_000, ...over });
    await h.voice.handle(accepted(h, working("background", { backgroundWork: true })));
    await h.voice.handle(accepted(h, working("prompt")));
    expect(h.ledger.sessionStates.get("background")).toMatchObject({ status: "working", backgroundWork: true });
    expect(h.ledger.sessionStates.get("prompt")?.status).toBe("working");
    expect(h.ledger.sessionStates.get("prompt")?.backgroundWork).toBeUndefined();
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

/** Synthetic provider state; the production pending-approval reader observes each change. */
function replaceApproval(path: string, next: "resolved" | "new-request"): void {
  const entries = next === "resolved"
    ? [assistant(bash), user({ type: "tool_result", tool_use_id: "tu_1", content: "answered by keyboard" })]
    // Same tool/summary, distinct native ID: textual equality does not authorize it.
    : [assistant({ ...bash, id: "tu_new" })];
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

describe("permission request lifetime", () => {
  test("keyboard resolution closes an idle permission mic without another voice event", async () => {
    const path = pendingBash();
    const h = harness({ heard: [[]] });
    const turn = h.voice.handle(accepted(h, permission(path)));
    try {
      await waitFor("permission mic", () => h.sessions[0]?.started === 1);
      replaceApproval(path, "resolved");
      await waitFor("stale permission mic to close", () => !h.voice.capturing());
      await turn;
      expect(h.keys).toEqual([]);
    } finally {
      h.voice.stop("test cleanup");
      await turn;
    }
  });

  for (const next of ["resolved", "new-request"] as const) {
    test(`${next} during the announcement cancels the mic and approval`, async () => {
      const path = pendingBash();
      const h = harness({ holdSpeech: true, heard: [["yes"]] });
      const announce = approvalAnnounce("alpha", ask);
      const turn = h.voice.handle(accepted(h, permission(path)));
      await waitFor("permission announcement", () => h.playing.has(announce));
      replaceApproval(path, next);
      h.playing.get(announce)!.finish();
      await turn;
      expect(h.keys).toEqual([]);
      expect(h.sessions).toEqual([]);
    });

    test(`${next} while listening cannot use the captured yes`, async () => {
      const path = pendingBash();
      const h = harness({ heard: [[]] });
      const turn = h.voice.handle(accepted(h, permission(path)));
      await waitFor("permission mic", () => h.sessions[0]?.started === 1);
      replaceApproval(path, next);
      h.sessions[0]!.hear("yes");
      await turn;
      expect(h.keys).toEqual([]);
      expect(h.voice.capturing()).toBe(false);
    });
  }

  test("a request resolved during the bell is never announced", async () => {
    const path = pendingBash();
    const h = harness({ holdCues: true, cfg: { bell: true }, heard: [["yes"]] });
    const turn = h.voice.handle(accepted(h, permission(path)));
    await waitFor("attention bell", () => h.cueExits.length === 1);
    replaceApproval(path, "resolved");
    // Finish every cue the old path erroneously reaches, so this fails on its assertions.
    h.cfg.micCues = false;
    h.cueExits[0]!(0);
    await turn;
    expect(h.said).toEqual([]);
    expect(h.keys).toEqual([]);
  });

  test("the final injection callback rejects a replacement request", async () => {
    const path = pendingBash();
    const h = harness({ heard: [["yes"]], beforeKey: () => replaceApproval(path, "new-request") });
    await h.voice.handle(accepted(h, permission(path)));
    expect(h.keys).toEqual([]);
  });

  test("replacement during the always confirmation announcement cancels both keys", async () => {
    const path = pendingBash();
    const h = harness({ holdSpeech: true, heard: [["always"], ["yes"]] });
    const announce = approvalAnnounce("alpha", ask);
    const confirmation = confirmAlwaysPrompt(ask);
    const turn = h.voice.handle(accepted(h, permission(path)));
    await waitFor("permission announcement", () => h.playing.has(announce));
    h.playing.get(announce)!.finish();
    await waitFor("always confirmation", () => h.playing.has(confirmation));
    replaceApproval(path, "new-request");
    h.playing.get(confirmation)!.finish();
    await turn;
    expect(h.keys).toEqual([]);
    expect(h.sessions).toHaveLength(1);
  });

  test("manual resolution during the second always listen invalidates its yes", async () => {
    const path = pendingBash();
    const h = harness({ heard: [["always"], []] });
    const turn = h.voice.handle(accepted(h, permission(path)));
    await waitFor("second permission mic", () => h.sessions[1]?.started === 1);
    replaceApproval(path, "resolved");
    h.sessions[1]!.hear("yes");
    await turn;
    expect(h.keys).toEqual([]);
  });

  for (const next of ["resolved", "new-request"] as const) {
    test(`an alternative after our Escape handles ${next} without answering a new ask`, async () => {
      const path = pendingBash();
      const h = harness({ heard: [["no, use main instead"]], key: () => {
        replaceApproval(path, next);
        return { via: "tmux" };
      } });
      await h.voice.handle(accepted(h, permission(path)));
      expect(h.keys).toEqual(["Escape"]);
      expect(h.texts).toEqual(next === "resolved" ? ["use main instead"] : []);
    });
  }

  test("replacement after Down cannot receive the confirming Enter", async () => {
    const path = pendingBash();
    const h = harness({ heard: [["always"], ["yes"]], key: (key) => {
      if (key === "Down") replaceApproval(path, "new-request");
      return { via: "tmux" };
    } });
    await h.voice.handle(accepted(h, permission(path)));
    expect(h.keys).toEqual(["Down"]);
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

  test("alternative prompts observe direct delivery without adding keys or confirmation retries", async () => {
    const scenarios: Array<{ result: InjectTextResult; autoSubmit: boolean; state: RecordObservation["state"]; code: string }> = [
      { result: { via: "tmux" }, autoSubmit: true, state: "delivered", code: "transport-submitted" },
      { result: { via: "tmux" }, autoSubmit: false, state: "staged", code: "staged-not-submitted" },
      { result: { via: "none", failed: true, reason: "automation-failed" }, autoSubmit: true, state: "failed", code: "automation-failed" },
      { result: { via: "clipboard" }, autoSubmit: true, state: "failed", code: "clipboard-fallback" },
      { result: { via: "none", interrupted: true }, autoSubmit: true, state: "unknown", code: "delivery-interrupted" },
    ];
    for (const scenario of scenarios) {
      const path = pendingBash();
      const events: RecordObservation[] = [];
      let nativeId = "original-native-id";
      const h = harness({
        heard: [["no, use main instead"]], cfg: { autoSubmit: scenario.autoSubmit },
        observeRecords: (event) => events.push(event),
        window: () => ({ ...busy(), backend: "claude", agentSessionId: nativeId }),
        inject: () => { nativeId = "replacement-native-id"; return scenario.result; },
      });
      try {
        await h.voice.handle(accepted(h, permission(path)));
        expect(h.keys).toEqual(["Escape"]);
        expect(h.texts).toEqual(["use main instead"]);
        const delivery = events.filter(({ kind }) => kind === "delivery");
        expect(delivery.map(({ state }) => state)).toEqual(["accepted", scenario.state]);
        expect(delivery[0]?.code).toBe("alternative-prompt-accepted");
        expect(delivery.at(-1)?.code).toBe(scenario.code);
        expect(delivery.map(({ nativeId }) => nativeId)).toEqual(["original-native-id", "original-native-id"]);
        expect(new Set(delivery.map(({ actionId }) => actionId)).size).toBe(1);
        expect(JSON.stringify(delivery)).not.toContain("use main instead");
      } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
    }
  });

  test("a thrown alternative transport records uncertainty and preserves the thrown outcome", async () => {
    const path = pendingBash();
    const events: RecordObservation[] = [];
    const h = harness({
      heard: [["no, use main instead"]], observeRecords: (event) => events.push(event),
      inject: () => { throw Error("synthetic transport uncertainty"); },
    });
    try {
      await expect(h.voice.handle(accepted(h, permission(path)))).rejects.toThrow("synthetic transport uncertainty");
      expect(h.keys).toEqual(["Escape"]);
      const delivery = events.filter(({ kind }) => kind === "delivery");
      expect(delivery.map(({ state }) => state)).toEqual(["accepted", "unknown"]);
      expect(delivery.at(-1)?.code).toBe("delivery-outcome-unknown");
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
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

  // The daemon log lives for weeks in /tmp: it records which session got a
  // dictation and how long it was, and at most a short classifier preview.
  test("dictated and injected words never reach the log in full", async () => {
    const path = transcript(assistant({ type: "text", text: "First part of the reply. Second part follows. A third closes it." }));
    const composer = harness({ cfg: { readFull: true }, gap: () => ({ text: "please also add a regression test" }) });
    await composer.voice.handle(accepted(composer, turnEnd({ compose: true, transcriptPath: path, announce: "alpha: First part of the reply." })));
    const sent = harness();
    await sent.voice.handle(inject("tell the database team the migration is ready"));
    expect(sent.texts).toEqual(["tell the database team the migration is ready"]);
    const logs = [...composer.logs, ...sent.logs];
    expect(logs).toContain("dictated → composer (33 chars)");
    expect(logs).toContain('heard → "alpha" (45 chars)');
    expect(logs.filter((line) => line.includes("regression test") || line.includes("migration is ready"))).toEqual([]);
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

/** Real controller/FIFO/reducer, with synthetic bytes and no processes or files. */
function failingDictation(stage: "capture" | "read" | "transcribe", firstResult?: Promise<void>) {
  const recorders: Array<{ finish(text: string, error?: string): void; stops: string[] }> = [];
  const callbacks = new Set<() => void>();
  const controller = new DictationController({
    backend: {
      open() {
        const result = deferred<CapturedAudio>();
        const stops: string[] = [];
        const recorder = {
          stops,
          finish(text: string, error?: string) {
            result.resolve({ rawPath: text, finalBytes: 32_000, ...(error ? { error } : {}) });
          },
        };
        recorders.push(recorder);
        return {
          finished: result.promise,
          stop(reason) {
            stops.push(reason);
            recorder.finish("but keep the comments");
          },
        } satisfies RecorderHandle;
      },
      read(capture) {
        if (stage === "read" && capture.rawPath === "failed fragment") throw new Error("synthetic read failure");
        return new TextEncoder().encode(capture.rawPath);
      },
    },
    transcriber: {
      async transcribe(pcm) {
        const text = new TextDecoder().decode(pcm);
        if (text !== "failed fragment") await firstResult;
        return stage === "transcribe" && text === "failed fragment"
          ? { text: "", error: "synthetic transcription failure" }
          : { text };
      },
    },
    minimumBytes: 16_000,
    deleteRaw() {},
    clock: {
      setTimeout(callback) { callbacks.add(callback); return callback; },
      clearTimeout(handle) { callbacks.delete(handle as () => void); },
    },
  });
  const session: RuntimeDictationSession = {
    controller,
    get micOpen() { return controller.micOpen; },
    get state() { return controller.state; },
    start: (capture) => controller.start(capture),
    resume: (capture) => controller.resume(capture),
    nextEvent: () => controller.nextEvent(),
    acknowledge: (event) => controller.acknowledge(event),
    requestBarrier: (reason) => controller.requestBarrier(reason),
    requestTimeout: () => controller.requestTimeout(),
    setIdleWindowSecs: (seconds) => controller.scheduleTimeout(seconds * 1000),
    abort: () => controller.requestBarrier("manual-reply").done,
  };
  return { controller, session, recorders };
}

describe("dictation failure recovery", () => {
  test("draft recovery completes even when the post-drain warning fails", async () => {
    const audio = failingDictation("transcribe");
    const h = harness({
      dictationSession: () => audio.session,
      cfg: { interruptOnManualReply: false },
      failSpeech: (text) => text.startsWith("Dictation was incomplete"),
    });
    const before = getLiveState().dictated?.id ?? 0;
    const turn = h.voice.handle(wake());
    const outcome = turn.then(() => null, (error) => error);
    await waitFor("first synthetic recorder", () => audio.recorders.length === 1);
    audio.recorders[0]!.finish("make the change");
    await waitFor("first result to drain", () => audio.recorders.length === 2 && audio.controller.finalWorkerIdle);
    audio.recorders[1]!.finish("failed fragment");
    expect(await outcome).toEqual(new Error("synthetic speech failure"));
    expect(h.texts).toEqual([]);
    expect(getLiveState().dictated).toEqual({
      text: "make the change but keep the comments", id: before + 1, sessionId: "s1",
    });
    expect(h.voice.capturing()).toBe(false);
    expect(h.violations).toEqual([]);
  });

  test("a failed tail cancels an earlier send already waiting for its barrier", async () => {
    const first = deferred<void>();
    const audio = failingDictation("transcribe", first.promise);
    const h = harness({ dictationSession: () => audio.session, cfg: { interruptOnManualReply: false } });
    const before = getLiveState().dictated?.id ?? 0;
    const turn = h.voice.handle(wake());
    await waitFor("first synthetic recorder", () => audio.recorders.length === 1);
    audio.recorders[0]!.finish("make the change. Send.");
    await waitFor("second synthetic recorder", () => audio.recorders.length === 2);
    audio.recorders[1]!.finish("failed fragment");
    await waitFor("failed capture queued before send", () => audio.recorders.length === 3);
    first.resolve();
    await turn;
    expect(h.texts).toEqual([]);
    expect(getLiveState().dictated).toEqual({
      text: "make the change. but keep the comments", id: before + 1, sessionId: "s1",
    });
    expect(audio.controller.state).toBe("idle");
    expect(h.violations).toEqual([]);
  });

  test("one utterance drained twice is recovered once, not repeated in the draft", async () => {
    // Tyler's report: a sentence arrived in the composer six times, space-joined,
    // "until i closed the convo bar". The published dictation itself held the
    // repeats, so nothing on the app side could have deduplicated them — the
    // recovery joined a drain backlog in which the same words appeared again and
    // again. Here the buffered segment and the words the drain hands back are the
    // SAME utterance, which is exactly the shape that corrupted the draft.
    const audio = failingDictation("transcribe");
    const h = harness({ dictationSession: () => audio.session, cfg: { interruptOnManualReply: false } });
    const before = getLiveState().dictated?.id ?? 0;
    const turn = h.voice.handle(wake());
    await waitFor("first synthetic recorder", () => audio.recorders.length === 1);
    // The same words the exit drain will hand back when it stops the live recorder.
    audio.recorders[0]!.finish("but keep the comments");
    await waitFor("first result to drain", () => audio.recorders.length === 2 && audio.controller.finalWorkerIdle);
    audio.recorders[1]!.finish("failed fragment");
    await turn;
    expect(h.texts).toEqual([]);
    // Published ONCE, and the sentence appears once inside it.
    expect(getLiveState().dictated).toEqual({
      text: "but keep the comments", id: before + 1, sessionId: "s1",
    });
    expect(h.violations).toEqual([]);
  });

  for (const stage of ["capture", "read", "transcribe"] as const) {
    test(`a ${stage} failure preserves good speech as a draft and never submits it`, async () => {
      const audio = failingDictation(stage);
      const h = harness({ dictationSession: () => audio.session, cfg: { interruptOnManualReply: false } });
      const before = getLiveState().dictated?.id ?? 0;
      const turn = h.voice.handle(wake());
      await waitFor("first synthetic recorder", () => audio.recorders.length === 1);
      audio.recorders[0]!.finish("make the change");
      await waitFor("first result to drain", () => audio.recorders.length === 2 && audio.controller.finalWorkerIdle);
      audio.recorders[1]!.finish("failed fragment", stage === "capture" ? "synthetic capture failure" : undefined);
      await turn;
      expect(h.texts).toEqual([]);
      expect(h.keys).toEqual([]);
      expect(getLiveState().dictated).toEqual({
        text: "make the change but keep the comments", id: before + 1, sessionId: "s1",
      });
      expect(h.errors.some((entry) => String(entry[1]).includes("incomplete"))).toBe(true);
      expect(h.said.at(-1)).toBe("Dictation was incomplete. Your recovered words are in the draft. Review them or retry before sending.");
      expect(h.voice.capturing()).toBe(false);
      expect(audio.controller.state).toBe("idle");
      expect(h.violations).toEqual([]);
    });
  }
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
    const at = daemon.indexOf("  async function handle(event: TurnEvent): Promise<SocketTurnOutcome> {");
    expect(at).toBeGreaterThan(-1);
    const end = daemon.indexOf("\n  }\n", at);
    const handle = daemon.slice(at, end);
    const wait = handle.indexOf('if (event.type !== "inject" && event.type !== "interrupt") await ttsStartup;');
    expect(wait).toBeGreaterThan(-1);
    expect(handle.indexOf("return voice.handle(event);")).toBeGreaterThan(wait);
  });
});

describe("an event naming a background job's hidden window", () => {
  // The wire shape a conch MCP server that started before #187 sends for
  // `review_to_front(session: "conch")`: the window's stale id and pid. The
  // daemon's socket door (`addressWindow`) runs it through
  // `addressParkedWindow`; the loop latches it; the published row carries it.
  test("a review sent to the window's stale id lands on the job's row in published state", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-stale-window-"));
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    const register = (pid: number, entry: object) => writeFileSync(
      join(claudeDir, "sessions", `${pid}.json`),
      JSON.stringify({ pid, cwd: "/Users/t", entrypoint: "cli", status: "idle", ...entry }),
    );
    // The window must be a live pid to route; this process is.
    register(process.pid, { sessionId: "pred", kind: "interactive", name: "conch", parkedJobId: "succjob" });
    register(72858, { sessionId: "succ", kind: "bg", name: "conch", jobId: "succjob" });
    const options = { configDir: join(claudeDir, "conch-config"), codexHome: join(claudeDir, "codex"), processParents: async () => null };
    try {
      const rows = (await registrySnapshot(claudeDir, options))!.infos;
      expect(rows.map((row) => row.sessionId)).toEqual(["succ"]);
      const wire: TurnEvent = {
        type: "turn-end", sessionId: "pred", pid: process.pid, label: "conch",
        announce: "conch has work ready for your review: the stale-id fix", eventAt: 1,
        review: { summary: "the stale-id fix", link: "https://example.com/pr" },
      };
      const event = await addressParkedWindow(claudeDir, wire, (id) => rows.some((row) => row.sessionId === id)) as TurnEvent;
      // Manual mode: the latch happens, nothing is spoken or opened.
      const h = harness({ paused: true });
      await h.voice.handle(accepted(h, event));
      const published = buildPublishedState("device", buildPanelModel({
        sessions: rows,
        sessionStates: h.ledger.sessionStates,
        pausedSessionIds: new Set(),
        live: { state: "idle", label: "", partial: "" },
        mode: { muted: false, paused: false, holding: 0 },
        activeSessionId: null,
        navSelectedId: null,
      }), new Map(), new Set(), Date.now());
      expect(published.rows.map((row) => row.id)).toEqual(["succ"]);
      expect(published.rows[0]!.review).toMatchObject({ summary: "the stale-id fix", link: "https://example.com/pr" });
      expect(h.ledger.sessionStates.has("pred")).toBe(false);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

/**
 * A deliverable has ONE identity from filing until a newer one replaces it.
 * Its published `at` used to be the session's LATEST latch time, so every
 * turn-end or notification re-stamped it: the Mac keyed the pane on it and
 * snapped back to the conversation while it was being read. And it was not
 * published at all while the session worked, so replying to the agent pulled
 * it out of both apps.
 */
describe("a deliverable keeps one identity from filing until a newer one", () => {
  const modelFor = (h: Harness) => buildPanelModel({
    sessions: [{ sessionId: "s1", name: "alpha" } as SessionInfo],
    sessionStates: h.ledger.sessionStates,
    pausedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  });
  const rowFor = (h: Harness) => modelFor(h).rows[0]!;
  const publishedReview = (h: Harness) =>
    buildPublishedState("device", modelFor(h), new Map(), new Set(), Date.now()).rows[0]!.review;

  test("routine events neither re-stamp it nor hide it while the session works", async () => {
    const h = harness({ paused: true });
    const review = { summary: "hero v3", link: "/tmp/hero-v3.png" };
    await h.voice.handle(accepted(h, turnEnd({ eventAt: 1_000, review })));
    const filed = filedAs("s1", { ...review, at: 1_000 });
    expect(h.ledger.sessionStates.get("s1")?.review).toEqual(filed);
    expect(rowFor(h).review).toEqual(filed);
    expect(reviewReady(rowFor(h))).toBe(true);

    // Replying to the agent starts a turn.
    await h.voice.handle(accepted(h, { type: "working", sessionId: "s1", label: "alpha", announce: "", eventAt: 2_000 }));
    expect(rowFor(h).status).toBe("working");
    expect(rowFor(h).review).toEqual(filed);
    expect(publishedReview(h)).toEqual(filed);
    expect(reviewReady(rowFor(h))).toBe(false);

    await h.voice.handle(accepted(h, { type: "needs-you", ntype: "idle_prompt", sessionId: "s1", label: "alpha", announce: "", eventAt: 3_000 }));
    expect(rowFor(h).status).toBe("needs");
    expect(publishedReview(h)).toEqual(filed);
    expect(reviewReady(rowFor(h))).toBe(true);

    await h.voice.handle(accepted(h, turnEnd({ eventAt: 4_000 })));
    expect(rowFor(h)).toMatchObject({ status: "waiting", at: 4_000 });
    expect(publishedReview(h)).toEqual(filed);
    expect(reviewReady(rowFor(h))).toBe(true);

    // Sending it again, even unchanged, is a newer deliverable.
    await h.voice.handle(accepted(h, turnEnd({ eventAt: 5_000, review })));
    expect(publishedReview(h)).toEqual(filedAs("s1", { ...review, at: 5_000 }));
  });

  test("its identity is minted once at filing, survives republishing, and moves only for a newer one", async () => {
    const h = harness({ paused: true });
    const review = { summary: "hero v3", link: "/tmp/hero-v3.png" };
    await h.voice.handle(accepted(h, turnEnd({ eventAt: 1_000, review })));
    const first = rowFor(h).review?.id;
    expect(first).toBeTruthy();

    // Routine events carry the record forward. None of them re-stamp it.
    await h.voice.handle(accepted(h, { type: "working", sessionId: "s1", label: "alpha", announce: "", eventAt: 2_000 }));
    await h.voice.handle(accepted(h, turnEnd({ eventAt: 4_000 })));
    expect(rowFor(h).review?.id).toBe(first);
    expect(publishedReview(h)?.id).toBe(first);

    // A newer deliverable is a different one, even filing the identical text again.
    await h.voice.handle(accepted(h, turnEnd({ eventAt: 5_000, review })));
    expect(rowFor(h).review?.id).not.toBe(first);

    // Two deliverables differing only in what they say are still two deliverables: the
    // filing time alone would collide inside a millisecond.
    expect(reviewIdentity("s1", { ...review, at: 5_000 }))
      .not.toBe(reviewIdentity("s1", { summary: "hero v4", link: review.link, at: 5_000 }));
  });

  /**
   * Since PR #191 the deliverable lived only in the in-memory latch, so every
   * daemon restart erased each session's current one from both apps. It is
   * written out when filed and restored on start with the same `at`; status is
   * not, and still comes from the registry and hooks.
   */
  test("it survives a daemon restart with the same identity; status does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-reviews-"));
    const reviewsPath = join(dir, "reviews.json");
    try {
      const before = harness({ paused: true, ledger: new SessionLedger(reviewsPath) });
      const review = { summary: "hero v3", link: "/tmp/hero-v3.png" };
      await before.voice.handle(accepted(before, turnEnd({ eventAt: 1_000, review })));
      const filed = filedAs("s1", { ...review, at: 1_000 });

      // The restart: a new ledger over the same file, and nothing else carried.
      const restarted = new SessionLedger(reviewsPath);
      restarted.restoreReviews();
      const after = harness({ paused: true, ledger: restarted });
      expect(publishedReview(after)).toEqual(filed);

      // The registry says busy, newer than nothing: the row works, the review stays.
      const registry = buildPanelModel({
        sessions: [{ sessionId: "s1", name: "alpha", status: "busy", statusUpdatedAt: 500 } as SessionInfo],
        sessionStates: restarted.sessionStates,
        pausedSessionIds: new Set(),
        live: { state: "idle", label: "", partial: "" },
        mode: { muted: false, paused: false, holding: 0 },
        activeSessionId: null,
        navSelectedId: null,
      }).rows[0]!;
      expect(registry.status).toBe("working");
      expect(registry.review).toEqual(filed);

      // A hook after the restart sets status and carries the same record.
      await after.voice.handle(accepted(after, { type: "working", sessionId: "s1", label: "alpha", announce: "", eventAt: 2_000 }));
      expect(rowFor(after)).toMatchObject({ status: "working", at: 2_000 });
      expect(publishedReview(after)).toEqual(filed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `review_to_front` used to send a synthetic `turn-end`: a publication mid-turn
 * latched the row waiting while the agent worked, opened the mic for a reply,
 * and the real Stop announced again. It is its own event now.
 */
describe("a publication is not the end of a turn", () => {
  const rowFor = (h: Harness) => buildPanelModel({
    sessions: [{ sessionId: "s1", name: "alpha" } as SessionInfo],
    sessionStates: h.ledger.sessionStates,
    pausedSessionIds: new Set(),
    live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 },
    activeSessionId: null,
    navSelectedId: null,
  }).rows[0]!;
  const review = { summary: "hero v3", link: "/tmp/hero-v3.png" };
  const announce = "alpha has work ready for your review: hero v3";
  const published = (over: Partial<TurnEvent> = {}): TurnEvent => ({
    type: "review-published", sessionId: "s1", label: "alpha", announce, eventAt: 2_000, review, ...over,
  });

  test("mid-turn it files the deliverable and says so once; the turn works on until its own Stop", async () => {
    // Live for its turn's own check, gone from then on, so the Stop's mic window closes.
    let checks = 0;
    const h = harness({ sessionGone: () => ++checks > 1 });
    await h.voice.handle(accepted(h, { type: "working", sessionId: "s1", label: "alpha", announce: "", eventAt: 1_000 }));
    await h.voice.handle(accepted(h, published()));
    expect(rowFor(h)).toMatchObject({ status: "working", review: { ...review, at: 2_000 } });
    expect(reviewReady(rowFor(h))).toBe(false);
    expect(h.said).toEqual([announce]);
    expect(h.sessions).toHaveLength(0); // no mic opened for a reply
    expect(h.ledger.lastTurn ?? null).toBeNull();

    await h.voice.handle(accepted(h, turnEnd({ eventAt: 3_000 })));
    expect(rowFor(h)).toMatchObject({ status: "waiting", review: { ...review, at: 2_000 } });
    expect(reviewReady(rowFor(h))).toBe(true);
    expect(h.said).toEqual([announce, "alpha: the build is green."]);
    expect(h.ledger.lastTurn?.type).toBe("turn-end");
  });

  test("its scene is filed with it and published on the row as rows[].review.scene", async () => {
    const h = harness({ paused: true });
    const scene = { v: 1 as const, target: { kind: "conversation" as const }, inspect: "Check that Save stays reachable" };
    await h.voice.handle(accepted(h, published({ review: { ...review, scene } })));
    const state = buildPublishedState("device", buildPanelModel({
      sessions: [{ sessionId: "s1", name: "alpha" } as SessionInfo],
      sessionStates: h.ledger.sessionStates,
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    }), new Map(), new Set(), Date.now());
    expect(state.rows[0]!.review).toEqual(filedAs("s1", { ...review, scene, at: 2_000 }));
  });

  test("in manual it files silently and holds nothing for replay", async () => {
    const h = harness({ paused: true });
    await h.voice.handle(accepted(h, published()));
    expect(rowFor(h).review).toEqual(filedAs("s1", { ...review, at: 2_000 }));
    expect(h.said).toEqual([]);
    expect(h.ledger.pending.size).toBe(0);
  });

  test("a Stop that lands first does not make it stale, and an older one replayed later does not replace a newer one", async () => {
    const h = harness({ paused: true });
    const stop = accepted(h, turnEnd({ eventAt: 3_000 }));
    const publication = accepted(h, published());
    await h.voice.handle(stop);
    await h.voice.handle(publication);
    expect(rowFor(h)).toMatchObject({ status: "waiting", review: { ...review, at: 2_000 } });

    await h.voice.handle(accepted(h, published({ eventAt: 5_000, review: { summary: "hero v4" } })));
    await h.voice.handle(publication);
    expect(rowFor(h).review).toEqual(filedAs("s1", { summary: "hero v4", at: 5_000 }));
  });
});

test("a failed transport keeps the words as a draft and never presses Return", async () => {
  const h = harness({ inject: () => ({ via: "none", failed: true, reason: "automation-failed" }) });
  const before = getLiveState().dictated?.id ?? 0;
  expect(await h.voice.handle(inject("words that never landed"))).toEqual({ delivered: false, reason: "automation-failed" });
  expect(h.keys).toEqual([]);
  expect(getLiveState().dictated).toEqual({ text: "words that never landed", id: before + 1, sessionId: "s1" });
});


/** Real capture queue and reducer, entirely synthetic audio and clock. */
function continuousAudio() {
  const captures: Array<{ finish(text: string, bytes?: number): void; stopReasons: string[] }> = [];
  const pending = new Map<string, Promise<void>>();
  const contents = new Map<string, string>();
  const failures = new Map<string, string>();
  const windows: number[] = [];
  let started = 0;
  const controller = new DictationController({
    minimumBytes: 16_000,
    backend: {
      open({ sequence }) {
        const end = deferred<CapturedAudio>();
        const stopReasons: string[] = [];
        const rawPath = `fake-${sequence}`;
        const capture = { stopReasons, finish(text: string, bytes = 32_000) {
          contents.set(rawPath, text);
          end.resolve({ rawPath, finalBytes: bytes, finalizedAt: 1000 + sequence });
        } };
        captures.push(capture);
        return { finished: end.promise, stop(reason) {
          stopReasons.push(reason);
          end.resolve({ rawPath, finalBytes: 6_000, cause: reason, finalizedAt: 1000 + sequence });
        } };
      },
      read: () => new Uint8Array(1),
    },
    transcriber: { async transcribe(_pcm, capture) {
      await pending.get(capture.rawPath);
      const failure = failures.get(capture.rawPath);
      return failure ? { text: "", error: failure } : { text: contents.get(capture.rawPath) ?? "tail" };
    } },
    deleteRaw() {},
    clock: { setTimeout: () => 1, clearTimeout() {} },
  });
  const session: RuntimeDictationSession = {
    controller,
    get micOpen() { return controller.micOpen; },
    get state() { return controller.state; },
    start(capture) { started++; controller.start(capture); },
    resume(capture) { controller.resume(capture); },
    nextEvent: () => controller.nextEvent(),
    acknowledge: (event) => controller.acknowledge(event),
    requestBarrier: (reason) => controller.requestBarrier(reason),
    requestTimeout: () => controller.requestTimeout(),
    setIdleWindowSecs(seconds) { windows.push(seconds); },
    abort: async () => { controller.requestBarrier("abort"); },
  };
  return { session, captures, contents, failures, pending, windows, starts: () => started };
}

function startSyntheticGap(
  audio: ReturnType<typeof continuousAudio>, text: string,
  cfg: Config, seconds: number,
  options: Parameters<NonNullable<VoiceLoopDeps["ear"]>["listenGap"]>[2],
): Promise<ListenResult> {
  const result = collectContinuousResult({ ...cfg, listenWindowSecs: seconds }, options?.hooks ?? {}, undefined, {
    ...options, sessionFactory: () => audio.session,
  });
  audio.captures[0]!.finish(text);
  return result;
}

describe("FIX8 continuous handoff and truthful delivery", () => {
  test("gap collector transfers the running controller without stopping its 6 KB successor", async () => {
    const audio = continuousAudio();
    const h = harness();
    const result = collectContinuousResult(h.cfg, {}, undefined, {
      handoff: true, sessionFactory: () => audio.session,
    });
    audio.captures[0]!.finish("please add");
    const heard = await result as ListenResult & { activeSession?: RuntimeDictationSession };
    const observed = { same: heard.activeSession === audio.session, state: audio.session.state, stopped: [...(audio.captures[1]?.stopReasons ?? [])] };
    const ticket = audio.session.requestBarrier("test-cleanup");
    while (true) { const e = await audio.session.nextEvent(); if(e.kind === "barrier") {audio.session.acknowledge(e); if(e.id === ticket.id) break;} }
    expect(observed).toEqual({ same: true, state: "running", stopped: [] });
  });

  test("read gap keeps its controller and in-flight next transcript through normal dictation", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const blocked = deferred();
    audio.pending.set("fake-2", blocked.promise);
    const h = harness({ cfg: { readFull: true, holdSubmit: true }, window: busy,
      gap: async (_cfg, _seconds, options) => {
        const first = await startSyntheticGap(audio, "please add", _cfg, _seconds, options);
        audio.captures[1]!.finish("the regression");
        return first;
      },
    });
    const run = h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
    await waitFor("handoff or replacement", () => h.sessions.length > 0 || audio.windows.length > 0);
    const replacements = h.sessions.length;
    blocked.resolve();
    await Bun.sleep(5);
    h.voice.stop("spacebar");
    await run;
    if (audio.session.state === "running") { const ticket = audio.session.requestBarrier("cleanup"); while(true) {const e=await audio.session.nextEvent(); if(e.kind==="barrier"){audio.session.acknowledge(e);if(e.id===ticket.id)break;}} }
    expect(replacements).toBe(0);
    expect(audio.starts()).toBe(1);
    expect(h.texts).toEqual(["please add the regression tail"]);
    expect(h.violations).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("non-hold handoff includes a 6 KB tail stopped by the send barrier", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const h = harness({ cfg: { readFull: true, holdSubmit: false }, window: busy,
      gap: async (_cfg, _seconds, options) => startSyntheticGap(audio, "please add", _cfg, _seconds, options),
    });
    await h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
    expect(audio.captures[1]!.stopReasons).toEqual(["dictation-send"]);
    expect(h.texts).toEqual(["please add tail"]);
    expect(audio.starts()).toBe(1);
    expect(h.violations).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("a handed-off continue command drains before TTS and rearms only after playback", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const h = harness({ cfg: { readFull: true, continueSentences: 1 }, holdSpeech: true, window: busy,
      gap: async (_cfg, _seconds, options) => {
        return startSyntheticGap(audio, "continue", _cfg, _seconds, options);
      },
    });
    const run = h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
    await waitFor("empty announcement", () => h.playing.has(""));
    h.playing.get("")!.finish();
    await waitFor("continued reading", () => h.said.includes("First sentence."));
    expect(audio.session.state).toBe("idle");
    expect(audio.captures).toHaveLength(2);
    expect(h.voice.capturing()).toBe(false);
    h.playing.get("First sentence.")!.finish();
    await waitFor("same controller rearmed", () => audio.captures.length === 3);
    h.voice.stop("spacebar"); await run;
    expect(audio.starts()).toBe(1);
    expect(h.sessions).toEqual([]);
    expect(h.violations).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("a remote ear taking ownership during handoff drains the old controller and resolves close", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const h = harness({ cfg: { readFull: true },
      gap: async (_cfg, _seconds, options) => {
        const result = await startSyntheticGap(audio, "please add", _cfg, _seconds, options);
        h.lease.request("phone", 1);
        return result;
      },
    });
    await h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
    await h.voice.close();
    expect(audio.session.state).toBe("idle");
    expect(audio.captures[1]!.stopReasons).toEqual(["handoff-exit"]);
    expect(h.voice.capturing()).toBe(false);
    expect(h.texts).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("shutdown during transfer waits for queued STT and never reopens or submits", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const blocked = deferred();
    audio.pending.set("fake-2", blocked.promise);
    let closeDone = false;
    let closing: Promise<void> | undefined;
    const h = harness({ cfg: { readFull: true },
      gap: async (_cfg, _seconds, options) => {
        const result = await startSyntheticGap(audio, "please add", _cfg, _seconds, options);
        audio.captures[1]!.finish("the queued words");
        closing = h.voice.close()?.then(() => { closeDone = true; });
        return result;
      },
    });
    const run = h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
    await waitFor("shutdown requested", () => Boolean(closing));
    const closedBeforeStt = closeDone;
    blocked.resolve();
    await Promise.all([run, closing]);
    expect(closedBeforeStt).toBe(false);
    expect(closeDone).toBe(true);
    expect(audio.session.state).toBe("idle");
    expect(audio.captures).toHaveLength(2);
    expect(h.sessions).toEqual([]);
    expect(h.texts).toEqual([]);
    expect(h.voice.capturing()).toBe(false);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("FIX8 final review: a shutdown queued behind handoff cleanup does not strand its done promise", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const releaseOldLoop = deferred<DictationEvent>();
    const next = audio.session.nextEvent;
    const barrierIds: number[] = [];
    audio.session.nextEvent = async () => {
      const event = await Promise.race([next(), releaseOldLoop.promise]);
      if (event.kind === "barrier") barrierIds.push(event.id);
      return event;
    };
    const request = audio.session.requestBarrier;
    let cleanupId = 0;
    audio.session.requestBarrier = (reason) => {
      const ticket = request(reason);
      if (reason === "handoff-exit") {
        cleanupId = ticket.id;
        // Models recorder shutdown occurring after the voice loop has already
        // requested its cleanup barrier, before either reaches acknowledgement.
        audio.session.controller.shutdown();
      }
      return ticket;
    };
    const h = harness({ cfg: { readFull: true },
      gap: async (_cfg, _seconds, options) => {
        const result = await startSyntheticGap(audio, "please add", _cfg, _seconds, options);
        h.lease.request("phone", 1);
        return result;
      },
    });
    let completed = false;
    const run = h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path }))).then(() => { completed = true; });
    await waitFor("all real barriers acknowledged", () => cleanupId > 0 && audio.session.state === "closed");
    await Bun.sleep(0);
    const completedAfterLastAck = { completed, cleanupId, barrierIds: [...barrierIds], capturing: h.voice.capturing() };
    // Release the old buggy loop without leaving a hanging test task. This
    // fabricated replay is used only after recording the regression verdict.
    releaseOldLoop.resolve({ kind: "barrier", id: cleanupId, reason: "test-release" });
    await run;
    expect(completedAfterLastAck).toEqual({ completed: true, cleanupId: 1, barrierIds: [1, 2], capturing: false });
    expect(h.voice.capturing()).toBe(false);
    expect(h.texts).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("a long handed-off composer prompt retains its trailing capture in the draft", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const audio = continuousAudio();
    const h = harness({ cfg: { readFull: true, holdSubmit: true },
      gap: async (_cfg, _seconds, options) => {
        return startSyntheticGap(audio, "please add all these details", _cfg, _seconds, options);
      },
    });
    const run = h.voice.handle(accepted(h, turnEnd({ compose: true, announce: "", transcriptPath: path })));
    await waitFor("held draft", () => audio.windows.length > 1);
    h.voice.stop("spacebar"); await run;
    expect(h.texts).toEqual([]);
    expect(getLiveState().dictated?.text).toBe("please add all these details tail");
    expect(h.violations).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("runtime partials reach the composer after empty gap hooks are handed off", async () => {
    const path = transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
    const captured = deferred<CapturedAudio>();
    let active!: RuntimeDictationSession;
    const h = harness({ cfg: { readFull: true, holdSubmit: true },
      gap: async (_cfg, _seconds, options) => {
        // An adopted fake capture avoids recorder spawning and real STT. The
        // runtime controller's partial callback and the voice hooks are real.
        active = createDictationSession(_cfg, options?.hooks ?? {});
        active.start({ finished: captured.promise, stop(reason) {
          captured.resolve({ rawPath: "", finalBytes: 0, cause: reason });
        } });
        options?.onSessionStarted?.(active);
        return { text: "please add", activeSession: active };
      },
    });
    const run = h.voice.handle(accepted(h, turnEnd({ compose: true, announce: "", transcriptPath: path })));
    await waitFor("normal reducer owns the gap", () => h.logs.some((line) => line.includes("· holding")));
    active.controller.publishPartial({ generation: active.controller.generation, sequence: active.controller.activeSequence!, text: "these final words" });
    const partial = getLiveState().partial;
    const prefix = getLiveState().transcriptPrefix;
    h.voice.stop("spacebar"); await run;
    expect(partial).toBe("these final words");
    expect(prefix).toBe("please add");
    expect(h.texts).toEqual([]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("held text sets the 8 second deadline with diagnostics disabled", async () => {
    const h = harness({ cfg: { holdSubmit: true, holdSubmitSecs: 8, listenWindowSecs: 30 } });
    const run = h.voice.handle(wake());
    await waitFor("microphone", () => h.sessions[0]?.started === 1);
    h.sessions[0]!.hear("keep these words");
    await Bun.sleep(5);
    const windows = [...h.sessions[0]!.windows];
    h.voice.stop("spacebar"); await run;
    expect(windows).toEqual([8]);
  });

  test("autoSubmit false stages text without retries, submitted annotations or sent claim", async () => {
    const path = transcript(user({ type: "text", text: "previous" }));
    const h = harness({ cfg: { autoSubmit: false } });
    const result = await h.voice.handle(inject("review before sending", { transcriptPath: path }));
    expect({ result, keys: h.keys, marked: h.ledger.injectedAt.has("s1"), warnings: h.said }).toEqual({ result: "staged", keys: [], marked: false, warnings: [] });
    expect(h.logs).toContain('phone inject into "alpha" staged');
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("a rejected input transaction recovers the addressed draft and returns failure", async () => {
    const h = harness({ inject: () => { throw new Error("synthetic input suspended"); } });
    const result = await h.voice.handle(inject("recover after rejection"));
    expect(result).toEqual({ delivered: false, reason: "transport-error" });
    expect(h.ledger.injectedAt.has("s1")).toBe(false);
    expect(getLiveState().dictated).toMatchObject({ text: "recover after rejection", sessionId: "s1" });
    expect(h.keys).toEqual([]);
  });

  test("failed transport returns recoverable draft without marking submission", async () => {
    const h = harness({ inject: () => ({ via: "none", failed: true, reason: "automation-failed" } as unknown as InjectTextResult) });
    const result = await h.voice.handle(inject("recover this"));
    expect(result).toEqual({ delivered: false, reason: "automation-failed" });
    expect(h.ledger.injectedAt.has("s1")).toBe(false);
    expect(getLiveState().dictated?.text).toBe("recover this");
    expect(h.said.join(" ")).not.toContain("clipboard");
  });
});

/**
 * Finding 4 (A8): two windows, one transcript, a permission dialog open in
 * each. The newest unresolved tool in the FILE belongs to whichever window
 * asked last — so only a window's own branch may be announced to it or
 * answered with its keys, and an ask nothing attributes is left alone.
 */
describe("a shared transcript answers only this window's permission (finding 4)", () => {
  const SESSION = "4eb30ede-6c1e-4f5a-9d2b-1f0c2a3b4c5d";
  const KEY_A = `${SESSION}#39889`;
  const KEY_B = `${SESSION}#21210`;
  const preamble = (bridge: string | undefined, leafUuid: string) => [
    { type: "last-prompt", leafUuid },
    ...(bridge ? [{ type: "bridge-session", bridgeSessionId: `cse_${bridge}` }] : []),
  ];
  const prompt = (uuid: string, parentUuid: string | null, text: string) =>
    ({ type: "user", uuid, parentUuid, message: { role: "user", content: text } });
  const reply = (uuid: string, parentUuid: string, ...content: unknown[]) =>
    ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content } });
  const tool = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const ASK_A = { name: "Bash", summary: "git push origin main" };
  const ASK_B = { name: "Bash", summary: "rm -rf build" };
  /** A asks first; B's dialog is written last, so the file's newest is B's. */
  const shared = (bridges = true) => {
    const bridge = (name: string) => (bridges ? name : undefined);
    return transcript(
      ...preamble(bridge("A"), "u1"), prompt("u1", null, "shared"),
      ...preamble(bridge("A"), "u1"), reply("a1", "u1", { type: "text", text: "ok" }),
      ...preamble(bridge("A"), "a1"), prompt("u2", "a1", "push it"),
      ...preamble(bridge("A"), "u2"), reply("a2", "u2", tool("tu_A", "git push origin main")),
      ...preamble(bridge("B"), "a1"), prompt("u3", "a1", "clean it"),
      ...preamble(bridge("B"), "u3"), reply("a3", "u3", tool("tu_B", "rm -rf build")),
    );
  };
  const registry = (key: string, bridge?: string) => () =>
    ({ sessionId: key, status: "idle", ...(bridge ? { bridgeSessionId: `session_${bridge}` } : {}) }) as SessionInfo;

  test("each window hears its own branch's ask and answers it in its own window", async () => {
    for (const window of [
      { key: KEY_A, bridge: "A", pid: 39889, ask: ASK_A },
      { key: KEY_B, bridge: "B", pid: 21210, ask: ASK_B },
    ]) {
      const path = shared();
      const h = harness({ heard: [["yes"]], window: registry(window.key, window.bridge) });
      try {
        const event = accepted(h, permission(path, { sessionId: window.key, pid: window.pid }));
        await h.voice.handle(event);
        expect(event.approval).toMatchObject(window.ask);
        expect(h.said[0]).toBe(approvalAnnounce("alpha", window.ask));
        expect(h.ledger.sessionStates.get(window.key)?.detail).toBe(approvalDetail(window.ask));
        expect(h.keys).toEqual(["Enter"]);
        expect(h.keyPids).toEqual([window.pid]);
      } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
    }
  });

  test("the other window's newer ask cannot capture this window's answer", async () => {
    const path = shared();
    // B opens a second dialog while A is being answered. Revalidation that
    // reads the file's tail finds B and drops A's yes on the floor.
    const h = harness({ heard: [["yes"]], window: registry(KEY_A, "A"), beforeKey: () => {
      appendFileSync(path, [
        ...preamble("B", "a3"), prompt("u4", "a3", "and the dist too"),
        ...preamble("B", "u4"), reply("a4", "u4", tool("tu_B2", "rm -rf dist")),
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    } });
    try {
      await h.voice.handle(accepted(h, permission(path, { sessionId: KEY_A, pid: 39889 })));
      expect(h.keys).toEqual(["Enter"]);
      expect(h.keyPids).toEqual([39889]);
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });

  test("an ask nothing can attribute is left for the keyboard", async () => {
    for (const window of [registry(KEY_A), undefined]) {
      const path = shared();
      const h = harness({ heard: [["yes"]], window });
      try {
        const event = accepted(h, permission(path, { sessionId: KEY_A, pid: 39889 }));
        await h.voice.handle(event);
        expect(event.approval).toBeUndefined();
        expect(h.said).toEqual([]);
        expect(h.sessions).toEqual([]);
        expect(h.keys).toEqual([]);
        expect(h.ledger.sessionStates.get(KEY_A)?.detail).toBe("needs an answer");
      } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
    }
  });
});

/**
 * Finding 3: one settlement for an incomplete dictation, wherever it happened.
 * A gap can return good text AND an error (listen.ts collects both); nothing
 * that hit an error may be submitted, and what was captured is recovered.
 */
describe("one settlement for an incomplete dictation (finding 3)", () => {
  const readingTurn = () => transcript(assistant({ type: "text", text: "First sentence. Second sentence." }));
  const INCOMPLETE = "Dictation was incomplete. Your recovered words are in the draft. Review them or retry before sending.";

  /** The first capture fails in transcription while its successor's good words land: both come back. */
  function failingGap(audio: ReturnType<typeof continuousAudio>, after?: () => void) {
    let calls = 0;
    return async (
      cfg: Config,
      seconds: number,
      options: Parameters<NonNullable<VoiceLoopDeps["ear"]>["listenGap"]>[2],
    ): Promise<ListenResult> => {
      if (++calls > 1) return { text: "" };
      const blocked = deferred();
      audio.pending.set("fake-1", blocked.promise);
      audio.failures.set("fake-1", "synthetic transcription failure");
      const result = collectContinuousResult({ ...cfg, listenWindowSecs: seconds }, options?.hooks ?? {}, undefined, {
        ...options, sessionFactory: () => audio.session,
      });
      audio.captures[0]!.finish("lost fragment");
      await waitFor("the gap successor", () => audio.captures.length > 1);
      audio.captures[1]!.finish("but keep the comments");
      blocked.resolve();
      const settled = await result;
      after?.();
      return settled;
    };
  }

  test("a gap that returns text and an error recovers the draft and submits nothing", async () => {
    const path = readingTurn();
    const audio = continuousAudio();
    const h = harness({ cfg: { readFull: true, holdSubmit: false }, window: busy, gap: failingGap(audio) });
    const before = getLiveState().dictated?.id ?? 0;
    try {
      await h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
      expect(h.texts).toEqual([]);
      expect(getLiveState().dictated).toEqual({ text: "but keep the comments", id: before + 1, sessionId: "s1" });
      expect(h.said.at(-1)).toBe(INCOMPLETE);
      expect(h.errors.some((entry) => String(entry[1]).includes("incomplete"))).toBe(true);
      expect(h.violations).toEqual([]);
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });

  test("an external spacebar cannot submit that fragment either", async () => {
    const path = readingTurn();
    const audio = continuousAudio();
    let h!: Harness;
    h = harness({ cfg: { readFull: true, holdSubmit: false }, window: busy,
      gap: failingGap(audio, () => h.voice.stop("spacebar")) });
    const before = getLiveState().dictated?.id ?? 0;
    try {
      await h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
      expect(h.texts).toEqual([]);
      expect(getLiveState().dictated).toEqual({ text: "but keep the comments", id: before + 1, sessionId: "s1" });
      expect(h.said.at(-1)).toBe(INCOMPLETE);
      expect(h.violations).toEqual([]);
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });

  test("a short tail captured just before the handoff still reaches the prompt", async () => {
    const path = readingTurn();
    const audio = continuousAudio();
    let h!: Harness;
    h = harness({ cfg: { readFull: true, holdSubmit: false }, window: busy,
      gap: async (cfg, seconds, options) => {
        const result = collectContinuousResult({ ...cfg, listenWindowSecs: seconds }, options?.hooks ?? {}, undefined, {
          ...options, sessionFactory: () => audio.session,
        });
        h.voice.stop("spacebar"); // space while the capture is still under the minimum
        return result;
      },
    });
    try {
      await h.voice.handle(accepted(h, turnEnd({ announce: "", transcriptPath: path })));
      expect(audio.captures[0]!.stopReasons).toEqual(["gap-spacebar"]);
      expect(h.texts).toEqual(["tail"]);
      expect(h.violations).toEqual([]);
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });
});

/** Finding 15: an alternative prompt settles like every other delivery. */
describe("an alternative prompt recovers its draft (finding 15)", () => {
  test("staged, not submitted: the words go back to the draft and nothing is bookkept as sent", async () => {
    const path = pendingBash();
    const h = harness({ heard: [["no, use main instead"]], cfg: { autoSubmit: false } });
    const before = getLiveState().dictated?.id ?? 0;
    try {
      await h.voice.handle(accepted(h, permission(path)));
      expect(h.keys).toEqual(["Escape"]);
      expect(h.texts).toEqual(["use main instead"]);
      expect(h.ledger.injectedAt.has("s1")).toBe(false);
      expect(getLiveState().dictated).toEqual({ text: "use main instead", id: before + 1, sessionId: "s1" });
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });

  test("a failed transport recovers the draft instead of reporting the alternative told", async () => {
    const path = pendingBash();
    const h = harness({
      heard: [["no, use main instead"]],
      inject: () => ({ via: "tmux", failed: true, reason: "front-window-changed" } as unknown as InjectTextResult),
    });
    try {
      await h.voice.handle(accepted(h, permission(path)));
      expect(h.ledger.injectedAt.has("s1")).toBe(false);
      expect(getLiveState().dictated?.text).toBe("use main instead");
      expect(h.said.at(-1)).toBe("Couldn't deliver that. Your words are in the draft. Review them before trying again.");
    } finally { rmSync(join(path, ".."), { recursive: true, force: true }); }
  });
});

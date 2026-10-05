import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlServer, type ControlServer } from "../src/control-server.ts";
import type { TurnEvent } from "../src/hook.ts";
import type { PublishedState } from "../src/panel.ts";
import {
  createPractice,
  decodePracticeRequest,
  practiceGate,
  practiceRefusal,
  PRACTICE_LABEL,
  PRACTICE_LEASE_MAX_MS,
  PRACTICE_LINE,
  PRACTICE_NO_TERMINAL,
  PRACTICE_REPLY,
  PRACTICE_SESSION_ID,
  WELCOME_FILE,
  WELCOME_SUMMARY,
  type PracticeDependencies,
  type PracticeLease,
} from "../src/practice.ts";
import type { PracticeTurnOutcome } from "../src/voice-loop.ts";

/**
 * Setup's practice turn (src/practice.ts), with the voice loop's turn standing in: what it publishes, the one sink its
 * answers go to, its card, and how it goes away. The turn itself, through the loop's gates, is voice-loop.test.ts's
 * "setup's practice turn"; the daemon end to end is scripts/practice-e2e.ts.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function until(what: string, condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(2);
  }
}

const baseState = (): PublishedState => ({
  v: 1,
  features: { deliverables: 4, viewedState: 1 },
  ownerDeviceId: "this-mac",
  ts: 1,
  mode: { muted: false, paused: false, holding: 0 },
  live: { state: "idle", label: "" },
  rows: [{ id: "s1", label: "dayloop", status: "waiting", needsResponse: false, paused: false, muted: false, live: null, active: true }],
  conversations: { s1: { sessionId: "s1", items: [], truncated: false } },
  dismissed: [],
  dismissedRows: [],
  seaGlass: 0,
});

interface Turn {
  options: Parameters<PracticeDependencies["turn"]>[0];
  finish(outcome: PracticeTurnOutcome): void;
}

function practiceWith(over: Partial<PracticeDependencies> = {}) {
  const root = mkdtempSync(join(tmpdir(), "conch-practice-"));
  roots.push(root);
  const dir = join(root, "cache", "practice");
  const turns: Turn[] = [];
  const logs: string[] = [];
  const dictated: string[] = [];
  let changes = 0;
  let hushed = 0;
  let now = 1_000;
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const deps: PracticeDependencies = {
    dir,
    now: () => now,
    log: (line) => void logs.push(line),
    audioElsewhere: () => null,
    recognitionReady: () => true,
    naturalVoicesReady: () => true,
    turn: (options) => {
      const done = deferred<PracticeTurnOutcome>();
      turns.push({ options, finish: done.resolve });
      return done.promise;
    },
    hush: () => void hushed++,
    dictated: (text) => void dictated.push(text),
    changed: () => void changes++,
    voice: "af_heart",
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
    ...over,
  };
  const practice = createPractice(deps);
  return {
    practice, dir, turns, logs, dictated, timers,
    changes: () => changes,
    hushed: () => hushed,
    tick: (ms: number) => { now += ms; },
    state: () => practice.publish(baseState()),
  };
}

/** A start whose line has played and whose mic window heard `heard`. */
async function answered(p: ReturnType<typeof practiceWith>, heard: string | null = "show me what you made") {
  expect(await p.practice.handle({ kind: "practice-start" })).toEqual({ kind: "practice-started", sessionId: PRACTICE_SESSION_ID });
  await until("the line's turn", () => p.turns.length === 1);
  p.turns[0]!.options.onSpoken();
  p.turns[0]!.finish({ heard });
  await until("the card", () => p.practice.published()?.stage === "ready");
}

describe("the practice session, published", () => {
  test("started: its row first, conch's own, active, no terminal, with its line in its conversation", async () => {
    const p = practiceWith();
    expect(await p.practice.handle({ kind: "practice-start" })).toEqual({ kind: "practice-started", sessionId: PRACTICE_SESSION_ID });
    const state = p.state();
    expect(state.features.practice).toBe(1);
    expect(state.rows.map((row) => row.id)).toEqual([PRACTICE_SESSION_ID, "s1"]);
    const row = state.rows[0]!;
    expect(row).toMatchObject({ label: PRACTICE_LABEL, backend: "conch", status: null, active: true, paused: false, noTerminal: PRACTICE_NO_TERMINAL, voice: "af_heart" });
    expect(row.review).toBeUndefined();
    expect(state.conversations?.[PRACTICE_SESSION_ID]?.items.map((item) => [item.kind, item.text])).toEqual([["assistant", PRACTICE_LINE]]);
    expect(state.conversations?.s1).toBeDefined();
    expect(state.practice).toEqual({ sessionId: PRACTICE_SESSION_ID, stage: "speaking" });
    // The line goes to the voice loop, and nothing is published as heard until the loop says so.
    await until("the turn", () => p.turns.length === 1);
    expect(p.turns[0]!.options.line).toBe(PRACTICE_LINE);
    expect(p.turns[0]!.options.systemVoice).toBe(false);
  });

  test("the line spoken, then listening: the tour's first beat moves on only from the loop's word", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    expect(p.practice.published()?.stage).toBe("speaking");
    p.turns[0]!.options.onSpoken();
    expect(p.practice.published()).toMatchObject({ stage: "listening", listening: true });
  });

  test("heard: echoed into its own conversation with its reply, and the welcome card filed in conch's own folder", async () => {
    const p = practiceWith();
    await answered(p);
    const state = p.state();
    expect(state.practice).toEqual({ sessionId: PRACTICE_SESSION_ID, stage: "ready", heard: "show me what you made" });
    expect(state.conversations?.[PRACTICE_SESSION_ID]?.items.map((item) => [item.kind, item.text])).toEqual([
      ["assistant", PRACTICE_LINE],
      ["user", "show me what you made"],
      ["assistant", PRACTICE_REPLY],
    ]);
    const row = state.rows[0]!;
    expect(row.status).toBe("waiting");
    expect(row.review).toMatchObject({ summary: WELCOME_SUMMARY, link: join(p.dir, WELCOME_FILE), kind: "page", version: 1 });
    expect(row.review?.id).toBeTruthy();
    expect(row.reviews).toEqual([row.review!]);
    expect(readFileSync(join(p.dir, WELCOME_FILE), "utf8")).toContain(`<title>${WELCOME_SUMMARY}</title>`);
    // The words are never logged, only their length.
    expect(p.logs.join("\n")).not.toContain("show me what you made");
  });

  test("nothing heard: said so, and the card still comes, so the tour has something to open", async () => {
    const p = practiceWith();
    await answered(p, null);
    expect(p.practice.published()).toEqual({ sessionId: PRACTICE_SESSION_ID, stage: "ready", silent: true });
    expect(p.state().rows[0]!.review?.summary).toBe(WELCOME_SUMMARY);
    // Another go listens again, without the line.
    expect(await p.practice.handle({ kind: "practice-listen" })).toEqual({ kind: "practice-listening" });
    await until("the second window", () => p.turns.length === 2);
    expect(p.turns[1]!.options.line).toBeUndefined();
    p.turns[1]!.options.onSpoken();
    p.turns[1]!.finish({ heard: "hello" });
    await until("heard", () => p.practice.published()?.heard === "hello");
    expect(p.practice.published()?.silent).toBeUndefined();
  });

  test("the card opened (the Ready pill): viewed, and only for its own id", async () => {
    const p = practiceWith();
    await answered(p);
    const id = p.state().rows[0]!.review!.id!;
    const other = p.practice.sessionCommand({ kind: "session-command", sessionId: PRACTICE_SESSION_ID, command: "review-viewed", review: "not-it" });
    expect(other).toMatchObject({ kind: "session-ack", changed: false });
    expect(p.practice.published()?.stage).toBe("ready");
    p.tick(500);
    const opened = p.practice.sessionCommand({ kind: "session-command", sessionId: PRACTICE_SESSION_ID, command: "review-viewed", review: id });
    expect(opened).toMatchObject({ kind: "session-ack", sessionId: PRACTICE_SESSION_ID, changed: true, label: PRACTICE_LABEL });
    expect(p.practice.published()?.stage).toBe("viewed");
    expect(p.state().rows[0]!.review?.viewedAt).toBe(1_500);
    // Nothing else a session command asks does anything to it.
    for (const command of [
      { command: "rename", label: "x" }, { command: "dismiss" }, { command: "reveal" }, { command: "attach" }, { command: "set-model", model: "o" },
      { command: "set-settings", effort: "high" },
    ] as const) {
      expect(p.practice.sessionCommand({ kind: "session-command", sessionId: PRACTICE_SESSION_ID, ...command } as never)).toMatchObject({ changed: false });
    }
  });

  test("the natural voices not ready: the loop is told to use the Mac's own voice, published without alarm", async () => {
    const p = practiceWith({ naturalVoicesReady: () => false });
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    expect(p.turns[0]!.options.systemVoice).toBe(true);
    expect(p.practice.published()).toEqual({ sessionId: PRACTICE_SESSION_ID, stage: "speaking", systemVoice: true });
    expect(p.practice.published()?.problem).toBeUndefined();
  });
});

describe("refused, in words, before anything is published", () => {
  test("the phone holds the audio: never taken back, and nothing speaks or listens", async () => {
    const p = practiceWith({ audioElsewhere: () => "phone" });
    const reply = await p.practice.handle({ kind: "practice-start" });
    expect(reply).toEqual({ kind: "practice-error", reason: "phone", error: practiceRefusal("phone") });
    expect(practiceRefusal("phone")).toBe("Your iPhone has conch's audio right now. Hand it back to this Mac to try it here.");
    expect(p.turns).toEqual([]);
    expect(p.practice.running()).toBe(false);
    expect(p.state().rows.map((row) => row.id)).toEqual(["s1"]);
    expect(p.state().practice).toBeUndefined();
  });

  test("another Mac holds it, or speech recognition is still downloading", async () => {
    expect(await practiceWith({ audioElsewhere: () => "another-mac" }).practice.handle({ kind: "practice-start" }))
      .toMatchObject({ kind: "practice-error", reason: "another-mac" });
    const downloading = practiceWith({ recognitionReady: () => false });
    expect(await downloading.practice.handle({ kind: "practice-start" }))
      .toEqual({ kind: "practice-error", reason: "recognition", error: "Speech recognition is still downloading. You can try this once it's here." });
    expect(downloading.turns).toEqual([]);
  });

  test("the loop refused it (busy, or the phone claimed the audio mid-line): the problem is published, and another go retries the line", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    p.turns[0]!.finish({ refused: "busy" });
    await until("the problem", () => p.practice.published()?.problem !== undefined);
    expect(p.practice.published()?.problem).toEqual({ reason: "busy", words: practiceRefusal("busy") });
    expect(p.state().rows[0]!.review).toBeUndefined();
    await p.practice.handle({ kind: "practice-listen" });
    await until("the retry", () => p.turns.length === 2);
    expect(p.turns[1]!.options.line).toBe(PRACTICE_LINE);
    expect(p.practice.published()?.problem).toBeUndefined();
  });

  test("another go with none running says so", async () => {
    expect(await practiceWith().practice.handle({ kind: "practice-listen" })).toEqual({ kind: "practice-error", reason: "none", error: practiceRefusal("none") });
  });
});

describe("the one sink: its own conversation, never a delivery", () => {
  test("an inject from its composer is echoed and resolves delivered; the intake's next door never sees it", async () => {
    const p = practiceWith();
    await answered(p);
    const passed: TurnEvent[] = [];
    const gate = practiceGate(p.practice, (event) => { passed.push(event); return "next"; });
    const typed = await gate({ type: "inject", sessionId: PRACTICE_SESSION_ID, label: PRACTICE_LABEL, announce: "typed words", origin: "user" });
    expect(typed).toBe(true);
    for (const type of ["wake", "recite", "interrupt", "pause", "resume", "turn-end", "needs-you"] as const) {
      gate({ type, sessionId: PRACTICE_SESSION_ID, label: PRACTICE_LABEL, announce: "", origin: "user" });
    }
    expect(passed).toEqual([]);
    const items = p.state().conversations?.[PRACTICE_SESSION_ID]?.items ?? [];
    expect(items.at(-1)).toMatchObject({ kind: "user", text: "typed words" });
    // One reply, after the first answer only.
    expect(items.filter((item) => item.text === PRACTICE_REPLY)).toHaveLength(1);
    // Any other session goes on through, untouched.
    const other: TurnEvent = { type: "inject", sessionId: "s1", label: "dayloop", announce: "hi", origin: "user" };
    expect(gate(other)).toBe("next");
    expect(passed).toEqual([other]);
  });

  test("an inject with nothing running is not delivered anywhere", async () => {
    const p = practiceWith();
    const passed: TurnEvent[] = [];
    const gate = practiceGate(p.practice, (event) => { passed.push(event); });
    expect(await gate({ type: "inject", sessionId: PRACTICE_SESSION_ID, label: PRACTICE_LABEL, announce: "words", origin: "user" })).toBe(false);
    expect(passed).toEqual([]);
  });

  test("its composer's mic: the words go back to the composer, not into the conversation", async () => {
    const p = practiceWith();
    await answered(p);
    const before = p.state().conversations?.[PRACTICE_SESSION_ID]?.items.length;
    p.practice.turn({ type: "wake", sessionId: PRACTICE_SESSION_ID, label: PRACTICE_LABEL, announce: "", origin: "user", compose: true });
    await until("the window", () => p.turns.length === 2);
    p.turns[1]!.options.onSpoken();
    p.turns[1]!.finish({ heard: "draft this" });
    await until("the dictation", () => p.dictated.length === 1);
    expect(p.dictated).toEqual(["draft this"]);
    expect(p.state().conversations?.[PRACTICE_SESSION_ID]?.items.length).toBe(before);
  });
});

describe("gone cleanly", () => {
  test("stopped: its row, conversation, block and card go; the loop's turn is no longer wanted; the lease is ended", async () => {
    const p = practiceWith();
    const ended: string[] = [];
    const lease: PracticeLease = { closed: new Promise(() => {}), end: () => void ended.push("end") };
    await p.practice.handle({ kind: "practice-start" }, lease);
    await until("the turn", () => p.turns.length === 1);
    p.turns[0]!.options.onSpoken();
    p.turns[0]!.finish({ heard: "hi" });
    await until("the card", () => existsSync(join(p.dir, WELCOME_FILE)));
    expect(await p.practice.handle({ kind: "practice-stop" })).toEqual({ kind: "practice-stopped", removed: true });
    expect(existsSync(p.dir)).toBe(false);
    const state = p.state();
    expect(state.rows.map((row) => row.id)).toEqual(["s1"]);
    expect(state.conversations?.[PRACTICE_SESSION_ID]).toBeUndefined();
    expect(state.practice).toBeUndefined();
    expect(state.features.practice).toBe(1);
    expect(p.turns[0]!.options.stillWanted()).toBe(false);
    expect(ended).toEqual(["end"]);
    expect(p.timers[0]!.cleared).toBe(true);
    expect(await p.practice.handle({ kind: "practice-stop" })).toEqual({ kind: "practice-stopped", removed: false });
  });

  test("stopped mid-line: the line is cut short; a mic window that ends after the stop changes nothing", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    // The loop holds the queue for it and has started its line.
    p.turns[0]!.options.onLine();
    p.practice.stop("test");
    expect(p.hushed()).toBe(1);
    p.turns[0]!.finish({ heard: "late words" });
    await Bun.sleep(5);
    expect(p.practice.published()).toBeNull();
    expect(existsSync(join(p.dir, WELCOME_FILE))).toBe(false);
  });

  // D4 (review 2026-09-28): Start while another session is being read, then Skip tour. The practice was `speaking` and
  // busy while its turn waited behind that session's (VoiceLoop.practice's queue wait), and the stop's hush
  // (`speech.cancelCurrent()`) cut the other session off.
  test("stopped while its turn waits behind another session's: nothing is cut off, since what's playing isn't its own", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    expect(p.practice.published()?.stage).toBe("speaking");
    p.practice.stop("the tour was skipped");
    expect(p.hushed()).toBe(0);
    expect(p.turns[0]!.options.stillWanted()).toBe(false);
    p.turns[0]!.finish({ heard: null, interrupted: true });
    await Bun.sleep(5);
    expect(p.hushed()).toBe(0);
  });

  test("its line played through, then its mic window: a stop then cuts nothing either", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    p.turns[0]!.options.onLine();
    p.turns[0]!.options.onSpoken();
    p.practice.stop("test");
    expect(p.hushed()).toBe(0);
  });

  test("another go's line: what a refused go left says nothing, and once started it is its own, and a stop cuts it", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the turn", () => p.turns.length === 1);
    // The loop started the line, then the phone claimed the audio: refused, and the line is no longer playing here.
    p.turns[0]!.options.onLine();
    p.turns[0]!.finish({ refused: "phone" });
    await until("the problem", () => p.practice.published()?.problem !== undefined);
    expect(await p.practice.handle({ kind: "practice-listen" })).toEqual({ kind: "practice-listening" });
    await until("the second turn", () => p.turns.length === 2);
    expect(p.turns[1]!.options.line).toBe(PRACTICE_LINE);
    p.turns[1]!.options.onLine();
    p.practice.stop("mid-line");
    expect(p.hushed()).toBe(1);
  });

  test("the app that started it goes away (its connection, the lease): stopped", async () => {
    const p = practiceWith();
    const closed = deferred();
    await p.practice.handle({ kind: "practice-start" }, { closed: closed.promise, end: () => {} });
    expect(p.practice.running()).toBe(true);
    closed.resolve();
    await until("stopped", () => !p.practice.running());
    expect(p.logs).toContain("practice: stopped (the app that started it went away)");
  });

  test("left open all afternoon: it ends at its longest", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    expect(p.timers[0]!.ms).toBe(PRACTICE_LEASE_MAX_MS);
    p.timers[0]!.run();
    expect(p.practice.running()).toBe(false);
  });

  test("a restart mid-practice leaves no ghost: the next daemon's practice empties the folder and publishes none", () => {
    const p = practiceWith();
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(join(p.dir, WELCOME_FILE), "left by a crashed daemon");
    // What the next daemon makes at its start.
    const next = createPractice({ ...practiceWithDepsFor(p.dir) });
    expect(existsSync(p.dir)).toBe(false);
    const state = next.publish(baseState());
    expect(state.rows.map((row) => row.id)).toEqual(["s1"]);
    expect(state.practice).toBeUndefined();
    // And an older state that still carried a practice row is scrubbed of it.
    const stale = next.publish({ ...baseState(), rows: [{ ...baseState().rows[0]!, id: PRACTICE_SESSION_ID }, ...baseState().rows] });
    expect(stale.rows.map((row) => row.id)).toEqual(["s1"]);
    // Its conversation too, when it was the only one published (the e2e caught it outliving the practice).
    const onlyIts = next.publish({ ...baseState(), conversations: { [PRACTICE_SESSION_ID]: { sessionId: PRACTICE_SESSION_ID, items: [], truncated: false } } });
    expect(onlyIts.conversations?.[PRACTICE_SESSION_ID]).toBeUndefined();
  });

  test("starting again replaces the running one", async () => {
    const p = practiceWith();
    await p.practice.handle({ kind: "practice-start" });
    await until("the first", () => p.turns.length === 1);
    await p.practice.handle({ kind: "practice-start" });
    await until("the second", () => p.turns.length === 2);
    expect(p.turns[0]!.options.stillWanted()).toBe(false);
    expect(p.turns[1]!.options.stillWanted()).toBe(true);
  });
});

function practiceWithDepsFor(dir: string): PracticeDependencies {
  return {
    dir, now: () => 0, log: () => {}, audioElsewhere: () => null, recognitionReady: () => true, naturalVoicesReady: () => true,
    turn: () => new Promise(() => {}), hush: () => {}, dictated: () => {}, changed: () => {},
  };
}

describe("over the control socket", () => {
  const servers: ControlServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  test("decodes only its own three kinds", () => {
    expect(decodePracticeRequest({ kind: "practice-start" })).toEqual({ kind: "practice-start" });
    expect(decodePracticeRequest({ kind: "practice-stop" })).toEqual({ kind: "practice-stop" });
    expect(decodePracticeRequest({ kind: "practice-listen" })).toEqual({ kind: "practice-listen" });
    expect(decodePracticeRequest({ kind: "practice-go" })).toBeNull();
    expect(decodePracticeRequest(["practice-start"])).toBeNull();
  });

  test("a start answers and holds its connection; closing it stops the practice, and a stop ends it from the daemon's side", async () => {
    const root = mkdtempSync("/tmp/conch-practice-sock-");
    roots.push(root);
    const socketPath = join(root, "c.sock");
    const p = practiceWith();
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: false }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
      practice: p.practice,
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    const open = () => new Promise<{ first: Record<string, unknown>; ended: Promise<void>; close(): void }>((resolve, reject) => {
      const socket = connect(socketPath);
      let data = "";
      const ended = new Promise<void>((done) => socket.on("end", () => done()));
      socket.on("data", (chunk) => {
        data += chunk.toString();
        if (data.includes("\n")) resolve({ first: JSON.parse(data.split("\n")[0]!), ended, close: () => socket.destroy() });
      });
      socket.on("error", reject);
      socket.write(JSON.stringify({ kind: "practice-start" }) + "\n");
    });
    const ask = (value: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath);
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => { resolve(JSON.parse(data.trim())); socket.end(); });
      socket.on("error", reject);
      socket.write(JSON.stringify(value) + "\n");
    });

    // The app's lease goes away: the practice goes with it.
    const first = await open();
    expect(first.first).toEqual({ kind: "practice-started", sessionId: PRACTICE_SESSION_ID });
    expect(p.practice.running()).toBe(true);
    first.close();
    await until("stopped by the lease", () => !p.practice.running());

    // A stop from another connection ends the lease from the daemon's side.
    const second = await open();
    expect(p.practice.running()).toBe(true);
    expect(await ask({ kind: "practice-stop" })).toEqual({ kind: "practice-stopped", removed: true });
    await second.ended;
    expect(p.practice.running()).toBe(false);
  });

  test("a daemon without a practice refuses in words", async () => {
    const root = mkdtempSync("/tmp/conch-practice-sock-");
    roots.push(root);
    const socketPath = join(root, "c.sock");
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: false }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: () => ({ kind: "session-error", error: "stub" }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = connect(socketPath);
      let data = "";
      socket.on("data", (chunk) => { data += chunk.toString(); });
      socket.on("end", () => { resolve(JSON.parse(data.trim())); socket.end(); });
      socket.on("error", reject);
      socket.write(JSON.stringify({ kind: "practice-start" }) + "\n");
    });
    expect(reply).toEqual({ kind: "practice-error", reason: "unavailable", error: practiceRefusal("unavailable") });
  });
});

describe("the daemon's wiring (runDaemon runs in no test: its text is the gate)", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
  const between = (from: string, to: string): string => {
    const start = daemon.indexOf(from);
    expect(start, `missing: ${from}`).toBeGreaterThan(-1);
    const end = daemon.indexOf(to, start);
    expect(end, `missing after it: ${to}`).toBeGreaterThan(start);
    return daemon.slice(start, end);
  };

  test("the intake's first door: an event naming the practice session stops at the practice, whatever door it came in by", () => {
    const enqueue = between("function enqueue(incoming: TurnEvent): void | Promise<SocketTurnOutcome> {", "warmTranscript(event.transcriptPath);");
    const guard = enqueue.indexOf("if (event.sessionId === PRACTICE_SESSION_ID) return practice?.turn(event);");
    expect(guard).toBeGreaterThan(-1);
    // Before the refusals, the queue, the voice loop and anything that reads a session.
    for (const later of ["voice.refusal(event)", "panelRefresh.accept", "handle(event)", "eventQueue.submit"]) {
      const at = enqueue.indexOf(later);
      if (at > -1) expect(at).toBeGreaterThan(guard);
    }
  });

  test("the control server's turn and session doors answer it first; its requests and lease go to the practice", () => {
    const wiring = between("const controlServer = createControlServer({", "\n  });");
    expect(wiring).toContain("turn: practiceGate(practiceTurns, (event) => dispatchSocketTurnEvent(event, socketTurnCallbacks)),");
    expect(wiring).toContain("? practiceTurns.sessionCommand(message)");
    expect(wiring).toContain("practice: practiceTurns,");
  });

  test("spoken and heard by the voice loop's own practice turn; the Mac's own voice while the natural voices aren't ready", () => {
    const made = between("practice = createPractice({", "const practiceTurns = practice;");
    expect(made).toContain('dir: join(conchHome(), ".cache/conch/practice"),');
    expect(made).toContain("turn: ({ line, systemVoice, stillWanted, onLine, onSpoken }) => voice.practice({");
    expect(made).toContain('speechCfg: systemVoice ? { ...cfg, ttsEngine: "say" } : { ...cfg, ttsVoices: cfg.ttsVoices.slice(0, 1) },');
    expect(made).toContain('audioElsewhere: () => (audioLease.isPhone() ? "phone" : audioHolder.isLocal() ? null : "another-mac"),');
    expect(made).toContain('recognitionReady: () => speechEngineStatus?.state === "ready",');
    expect(made).toContain("dictated: (text) => publishDictation(text, PRACTICE_SESSION_ID),");
  });

  test("merged into every published state the daemon writes, and gone with the daemon", () => {
    expect(daemon.match(/lastPublishedPanelState = practice\.publish\(lastPublishedPanelState\);/g)?.length).toBe(2);
    expect(daemon).toContain("lastPublishedPanelState = practice!.publish({ ...lastPublishedPanelState, ts: Date.now() });");
    const shutdown = between("const shutdown = async (): Promise<void> => {", "process.exit(0);");
    expect(shutdown).toContain('practice?.stop("conch is closing");');
  });

  test("the voice loop's practice turn never reaches a delivery", () => {
    const loop = readFileSync(join(import.meta.dir, "..", "src/voice-loop.ts"), "utf8");
    const start = loop.indexOf("const practice = async (turn: PracticeTurn): Promise<PracticeTurnOutcome> => {");
    const end = loop.indexOf("  /**\n   * Why `speak` would drop a line right now", start);
    const body = loop.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("await speak(turn.speechCfg, turn.line, turn.label, true);");
    expect(body).toContain('const heard = await oneMicWindow(turn.label, wanted, "practice",');
    for (const never of ["deliver(", "injectText(", "injectKey(", "toClipboard(", "publishDictation(", "answerQuestion("]) {
      expect(body, never).not.toContain(never);
    }
  });
});

/**
 * Setup's practice turn (conch-design/onboarding/README.md §2 "5 · Try it", §5 Wave C): a session of conch's own that
 * reads one scripted line aloud, listens once, echoes what it heard into its own conversation, and hands over a welcome
 * card, so the tour has a real pill, a real Ready and a real panel to point at. No agent, no cost, the same every time.
 *
 *   practice-start   the practice session published, its line spoken, then the mic: answered at once, and the connection
 *                    held open as its lease (as Show's narration's is), so an app that quits or crashes takes its
 *                    practice with it
 *   practice-listen  another go on it: the line again if it never played, else one more mic window
 *   practice-stop    the session, its conversation and its card, gone
 *
 * Speaking and listening are the voice loop's own (`VoiceLoop.practice`): the line through `speak`, the mic through the
 * one reservation, so the mic never opens while conch speaks. What it hears goes to one sink, `echo`, which puts it in
 * this session's conversation and nowhere else: never a terminal, a clipboard or another session. Every event the
 * daemon's intake takes for the practice session (an inject from its composer, a wake from its mic button) comes here
 * first and stops here (`practiceGate`).
 *
 * Nothing is persisted. The session lives in this process's memory and its card in conch's own folder
 * (`~/.cache/conch/practice`), which is emptied whenever a practice starts or stops and when the daemon starts: a crash
 * or a restart mid-practice leaves no ghost.
 *
 * Manual and Quiet: pressing Start is a person asking for the sound, so the line is `volunteered`, as a recite is, and
 * speaks once while every session is quiet. Quiet (`SessionVoice`, the daemon's `pause`) is conch not speaking FIRST;
 * nothing here speaks unasked, and the practice session is never itself quieted. The audio's holder is never overridden
 * (`audio-holder.ts`): with the phone or another Mac holding it, the practice is refused in words, and taking it back is
 * the person's own press.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnEvent } from "./hook.ts";
import type { ConversationItem } from "./conversation.ts";
import { fileReview, type PublishedSessionRow, type PublishedState, type SessionReview } from "./panel.ts";
import type { SessionControlMessage, SessionControlResponse } from "./settings.ts";
import type { PracticeTurnOutcome } from "./voice-loop.ts";

/** Not a session any agent could have: a real one is a UUID, a window key or a Codex thread id. */
export const PRACTICE_SESSION_ID = "conch-practice";
export const PRACTICE_LABEL = "Practice turn";
/** What conch says (the design's §7, question 6). */
export const PRACTICE_LINE = "Hi, I'm conch. When an agent finishes a turn, I read you what it did, then listen for your answer. Try it: say anything.";
/** What the practice session says back once it has heard you, in its conversation. */
export const PRACTICE_REPLY = "Here it is: a welcome card, waiting where the work lives. Click the pill, or look below. When you answer here, it goes to whoever spoke.";
export const WELCOME_SUMMARY = "Welcome to conch";
export const WELCOME_FILE = "welcome.html";
/** Why the practice session has no terminal, on its row: the apps offer nothing that would reach one. */
export const PRACTICE_NO_TERMINAL = "The practice turn is conch's own. There's no terminal behind it.";
/** The longest a practice runs: a tour left open all afternoon ends here. */
export const PRACTICE_LEASE_MAX_MS = 30 * 60_000;

export type PracticeRefusal = "phone" | "another-mac" | "recognition" | "busy" | "mic-open" | "closing" | "none" | "unavailable";

/** Where the practice is. The tour moves on from these: spoken past `speaking`, answered with `heard`, opened at `viewed`. */
export type PracticeStage = "speaking" | "listening" | "ready" | "viewed";

/** The practice as the published state carries it (`practice`), for the setup window and the tour. */
export interface PublishedPractice {
  sessionId: string;
  stage: PracticeStage;
  /** The latest answer conch heard, or that was typed in its composer. */
  heard?: string;
  /** The last mic window closed with nothing heard. */
  silent?: true;
  /** A mic window is open on it right now. */
  listening?: true;
  /** Why the last go didn't run, in words the app shows as they are. */
  problem?: { reason: PracticeRefusal; words: string };
  /** The line was read with the Mac's own voice, as the natural voices weren't ready yet. Nothing to say about it. */
  systemVoice?: true;
}

export type PracticeRequest = { kind: "practice-start" } | { kind: "practice-listen" } | { kind: "practice-stop" };

export type PracticeReply =
  | { kind: "practice-started"; sessionId: string }
  | { kind: "practice-listening" }
  | { kind: "practice-stopped"; removed: boolean }
  | { kind: "practice-error"; reason: PracticeRefusal; error: string };

/** Every kind `decodePracticeRequest` takes: the Mac app's alone (the phone bridge refuses each, `isMacAppOnlyRequest`). */
export const PRACTICE_REQUEST_KINDS: ReadonlySet<string> = new Set(["practice-start", "practice-listen", "practice-stop"]);

/** A practice request, or null for anything that isn't one. */
export function decodePracticeRequest(body: unknown): PracticeRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const kind = (body as { kind?: unknown }).kind;
  return typeof kind === "string" && PRACTICE_REQUEST_KINDS.has(kind) ? { kind } as PracticeRequest : null;
}

/** Each refusal in words a person can act on. The phone's names what to do; nothing here takes the audio back. */
export function practiceRefusal(reason: PracticeRefusal): string {
  switch (reason) {
    case "phone": return "Your iPhone has conch's audio right now. Hand it back to this Mac to try it here.";
    case "another-mac": return "Another Mac has conch's audio right now. Hand it back to try it here.";
    case "recognition": return "Speech recognition is still downloading. You can try this once it's here.";
    case "busy": return "conch is still reading something aloud. Try again once it's done.";
    case "mic-open": return "The microphone is open for something else. Try again in a moment.";
    case "closing": return "conch is closing.";
    case "none": return "The practice turn isn't running. Start it again.";
    case "unavailable": return "This conch can't run the practice turn. Quit conch and open it again to update it.";
  }
}

export interface PracticeLease {
  /** Resolves when the connection that started it goes away: a quit, a crash, its own close. */
  closed: Promise<void>;
  /** Ends that connection from this side, when the practice stops for another reason. */
  end(): void;
}

export interface PracticeDependencies {
  /** conch's own folder for the welcome card (`~/.cache/conch/practice`): emptied at every start and stop. */
  dir: string;
  now(): number;
  log(line: string): void;
  /** Who has the ear, when it isn't this Mac. */
  audioElsewhere(): "phone" | "another-mac" | null;
  /** Speech recognition is downloaded and loadable. */
  recognitionReady(): boolean;
  /** The natural voices are ready; else the line is read with the Mac's own voice. */
  naturalVoicesReady(): boolean;
  /** The voice loop's practice turn (`VoiceLoop.practice`), with the daemon's config. */
  turn(options: { line?: string; systemVoice: boolean; stillWanted(): boolean; onLine(): void; onSpoken(): void }): Promise<PracticeTurnOutcome>;
  /** The line cut short: the practice stopped while its own line was playing (`onLine` until `onSpoken`), never before. */
  hush(): void;
  /** A composer dictation's words, back to the composer that asked (`publishDictation`). */
  dictated(text: string): void;
  /** Something about the practice changed: publish it. */
  changed(): void;
  /** The ring voice the line is read in, published on its row. */
  voice?: string;
  /** Scheduling, for tests; the lease's longest life. */
  setTimer?(run: () => void, ms: number): { clear(): void };
}

interface Run {
  startedAt: number;
  stage: PracticeStage;
  /** The line has played through at least once. */
  spoken: boolean;
  /** A line or a mic window is running now. */
  busy: boolean;
  /**
   * Its own line is playing: the voice loop holds the queue for it and has started it (`onLine`), and it hasn't finished
   * (`onSpoken`). A practice waiting behind another session's turn is `speaking` and `busy` without this: what is playing
   * then is that session's, and stopping the practice must not cut it off.
   */
  linePlaying: boolean;
  listening: boolean;
  heard?: string;
  silent: boolean;
  problem?: { reason: PracticeRefusal; words: string };
  systemVoice: boolean;
  items: ConversationItem[];
  answers: number;
  replied: boolean;
  review?: SessionReview;
  lease?: PracticeLease;
  timer?: { clear(): void };
}

export interface Practice {
  handle(request: PracticeRequest, lease?: PracticeLease): Promise<PracticeReply>;
  /** The practice session's id, whether or not one is running: nothing else may take an event for it. */
  owns(sessionId: string | undefined): boolean;
  /** An event the intake took for the practice session, answered here and never passed on. An inject resolves to whether it was echoed. */
  turn(event: TurnEvent): Promise<boolean> | void;
  /** A session command naming it: marking its card looked at, or removing it. Nothing else does anything. */
  sessionCommand(message: SessionControlMessage): SessionControlResponse;
  /** The published state with the practice in it: its row first, its conversation, and the `practice` block. */
  publish(state: PublishedState): PublishedState;
  /** What the published state carries, or null with none running. */
  published(): PublishedPractice | null;
  running(): boolean;
  /** Stopped for `why`; false when none was running. */
  stop(why: string): boolean;
}

export function createPractice(deps: PracticeDependencies): Practice {
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { clear: () => clearTimeout(timer) };
  });
  let current: Run | null = null;
  // Whatever an earlier daemon left, crashed mid-practice or killed: gone before anything is published.
  clearFolder(deps.dir);

  const item = (run: Run, id: string, kind: "user" | "assistant", text: string): void => {
    run.items.push({ id, rev: 1, kind, text, at: deps.now() });
  };

  /** The one sink for what the practice heard, or was typed to it: its own conversation, and nothing else. */
  const echo = (run: Run, text: string): boolean => {
    const words = text.replace(/\s+/g, " ").trim();
    if (!words) return false;
    run.answers += 1;
    item(run, `practice-answer-${run.answers}`, "user", words);
    run.heard = words;
    run.silent = false;
    if (!run.replied) {
      run.replied = true;
      item(run, "practice-reply", "assistant", PRACTICE_REPLY);
    }
    // Its length, never the words, as every answer conch hears is logged.
    deps.log(`practice: echoed ${words.length} chars into its own conversation`);
    return true;
  };

  /** The welcome card, filed as any deliverable is (`fileReview`), in conch's own folder. */
  const fileCard = (run: Run): void => {
    if (run.review) return;
    const link = join(deps.dir, WELCOME_FILE);
    try {
      mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
      writeFileSync(link, welcomeCard(), { mode: 0o600 });
    } catch (error) {
      deps.log(`practice: couldn't write the welcome card: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    run.review = fileReview(PRACTICE_SESSION_ID, { summary: WELCOME_SUMMARY, link, kind: "page" }, deps.now(), undefined);
    if (run.stage !== "viewed") run.stage = "ready";
    deps.log("practice: the welcome card is ready");
  };

  /** One go: the line (when given), then one mic window, through the voice loop. */
  const exchange = async (run: Run, line: string | undefined, compose = false): Promise<void> => {
    run.busy = true;
    run.problem = undefined;
    run.systemVoice = !deps.naturalVoicesReady();
    if (line) run.stage = "speaking";
    deps.changed();
    let outcome: PracticeTurnOutcome;
    try {
      outcome = await deps.turn({
        ...(line ? { line } : {}),
        systemVoice: run.systemVoice,
        stillWanted: () => current === run,
        onLine: () => {
          if (current === run) run.linePlaying = true;
        },
        onSpoken: () => {
          run.linePlaying = false;
          if (current !== run) return;
          run.spoken ||= Boolean(line);
          if (run.stage === "speaking") run.stage = "listening";
          run.listening = true;
          deps.changed();
        },
      });
    } catch (error) {
      deps.log(`practice: its turn failed: ${error instanceof Error ? error.message : String(error)}`);
      outcome = { heard: null, interrupted: true };
    }
    run.busy = false;
    run.linePlaying = false;
    run.listening = false;
    if (current !== run) return;
    if ("refused" in outcome) {
      run.problem = { reason: outcome.refused, words: practiceRefusal(outcome.refused) };
      deps.log(`practice: refused (${outcome.refused})`);
      return deps.changed();
    }
    if (outcome.heard) {
      if (compose) deps.dictated(outcome.heard);
      else echo(run, outcome.heard);
    } else if (!outcome.interrupted) {
      run.silent = true;
    }
    // Ready once the first window has closed, heard or not: the tour's next beat has something to open.
    if (run.spoken) fileCard(run);
    deps.changed();
  };

  const stop = (why: string): boolean => {
    const run = current;
    if (!run) return false;
    current = null;
    run.timer?.clear();
    // Only its own line: queued behind another session's turn, what is playing is that session's.
    if (run.linePlaying) deps.hush();
    run.linePlaying = false;
    clearFolder(deps.dir);
    deps.log(`practice: stopped (${why})`);
    deps.changed();
    // The app's side of the lease learns it is over, whoever ended it.
    run.lease?.end();
    return true;
  };

  const start = (lease?: PracticeLease): PracticeReply => {
    const elsewhere = deps.audioElsewhere();
    if (elsewhere) return { kind: "practice-error", reason: elsewhere, error: practiceRefusal(elsewhere) };
    if (!deps.recognitionReady()) return { kind: "practice-error", reason: "recognition", error: practiceRefusal("recognition") };
    if (current) stop("started again");
    clearFolder(deps.dir);
    const run: Run = {
      startedAt: deps.now(), stage: "speaking", spoken: false, busy: false, linePlaying: false, listening: false, silent: false,
      systemVoice: false, items: [], answers: 0, replied: false,
    };
    item(run, "practice-line", "assistant", PRACTICE_LINE);
    current = run;
    if (lease) {
      run.lease = lease;
      void lease.closed.then(() => {
        if (current === run) stop("the app that started it went away");
      });
    }
    run.timer = setTimer(() => {
      if (current === run) stop("it ran its full length");
    }, PRACTICE_LEASE_MAX_MS);
    deps.log("practice: started");
    void exchange(run, PRACTICE_LINE);
    return { kind: "practice-started", sessionId: PRACTICE_SESSION_ID };
  };

  /** Another go: the line again when it never played, else one more mic window. */
  const again = (compose = false): PracticeReply => {
    const run = current;
    if (!run) return { kind: "practice-error", reason: "none", error: practiceRefusal("none") };
    if (run.busy) return { kind: "practice-listening" };
    const elsewhere = deps.audioElsewhere();
    if (elsewhere) {
      run.problem = { reason: elsewhere, words: practiceRefusal(elsewhere) };
      deps.changed();
      return { kind: "practice-error", reason: elsewhere, error: practiceRefusal(elsewhere) };
    }
    void exchange(run, run.spoken ? undefined : PRACTICE_LINE, compose);
    return { kind: "practice-listening" };
  };

  const published = (): PublishedPractice | null => {
    const run = current;
    if (!run) return null;
    return {
      sessionId: PRACTICE_SESSION_ID,
      stage: run.stage,
      ...(run.heard ? { heard: run.heard } : {}),
      ...(run.silent && !run.heard ? { silent: true as const } : {}),
      ...(run.listening ? { listening: true as const } : {}),
      ...(run.problem ? { problem: { ...run.problem } } : {}),
      ...(run.systemVoice ? { systemVoice: true as const } : {}),
    };
  };

  return {
    async handle(request, lease) {
      switch (request.kind) {
        case "practice-start": return start(lease);
        case "practice-listen": return again();
        case "practice-stop": return { kind: "practice-stopped", removed: stop("asked to") };
      }
    },
    owns: (sessionId) => sessionId === PRACTICE_SESSION_ID,
    turn(event) {
      const run = current;
      if (event.type === "inject") {
        // Typed into its composer: the same sink as a spoken answer, and never a keystroke anywhere.
        if (!run) return Promise.resolve(false);
        const echoed = echo(run, event.announce);
        if (echoed) {
          if (run.spoken) fileCard(run);
          deps.changed();
        }
        return Promise.resolve(echoed);
      }
      if (event.type === "wake") {
        // Its mic button, or its composer's: one more window, whose words go where that button's go.
        if (run) again(event.compose === true);
        return;
      }
      deps.log(`practice: ${event.type} for the practice session, which it doesn't take`);
    },
    sessionCommand(message) {
      const run = current;
      const ack = (changed: boolean): SessionControlResponse => ({
        kind: "session-ack", sessionId: message.sessionId, command: message.command, label: PRACTICE_LABEL, changed,
      });
      if (!run) return ack(false);
      if (message.command === "review-viewed" && run.review && message.review === run.review.id) {
        if (run.review.viewedAt === undefined) {
          run.review = { ...run.review, viewedAt: deps.now() };
          run.stage = "viewed";
          deps.log("practice: the welcome card was opened");
          deps.changed();
        }
        return ack(true);
      }
      if (message.command === "review-remove" && run.review
        && (message.review === run.review.id || message.artifact === run.review.artifact)) {
        run.review = undefined;
        deps.changed();
        return ack(true);
      }
      return ack(false);
    },
    publish(state) {
      const withFeature: PublishedState = { ...state, features: { ...state.features, practice: 1 } };
      const rows = withFeature.rows.filter((row) => row.id !== PRACTICE_SESSION_ID);
      const { [PRACTICE_SESSION_ID]: _stale, ...conversations } = withFeature.conversations ?? {};
      const { practice: _gone, conversations: _all, ...rest } = withFeature;
      const run = current;
      if (!run) {
        return { ...rest, rows, ...(Object.keys(conversations).length ? { conversations } : {}) };
      }
      return {
        ...rest,
        rows: [practiceRow(run, state, deps), ...rows],
        conversations: {
          ...conversations,
          [PRACTICE_SESSION_ID]: { sessionId: PRACTICE_SESSION_ID, items: run.items.map((one) => ({ ...one })), truncated: false },
        },
        practice: published()!,
      };
    },
    published,
    running: () => current !== null,
    stop,
  };
}

const LIVE_ON_ROW = new Set(["speaking", "listening", "recording", "transcribing"]);

/** The practice session's row: first, active, and holding its card once it has one. */
function practiceRow(run: Run, state: PublishedState, deps: Pick<PracticeDependencies, "dir" | "voice">): PublishedSessionRow {
  const review = run.review;
  const wire = review
    ? {
      summary: review.summary,
      ...(review.link ? { link: review.link } : {}),
      at: review.at,
      id: review.id,
      ...(review.viewedAt !== undefined ? { viewedAt: review.viewedAt } : {}),
      ...(review.artifact ? { artifact: review.artifact } : {}),
      ...(review.version !== undefined ? { version: review.version } : {}),
      ...(review.kind ? { kind: review.kind } : {}),
    }
    : undefined;
  // The voice is on it while conch speaks or listens for it, by the live state's own label: the practice is the only
  // session called that.
  const live = state.live.label === PRACTICE_LABEL && LIVE_ON_ROW.has(state.live.state) ? state.live.state : null;
  return {
    id: PRACTICE_SESSION_ID,
    label: PRACTICE_LABEL,
    backend: "conch",
    status: wire ? "waiting" : null,
    at: wire?.at ?? run.startedAt,
    cwd: deps.dir,
    ...(deps.voice ? { voice: deps.voice } : {}),
    needsResponse: false,
    ...(wire ? { detail: wire.summary } : {}),
    paused: false,
    muted: false,
    live,
    active: true,
    noTerminal: PRACTICE_NO_TERMINAL,
    ...(wire ? { review: wire, reviews: [wire] } : {}),
  };
}

/**
 * The intake's door for the practice session. An event naming it is answered by the practice and never passed on: an
 * inject from its composer is echoed, not typed; a wake opens a practice window, not a session's. Every other session's
 * events go to `next` untouched.
 */
export function practiceGate<R>(practice: Pick<Practice, "owns" | "turn">, next: (event: TurnEvent) => R): (event: TurnEvent) => R | Promise<boolean> | void {
  return (event) => (practice.owns(event.sessionId) ? practice.turn(event) : next(event));
}

function clearFolder(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * The welcome card: one self-contained page, light and dark, nothing fetched. What the practice showed, and where the
 * rest lives.
 */
export function welcomeCard(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${WELCOME_SUMMARY}</title>
<style>
  :root { --ground: #f2f1ef; --card: #ffffff; --ink: #1d1d1f; --soft: #5f5f64; --faint: #8e8e93; --line: rgba(0,0,0,0.08); --ready: #2ea44f; }
  @media (prefers-color-scheme: dark) {
    :root { --ground: #1c1c1e; --card: #2a2a2d; --ink: #f2f2f4; --soft: #b4b4ba; --faint: #86868c; --line: rgba(255,255,255,0.1); --ready: #3fb950; }
  }
  html, body { margin: 0; background: var(--ground); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; }
  main { max-width: 560px; margin: 56px auto; padding: 0 20px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 20px; padding: 32px 32px 28px; box-shadow: 0 12px 40px rgba(0,0,0,0.08); }
  .mark { width: 28px; height: 28px; border-radius: 50%; background: var(--ready); display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 15px; }
  h1 { font-size: 28px; line-height: 1.15; letter-spacing: -0.4px; margin: 18px 0 8px; }
  p { color: var(--soft); margin: 0 0 16px; }
  ul { list-style: none; padding: 0; margin: 20px 0 0; border-top: 1px solid var(--line); }
  li { padding: 12px 0; border-bottom: 1px solid var(--line); color: var(--ink); }
  li span { display: block; color: var(--soft); font-size: 13px; }
  kbd { font: 600 12px/1 -apple-system, sans-serif; border: 1px solid var(--line); border-radius: 5px; padding: 3px 5px; background: var(--ground); }
  footer { color: var(--faint); font-size: 12px; margin-top: 18px; text-align: center; }
</style>
</head>
<body>
<main>
  <div class="card">
    <div class="mark" aria-hidden="true">&#10003;</div>
    <h1>${WELCOME_SUMMARY}</h1>
    <p>This is how an agent's finished work reaches you. conch reads you the turn, takes your answer out loud, and brings what it made to where it lives: a page, an app, a file.</p>
    <ul>
      <li>The pill<span>Who's talking, and what's ready. Green means something is waiting for you.</span></li>
      <li>The panel<span>The conversation and a line to answer in. <kbd>&#8984;&#8617;</kbd> fills the screen, <kbd>&#8984;.</kbd> folds it away.</span></li>
      <li>Drawing<span><kbd>&#8963;&#8997;&#8984;P</kbd> puts the pen down over anything, to mark it up and send it to the agent.</span></li>
    </ul>
  </div>
  <footer>conch's own practice card. It goes away when setup finishes.</footer>
</main>
</body>
</html>
`;
}

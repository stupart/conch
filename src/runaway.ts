import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { basename } from "node:path";

/**
 * Runaway guards: what stops conch doing more and more of something that keeps failing.
 *
 * Tyler, 2026-10-28: "do we have protections in place to stop the daemon from going out of control and infinite
 * looping making processes until my computer is bricked if an error is going off over and over or something?"
 * Mostly yes, one piece at a time: the app backs off a daemon that keeps exiting (`DaemonHealth.CrashBudget`), a
 * warm server's restarts come in bursts of three (`server-supervisor.ts`), a lost background session comes back at
 * most three times a day (`background-recovery.ts`), the logs roll over. What none of them had was a memory longer
 * than one burst. A whisper-server that answered once and then died, or never started at all, was tried again
 * every 30 s for as long as the daemon lived, about 8,600 spawns a day, each loading a large model, and nothing told
 * Tyler. And nothing counted the processes conch had running at once.
 *
 * So this file holds the three small things every guard shares, documented in `docs/runaway-guards.md`:
 *
 *  - `Breaker`: at most `limit` of something (a restart, a relaunch) in `windowMs`. The next one is refused, for
 *    a cool-down that grows each time it trips again (5 min, 15 min, 1 h by default), and forgiven once it has gone
 *    `calmMs` without tripping. Every breaker belongs to a `RunawayGuards`, which logs a trip once, in plain words,
 *    and publishes it (`PublishedState.guards`) for the Mac app to say.
 *  - `installChildCeiling`: a ceiling on the child processes the daemon has running at once. It wraps `Bun.spawn`,
 *    so every one of the daemon's spawn sites is under it without each having to remember to be.
 *  - `LogDamper`: one line said over and over is written a few times a minute and then counted, so a repeating
 *    error neither churns the disk nor rolls the history that explains it out of the log.
 */

// MARK: - Breaker

export interface BreakerPolicy {
  /** This many events inside `windowMs` trip it: the next is refused. */
  limit: number;
  windowMs: number;
  /** How long it stays open after its first trip, its second in a row, …; the last one repeats. */
  cooldownsMs: readonly number[];
  /** This long without a trip, and the next trip starts from the first cool-down again. */
  calmMs: number;
}

/** A restarted worker: five in ten minutes is no longer recovering. Then 5 min, 15 min, and hourly after that. */
export const RESTART_POLICY: BreakerPolicy = {
  limit: 5,
  windowMs: 10 * 60_000,
  cooldownsMs: [5 * 60_000, 15 * 60_000, 60 * 60_000],
  calmMs: 2 * 60 * 60_000,
};

/** A trip, as the log, the published state and the Mac app say it. */
export interface GuardTrip {
  /** Stable key: `whisper-server`, `kokoro`, `processes`, `session-relaunch`. */
  name: string;
  /** What stopped, in words that finish "conch stopped …": "restarting the speech engine (whisper-server)". */
  what: string;
  /** Why, in words that finish "because it …": "failed 5 times in 10 min". */
  why: string;
  /** The last thing it said, cut short. */
  detail?: string;
  /** Epoch ms it tripped. */
  trippedAt: number;
  /** Epoch ms it allows again; absent for a guard that is not timed (the process ceiling, while over). */
  retryAt?: number;
  /** Trips in a row without a calm `calmMs` between: 1 the first time. */
  trips: number;
}

export interface BreakerOptions {
  name: string;
  what: string;
  policy?: BreakerPolicy;
  now?: () => number;
  /** Told when it trips and when a trip is over, so the registry can log and republish. */
  changed?: (breaker: Breaker, tripped: boolean) => void;
}

const DETAIL_MAX = 240;

/**
 * At most `limit` events in `windowMs`; the next is refused until a cool-down has passed.
 *
 * An event is whatever the guard counts: a worker restarted, a session brought back. Callers ask `allows()` before
 * doing it and `record()` once it is done, so the event that reaches the limit still happens and the one after is
 * refused. A trip clears the count: after its cool-down the work gets another `limit` before tripping again, for
 * longer. Nothing here starts a timer; `waitMs()` says how long, and the caller schedules its own retry with it.
 */
export class Breaker {
  readonly name: string;
  readonly what: string;
  readonly policy: BreakerPolicy;
  readonly #now: () => number;
  readonly #changed?: (breaker: Breaker, tripped: boolean) => void;
  #events: number[] = [];
  #openUntil = 0;
  #trips = 0;
  #lastTripAt = 0;
  #detail: string | undefined;

  constructor(options: BreakerOptions) {
    this.name = options.name;
    this.what = options.what;
    this.policy = options.policy ?? RESTART_POLICY;
    this.#now = options.now ?? Date.now;
    this.#changed = options.changed;
  }

  /** May the work run now? */
  allows(): boolean {
    return this.waitMs() === 0;
  }

  /** How long until it allows again: 0 when it does. */
  waitMs(): number {
    return Math.max(0, this.#openUntil - this.#now());
  }

  /**
   * One event happened. True while it is still under its limit; false when this one tripped it (or it was already
   * open, which a caller that asked `allows()` first never sees).
   */
  record(detail?: string): boolean {
    const now = this.#now();
    if (detail) this.#detail = detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail;
    if (now < this.#openUntil) return false;
    if (this.#trips && now - this.#lastTripAt >= this.policy.calmMs) this.#trips = 0;
    this.#events = this.#events.filter((at) => now - at < this.policy.windowMs);
    this.#events.push(now);
    if (this.#events.length < this.policy.limit) return true;
    this.#trip(now);
    return false;
  }

  /** It came good for long enough to say so (a person's Try again, a fresh install): forget everything. */
  reset(): void {
    const wasOpen = this.#openUntil > this.#now();
    this.#events = [];
    this.#openUntil = 0;
    this.#trips = 0;
    this.#detail = undefined;
    if (wasOpen) this.#changed?.(this, false);
  }

  /** The trip in force, or null while it allows. */
  trip(): GuardTrip | null {
    const now = this.#now();
    if (now >= this.#openUntil) return null;
    return {
      name: this.name,
      what: this.what,
      why: `${this.#trips > 1 ? "kept failing: " : "failed "}${this.policy.limit} times in ${duration(this.policy.windowMs)}`,
      ...(this.#detail ? { detail: this.#detail } : {}),
      trippedAt: this.#lastTripAt,
      retryAt: this.#openUntil,
      trips: this.#trips,
    };
  }

  #trip(now: number): void {
    const cooldowns = this.policy.cooldownsMs;
    const cooldown = cooldowns[Math.min(this.#trips, cooldowns.length - 1)] ?? 60_000;
    this.#trips += 1;
    this.#lastTripAt = now;
    this.#openUntil = now + cooldown;
    this.#events = [];
    this.#changed?.(this, true);
  }
}

/** "10 min", "1 h", "45 s": how a window or a cool-down is said. */
export function duration(ms: number): string {
  if (ms >= 60 * 60_000 && ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1_000))} s`;
}

// MARK: - The registry

export interface RunawayGuardsOptions {
  log?: (message: string) => void;
  /** Something to republish: a trip, or a trip over. */
  changed?: () => void;
  now?: () => number;
}

/**
 * The daemon's guards, by name: each breaker it hands out logs its trip here once, and the trips in force are what
 * `published()` returns for `PublishedState.guards`. A guard that is not a breaker (the process ceiling) reports
 * through `note()`, which shows for a fixed while and is forgotten after.
 */
export class RunawayGuards {
  readonly #breakers = new Map<string, Breaker>();
  /** Notes by name, each with when it stops showing: not a retry, so not the trip's `retryAt`. */
  readonly #notes = new Map<string, { trip: GuardTrip; until: number }>();
  #log: (message: string) => void;
  #changed: () => void;
  readonly #now: () => number;

  constructor(options: RunawayGuardsOptions = {}) {
    this.#log = options.log ?? (() => {});
    this.#changed = options.changed ?? (() => {});
    this.#now = options.now ?? Date.now;
  }

  /** Where trips are said and republished: set once the daemon has its log and its publisher. */
  wire(options: Pick<RunawayGuardsOptions, "log" | "changed">): void {
    if (options.log) this.#log = options.log;
    if (options.changed) this.#changed = options.changed;
  }

  /** The breaker by this name, made on first ask. */
  breaker(name: string, what: string, policy: BreakerPolicy = RESTART_POLICY): Breaker {
    const known = this.#breakers.get(name);
    if (known) return known;
    const breaker = new Breaker({
      name, what, policy, now: this.#now,
      changed: (changed, tripped) => {
        if (tripped) {
          const trip = changed.trip();
          if (trip) this.#log(tripLine(trip, this.#now()));
        }
        // A republish that throws (the panel not built yet) must never throw into the worker that tripped.
        try { this.#changed(); } catch {}
      },
    });
    this.#breakers.set(name, breaker);
    return breaker;
  }

  /**
   * A guard that is not a breaker held something back (the process ceiling refused a spawn): shown until `forMs`
   * after the last time it did, and said in the log once per showing, however often it holds back meanwhile.
   */
  note(trip: Omit<GuardTrip, "trippedAt" | "trips" | "retryAt"> & { forMs: number }): void {
    const now = this.#now();
    const known = this.#notes.get(trip.name);
    const { forMs, ...rest } = trip;
    const showing = known !== undefined && known.until > now;
    const next: GuardTrip = {
      ...rest,
      trippedAt: showing ? known.trip.trippedAt : now,
      trips: showing ? known.trip.trips : (known?.trip.trips ?? 0) + 1,
    };
    this.#notes.set(trip.name, { trip: next, until: now + forMs });
    if (!showing) {
      this.#log(tripLine(next, now));
      try { this.#changed(); } catch {}
    }
  }

  /** The trips in force now, newest first: what the Mac app says. */
  published(): GuardTrip[] {
    const now = this.#now();
    const trips: GuardTrip[] = [];
    for (const breaker of this.#breakers.values()) {
      const trip = breaker.trip();
      if (trip) trips.push(trip);
    }
    for (const [name, note] of this.#notes) {
      if (note.until > now) trips.push(note.trip);
      else if (now - note.until > 24 * 60 * 60_000) this.#notes.delete(name);
    }
    return trips.sort((a, b) => b.trippedAt - a.trippedAt);
  }
}

function tripLine(trip: GuardTrip, now: number): string {
  const again = trip.retryAt ? `; tries again in ${duration(trip.retryAt - now)}` : "";
  const detail = trip.detail ? ` (last: ${trip.detail})` : "";
  return `runaway guard: stopped ${trip.what} — it ${trip.why}${detail}${again}`;
}

/**
 * The daemon's one registry. Module-level so a guard deep in a worker's supervisor reaches the same one the
 * publisher reads, without threading it through every constructor; tests make their own.
 */
export const runawayGuards = new RunawayGuards();

// MARK: - The process ceiling

/**
 * Children the daemon may have running at once. A steady daemon has three (whisper-server, the Kokoro worker,
 * claude-swap) and a few short ones at a time (`ps`, `tmux`, `osascript`, `lsof`): measured 2026-10-28 with 14
 * sessions open, never more than five. Far under the Mac's own limit (`kern.maxprocperuid`, 10,666 here), so
 * reaching it means something is piling up, and conch stops adding to the pile before the Mac has to.
 */
export const CHILD_CEILING = 64;

/**
 * The ceiling this daemon runs under: `CHILD_CEILING`, unless `CONCH_CHILD_CEILING` names another whole number, which
 * only scripts/runaway-e2e.ts does, to prove in a sandboxed daemon that one past it is refused and the daemon lives on.
 */
export function childCeilingFrom(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const set = env.CONCH_CHILD_CEILING?.trim();
  return set && /^\d+$/.test(set) ? Number(set) : CHILD_CEILING;
}

export class ChildCeilingError extends Error {
  readonly code = "ECONCHCEILING";
}

export interface ChildCeiling {
  /** Children running now that went through the ceiling. */
  live(): number;
  /** The same, by program name, most first. */
  byProgram(): Array<[string, number]>;
  /** Spawns refused since it was installed. */
  refused(): number;
  /** Put `Bun.spawn` back (tests). */
  uninstall(): void;
}

export interface ChildCeilingOptions {
  limit?: number;
  /** Said when a spawn is refused: the guards' `note`, in the daemon. */
  onRefused?: (live: number, program: string, byProgram: Array<[string, number]>) => void;
  /** The object whose `spawn` is wrapped; `Bun`, unless a test hands it another. */
  target?: { spawn: (...args: never[]) => { exited: Promise<unknown> } };
}

/** The program a spawn names: `Bun.spawn(argv, …)` or `Bun.spawn({ cmd }, …)`. */
function programOf(first: unknown): string {
  const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | null)?.cmd;
  const program = Array.isArray(argv) ? argv[0] : undefined;
  return typeof program === "string" && program ? basename(program) : "?";
}

/**
 * Hold the daemon's live children to `limit`: past it, `Bun.spawn` throws `ChildCeilingError` instead of starting
 * another, the way it throws for a program that isn't there, which every spawn site already has to survive.
 *
 * It wraps `Bun.spawn` itself rather than each of the daemon's forty-odd spawn sites, so a site added next month is
 * under it too. A child counts from its spawn until its exit is observed. `Bun.spawnSync` is not counted: it blocks
 * the one thread that could start another, so it can never pile up. Only the daemon installs it: a hook or an MCP
 * server is one short process per turn or per session, already bounded by what started it.
 */
export function installChildCeiling(options: ChildCeilingOptions = {}): ChildCeiling {
  const limit = options.limit ?? CHILD_CEILING;
  const target = (options.target ?? Bun) as unknown as { spawn: (...args: unknown[]) => { exited: Promise<unknown> } };
  const original = target.spawn;
  const programs = new Map<string, number>();
  let live = 0;
  let refused = 0;
  const byProgram = (): Array<[string, number]> => [...programs].sort((a, b) => b[1] - a[1]);
  const guarded = function guardedSpawn(this: unknown, ...args: unknown[]) {
    const program = programOf(args[0]);
    if (live >= limit) {
      refused += 1;
      try { options.onRefused?.(live, program, byProgram()); } catch {}
      throw new ChildCeilingError(
        `conch already has ${live} child processes running, its ceiling; not starting ${program}`,
      );
    }
    const child = original.apply(target, args);
    live += 1;
    programs.set(program, (programs.get(program) ?? 0) + 1);
    let counted = true;
    const exited = (): void => {
      if (!counted) return;
      counted = false;
      live -= 1;
      const left = (programs.get(program) ?? 1) - 1;
      if (left > 0) programs.set(program, left);
      else programs.delete(program);
    };
    child.exited.then(exited, exited);
    return child;
  };
  target.spawn = guarded;
  return {
    live: () => live,
    byProgram,
    refused: () => refused,
    uninstall: () => {
      if (target.spawn === guarded) target.spawn = original;
    },
  };
}

// MARK: - Logs

/** The same line with its numbers, ids and quoted names taken out: what "the same message again" means. */
export function logShape(line: string): string {
  return line
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/"[^"]*"|“[^”]*”/g, "\"…\"")
    .replace(/\d+(?:\.\d+)?/g, "N")
    .slice(0, 200);
}

export interface LogDamperOptions {
  /** Lines of one shape written per window; the rest are counted. */
  burst?: number;
  windowMs?: number;
  /** Shapes remembered at once; the oldest is forgotten first. */
  shapes?: number;
  now?: () => number;
}

interface ShapeWindow {
  startedAt: number;
  written: number;
  held: number;
  example: string;
}

/**
 * Rate limit for a log: per shape (`logShape`), `burst` lines a window are written; past that they are counted, and
 * the count is written as one line when the window is over, at the next line logged. A storm of one error costs a
 * handful of lines a minute instead of thousands, and the log still says it happened and how often.
 */
export class LogDamper {
  readonly #burst: number;
  readonly #windowMs: number;
  readonly #shapes: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, ShapeWindow>();

  constructor(options: LogDamperOptions = {}) {
    this.#burst = options.burst ?? 10;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#shapes = options.shapes ?? 256;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The lines to write for this one: a summary of any window that has closed since, then the line itself unless
   * its shape is over its burst.
   */
  admit(line: string): string[] {
    const now = this.#now();
    const out = this.#closed(now);
    const shape = logShape(line);
    let window = this.#windows.get(shape);
    if (!window || now - window.startedAt >= this.#windowMs) {
      window = { startedAt: now, written: 0, held: 0, example: line };
    }
    this.#windows.delete(shape); // re-inserted last: the map's order is least recently used first
    this.#windows.set(shape, window);
    if (this.#windows.size > this.#shapes) this.#windows.delete(this.#windows.keys().next().value!);
    if (window.written < this.#burst) {
      window.written += 1;
      out.push(line);
    } else {
      window.held += 1;
      window.example = line;
    }
    return out;
  }

  /** Summaries of windows that closed holding lines back; those windows are forgotten. */
  #closed(now: number): string[] {
    const out: string[] = [];
    for (const [shape, window] of this.#windows) {
      if (now - window.startedAt < this.#windowMs) continue;
      if (window.held) {
        out.push(`(${window.held} more like this in ${duration(this.#windowMs)}, last: ${window.example})`);
      }
      this.#windows.delete(shape);
    }
    return out;
  }
}

/**
 * Append a line to a diagnostic file that rolls over at `maxBytes` to one previous copy, like the daemon log: two
 * files at most, whatever is written. Best effort, as every diagnostic is.
 */
export function appendCapped(path: string, text: string, maxBytes: number): void {
  try {
    if (existsSync(path) && statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
  } catch {}
  try {
    appendFileSync(path, text, { mode: 0o600 });
  } catch {}
}

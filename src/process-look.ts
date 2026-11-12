import { readProcessRows } from "./process-table.ts";
/**
 * One look at something only a process can tell conch (the process table, a tmux server's panes), shared by every
 * caller that asks within an interval.
 *
 * Each render read the registry, and each registry read ran its own `ps -Ao pid=,ppid=` (73 ms on a quiet Mac,
 * 100–190 ms loaded) and each complete one two `tmux list-panes`: `conch evals` counted 290 `ps` and 493 `tmux` a
 * minute in its scripted load (12 sessions, 3 working, four renders a second), 2026-11-11. A process tree the
 * registry hasn't seen move is the same tree, so:
 *
 *  - a look is reused for `minIntervalMs`, whoever asks;
 *  - each look that finds what the last one found doubles that, up to `maxIntervalMs`: a quiet Mac is looked at
 *    less and less often;
 *  - `invalidate()` (a session opened or closed: the registry watchers) makes the next ask look again at once;
 *  - `nudge()` (something moved that may have started a process: a transcript grew) drops the interval back to
 *    `minIntervalMs`, without forcing a look;
 *  - a caller that must see the latest state passes `maxAgeMs` (0: look now, or join the look under way).
 *
 * A look that fails is never kept: the next ask tries again.
 */
export interface SharedLookOptions<T> {
  read: () => Promise<T | null>;
  /** Whether two looks found the same thing: the interval backs off while they do. */
  same: (a: T, b: T) => boolean;
  minIntervalMs: number;
  maxIntervalMs: number;
  now?: () => number;
}

export class SharedLook<T> {
  readonly #options: SharedLookOptions<T>;
  #kept: { value: T; at: number } | null = null;
  #flight: { generation: number; answer: Promise<T | null> } | null = null;
  #interval: number;
  /** Moved by `invalidate`: a look started before it can't answer an ask made after it. */
  #generation = 0;
  #keptGeneration = 0;

  constructor(options: SharedLookOptions<T>) {
    this.#options = options;
    this.#interval = options.minIntervalMs;
  }

  get(options: { maxAgeMs?: number } = {}): Promise<T | null> {
    const now = (this.#options.now ?? Date.now)();
    const kept = this.#kept;
    const reuseFor = Math.min(this.#interval, options.maxAgeMs ?? Infinity);
    if (kept && this.#keptGeneration === this.#generation && now - kept.at < reuseFor) return Promise.resolve(kept.value);
    if (this.#flight?.generation === this.#generation) return this.#flight.answer;
    const flight = { generation: this.#generation, answer: this.#look(this.#generation) };
    this.#flight = flight;
    void flight.answer.finally(() => { if (this.#flight === flight) this.#flight = null; });
    return flight.answer;
  }

  /** The last look, and when it was taken; null before one succeeded. Never starts a look. */
  peek(): { value: T; at: number } | null {
    return this.#kept;
  }

  invalidate(): void {
    this.#generation += 1;
    this.#interval = this.#options.minIntervalMs;
  }

  nudge(): void {
    this.#interval = this.#options.minIntervalMs;
  }

  /** How long a look is reused for now. Exposed for the tests. */
  interval(): number {
    return this.#interval;
  }

  async #look(generation: number): Promise<T | null> {
    const value = await this.#options.read().catch(() => null);
    // A failed look keeps nothing; one overtaken by an `invalidate` answers its own askers and keeps nothing either.
    if (value === null || generation !== this.#generation) return value;
    const previous = this.#kept?.value;
    this.#interval = previous !== undefined && this.#options.same(previous, value)
      ? Math.min(this.#options.maxIntervalMs, this.#interval * 2)
      : this.#options.minIntervalMs;
    // Taken when the look finished: a look that took 190 ms is that old when it lands, not older.
    this.#kept = { value, at: (this.#options.now ?? Date.now)() };
    this.#keptGeneration = generation;
    return value;
  }
}

/** Every process's parent, by pid. */
export type ProcessParents = ReadonlyMap<number, number>;

export function parseProcessParents(text: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) table.set(pid!, ppid!);
  }
  return table;
}

export function sameProcessParents(a: ProcessParents, b: ProcessParents): boolean {
  if (a.size !== b.size) return false;
  for (const [pid, ppid] of a) if (b.get(pid) !== ppid) return false;
  return true;
}

/**
 * The same `ps` names each process's terminal and executable too (2026-11-12), and the table is kept
 * (`latestProcessRows`, process-table.ts): finding the agents running outside conch (elsewhere.ts) reads it rather than
 * running a `ps` of its own.
 */
async function readProcessParents(): Promise<Map<number, number> | null> {
  const rows = await readProcessRows();
  return rows ? new Map(rows.map((row) => [row.pid, row.ppid])) : null;
}

/**
 * This process's shared look at the process table: what `processParentTable` answers. Anything else that wants the
 * table on an interval (a resource ledger sampling conch's tree) asks this one rather than running its own `ps`.
 *
 * A second up to every 16 s with nothing changing: the registry watchers invalidate it when a session opens or
 * closes, which is when the sessions' ancestry can change.
 */
export const processLook = new SharedLook<ProcessParents>({
  read: readProcessParents,
  same: sameProcessParents,
  minIntervalMs: 1_000,
  maxIntervalMs: 16_000,
});

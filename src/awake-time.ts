/**
 * Deadlines that count only the time this process ran, so a Mac asleep never runs one out.
 *
 * On macOS a timer's clock keeps counting through sleep. A thirty-second setTimeout armed two seconds before the Mac
 * went back to sleep fires the moment it next wakes, a quarter of an hour later, having given the work it guards two
 * seconds. The daemon has no sleep notification of its own to correct for that: the app's `system-woke` comes for full
 * wakes only, and the DarkWakes a sleeping Mac makes every quarter hour send nothing. So it tells sleep the way the
 * wake watch (daemon.ts) and the phone relay's liveness timer already do: a timer that fires much later than it was
 * due was not running in between. A deadline here ticks, and a tick that comes back late counts for nothing.
 *
 * 2026-10-23, overnight in manual mode: the Kokoro worker's idle health check started in one DarkWake and its timeout
 * fired in the next, in the same second as "phone relay: process was suspended for 974s". A healthy worker was killed
 * as hung every half hour; its replacement's startup timed out across the next sleep the same way, and after the
 * bounded attempts conch gave up on Kokoro and spoke with `say`.
 */

/** A tick that came back more than this past its period was not running: the Mac slept, or the loop was held. */
export const SUSPENDED_SLACK_MS = 5_000;
/** How often a pending deadline looks at the clock. It ticks only while something is pending. */
export const AWAKE_TICK_MS = 1_000;

/** The wake watch's rule, for a timer due every `periodMs` that took `gapMs` of wall-clock. */
export function wasSuspended(gapMs: number, periodMs: number): boolean {
  return gapMs > periodMs + SUSPENDED_SLACK_MS;
}

export interface AwakeTimeoutOptions {
  /**
   * Wall-clock, as the wake watch reads it: the clock that moves while the Mac sleeps, which is what makes a late
   * tick visible. A test seam.
   */
  now?: () => number;
  tickMs?: number;
}

/**
 * setTimeout for `ms` of time awake. It ticks at most every `tickMs`; a tick that fired on time counts what it was
 * armed for, and one that came back late (wasSuspended) counts nothing, so the work it guards gets its whole budget of
 * running time after a wake. A held loop counts nothing too, which is right: nothing could read an answer meanwhile.
 * Returns the canceller.
 */
export function awakeTimeout(fire: () => void, ms: number, options: AwakeTimeoutOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const tickMs = Math.max(1, options.tickMs ?? AWAKE_TICK_MS);
  let remaining = Math.max(1, Math.ceil(ms));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    const period = Math.min(remaining, tickMs);
    const armedAt = now();
    timer = setTimeout(() => {
      timer = null;
      if (!wasSuspended(now() - armedAt, period)) remaining -= period;
      if (remaining > 0) arm();
      else fire();
    }, period);
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

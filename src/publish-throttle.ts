export interface PublishThrottle {
  /** Publish immediately when the interval allows, otherwise coalesce at the trailing edge. */
  request(): void;
  /** Force the latest pending value out, for orderly shutdown. */
  flush(): boolean;
  /** Drop a pending trailing write. */
  cancel(): void;
  pending(): boolean;
}

export interface PublishThrottleOptions {
  intervalMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const DEFAULT_PUBLISH_INTERVAL_MS = 100;

/**
 * Leading/trailing throttle for an external snapshot writer.
 *
 * The callback deliberately receives no captured value: callers retain one
 * latest snapshot and the trailing edge reads that value when it actually
 * writes. A burst therefore cannot leave an intermediate state on disk.
 */
export function createPublishThrottle(
  publishLatest: () => void,
  options: PublishThrottleOptions = {},
): PublishThrottle {
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(1, Math.trunc(options.intervalMs!))
    : DEFAULT_PUBLISH_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, delayMs: number): unknown => {
    const timer = setTimeout(callback, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  });
  const clearTimer = options.clearTimer ?? ((timer: unknown): void => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  });

  let lastPublishedAt: number | null = null;
  let trailingTimer: unknown | null = null;
  let publishPending = false;

  const remainingDelay = (at: number): number => lastPublishedAt === null
    ? 0
    : Math.max(0, intervalMs - (at - lastPublishedAt));

  const run = (): void => {
    if (!publishPending) return;
    const at = now();
    const delay = remainingDelay(at);
    if (delay > 0) {
      trailingTimer = setTimer(() => {
        trailingTimer = null;
        run();
      }, delay);
      return;
    }

    publishPending = false;
    lastPublishedAt = at;
    publishLatest();
  };

  const request = (): void => {
    publishPending = true;
    if (trailingTimer !== null) return;
    run();
  };

  return {
    request,
    flush(): boolean {
      if (!publishPending) return false;
      if (trailingTimer !== null) {
        clearTimer(trailingTimer);
        trailingTimer = null;
      }
      publishPending = false;
      lastPublishedAt = now();
      publishLatest();
      return true;
    },
    cancel(): void {
      publishPending = false;
      if (trailingTimer === null) return;
      clearTimer(trailingTimer);
      trailingTimer = null;
    },
    pending: () => publishPending,
  };
}

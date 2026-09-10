import type { TurnEvent } from "./hook.ts";
import type { HandoffOrder } from "./settings.ts";
import { STATE_EVENT_TYPES } from "./session-ledger.ts";

const HANDOFF_URGENCY: Partial<Record<TurnEvent["type"], number>> = {
  working: 1,
  "turn-end": 2,
  "needs-you": 3,
};
const MODE_CONTROL_TYPES = new Set<TurnEvent["type"]>(["pause", "resume"]);
const NO_INSTANT_QUEUE_BARRIERS = { has: (_event: TurnEvent): boolean => false };

/**
 * Keep mode acknowledgements last as before, while an opt-in dashboard
 * takeover stays ahead of every ordinary command/state arrival that follows it.
 */
export function insertQueuedEvent(
  queue: TurnEvent[],
  event: TurnEvent,
  instantBarriers: { has(event: TurnEvent): boolean } = NO_INSTANT_QUEUE_BARRIERS,
): boolean {
  const instant = instantBarriers.has(event);
  const duplicateIndex = event.type === "inject" || (event.type === "speak" && !event.sessionId)
    ? -1
    : queue.findIndex(
      (queued) => queued.sessionId === event.sessionId && queued.type === event.type,
    );
  if (duplicateIndex !== -1) {
    const duplicate = queue[duplicateIndex]!;
    // An ordinary socket command cannot silently dislodge the dashboard
    // takeover that already interrupted the active exchange. A later instant
    // edge or mode/space cancellation removes that protection explicitly.
    if (instantBarriers.has(duplicate) && !instant) return false;
    queue.splice(duplicateIndex, 1);
  }

  if (MODE_CONTROL_TYPES.has(event.type)) {
    queue.push(event);
    return true;
  }

  const modeIndex = queue.findIndex((queued) => MODE_CONTROL_TYPES.has(queued.type));
  if (instant) {
    if (modeIndex === -1) queue.push(event);
    else queue.splice(modeIndex, 0, event);
    return true;
  }

  const barrierIndex = queue.findIndex(
    (queued) => MODE_CONTROL_TYPES.has(queued.type) || instantBarriers.has(queued),
  );
  if (barrierIndex === -1) queue.push(event);
  else queue.splice(barrierIndex, 0, event);
  return true;
}

/**
 * Remove the next queued session event without sorting the queue. Imperative
 * events are LIFO barriers: only the state-event cohort newer than the latest
 * command is reordered, preserving wake/speak/mode command semantics. Session
 * priority narrows that eligible cohort but can never reach below the barrier.
 */
export function takeNextQueuedEvent(
  queue: TurnEvent[],
  order: HandoffOrder,
  prioritized: ReadonlySet<string> = new Set(),
): TurnEvent | undefined {
  if (!queue.length) return undefined;

  let latestCommand = -1;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (!STATE_EVENT_TYPES.has(queue[i]!.type)) {
      latestCommand = i;
      break;
    }
  }
  const cohortStart = latestCommand + 1;
  if (cohortStart === queue.length) return queue.pop();

  const prioritizedIndices: number[] = [];
  if (prioritized.size) {
    for (let i = cohortStart; i < queue.length; i++) {
      if (prioritized.has(queue[i]!.sessionId)) prioritizedIndices.push(i);
    }
  }
  const candidates = prioritizedIndices.length
    ? prioritizedIndices
    : Array.from({ length: queue.length - cohortStart }, (_, index) => cohortStart + index);

  let selected = order === "newest"
    ? candidates[candidates.length - 1]!
    : candidates[0]!;
  if (order === "urgency") {
    for (const i of candidates.slice(1)) {
      const candidate = HANDOFF_URGENCY[queue[i]!.type] ?? 0;
      const current = HANDOFF_URGENCY[queue[selected]!.type] ?? 0;
      if (candidate >= current) selected = i; // equal urgency => newer arrival
    }
  }
  return queue.splice(selected, 1)[0];
}

export interface EventQueueOptions {
  handle(event: TurnEvent): Promise<void>;
  handoffOrder(): HandoffOrder;
  prioritized: ReadonlySet<string>;
  shuttingDown(): boolean;
  /** Called only at drain entry with pending work, never during an exchange. */
  consumeStopKey(): boolean;
  onError(event: TurnEvent, error: unknown): void;
  onIdle(): void;
  log(message: string): void;
  trace(message: string): void;
}

/** Serializes queued handlers and voice auditions; intake and audio stay in the daemon. */
export class EventQueue {
  readonly #options: EventQueueOptions;
  readonly #pending: TurnEvent[] = [];
  readonly #instantBarriers = new WeakSet<TurnEvent>();
  readonly #cancelled = new WeakSet<TurnEvent>();
  #busy = false;
  #busyLabel = "none";

  constructor(options: EventQueueOptions) {
    this.#options = options;
  }

  /** Read-only collection, mutable events: rename and ordering retain these identities. */
  get pending(): readonly TurnEvent[] {
    return this.#pending;
  }

  busy(): boolean {
    return this.#busy;
  }

  /** Starts draining synchronously; a submission while busy joins the existing drain. */
  submit(event: TurnEvent): Promise<void> {
    insertQueuedEvent(this.#pending, event, this.#instantBarriers);
    return this.#drain();
  }

  markInstantQueued(event: TurnEvent): void {
    this.#instantBarriers.add(event);
  }

  /** Retain the command's place but revoke its protection against replacement. */
  cancel(event: TurnEvent): void {
    this.#cancelled.add(event);
    this.#instantBarriers.delete(event);
  }

  /** The daemon consumes this at its existing handleTurn cancellation boundary. */
  consumeCancellation(event: TurnEvent): boolean {
    return this.#cancelled.delete(event);
  }

  removePending(matches: (event: TurnEvent) => boolean): void {
    for (let index = this.#pending.length - 1; index >= 0; index--) {
      if (matches(this.#pending[index]!)) this.#pending.splice(index, 1);
    }
  }

  clear(): void {
    this.#pending.length = 0;
  }

  /** Auditions acquire the same flag before their first await and restart on release. */
  async exclusive(operation: () => Promise<void>): Promise<boolean> {
    if (this.#busy) return false;
    this.#busy = true;
    try {
      await operation();
      return true;
    } finally {
      this.#busy = false;
      this.#options.onIdle();
      void this.#drain();
    }
  }

  #takeNext(): TurnEvent {
    return takeNextQueuedEvent(
      this.#pending,
      this.#options.handoffOrder(),
      this.#options.prioritized,
    )!;
  }

  async #drain(): Promise<void> {
    this.#options.trace(this.#busy
      ? `blocked behind "${this.#busyLabel}" (${this.#pending.length} waiting)`
      : `drain start (${this.#pending.length})`);
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (this.#options.shuttingDown()) return;
      if (this.#pending.length && this.#options.consumeStopKey()) {
        const skipped = this.#takeNext();
        this.#options.log(`⏹ spacebar — skipped queued ${skipped.type} for "${skipped.label}" during TTS startup`);
      }
      while (this.#pending.length) {
        const event = this.#takeNext();
        try {
          this.#busyLabel = `${event.type}:${event.label}`;
          this.#options.trace(`handle ${this.#busyLabel}`);
          await this.#options.handle(event);
          this.#options.trace(`done ${this.#busyLabel}`);
        } catch (error) {
          // One bad event must not strand the rest of the queue.
          this.#options.onError(event, error);
        }
      }
    } finally {
      this.#busy = false;
      this.#options.onIdle();
    }
  }
}

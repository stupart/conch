/**
 * One voice across two Macs (C9b Cut B): who makes THIS daemon's sound.
 *
 * `AudioSinkLease` is a local sink selector with two hardcoded values and no
 * identity. A second Mac needs what that lease cannot give: an identified
 * holder, a revision so a stale claim loses, and an expiry so a holder whose
 * app quit cannot mute this Mac forever. This module owns that record and the
 * one acceptance rule; the daemon owns the effects (the stop sequence, the
 * outbox, publication).
 */

export interface AudioControl {
  /** "local" = this Mac speaks and listens; otherwise the ownerDeviceId that does. */
  holder: string;
  /** Bumped by take and release. Expiry does NOT bump it. */
  revision: number;
  /** Only while yielded. */
  expiresAt: number | null;
}

export type AudioYieldVerdict = "grant" | "renew" | "stale";

export type AudioYieldOutcome =
  | { kind: "grant" | "renew"; record: AudioControl }
  | { kind: "stale"; revision: number };

export const AUDIO_LEASE_MIN_MS = 1_000;
export const AUDIO_LEASE_MAX_MS = 600_000;

export class AudioHolder {
  #holder = "local";
  #revision = 0;
  #expiresAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** The published record. Reading it applies expiry (named simplification #1: back to local, revision unchanged). */
  get record(): AudioControl {
    this.#expire();
    return { holder: this.#holder, revision: this.#revision, expiresAt: this.#expiresAt };
  }

  get holder(): string {
    return this.record.holder;
  }

  isLocal(): boolean {
    return this.holder === "local";
  }

  /** This Mac's own app takes its audio back: bump, local. */
  take(): AudioControl {
    return this.#reclaim();
  }

  /** The holder's app hands it back: bump, local. */
  release(): AudioControl {
    return this.#reclaim();
  }

  /**
   * The one acceptance rule (F8), without side effects — the daemon runs the
   * stop sequence between the verdict and `yield` so the record flips in the
   * same tick as the cancels (F5).
   */
  assess(holder: string, revision: number): AudioYieldVerdict {
    this.#expire();
    if (!holder || holder === "local") return "stale";
    if (revision > this.#revision) return "grant";
    if (revision === this.#revision) {
      // Expiry already returned it to local and the same holder renews: a
      // re-yield, with the stop sequence and a fresh lease (F8, F10).
      if (this.#holder === "local") return "grant";
      if (this.#holder === holder) return "renew";
    }
    return "stale";
  }

  yield(holder: string, revision: number, leaseMs: number): AudioYieldOutcome {
    const verdict = this.assess(holder, revision);
    if (verdict === "stale") return { kind: "stale", revision: this.#revision };
    const lease = Math.min(AUDIO_LEASE_MAX_MS, Math.max(AUDIO_LEASE_MIN_MS, leaseMs));
    this.#holder = holder;
    this.#revision = revision;
    this.#expiresAt = this.now() + lease;
    return { kind: verdict, record: this.record };
  }

  #reclaim(): AudioControl {
    this.#holder = "local";
    this.#expiresAt = null;
    this.#revision += 1;
    return this.record;
  }

  #expire(): void {
    if (this.#expiresAt !== null && this.now() >= this.#expiresAt) {
      this.#holder = "local";
      this.#expiresAt = null;
    }
  }
}

/** The speech gate: sound is made HERE only while this Mac holds its own audio and no phone has claimed it. */
export function speechAllowedHere(holder: string, sink: "mac" | "phone"): boolean {
  return holder === "local" && sink !== "phone";
}

/**
 * The owner this daemon's announcements are presented on, or null when they
 * sound here — or on the phone, which wins on its own daemon (F2).
 */
export function presentedTo(holder: string, sink: "mac" | "phone"): string | null {
  return sink === "phone" || holder === "local" ? null : holder;
}

export interface AudioOutboxItem {
  seq: number;
  text: string;
  voice: string;
  label: string;
  session: { ownerDeviceId: string; localSessionKey: string };
  at: number;
}

export const AUDIO_OUTBOX_MAX = 20;

/** What a yielded daemon could not say itself, for the holder's app to carry over. */
export class AudioOutbox {
  #items: AudioOutboxItem[] = [];
  #seq: number;

  /** Seeded from the clock so a restart never re-issues a used sequence (F9). */
  constructor(seed: number = Date.now()) {
    this.#seq = seed;
  }

  push(item: Omit<AudioOutboxItem, "seq" | "at">, at: number = Date.now()): AudioOutboxItem {
    const entry: AudioOutboxItem = { ...item, seq: ++this.#seq, at };
    this.#items.push(entry);
    if (this.#items.length > AUDIO_OUTBOX_MAX) this.#items.splice(0, this.#items.length - AUDIO_OUTBOX_MAX);
    return entry;
  }

  get items(): AudioOutboxItem[] {
    return [...this.#items];
  }
}

export type PresentedAdmission = "admit" | "seen" | "stale";

/**
 * At-most-once admission for items presented on this Mac (F4, F12): an item
 * older than this daemon's start is never replayed, and a sequence is recorded
 * only when the item was actually enqueued — the daemon calls `record` itself.
 */
export class PresentedItems {
  #seen = new Set<string>();

  constructor(private readonly startedAt: number) {}

  check(source: string, seq: number, at: number): PresentedAdmission {
    if (at < this.startedAt) return "stale";
    return this.#seen.has(`${source}:${seq}`) ? "seen" : "admit";
  }

  record(source: string, seq: number): void {
    this.#seen.add(`${source}:${seq}`);
    // ponytail: a Set keeps insertion order, so trimming the front drops the oldest.
    if (this.#seen.size > 1_000) this.#seen.delete(this.#seen.values().next().value!);
  }
}

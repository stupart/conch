import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import type { StartSessionRequest } from "./session-lifecycle.ts";

/**
 * Sessions come back after the Mac restarts.
 *
 * A session in a Terminal window dies with the Mac: shut down, restart, a forced power-off. Its conversation is on
 * disk and conch knew how it was launched, but nothing remembered it was running, so after the 2026-10-26 restart
 * the user found half their sessions gone and had to find and resume each by hand. Background sessions already came
 * back (`background-recovery.ts`, which watches their tmux server); this is everything else conch can restart.
 *
 * conch keeps a ledger of every session it sees running that it could start again — its conversation and exactly
 * how it was launched, read from its live command line as conch's own Restart reads it — and keeps it current on
 * every complete registry read:
 *
 *  - a session conch watches disappear while the Mac stays up was closed (`/exit`, a closed window, Ctrl-D): it is
 *    forgotten, but only once it has stayed gone for `GONE_GRACE_MS`. During a shutdown Terminal can quit a moment
 *    before conch does, and a session that went that way is the shutdown's, not the person's;
 *  - after the Mac restarts, everything still in the ledger was running when conch last looked. When conch watched
 *    to the end — the Mac told the app it was powering off (`system-power-off`), or conch never stopped cleanly
 *    and so went down with the Mac — each comes back, as a background session. When conch had been quit before the
 *    restart, something may have closed after it stopped looking, so they are offered instead of started.
 *
 * Never a session already running somewhere, never one conch has brought back `RESTORE_TRIES` times in a day.
 */

/** A session conch saw running, and how to start it again. */
export interface RunningRecord {
  conversationId: string;
  label: string;
  backend: string;
  /** How to start it again: a background session resuming `conversationId`. */
  request: StartSessionRequest;
  /** Epoch ms it was last seen running. */
  seenAt: number;
  /** Epoch ms conch first saw it gone while still watching; forgotten once gone for `GONE_GRACE_MS`. */
  goneAt?: number;
}

export interface RestartLedger {
  /** The boot these records were taken under, in epoch seconds (`bootTime`). */
  boot: number;
  /** Epoch ms of conch's last complete look. */
  heartbeat: number;
  /** Epoch ms the daemon stopped cleanly. Absent while it runs, and when it went down with the Mac. */
  stoppedAt?: number;
  /** Epoch ms the Mac said it was logging out, restarting or shutting down. */
  poweringOffAt?: number;
  records: RunningRecord[];
  /** Restores by conversation, epoch ms: at most `RESTORE_TRIES` a day. */
  attempts: Record<string, number[]>;
  /** Held for the person to bring back: a restart conch did not watch to the end. */
  offered: RunningRecord[];
}

/** How long a session must stay gone, while conch watches, before it counts as closed. */
export const GONE_GRACE_MS = 2 * 60_000;
/** A power-off this much older than conch's last look did not happen: someone cancelled it. */
export const POWER_OFF_WINDOW_MS = 10 * 60_000;
/** Two readings of one boot time differ by rounding; a restart moves it by far more. */
const BOOT_SLACK_S = 90;
export const RESTORE_TRIES = 3;
const RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When this boot began, in epoch seconds. */
export function bootTime(now = Date.now(), up = uptime()): number {
  return Math.round(now / 1000 - up);
}

export function sameBoot(a: number, b: number): boolean {
  return Math.abs(a - b) <= BOOT_SLACK_S;
}

export function emptyLedger(boot: number, now: number): RestartLedger {
  return { boot, heartbeat: now, records: [], attempts: {}, offered: [] };
}

/** Whether conch was looking when the Mac went down: what lets it restart sessions without asking. */
export function watchedToTheEnd(ledger: Pick<RestartLedger, "heartbeat" | "stoppedAt" | "poweringOffAt">): boolean {
  if (ledger.poweringOffAt !== undefined && ledger.heartbeat - ledger.poweringOffAt < POWER_OFF_WINDOW_MS) return true;
  return ledger.stoppedAt === undefined;
}

export interface RestartPlan {
  resume: RunningRecord[];
  offer: RunningRecord[];
  skipped: Array<{ record: RunningRecord; why: string }>;
}

/** What to do with a ledger taken under an earlier boot. */
export function planAfterRestart(input: {
  ledger: RestartLedger;
  /** Every conversation running now, anywhere. */
  liveConversations: ReadonlySet<string>;
  now: number;
}): RestartPlan {
  const plan: RestartPlan = { resume: [], offer: [], skipped: [] };
  const watched = watchedToTheEnd(input.ledger);
  for (const record of input.ledger.records) {
    // Gone long enough before the end to have been closed, whatever came after.
    if (record.goneAt !== undefined && input.ledger.heartbeat - record.goneAt >= GONE_GRACE_MS) {
      plan.skipped.push({ record, why: "it was closed before the restart" });
      continue;
    }
    if (input.liveConversations.has(record.conversationId)) {
      plan.skipped.push({ record, why: "it is running already" });
      continue;
    }
    const recent = (input.ledger.attempts[record.conversationId] ?? []).filter((at) => input.now - at < RESTORE_WINDOW_MS);
    if (recent.length >= RESTORE_TRIES) {
      plan.skipped.push({ record, why: `already brought back ${recent.length} times today` });
      continue;
    }
    (watched ? plan.resume : plan.offer).push(record);
  }
  return plan;
}

/** A running session, as much of it as the ledger reads. */
export interface RunningSession {
  sessionId: string;
  agentSessionId?: string;
  label?: string;
  backend?: string;
}

export interface RestartGuardOptions {
  file: string;
  /** How to start it again (`restartRequest` over its live command line); null when it can't be read. */
  relaunchFor(session: RunningSession): Promise<StartSessionRequest | null>;
  launch(request: StartSessionRequest): Promise<unknown>;
  log(message: string): void;
  /** Something the person should hear about changed: what came back, what is offered. */
  changed?(): void;
  now?(): number;
  boot?(): number;
}

export class RestartGuard {
  readonly #options: RestartGuardOptions;
  #ledger: RestartLedger;
  /** The ledger as the daemon found it at start, until the first complete read has decided what it means. */
  #previous: RestartLedger | null;
  #restored: Array<{ conversationId: string; label: string }> = [];
  #running: Promise<void> | null = null;
  #savedAt = 0;

  constructor(options: RestartGuardOptions) {
    this.#options = options;
    const now = options.now?.() ?? Date.now();
    const boot = options.boot?.() ?? bootTime(now);
    let stored: RestartLedger | null = null;
    try { stored = normalize(JSON.parse(readFileSync(options.file, "utf8"))); } catch {}
    this.#previous = stored;
    this.#ledger = stored && sameBoot(stored.boot, boot)
      // The same boot: the daemon restarted under a Mac that kept running. What it knew still stands.
      ? { ...stored, stoppedAt: undefined }
      : { ...emptyLedger(boot, now), attempts: stored?.attempts ?? {}, offered: stored?.offered ?? [] };
  }

  /** What came back after the last restart, and what is held for the person to bring back. */
  summary(): { restored: Array<{ conversationId: string; label: string }>; offered: Array<{ conversationId: string; label: string }> } {
    return {
      restored: [...this.#restored],
      offered: this.#ledger.offered.map(({ conversationId, label }) => ({ conversationId, label })),
    };
  }

  /** The Mac said it is going down: from here, a session that disappears is the shutdown's doing. */
  poweringOff(): void {
    const now = this.#options.now?.() ?? Date.now();
    this.#ledger.poweringOffAt = now;
    this.#save(true);
    this.#options.log(`the Mac is powering off — ${this.#ledger.records.length} running session(s) will come back after it starts`);
  }

  /** A clean stop: conch isn't looking any more, so a restart after this can't be read as the sessions' end. */
  stopped(): void {
    this.#ledger.stoppedAt = this.#options.now?.() ?? Date.now();
    this.#save(true);
  }

  /** Bring back what was offered, or let it go. */
  async settleOffer(accept: boolean): Promise<number> {
    const offered = this.#ledger.offered;
    this.#ledger.offered = [];
    this.#save(true);
    if (accept) for (const record of offered) await this.#resume(record);
    this.#options.changed?.();
    return offered.length;
  }

  dismissRestored(): void {
    this.#restored = [];
    this.#options.changed?.();
  }

  /**
   * After a COMPLETE registry read: what runs now that conch could restart (not a background session, which its
   * own guard watches), and every conversation running anywhere.
   */
  observe(sessions: readonly RunningSession[], liveConversations: ReadonlySet<string>): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#observe(sessions, liveConversations).finally(() => { this.#running = null; });
    return this.#running;
  }

  async #observe(sessions: readonly RunningSession[], liveConversations: ReadonlySet<string>): Promise<void> {
    const now = this.#options.now?.() ?? Date.now();
    let changed = false;

    // The first look since the daemon started decides what a ledger from an earlier boot means.
    const previous = this.#previous;
    this.#previous = null;
    if (previous && !sameBoot(previous.boot, this.#ledger.boot) && previous.records.length) {
      const plan = planAfterRestart({ ledger: previous, liveConversations, now });
      for (const { record, why } of plan.skipped) this.#options.log(`not bringing back "${record.label}" after the restart: ${why}`);
      if (plan.offer.length) {
        this.#ledger.offered = [...this.#ledger.offered.filter((held) => !plan.offer.some((record) => record.conversationId === held.conversationId)), ...plan.offer];
        this.#options.log(`${plan.offer.length} session(s) were running before the restart, when conch wasn't watching — offered, not started`);
      }
      for (const record of plan.resume) await this.#resume(record);
      changed = true;
    }

    // What runs now.
    const live = new Set<string>();
    for (const session of sessions) {
      const conversationId = session.agentSessionId ?? session.sessionId;
      live.add(conversationId);
      const known = this.#ledger.records.find((record) => record.conversationId === conversationId);
      if (known) {
        if (known.goneAt !== undefined || (session.label && session.label !== known.label)) changed = true;
        known.goneAt = undefined;
        known.seenAt = now;
        known.label = session.label ?? known.label;
        continue;
      }
      const request = await this.#options.relaunchFor(session).catch(() => null);
      if (!request) continue;
      this.#ledger.records.push({
        conversationId,
        label: session.label ?? conversationId,
        backend: session.backend ?? "claude",
        request: { ...request, host: "background", resumeSessionId: conversationId },
        seenAt: now,
      });
      // Running again by itself: no longer anything to offer.
      this.#ledger.offered = this.#ledger.offered.filter((held) => held.conversationId !== conversationId);
      changed = true;
    }

    // What has gone. Not while the Mac is going down: that is the shutdown, and what it ends comes back.
    const poweringOff = this.#ledger.poweringOffAt !== undefined && now - this.#ledger.poweringOffAt < POWER_OFF_WINDOW_MS;
    if (!poweringOff && this.#ledger.poweringOffAt !== undefined) {
      // A power-off that didn't happen: someone cancelled it, and conch kept running.
      this.#ledger.poweringOffAt = undefined;
      changed = true;
    }
    if (!poweringOff) {
      this.#ledger.records = this.#ledger.records.filter((record) => {
        if (live.has(record.conversationId)) return true;
        if (record.goneAt === undefined) {
          record.goneAt = now;
          changed = true;
          return true;
        }
        if (now - record.goneAt < GONE_GRACE_MS) return true;
        changed = true;
        return false;
      });
    }
    this.#ledger.heartbeat = now;
    this.#save(changed);
  }

  async #resume(record: RunningRecord): Promise<void> {
    const now = this.#options.now?.() ?? Date.now();
    this.#ledger.attempts[record.conversationId] = [
      ...(this.#ledger.attempts[record.conversationId] ?? []).filter((at) => now - at < RESTORE_WINDOW_MS),
      now,
    ];
    try {
      // It already ran in this folder: its trust was given then.
      await this.#options.launch({ ...record.request, host: "background", resumeSessionId: record.conversationId, trustFolder: true });
      this.#restored.push({ conversationId: record.conversationId, label: record.label });
      this.#options.log(`brought back "${record.label}" after the restart, as a background session`);
    } catch (error) {
      this.#options.log(`could not bring back "${record.label}" after the restart: ${(error as Error).message}`);
    }
    this.#options.changed?.();
  }

  /** Written when something changed, and otherwise every half minute: the heartbeat is what dates the end. */
  #save(changed: boolean): void {
    const now = this.#options.now?.() ?? Date.now();
    if (!changed && now - this.#savedAt < 30_000) return;
    this.#savedAt = now;
    try {
      mkdirSync(dirname(this.#options.file), { recursive: true });
      const temp = `${this.#options.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(this.#ledger, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, this.#options.file);
    } catch {}
  }
}

function normalize(value: unknown): RestartLedger | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<RestartLedger>;
  if (typeof raw.boot !== "number" || typeof raw.heartbeat !== "number") return null;
  const records = (Array.isArray(raw.records) ? raw.records : []).filter((record): record is RunningRecord =>
    Boolean(record) && typeof record.conversationId === "string" && typeof record.request === "object" && record.request !== null);
  const offered = (Array.isArray(raw.offered) ? raw.offered : []).filter((record): record is RunningRecord =>
    Boolean(record) && typeof record.conversationId === "string" && typeof record.request === "object" && record.request !== null);
  const attempts: Record<string, number[]> = {};
  for (const [id, times] of Object.entries(raw.attempts ?? {})) {
    if (Array.isArray(times)) attempts[id] = times.filter((at) => typeof at === "number");
  }
  return {
    boot: raw.boot,
    heartbeat: raw.heartbeat,
    ...(typeof raw.stoppedAt === "number" ? { stoppedAt: raw.stoppedAt } : {}),
    ...(typeof raw.poweringOffAt === "number" ? { poweringOffAt: raw.poweringOffAt } : {}),
    records,
    attempts,
    offered,
  };
}

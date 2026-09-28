/**
 * How conch's natural voices heal themselves: the rules, as pure functions. voice-env.ts observes (the probe, the disk,
 * the network, the worker) and acts (build, fetch, hand the worker its Python); this decides what to do next and what
 * to say while it does.
 *
 * Tyler, 2026-09-28: "Please add the visible thing but also it should 'just work'." The voices had silently fallen
 * back to macOS `say` for weeks. Every way they can end up there now either heals by itself or says why it can't:
 *
 *   - offline, or a slow connection: never counted; it waits for the network and carries on when it's back, keeping
 *     what it already fetched (uv's wheel cache, Hugging Face's partial files);
 *   - out of room: never counted; it waits, says so, and carries on when there's room;
 *   - killed or cut short (a half-finished build): never counted; cleaned up and started again;
 *   - a limit of this Mac (Intel, no Metal device, a macOS too old for MLX): said once, plainly, never looped;
 *   - anything else: three quick attempts (now, a minute later, five minutes later), then cool-downs of 1, 2 and 4 hours,
 *     so a truly broken setup isn't hammered and a fixable one is never left until tomorrow. The count starts over on an
 *     update (conch, its lock, its uv, or macOS), when the network comes back, when the disk frees up, and on Try again.
 */

// MARK: - What went wrong

export type VoiceFailureKind =
  /** The network: waits for it to come back. Never counted. */
  | "offline"
  /** The disk: waits for room. Never counted. */
  | "no-space"
  /** Killed, cancelled, or left half done: cleaned up and started again. Never counted. */
  | "interrupted"
  /** A limit of this Mac: said once, never retried in this run. */
  | "unsupported"
  /** MLX or Metal failed at work: retried, the environment rebuilt once, then counted. */
  | "gpu"
  /** The environment itself: a package missing, a library that no longer loads, an interpreter gone. Rebuilt. */
  | "env"
  /** Kokoro's model files: verified, and only what's broken fetched again. */
  | "model"
  | "other";

const NO_SPACE = /\bENOSPC\b|no space left|os error 28|not enough free space|disk quota exceeded|\bEDQUOT\b/i;
const OFFLINE = new RegExp(
  [
    // Word-bounded: "ModuleNotFoundError" holds "eNotFound".
    "\\bENOTFOUND\\b", "\\bEAI_AGAIN\\b", "\\bECONNREFUSED\\b", "\\bECONNRESET\\b", "\\bENETUNREACH\\b", "\\bEHOSTUNREACH\\b", "\\bETIMEDOUT\\b",
    "unable to connect", "network is unreachable", "network unreachable", "socket connection was closed", "\\bstalled\\b", "fetch failed",
    // uv (reqwest)
    "failed to fetch", "failed to download", "error sending request", "dns error", "failed to lookup address", "nodename nor servname",
    "tcp connect error", "connection refused", "connection reset", "client error \\(connect\\)", "operation timed out",
    "request failed after \\d+ retries", "could not connect", "couldn't connect",
    // Python (urllib3, requests, huggingface_hub)
    "name resolution", "max retries exceeded", "ConnectionError", "ProxyError", "LocalEntryNotFoundError",
    "outgoing traffic has been disabled", "offline mode", "connect timeout", "read timed out",
  ].join("|"),
  "i",
);
const UNSUPPORTED = new RegExp(
  [
    "needs Apple silicon", "Failed to load device", "No Metal device", "Metal is not supported", "MTLCreateSystemDefaultDevice",
    "doesn't have a source distribution or wheel for the current platform", "not a supported wheel on this platform",
    "no wheels? (?:with|for) a matching platform tag", "unsupported macOS",
  ].join("|"),
  "i",
);
const ENV = new RegExp(
  [
    "Library not loaded", "dlopen\\(", "image not found", "Symbol not found", "incompatible architecture", "mach-o",
    "code signature", "bad interpreter", "exec format error", "probe could not start", "is off the lock", "cannot import Kokoro",
    "runs Python \\d", "is not set up yet", "ModuleNotFoundError", "ImportError", "Model type \\w+ not supported",
    "no voice environment",
  ].join("|"),
  "i",
);
const MODEL = new RegExp(
  [
    // Only what Kokoro's own files say when they are damaged: a wheel's "hash mismatch" is the build's, not the model's.
    "safetensor", "deserializ", "HeaderTooLarge", "incomplete metadata", "EntryNotFound", "RepositoryNotFound", "config\\.json",
    "JSONDecodeError", "invalid load key", "voice file", "snapshots/", "huggingface/hub",
  ].join("|"),
  "i",
);
const GPU = /\[metal|metal::|\bMetal\b|kIOGPU|MTLCommandBuffer|command buffer|\bGPU\b|\bmlx\b.*(?:error|failed)/i;
const INTERRUPTED = /\bcancelled\b|\bcanceled\b|exit killed|was interrupted|timed out after \d+ min|\bSIGKILL\b|\bSIGTERM\b/i;

/** What kind of failure a message is, by its words. Order matters: a full disk or no network explains everything after. */
export function classifyVoiceFailure(text: string): VoiceFailureKind {
  if (NO_SPACE.test(text)) return "no-space";
  if (OFFLINE.test(text)) return "offline";
  if (UNSUPPORTED.test(text)) return "unsupported";
  if (ENV.test(text)) return "env";
  if (MODEL.test(text)) return "model";
  if (GPU.test(text)) return "gpu";
  if (INTERRUPTED.test(text)) return "interrupted";
  return "other";
}

/** The limit, in the words the status and the app use: "needs Apple silicon", "needs a newer macOS", "no Metal GPU". */
export function unsupportedReason(text: string): string {
  if (/needs Apple silicon/i.test(text)) return "needs Apple silicon";
  if (/wheel|platform tag|source distribution|macOS/i.test(text)) return "needs a newer macOS";
  return "no Metal GPU";
}

/** Only failures that retrying could fix, and that aren't the network's or the disk's, count against the attempts. */
export function countsAgainstBudget(kind: VoiceFailureKind): boolean {
  return kind === "gpu" || kind === "env" || kind === "model" || kind === "other";
}

// MARK: - The attempts

/** After the first and the second counted failure: a minute, then five. The third says so and cools down. */
export const VOICE_HEAL_QUICK_RETRY_MS: readonly number[] = [60_000, 5 * 60_000];
export const VOICE_HEAL_MAX_QUICK = 3;
/** After the quick attempts: one more try an hour later, then two, then every four. Never "until tomorrow". */
export const VOICE_HEAL_COOLDOWNS_MS: readonly number[] = [60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000];
/** A disk that gained this much since the last counted failure starts the count over… */
export const VOICE_HEAL_FREED_BYTES = 1_000_000_000;
/**
 * …when it was tight then. On a disk with room to spare the free space swings by gigabytes with whatever else is running
 * (the first e2e run, on a Mac building other things, reset the count that way), and a failure there wasn't the disk's.
 */
export const VOICE_HEAL_TIGHT_DISK_BYTES = 5_000_000_000;
/** After a build ran out of room: it tries again once the disk has this much more than it had then. */
export const VOICE_HEAL_NO_SPACE_MARGIN_BYTES = 256_000_000;
/** …or after this long, in case the disk was only briefly full. */
export const VOICE_HEAL_NO_SPACE_BACKSTOP_MS = 60 * 60_000;
/** Failed worker start bursts (each is the worker's own four attempts) before the environment is rebuilt for it. */
export const VOICE_WORKER_BURSTS = 3;

export interface VoiceHealBudget {
  /** Which conch, lock, uv and macOS these were counted against: any change starts over. */
  epoch: string;
  count: number;
  lastError: string;
  kind: VoiceFailureKind;
  at: number;
  /** Not before: a quick retry's delay, or the cool-down after them. */
  nextAt: number;
  /** Cool-downs taken since the quick attempts ran out. */
  cooldowns: number;
  /** Free bytes when this was counted, so a disk that frees up starts over. */
  free: number | null;
}

export function countFailure(
  budget: VoiceHealBudget | null,
  failure: { error: string; kind: VoiceFailureKind; now: number; epoch: string; free: number | null },
): VoiceHealBudget {
  const fresh = !budget || budget.epoch !== failure.epoch;
  const count = (fresh ? 0 : budget.count) + 1;
  const cooldowns = fresh ? 0 : budget.cooldowns;
  const quick = count < VOICE_HEAL_MAX_QUICK;
  const delay = quick
    ? VOICE_HEAL_QUICK_RETRY_MS[count - 1] ?? VOICE_HEAL_QUICK_RETRY_MS.at(-1)!
    : VOICE_HEAL_COOLDOWNS_MS[Math.min(cooldowns, VOICE_HEAL_COOLDOWNS_MS.length - 1)]!;
  return {
    epoch: failure.epoch,
    count,
    lastError: failure.error,
    kind: failure.kind,
    at: failure.now,
    nextAt: failure.now + delay,
    cooldowns: quick ? cooldowns : cooldowns + 1,
    free: failure.free,
  };
}

/** The quick attempts ran out: the app says so, once, and it cools down. */
export function budgetExhausted(budget: VoiceHealBudget | null): boolean {
  return Boolean(budget && budget.count >= VOICE_HEAL_MAX_QUICK);
}

/** The disk was tight when the last failure was counted, and has gained a gigabyte since. */
export function diskFreedSince(budget: VoiceHealBudget | null, free: number | null): boolean {
  if (!budget || budget.free === null || free === null) return false;
  return budget.free < VOICE_HEAL_TIGHT_DISK_BYTES && free - budget.free >= VOICE_HEAL_FREED_BYTES;
}

/** Why the count starts over now, or null. Each is a reason a failure that was counted may no longer hold. */
export function budgetReset(
  budget: VoiceHealBudget | null,
  seen: { epoch: string; free: number | null; networkReturned?: boolean; tryAgain?: boolean },
): string | null {
  if (!budget) return null;
  if (seen.tryAgain) return "Try again";
  if (budget.epoch !== seen.epoch) return "conch, its uv or macOS changed";
  if (seen.networkReturned) return "the network came back";
  if (diskFreedSince(budget, seen.free)) return "the disk has more room";
  return null;
}

/** Which conch, lock, uv and macOS: the budget's epoch. */
export function voiceHealEpoch(parts: { lock: string; conch: string; uv: string; macos: string }): string {
  return `${parts.lock}|${parts.conch}|${parts.uv}|${parts.macos}`;
}

// MARK: - The decision

export interface VoiceWorkerTrouble {
  kind: VoiceFailureKind;
  error: string;
  /** Failed start bursts in a row. */
  bursts: number;
  /** The environment was rebuilt for this trouble already. */
  rebuilt: boolean;
  /** Counted and set aside: the worker has no interpreter until the next attempt. */
  parked: boolean;
}

export interface VoiceHealObservation {
  now: number;
  /** Natural voices have worked on this Mac before: healing says "coming back", not "setting up". */
  everReady: boolean;
  /** A legacy mlx-audio install speaks meanwhile (so the status says so, rather than `say`). */
  legacy: boolean;
  /** A limit of this Mac found along the way, in plain words. */
  unsupported: string | null;
  uv: boolean;
  heldElsewhere: number | null;
  env: { ok: true } | { ok: false; reason: string };
  model: "ok" | "missing";
  worker: VoiceWorkerTrouble | null;
  /** macOS or the interpreter changed under the environment since it was built: a failing worker rebuilds at once. */
  suspect: boolean;
  /** The last attempt's failure, while it stands. */
  last: { kind: VoiceFailureKind; error: string; at: number } | null;
  network: "online" | "offline" | "unknown";
  free: number | null;
  needs: number;
  /** What the disk had once a no-space failure was cleaned up. */
  freeAfterNoSpace: number | null;
  budget: VoiceHealBudget | null;
}

export type VoiceHealNeed = "build" | "fetch-model" | "park-worker" | "retry-worker";

export type VoiceHealAction =
  | { kind: "adopt" }
  | { kind: "build" }
  | { kind: "fetch-model" }
  | { kind: "park-worker" }
  | { kind: "retry-worker" }
  /** A quick retry's wait: short, in line. */
  | { kind: "delay"; until: number }
  /** Nothing to do until something changes: watched on a timer, never in line. */
  | { kind: "rest"; for: "network" | "space" | "elsewhere" | "uv" | "cooldown" | "unsupported"; until?: number };

/** What the published status says, before the doer adds its step and percent. */
export interface VoiceHealStatus {
  state: "checking" | "setting-up" | "ready" | "off";
  reason?: string;
  detail: string;
  healing?: "first-run" | "repair";
  waiting?: "network" | "space" | "retry";
  retryAt?: number;
  off?: "choice" | "unsupported" | "failed";
  problem?: VoiceFailureKind;
  space?: { needs: number; free: number };
  stage?: "prefetch" | "elsewhere";
}

export interface VoiceHealDecision {
  need: VoiceHealNeed | null;
  action: VoiceHealAction;
  status: VoiceHealStatus;
}

/** "1.7 GB", "900 MB": the way Finder writes them. */
export function gigabytes(bytes: number): string {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`;
}

function clock(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function inMinutes(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}

/** What is wrong, first to last: the environment, then the model, then a worker that keeps failing on both. */
export function voiceHealNeed(o: Pick<VoiceHealObservation, "env" | "model" | "worker" | "suspect">): VoiceHealNeed | null {
  const worker = o.worker;
  if (!o.env.ok) return "build";
  if (worker?.kind === "env" && !worker.rebuilt) return "build";
  if (o.model === "missing") return "fetch-model";
  if (!worker) return null;
  if (worker.parked) return "retry-worker";
  const enough = worker.bursts >= VOICE_WORKER_BURSTS || (o.suspect && worker.bursts >= 1);
  if (!enough) return null;
  return worker.rebuilt ? "park-worker" : "build";
}

/**
 * The next thing to do, and what to say. Pure: every input is observed by voice-env.ts, and every rule about when to
 * wait, when to try, when to say it failed and when to try again anyway is here, where it is tested.
 */
export function decideVoiceHeal(o: VoiceHealObservation): VoiceHealDecision {
  const healing = o.everReady ? "repair" as const : "first-run" as const;
  const meanwhile = o.legacy ? "using your mlx-audio install until it is ready" : "speaking with macOS say until it is ready";
  if (o.unsupported) {
    return {
      need: null,
      action: { kind: "rest", for: "unsupported" },
      status: {
        state: "off",
        off: "unsupported",
        reason: o.unsupported,
        problem: "unsupported",
        detail: `natural voices can't run on this Mac (${o.unsupported}) — voices via say`,
      },
    };
  }

  const need = voiceHealNeed(o);
  if (need === null) {
    if (o.worker) {
      // The environment and the model check out and the worker is still retrying on its own: say so, quietly.
      return {
        need,
        action: { kind: "adopt" },
        status: {
          state: "setting-up",
          healing: "repair",
          problem: o.worker.kind,
          detail: `the voice worker is restarting (${o.worker.error}) — ${meanwhile}`,
        },
      };
    }
    return { need, action: { kind: "adopt" }, status: { state: "ready", detail: "ready" } };
  }
  if (need === "park-worker") {
    return {
      need,
      action: { kind: "park-worker" },
      status: { state: "setting-up", healing: "repair", problem: o.worker?.kind, detail: `the voice worker keeps failing — ${meanwhile}` },
    };
  }

  // The voices' own download keeps its stage while it waits, so setup's tray still says what is downloading.
  const settingUp = (detail: string, extra: Partial<VoiceHealStatus> = {}): VoiceHealStatus => ({
    state: "setting-up",
    healing,
    detail,
    ...(need === "fetch-model" ? { stage: "prefetch" as const } : {}),
    ...extra,
  });

  if (need === "build" && !o.uv) {
    return {
      need,
      action: { kind: "rest", for: "uv" },
      status: {
        state: "off",
        off: "failed",
        reason: "no uv",
        problem: "other",
        detail: "no uv to build it with — install the conch app (it carries one), or set CONCH_UV",
      },
    };
  }
  if (o.heldElsewhere !== null && need !== "retry-worker") {
    return {
      need,
      action: { kind: "rest", for: "elsewhere" },
      status: settingUp(`being set up by another conch process (pid ${o.heldElsewhere}) — ${meanwhile}`, { stage: "elsewhere" }),
    };
  }
  if (o.last?.kind === "offline" && o.network !== "online") {
    return {
      need,
      action: { kind: "rest", for: "network" },
      status: settingUp(`waiting for the network — it carries on by itself when this Mac is back online; ${meanwhile}`, {
        waiting: "network",
        problem: "offline",
      }),
    };
  }
  if (need === "build" && o.free !== null && o.free < o.needs) {
    return {
      need,
      action: { kind: "rest", for: "space" },
      status: settingUp(
        `not enough free space: needs ${gigabytes(o.needs)}, this Mac has ${gigabytes(o.free)} — it carries on by itself when there's room; ${meanwhile}`,
        { waiting: "space", problem: "no-space", space: { needs: o.needs, free: o.free } },
      ),
    };
  }
  if (
    o.last?.kind === "no-space"
    && o.freeAfterNoSpace !== null
    && o.free !== null
    && o.free < o.freeAfterNoSpace + VOICE_HEAL_NO_SPACE_MARGIN_BYTES
    && o.now - o.last.at < VOICE_HEAL_NO_SPACE_BACKSTOP_MS
  ) {
    const needs = Math.max(o.needs, o.freeAfterNoSpace + VOICE_HEAL_NO_SPACE_MARGIN_BYTES);
    return {
      need,
      action: { kind: "rest", for: "space", until: o.last.at + VOICE_HEAL_NO_SPACE_BACKSTOP_MS },
      status: settingUp(
        `the disk filled up while setting up (this Mac has ${gigabytes(o.free)} free) — it carries on by itself when there's room; ${meanwhile}`,
        { waiting: "space", problem: "no-space", space: { needs, free: o.free } },
      ),
    };
  }
  const budget = o.budget;
  if (budget && budgetExhausted(budget) && o.now < budget.nextAt) {
    const detail = `setup failed ${budget.count} times: ${budget.lastError} — it tries again by itself at ${clock(budget.nextAt)}, or now with \`conch voices setup\``;
    return {
      need,
      action: { kind: "rest", for: "cooldown", until: budget.nextAt },
      status: {
        state: "off",
        off: "failed",
        reason: "setup failed",
        problem: budget.kind,
        retryAt: budget.nextAt,
        detail: o.legacy ? `your mlx-audio install speaks meanwhile; conch's own ${detail}` : detail,
      },
    };
  }
  if (budget && o.now < budget.nextAt) {
    return {
      need,
      action: { kind: "delay", until: budget.nextAt },
      status: settingUp(`attempt ${budget.count} failed (${budget.lastError}) — trying again in ${inMinutes(budget.nextAt - o.now)}; ${meanwhile}`, {
        waiting: "retry",
        retryAt: budget.nextAt,
        problem: budget.kind,
      }),
    };
  }
  switch (need) {
    case "build":
      return { need, action: { kind: "build" }, status: settingUp(`setting up conch's voice environment — ${meanwhile}`) };
    case "fetch-model":
      return {
        need,
        action: { kind: "fetch-model" },
        status: settingUp(`downloading and trying the Kokoro voices (~360 MB, once) — ${meanwhile}`, { stage: "prefetch" }),
      };
    case "retry-worker":
      return { need, action: { kind: "retry-worker" }, status: settingUp(`trying the voice worker again — ${meanwhile}`, { healing: "repair" }) };
  }
}

// MARK: - How far along

/**
 * One percentage across the whole of a setup: the build (when there is one) takes the first 80, the voices' own
 * download the rest. In the build, where it is: its step (1–4) and, in the package step, how many of the lock's packages
 * uv has unpacked. Never 100 until it is ready.
 */
export function healPercent(parts: {
  withBuild: boolean;
  phase: "build" | "model";
  step?: number;
  packages?: { done: number; total: number };
  model?: { bytes: number; total: number };
}): number {
  const fraction = (part?: { done: number; total: number }) =>
    part && part.total > 0 ? Math.min(1, Math.max(0, part.done / part.total)) : 0;
  let value: number;
  if (parts.phase === "build") {
    const step = parts.step ?? 1;
    const built = step <= 1 ? 0.02 : step === 2 ? 0.1 : step === 3 ? 0.12 + 0.83 * fraction(parts.packages) : 0.97;
    value = 0.8 * built;
  } else {
    const fetched = fraction(parts.model && { done: parts.model.bytes, total: parts.model.total });
    value = parts.withBuild ? 0.8 + 0.2 * fetched : fetched;
  }
  return Math.min(99, Math.max(0, Math.floor(value * 100)));
}

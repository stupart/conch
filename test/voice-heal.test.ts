import { describe, expect, test } from "bun:test";
import {
  budgetExhausted,
  budgetReset,
  classifyVoiceFailure,
  countFailure,
  countsAgainstBudget,
  decideVoiceHeal,
  diskFreedSince,
  healPercent,
  unsupportedReason,
  VOICE_HEAL_FREED_BYTES,
  VOICE_HEAL_NO_SPACE_BACKSTOP_MS,
  VOICE_HEAL_NO_SPACE_MARGIN_BYTES,
  VOICE_HEAL_TIGHT_DISK_BYTES,
  voiceHealNeed,
  type VoiceHealBudget,
  type VoiceHealObservation,
} from "../src/voice-heal.ts";

/**
 * The natural voices' heal rules (voice-heal.ts), as a pure function of what was observed. Tyler, 2026-09-28: "Please
 * add the visible thing but also it should 'just work'." These pin every way the voices could end up on `say` without
 * healing: what waits (the network, room), what is retried and how often, what is counted and when the count starts
 * over, what is said once as a limit of this Mac, and what the status says meanwhile.
 */

const NOW = 10_000_000;
const EPOCH = "lock|0.9.0|/app/uv:1:2|darwin 25.6.0";

function observed(overrides: Partial<VoiceHealObservation> = {}): VoiceHealObservation {
  return {
    now: NOW,
    everReady: false,
    legacy: false,
    unsupported: null,
    uv: true,
    heldElsewhere: null,
    env: { ok: true },
    model: "ok",
    worker: null,
    suspect: false,
    last: null,
    network: "unknown",
    free: 50_000_000_000,
    needs: 1_700_000_000,
    freeAfterNoSpace: null,
    budget: null,
    ...overrides,
  };
}

function budget(count: number, overrides: Partial<VoiceHealBudget> = {}): VoiceHealBudget {
  return { epoch: EPOCH, count, lastError: "exit 2 — hash mismatch", kind: "other", at: NOW - 1_000, nextAt: NOW + 60_000, cooldowns: 0, free: 50_000_000_000, ...overrides };
}

describe("what kind of failure", () => {
  test("each message is sorted by its words, as uv, huggingface_hub, MLX and conch write them", () => {
    const table: Array<[string, ReturnType<typeof classifyVoiceFailure>]> = [
      // uv, offline on a first run (python-build-standalone from GitHub, wheels from PyPI).
      ["installing Python 3.12 failed: exit 2 — error: Failed to download `https://github.com/astral-sh/python-build-standalone/releases/download/…` | Caused by: Request failed after 3 retries | Caused by: error sending request for url (…) | Caused by: client error (Connect) | Caused by: dns error: failed to lookup address information: nodename nor servname provided, or not known", "offline"],
      ["installing Kokoro and its packages failed: exit 2 — error: Failed to fetch: `https://pypi.org/simple/numpy/` | Caused by: Could not connect, are you offline?", "offline"],
      ["tcp connect error: Connection refused (os error 61)", "offline"],
      // huggingface_hub, offline while fetching Kokoro.
      ["Error: requests.exceptions.ConnectionError: (MaxRetryError(\"HTTPSConnectionPool(host='huggingface.co', port=443): Max retries exceeded with url: /api/models/mlx-community/Kokoro-82M-bf16\"))", "offline"],
      ["huggingface_hub.errors.LocalEntryNotFoundError: An error happened while trying to locate the file on the Hub and we cannot find the requested files in the local cache.", "offline"],
      // A full disk, whichever step found it.
      ["installing Kokoro and its packages failed: exit 2 — error: Failed to install: numpy-2.3.4-cp312-cp312-macosx_14_0_arm64.whl | Caused by: failed to write to file `…`: No space left on device (os error 28)", "no-space"],
      ["OSError: [Errno 28] No space left on device", "no-space"],
      ["not enough free space: needs 1.7 GB, this Mac has 900 MB", "no-space"],
      // A limit of this Mac.
      ["Error: RuntimeError: [metal::Device] Failed to load device", "unsupported"],
      ["installing Kokoro and its packages failed: exit 1 — error: Distribution `mlx==0.32.2 @ registry+https://pypi.org/simple` can't be installed because it doesn't have a source distribution or wheel for the current platform", "unsupported"],
      // MLX and Metal at work.
      ["Error: RuntimeError: [METAL] Command buffer execution failed: Insufficient Memory (00000008:kIOGPUCommandBufferCallbackErrorOutOfMemory)", "gpu"],
      ["Error: Metal device lost", "gpu"],
      // The environment itself: a library that no longer loads (a macOS update), a package gone, the 2026-09-27 break.
      ["Error: ImportError: dlopen(/Users/x/.cache/conch/voice/env/lib/python3.12/site-packages/mlx/core.cpython-312-darwin.so, 0x0002): Library not loaded: @rpath/libmlx.dylib", "env"],
      ["Error: ModuleNotFoundError: No module named 'loguru'", "env"],
      ["Error: ValueError: Model type kokoro not supported", "env"],
      // Kokoro's files.
      ["Error: safetensors_rust.SafetensorError: Error while deserializing header: HeaderTooLarge", "model"],
      ["Error: json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0) in config.json", "model"],
      // Cut short.
      ["installing Kokoro and its packages failed: timed out after 60 min", "interrupted"],
      ["installing Kokoro and its packages failed: cancelled", "interrupted"],
      // Anything else — including a wheel's own hash mismatch, which is the build's, not the model's.
      ["installing Kokoro and its packages failed: exit 2 — hash mismatch for torch", "other"],
      ["Kokoro worker startup timed out", "other"],
    ];
    for (const [message, kind] of table) expect(classifyVoiceFailure(message), message).toBe(kind);
  });

  test("a limit is said in the app's words", () => {
    expect(unsupportedReason("needs Apple silicon")).toBe("needs Apple silicon");
    expect(unsupportedReason("doesn't have a source distribution or wheel for the current platform")).toBe("needs a newer macOS");
    expect(unsupportedReason("[metal::Device] Failed to load device")).toBe("no Metal GPU");
  });

  test("only what retrying could fix is counted: never the network, the disk, an interruption or a limit", () => {
    expect(["offline", "no-space", "interrupted", "unsupported"].map((kind) => countsAgainstBudget(kind as never))).toEqual([false, false, false, false]);
    expect(["gpu", "env", "model", "other"].map((kind) => countsAgainstBudget(kind as never))).toEqual([true, true, true, true]);
  });
});

describe("the count of attempts", () => {
  test("three quick attempts (now, a minute, five minutes), then cool-downs of 1, 2 and 4 hours — never until tomorrow", () => {
    let current: VoiceHealBudget | null = null;
    const gaps: number[] = [];
    let now = NOW;
    for (let i = 0; i < 6; i++) {
      current = countFailure(current, { error: "boom", kind: "other", now, epoch: EPOCH, free: 1 });
      gaps.push(current.nextAt - now);
      now = current.nextAt;
    }
    expect(gaps).toEqual([60_000, 300_000, 3_600_000, 7_200_000, 14_400_000, 14_400_000]);
    expect(current!.count).toBe(6);
    expect(budgetExhausted(countFailure(null, { error: "", kind: "other", now, epoch: EPOCH, free: 1 }))).toBeFalse();
    expect(budgetExhausted(budget(2))).toBeFalse();
    expect(budgetExhausted(budget(3))).toBeTrue();
  });

  test("an update (conch, its lock, its uv or macOS) starts the count over", () => {
    const counted = countFailure(budget(5), { error: "boom", kind: "other", now: NOW, epoch: "another|epoch", free: 1 });
    expect(counted.count).toBe(1);
    expect(counted.nextAt - NOW).toBe(60_000);
    expect(budgetReset(budget(3), { epoch: "another|epoch", free: 1 })).toBe("conch, its uv or macOS changed");
  });

  test("the count starts over on Try again, the network coming back, or the disk freeing up — and not otherwise", () => {
    const b = budget(3, { free: 2_000_000_000 });
    expect(budgetReset(null, { epoch: EPOCH, free: 1, tryAgain: true })).toBeNull();
    expect(budgetReset(b, { epoch: EPOCH, free: 2_000_000_000, tryAgain: true })).toBe("Try again");
    expect(budgetReset(b, { epoch: EPOCH, free: 2_000_000_000, networkReturned: true })).toBe("the network came back");
    expect(budgetReset(b, { epoch: EPOCH, free: 2_000_000_000 + VOICE_HEAL_FREED_BYTES })).toBe("the disk has more room");
    expect(budgetReset(b, { epoch: EPOCH, free: 2_000_000_000 + VOICE_HEAL_FREED_BYTES - 1 })).toBeNull();
    expect(budgetReset(b, { epoch: EPOCH, free: null })).toBeNull();
    // A disk with room to spare swings by gigabytes with whatever else runs: a failure there wasn't the disk's.
    const roomy = budget(3, { free: VOICE_HEAL_TIGHT_DISK_BYTES });
    expect(budgetReset(roomy, { epoch: EPOCH, free: VOICE_HEAL_TIGHT_DISK_BYTES + 5 * VOICE_HEAL_FREED_BYTES })).toBeNull();
    expect(diskFreedSince(budget(3, { free: VOICE_HEAL_TIGHT_DISK_BYTES - 1 }), VOICE_HEAL_TIGHT_DISK_BYTES - 1 + VOICE_HEAL_FREED_BYTES)).toBeTrue();
  });
});

describe("what is wrong, first to last", () => {
  test("the environment, then the model, then a worker that keeps failing on both", () => {
    expect(voiceHealNeed(observed({ env: { ok: false, reason: "is not set up yet" }, model: "missing" }))).toBe("build");
    expect(voiceHealNeed(observed({ model: "missing" }))).toBe("fetch-model");
    expect(voiceHealNeed(observed())).toBeNull();
    const failing = { kind: "gpu" as const, error: "Metal", bursts: 1, rebuilt: false, parked: false };
    // The worker retries by itself first; three bursts, and the environment is rebuilt once; after that it is set aside.
    expect(voiceHealNeed(observed({ worker: failing }))).toBeNull();
    expect(voiceHealNeed(observed({ worker: { ...failing, bursts: 3 } }))).toBe("build");
    expect(voiceHealNeed(observed({ worker: { ...failing, bursts: 3, rebuilt: true } }))).toBe("park-worker");
    expect(voiceHealNeed(observed({ worker: { ...failing, parked: true } }))).toBe("retry-worker");
    // macOS or the interpreter changed under it: one failed burst is enough.
    expect(voiceHealNeed(observed({ worker: failing, suspect: true }))).toBe("build");
    // A library that no longer loads: rebuilt at once, once.
    expect(voiceHealNeed(observed({ worker: { ...failing, kind: "env" } }))).toBe("build");
    expect(voiceHealNeed(observed({ worker: { ...failing, kind: "env", rebuilt: true } }))).toBeNull();
    // Damaged files come before the worker.
    expect(voiceHealNeed(observed({ worker: { ...failing, bursts: 3 }, model: "missing" }))).toBe("fetch-model");
  });
});

describe("the decision", () => {
  test("healthy: ready, and nothing else", () => {
    expect(decideVoiceHeal(observed())).toEqual({ need: null, action: { kind: "adopt" }, status: { state: "ready", detail: "ready" } });
  });

  test("broken or missing: built, said as a first setup or as coming back", () => {
    const first = decideVoiceHeal(observed({ env: { ok: false, reason: "is not set up yet" } }));
    expect(first.action).toEqual({ kind: "build" });
    expect(first.status).toMatchObject({ state: "setting-up", healing: "first-run" });
    expect(first.status.detail).toContain("speaking with macOS say until it is ready");
    const again = decideVoiceHeal(observed({ env: { ok: false, reason: "is off the lock" }, everReady: true, legacy: true }));
    expect(again.status).toMatchObject({ state: "setting-up", healing: "repair" });
    expect(again.status.detail).toContain("using your mlx-audio install until it is ready");
    expect(decideVoiceHeal(observed({ model: "missing" }))).toMatchObject({ action: { kind: "fetch-model" }, status: { stage: "prefetch" } });
  });

  test("offline: waits for the network, quietly, and carries on the moment it is back", () => {
    const last = { kind: "offline" as const, error: "dns error", at: NOW - 5_000 };
    const waiting = decideVoiceHeal(observed({ env: { ok: false, reason: "is not set up yet" }, last, network: "offline" }));
    expect(waiting.action).toEqual({ kind: "rest", for: "network" });
    expect(waiting.status).toMatchObject({ state: "setting-up", waiting: "network", problem: "offline", healing: "first-run" });
    // Not counted: however long it is offline, nothing runs out.
    expect(waiting.status.off).toBeUndefined();
    expect(decideVoiceHeal(observed({ env: { ok: false, reason: "x" }, last, network: "unknown" })).action).toEqual({ kind: "rest", for: "network" });
    expect(decideVoiceHeal(observed({ env: { ok: false, reason: "x" }, last, network: "online" })).action).toEqual({ kind: "build" });
    // The model's download waits the same way.
    expect(decideVoiceHeal(observed({ model: "missing", last, network: "offline" })).action).toEqual({ kind: "rest", for: "network" });
  });

  test("no room: a build doesn't start, says what it needs, and carries on when there's room", () => {
    const low = decideVoiceHeal(observed({ env: { ok: false, reason: "x" }, free: 900_000_000 }));
    expect(low.action).toEqual({ kind: "rest", for: "space" });
    expect(low.status).toMatchObject({ waiting: "space", problem: "no-space", space: { needs: 1_700_000_000, free: 900_000_000 } });
    expect(low.status.detail).toContain("needs 1.7 GB, this Mac has 900 MB");
    // Unknown free space never blocks.
    expect(decideVoiceHeal(observed({ env: { ok: false, reason: "x" }, free: null })).action).toEqual({ kind: "build" });

    // Filled up part way: it waits for more room than it had then, or an hour, whichever first.
    const last = { kind: "no-space" as const, error: "No space left on device", at: NOW - 60_000 };
    const after = { env: { ok: false, reason: "x" } as const, last, freeAfterNoSpace: 2_000_000_000 };
    const stillFull = decideVoiceHeal(observed({ ...after, free: 2_000_000_000 + VOICE_HEAL_NO_SPACE_MARGIN_BYTES - 1 }));
    expect(stillFull.action).toEqual({ kind: "rest", for: "space", until: last.at + VOICE_HEAL_NO_SPACE_BACKSTOP_MS });
    expect(stillFull.status.space?.needs).toBe(2_000_000_000 + VOICE_HEAL_NO_SPACE_MARGIN_BYTES);
    expect(decideVoiceHeal(observed({ ...after, free: 2_000_000_000 + VOICE_HEAL_NO_SPACE_MARGIN_BYTES })).action).toEqual({ kind: "build" });
    expect(decideVoiceHeal(observed({ ...after, free: 2_000_000_000, now: last.at + VOICE_HEAL_NO_SPACE_BACKSTOP_MS })).action).toEqual({ kind: "build" });
  });

  test("a quick retry's wait is in line and quiet; after three, off with the reason and when it tries again by itself", () => {
    const env = { ok: false, reason: "x" } as const;
    const quick = decideVoiceHeal(observed({ env, budget: budget(1, { nextAt: NOW + 60_000 }) }));
    expect(quick.action).toEqual({ kind: "delay", until: NOW + 60_000 });
    expect(quick.status).toMatchObject({ state: "setting-up", waiting: "retry", retryAt: NOW + 60_000 });
    expect(quick.status.detail).toContain("trying again in a minute");
    // Its time has come: it builds.
    expect(decideVoiceHeal(observed({ env, budget: budget(2, { nextAt: NOW }) })).action).toEqual({ kind: "build" });

    const cooling = decideVoiceHeal(observed({ env, budget: budget(3, { nextAt: NOW + 3_600_000 }) }));
    expect(cooling.action).toEqual({ kind: "rest", for: "cooldown", until: NOW + 3_600_000 });
    expect(cooling.status).toMatchObject({ state: "off", off: "failed", reason: "setup failed", problem: "other", retryAt: NOW + 3_600_000 });
    expect(cooling.status.detail).toContain("setup failed 3 times: exit 2 — hash mismatch");
    // The cool-down over, it tries once more by itself.
    expect(decideVoiceHeal(observed({ env, budget: budget(3, { nextAt: NOW }) })).action).toEqual({ kind: "build" });
  });

  test("a limit of this Mac is said once and never retried; no uv is off, and watched for", () => {
    const limit = decideVoiceHeal(observed({ unsupported: "no Metal GPU", env: { ok: false, reason: "x" } }));
    expect(limit.action).toEqual({ kind: "rest", for: "unsupported" });
    expect(limit.status).toMatchObject({ state: "off", off: "unsupported", reason: "no Metal GPU", problem: "unsupported" });
    const noUv = decideVoiceHeal(observed({ uv: false, env: { ok: false, reason: "x" } }));
    expect(noUv.action).toEqual({ kind: "rest", for: "uv" });
    expect(noUv.status).toMatchObject({ state: "off", off: "failed", reason: "no uv" });
    // No uv is only a problem for a build: a model download needs none.
    expect(decideVoiceHeal(observed({ uv: false, model: "missing" })).action).toEqual({ kind: "fetch-model" });
  });

  test("another conch building: waited for, not raced", () => {
    const elsewhere = decideVoiceHeal(observed({ env: { ok: false, reason: "x" }, heldElsewhere: 4242 }));
    expect(elsewhere.action).toEqual({ kind: "rest", for: "elsewhere" });
    expect(elsewhere.status).toMatchObject({ state: "setting-up", stage: "elsewhere" });
    expect(elsewhere.status.detail).toContain("pid 4242");
  });

  test("a failing worker: coming back while it retries, rebuilt for, set aside, then tried again on the count's clock", () => {
    const worker = { kind: "gpu" as const, error: "Metal device lost", bursts: 1, rebuilt: false, parked: false };
    const retrying = decideVoiceHeal(observed({ worker }));
    expect(retrying.action).toEqual({ kind: "adopt" });
    expect(retrying.status).toMatchObject({ state: "setting-up", healing: "repair", problem: "gpu" });
    expect(decideVoiceHeal(observed({ worker: { ...worker, bursts: 3 } })).action).toEqual({ kind: "build" });
    expect(decideVoiceHeal(observed({ worker: { ...worker, bursts: 3, rebuilt: true } })).action).toEqual({ kind: "park-worker" });
    const parked = { ...worker, bursts: 0, rebuilt: true, parked: true };
    expect(decideVoiceHeal(observed({ worker: parked, budget: budget(1) })).action).toEqual({ kind: "delay", until: NOW + 60_000 });
    expect(decideVoiceHeal(observed({ worker: parked, budget: budget(1, { nextAt: NOW }) })).action).toEqual({ kind: "retry-worker" });
    expect(decideVoiceHeal(observed({ worker: parked, budget: budget(3, { nextAt: NOW + 3_600_000 }) })).status).toMatchObject({ state: "off", off: "failed" });
  });
});

describe("how far along", () => {
  test("one percentage over the build and the voices' download, rising, and never 100 until ready", () => {
    const steps = [
      healPercent({ withBuild: true, phase: "build", step: 1 }),
      healPercent({ withBuild: true, phase: "build", step: 2 }),
      healPercent({ withBuild: true, phase: "build", step: 3, packages: { done: 0, total: 95 } }),
      healPercent({ withBuild: true, phase: "build", step: 3, packages: { done: 48, total: 95 } }),
      healPercent({ withBuild: true, phase: "build", step: 3, packages: { done: 95, total: 95 } }),
      healPercent({ withBuild: true, phase: "build", step: 4 }),
      healPercent({ withBuild: true, phase: "model", model: { bytes: 0, total: 360 } }),
      healPercent({ withBuild: true, phase: "model", model: { bytes: 180, total: 360 } }),
      healPercent({ withBuild: true, phase: "model", model: { bytes: 400, total: 360 } }),
    ];
    expect(steps).toEqual([1, 8, 9, 43, 76, 77, 80, 90, 99]);
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeGreaterThanOrEqual(steps[i - 1]!);
    // The voices alone (the environment was there): the whole bar is theirs.
    expect(healPercent({ withBuild: false, phase: "model", model: { bytes: 90, total: 360 } })).toBe(25);
    expect(healPercent({ withBuild: false, phase: "model", model: { bytes: 360, total: 360 } })).toBe(99);
  });
});

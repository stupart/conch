import { describe, expect, test } from "bun:test";
import {
  AudioSinkLease,
  rehydrateLatestTurns,
  reserveNormalMicForSink,
  retainMatchingPhoneBridge,
  validateAndScopeSocketTurnEvent,
} from "../src/daemon.ts";
import type { Config } from "../src/config.ts";
import type { TurnEvent } from "../src/hook.ts";
import { injectText } from "../src/inject.ts";
import type { PublishedState } from "../src/panel.ts";
import type { PhoneBridgeHandle } from "../src/phone-bridge.ts";

describe("phone-backed audio ownership", () => {
  test("a phone claim exists only while at least one client exists", () => {
    const lease = new AudioSinkLease();

    expect(lease.request("phone", 0)).toBe("mac");
    expect(lease.request("phone", 2)).toBe("phone");
    expect(lease.clientsChanged(1)).toBeFalse();
    expect(lease.sink).toBe("phone");
    expect(lease.clientsChanged(0)).toBeTrue();
    expect(lease.sink).toBe("mac");
    // A delayed claim from the just-closed phone must not re-mute the Mac.
    expect(lease.request("phone", 0)).toBe("mac");
  });

  test("stopping or changing the configured port retires the old bridge", () => {
    const stopped: number[] = [];
    const fake = (port: number): PhoneBridgeHandle => ({
      port,
      stop: () => { stopped.push(port); },
      offerPairingCode: () => {},
      publish: () => {},
      clientCount: () => 1,
    });

    const matching = fake(8674);
    expect(retainMatchingPhoneBridge(matching, true, 8674)).toBe(matching);
    expect(stopped).toEqual([]);

    expect(retainMatchingPhoneBridge(matching, true, 9000)).toBeNull();
    expect(stopped).toEqual([8674]);

    const disabled = fake(9000);
    expect(retainMatchingPhoneBridge(disabled, false, 9000)).toBeNull();
    expect(stopped).toEqual([8674, 9000]);
  });

  test("normal mic reservation refuses phone ownership before waiting", async () => {
    const reservations: boolean[] = [];
    let waited = false;
    const reserved = await reserveNormalMicForSink({
      sink: () => "phone",
      shuttingDown: () => false,
      setReserved: (value) => reservations.push(value),
      quiescent: async () => { waited = true; },
    });

    expect(reserved).toBeFalse();
    expect(waited).toBeFalse();
    expect(reservations).toEqual([]);
  });

  test("normal mic reservation is released if the phone claims during quiescence", async () => {
    let sink: "mac" | "phone" = "mac";
    let release!: () => void;
    const quiescent = new Promise<void>((resolve) => { release = resolve; });
    const reservations: boolean[] = [];

    const pending = reserveNormalMicForSink({
      sink: () => sink,
      shuttingDown: () => false,
      setReserved: (value) => reservations.push(value),
      quiescent: () => quiescent,
    });
    await Bun.sleep(0);
    sink = "phone";
    release();

    expect(await pending).toBeFalse();
    expect(reservations).toEqual([true, false]);
  });
});

describe("startup transcript rehydration", () => {
  test("writes dashboard history only and never overwrites an existing live turn", async () => {
    const live: TurnEvent = {
      type: "turn-end",
      sessionId: "live",
      label: "live",
      announce: "new hook",
    };
    const latest = new Map<string, TurnEvent>([["live", live]]);
    const reads: string[] = [];

    const restored = await rehydrateLatestTurns({
      sessions: [
        { sessionId: "history", cwd: "/history", statusUpdatedAt: 111 },
        { sessionId: "live", cwd: "/live", statusUpdatedAt: 222 },
      ],
      latest,
      transcriptFor: (sessionId) => `/transcripts/${sessionId}.jsonl`,
      readAssistant: async (path) => {
        reads.push(path);
        return "**finished** with history";
      },
      labelFor: (session) => `label:${session.sessionId}`,
      maxChars: 200,
      stopping: () => false,
      now: () => 999,
    });

    expect(restored).toBe(1);
    expect(reads).toEqual(["/transcripts/history.jsonl"]);
    expect(latest.get("live")).toBe(live);
    expect(latest.get("history")).toEqual({
      type: "turn-end",
      sessionId: "history",
      label: "label:history",
      cwd: "/history",
      announce: "finished with history",
      transcriptPath: "/transcripts/history.jsonl",
      eventAt: 111,
    });
  });

  test("a hook arriving during transcript I/O wins the startup race", async () => {
    const latest = new Map<string, TurnEvent>();
    let finishRead!: (value: string) => void;
    const read = new Promise<string>((resolve) => { finishRead = resolve; });
    const pending = rehydrateLatestTurns({
      sessions: [{ sessionId: "same" }],
      latest,
      transcriptFor: () => "/same.jsonl",
      readAssistant: () => read,
      labelFor: () => "historical",
      maxChars: 200,
      stopping: () => false,
    });
    await Bun.sleep(0);
    const live: TurnEvent = {
      type: "turn-end",
      sessionId: "same",
      label: "live",
      announce: "new hook",
    };
    latest.set("same", live);
    finishRead("old transcript");

    expect(await pending).toBe(0);
    expect(latest.get("same")).toBe(live);
  });
});

describe("phone inject scope", () => {
  const published = {
    v: 1,
    rows: [{ id: "named", label: "canonical" }],
  } as unknown as PublishedState;

  test("requires a published id and replaces every caller routing field", () => {
    const event: TurnEvent = {
      type: "inject",
      sessionId: "named",
      label: "spoofed",
      announce: "  keep the text  ",
      cwd: "/attacker",
      pid: 99999,
      transcriptPath: "/attacker/transcript",
      eventAt: 1,
    };
    const scoped = validateAndScopeSocketTurnEvent(event, published, () => ({
      cwd: "/real",
      pid: 42,
      transcriptPath: "/real/transcript",
    }), 500);

    expect(scoped).toEqual({
      ok: true,
      value: {
        type: "inject",
        sessionId: "named",
        label: "canonical",
        announce: "keep the text",
        cwd: "/real",
        pid: 42,
        transcriptPath: "/real/transcript",
        eventAt: 500,
      },
    });
    expect(validateAndScopeSocketTurnEvent(
      { ...event, sessionId: "not-published" },
      published,
    ).ok).toBeFalse();
    expect(validateAndScopeSocketTurnEvent(
      { ...event, sessionId: "   " },
      published,
    ).ok).toBeFalse();
  });

  test("a scoped inject without a routable pid copies instead of blind typing", async () => {
    const copied: string[] = [];
    const result = await injectText(
      { autoSubmit: true, keystrokeFallback: true } as Config,
      undefined,
      "irreplaceable words",
      undefined,
      {
        allowBlindFallback: false,
        copyToClipboard: async (text) => { copied.push(text); },
      },
    );

    expect(result).toEqual({ via: "clipboard", reason: "session-not-routable" });
    expect(copied).toEqual(["irreplaceable words"]);
  });
});

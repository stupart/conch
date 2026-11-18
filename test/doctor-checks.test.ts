import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  checkConchBinaries,
  checkKokoro,
  checkMicrophone,
  checkNaturalVoices,
  checkTts,
  checkWhisperServer,
  formatDoctorProbe,
  MICROPHONE_PROBE_DURATION_MS,
  pcm16HasNonZeroSample,
  TTS_PROBE_WORD,
} from "../src/doctor-checks.ts";
import { VOICE_LOCK, voiceEnvPaths } from "../src/voice-env.ts";

function config() {
  return loadConfig({
    env: {},
    settingsPath: `/tmp/conch-doctor-checks-${process.pid}/settings.json`,
  });
}

describe("microphone doctor probe", () => {

  test("classifies complete signed 16-bit samples instead of stray bytes", () => {
    expect(pcm16HasNonZeroSample(new Uint8Array([0, 0, 0, 0]))).toBeFalse();
    expect(pcm16HasNonZeroSample(new Uint8Array([1, 0]))).toBeTrue();
    expect(pcm16HasNonZeroSample(new Uint8Array([0, 128]))).toBeTrue();
    expect(pcm16HasNonZeroSample(new Uint8Array([0, 0, 7]))).toBeFalse();
  });

  test("passes nonzero capture and keeps the default probe short", async () => {
    let receivedDuration = 0;
    const result = await checkMicrophone({
      capture: async (durationMs) => {
        receivedDuration = durationMs;
        return { pcm: new Uint8Array([0, 0, 2, 0]) };
      },
    });

    expect(receivedDuration).toBe(MICROPHONE_PROBE_DURATION_MS);
    expect(result).toMatchObject({ ok: true, label: "microphone" });
  });

  test("all-zero capture reports likely permission denial and the exact settings pane", async () => {
    const result = await checkMicrophone({
      capture: async () => ({ pcm: new Uint8Array(9_600) }),
    });

    expect(result.ok).toBeFalse();
    expect(result.message).toContain("all zeros");
    expect(result.action).toContain("Microphone");
    expect(formatDoctorProbe(result)).toStartWith("⚠️");
  });

  test("conch Microphone is probed when macOS allows it; otherwise the probe says so and checks sox", async () => {
    const asked: string[] = [];
    const allowed = await checkMicrophone({
      native: "/Runtime/conch Microphone",
      nativeStatus: async (path) => (asked.push(path), "authorized"),
      capture: async () => ({ pcm: new Uint8Array([0, 0, 2, 0]) }),
    });
    expect(asked).toEqual(["/Runtime/conch Microphone"]);
    expect(allowed).toMatchObject({ ok: true, label: "microphone" });
    expect(allowed.message).toStartWith("conch Microphone");

    const undecided = await checkMicrophone({
      native: "/Runtime/conch Microphone",
      nativeStatus: async () => "notDetermined",
      capture: async () => ({ pcm: new Uint8Array([0, 0, 2, 0]) }),
    });
    expect(undecided.ok).toBeTrue();
    expect(undecided.message).toStartWith("sox");
    expect(undecided.message).toContain("notDetermined");
  });

  test("capture errors become actionable advisory results", async () => {
    const result = await checkMicrophone({
      capture: async () => { throw new Error("SoX exited with code 1"); },
    });

    expect(result).toMatchObject({ ok: false, label: "microphone" });
    expect(result.message).toContain("SoX exited with code 1");
  });
});

describe("TTS doctor probe", () => {
  test("speaks one short word through the injected configured-path seam", async () => {
    const cfg = config();
    cfg.speak = false;
    let received: { cfg: typeof cfg; word: string; timeoutMs: number } | undefined;
    const result = await checkTts(cfg, {
      speak: async (receivedCfg, word, timeoutMs) => {
        received = { cfg: receivedCfg, word, timeoutMs };
      },
    });

    expect(received?.cfg).toBe(cfg);
    expect(received?.word).toBe(TTS_PROBE_WORD);
    expect(cfg.speak).toBeFalse();
    expect(result).toMatchObject({ ok: true, label: "TTS" });
  });

  test("a configured-path error says what to do and remains an advisory warning", async () => {
    const result = await checkTts(config(), {
      speak: async () => { throw new Error("say exited with code 1"); },
    });

    expect(result).toMatchObject({ ok: false, label: "TTS" });
    expect(result.message).toContain("say exited with code 1");
    expect(formatDoctorProbe(result)).toStartWith("⚠️");
  });
});

describe("conch binaries on PATH", () => {
  const executable = (...files: string[]) => (file: string) => files.includes(file);

  test("names every conch on PATH when there is more than one", () => {
    // The from-source trap: a brew binary and a `bun link`ed checkout both on
    // PATH, so the app and the daemon run different versions and nothing says
    // so. The first on PATH is the one a shell runs.
    const result = checkConchBinaries(
      "/opt/homebrew/bin:/Users/me/.bun/bin:/usr/bin",
      executable("/opt/homebrew/bin/conch", "/Users/me/.bun/bin/conch"),
    );
    expect(result).toMatchObject({ ok: false, label: "conch" });
    expect(result.message).toContain("2 on PATH");
    expect(result.message).toContain("/opt/homebrew/bin/conch, /Users/me/.bun/bin/conch");
    expect(formatDoctorProbe(result)).toStartWith("⚠️");
  });

  test("one conch, or a PATH that repeats its directory, is not a warning", () => {
    // PATH commonly lists /opt/homebrew/bin twice; that is one install.
    const result = checkConchBinaries(
      "/opt/homebrew/bin:/usr/bin::/opt/homebrew/bin",
      executable("/opt/homebrew/bin/conch"),
    );
    expect(result.ok).toBe(true);
    expect(checkConchBinaries("/usr/bin", executable()).ok).toBe(true);
  });

});

describe("whisper-server state (D2)", () => {
  const cfg = { ...config(), whisperPort: 8642, whisperIdleUnloadMins: 20 };
  const record = { pid: 4242, port: 8642, daemonPid: 999, startedAt: 1 };
  const deps = (listening: boolean, alive: number[], spawn: typeof record | null = record) => ({
    listening: async () => listening,
    record: () => spawn,
    alive: (pid: number) => alive.includes(pid),
  });

  test("says warm (owned or adopted), unloaded, or not listening — never as a fault", async () => {
    const owned = await checkWhisperServer(cfg, deps(true, [4242, 999]));
    expect(owned.ok).toBe(true);
    expect(owned.message).toContain("owned by conch daemon 999");
    // Listening, but the recorded daemon is dead, or the record is for another port: someone else's.
    expect((await checkWhisperServer(cfg, deps(true, [4242]))).message).toContain("adopted");
    expect((await checkWhisperServer(cfg, deps(true, [4242, 999], { ...record, port: 8643 }))).message).toContain("adopted");
    expect((await checkWhisperServer(cfg, deps(true, [], null))).message).toContain("adopted");
    // Its daemon is up and nothing listens: idle-unloaded (or still warming).
    const unloaded = await checkWhisperServer(cfg, deps(false, [999]));
    expect(unloaded.ok).toBeTrue();
    expect(unloaded.message).toContain("unloaded —");
    // With the window off nothing was unloaded, so the line must not say so.
    const never = await checkWhisperServer({ ...cfg, whisperIdleUnloadMins: 0 }, deps(false, [999]));
    expect(never.message).not.toContain("unloaded —");
    expect((await checkWhisperServer(cfg, deps(false, []))).message).toContain("not listening");
    expect((await checkWhisperServer({ ...cfg, whisperPort: 0 }, deps(true, [4242, 999]))).message).toContain("cold cli only");
    expect(formatDoctorProbe(unloaded)).toStartWith("✅");
  });

});

describe("kokoro state (D1)", () => {
  const daemon = { pid: 999, version: "x", startedBy: "terminal" as const, startedAt: 1 };
  const deps = (options: { daemon?: boolean; worker?: number | null; listening?: boolean; paused?: boolean }) => ({
    daemon: () => ((options.daemon ?? true) ? daemon : null),
    workerPid: () => options.worker ?? null,
    listening: async () => options.listening ?? false,
    paused: () => options.paused ?? false,
  });
  const worker = { ...config(), ttsEngine: "worker" as const };

  test("says warm, unloaded in manual mode, or not loaded — never as a fault", async () => {
    const warm = await checkKokoro(worker, deps({ worker: 4321 }));
    expect(warm.ok).toBe(true);
    expect(warm.message).toContain("warm (worker pid 4321");
    const unloaded = await checkKokoro(worker, deps({ paused: true }));
    expect(unloaded.message).toContain("unloaded");
    expect(formatDoctorProbe(unloaded)).toStartWith("✅");
    expect((await checkKokoro(worker, deps({}))).message).toContain("not loaded");
    expect((await checkKokoro(worker, deps({ daemon: false, paused: true }))).message).toContain("not loaded");
    expect((await checkKokoro({ ...worker, ttsEngine: "say" }, deps({ worker: 4321 }))).message).toContain("CONCH_TTS=say");
    // The legacy server is read from its port, not the process table.
    const server = { ...worker, ttsEngine: "server" as const, ttsPort: 8880 };
    expect((await checkKokoro(server, deps({ listening: true, worker: 4321 }))).message).toContain("legacy server");
    expect((await checkKokoro(server, deps({ paused: true }))).message).toContain("manual mode");
    expect((await checkKokoro({ ...server, ttsPort: 0 }, deps({ listening: true }))).message).toContain("CONCH_TTS_PORT=0");
  });

});

describe("natural voices doctor line (voice-env.ts)", () => {
  test("says where the voices stand: the live daemon's status first, else what is on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-doctor-voices-"));
    try {
      const paths = voiceEnvPaths(root);
      const worker = config();
      worker.ttsEngine = "worker";
      const none = () => null;

      expect(checkNaturalVoices({ ...worker, ttsEngine: "say" }, { paths, published: none }).message).toContain("off (CONCH_TTS=say)");

      const fresh = checkNaturalVoices(worker, { paths, published: none });
      expect(fresh.message).toContain("not set up yet");

      mkdirSync(paths.env, { recursive: true });
      writeFileSync(paths.record, JSON.stringify({ lock: VOICE_LOCK.id, python: "3.12.14" }));
      expect(checkNaturalVoices(worker, { paths, published: none }).message).toContain("installed (Python 3.12.14)");

      const failed = checkNaturalVoices(worker, {
        paths,
        published: () => ({ state: "off", reason: "setup failed", detail: "setup failed 3 times: no space left", pid: 4321 }),
      });
      expect(failed.message).toContain("setup failed 3 times: no space left");
      expect(failed.action).toContain(paths.log);

      const building = checkNaturalVoices(worker, {
        paths,
        published: () => ({ state: "setting-up", detail: "installing Kokoro and its packages (3/4) — speaking with macOS say until it is ready", pid: 4321 }),
      });
      expect(building.message).toContain("installing Kokoro");
      expect(building.action).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

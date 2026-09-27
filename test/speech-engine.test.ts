import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { checkSpeechEngine } from "../src/doctor-checks.ts";
import { downloadModel } from "../src/install.ts";
import {
  acquireFetchLock,
  conchAppCandidates,
  describeSpeechEngine,
  fetchPinnedModel,
  readFetchFailures,
  resolveSpeechEngine,
  SpeechEngineManager,
  VAD_MODEL,
  WHISPER_MODEL,
  type FetchModelOptions,
  type PinnedModel,
  type SpeechEngine,
  type SpeechEngineStatus,
} from "../src/speech-engine.ts";

/**
 * conch hears with seashell's engine — sox, whisper.cpp, the Silero VAD — and
 * the app carries it, so a downloaded conch needs nothing installed (Tyler:
 * "we built our audio capture on seashell because we made such a great
 * transcription tool — don't go stripping that out and replacing with Apple
 * defaults"). These pin the resolution order (explicit, the app, seashell,
 * Homebrew, conch's own downloads), the first-run model fetch (pinned sha256,
 * resumable, bounded retries across restarts) and the status it publishes.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-speech-engine-"));
  roots.push(root);
  return root;
}

const HOME = "/Users/tester";
const APP = "/Applications/conch.app";
const helper = (name: string) => `${APP}/Contents/Helpers/${name}`;
const SEASHELL = `${HOME}/whisper-cli`;
const SEASHELL_BREW = "/opt/homebrew/opt/seashell/libexec";
const CACHE = `${HOME}/.cache/conch/models`;

function resolveWith(present: string[], env: Record<string, string> = {}, extra: { execPath?: string; which?: (name: string) => string | null } = {}) {
  const set = new Set(present);
  return resolveSpeechEngine({
    env,
    home: HOME,
    execPath: extra.execPath ?? "/opt/homebrew/bin/bun",
    executable: (path) => set.has(path),
    file: (path) => set.has(path),
    which: extra.which ?? (() => null),
  });
}

describe("every part resolves: explicit, then the app, then seashell, then Homebrew", () => {
  const everything = [
    helper("whisper-cli"), helper("whisper-server"), helper("sox"),
    `${APP}/Contents/Resources/models/${VAD_MODEL.file}`,
    `${SEASHELL}/whisper.cpp/build/bin/whisper-cli`, `${SEASHELL}/whisper.cpp/build/bin/whisper-server`,
    `${SEASHELL}/models/${WHISPER_MODEL.file}`, `${SEASHELL}/whisper.cpp/models/${VAD_MODEL.file}`,
    "/opt/homebrew/bin/whisper-cli", "/opt/homebrew/bin/whisper-server", "/opt/homebrew/bin/sox",
    `${CACHE}/${WHISPER_MODEL.file}`, `${CACHE}/${VAD_MODEL.file}`,
  ];

  test("with everything installed, the app's own copies win (and the model is seashell's)", () => {
    const engine = resolveWith(everything);
    expect(engine.whisperCli).toEqual({ path: helper("whisper-cli"), source: "conch.app", found: true });
    expect(engine.whisperServer).toEqual({ path: helper("whisper-server"), source: "conch.app", found: true });
    expect(engine.sox).toEqual({ path: helper("sox"), source: "conch.app", found: true });
    expect(engine.vadModel).toEqual({ path: `${APP}/Contents/Resources/models/${VAD_MODEL.file}`, source: "conch.app", found: true });
    expect(engine.whisperModel).toEqual({ path: `${SEASHELL}/models/${WHISPER_MODEL.file}`, source: "seashell", found: true });
  });

  test("an explicit CONCH_* path beats everything — even when it is missing, which is a setting to fix", () => {
    const engine = resolveWith(everything, {
      CONCH_WHISPER_CLI: "/custom/whisper-cli",
      CONCH_WHISPER_MODEL: "/custom/model.bin",
      CONCH_SOX: "/custom/sox",
    });
    expect(engine.whisperCli).toEqual({ path: "/custom/whisper-cli", source: "explicit", found: false });
    expect(engine.whisperModel).toEqual({ path: "/custom/model.bin", source: "explicit", found: false });
    expect(engine.sox).toEqual({ path: "/custom/sox", source: "explicit", found: false });
  });

  test("without the app: a seashell checkout, then seashell's Homebrew formula, then Homebrew's whisper-cpp", () => {
    const noApp = everything.filter((path) => !path.startsWith(APP));
    expect(resolveWith(noApp).whisperCli).toEqual({ path: `${SEASHELL}/whisper.cpp/build/bin/whisper-cli`, source: "seashell", found: true });
    expect(resolveWith(noApp).vadModel.source).toBe("seashell");
    const formula = [`${SEASHELL_BREW}/whisper.cpp/build/bin/whisper-server`, `${SEASHELL_BREW}/models/${WHISPER_MODEL.file}`, "/opt/homebrew/bin/whisper-server"];
    expect(resolveWith(formula).whisperServer).toEqual({ path: `${SEASHELL_BREW}/whisper.cpp/build/bin/whisper-server`, source: "seashell", found: true });
    expect(resolveWith(formula).whisperModel).toEqual({ path: `${SEASHELL_BREW}/models/${WHISPER_MODEL.file}`, source: "seashell", found: true });
    expect(resolveWith(["/opt/homebrew/bin/whisper-cli"]).whisperCli).toEqual({ path: "/opt/homebrew/bin/whisper-cli", source: "homebrew", found: true });
    expect(resolveWith(["/usr/local/bin/whisper-cli"]).whisperCli.source).toBe("homebrew");
  });

  test("CONCH_SEASHELL_ROOT names the one seashell tree: ~/whisper-cli and the formula are not searched", () => {
    const engine = resolveWith(["/src/seashell/whisper.cpp/build/bin/whisper-cli", `${SEASHELL}/whisper.cpp/build/bin/whisper-cli`], { CONCH_SEASHELL_ROOT: "/src/seashell" });
    expect(engine.whisperCli.path).toBe("/src/seashell/whisper.cpp/build/bin/whisper-cli");
    const formulaModel = `${SEASHELL_BREW}/models/${WHISPER_MODEL.file}`;
    expect(resolveWith([formulaModel]).whisperModel.path).toBe(formulaModel);
    expect(resolveWith([formulaModel], { CONCH_SEASHELL_ROOT: "/src/seashell" }).whisperModel).toEqual({ path: `${CACHE}/${WHISPER_MODEL.file}`, source: "missing", found: false });
  });

  test("the models fall back to conch's own downloads; missing, they name that destination", () => {
    expect(resolveWith([`${CACHE}/${WHISPER_MODEL.file}`]).whisperModel).toEqual({ path: `${CACHE}/${WHISPER_MODEL.file}`, source: "conch", found: true });
    expect(resolveWith([]).whisperModel).toEqual({ path: `${CACHE}/${WHISPER_MODEL.file}`, source: "missing", found: false });
    expect(resolveWith([]).vadModel).toEqual({ path: `${CACHE}/${VAD_MODEL.file}`, source: "missing", found: false });
  });

  test("sox: the app's, then Homebrew's, then PATH — and bare `sox`, as it always spawned, when none", () => {
    expect(resolveWith(["/opt/homebrew/bin/sox"]).sox).toEqual({ path: "/opt/homebrew/bin/sox", source: "homebrew", found: true });
    const onPath = resolveWith(["/nix/bin/sox"], {}, { which: (name) => (name === "sox" ? "/nix/bin/sox" : null) });
    expect(onPath.sox).toEqual({ path: "/nix/bin/sox", source: "PATH", found: true });
    expect(resolveWith([]).sox).toEqual({ path: "sox", source: "missing", found: false });
  });

  test("CONCH_APP_BUNDLE (what the app hands its daemon) is the only app looked in", () => {
    const other = "/Users/tester/Downloads/conch.app";
    expect(conchAppCandidates({ CONCH_APP_BUNDLE: other }, HOME, "/opt/homebrew/bin/bun")).toEqual([other]);
    const engine = resolveWith([helper("whisper-cli"), `${other}/Contents/Helpers/sox`], { CONCH_APP_BUNDLE: other });
    expect(engine.whisperCli.found).toBeFalse(); // /Applications' copy is another app's
    expect(engine.sox).toEqual({ path: `${other}/Contents/Helpers/sox`, source: "conch.app", found: true });
  });

  test("the bundled daemon finds the app it sits in; the Homebrew CLI finds the app beside it", () => {
    const inside = conchAppCandidates({}, HOME, "/Users/tester/Downloads/conch 2.app/Contents/Helpers/conch-daemon");
    expect(inside[0]).toBe("/Users/tester/Downloads/conch 2.app");
    const cellar = conchAppCandidates({}, HOME, "/opt/homebrew/Cellar/conch/0.4.0/bin/conch");
    expect(cellar).toContain("/opt/homebrew/Cellar/conch/0.4.0/conch.app");
    expect(cellar.slice(0, 2)).toEqual(["/Applications/conch.app", `${HOME}/Applications/conch.app`]);
  });

  test("loadConfig takes its engine paths — and sox — from this resolution", () => {
    const root = scratch();
    const app = join(root, "conch.app");
    mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
    mkdirSync(join(app, "Contents", "Resources", "models"), { recursive: true });
    for (const name of ["whisper-cli", "whisper-server", "sox"]) writeFileSync(join(app, "Contents", "Helpers", name), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Contents", "Resources", "models", VAD_MODEL.file), "vad");
    const cfg = loadConfig({ env: { CONCH_APP_BUNDLE: app }, settingsPath: join(root, "settings.json") });
    expect(cfg.whisperCli).toBe(join(app, "Contents", "Helpers", "whisper-cli"));
    expect(cfg.whisperServerBin).toBe(join(app, "Contents", "Helpers", "whisper-server"));
    expect(cfg.soxBin).toBe(join(app, "Contents", "Helpers", "sox"));
    expect(cfg.vadModel).toBe(join(app, "Contents", "Resources", "models", VAD_MODEL.file));
    expect(cfg.speechEngine.sox.source).toBe("conch.app");
  });
});

// MARK: - The fetch

function pinFor(bytes: Uint8Array, url: string): PinnedModel {
  return { file: "model.bin", url, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, label: "test" };
}

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: `http://127.0.0.1:${server.port}/model.bin`, stop: () => server.stop(true) };
}

const BODY = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);

describe("a pinned model lands only as the exact bytes it was pinned to", () => {
  test("the right bytes are hashed as they land and moved into place", async () => {
    const root = scratch();
    const server = serve(() => new Response(BODY));
    try {
      const dest = join(root, "model.bin");
      const seen: number[] = [];
      await fetchPinnedModel(pinFor(BODY, server.url), dest, { onProgress: (bytes) => seen.push(bytes) });
      expect(new Uint8Array(readFileSync(dest))).toEqual(BODY);
      expect(existsSync(`${dest}.part`)).toBeFalse();
      expect(seen.at(-1)).toBe(BODY.byteLength);
    } finally {
      server.stop();
    }
  });

  test("a wrong digest never lands: no model, no partial", async () => {
    const root = scratch();
    const tampered = BODY.slice();
    tampered[1234] ^= 0xff;
    const server = serve(() => new Response(tampered));
    try {
      const dest = join(root, "model.bin");
      await expect(fetchPinnedModel(pinFor(BODY, server.url), dest)).rejects.toThrow(/sha256 [0-9a-f]{64} is not the pinned/);
      expect(existsSync(dest)).toBeFalse();
      expect(existsSync(`${dest}.part`)).toBeFalse();
    } finally {
      server.stop();
    }
  });

  test("a short or oversized download, or an HTTP error, fails", async () => {
    const root = scratch();
    const short = serve(() => new Response(BODY.slice(0, 1000)));
    const long = serve(() => new Response(new Uint8Array(BODY.byteLength + 10)));
    const missing = serve(() => new Response("no", { status: 404 }));
    try {
      await expect(fetchPinnedModel(pinFor(BODY, short.url), join(root, "a.bin"))).rejects.toThrow(/size 1000 is not the pinned/);
      await expect(fetchPinnedModel(pinFor(BODY, long.url), join(root, "b.bin"))).rejects.toThrow(/more than the pinned/);
      await expect(fetchPinnedModel(pinFor(BODY, missing.url), join(root, "c.bin"))).rejects.toThrow("HTTP 404");
      expect(existsSync(join(root, "a.bin"))).toBeFalse();
    } finally {
      short.stop();
      long.stop();
      missing.stop();
    }
  });

  test("an interrupted download resumes from its partial with a Range request, and the whole is verified", async () => {
    const root = scratch();
    const dest = join(root, "model.bin");
    writeFileSync(`${dest}.part`, BODY.slice(0, 100_000));
    const ranges: (string | null)[] = [];
    const server = serve((req) => {
      ranges.push(req.headers.get("range"));
      return new Response(BODY.slice(100_000), {
        status: 206,
        headers: { "content-range": `bytes 100000-${BODY.byteLength - 1}/${BODY.byteLength}` },
      });
    });
    try {
      await fetchPinnedModel(pinFor(BODY, server.url), dest);
      expect(ranges).toEqual(["bytes=100000-"]);
      expect(new Uint8Array(readFileSync(dest))).toEqual(BODY);
    } finally {
      server.stop();
    }
  });

  test("a server that ignores the Range sends everything, and the partial is started over", async () => {
    const root = scratch();
    const dest = join(root, "model.bin");
    writeFileSync(`${dest}.part`, new Uint8Array(100_000).fill(9)); // wrong bytes: must not survive
    const server = serve(() => new Response(BODY));
    try {
      await fetchPinnedModel(pinFor(BODY, server.url), dest);
      expect(new Uint8Array(readFileSync(dest))).toEqual(BODY);
    } finally {
      server.stop();
    }
  });

  test("a resume that starts somewhere else is refused and its partial dropped", async () => {
    const root = scratch();
    const dest = join(root, "model.bin");
    writeFileSync(`${dest}.part`, BODY.slice(0, 100_000));
    const server = serve(() => new Response(BODY.slice(50_000), { status: 206, headers: { "content-range": `bytes 50000-${BODY.byteLength - 1}/${BODY.byteLength}` } }));
    try {
      await expect(fetchPinnedModel(pinFor(BODY, server.url), dest)).rejects.toThrow("resumed from the wrong place");
      expect(existsSync(`${dest}.part`)).toBeFalse();
    } finally {
      server.stop();
    }
  });

  test("a stalled connection fails the attempt instead of hanging it", async () => {
    const root = scratch();
    const server = serve(() => new Response(new ReadableStream({
      start(controller) { controller.enqueue(BODY.slice(0, 10)); }, // then nothing, forever
    })));
    try {
      await expect(fetchPinnedModel(pinFor(BODY, server.url), join(root, "m.bin"), { stallMs: 200 })).rejects.toThrow("no data for");
    } finally {
      server.stop();
    }
  });

  test("the pins are seashell's, and `conch setup`'s downloader checks the same digest", async () => {
    expect(WHISPER_MODEL.sha256).toBe("394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2");
    expect(WHISPER_MODEL.bytes).toBe(574_041_195);
    expect(VAD_MODEL.sha256).toBe("2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987");
    const root = scratch();
    const server = serve(() => new Response(BODY));
    const out = { write: () => {}, tty: false };
    try {
      const pin = pinFor(BODY, server.url);
      await downloadModel({ url: server.url, label: "x", minBytes: 1, sha256: pin.sha256 }, join(root, "ok.bin"), out);
      expect(existsSync(join(root, "ok.bin"))).toBeTrue();
      await expect(downloadModel({ url: server.url, label: "x", minBytes: 1, sha256: "0".repeat(64) }, join(root, "bad.bin"), out))
        .rejects.toThrow("checksum mismatch");
      expect(existsSync(join(root, "bad.bin"))).toBeFalse();
      expect(existsSync(join(root, "bad.bin.part"))).toBeFalse();
    } finally {
      server.stop();
    }
  });
});

// MARK: - The daemon's manager

function engineAt(root: string, overrides: Partial<SpeechEngine> = {}): SpeechEngine {
  const found = (path: string, source: "conch.app" | "conch" = "conch.app") => ({ path, source, found: true });
  return {
    whisperCli: found("/app/whisper-cli"),
    whisperServer: found("/app/whisper-server"),
    whisperModel: { path: join(root, "models", "whisper.bin"), source: "missing", found: false },
    vadModel: found("/app/vad.bin"),
    sox: found("/app/sox"),
    ...overrides,
  };
}

interface Harness {
  manager: SpeechEngineManager;
  statuses: SpeechEngineStatus[];
  logs: string[];
  sleeps: number[];
  fetches: string[];
}

function harness(root: string, options: {
  engine?: SpeechEngine;
  fetch?: (model: PinnedModel, dest: string, options: FetchModelOptions) => Promise<void>;
  now?: () => number;
  watchMs?: number;
} = {}): Harness {
  const statuses: SpeechEngineStatus[] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const fetches: string[] = [];
  const pin: PinnedModel = { file: "whisper.bin", url: "http://example.invalid/w", sha256: "a".repeat(64), bytes: 10, label: "whisper" };
  const manager = new SpeechEngineManager({
    engine: options.engine ?? engineAt(root),
    daemon: { version: "9.9.9", path: "/app/conch-daemon" },
    log: (line) => logs.push(line),
    onStatus: (status) => statuses.push(status),
    statusPath: join(root, "speech-engine.json"),
    failuresPath: join(root, "models", "fetch-failures.json"),
    whisperModel: pin,
    tmux: () => null,
    fetchModel: async (model, dest, fetchOptions) => {
      fetches.push(dest);
      await (options.fetch ?? (async (_m, d) => { mkdirSync(join(root, "models"), { recursive: true }); writeFileSync(d, "model"); }))(model, dest, fetchOptions);
    },
    sleep: async (ms) => { sleeps.push(ms); return true; },
    now: options.now,
    watchMs: options.watchMs,
    progressEveryMs: 0,
  });
  return { manager, statuses, logs, sleeps, fetches };
}

describe("the daemon fetches what the app cannot carry, and says where it stands", () => {
  test("first run: checking, downloading with progress, then ready — and whisper-server may start", async () => {
    const root = scratch();
    const h = harness(root, {
      fetch: async (_model, dest, options) => {
        options.onProgress?.(0, 10);
        options.onProgress?.(5, 10);
        options.onProgress?.(10, 10);
        mkdirSync(join(root, "models"), { recursive: true });
        writeFileSync(dest, "model");
      },
    });
    const ready = h.manager.modelReady();
    await h.manager.start();
    expect(await ready).toBeTrue();
    expect(h.statuses[0]!.state).toBe("checking");
    const downloading = h.statuses.filter((status) => status.state === "downloading");
    expect(downloading.map((status) => status.progress?.bytes)).toContain(5);
    expect(downloading[0]!.detail).toContain("downloading the whisper model");
    const last = h.statuses.at(-1)!;
    expect(last.state).toBe("ready");
    expect(last.parts.model.source).toBe("conch");
    expect(last.parts.capture).toEqual({ source: "conch.app", path: "/app/sox" });
    expect(last.parts.tmux).toEqual({ found: false });
    expect(last.daemon).toEqual({ version: "9.9.9", path: "/app/conch-daemon" });
    expect(describeSpeechEngine(last)).toStartWith("Speech engine: ready — whisper from the app, model from conch's download, capture from the app");
    // Written with our pid, for `conch doctor`.
    expect(JSON.parse(readFileSync(join(root, "speech-engine.json"), "utf8")).pid).toBe(process.pid);
  });

  test("a model already resolved is never fetched", async () => {
    const root = scratch();
    const h = harness(root, { engine: engineAt(root, { whisperModel: { path: "/seashell/models/w.bin", source: "seashell", found: true } }) });
    await h.manager.start();
    expect(h.fetches).toEqual([]);
    expect(await h.manager.modelReady()).toBeTrue();
    expect(h.statuses.at(-1)!.state).toBe("ready");
  });

  test("the VAD model is fetched too when nothing carries it, before the whisper model", async () => {
    const root = scratch();
    const h = harness(root, { engine: engineAt(root, { vadModel: { path: join(root, "models", "vad.bin"), source: "missing", found: false } }) });
    await h.manager.start();
    expect(h.fetches).toEqual([join(root, "models", "vad.bin"), join(root, "models", "whisper.bin")]);
  });

  test("failures retry now, in a minute, in five — then stop and say why; whisper-server keeps waiting for a model", async () => {
    const root = scratch();
    const h = harness(root, { fetch: async () => { throw new Error("connection reset"); } });
    let settled: boolean | null = null;
    const ready = h.manager.modelReady().then((value) => (settled = value));
    await h.manager.start();
    expect(h.fetches).toHaveLength(3);
    expect(h.sleeps).toEqual([0, 60_000, 300_000]);
    // Still waiting: a model `conch setup` places later starts whisper-server (next test).
    await Bun.sleep(5);
    expect(settled).toBeNull();
    const last = h.statuses.at(-1)!;
    expect(last.state).toBe("off");
    expect(last.reason).toBe("download failed");
    expect(last.detail).toContain("connection reset");
    expect(last.detail).toContain("`conch setup` tries again");
    h.manager.close();
    expect(await ready).toBeFalse(); // a shutdown releases the wait
  });

  test("the bound holds across restarts: three failures in a day, and the next daemon does not try", async () => {
    const root = scratch();
    const first = harness(root, { fetch: async () => { throw new Error("offline"); } });
    await first.manager.start();
    first.manager.close();
    expect(readFetchFailures(join(root, "models", "fetch-failures.json"), "a".repeat(64))?.count).toBe(3);
    const second = harness(root, { fetch: async () => { throw new Error("offline"); } });
    await second.manager.start();
    expect(second.fetches).toEqual([]);
    expect(second.statuses.at(-1)!.detail).toContain("failed to download 3 times");
    second.manager.close();
    // A day later, it tries again.
    const later = harness(root, { now: () => Date.now() + 25 * 60 * 60_000 });
    await later.manager.start();
    expect(later.fetches).toHaveLength(1);
    expect(later.statuses.at(-1)!.state).toBe("ready");
  });

  test("after giving up, a model placed by `conch setup` is noticed and adopted", async () => {
    const root = scratch();
    const h = harness(root, { fetch: async () => { throw new Error("offline"); }, watchMs: 20 });
    const ready = h.manager.modelReady();
    await h.manager.start();
    expect(h.statuses.at(-1)!.state).toBe("off");
    mkdirSync(join(root, "models"), { recursive: true });
    writeFileSync(join(root, "models", "whisper.bin"), "placed by setup");
    for (let i = 0; i < 100 && h.statuses.at(-1)!.state !== "ready"; i++) await Bun.sleep(10);
    await h.manager.settled();
    expect(h.statuses.at(-1)!.state).toBe("ready");
    expect(await ready).toBeTrue(); // and whisper-server starts
    h.manager.close();
  });

  test("another conch process holding the fetch lock is waited for, not raced", async () => {
    const root = scratch();
    const dest = join(root, "models", "whisper.bin");
    mkdirSync(join(root, "models"), { recursive: true });
    writeFileSync(`${dest}.lock`, String(process.ppid)); // alive, and not us
    const h = harness(root);
    let slept = 0;
    // The first wait sees the other process finish: it removes its lock and leaves the model.
    (h.manager as unknown as { options: { sleep: (ms: number) => Promise<boolean> } }).options.sleep = async (ms) => {
      h.sleeps.push(ms);
      if (ms === 5_000 && slept++ === 0) {
        writeFileSync(dest, "fetched by the other process");
        rmSync(`${dest}.lock`);
      }
      return true;
    };
    await h.manager.start();
    expect(h.fetches).toEqual([]);
    expect(h.statuses.some((status) => status.detail.includes(`another conch process (pid ${process.ppid})`))).toBeTrue();
    expect(h.statuses.at(-1)!.state).toBe("ready");
  });

  test("a stale lock from a dead process is taken over", () => {
    const root = scratch();
    const dest = join(root, "m.bin");
    writeFileSync(`${dest}.lock`, "2147483646");
    const held = acquireFetchLock(dest);
    expect("release" in held).toBeTrue();
    if ("release" in held) held.release();
    expect(existsSync(`${dest}.lock`)).toBeFalse();
  });

  test("a missing explicit model is a setting to fix, not a download", async () => {
    const root = scratch();
    const h = harness(root, { engine: engineAt(root, { whisperModel: { path: "/custom/w.bin", source: "explicit", found: false } }) });
    await h.manager.start();
    expect(h.fetches).toEqual([]);
    expect(h.statuses.at(-1)).toMatchObject({ state: "off", reason: "CONCH_WHISPER_MODEL not found" });
    expect(await h.manager.modelReady()).toBeFalse();
  });

  test("no whisper at all, or no sox, is off — and says what carries them", async () => {
    const root = scratch();
    const missing = { path: "/nowhere", source: "missing" as const, found: false };
    const noWhisper = harness(root, { engine: engineAt(root, { whisperCli: missing, whisperServer: missing }) });
    await noWhisper.manager.start();
    expect(noWhisper.statuses.at(-1)).toMatchObject({ state: "off", reason: "no whisper" });
    expect(await noWhisper.manager.modelReady()).toBeFalse();
    const noSox = harness(scratch(), { engine: engineAt(root, { sox: { path: "sox", source: "missing", found: false }, whisperModel: { path: "/m", source: "seashell", found: true } }) });
    await noSox.manager.start();
    expect(noSox.statuses.at(-1)).toMatchObject({ state: "off", reason: "no sox" });
    expect(noSox.statuses.at(-1)!.detail).toContain("the conch app carries one");
    // whisper-server can still load: transcription does not need the mic.
    expect(await noSox.manager.modelReady()).toBeTrue();
  });

  test("closing stops a fetch in flight and releases whoever waits on the model", async () => {
    const root = scratch();
    let aborted = false;
    const h = harness(root, {
      fetch: (_model, _dest, options) => new Promise((_, reject) => {
        options.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
      }),
    });
    const ready = h.manager.modelReady();
    const started = h.manager.start();
    await Bun.sleep(5);
    h.manager.close();
    await started;
    expect(aborted).toBeTrue();
    expect(await ready).toBeFalse();
    expect(readFetchFailures(join(root, "models", "fetch-failures.json"), "a".repeat(64))).toBeNull(); // a shutdown is not a failure
  });

  test("the doctor reads the live daemon's status, or says where each part resolves", () => {
    const status = { state: "downloading", detail: "downloading the whisper model", progress: { bytes: 287_020_598, total: 574_041_195 }, pid: 42 } as unknown as SpeechEngineStatus & { pid: number };
    expect(checkSpeechEngine({ speechEngine: engineAt("/r") }, { published: () => status }).message)
      .toBe("Speech engine: downloading… 50% — downloading the whisper model (daemon 42).");
    const offline = checkSpeechEngine({ speechEngine: engineAt("/r") }, { published: () => null });
    expect(offline.message).toContain("whisper-cli from the app (/app/whisper-cli)");
    expect(offline.message).toContain("model missing (/r/models/whisper.bin)");
    expect(offline.action).toContain("conch setup");
    expect(offline.ok).toBeFalse();
  });
});

describe("the capture and the published state use it", () => {
  test("the capture runs the resolved sox — the app's — and the orphan reaper still knows it as conch's", async () => {
    const { soxCaptureArgs, narrationSoxArgs } = await import("../src/listen.ts");
    const { isConchSox } = await import("../src/sox-orphan.ts");
    const app = "/Users/tester/Downloads/conch 2.app/Contents/Helpers/sox";
    const capture = soxCaptureArgs({ micGainDb: 0, endSilenceSecs: 3.5, endThresholdPct: 2, soxBin: app }, "/tmp/conch-normal-1-2.raw", 2);
    expect(capture[0]).toBe(app);
    expect(isConchSox(capture.join(" "))).toBeTrue();
    const wav = "/Users/tester/.cache/conch/canvas/0f8fad5b-d9cb-469f-a165-70867728950e/narration.wav";
    const narration = narrationSoxArgs({ micGainDb: 0, soxBin: app }, wav, 150);
    expect(narration[0]).toBe(app);
    expect(isConchSox(narration.join(" "))).toBeTrue();
    // A config without one (older callers, tests) still spawns bare `sox` from PATH.
    expect(soxCaptureArgs({ micGainDb: 0, endSilenceSecs: 3.5, endThresholdPct: 2 }, "/tmp/conch-normal-1-2.raw", 2)[0]).toBe("sox");
  });

  test("the published state carries the engine status, as a copy", async () => {
    const { buildPanelModel, buildPublishedState } = await import("../src/panel.ts");
    const model = buildPanelModel({
      sessions: [],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      now: 10_000,
    });
    const root = scratch();
    const h = harness(root);
    await h.manager.start();
    const speechEngine = h.manager.snapshot();
    const state = buildPublishedState("device", model, new Map(), new Set(), 10_000, { speechEngine });
    expect(state.speechEngine).toEqual(speechEngine);
    expect(state.speechEngine).not.toBe(speechEngine);
    expect("speechEngine" in buildPublishedState("device", model, new Map(), new Set(), 10_000)).toBeFalse();
  });

  test("Settings shows it beside the natural voices: ready, downloading with a percentage, checking, off (reason)", () => {
    const settings = readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "SettingsView.swift"), "utf8");
    const status = settings.slice(settings.indexOf("private struct SpeechEngineStatus"), settings.indexOf("private struct NaturalVoicesEnvelope"));
    expect(status).toContain('case "ready": return "Speech engine: ready"');
    expect(status).toContain('return "Speech engine: downloading… \\(Int((progress.bytes / progress.total * 100).rounded(.down)))%"');
    expect(status).toContain('case "checking": return "Speech engine: checking…"');
    expect(status).toContain('default: return "Speech engine: off" + (reason.map { " (\\($0))" } ?? "")');
    // Decoded on its own, so a status shaped differently never hides the voices' line.
    expect(settings).toContain("(try? JSONDecoder().decode(SpeechEngineEnvelope.self, from: data))?.speechEngine");
    const section = settings.slice(settings.indexOf("private struct SessionVoicesSection"), settings.indexOf("private struct NaturalVoicesStatus"));
    expect(section).toContain("Text(engine.headline)");
    expect(section.indexOf("Text(engine.headline)")).toBeLessThan(section.indexOf("Text(natural.headline)"));
  });
});

describe("the daemon is wired to it", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

  test("whisper-server starts only once the engine says the model is in place", () => {
    const wait = daemon.indexOf(".then(() => speechEngine.modelReady())");
    expect(wait).toBeGreaterThan(-1);
    expect(daemon.slice(wait, wait + 200)).toContain(".then((ready) => (ready ? supervisor.start() : false))");
    expect(daemon.indexOf("void reapOrphanedWhisper(cfg.whisperPort)")).toBeLessThan(wait);
  });

  test("only the socket's owner fetches, and a shutdown stops the fetch", () => {
    const owner = daemon.indexOf("writeIdentity(undefined, { socketPath: cfg.socketPath });\n");
    expect(owner).toBeGreaterThan(-1);
    expect(daemon.indexOf("void speechEngine.start();")).toBeGreaterThan(owner);
    expect(daemon).toContain("speechEngine.close();");
  });

  test("its status is published beside the natural voices", () => {
    expect(daemon).toContain("naturalVoices,\n        speechEngineStatus,\n      );");
    const panel = readFileSync(join(import.meta.dir, "..", "src", "panel.ts"), "utf8");
    expect(panel).toContain("...(options.speechEngine ? { speechEngine: structuredClone(options.speechEngine) } : {}),");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DIGITAL_SILENCE_COOLOFF_MS,
  embeddedHelperProtocol,
  MICROPHONE_HELPER_NAME,
  microphoneAttribution,
  MicrophoneRecorders,
  microphoneRuntimeDir,
  parseMicrophoneStatus,
  prepareMicrophoneHelper,
  type HelperRunner,
  type MicrophoneAuthorization,
} from "../src/microphone-helper.ts";
import { resolveSpeechEngine } from "../src/speech-engine.ts";

/**
 * conch Microphone's installed copy, its permission, and when conch records
 * with sox instead. The helper is a stand-in file with the Info.plist a real
 * build embeds; nothing here runs a recorder or asks macOS anything.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "conch-microphone-helper-"));
  roots.push(root);
  return root;
}

function helper(root: string, name: string, protocol: number | null, body = "binary"): string {
  const path = join(root, name);
  const plist = protocol === null
    ? ""
    : `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.blueprintstudio.conch.microphone</string>`
      + `<key>ConchHelperProtocol</key><string>${protocol}</string></dict></plist>`;
  writeFileSync(path, `Ïúíþ${body}\u0000${plist}\u0000rest`, "latin1");
  chmodSync(path, 0o755);
  return path;
}

describe("the installed copy", () => {
  test("reads the protocol from the embedded Info.plist, and nothing from a binary that is not conch Microphone", () => {
    const root = scratch();
    expect(embeddedHelperProtocol(helper(root, "one", 1))).toBe(1);
    expect(embeddedHelperProtocol(helper(root, "seven", 7))).toBe(7);
    expect(embeddedHelperProtocol(helper(root, "none", null))).toBeUndefined();
    const seashell = join(root, "seashell");
    writeFileSync(seashell, `<plist><string>com.humain.seashell.microphone</string><key>SeashellHelperProtocol</key><string>3</string></plist>`);
    expect(embeddedHelperProtocol(seashell)).toBeUndefined();
  });

  test("is made once, private, under a stable name, and kept across a rebuild that speaks the same protocol", () => {
    const root = scratch();
    const runtime = join(root, "Runtime");
    const first = prepareMicrophoneHelper(helper(root, "build-1", 1, "first"), runtime);
    expect(first).toBe(join(runtime, MICROPHONE_HELPER_NAME));
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
    expect(statSync(first).mode & 0o777).toBe(0o700);
    // A rebuilt app: other bytes, the same protocol. macOS gave the permission to the copy, so it stays.
    expect(prepareMicrophoneHelper(helper(root, "build-2", 1, "second"), runtime)).toBe(first);
    expect(readFileSync(first, "latin1")).toContain("first");
    // A new protocol replaces it, and macOS asks once more.
    prepareMicrophoneHelper(helper(root, "build-3", 2, "third"), runtime);
    expect(readFileSync(first, "latin1")).toContain("third");
    expect(embeddedHelperProtocol(first)).toBe(2);
  });

  test("refuses a source that is not conch Microphone, and a copy that is a link", () => {
    const root = scratch();
    expect(() => prepareMicrophoneHelper(helper(root, "plain", null), join(root, "a"))).toThrow(/not conch Microphone/);
    const runtime = join(root, "b");
    mkdirSync(runtime, { recursive: true });
    symlinkSync(helper(root, "elsewhere", 1), join(runtime, MICROPHONE_HELPER_NAME));
    expect(() => prepareMicrophoneHelper(helper(root, "source", 1), runtime)).toThrow(/not a link/);
  });

  test("lives in conch's own Application Support folder, never seashell's", () => {
    expect(microphoneRuntimeDir({}, "/Users/someone")).toBe("/Users/someone/Library/Application Support/conch/Runtime");
    expect(microphoneRuntimeDir({ CONCH_MICROPHONE_RUNTIME_DIR: "/tmp/x" }, "/Users/someone")).toBe("/tmp/x");
  });

  test("the engine finds the app's conch Microphone or an explicit one, and never seashell's recorder", () => {
    const root = scratch();
    const app = join(root, "conch.app");
    mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
    const inApp = join(app, "Contents", "Helpers", "conch-microphone");
    const seashellHelper = join(root, "seashell", "native", "bin", "seashell-microphone");
    const executable = (path: string) => path === inApp || path === seashellHelper || path === "/custom/mic";
    const base = { home: root, file: () => false, which: () => null, brewPrefixes: [join(root, "brew")] };
    const fromApp = resolveSpeechEngine({ ...base, env: { CONCH_APP_BUNDLE: app, CONCH_SEASHELL_ROOT: join(root, "seashell") }, executable });
    expect(fromApp.microphone).toEqual({ path: inApp, source: "conch.app", found: true });
    const explicit = resolveSpeechEngine({ ...base, env: { CONCH_APP_BUNDLE: app, CONCH_MICROPHONE: "/custom/mic" }, executable });
    expect(explicit.microphone).toEqual({ path: "/custom/mic", source: "explicit", found: true });
    const none = resolveSpeechEngine({ ...base, env: { CONCH_APP_BUNDLE: join(root, "old.app"), CONCH_SEASHELL_ROOT: join(root, "seashell") }, executable });
    expect(none.microphone.found).toBeFalse();
  });
});

describe("its permission", () => {
  test("reads --status's JSON, and anything else as unknown", () => {
    expect(parseMicrophoneStatus('{"authorization":"authorized","executable":"/x","responsibleForItself":true}\n')).toBe("authorized");
    expect(parseMicrophoneStatus('{"authorization":"notDetermined"}')).toBe("notDetermined");
    expect(parseMicrophoneStatus('{"authorization":"denied"}')).toBe("denied");
    expect(parseMicrophoneStatus("")).toBe("unknown");
    expect(parseMicrophoneStatus("Usage: conch-microphone")).toBe("unknown");
  });
});

describe("which recorder the next capture uses, and whose permission it records under", () => {
  function recorders(answers: MicrophoneAuthorization[], start = 1_000) {
    let now = start;
    const runs: string[][] = [];
    const lines: string[] = [];
    const run: HelperRunner = async (argv) => {
      runs.push(argv);
      const authorization = answers.length > 1 ? answers.shift()! : answers[0]!;
      return { code: authorization === "authorized" ? 0 : 77, stdout: JSON.stringify({ authorization }) };
    };
    const r = new MicrophoneRecorders({ run, prepare: () => "/Runtime/conch Microphone", now: () => now, log: (line) => lines.push(line) });
    return { r, runs, lines, advance: (ms: number) => (now += ms) };
  }

  test("a daemon the app or a terminal started runs the app's own helper under that app's permission, and asks nothing", async () => {
    expect(microphoneAttribution("app")).toBe("attributed");
    expect(microphoneAttribution("terminal")).toBe("attributed");
    const { r, runs } = recorders(["notDetermined"]);
    await r.start("/app/Contents/Helpers/conch-microphone", "attributed");
    // Looked at, not asked for: the app owns that question (Permissions.swift).
    expect(runs).toEqual([["/app/Contents/Helpers/conch-microphone", "--status", "--no-disclaim"]]);
    expect(r.choose({})).toEqual({
      kind: "native",
      path: "/app/Contents/Helpers/conch-microphone",
      args: ["--sample-rate", "16000", "--no-disclaim"],
    });
    expect(r.permissionName).toBe("conch");
  });

  test("under launchd it records from the installed copy under its own permission, asked for once at start", async () => {
    expect(microphoneAttribution("launchd")).toBe("own");
    const { r, runs, lines } = recorders(["notDetermined", "authorized"]);
    await r.start("/app/Contents/Helpers/conch-microphone", "own");
    expect(runs).toEqual([
      ["/Runtime/conch Microphone", "--status"],
      ["/Runtime/conch Microphone", "--request-permission"],
    ]);
    expect(lines).toContain("conch Microphone has not been allowed the microphone yet — macOS asks once now");
    expect(r.choose({})).toEqual({ kind: "native", path: "/Runtime/conch Microphone", args: ["--sample-rate", "16000"] });
    expect(r.permissionName).toBe("conch Microphone");
    expect(r.snapshot().authorization).toBe("authorized");
  });

  test("the recorder setting can choose sox; an app without the helper, or a daemon that never started it, records with sox", async () => {
    const { r } = recorders(["authorized"]);
    await r.start("/app/conch-microphone");
    expect(r.choose({ recorder: "sox" })).toEqual({ kind: "sox", why: "the recorder setting is sox" });
    expect(recorders(["authorized"]).r.choose({}).kind).toBe("sox");
    await r.start(null);
    expect(r.choose({})).toEqual({ kind: "sox", why: "no conch Microphone in this conch.app" });
    const broken = new MicrophoneRecorders({ prepare: () => { throw new Error("disk full"); }, run: async () => ({ code: 0, stdout: "" }) });
    await broken.start("/app/conch-microphone", "own");
    expect(broken.choose({})).toEqual({ kind: "sox", why: "conch Microphone could not be installed: disk full" });
  });

  test("a refused permission is said once, naming the switch, and is not hidden behind sox's silence", async () => {
    const { r, lines } = recorders(["denied"]);
    await r.start("/app/conch-microphone");
    expect(lines.filter((line) => line.startsWith("Microphone access is denied for conch —"))).toHaveLength(1);
    // sox answers to the same app: it would record zeros nobody notices. The helper's refusal is the error.
    expect(r.choose({}).kind).toBe("native");
    r.reportPermissionRefused();
    r.reportPermissionRefused();
    expect(lines.filter((line) => line.includes("Microphone access is"))).toHaveLength(1);
  });

  test("digital silence sends captures to sox for a while, then conch Microphone is tried again", async () => {
    const { r, advance } = recorders(["authorized"]);
    await r.start("/app/conch-microphone");
    r.reportDigitalSilence();
    expect(r.choose({})).toEqual({ kind: "sox", why: "conch Microphone recorded digital silence" });
    advance(DIGITAL_SILENCE_COOLOFF_MS);
    expect(r.choose({}).kind).toBe("native");
  });

  test("says which recorder captures when it changes, not at every capture", async () => {
    const { r, lines } = recorders(["authorized"]);
    await r.start("/app/conch-microphone");
    r.choose({});
    r.choose({});
    r.choose({ recorder: "sox" });
    r.choose({});
    expect(lines.filter((line) => line.startsWith("capturing with"))).toEqual([
      "capturing with conch Microphone (/app/conch-microphone, under the app's Microphone permission)",
      "capturing with sox — the recorder setting is sox",
      "capturing with conch Microphone (/app/conch-microphone, under the app's Microphone permission)",
    ]);
  });

  test("shutdown withdraws a question still on screen", async () => {
    let aborted = false;
    const r = new MicrophoneRecorders({
      prepare: () => "/Runtime/conch Microphone",
      run: (argv, _timeout, signal) => argv[1] === "--status"
        ? Promise.resolve({ code: 0, stdout: '{"authorization":"notDetermined"}' })
        : new Promise((resolve) => signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ code: null, stdout: "" });
        })),
    });
    const started = r.start("/app/conch-microphone", "own");
    await Bun.sleep(0);
    r.close();
    await started;
    expect(aborted).toBeTrue();
  });
});

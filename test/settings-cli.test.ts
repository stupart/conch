import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface CliFixture {
  root: string;
  configDir: string;
  settingsPath: string;
  socketPath: string;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

function fixture(settings?: unknown): CliFixture {
  const root = mkdtempSync("/tmp/conch-cli-test-");
  roots.push(root);
  const configDir = join(root, "config");
  const settingsPath = join(configDir, "settings.json");
  if (settings !== undefined) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsPath, typeof settings === "string" ? settings : `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { root, configDir, settingsPath, socketPath: join(root, "daemon.sock") };
}

function cleanEnv(f: CliFixture, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CONCH_") || key === "CLAUDE_CONFIG_DIR") continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: f.root,
    CLAUDE_CONFIG_DIR: join(f.root, "claude"),
    CONCH_CONFIG_DIR: f.configDir,
    CONCH_SOCKET: f.socketPath,
    NO_COLOR: "1",
    ...extra,
  };
}

async function runCli(
  f: CliFixture,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    cwd: join(import.meta.dir, ".."),
    env: cleanEnv(f, extraEnv),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 5_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("settings CLI without a daemon", () => {
  test("set persists a native value and honestly reports daemon-down", async () => {
    const f = fixture();
    const result = await runCli(f, ["set", "end-silence", "4.75"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("saved");
    expect(result.stdout).toContain("daemon-down");
    expect(result.stdout).toContain("next start");
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8"))).toEqual({ "end-silence": 4.75 });
  });

  test("a daemon-down env mask distinguishes the saved value from the effective value", async () => {
    const f = fixture();
    const result = await runCli(f, ["set", "end-silence", "4"], {
      CONCH_END_SILENCE_SECS: "7",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("end-silence = 4 — saved");
    expect(result.stdout).toContain("masked-by-env CONCH_END_SILENCE_SECS");
    expect(result.stdout).toContain("daemon-down");
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8"))).toEqual({ "end-silence": 4 });
  });

  test("get and settings fall back to local env > file resolution", async () => {
    const f = fixture({
      "end-silence": 4.75,
      "read-full": false,
    });

    const get = await runCli(f, ["get", "end-silence"], { CONCH_END_SILENCE_SECS: "6.5" });
    expect(get.exitCode).toBe(0);
    expect(get.stdout).toContain("daemon-down");
    expect(get.stdout).toContain("end-silence");
    expect(get.stdout).toContain("6.5");
    expect(get.stdout).toContain("CONCH_END_SILENCE_SECS");

    const settings = await runCli(f, ["settings"]);
    expect(settings.exitCode).toBe(0);
    expect(settings.stdout).toContain("daemon-down");
    expect(settings.stdout).toContain("end-silence");
    expect(settings.stdout).toContain("4.75");
    expect(settings.stdout).toContain("read-full");
    expect(settings.stdout).toContain("false");
    expect(settings.stdout).toContain("file");
    expect(settings.stdout).toContain("announce-sentences");
    expect(settings.stdout).toContain("announce-max-chars");
  });

  test("settings advises when the hold timer is no longer than utterance endpointing", async () => {
    const risky = fixture({
      "end-silence": 1,
      "hold-submit-delay": 1,
    });
    const warning = await runCli(risky, ["settings"]);
    expect(warning.exitCode).toBe(0);
    expect(warning.stdout).toContain("advisory: hold-submit-delay (1s) <= end-silence (1s)");
    expect(warning.stdout).toContain("can fire before the utterance is considered ended");

    const safe = fixture({
      "end-silence": 1,
      "hold-submit-delay": 1.01,
    });
    const noWarning = await runCli(safe, ["settings"]);
    expect(noWarning.exitCode).toBe(0);
    expect(noWarning.stdout).not.toContain("advisory:");
  });

  test("unset removes only the requested key and reports the fallback", async () => {
    const f = fixture({
      "end-silence": 4.75,
      "read-full": false,
    });
    const result = await runCli(f, ["unset", "end-silence"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("daemon-down");
    expect(result.stdout).toContain("default");
    expect(JSON.parse(readFileSync(f.settingsPath, "utf8"))).toEqual({ "read-full": false });
  });

  test("a corrupt settings file is preserved when set fails", async () => {
    const corrupt = "{ definitely not json\n";
    const f = fixture(corrupt);
    const result = await runCli(f, ["set", "read-full", "false"]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).toContain("settings");
    expect(readFileSync(f.settingsPath, "utf8")).toBe(corrupt);
  });

  test("invalid values and prototype keys fail without creating settings.json", async () => {
    const invalid = fixture();
    const invalidResult = await runCli(invalid, ["set", "barge-threshold", "101"]);
    expect(invalidResult.exitCode).not.toBe(0);

    const prototype = fixture();
    const prototypeResult = await runCli(prototype, ["set", "__proto__", "1"]);
    expect(prototypeResult.exitCode).not.toBe(0);
    expect(existsSync(invalid.settingsPath)).toBe(false);
    expect(existsSync(prototype.settingsPath)).toBe(false);
  });
});

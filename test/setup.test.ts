import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  hardDependencyInstallCommand,
  missingHardDependencies,
  parseSetupArgs,
  renderHardDependencyFailure,
  REVIEW_INSTRUCTIONS_BLOCK,
  renderSetupReady,
  runInstall,
  runSetupIntegrations,
} from "../src/install.ts";

describe("one-command setup", () => {
  test("enables the service and plugin by default and parses either opt-out order", () => {
    expect(parseSetupArgs([])).toEqual({ service: true, plugin: true });
    expect(parseSetupArgs(["--no-service"])).toEqual({
      service: false,
      plugin: true,
    });
    expect(parseSetupArgs(["--no-plugin", "--no-service"])).toEqual({
      service: false,
      plugin: false,
    });
    expect(parseSetupArgs(["--no-service", "--no-plugin"])).toEqual({
      service: false,
      plugin: false,
    });
  });

  test("rejects unknown setup options before doing installation work", () => {
    expect(() => parseSetupArgs(["--no-service", "--mystery"]))
      .toThrow("unknown setup option: --mystery");
  });

  test("runs the shared service then plugin installers with the CLI runtime paths", async () => {
    const calls: string[] = [];
    const cfg = {} as Config;
    const completion = await runSetupIntegrations(
      cfg,
      {
        service: true,
        plugin: true,
        absBun: "/absolute/bun",
        absCli: "/absolute/conch/src/cli.ts",
      },
      {
        service: async (receivedCfg, action) => {
          expect(receivedCfg).toBe(cfg);
          calls.push(`service:${action}`);
        },
        plugin: async (absBun, absCli) => {
          calls.push(`plugin:${absBun}:${absCli}`);
          return true;
        },
      },
    );

    expect(calls).toEqual([
      "service:install",
      "plugin:/absolute/bun:/absolute/conch/src/cli.ts",
    ]);
    expect(completion).toEqual({ service: "installed", plugin: "installed" });
  });

  test("does not call integrations that the user opted out of", async () => {
    const completion = await runSetupIntegrations(
      {} as Config,
      {
        service: false,
        plugin: false,
        absBun: "/absolute/bun",
        absCli: "/absolute/cli.ts",
      },
      {
        service: async () => {
          throw new Error("service should not run");
        },
        plugin: async () => {
          throw new Error("plugin should not run");
        },
      },
    );

    expect(completion).toEqual({ service: "skipped", plugin: "skipped" });
  });

  test("surfaces plugin failure so setup cannot print an unconditional ready claim", async () => {
    const completion = await runSetupIntegrations(
      {} as Config,
      {
        service: false,
        plugin: true,
        absBun: "/absolute/bun",
        absCli: "/absolute/cli.ts",
      },
      {
        service: async () => {},
        plugin: async () => false,
      },
    );

    expect(completion).toEqual({ service: "skipped", plugin: "failed" });
  });

  test("creates the Claude settings directory on a fresh or Codex-only machine", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-setup-hooks-"));
    const claudeDir = join(root, "not-created-yet", ".claude");
    try {
      await runInstall({ claudeDir } as Config);
      const settings = JSON.parse(
        readFileSync(join(claudeDir, "settings.json"), "utf8"),
      );
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Notification).toHaveLength(1);
      expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
      expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8"))
        .toBe(`${REVIEW_INSTRUCTIONS_BLOCK}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ready output puts the already-open-session fix first and preempts mic failure", () => {
    const ready = renderSetupReady(
      { service: "installed", plugin: "installed" },
      { color: false },
    );
    expect(ready.split("\n")[0]).toBe(
      "╭─ 🐚 DO THIS FIRST — Type /hooks in any Claude Code session you already have open.",
    );
    expect(ready).toContain("Sessions opened from now on pick conch up automatically.");
    expect(ready).toContain("THEN — Just finish a turn.");
    expect(ready).toContain("plays a tink, and opens");
    expect(ready).toContain("talk, pause, and your words go back into that session.");
    expect(ready).toContain("macOS will ask for microphone access");
    expect(ready).not.toContain("System Settings");
    expect(ready).toContain("If you miss the prompt, run `conch doctor`.");
    expect(ready).toContain(
      "WHERE TO LOOK — `conch` (the terminal dashboard, also what to use over ssh)",
    );
    expect(ready).not.toContain("Mac app");
    expect(ready).toContain("IF IT'S QUIET — `conch doctor`");
    expect(ready).toContain(
      "installed: hooks · plugin · background service (starts at login) · speech models",
    );
    expect(ready.match(/^│ installed:/gm)).toHaveLength(1);
    expect(ready).not.toMatch(/[✓○✗]/);
    expect(ready.trimEnd().endsWith("╰─")).toBe(true);

    const skipped = renderSetupReady(
      { service: "skipped", plugin: "skipped" },
      { color: false },
    );
    expect(skipped).toContain(
      "THEN — Run `conch daemon` to start the voice loop; leave it open, then",
    );
    expect(skipped).not.toContain("THEN — Just finish a turn.");
    expect(skipped).toContain("installed: hooks · speech models");
    expect(skipped).not.toContain("background service (starts at login)");
    expect(skipped).not.toContain("installed: hooks · plugin");
  });

  test("ready output sends an unwired existing Codex install to its hook installer", () => {
    const ready = renderSetupReady(
      { service: "installed", plugin: "installed" },
      { codexNeedsInstall: true, color: false },
    );
    expect(ready.split("\n")[0]).toBe(
      "╭─ 🐚 DO THIS FIRST — Run `conch install --codex`.",
    );
    expect(ready).not.toContain("Type /hooks");
    expect(ready).toContain("Codex is present, but its lifecycle hooks are not wired yet.");
  });

  test("hard-dependency guidance is copyable and includes Homebrew when absent", () => {
    const missing = missingHardDependencies(
      { whisperCli: "/missing/whisper-cli" },
      () => null,
      () => false,
    );
    expect(missing.map(({ formula }) => formula)).toEqual([
      "sox",
      "tmux",
      "whisper-cpp",
    ]);
    expect(hardDependencyInstallCommand(missing)).toBe(
      "brew install sox tmux whisper-cpp",
    );
    const failure = renderHardDependencyFailure(missing, false);
    expect(failure).toContain("stopped before downloading speech models");
    expect(failure).toContain("https://brew.sh");
    expect(failure.split("\n")).toContain("brew install sox tmux whisper-cpp");
  });

  test("help presents setup as the single entry point in one grouped screen", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const proc = Bun.spawnSync([process.execPath, cli, "help"], {
      env: { ...process.env, NO_COLOR: "1" },
    });
    const stdout = proc.stdout.toString();

    expect(proc.exitCode).toBe(0);
    expect(stdout).toContain("Getting started:");
    expect(stdout).toContain("conch setup                    run this once — installs everything");
    expect(stdout).toContain("Optional / manual setup:");
    expect(stdout).toContain("--no-service");
    expect(stdout).toContain("--no-plugin");
    expect(stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
  });

  test("the setup command rejects unknown flags before starting setup", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const proc = Bun.spawnSync([process.execPath, cli, "setup", "--mystery"]);

    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("unknown setup option: --mystery");
    expect(proc.stdout.toString()).not.toContain("conch setup — getting");
  });
});

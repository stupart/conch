import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import {
  HOOKS_WIRED_LINE,
  downloadModel,
  formatBytes,
  formatProgress,
  hardDependencyInstallCommand,
  INSTALLED_APP_PATH,
  missingHardDependencies,
  parseSetupArgs,
  progressReporter,
  renderHardDependencyFailure,
  renderSetupReady,
  runInstall,
  runSetupIntegrations,
} from "../src/install.ts";

describe("one-command setup", () => {
  test("enables the service and plugin by default and parses either opt-out order", () => {
    // `appInstalled` is pinned so the answer does not depend on whether the
    // machine running the tests has the Mac app in /Applications.
    expect(parseSetupArgs([], false)).toEqual({ service: true, plugin: true });
    expect(parseSetupArgs(["--no-service"], false)).toEqual({
      service: false,
      plugin: true,
    });
    expect(parseSetupArgs(["--no-plugin", "--no-service"], false)).toEqual({
      service: false,
      plugin: false,
    });
    expect(parseSetupArgs(["--no-service", "--no-plugin"], false)).toEqual({
      service: false,
      plugin: false,
    });
  });

  test("leaves the service to an installed Mac app unless --service forces it", () => {
    // The app hosts its own daemon; a launchd service next to it is a second
    // daemon fighting over the socket and the mic (install-journeys, path 2
    // step 3). Forgetting `--no-service` used to be how that happened.
    const left = parseSetupArgs([], true);
    expect(left.service).toBe(false);
    expect(left.plugin).toBe(true);
    expect(left.serviceNotice).toContain(INSTALLED_APP_PATH);
    expect(left.serviceNotice).toContain("`conch setup --service`");

    expect(parseSetupArgs(["--service"], true)).toEqual({ service: true, plugin: true });
    expect(parseSetupArgs(["--no-plugin", "--service"], true)).toEqual({
      service: true,
      plugin: false,
    });
    // An explicit opt-out is not a surprise, so it gets no notice.
    expect(parseSetupArgs(["--no-service"], true)).toEqual({ service: false, plugin: true });
    // Without the app nothing changes, and forcing is a no-op.
    expect(parseSetupArgs(["--service"], false)).toEqual({ service: true, plugin: true });
  });

  test("prints why the service was left off, where it would have been installed", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...data: any[]) => { logs.push(data.map(String).join(" ")); };
    try {
      const completion = await runSetupIntegrations(
        {} as Config,
        {
          service: false,
          serviceNotice: "Skipping the background service: the app owns the daemon.",
          plugin: false,
          absBun: "/absolute/bun",
          absCli: "/absolute/cli.ts",
        },
        {
          service: async () => { throw new Error("service should not run"); },
          plugin: async () => { throw new Error("plugin should not run"); },
        },
      );
      expect(completion).toEqual({ service: "skipped", plugin: "skipped" });
      expect(logs.join("\n")).toContain("Skipping the background service: the app owns the daemon.");
    } finally {
      console.log = originalLog;
    }
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
      // It creates the directory for its hooks and nothing else. This used to
      // assert conch had written a CLAUDE.md here — on a machine with no
      // ~/.claude at all, installing a voice tool would CREATE the user's
      // global instruction file just to hold conch's own review contract.
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);
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

  test("ready output never sends anyone to wire Codex", () => {
    // It used to LEAD with "Run `conch install --codex`", so the first
    // instruction a new person received was the one thing that does not work:
    // Codex 0.144.1 never executes ~/.codex/hooks.json, proven with a bare
    // `touch` hook that did not fire. An unfinished integration should be
    // named honestly and left off, not put at the top of the getting-started.
    const ready = renderSetupReady(
      { service: "installed", plugin: "installed" },
      { codexNeedsInstall: true, color: false },
    );
    expect(ready.split("\n")[0]).toContain("Type /hooks");
    expect(ready).not.toContain("conch install --codex");
    expect(ready).toContain("unfinished");
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
    expect(stdout).toContain("[--service|--no-service]");
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

// Path 1 of docs/install-journeys.md: the three places `conch setup` went
// quiet — a download that looked hung, hooks that open sessions never reloaded,
// and a manual mode persisted from an old install that nobody was told about.
describe("setup says what it does", () => {
  test("sizes read the way a person says them, and an unknown size is said rather than guessed", () => {
    expect(formatBytes(885_098)).toBe("885 KB");
    expect(formatBytes(574_041_195)).toBe("574 MB");
    expect(formatBytes(1_620_000_000)).toBe("1.62 GB");
    expect(formatProgress(120_000_000, 574_041_195)).toBe("120 MB / 574 MB (20%)");
    expect(formatProgress(574_041_195, 574_041_195)).toBe("574 MB / 574 MB (100%)");
    expect(formatProgress(120_000_000)).toBe("120 MB / size unknown");
    expect(formatProgress(120_000_000, 0)).toBe("120 MB / size unknown");
  });

  test("progress redraws in place on a terminal and prints once per 10% when piped", () => {
    const tty: string[] = [];
    const redraw = progressReporter(10_000_000, { write: (text) => tty.push(text), tty: true });
    for (let done = 0; done <= 10_000_000; done += 1_000_000) redraw(done);
    expect(tty).toHaveLength(11);
    expect(tty.every((text) => text.startsWith("\r"))).toBe(true);
    redraw(10_000_000); // same text again: nothing to redraw
    expect(tty).toHaveLength(11);

    const piped: string[] = [];
    const print = progressReporter(10_000_000, { write: (text) => piped.push(text), tty: false });
    for (let done = 0; done <= 10_000_000; done += 10_000) print(done);
    expect(piped).toHaveLength(11);
    expect(piped[0]).toBe("   0 KB / 10 MB (0%)\n");
    expect(piped[10]).toBe("   10 MB / 10 MB (100%)\n");
    expect(piped.some((text) => text.includes("\r"))).toBe(false);

    const unknown: string[] = [];
    const every100 = progressReporter(undefined, { write: (text) => unknown.push(text), tty: false });
    for (let done = 0; done <= 250_000_000; done += 1_000_000) every100(done);
    expect(unknown).toEqual([
      "   0 KB / size unknown\n",
      "   100 MB / size unknown\n",
      "   200 MB / size unknown\n",
    ]);
  });

  test("a download says size and destination before the first byte, then the bytes, and refuses an error page", async () => {
    const body = new Uint8Array(2_000_000);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/sized") return new Response(body);
        if (path === "/chunked") {
          return new Response(new ReadableStream({
            start(controller) {
              controller.enqueue(body.subarray(0, 1_000_000));
              controller.enqueue(body.subarray(1_000_000));
              controller.close();
            },
          }));
        }
        return new Response("<html>not found</html>", { status: 404 });
      },
    });
    const root = mkdtempSync(join(tmpdir(), "conch-setup-download-"));
    const lines: string[] = [];
    const out = { write: (text: string) => void lines.push(text), tty: false };
    try {
      const dest = join(root, "model.bin");
      await downloadModel({ url: `${server.url}sized`, label: "test model", minBytes: 1_000 }, dest, out);
      expect(lines[0]).toBe(`⬇️  test model: 2 MB → ${dest}\n`);
      expect(lines.at(-1)).toBe("   2 MB / 2 MB (100%)\n");
      expect(lines.length).toBeLessThanOrEqual(12);
      expect(readFileSync(dest).length).toBe(2_000_000);
      expect(existsSync(`${dest}.part`)).toBe(false);

      lines.length = 0;
      const chunked = join(root, "chunked.bin");
      await downloadModel({ url: `${server.url}chunked`, label: "chunked model", minBytes: 1_000 }, chunked, out);
      expect(lines[0]).toBe(`⬇️  chunked model: size unknown → ${chunked}\n`);
      expect(lines).toHaveLength(2); // one progress line per 100 MB when the size is unknown
      expect(lines[1]).toMatch(/^ {3}\d+ [KM]B \/ size unknown\n$/);
      expect(readFileSync(chunked).length).toBe(2_000_000);

      const small = join(root, "small.bin");
      await expect(downloadModel({ url: `${server.url}sized`, label: "x", minBytes: 5_000_000 }, small, out))
        .rejects.toThrow("too small");
      expect(existsSync(`${small}.part`)).toBe(false);
      expect(existsSync(small)).toBe(false);

      await expect(downloadModel({ url: `${server.url}missing`, label: "x", minBytes: 1 }, join(root, "missing.bin"), out))
        .rejects.toThrow("HTTP 404");
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("says the /hooks step for open sessions only when hooks were actually written", async () => {
    const root = mkdtempSync(join(tmpdir(), "conch-setup-hooks-line-"));
    const claudeDir = join(root, ".claude");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const said = () => log.mock.calls.some((args) => args.join(" ").includes(HOOKS_WIRED_LINE));
    try {
      expect(HOOKS_WIRED_LINE).toContain("already open needs `/hooks` typed once");
      expect(HOOKS_WIRED_LINE).toContain("opened from now on pick conch up automatically");

      await runInstall({ claudeDir } as Config);
      expect(said()).toBe(true);

      log.mockClear();
      await runInstall({ claudeDir } as Config); // already wired: open sessions have nothing to reload
      expect(said()).toBe(false);
      expect(log.mock.calls.some((args) => args.join(" ").includes("Nothing to do."))).toBe(true);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ready output says which mode the daemon starts in and the one way to flip it", () => {
    const manual = renderSetupReady(
      { service: "installed", plugin: "installed" },
      { color: false, paused: true },
    );
    expect(manual).toContain("MODE — manual (persisted from a previous install)");
    expect(manual).toContain("`conch resume`");
    expect(manual).not.toContain("MODE — auto");

    const auto = renderSetupReady(
      { service: "installed", plugin: "installed" },
      { color: false, paused: false },
    );
    expect(auto).toContain("MODE — auto: conch speaks after every finished turn");
    expect(auto).toContain("`conch pause`");
    expect(auto).not.toContain("persisted");

    // No state passed reads as auto, the daemon's own default.
    expect(renderSetupReady({ service: "skipped", plugin: "skipped" }, { color: false }))
      .toContain("MODE — auto");
  });

  test("setup feeds the daemon's persisted mode into the banner and streams models through the downloader", () => {
    // `runSetup` is the one function here no test can execute (it installs for
    // real), so its two wirings are guarded as text: marker first, then placement.
    const src = readFileSync(join(import.meta.dir, "..", "src", "install.ts"), "utf8");
    expect(src).toContain("readState().paused");
    expect(src).toContain("renderSetupReady(completion, { codexNeedsInstall, paused: readState().paused })");
    const download = "await downloadModel(m, join(modelsDir, m.file))";
    expect(src).toContain(download);
    expect(src.slice(src.indexOf(download), src.indexOf(download) + 300))
      .toContain("Check your connection and re-run");
  });
});

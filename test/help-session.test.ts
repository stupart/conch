import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { APP_ERRORS_PATH } from "../src/app-errors.ts";
import {
  HELP_SESSION_LABEL,
  ensureHelpSession,
  helpSessionDir,
  renderHelpSessionClaudeMd,
} from "../src/help-session.ts";
import { startHelpSession, startTerminalSession } from "../src/session-lifecycle.ts";
import { sessionLabel } from "../src/sessions.ts";
import { SETTINGS_FILE, SETTING_KEYS } from "../src/settings.ts";
import { SESSIONS_FILE } from "../src/status.ts";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

function withConfigDir<T>(run: (configDir: string) => T): T {
  const configDir = mkdtempSync(join(tmpdir(), "conch-help-"));
  const previous = process.env.CONCH_CONFIG_DIR;
  process.env.CONCH_CONFIG_DIR = configDir;
  const restore = () => {
    if (previous === undefined) delete process.env.CONCH_CONFIG_DIR;
    else process.env.CONCH_CONFIG_DIR = previous;
    rmSync(configDir, { recursive: true, force: true });
  };
  try {
    const result = run(configDir);
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

describe("help session CLAUDE.md", () => {
  test("is written from the template with this Mac's config dir, once", () => {
    withConfigDir((configDir) => {
      const dir = ensureHelpSession();
      expect(dir).toBe(join(configDir, "help"));
      const path = join(dir, "CLAUDE.md");
      const written = readFileSync(path, "utf8");
      expect(written).toBe(renderHelpSessionClaudeMd());
      expect(written).toContain(join(configDir, SETTINGS_FILE));
      expect(written).not.toContain("{{");

      // Idempotent: an unchanged file is not rewritten.
      const before = statSync(path).mtimeMs;
      expect(ensureHelpSession()).toBe(dir);
      expect(statSync(path).mtimeMs).toBe(before);

      // Owned: a stale or edited copy is brought back to what conch knows.
      writeFileSync(path, "# an older conch wrote this\n");
      ensureHelpSession();
      expect(readFileSync(path, "utf8")).toBe(written);
    });
  });

  // The doc is prose about code that moves. Every name it uses is checked
  // against the source it describes, the way the plugin docs are regenerated
  // and diffed: rename a command, a tool or a file and this fails.
  const doc = read("docs/help-session/CLAUDE.md");
  const cli = read("src/cli.ts");
  const mcp = read("src/mcp.ts");

  test("every `conch <command>` it names is a CLI command", () => {
    const commands = new Set([...doc.matchAll(/`conch ([a-z-]+)/g)].map((m) => m[1]));
    expect(commands.size).toBeGreaterThanOrEqual(8);
    for (const command of commands) expect(cli).toContain(`case "${command}":`);
  });

  test("every conch_* tool it names is an MCP tool", () => {
    const tools = new Set([...doc.matchAll(/conch_[a-z_]+/g)].map((m) => m[0]));
    expect(tools.size).toBeGreaterThanOrEqual(8);
    for (const tool of tools) expect(mcp).toContain(`name: "${tool}"`);
  });

  test("the files and settings it points at are the ones conch uses", () => {
    for (const path of [
      "/tmp/conch-daemon.log",
      SESSIONS_FILE,
      "/tmp/conch-state.json", // not STATE_FILE: the suite redirects it
      "/tmp/conch.sock",
      `{{CONFIG_DIR}}/${SETTINGS_FILE}`,
      `{{CONFIG_DIR}}/${basename(APP_ERRORS_PATH)}`,
      "{{CONFIG_DIR}}/labels.json",
      "{{CONFIG_DIR}}/voices.json",
    ]) expect(doc).toContain(`\`${path}\``);
    for (const key of ["phone", "phone-relay-url"]) {
      expect(SETTING_KEYS as readonly string[]).toContain(key);
      expect(doc).toContain(`\`${key}\``);
    }
    // The rules the session must follow, and the install-map problems.
    for (const phrase of [
      "Read before guessing",
      "Never kill the daemon by pattern",
      "The app owns the daemon",
      "Ask before changing settings",
      "microphone entitlement",
      "`conch set phone true`",
      "`conch set phone-relay-url <url>`",
    ]) expect(doc).toContain(phrase);
  });
});

describe("help session label", () => {
  test("is pinned to the folder, above a generated title and below a conch rename", () => {
    withConfigDir((configDir) => {
      const cwd = join(configDir, "help");
      const labels = join(configDir, "labels.json");
      const info = { sessionId: "abc123", name: "Fixing the silent mic", cwd };
      expect(sessionLabel(info, cwd, { labelsPath: labels })).toBe(HELP_SESSION_LABEL);
      expect(sessionLabel(info, undefined, { labelsPath: labels })).toBe(HELP_SESSION_LABEL);
      writeFileSync(labels, JSON.stringify({ abc123: "my helper" }));
      expect(sessionLabel(info, cwd, { labelsPath: labels })).toBe("my helper");
      // Any other folder is unaffected.
      expect(sessionLabel({ ...info, cwd: "/tmp/other" }, "/tmp/other", { labelsPath: labels }))
        .toBe("my helper");
      expect(sessionLabel({ sessionId: "z", cwd: "/tmp/other" }, "/tmp/other", { labelsPath: labels }))
        .toBe("other");
    });
  });
});

describe("help session launch", () => {
  const dependencies = (launches: string[][]) => ({
    which: () => "/usr/local/bin/claude",
    spawn: (argv: string[]) => {
      launches.push(argv);
      return { exited: Promise.resolve(0), cancel() {} };
    },
  });

  test("conch help-session creates the folder and opens Claude there through the Terminal path", async () => {
    await withConfigDir(async (configDir) => {
      const launches: string[][] = [];
      const cwd = await startHelpSession({ bypassPermissions: true }, dependencies(launches));
      expect(cwd).toBe(helpSessionDir());
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.[0]).toBe("osascript");
      expect(launches[0]?.at(-1))
        .toBe(`cd -- '${join(configDir, "help")}' && exec claude --dangerously-skip-permissions`);
    });
  });

  test("the app's session-start with that cwd gets the same folder without a CLI in between", async () => {
    await withConfigDir(async () => {
      const launches: string[][] = [];
      const cwd = helpSessionDir();
      expect(existsSync(cwd)).toBe(false);
      await startTerminalSession({ backend: "claude", cwd }, dependencies(launches));
      expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toBe(renderHelpSessionClaudeMd());
      expect(launches[0]?.at(-1)).toBe(`cd -- '${cwd}' && exec claude`);
    });
  });

  test("the CLI refuses arguments before anything is created or launched", () => {
    const configDir = mkdtempSync(join(tmpdir(), "conch-help-cli-"));
    try {
      const proc = Bun.spawnSync(
        [process.execPath, join(repoRoot, "src", "cli.ts"), "help-session", "--extra"],
        { env: { ...process.env, CONCH_CONFIG_DIR: configDir, NO_COLOR: "1" } },
      );
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("usage: conch help-session");
      expect(existsSync(join(configDir, "help"))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("conch help lists it", () => {
    expect(cli()).toContain("help-session");
  });
  const cli = () => Bun.spawnSync([process.execPath, join(repoRoot, "src", "cli.ts"), "help"]).stdout.toString();
});

describe("Mac New session sheet: Help with conch", () => {
  const source = read("mac-app/conch-mac/ContentView.swift");

  function expectBefore(first: string, second: string) {
    expect(source).toContain(first);
    expect(source).toContain(second);
    expect(source.indexOf(first)).toBeLessThan(source.indexOf(second));
  }

  test("is a third mode, Claude only, in conch's own folder", () => {
    expectBefore('case teleport = "Teleport by ID…"', 'case help = "Help with conch"');
    expect(source).toContain("if mode == .help { return .claude }");
    expect(source).toContain('.appendingPathComponent(".config/conch/help", isDirectory: true).path');
    expect(source).toContain("case .help: return Self.helpSessionDir");
    expect(source).toContain("case .new, .help: return true");
    // Still the same request the other modes send.
    expect(source).toContain("cwd: effectiveCwd");
  });

  test("says in one line what the session can do, and hides the folder and agent choice", () => {
    expectBefore("if mode == .help {", 'Text("Help with conch — a Claude session that knows the app.")');
    expect(source).toContain("it reads the daemon log, settings and errors on this Mac, runs `conch doctor`, and can see and steer your other sessions");
    expect(source).toContain("shows here as \\u{201C}conch help\\u{201D}");
    expectBefore('Text("Help with conch — a Claude session that knows the app.")', "} else if mode != .resume {");
  });
});

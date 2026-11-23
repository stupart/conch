import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_COMMANDS } from "../src/agent-instructions.ts";
import {
  HELP_SESSION_LABEL,
  ensureHelpSession,
  helpSessionDir,
  renderHelpSessionClaudeMd,
} from "../src/help-session.ts";
import { startHelpSession, startTerminalSession } from "../src/session-lifecycle.ts";
import { sessionLabel } from "../src/sessions.ts";
import { SETTINGS_FILE, validateRuntimeControlMessage } from "../src/settings.ts";

const repoRoot = join(import.meta.dir, "..");

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

  // Rendered, so the conch section generated from agent-instructions.ts is checked too: an agent told to run a
  // command conch doesn't have fails.
  const doc = renderHelpSessionClaudeMd({ CONCH_CONFIG_DIR: "{{CONFIG_DIR}}" });

  test("every `conch agent <command>` it names is one conch has", () => {
    const named = new Set([...doc.matchAll(/`conch agent ([a-z-]+(?: [a-z]+)?)/g)].map((m) => m[1]!));
    expect(named.size).toBeGreaterThanOrEqual(20);
    const commands = ["help", ...AGENT_COMMANDS.map((command) => command.name)];
    // A command, or a group of them (`conch agent browser …`), or a command's own help (`conch agent help publish`).
    for (const name of named) {
      const asked = name.startsWith("help ") ? name.slice("help ".length) : name;
      expect(commands.some((command) => command === asked || command.split(" ")[0] === asked), name).toBe(true);
    }
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
});

describe("Help with conch, asked for by name (a phone can't name this Mac's folder)", () => {
  test("help: true is a fresh Claude session in conch's own folder", () => {
    expect(validateRuntimeControlMessage({ kind: "session-start", backend: "claude", help: true }))
      .toEqual({ ok: true, value: { kind: "session-start", backend: "claude", cwd: helpSessionDir() } });
    // With the account and host a person chose, as any start.
    expect(validateRuntimeControlMessage({ kind: "session-start", backend: "claude", help: true, host: "background", claudeAccountId: "work" }))
      .toMatchObject({ ok: true, value: { cwd: helpSessionDir(), host: "background", claudeAccountId: "work" } });
  });

  test("it is never a resume, a teleport, Codex, or somewhere else", () => {
    for (const extra of [
      { backend: "codex" }, { resumeSessionId: "abc" }, { teleportSessionId: "abc" }, { cwd: "/tmp" }, { help: "yes" },
    ]) {
      expect(validateRuntimeControlMessage({ kind: "session-start", backend: "claude", help: true, ...extra }).ok).toBe(false);
    }
  });
});

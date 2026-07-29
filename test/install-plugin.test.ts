import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildInstallCommands,
  buildMcpJson,
  buildUninstallCommands,
  materializePlugin,
} from "../src/plugin-install.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin installer helpers", () => {
  test("buildMcpJson uses the exact absolute Bun and CLI paths", () => {
    const absBun = "/opt/homebrew/bin/bun";
    const absCli = "/Users/example/conch/src/cli.ts";

    expect(buildMcpJson(absBun, absCli)).toEqual({
      mcpServers: {
        conch: {
          command: absBun,
          args: ["run", absCli, "mcp"],
        },
      },
    });
  });

  test("buildInstallCommands returns the marketplace and install argv", () => {
    const dist = "/Users/example/.config/conch/plugin-dist";

    expect(buildInstallCommands(dist)).toEqual({
      claude: [
        ["claude", "plugin", "marketplace", "add", dist],
        ["claude", "plugin", "install", "conch@conch"],
      ],
      codex: [
        ["codex", "plugin", "marketplace", "add", dist],
        ["codex", "plugin", "add", "conch@conch-local"],
      ],
    });
  });

  test("buildUninstallCommands returns the confirmed reverse argv", () => {
    expect(buildUninstallCommands()).toEqual({
      claude: [
        ["claude", "plugin", "uninstall", "conch@conch"],
        ["claude", "plugin", "marketplace", "remove", "conch"],
      ],
      codex: [
        ["codex", "plugin", "remove", "conch@conch-local"],
        ["codex", "plugin", "marketplace", "remove", "conch-local"],
      ],
    });
  });

  test("materialization writes parseable MCP config and current prose", async () => {
    const root = mkdtempSync("/tmp/conch-install-plugin-test-");
    roots.push(root);
    const repoRoot = join(import.meta.dir, "..");
    const distDir = join(root, "plugin-dist");
    const absBun = "/absolute/runtime/bun";
    const absCli = "/absolute/repo/src/cli.ts";

    await materializePlugin({
      templateDir: join(repoRoot, "plugin"),
      prosePath: join(repoRoot, "docs", "conch-control-skill.md"),
      distDir,
      absBun,
      absCli,
    });

    const pluginRoot = join(distDir, "plugins", "conch");
    const generated = JSON.parse(
      readFileSync(join(pluginRoot, ".mcp.json"), "utf8"),
    );
    expect(generated).toEqual(buildMcpJson(absBun, absCli));
    expect(generated.mcpServers.conch.command).toBe(absBun);
    expect(generated.mcpServers.conch.args).toEqual([
      "run",
      absCli,
      "mcp",
    ]);

    const prose = readFileSync(
      join(repoRoot, "docs", "conch-control-skill.md"),
      "utf8",
    );
    expect(readFileSync(join(pluginRoot, "AGENTS.md"), "utf8")).toBe(prose);
    expect(
      readFileSync(
        join(pluginRoot, "skills", "conch-control", "SKILL.md"),
        "utf8",
      ),
    ).toBe(`---
name: conch-control
description: Control conch — see and steer your other sessions by voice.
---

${prose}`);
    expect(existsSync(join(repoRoot, "plugin", "plugins", "conch", ".mcp.json")))
      .toBe(false);
  });
});

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
  buildMcpInvocation,
  buildMcpJson,
  buildUninstallCommands,
  materializeEmbeddedPlugin,
  materializePlugin,
} from "../src/plugin-install.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin installer helpers", () => {
  test("buildMcpInvocation distinguishes source and compiled runtimes", () => {
    const absBun = "/opt/homebrew/bin/bun";
    const absCli = "/Users/example/conch/src/cli.ts";

    expect(buildMcpInvocation(absBun, absCli)).toEqual({
      command: absBun,
      args: ["run", absCli, "mcp"],
    });
    expect(buildMcpInvocation("/opt/homebrew/bin/conch", "/$bunfs/root/src/cli.ts", true))
      .toEqual({
        command: "/opt/homebrew/bin/conch",
        args: ["mcp"],
      });
  });

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

    expect(buildMcpJson("/opt/homebrew/bin/conch", "/$bunfs/root/src/cli.ts", true))
      .toEqual({
        mcpServers: {
          conch: {
            command: "/opt/homebrew/bin/conch",
            args: ["mcp"],
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
    // The plugin MUST ship its own .mcp.json — that file is the only thing
    // that registers conch's MCP server when a stranger installs the plugin.
    expect(existsSync(join(repoRoot, "plugin", "plugins", "conch", ".mcp.json")))
      .toBe(true);
  });

  test("embedded materialization reconstructs every compiled-release plugin asset", async () => {
    const root = mkdtempSync("/tmp/conch-embedded-plugin-test-");
    roots.push(root);
    const repoRoot = join(import.meta.dir, "..");
    const distDir = join(root, "plugin-dist");
    const binary = "/opt/homebrew/bin/conch";

    await materializeEmbeddedPlugin({
      distDir,
      absBun: binary,
      absCli: "/$bunfs/root/src/cli.ts",
    });

    for (const relativePath of [
      ".claude-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
      "README.md",
      "plugins/conch/.claude-plugin/plugin.json",
      "plugins/conch/.codex-plugin/plugin.json",
    ]) {
      expect(readFileSync(join(distDir, relativePath), "utf8")).toBe(
        readFileSync(join(repoRoot, "plugin", relativePath), "utf8"),
      );
    }

    const prose = readFileSync(
      join(repoRoot, "docs", "conch-control-skill.md"),
      "utf8",
    );
    expect(readFileSync(join(distDir, "plugins", "conch", "AGENTS.md"), "utf8"))
      .toBe(prose);
    expect(
      readFileSync(
        join(distDir, "plugins", "conch", "skills", "conch-control", "SKILL.md"),
        "utf8",
      ),
    ).toBe(`---
name: conch-control
description: Control conch — see and steer your other sessions by voice.
---

${prose}`);

    expect(
      JSON.parse(
        readFileSync(join(distDir, "plugins", "conch", ".mcp.json"), "utf8"),
      ),
    ).toEqual({
      mcpServers: {
        conch: {
          command: binary,
          args: ["mcp"],
        },
      },
    });
  });

  test("compiled CLI installs its embedded plugin and smoke-tests itself directly", () => {
    const root = mkdtempSync("/tmp/conch-compiled-plugin-test-");
    roots.push(root);
    const repoRoot = join(import.meta.dir, "..");
    const binary = join(root, "conch");
    const configDir = join(root, "config");

    const build = Bun.spawnSync([
      process.execPath,
      "build",
      "--compile",
      join(repoRoot, "src", "cli.ts"),
      "--outfile",
      binary,
    ]);
    expect(build.exitCode).toBe(0);

    const install = Bun.spawnSync([binary, "install-plugin"], {
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin",
        CONCH_CONFIG_DIR: configDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${install.stdout.toString()}\n${install.stderr.toString()}`;
    expect(install.exitCode).toBe(0);
    expect(output).toContain("Claude Code: not-found");
    expect(output).toContain("Codex: not-found");
    expect(output).toContain("MCP smoke test: passed — 9 tools");

    const mcp = JSON.parse(
      readFileSync(
        join(configDir, "plugin-dist", "plugins", "conch", ".mcp.json"),
        "utf8",
      ),
    );
    expect(mcp.mcpServers.conch.command).toEndWith("/conch");
    expect(mcp.mcpServers.conch.args).toEqual(["mcp"]);
  }, 15_000);
});

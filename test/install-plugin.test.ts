import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AGENTS_ALWAYS_ON,
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
    // NOT the prose. AGENTS.md is always-on context for Codex while the skill
    // loads on demand, so shipping the same bytes to both made every Codex
    // session permanently carry a Homebrew install pitch.
    expect(readFileSync(join(pluginRoot, "AGENTS.md"), "utf8")).toBe(AGENTS_ALWAYS_ON);
    expect(
      readFileSync(
        join(pluginRoot, "skills", "conch-control", "SKILL.md"),
        "utf8",
      ),
    ).toBe(`---
name: conch-control
description: Put finished work in front of the user when a turn produces something to look at (a page, a diff, a screenshot, a built app), and see or steer their other Claude Code and Codex sessions. Use when you have made something viewable, or when asked what the other sessions are doing.
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
      .toBe(AGENTS_ALWAYS_ON);
    expect(
      readFileSync(
        join(distDir, "plugins", "conch", "skills", "conch-control", "SKILL.md"),
        "utf8",
      ),
    ).toBe(`---
name: conch-control
description: Put finished work in front of the user when a turn produces something to look at (a page, a diff, a screenshot, a built app), and see or steer their other Claude Code and Codex sessions. Use when you have made something viewable, or when asked what the other sessions are doing.
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
    ], {
      // `--outfile` decides where the BINARY goes; the ~60MB `.bun-build`
      // intermediate goes to cwd regardless. Run from the tmpdir so it lands
      // there and dies with `roots`. Four of them reached main via `git add -A`.
      cwd: root,
    });
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

describe("the two install paths ship the same prose", () => {
  // conch reaches users two ways with two different sources for one text:
  //
  //   marketplace  -> `plugin/plugins/conch` is served straight out of git
  //                   (`source: git-subdir` in the marketplace manifest)
  //   Homebrew/dev -> materializePlugin GENERATES those same files from
  //                   docs/conch-control-skill.md
  //
  // Nothing kept them equal, and they silently drifted into three different
  // review contracts — the checked-in AGENTS.md told agents `session` was
  // required and must NOT name the caller, which is the exact inverse of what
  // `requiredReviewSession` enforces, so following it was a guaranteed
  // ToolInputError. Whichever file is edited, this fails until both match.
  const repoRoot = join(import.meta.dir, "..");
  const prose = readFileSync(join(repoRoot, "docs", "conch-control-skill.md"), "utf8");
  const pluginRoot = join(repoRoot, "plugin", "plugins", "conch");

  test("the checked-in AGENTS.md is the short always-on text", () => {
    expect(readFileSync(join(pluginRoot, "AGENTS.md"), "utf8")).toBe(AGENTS_ALWAYS_ON);
  });

  test("the checked-in SKILL.md is the generated prose under its frontmatter", () => {
    const skill = readFileSync(
      join(pluginRoot, "skills", "conch-control", "SKILL.md"),
      "utf8",
    );
    expect(skill.endsWith(prose)).toBe(true);
    expect(skill.slice(0, skill.length - prose.length)).toMatch(/^---\nname: conch-control\n/);
  });

  test("the shipped contract matches what review_to_front actually enforces", () => {
    // The drift above was undetectable by eye. Pin the two claims that were
    // wrong: `session` defaults to the caller, and naming a sibling is refused.
    expect(prose).toContain("`session` is optional and defaults to you");
    expect(prose).toContain("naming a different session is refused");
  });
});

describe("each harness can start the MCP server the marketplace serves from git", () => {
  // The marketplace serves plugin/plugins/conch from git, so neither harness
  // gets the absolute paths install-plugin writes. Each has its own rules for
  // turning a declaration into a process; these helpers follow them as the
  // sources show, then check that sh can open the launcher from there.
  interface Launch {
    command: string;
    args: string[];
    cwd: string;
  }
  interface Server {
    command: string;
    args?: string[];
    cwd?: string;
  }

  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  // Both harnesses accept {mcpServers: {...}} or a bare server map.
  const conchServer = (path: string): Server => {
    const parsed = readJson(path);
    return (parsed.mcpServers ?? parsed).conch;
  };

  // Codex rust-v0.153.4. The manifest is the first of these directories
  // (utils/plugins/src/plugin_namespace.rs, exec-server-protocol/src/protocol.rs).
  // `mcpServers` is inline, a "./" path, or else .mcp.json
  // (core-plugins/src/manifest.rs, core-plugins/src/loader.rs). In this legacy
  // format, command and args pass through unexpanded, a relative cwd joins the
  // plugin root, and no cwd means the session's cwd
  // (codex-mcp/src/plugin_config.rs, codex-mcp/src/server.rs).
  function codexLaunch(pluginRoot: string, sessionCwd: string): Launch {
    const dir = [".codex-plugin", ".claude-plugin", ".cursor-plugin"]
      .find((candidate) => existsSync(join(pluginRoot, candidate, "plugin.json")));
    const declared = readJson(join(pluginRoot, dir!, "plugin.json")).mcpServers;
    const server: Server = typeof declared === "object"
      ? declared.conch
      : conchServer(join(
        pluginRoot,
        typeof declared === "string" && declared.startsWith("./") ? declared : ".mcp.json",
      ));
    const cwd = server.cwd === undefined
      ? sessionCwd
      : isAbsolute(server.cwd) ? server.cwd : join(pluginRoot, server.cwd);
    return { command: server.command, args: server.args ?? [], cwd };
  }

  // Claude Code 2.1.266 (its binary, the plugin MCP loader and C5). The
  // manifest is .claude-plugin/plugin.json and the default file is .mcp.json.
  // Only ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PROJECT_DIR} and ${CLAUDE_PLUGIN_DATA}
  // are replaced. There is no ${PLUGIN_ROOT}, and no documented cwd, so the
  // server starts in the session's directory.
  function claudeLaunch(pluginRoot: string, sessionCwd: string): Launch {
    const declared = readJson(join(pluginRoot, ".claude-plugin", "plugin.json")).mcpServers;
    const server: Server = typeof declared === "object"
      ? declared.conch
      : conchServer(join(pluginRoot, typeof declared === "string" ? declared : ".mcp.json"));
    const expand = (value: string) => value
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot)
      .replaceAll("${CLAUDE_PROJECT_DIR}", sessionCwd)
      .replaceAll("${CLAUDE_PLUGIN_DATA}", join(sessionCwd, ".plugin-data"));
    return {
      command: expand(server.command),
      args: (server.args ?? []).map(expand),
      cwd: sessionCwd,
    };
  }

  function expectLaunchable({ command, args, cwd }: Launch) {
    expect(`${command} ${args.join(" ")}`).not.toContain("${");
    expect(command).toBe("sh");
    // `sh -n` opens and parses the launcher without running it, so it fails
    // exactly when that path does not resolve from that cwd.
    const check = Bun.spawnSync([command, "-n", ...args], {
      cwd,
      env: { PATH: "/usr/bin:/bin" },
      stderr: "pipe",
    });
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
  }

  const pluginRoot = join(import.meta.dir, "..", "plugin", "plugins", "conch");
  const sessionCwd = () => {
    const dir = mkdtempSync("/tmp/conch-session-cwd-");
    roots.push(dir);
    return dir;
  };

  test("Codex launches the checked-in declaration without expanding anything", () => {
    // Premise of the simulation: a root plugin.json would switch Codex to the
    // Agent Plugins format, which has different rules.
    expect(existsSync(join(pluginRoot, "plugin.json"))).toBe(false);
    expectLaunchable(codexLaunch(pluginRoot, sessionCwd()));
  });

  test("Claude Code expands the checked-in declaration to the plugin's launcher", () => {
    expectLaunchable(claudeLaunch(pluginRoot, sessionCwd()));
  });

  test("an install-plugin copy still hands both harnesses the absolute invocation", async () => {
    const root = sessionCwd();
    const repoRoot = join(import.meta.dir, "..");
    const absBun = "/absolute/runtime/bun";
    const absCli = "/absolute/repo/src/cli.ts";
    const binary = "/opt/homebrew/bin/conch";

    await materializePlugin({
      templateDir: join(repoRoot, "plugin"),
      prosePath: join(repoRoot, "docs", "conch-control-skill.md"),
      distDir: join(root, "source"),
      absBun,
      absCli,
    });
    await materializeEmbeddedPlugin({
      distDir: join(root, "compiled"),
      absBun: binary,
      absCli: "/$bunfs/root/src/cli.ts",
    });

    for (const [dist, expected] of [
      ["source", buildMcpInvocation(absBun, absCli)],
      ["compiled", buildMcpInvocation(binary, "/$bunfs/root/src/cli.ts", true)],
    ] as const) {
      const distRoot = join(root, dist, "plugins", "conch");
      for (const launch of [codexLaunch(distRoot, root), claudeLaunch(distRoot, root)]) {
        expect({ command: launch.command, args: launch.args }).toEqual(expected);
      }
    }
  });
});

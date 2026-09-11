import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  applyPlan,
  backupsFor,
  contentHash,
  planToggle,
  rollbackFile,
  tomlHeaderPath,
  tomlSetEnabled,
  unifiedDiff,
  type ConfigTogglePlan,
  type ConfigWriteHomes,
} from "../src/config-write.ts";
import { applyRuntimeControlMessage, createControlServer, type ControlServer } from "../src/control-server.ts";
import {
  isControlMessageCandidate,
  sendControlMessage,
  validateControlResponse,
  validateRuntimeControlMessage,
} from "../src/settings.ts";

const repo = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");

/**
 * Every test writes under its own temp dir. The real `~/.claude/settings.json`
 * and `~/.codex/config.toml` are in use by live sessions and are never named.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const CLAUDE_SETTINGS = `{
  "model": "claude-fable-5-1[1m]",
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "conch hook"
          }
        ]
      }
    ]
  },
  "enabledPlugins": {
    "linear@claude-plugins-official": true,
    "ponytail@ponytail": true,
    "conch@conch": true
  },
  "extraKnownMarketplaces": {
    "conch": {
      "source": {
        "source": "github",
        "repo": "stupart/conch"
      }
    }
  },
  "theme": "dark"
}
`;

const CLAUDE_LEDGER = JSON.stringify({
  version: 2,
  plugins: {
    "linear@claude-plugins-official": [{ scope: "user", installPath: "/x/linear", version: "3ea32df27be7" }],
    "ponytail@ponytail": [{ scope: "user", installPath: "/x/ponytail", version: "4.8.4" }],
    "conch@conch": [{ scope: "user", installPath: "/x/conch", version: "0.2.1" }],
  },
}, null, 2);

// Claude's state file: 2-space, NO trailing newline, exactly as Claude Code writes it.
const claudeState = (project: string) => `{
  "numStartups": 22,
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp"
    }
  },
  "projects": {
    "${project}": {
      "allowedTools": [],
      "mcpContextUris": [],
      "mcpServers": {
        "local-only": {
          "command": "bun",
          "args": [
            "run",
            "x"
          ]
        }
      },
      "enabledMcpjsonServers": [],
      "disabledMcpjsonServers": [],
      "hasTrustDialogAccepted": true,
      "lastCost": 0.42
    }
  },
  "lastReleaseNotesSeen": "2.1.266"
}`;

const CODEX_CONFIG = `model = "gpt-6-astra"
model_reasoning_effort = "xhigh"

[marketplaces.openai-bundled]
source = "openai"

# plugins the desktop app turned on
[plugins."browser@openai-bundled"]
enabled = true

[plugins."conch@conch-local"]
enabled = true

[mcp_servers.node_repl]
args = []
command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
CODEX_HOME = "/Users/someone/.codex"

[mcp_servers.computer-use]
command = "./SkyComputerUseClient"
args = ["mcp"]
cwd = "."
enabled = false  # turned off 09-09

[projects."/Users/someone/Projects/Conch"]
trust_level = "trusted"

[tui.model_availability_nux]
seen = true
`;

function fixture() {
  const root = mkdtempSync("/tmp/conch-cw-");
  roots.push(root);
  const project = join(root, "project");
  const homes: ConfigWriteHomes = {
    claudeHome: join(root, "home", ".claude"),
    claudeStatePath: join(root, "home", ".claude.json"),
    codexHome: join(root, "home", ".codex"),
  };
  write(join(homes.claudeHome, "settings.json"), CLAUDE_SETTINGS);
  write(join(homes.claudeHome, "plugins", "installed_plugins.json"), CLAUDE_LEDGER);
  write(homes.claudeStatePath, claudeState(project));
  write(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "team-db": { command: "db-mcp" } } }, null, 2) + "\n");
  write(join(homes.codexHome, "config.toml"), CODEX_CONFIG);
  mkdirSync(project, { recursive: true });
  return { root, project, homes };
}

/**
 * Exactly these lines moved, and nothing else: applying the diff's one hunk
 * as a patch to `before` must reproduce `after` byte for byte, which is an
 * independent check on both the diff and the edit.
 */
function expectOnlyTheseLinesMoved(plan: ConfigTogglePlan, removed: string[], added: string[]): void {
  const lines = plan.diff.split("\n");
  const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[2] ?? "");
  expect(header).not.toBeNull();
  const [, aStart, aCount] = header!.map(Number);
  const hunk = lines.slice(3, -1);
  expect(hunk.filter((l) => l.startsWith("-")).map((l) => l.slice(1))).toEqual(removed);
  expect(hunk.filter((l) => l.startsWith("+")).map((l) => l.slice(1))).toEqual(added);
  const beforeLines = plan.before.split("\n");
  const patched = [
    ...beforeLines.slice(0, aStart! - 1),
    ...hunk.filter((l) => !l.startsWith("-")).map((l) => l.slice(1)),
    ...beforeLines.slice(aStart! - 1 + aCount!),
  ];
  expect(patched.join("\n")).toBe(plan.after);
}

describe("planning Claude", () => {
  test("a user-scope plugin flips one enabledPlugins line in settings.json and nothing else", () => {
    const f = fixture();
    const plan = planToggle({ agent: "claude", scope: "user", capability: "plugin", id: "ponytail@ponytail", enabled: false }, f.homes);
    expect(plan.file).toBe(join(f.homes.claudeHome, "settings.json"));
    expect(plan.appliesNextSession).toBe(true);
    expect(plan.beforeHash).toBe(contentHash(CLAUDE_SETTINGS));
    expectOnlyTheseLinesMoved(plan, ['    "ponytail@ponytail": true,'], ['    "ponytail@ponytail": false,']);
    expect(plan.diff.startsWith(`--- ${plan.file}\n+++ ${plan.file}\n@@ -14,7 +14,7 @@\n`)).toBe(true);
    expect(plan.after.endsWith("}\n")).toBe(true);
  });

  test("a project-scope plugin creates .claude/settings.json holding only that key", () => {
    const f = fixture();
    const plan = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "plugin", id: "conch@conch", enabled: false }, f.homes);
    expect(plan.file).toBe(join(f.project, ".claude", "settings.json"));
    expect(plan.before).toBe("");
    expect(plan.after).toBe('{\n  "enabledPlugins": {\n    "conch@conch": false\n  }\n}\n');
    expect(plan.diff).toContain("@@ -0,0 +1,5 @@");
  });

  test("an uninstalled plugin, or project scope without a directory, is refused in words", () => {
    const f = fixture();
    expect(() => planToggle({ agent: "claude", scope: "user", capability: "plugin", id: "nope@nowhere", enabled: true }, f.homes))
      .toThrow('Claude plugin "nope@nowhere" is not installed');
    expect(() => planToggle({ agent: "claude", scope: "project", capability: "plugin", id: "conch@conch", enabled: true }, f.homes))
      .toThrow("project scope needs the project directory");
  });

  test("an MCP server is per project: disabledMcpServers in ~/.claude.json, trailing-newline-less file kept that way", () => {
    const f = fixture();
    const off = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "mcp-server", id: "linear", enabled: false }, f.homes);
    expect(off.file).toBe(f.homes.claudeStatePath);
    expect(off.after.endsWith("}")).toBe(true);
    expectOnlyTheseLinesMoved(off, ['      "lastCost": 0.42'], [
      '      "lastCost": 0.42,',
      '      "disabledMcpServers": [',
      '        "linear"',
      "      ]",
    ]);
    // A local-scope server (defined in the project entry) takes the same list.
    const local = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "mcp-server", id: "local-only", enabled: false }, f.homes);
    expect(local.diff).toContain('+        "local-only"');

    applyPlan(off);
    const on = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "mcp-server", id: "linear", enabled: true }, f.homes);
    expect(on.after).toContain('"disabledMcpServers": []');
    expect(() => planToggle({ agent: "claude", scope: "user", capability: "mcp-server", id: "linear", enabled: false }, f.homes))
      .toThrow("Claude Code records MCP server enablement per project");
  });

  test("a .mcp.json server is approved or rejected through the enabled/disabled Mcpjson lists", () => {
    const f = fixture();
    const on = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "mcp-server", id: "team-db", enabled: true }, f.homes);
    expectOnlyTheseLinesMoved(on, ['      "enabledMcpjsonServers": [],'], ['      "enabledMcpjsonServers": [', '        "team-db"', "      ],"]);
    applyPlan(on);
    const off = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "mcp-server", id: "team-db", enabled: false }, f.homes);
    expect(off.after).toContain('"enabledMcpjsonServers": []');
    expect(off.after).toContain('"disabledMcpjsonServers": [\n        "team-db"\n      ]');
    expect(() => planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "mcp-server", id: "ghost", enabled: false }, f.homes))
      .toThrow('MCP server "ghost" is not defined for Claude');
    expect(() => planToggle({ agent: "claude", scope: "project", projectDir: "/elsewhere", capability: "mcp-server", id: "linear", enabled: false }, f.homes))
      .toThrow("has no entry for /elsewhere");
  });
});

describe("planning Codex", () => {
  test("a plugin flips its one enabled line; comments, env sub-tables and the rest re-parse untouched", () => {
    const f = fixture();
    const plan = planToggle({ agent: "codex", scope: "user", capability: "plugin", id: "conch@conch-local", enabled: false }, f.homes);
    expect(plan.file).toBe(join(f.homes.codexHome, "config.toml"));
    expectOnlyTheseLinesMoved(plan, ["enabled = true"], ["enabled = false"]);
    // The RIGHT enabled line: the one under [plugins."conch@conch-local"], not browser's.
    expect(plan.after).toContain('[plugins."browser@openai-bundled"]\nenabled = true');
    expect(plan.after).toContain('[plugins."conch@conch-local"]\nenabled = false');
    const parsed = Bun.TOML.parse(plan.after) as Record<string, Record<string, Record<string, unknown>>>;
    expect(parsed.mcp_servers!["node_repl"]!["env"]).toEqual({
      NODE_REPL_NODE_PATH: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      CODEX_HOME: "/Users/someone/.codex",
    });
    expect(plan.after).toContain("# plugins the desktop app turned on");
  });

  test("an MCP server keeps its trailing comment; one without an enabled line gets one under its header", () => {
    const f = fixture();
    const on = planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "computer-use", enabled: true }, f.homes);
    expectOnlyTheseLinesMoved(on, ["enabled = false  # turned off 09-09"], ["enabled = true  # turned off 09-09"]);
    const off = planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "node_repl", enabled: false }, f.homes);
    expectOnlyTheseLinesMoved(off, [], ["enabled = false"]);
    expect(off.after).toContain("[mcp_servers.node_repl]\nenabled = false\nargs = []");
    expect(() => planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "ghost", enabled: false }, f.homes))
      .toThrow("[mcp_servers.ghost] is not defined; conch does not add entries");
  });

  test("project scope creates .codex/config.toml with just the plugin table; an unnamed plugin is refused", () => {
    const f = fixture();
    const plan = planToggle({ agent: "codex", scope: "project", projectDir: f.project, capability: "plugin", id: "conch@conch-local", enabled: false }, f.homes);
    expect(plan.file).toBe(join(f.project, ".codex", "config.toml"));
    expect(plan.after).toBe('[plugins."conch@conch-local"]\nenabled = false\n');
    write(plan.file, "model = \"o3\"");
    const appended = planToggle({ agent: "codex", scope: "project", projectDir: f.project, capability: "plugin", id: "conch@conch-local", enabled: false }, f.homes);
    expect(appended.after).toBe('model = "o3"\n\n[plugins."conch@conch-local"]\nenabled = false\n');
    expect(() => planToggle({ agent: "codex", scope: "project", projectDir: f.project, capability: "plugin", id: "nope@x", enabled: true }, f.homes))
      .toThrow('Codex plugin "nope@x" is not named in');
  });

  test("forms the line editor does not edit are refused, never rewritten", () => {
    const f = fixture();
    const file = join(f.homes.codexHome, "config.toml");
    write(file, 'mcp_servers = { conch = { command = "bun", enabled = true } }\n');
    expect(() => planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "conch", enabled: false }, f.homes))
      .toThrow("[mcp_servers.conch] is written in a form conch does not edit");
    write(file, '[mcp_servers.conch]\ncommand = "bun"\nenabled = "yes"\n');
    expect(() => planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "conch", enabled: false }, f.homes))
      .toThrow("enabled under [mcp_servers.conch] is not a bare boolean");
    write(file, "[mcp_servers.conch\ncommand = 1\n");
    expect(() => planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "conch", enabled: false }, f.homes))
      .toThrow("is not valid TOML");
    // The line editor's blind spot: an `enabled = true` INSIDE a multi-line
    // string. The re-parse proof catches what the editor cannot see.
    write(file, '[mcp_servers.conch]\ncommand = "bun"\nnote = """\nenabled = true\n"""\n');
    expect(() => planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "conch", enabled: false }, f.homes))
      .toThrow("the edit would change more than conch; refusing");
  });

  test("header parsing handles quoted, dotted and commented headers and rejects arrays of tables", () => {
    expect(tomlHeaderPath('[plugins."conch@conch-local"]')).toEqual(["plugins", "conch@conch-local"]);
    expect(tomlHeaderPath("  [ mcp_servers . node_repl ]  # note")).toEqual(["mcp_servers", "node_repl"]);
    expect(tomlHeaderPath("[a.'b.c'.d]")).toEqual(["a", "b.c", "d"]);
    expect(tomlHeaderPath("[[servers]]")).toBeNull();
    expect(tomlHeaderPath('key = "[not a header]"')).toBeNull();
    expect(tomlHeaderPath("[a..b]")).toBeNull();
    expect(tomlSetEnabled("f", "", ["mcp_servers", "x y"], true, true)).toBe('[mcp_servers."x y"]\nenabled = true\n');
  });
});

describe("applying", () => {
  test("writes the plan, keeps a backup of the previous bytes, and bounds backups to the newest three", () => {
    const f = fixture();
    const file = join(f.homes.claudeHome, "settings.json");
    let expectedBefore = CLAUDE_SETTINGS;
    for (let round = 0; round < 4; round += 1) {
      const enabled = round % 2 === 1;
      const plan = planToggle({ agent: "claude", scope: "user", capability: "plugin", id: "conch@conch", enabled }, f.homes);
      expect(plan.before).toBe(expectedBefore);
      const result = applyPlan(plan);
      expect(readFileSync(file, "utf8")).toBe(plan.after);
      expect(result.backup).toBeDefined();
      expect(readFileSync(result.backup!, "utf8")).toBe(plan.before);
      expectedBefore = plan.after;
    }
    const backups = backupsFor(file);
    expect(backups).toHaveLength(3);
    expect(backups.every((path) => path.startsWith(`${file}.conch-backup-`))).toBe(true);
    expect(readdirSync(dirname(file)).filter((name) => name.includes("conch-tmp"))).toEqual([]);
    // A plan whose file already says so writes nothing and makes no backup.
    const same = planToggle({ agent: "claude", scope: "user", capability: "plugin", id: "conch@conch", enabled: true }, f.homes);
    expect(same.diff).toBe("");
    expect(applyPlan(same)).toEqual({ file });
    expect(backupsFor(file)).toHaveLength(3);
  });

  test("a failing rename leaves the file byte-identical and no temp file behind", () => {
    const f = fixture();
    const plan = planToggle({ agent: "codex", scope: "user", capability: "plugin", id: "conch@conch-local", enabled: false }, f.homes);
    expect(() => applyPlan(plan, { rename: () => { throw new Error("EXDEV: fake"); } })).toThrow("EXDEV: fake");
    expect(readFileSync(plan.file, "utf8")).toBe(CODEX_CONFIG);
    expect(readdirSync(dirname(plan.file)).filter((name) => name.includes("conch-tmp"))).toEqual([]);
  });

  test("a write that reads back corrupt, or without the change, is refused and the previous bytes restored", () => {
    const f = fixture();
    const plan = planToggle({ agent: "codex", scope: "user", capability: "mcp-server", id: "computer-use", enabled: true }, f.homes);
    // The rename "succeeds" but the bytes land wrong once; the restore that follows renames for real.
    const corruptOnce = () => {
      let done = false;
      return {
        rename: (from: string, to: string) => {
          if (done) return renameSync(from, to);
          done = true;
          rmSync(from);
          writeFileSync(to, "[mcp_servers.computer-use\nbroken");
        },
      };
    };
    expect(() => applyPlan(plan, corruptOnce())).toThrow("read back wrong after the write");
    expect(() => applyPlan(plan, corruptOnce())).toThrow("is not valid TOML");
    expect(readFileSync(plan.file, "utf8")).toBe(CODEX_CONFIG);
    expect(readdirSync(dirname(plan.file)).filter((name) => name.includes("conch-tmp"))).toEqual([]);

    const missing = { readBack: () => CODEX_CONFIG };
    expect(() => applyPlan(plan, missing)).toThrow("it does not contain the change");
    expect(readFileSync(plan.file, "utf8")).toBe(CODEX_CONFIG);

    // The same refusal for a JSON file, and a file that did not exist is removed again.
    const created = planToggle({ agent: "claude", scope: "project", projectDir: f.project, capability: "plugin", id: "conch@conch", enabled: false }, f.homes);
    expect(() => applyPlan(created, { readBack: () => "{ not json" })).toThrow("the previous content is restored");
    expect(existsSync(created.file)).toBe(false);
  });

  test("a plan is refused once the file moved under it, and a live Claude lock is honoured", () => {
    const f = fixture();
    const plan = planToggle({ agent: "claude", scope: "user", capability: "plugin", id: "conch@conch", enabled: false }, f.homes);
    write(plan.file, CLAUDE_SETTINGS.replace('"theme": "dark"', '"theme": "light"'));
    expect(() => applyPlan(plan)).toThrow("changed since the preview");

    const fresh = planToggle({ agent: "claude", scope: "user", capability: "plugin", id: "conch@conch", enabled: false }, f.homes);
    const lock = `${fresh.file}.lock`;
    mkdirSync(lock);
    expect(() => applyPlan(fresh)).toThrow("Claude Code is writing");
    expect(readFileSync(fresh.file, "utf8")).toBe(fresh.before);
    // Older than ten seconds: Claude's own writer treats it as stale, so does conch.
    const old = new Date(Date.now() - 11_000);
    utimesSync(lock, old, old);
    applyPlan(fresh);
    expect(readFileSync(fresh.file, "utf8")).toBe(fresh.after);
    expect(existsSync(lock)).toBe(false);
  });

  test("rollback puts the newest backup back and can itself be undone", () => {
    const f = fixture();
    const file = join(f.homes.codexHome, "config.toml");
    expect(() => rollbackFile(file)).toThrow("no conch backup beside");
    const plan = planToggle({ agent: "codex", scope: "user", capability: "plugin", id: "conch@conch-local", enabled: false }, f.homes);
    const { backup } = applyPlan(plan);
    expect(rollbackFile(file)).toEqual({ file, restoredFrom: backup! });
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG);
    const again = rollbackFile(file);
    expect(again.restoredFrom).not.toBe(backup);
    expect(readFileSync(file, "utf8")).toBe(plan.after);
  });

  test("the unified diff is one hunk with three lines of context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n") + "\n";
    const after = before.replace("d\ne", "d\nE\ne2");
    expect(unifiedDiff("/f", before, after)).toBe([
      "--- /f", "+++ /f", "@@ -2,7 +2,8 @@", " b", " c", " d", "-e", "+E", "+e2", " f", " g", " h", "",
    ].join("\n"));
    expect(unifiedDiff("/f", "x\n", "x\n")).toBe("");
  });
});

describe("the wire", () => {
  test("config-toggle and config-rollback are validated at the one boundary", () => {
    expect(isControlMessageCandidate({ kind: "config-toggle" })).toBe(true);
    expect(isControlMessageCandidate({ kind: "config-rollback" })).toBe(true);
    const full = {
      kind: "config-toggle", agent: "codex", scope: "project", projectDir: "/p", capability: "mcp-server",
      id: "node_repl", enabled: false, preview: true, expectBeforeHash: "a".repeat(64), extra: 1,
    };
    expect(validateRuntimeControlMessage(full)).toEqual({
      ok: true,
      value: {
        kind: "config-toggle", agent: "codex", scope: "project", projectDir: "/p", capability: "mcp-server",
        id: "node_repl", enabled: false, preview: true, expectBeforeHash: "a".repeat(64),
      },
    });
    expect(validateRuntimeControlMessage({ kind: "config-toggle", agent: "claude", scope: "user", capability: "plugin", id: "a@b", enabled: true }))
      .toEqual({ ok: true, value: { kind: "config-toggle", agent: "claude", scope: "user", capability: "plugin", id: "a@b", enabled: true } });
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{ agent: "gemini" }, "agent must be claude or codex"],
      [{ scope: "local" }, "scope must be user or project"],
      [{ capability: "skill" }, "capability must be plugin or mcp-server"],
      [{ id: 'a"b' }, "id cannot contain quotes, backslashes or whitespace"],
      [{ id: "a b" }, "id cannot contain quotes, backslashes or whitespace"],
      [{ id: "" }, "id cannot be empty"],
      [{ enabled: "yes" }, "enabled must be a boolean"],
      [{ scope: "project" }, "project scope needs projectDir"],
      [{ scope: "project", projectDir: "rel" }, "projectDir must be an absolute path"],
      [{ preview: 1 }, "preview must be a boolean"],
      [{ expectBeforeHash: "zz" }, "expectBeforeHash must be a sha256 hex digest"],
    ];
    for (const [patch, err] of refusals) {
      const message = { kind: "config-toggle", agent: "claude", scope: "user", capability: "plugin", id: "a@b", enabled: true, ...patch };
      expect(validateRuntimeControlMessage(message)).toEqual({ ok: false, err: `config-toggle: ${err}` });
    }
    expect(validateRuntimeControlMessage({ kind: "config-rollback", file: "/a/b.json" }))
      .toEqual({ ok: true, value: { kind: "config-rollback", file: "/a/b.json" } });
    expect(validateRuntimeControlMessage({ kind: "config-rollback", file: "b.json" }))
      .toEqual({ ok: false, err: "config-rollback: file must be an absolute path" });

    const reply = {
      kind: "config-toggle" as const, file: "/f", diff: "", beforeHash: "x", applied: true,
      backup: "/f.conch-backup-1", appliesNextSession: true as const,
    };
    expect(validateControlResponse(reply)).toEqual({ ok: true, value: reply });
    expect(validateControlResponse({ ...reply, appliesNextSession: false })).toEqual({ ok: false, err: "invalid config-toggle response" });
    expect(validateControlResponse({ kind: "config-rollback", file: "/f", restoredFrom: "/f.conch-backup-1" }))
      .toEqual({ ok: true, value: { kind: "config-rollback", file: "/f", restoredFrom: "/f.conch-backup-1" } });
  });

  const servers: ControlServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  test("over the real socket: preview writes nothing, a stale apply is refused in words, apply and rollback write", async () => {
    const f = fixture();
    const socketPath = join(f.root, "control.sock");
    const server = createControlServer({
      socketPath,
      ownerDeviceId: "this-mac",
      log: () => {},
      sessions: { resolve: (value) => value, current: () => ({ published: false }) },
      application: {
        configuration: () => ({ kind: "config-error", error: "stub" }),
        session: () => ({ kind: "session-error", error: "stub" }),
        runtime: (message) => applyRuntimeControlMessage(message, {
          listResumable: () => ({ sessions: [], complete: true }),
          start: () => {},
          close: () => {},
          report: () => {},
          configWrite: { homes: f.homes },
        }),
        turn: () => {},
        device: () => ({ kind: "ack" }),
      },
    });
    servers.push(server);
    expect(await server.start()).toBe(true);
    const file = join(f.homes.codexHome, "config.toml");
    const request = {
      kind: "config-toggle" as const, agent: "codex" as const, scope: "user" as const,
      capability: "plugin" as const, id: "conch@conch-local", enabled: false,
    };

    const preview = await sendControlMessage(socketPath, { ...request, preview: true });
    expect(preview.ok && preview.response.kind === "config-toggle" && preview.response).toMatchObject({
      file, applied: false, beforeHash: contentHash(CODEX_CONFIG), appliesNextSession: true,
    });
    const diff = preview.ok && preview.response.kind === "config-toggle" ? preview.response.diff : "";
    expect(diff).toContain("-enabled = true\n+enabled = false");
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG);

    await expect(sendControlMessage(socketPath, { ...request, expectBeforeHash: "0".repeat(64) })).resolves.toEqual({
      ok: true,
      response: { kind: "session-error", error: `${file} changed since the preview; ask for a new preview.` },
    });
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG);

    const applied = await sendControlMessage(socketPath, { ...request, expectBeforeHash: contentHash(CODEX_CONFIG) });
    expect(applied.ok && applied.response.kind === "config-toggle" && applied.response).toMatchObject({ file, diff, applied: true });
    const backup = applied.ok && applied.response.kind === "config-toggle" ? applied.response.backup : undefined;
    expect(backup).toStartWith(`${file}.conch-backup-`);
    expect(readFileSync(file, "utf8")).toContain('[plugins."conch@conch-local"]\nenabled = false');

    // The module's refusal text reaches the client verbatim.
    await expect(sendControlMessage(socketPath, { ...request, id: "ghost@x" })).resolves.toEqual({
      ok: true,
      response: { kind: "session-error", error: `Codex plugin "ghost@x" is not named in ${file}; conch does not install plugins.` },
    });

    await expect(sendControlMessage(socketPath, { kind: "config-rollback", file })).resolves.toEqual({
      ok: true,
      response: { kind: "config-rollback", file, restoredFrom: backup! },
    });
    expect(readFileSync(file, "utf8")).toBe(CODEX_CONFIG);
  });
});

describe("the surfaces", () => {
  test("the CLI mirrors the message and the daemon needs no wiring beyond the runtime entry", () => {
    const cli = read("src/cli.ts");
    expect(cli).toContain('case "config-toggle": {');
    expect(cli).toContain('kind: "config-toggle",');
    expect(cli).toContain('...(flags.has("--preview") ? { preview: true } : {}),');
    expect(cli).toContain('case "config-rollback": {');
    expect(cli).toContain("applies to the next session");
    expect(cli).toContain("config-toggle <agent> <plugin|mcp-server> <id> <on|off> [--scope user|project] [--project <dir>] [--preview] | config-rollback <file>");
    // The runtime entry the daemon already passes is where the case lives.
    expect(read("src/daemon.ts")).toContain("runtime: (message) => applyRuntimeControlMessage(message, runtimeControlDispatchOptions),");
    expect(read("src/control-server.ts")).toContain('if (message.kind === "config-toggle") {');
  });

  test("the Mac inspector offers a toggle per plugin and MCP server, previews the diff, and shows the daemon's refusal verbatim", () => {
    const inspector = read("mac-app/conch-mac/CapabilityInspectorView.swift");
    const at = inspector.indexOf("struct ConfigTogglePreview: View");
    expect(at).toBeGreaterThan(-1);
    const preview = inspector.slice(at);
    // Every toggle previews first: the diff, the scope, the file, and the label that keeps it honest.
    expect(preview).toContain('Picker("Scope", selection: $scope)');
    expect(preview).toContain('Text("user").tag("user")');
    expect(preview).toContain('Text("project").tag("project")');
    expect(preview).toContain("Text(reply.diff.isEmpty ? \"No change: the file already says so.\" : reply.diff)");
    expect(preview).toContain('Text("Applies to the next session; a running session is untouched.")');
    expect(preview).toContain('Button(applied ? "Done" : "Cancel", role: .cancel, action: onDone)');
    expect(preview).toContain('Button("Apply") { apply() }');
    expect(preview).toContain("expectBeforeHash: preview ? nil : reply?.beforeHash");
    // The refusal is the daemon's text, never a paraphrase.
    expect(preview).toContain("case let .refused(error): message = error");

    const row = inspector.slice(inspector.indexOf("private struct CapabilityRow: View"), at);
    expect(row).toContain("Toggle(\"\", isOn: Binding(");
    expect(row).toContain("get: { entity.enabledForNextSession }");
    expect(row).toContain("set: { onToggle?(entity, $0) }");
    expect(row).toContain('Text("next session")');
    expect(row).toContain("if entity.isToggleable, onToggle != nil {");
    const model = read("mac-app/conch-mac/AgentCapabilities.swift");
    // Only standalone plugins and servers at a scope conch writes; a plugin's own servers ride with the plugin.
    expect(model).toContain("var isToggleable: Bool {");
    expect(model).toContain('(kind == "plugin" || kind == "mcp-server") && parentId == nil');
    expect(model).toContain('&& ["user", "project", "local"].contains(scope)');

    const store = read("mac-app/conch-mac/StateStore.swift");
    const toggle = store.indexOf("func toggleCapability(_ request: ConchConfigToggleRequest) async -> ConfigToggleOutcome {");
    expect(toggle).toBeGreaterThan(-1);
    const body = store.slice(toggle, toggle + 1200);
    expect(body).toContain("return .refused(error.error)");
    expect(body).toContain('return .refused("daemon not running")');
    const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
    expect(socket).toContain('let kind = "config-toggle"');
    expect(socket).toContain("let expectBeforeHash: String?");
    expect(socket).toContain("struct ConchConfigToggleReply: Decodable, Equatable, Sendable {");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isAgentCapabilitiesRead,
  readAgentCapabilities,
  type AgentCapabilityEntity,
} from "../src/agent-capabilities.ts";

const roots: string[] = [];

function fixture(): { root: string; cwd: string; claudeHome: string; codexHome: string; agentsHome: string } {
  const root = mkdtempSync(join(tmpdir(), "conch-capabilities-"));
  roots.push(root);
  const cwd = join(root, "repo");
  const claudeHome = join(root, ".claude");
  const codexHome = join(root, ".codex");
  const agentsHome = join(root, ".agents");
  for (const path of [join(cwd, ".git"), claudeHome, codexHome, agentsHome]) {
    mkdirSync(path, { recursive: true });
  }
  return { root, cwd, claudeHome, codexHome, agentsHome };
}

function write(path: string, contents: string | Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
}

function skill(path: string, name: string, extra = ""): void {
  write(path, `---\nname: ${name}\ndescription: ${name} description\n${extra}---\n# ${name}\n`);
}

function entity(
  entities: AgentCapabilityEntity[],
  kind: AgentCapabilityEntity["kind"],
  name: string,
): AgentCapabilityEntity {
  const found = entities.find((item) => item.kind === kind && item.name === name);
  if (!found) throw new Error(`missing ${kind} ${name}`);
  return found;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent capability discovery", () => {
  test("joins Claude plugin, skill, MCP project decisions, permissions, and positive usage without leaking secrets", () => {
    const f = fixture();
    const statePath = join(f.root, ".claude.json");
    const packagePath = join(f.root, "packages", "sample", "1.0.0");
    write(join(packagePath, ".claude-plugin", "plugin.json"), {
      name: "sample",
      description: "Sample plugin",
    });
    skill(join(packagePath, "skills", "plugin-skill", "SKILL.md"), "plugin-skill");
    // Claude plugins in the wild use both this direct form and {mcpServers:{...}}.
    write(join(packagePath, ".mcp.json"), {
      "plugin-server": {
        command: "bun",
        args: ["run", "--secret=DO_NOT_PUBLISH"],
        env: { PRIVATE_TOKEN: "secret-value" },
      },
    });
    write(join(f.claudeHome, "plugins", "installed_plugins.json"), {
      version: 2,
      plugins: {
        "sample@market": [{
          scope: "user",
          installPath: packagePath,
          version: "1.0.0",
        }],
      },
    });
    write(join(f.claudeHome, "settings.json"), {
      enabledPlugins: { "sample@market": false },
      skillOverrides: { "user-skill": "user-invocable-only" },
      permissions: { ask: ["mcp__project-server__write"] },
    });
    skill(join(f.claudeHome, "skills", "user-skill", "SKILL.md"), "user-skill", "allowed-tools: [Read, Grep]\n");
    write(join(f.cwd, ".mcp.json"), {
      mcpServers: {
        "project-server": {
          type: "http",
          url: "https://person:password@example.test/private/token?signature=DO_NOT_PUBLISH#fragment",
          headers: { Authorization: "Bearer DO_NOT_PUBLISH" },
          enabled_tools: ["read"],
        },
      },
    });
    write(statePath, {
      mcpServers: {
        global: { command: "global-server", env: { GLOBAL_SECRET: "DO_NOT_PUBLISH" } },
      },
      projects: {
        [f.cwd]: {
          enabledMcpServers: [],
          disabledMcpServers: ["plugin-server"],
          enabledMcpjsonServers: ["project-server"],
          disabledMcpjsonServers: [],
          hasTrustDialogAccepted: true,
          allowedTools: ["mcp__project-server__read"],
        },
      },
      pluginUsage: { "sample@market": { usageCount: 3, lastUsedAt: 1_786_000_000_000 } },
      skillUsage: { "plugin-skill": { usageCount: 1, lastUsedAt: 1_786_000_000_100 } },
    });

    const result = readAgentCapabilities({
      backend: "claude",
      cwd: f.cwd,
      sessionId: "session-1",
      claudeHome: f.claudeHome,
      claudeStatePath: statePath,
      claudeManagedSettingsPath: null,
      claudeManagedMcpPath: null,
      observations: [{
        kind: "mcp-tool",
        serverName: "project-server",
        toolName: "read",
        sessionId: "session-1",
        at: 1_786_000_000_200,
      }],
    });

    expect(result.complete).toBe(true);
    expect(isAgentCapabilitiesRead(result)).toBe(true);
    const plugin = entity(result.entities, "plugin", "sample");
    expect(plugin.kind === "plugin" && plugin.plugin).toMatchObject({
      pluginId: "sample@market",
      enabledForNextSession: false,
      components: { skills: 1, mcpServers: 1 },
    });
    expect(plugin.evidence).toMatchObject({
      configured: { state: "yes", basis: "provider-state" },
      available: { state: "no" },
      loaded: { state: "unknown" },
      observed: { state: "yes", basis: "provider-state" },
    });
    const pluginSkill = entity(result.entities, "skill", "plugin-skill");
    expect(pluginSkill.parentId).toBe(plugin.id);
    expect(pluginSkill.evidence.available.state).toBe("no");
    expect(pluginSkill.evidence.observed.state).toBe("yes");
    const userSkill = entity(result.entities, "skill", "user-skill");
    expect(userSkill.evidence.configured.basis).toBe("filesystem");
    expect(userSkill.kind === "skill" && userSkill.skill).toMatchObject({
      visibility: "user-invocable-only",
      userInvocable: true,
      modelInvocable: false,
      allowedTools: ["Read", "Grep"],
    });

    const projectServer = entity(result.entities, "mcp-server", "project-server");
    expect(projectServer.kind === "mcp-server" && projectServer.mcpServer).toMatchObject({
      url: "https://example.test/",
      credentialSources: ["header:Authorization"],
      projectDecision: "approved",
    });
    expect(projectServer.evidence.available.state).toBe("unknown");
    expect(projectServer.evidence.loaded.state).toBe("unknown");
    expect(projectServer.evidence.observed.state).toBe("yes");
    const readTool = entity(result.entities, "mcp-tool", "read");
    expect(readTool.kind === "mcp-tool" && readTool.mcpTool.policy).toBe("allow");
    expect(readTool.evidence.observed.state).toBe("yes");
    const pluginServer = entity(result.entities, "mcp-server", "plugin-server");
    expect(pluginServer.evidence.available.state).toBe("no");

    const wire = JSON.stringify(result);
    for (const secret of ["DO_NOT_PUBLISH", "secret-value", "password", "/private/token"]) {
      expect(wire).not.toContain(secret);
    }

    // A package upgrade must not replace the rank/feed identity.
    const nextPackagePath = join(f.root, "packages", "sample", "2.0.0");
    write(join(nextPackagePath, ".claude-plugin", "plugin.json"), { name: "sample" });
    write(join(f.claudeHome, "plugins", "installed_plugins.json"), {
      plugins: { "sample@market": [{ scope: "user", installPath: nextPackagePath, version: "2.0.0" }] },
    });
    const updated = readAgentCapabilities({
      backend: "claude",
      cwd: f.cwd,
      claudeHome: f.claudeHome,
      claudeStatePath: statePath,
      claudeManagedSettingsPath: null,
      claudeManagedMcpPath: null,
    });
    expect(entity(updated.entities, "plugin", "sample").id).toBe(plugin.id);
  });

  test("reads Codex config, plugin manifests, skill visibility, and tool policy from disk", () => {
    const f = fixture();
    const marketplace = join(f.root, "marketplace");
    const pluginRoot = join(marketplace, "plugins", "sample");
    const pluginSkillPath = join(pluginRoot, "skills", "codex-plugin-skill", "SKILL.md");
    const userSkillPath = join(f.agentsHome, "skills", "disabled-skill", "SKILL.md");
    skill(pluginSkillPath, "codex-plugin-skill");
    skill(userSkillPath, "disabled-skill");
    skill(join(f.cwd, ".agents", "skills", "project-skill", "SKILL.md"), "project-skill");
    write(join(pluginRoot, ".codex-plugin", "plugin.json"), {
      name: "sample",
      version: "2.0.0",
      skills: "./skills",
      mcpServers: "./.mcp.json",
    });
    write(join(pluginRoot, ".mcp.json"), {
      mcpServers: {
        "plugin-server": {
          command: "plugin-command",
          tools: { mutate: { approval_mode: "prompt" } },
        },
      },
    });
    write(join(f.codexHome, "config.toml"), `
[marketplaces.local]
source = ${JSON.stringify(marketplace)}

[plugins."sample@local"]
enabled = true

[plugins."sample@local".mcp_servers.plugin-server]
enabled = false

[mcp_servers.remote]
url = "https://token-user:token-password@example.test/secret/TOKEN_VALUE?signature=QUERY_SECRET"
http_headers = { Authorization = "Bearer HEADER_SECRET" }
enabled_tools = ["read"]
disabled_tools = ["delete"]

[mcp_servers.remote.tools.write]
approval_mode = "approve"

[mcp_servers.off]
command = "disabled-command"
enabled = false

[mcp_servers.layered]
command = "layered-command"

[[skills.config]]
path = ${JSON.stringify(userSkillPath)}
enabled = false

[projects.${JSON.stringify(f.cwd)}]
trust_level = "trusted"
`);
    write(join(f.cwd, ".codex", "config.toml"), `
[mcp_servers.layered]
enabled = false
`);
    const statePath = join(f.codexHome, "state_5.sqlite");
    const db = new Database(statePath, { create: true });
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      source TEXT,
      model_provider TEXT,
      sandbox_policy TEXT,
      approval_mode TEXT,
      model TEXT,
      reasoning_effort TEXT,
      memory_mode TEXT,
      history_mode TEXT,
      agent_path TEXT,
      cli_version TEXT,
      updated_at_ms INTEGER
    )`);
    db.query(`INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "thread-1",
        "cli",
        "openai",
        '{"type":"workspaceWrite"}',
        "never",
        "gpt-test",
        "high",
        "enabled",
        "legacy",
        "/tmp/agent.toml",
        "0.147.0",
        1_786_000_000_300,
      );
    db.close();

    const result = readAgentCapabilities({
      backend: "codex",
      cwd: f.cwd,
      sessionId: "thread-1",
      codexHome: f.codexHome,
      agentsHome: f.agentsHome,
      codexAdminSkills: join(f.root, "admin-skills"),
      codexManagedConfigPath: null,
      codexRequirementsPath: null,
    });

    expect(result.complete).toBe(true);
    expect(result.context.projectTrust).toMatchObject({
      projectPath: f.cwd,
      trusted: true,
      basis: "config",
    });
    expect(result.context.threadConfiguration).toMatchObject({
      basis: "provider-state",
      sourcePath: statePath,
      source: "cli",
      modelProvider: "openai",
      sandboxPolicy: '{"type":"workspaceWrite"}',
      approvalMode: "never",
      model: "gpt-test",
      reasoningEffort: "high",
      memoryMode: "enabled",
      historyMode: "legacy",
      agentPath: "/tmp/agent.toml",
      cliVersion: "0.147.0",
      recordedAt: 1_786_000_000_300,
    });
    const plugin = entity(result.entities, "plugin", "sample");
    expect(plugin.kind === "plugin" && plugin.plugin).toMatchObject({
      pluginId: "sample@local",
      enabledForNextSession: true,
      components: { skills: 1, mcpServers: 1 },
    });
    const pluginServer = entity(result.entities, "mcp-server", "plugin-server");
    expect(pluginServer.parentId).toBe(plugin.id);
    expect(pluginServer.evidence.available.state).toBe("no");
    const mutate = entity(result.entities, "mcp-tool", "mutate");
    expect(mutate.kind === "mcp-tool" && mutate.mcpTool.approvalMode).toBe("prompt");
    const disabled = entity(result.entities, "skill", "disabled-skill");
    expect(disabled.kind === "skill" && disabled.skill.enabledForNextSession).toBe(false);
    expect(disabled.evidence.available.state).toBe("no");
    expect(entity(result.entities, "skill", "project-skill").scope).toBe("project");

    const remote = entity(result.entities, "mcp-server", "remote");
    expect(remote.kind === "mcp-server" && remote.mcpServer).toMatchObject({
      url: "https://example.test/",
      credentialSources: ["header:Authorization"],
      enabledForNextSession: true,
    });
    const off = entity(result.entities, "mcp-server", "off");
    expect(off.kind === "mcp-server" && off.mcpServer.enabledForNextSession).toBe(false);
    expect(off.evidence.available.state).toBe("no");
    const layered = entity(result.entities, "mcp-server", "layered");
    expect(layered.kind === "mcp-server" && layered.mcpServer).toMatchObject({
      transport: "stdio",
      command: "layered-command",
      enabledForNextSession: false,
    });
    expect(layered.sources).toHaveLength(2);
    expect(entity(result.entities, "mcp-tool", "read").evidence.available.state).toBe("unknown");
    expect(entity(result.entities, "mcp-tool", "delete").evidence.available.state).toBe("no");
    const writeTool = entity(result.entities, "mcp-tool", "write");
    expect(writeTool.kind === "mcp-tool" && writeTool.mcpTool.approvalMode).toBe("approve");
    const wire = JSON.stringify(result);
    for (const secret of ["token-user", "token-password", "/secret/", "TOKEN_VALUE", "QUERY_SECRET", "HEADER_SECRET"]) {
      expect(wire).not.toContain(secret);
    }
  });

  test("reports Codex project trust and does not apply untrusted project config as effective", () => {
    const f = fixture();
    const userSkillPath = join(f.agentsHome, "skills", "user-skill", "SKILL.md");
    skill(userSkillPath, "user-skill");
    write(join(f.codexHome, "config.toml"), `
[projects.${JSON.stringify(f.cwd)}]
trust_level = "untrusted"
`);
    write(join(f.cwd, ".codex", "config.toml"), `
[[skills.config]]
path = ${JSON.stringify(userSkillPath)}
enabled = false

[mcp_servers.project-only]
command = "project-command"
`);

    const result = readAgentCapabilities({
      backend: "codex",
      cwd: f.cwd,
      codexHome: f.codexHome,
      agentsHome: f.agentsHome,
      codexAdminSkills: join(f.root, "admin-skills"),
      codexManagedConfigPath: null,
      codexRequirementsPath: null,
    });

    expect(result.context.projectTrust).toMatchObject({ trusted: false, basis: "config" });
    const userSkill = entity(result.entities, "skill", "user-skill");
    expect(userSkill.kind === "skill" && userSkill.skill.enabledForNextSession).toBe(true);
    const server = entity(result.entities, "mcp-server", "project-only");
    expect(server.kind === "mcp-server" && server.mcpServer.enabledForNextSession).toBe(true);
    expect(server.evidence.available).toMatchObject({
      state: "no",
      detail: expect.stringContaining("until this project is trusted"),
    });
  });

  test("applies file-based Claude managed settings, skills, and exclusive MCP definitions", () => {
    const f = fixture();
    const statePath = join(f.root, ".claude.json");
    const packagePath = join(f.root, "package");
    const managedRoot = join(f.root, "managed-claude");
    const managedSettingsPath = join(managedRoot, "managed-settings.json");
    const managedMcpPath = join(managedRoot, "managed-mcp.json");
    write(join(packagePath, ".claude-plugin", "plugin.json"), { name: "sample" });
    write(join(f.claudeHome, "plugins", "installed_plugins.json"), {
      plugins: { "sample@market": [{ scope: "user", installPath: packagePath }] },
    });
    write(join(f.claudeHome, "settings.json"), {
      enabledPlugins: { "sample@market": true },
    });
    write(managedSettingsPath, {
      enabledPlugins: { "sample@market": false },
    });
    skill(join(managedRoot, ".claude", "skills", "org-skill", "SKILL.md"), "org-skill");
    write(managedMcpPath, {
      mcpServers: {
        "managed-only": { command: "managed-command" },
      },
    });
    write(statePath, {
      mcpServers: { personal: { command: "personal-command" } },
      projects: { [f.cwd]: { hasTrustDialogAccepted: true } },
    });

    const result = readAgentCapabilities({
      backend: "claude",
      cwd: f.cwd,
      claudeHome: f.claudeHome,
      claudeStatePath: statePath,
      claudeManagedSettingsPath: managedSettingsPath,
      claudeManagedMcpPath: managedMcpPath,
    });

    const plugin = entity(result.entities, "plugin", "sample");
    expect(plugin.kind === "plugin" && plugin.plugin.enabledForNextSession).toBe(false);
    const personal = entity(result.entities, "mcp-server", "personal");
    expect(personal.evidence.available).toMatchObject({
      state: "no",
      detail: expect.stringContaining("exclusive control"),
    });
    expect(entity(result.entities, "mcp-server", "managed-only").scope).toBe("managed");
    expect(entity(result.entities, "mcp-server", "managed-only").evidence.available.state).toBe("unknown");
    expect(entity(result.entities, "skill", "org-skill").scope).toBe("managed");
  });

  test("merges Codex managed defaults and applies exact managed MCP/plugin requirements", () => {
    const f = fixture();
    const marketplace = join(f.root, "marketplace");
    const pluginRoot = join(marketplace, "plugins", "sample");
    const managedConfigPath = join(f.root, "managed_config.toml");
    const requirementsPath = join(f.root, "requirements.toml");
    write(join(pluginRoot, ".codex-plugin", "plugin.json"), { name: "sample" });
    write(join(f.codexHome, "config.toml"), `
[marketplaces.local]
source = ${JSON.stringify(marketplace)}

[plugins."sample@local"]
enabled = true

[mcp_servers.allowed]
url = "https://allowed.test/mcp"

[mcp_servers.blocked]
command = "blocked-command"
`);
    write(managedConfigPath, `
[plugins."sample@local"]
enabled = false

[mcp_servers.managed-default]
command = "managed-command"
`);
    write(requirementsPath, `
[features]
plugins = false

[mcp_servers.allowed]
identity = { url = "https://allowed.test/mcp" }
`);

    const result = readAgentCapabilities({
      backend: "codex",
      cwd: f.cwd,
      codexHome: f.codexHome,
      agentsHome: f.agentsHome,
      codexAdminSkills: join(f.root, "admin-skills"),
      codexManagedConfigPath: managedConfigPath,
      codexRequirementsPath: requirementsPath,
    });

    const plugin = entity(result.entities, "plugin", "sample");
    expect(plugin.kind === "plugin" && plugin.plugin.enabledForNextSession).toBe(false);
    expect(plugin.evidence.available.detail).toContain("Managed requirements disable plugins");
    expect(plugin.sources.map((source) => source.path)).toContain(managedConfigPath);
    expect(entity(result.entities, "mcp-server", "allowed").evidence.available.state).toBe("unknown");
    expect(entity(result.entities, "mcp-server", "blocked").evidence.available).toMatchObject({
      state: "no",
      detail: expect.stringContaining("do not allow"),
    });
    expect(entity(result.entities, "mcp-server", "managed-default").evidence.available.state).toBe("no");
    expect(result.entities.filter((item) => item.kind === "plugin" && item.name === "sample")).toHaveLength(1);
  });

  test("reports malformed sources as incomplete and suppresses real-home reads under a redirected conch home", () => {
    const f = fixture();
    const statePath = join(f.root, ".claude.json");
    write(statePath, "{not-json");
    const malformed = readAgentCapabilities({
      backend: "claude",
      cwd: f.cwd,
      claudeHome: f.claudeHome,
      claudeStatePath: statePath,
      claudeManagedSettingsPath: null,
      claudeManagedMcpPath: null,
    });
    expect(malformed.complete).toBe(false);
    expect(malformed.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-json" }));

    const suppressed = readAgentCapabilities({
      backend: "codex",
      cwd: f.cwd,
      configDir: join(f.root, "conch-config"),
    });
    expect(suppressed.entities).toEqual([]);
    expect(suppressed.complete).toBe(true);
  });

  test("keeps an observed-only MCP call without pretending it is configured, loaded, or still available", () => {
    const f = fixture();
    const result = readAgentCapabilities({
      backend: "codex",
      cwd: f.cwd,
      codexHome: f.codexHome,
      agentsHome: f.agentsHome,
      codexAdminSkills: join(f.root, "admin-skills"),
      codexManagedConfigPath: null,
      codexRequirementsPath: null,
      observations: [{
        kind: "mcp-tool",
        serverName: "ephemeral",
        toolName: "lookup",
        sessionId: "thread-1",
      }],
    });
    const server = entity(result.entities, "mcp-server", "ephemeral");
    expect(server.evidence).toMatchObject({
      configured: { state: "unknown" },
      available: { state: "unknown" },
      loaded: { state: "unknown" },
      observed: { state: "yes" },
    });
    const tool = entity(result.entities, "mcp-tool", "lookup");
    expect(tool.parentId).toBe(server.id);
    expect(tool.evidence.configured.state).toBe("unknown");
    expect(tool.evidence.observed.state).toBe("yes");
  });

  test("does not guess which configured server owns an ambiguous observation", () => {
    const f = fixture();
    const statePath = join(f.root, ".claude.json");
    write(statePath, {
      mcpServers: { duplicate: { command: "global-command" } },
      projects: {
        [f.cwd]: {
          hasTrustDialogAccepted: true,
          enabledMcpjsonServers: ["duplicate"],
        },
      },
    });
    write(join(f.cwd, ".mcp.json"), {
      mcpServers: { duplicate: { command: "project-command" } },
    });

    const result = readAgentCapabilities({
      backend: "claude",
      cwd: f.cwd,
      claudeHome: f.claudeHome,
      claudeStatePath: statePath,
      claudeManagedSettingsPath: null,
      claudeManagedMcpPath: null,
      observations: [{
        kind: "mcp-tool",
        serverName: "duplicate",
        toolName: "read",
        sessionId: "session-1",
      }],
    });

    const servers = result.entities.filter((item) => item.kind === "mcp-server" && item.name === "duplicate");
    expect(servers).toHaveLength(3);
    const configured = servers.filter((item) => item.evidence.configured.state === "yes");
    expect(configured).toHaveLength(2);
    expect(configured.every((item) => item.evidence.observed.state === "unknown")).toBe(true);
    const observed = servers.find((item) => item.evidence.configured.state === "unknown");
    expect(observed?.evidence.observed.state).toBe("yes");
    expect(observed?.diagnostics).toContainEqual(expect.objectContaining({ code: "ambiguous-mcp-observation" }));
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_COMMANDS,
  AGENT_INSTRUCTIONS,
  movedToolDescription,
  renderAgentsMd,
  renderSkillMd,
  CLAUDE_CODE_INSTRUCTIONS_CUT,
  REVIEW_TO_FRONT_DESCRIPTION_MAX,
  SERVER_INSTRUCTIONS_MAX,
  type AgentInstructions,
} from "../src/agent-instructions.ts";
import { renderHelpSessionClaudeMd } from "../src/help-session.ts";
import { buildMcpTools, initializeResult, MCP_LISTED_TOOLS, MCP_TOOLS } from "../src/mcp.ts";

/**
 * What conch tells agents has one source. The AGENTS.md, the skill, the help
 * session's conch section and the tool descriptions used to be four texts that
 * disagreed; each is rendered here from a marked copy of the source, so a doc
 * that stops reading from it (a pasted copy, a default argument ignored) fails.
 */
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const marked: AgentInstructions = {
  alwaysOn: `${AGENT_INSTRUCTIONS.alwaysOn}\n\nMARK-ALWAYS-ON`,
  serverInstructions: "MARK-SERVER-INSTRUCTIONS",
  skillDescription: "MARK-SKILL-DESCRIPTION",
  missingTools: "MARK-MISSING-TOOLS",
  tools: Object.fromEntries(
    Object.entries(AGENT_INSTRUCTIONS.tools).map(([name, description]) => [name, `${description} MARK-${name}`]),
  ) as AgentInstructions["tools"],
};

describe("one source for the agent-facing instructions", () => {
  test("a change in the source shows up in every generated doc and every tool description", () => {
    expect(renderAgentsMd(marked)).toContain("MARK-ALWAYS-ON");

    const skill = renderSkillMd(undefined, marked);
    expect(skill).toContain("MARK-ALWAYS-ON");
    expect(skill).toStartWith("---\nname: conch-control\ndescription: MARK-SKILL-DESCRIPTION\n---\n");
    expect(skill).not.toContain("{{ALWAYS_ON}}");

    const help = renderHelpSessionClaudeMd({ CONCH_CONFIG_DIR: "/cfg" }, marked);
    expect(help).toContain("MARK-ALWAYS-ON");
    expect(help).toContain("MARK-MISSING-TOOLS");
    expect(help).not.toContain("{{");

    // What the MCP server says at `initialize`, which Claude Code puts in every session that loads the plugin.
    expect(initializeResult(undefined, marked).instructions).toBe("MARK-SERVER-INSTRUCTIONS");

    const tools = buildMcpTools(marked);
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(marked.tools));
    for (const tool of tools) {
      expect(tool.description).toBe((marked.tools as Record<string, string>)[tool.name]);
      expect(help).toContain(`MARK-${tool.name}`);
    }
    for (const command of AGENT_COMMANDS) expect(help).toContain(`conch agent ${command.name}`);
  });

  test("what ships is the source's own rendering", () => {
    // A listed tool says what it is; a moved one says where it went, from the command it is now.
    const listed = AGENT_INSTRUCTIONS.tools as Record<string, string>;
    for (const tool of MCP_TOOLS) expect(tool.description).toBe(listed[tool.name] ?? movedToolDescription(tool.name));
    expect(MCP_LISTED_TOOLS.map((tool) => tool.name)).toEqual(Object.keys(AGENT_INSTRUCTIONS.tools));
    expect(initializeResult({ protocolVersion: "2025-06-18" }).instructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
    expect(read("plugin/plugins/conch/AGENTS.md")).toBe(renderAgentsMd());
    expect(read("plugin/plugins/conch/skills/conch-control/SKILL.md")).toBe(renderSkillMd());
    expect(renderHelpSessionClaudeMd()).toContain(AGENT_INSTRUCTIONS.missingTools);
  });

  // 2026-10-18 review: Codex put the instructions in front of each tool's own description, so its 25 tools read alike.
  test("a Codex client gets no server instructions, since AGENTS.md carries them; Claude Code and an unnamed client do", () => {
    const codex = initializeResult({ protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "0.163.0" } });
    expect(codex).not.toHaveProperty("instructions");
    expect(codex.serverInfo.name).toBe("conch");
    expect(initializeResult({ clientInfo: { name: "claude-code" } }).instructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
    expect(initializeResult({}).instructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
  });

  /**
   * What every session carries stays short: Claude Code cuts server instructions and tool descriptions past 2048
   * characters (ending them in "… [truncated]"), and lists every skill's description in every session.
   */
  test("what every session carries stays within its budget", () => {
    expect(SERVER_INSTRUCTIONS_MAX).toBeLessThanOrEqual(CLAUDE_CODE_INSTRUCTIONS_CUT - 500);
    expect(AGENT_INSTRUCTIONS.serverInstructions.length).toBeLessThanOrEqual(SERVER_INSTRUCTIONS_MAX);
    expect(AGENT_INSTRUCTIONS.serverInstructions).not.toContain("\n");
    expect(AGENT_INSTRUCTIONS.tools.review_to_front.length).toBeLessThanOrEqual(REVIEW_TO_FRONT_DESCRIPTION_MAX);
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "review_to_front")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    for (const [name, property] of Object.entries(properties)) expect(property.description?.length ?? 0, name).toBeLessThanOrEqual(160);
    expect(AGENT_INSTRUCTIONS.skillDescription.length).toBeLessThan(300);
  });
});

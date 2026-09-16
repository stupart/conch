import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_INSTRUCTIONS,
  renderAgentsMd,
  renderSkillMd,
  type AgentInstructions,
} from "../src/agent-instructions.ts";
import { renderHelpSessionClaudeMd } from "../src/help-session.ts";
import { buildMcpTools, MCP_TOOLS } from "../src/mcp.ts";

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

    const tools = buildMcpTools(marked);
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(marked.tools) as typeof tools[number]["name"][]);
    for (const tool of tools) {
      expect(tool.description).toBe(marked.tools[tool.name]);
      expect(help).toContain(`MARK-${tool.name}`);
    }
  });

  test("what ships is the source's own rendering", () => {
    for (const tool of MCP_TOOLS) expect(tool.description).toBe(AGENT_INSTRUCTIONS.tools[tool.name]);
    expect(read("plugin/plugins/conch/AGENTS.md")).toBe(renderAgentsMd());
    expect(read("plugin/plugins/conch/skills/conch-control/SKILL.md")).toBe(renderSkillMd());
    expect(renderHelpSessionClaudeMd()).toContain(AGENT_INSTRUCTIONS.missingTools);
  });

  test("the stale wording is gone from everything conch tells an agent", () => {
    const told = [
      renderAgentsMd(),
      renderSkillMd(),
      renderHelpSessionClaudeMd(),
      JSON.stringify(MCP_TOOLS),
      read("src/mcp.ts"),
      read("src/install.ts"),
      read("src/plugin-install.ts"),
    ].join("\n");
    for (const stale of [
      /final approval gate/i,
      /already spoken/i,
      /announced anyway/i,
      /produced only prose/i,
      /bring (?:one|a session|it) forward/i,
    ]) expect(told).not.toMatch(stale);
    // The dead global-instruction writer, whose block said "final approval gate".
    expect(read("src/install.ts")).not.toContain("REVIEW_INSTRUCTIONS");
  });
});

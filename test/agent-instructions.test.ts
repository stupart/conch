import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_INSTRUCTIONS,
  renderAgentsMd,
  renderSkillMd,
  SERVER_INSTRUCTIONS_MAX,
  type AgentInstructions,
} from "../src/agent-instructions.ts";
import { renderHelpSessionClaudeMd } from "../src/help-session.ts";
import { buildMcpTools, initializeResult, MCP_TOOLS } from "../src/mcp.ts";

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
    expect(tools.map((tool) => tool.name)).toEqual(Object.keys(marked.tools) as typeof tools[number]["name"][]);
    for (const tool of tools) {
      expect(tool.description).toBe(marked.tools[tool.name]);
      expect(help).toContain(`MARK-${tool.name}`);
    }
  });

  test("what ships is the source's own rendering", () => {
    for (const tool of MCP_TOOLS) expect(tool.description).toBe(AGENT_INSTRUCTIONS.tools[tool.name]);
    expect(initializeResult({ protocolVersion: "2025-06-18" }).instructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
    expect(read("plugin/plugins/conch/AGENTS.md")).toBe(renderAgentsMd());
    expect(read("plugin/plugins/conch/skills/conch-control/SKILL.md")).toBe(renderSkillMd());
    expect(renderHelpSessionClaudeMd()).toContain(AGENT_INSTRUCTIONS.missingTools);
  });

  /**
   * Every session that loads the plugin is told, at `initialize`, that conch is watching it. Claude Code cuts server
   * instructions past 2048 characters, and this sits in every session's context, so it is a pointer kept well under
   * that: what to do (publish what the user should look at, say where it landed) and where the manual is.
   */
  test("the server's instructions say conch is watching, what to do about it, and where the rest is, in a short budget", () => {
    const told = AGENT_INSTRUCTIONS.serverInstructions;
    expect(SERVER_INSTRUCTIONS_MAX).toBeLessThanOrEqual(500);
    expect(told.length).toBeLessThanOrEqual(SERVER_INSTRUCTIONS_MAX);
    expect(told).toStartWith("This session is watched by conch");
    expect(told).toContain("publish it with review_to_front instead of only mentioning a path");
    expect(told).toMatch(/a page, image, file, folder, build or app state/);
    expect(told).toContain("where it landed from the result’s surfaces");
    expect(told).toContain("/tmp or macOS’s /var/folders/…/T is copied into conch");
    // Both agents' names for the skill: Claude Code namespaces a plugin's skills, Codex reads the folder's.
    expect(told).toContain("conch-control skill (conch:conch-control)");
    expect(told).not.toContain("\n");
  });

  test("the skill's description says when to load it: something to look at, or the other sessions", () => {
    expect(AGENT_INSTRUCTIONS.skillDescription).toStartWith("Publish what the user should look at (a page, image, file, folder, build or app state) with review_to_front");
    expect(AGENT_INSTRUCTIONS.skillDescription).toContain("see or steer their other Claude Code and Codex sessions when asked");
    // Claude Code lists every skill's description in every session.
    expect(AGENT_INSTRUCTIONS.skillDescription.length).toBeLessThan(300);
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

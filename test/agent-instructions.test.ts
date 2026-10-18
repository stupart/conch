import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_INSTRUCTIONS,
  renderAgentsMd,
  renderSkillMd,
  CLAUDE_CODE_INSTRUCTIONS_CUT,
  REVIEW_TO_FRONT_DESCRIPTION_MAX,
  SERVER_INSTRUCTIONS_MAX,
  TOOLSEARCH_PRELOAD,
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
    // Well under Claude Code's cut, which would end it in "… [truncated]" and lose the ToolSearch line.
    expect(SERVER_INSTRUCTIONS_MAX).toBeLessThanOrEqual(CLAUDE_CODE_INSTRUCTIONS_CUT - 500);
    expect(told.length).toBeLessThanOrEqual(SERVER_INSTRUCTIONS_MAX);
    expect(told).toStartWith("This session is watched by conch");
    expect(told).toContain("publish it with review_to_front instead of only mentioning a path");
    expect(told).toMatch(/a page, image, file, folder, build or app state/);
    expect(told).toContain("where it landed from the result’s surfaces");
    expect(told).toContain("/tmp or macOS’s /var/folders/…/T is copied into conch");
    // Both agents' names for the skill: Claude Code namespaces a plugin's skills, Codex reads the folder's.
    expect(told).toContain("conch-control skill (conch:conch-control)");
    expect(told).not.toContain("\n");
    // 2026-10-05: as the work goes, not only for the final result.
    expect(told).toContain("Whenever there is something to look at");
    expect(told).toContain("as you go and not only at the end");
  });

  /**
   * 2026-10-18 review: no Claude Code agent loaded conch_capture or browser_* through ToolSearch in three weeks, and they
   * wrote 686 Playwright screenshot scripts, 112 with conch_capture in their tool list. Claude in Chrome's instructions
   * give a one-line `select:` preload that agents copy; conch's now do too, with Claude Code's own names for the tools.
   */
  test("the server's instructions give Claude Code one ToolSearch line for conch's page tools, and say conch_capture over a script", () => {
    const told = AGENT_INSTRUCTIONS.serverInstructions;
    const select = /query "select:([^"]+)"/.exec(told)?.[1];
    expect(select?.split(",")).toEqual(TOOLSEARCH_PRELOAD.map((tool) => `mcp__plugin_conch_conch__${tool}`));
    for (const tool of TOOLSEARCH_PRELOAD) expect(MCP_TOOLS.some((one) => one.name === tool)).toBe(true);
    expect(TOOLSEARCH_PRELOAD).toContain("conch_capture");
    expect(told).toContain("in one ToolSearch call");
    expect(told).toContain("use conch_capture rather than writing a Playwright screenshot script");
    expect(told).toContain("To fork a session, conch_fork.");
  });

  // 2026-10-18 review: Codex put the instructions in front of each tool's own description, so its 25 tools read alike.
  test("a Codex client gets no server instructions, since AGENTS.md carries them; Claude Code and an unnamed client do", () => {
    const codex = initializeResult({ protocolVersion: "2025-06-18", clientInfo: { name: "codex-mcp-client", version: "0.163.0" } });
    expect(codex).not.toHaveProperty("instructions");
    expect(codex.serverInfo.name).toBe("conch");
    expect(initializeResult({ clientInfo: { name: "claude-code" } }).instructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
    expect(initializeResult({}).instructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
    expect(renderAgentsMd()).toContain("publish it with `review_to_front` as you go");
  });

  /**
   * 2026-10-05: Tyler asked whether anything in the MCP made agents less likely to show what they do in conch. The
   * description had grown from 403 characters (v0.3.0) to 2,036, just under Claude Code's 2048 cut, and led with
   * mechanics and obligations: when to publish was buried under copies, verdicts, surfaces states and login walls.
   * It leads with when and why now, and stays short, so it can't creep back up to the cap.
   */
  test("review_to_front's description leads with when to publish, and stays short", () => {
    const description = AGENT_INSTRUCTIONS.tools.review_to_front;
    expect(REVIEW_TO_FRONT_DESCRIPTION_MAX).toBeLessThanOrEqual(1000);
    expect(description.length).toBeLessThanOrEqual(REVIEW_TO_FRONT_DESCRIPTION_MAX);
    expect(description).toStartWith(
      "Publish whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), as you go, not only at the end.",
    );
    // Why it is cheap, before any of how.
    expect(description.indexOf("it doesn’t interrupt them")).toBeLessThan(description.indexOf("Pass a one-line summary"));
    expect(description).toContain("Publishing the same link or key again adds its next version");
    expect(description).toEndWith("The result says where it landed (surfaces) and any warning or relabel to act on; tell the user from that, not from what you assume.");
    // The mechanics are the parameters' and the skill's; the next test says where.
    for (const mechanic of ["copiedFrom", "approval", "snapshot", "paired-not-connected", "login wall", "never by default"]) {
      expect(description).not.toContain(mechanic);
    }
  });

  test("what the description no longer says is where the agent reads it: the parameters and the skill", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "review_to_front")!;
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    const link = properties.link.description!;
    expect(link).toContain("A file or folder in a temp folder is filed as conch's own copy");
    expect(link).toContain("the result's copiedFrom names the original");
    expect(link).toContain("link the folder and name the paths to look at with focus");
    expect(link).toContain("access says what conch's Mac, with its review pane's sign-ins, and a device without them (the phone) were shown (mac and anonymous: page, sign-in or unchecked)");
    expect(link).toContain("snapshot is the Mac's picture of the page, which the phone shows first");
    expect(link).toContain("warning, when either was shown a sign-in page, says what to do: act on it");
    expect(properties.approval.description).toContain("only when you are waiting on the user's yes to proceed: never by default");
    expect(properties.key.description).toContain("publishing it again is its next version");
    expect(properties.scene.description).toContain("What the pill click brings forward");

    const skill = renderSkillMd();
    for (const said of [
      "`mac`: `showing`",
      "`running`",
      "`not-running`",
      "`phone`: `connected`",
      "`paired-not-connected`",
      "`audio`: `mac`",
      "`other-mac`",
      "`access` says what each\n  was shown",
      "`snapshot`",
      "`warning` is there when either look was a sign-in page",
      "the result carries `relabel: {label, hint}`",
      "the result's `copiedFrom` names the original",
      "Set `approval` only when you are waiting on\n  the user's approval to go on, never by default",
      "Publishing\n  opens nothing and doesn't end your turn",
    ]) expect(skill).toContain(said);
  });

  // 2026-10-05: every session is told to publish as it goes, and still not after every edit, so versions don't pile up.
  test("the always-on text says to publish as you go, and not after every edit", () => {
    const told = AGENT_INSTRUCTIONS.alwaysOn;
    expect(told).toContain("Whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), publish it with `review_to_front` as you go, not only at the end");
    expect(told).toContain("Publishing makes the result available without interrupting the user");
    expect(told).toContain("Publish again whenever it changes in a way worth seeing, not after every edit");
  });

  // 2026-10-16: the Workdesk, its typed items, where to show work, the browser to browse in, sign-ins, and Atlas pages.
  test("the always-on text names the Workdesk and its items, and says how to show work there", () => {
    const told = AGENT_INSTRUCTIONS.alwaysOn;
    expect(told).toContain("a Workdesk of typed items beside the conversation: deliverables, browser tabs, files, shell, terminal");
    expect(told).toContain("Show your work there: results with `review_to_front`, pages with `browser_open`.");
    expect(told).toContain("Browse for the user with conch’s `browser_*` tools so they can watch in the Workdesk; other browser tools are fine when they ask or the task needs them.");
    expect(told).toContain("At a sign-in, ask them to sign in in the tab with `browser_ask`; never type passwords.");
    expect(told).toContain("Show an Atlas page you read or wrote that matters to the user with `atlas_show`.");
    const skill = renderSkillMd();
    expect(skill).toContain("## The Workdesk");
    expect(skill).toContain("**Signing in is the user's.**");
    expect(skill).toContain("stop and ask in the tab itself: `browser_ask {tab?,\n    reason}`");
    expect(skill).toContain("Passkeys don't work in conch's browser yet");
    expect(skill).toContain("**Pause agents.**");
    expect(skill).toContain("- **Show an Atlas page** — `atlas_show {path, markdown, summary?}`");
    expect(skill).toContain('key:\n  "atlas:<path>"}`');
    expect(skill).toContain("conch never fetches Atlas");
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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import conchControlProse from "../docs/conch-control-skill.md" with { type: "text" };

/**
 * The one source for what conch tells agents.
 *
 * Four texts used to say four different things: the plugin's AGENTS.md said
 * replies are already spoken and prose should not be published, the old global
 * block said "final approval gate", the help session said wake and recite bring
 * a session forward, and the tool descriptions said something else again. Each
 * is now rendered from this object, and a test renders them from a changed copy
 * so a doc that stops reading from here fails:
 *
 * - the plugin's AGENTS.md (`renderAgentsMd`), which Codex carries always-on
 * - the conch-control SKILL.md (`renderSkillMd`), frontmatter and `{{ALWAYS_ON}}`
 * - the help session's conch section (`renderHelpConchSection`)
 * - every MCP tool description (`buildMcpTools` in mcp.ts)
 *
 * A leaf module: the help session imports it, and must stay a leaf.
 */

/** A `conch_speak` is a confirmation, not a narration; longer is refused, never cut. */
export const MAX_SPEAK_CHARS = 600;

export const AGENT_INSTRUCTIONS = {
  alwaysOn: `conch connects this session to the user’s Mac workspace, floating overlay, and iPhone.

When you have a meaningful result or something the user should inspect, call \`review_to_front\` with a short summary and the best artifact link. For a written explanation, request a conversation scene (\`scene: {v: 1, target: {kind: "conversation"}}\`) and keep the complete explanation in your normal reply.

Publishing makes the result available. The user chooses when to open it. Do not open applications, rearrange windows, or start the microphone as a publication side effect. Publish again when the result materially changes, not after every edit.

Omit \`session\` when publishing. Never attribute work to another session or invent surface references.

For user-requested session, audio, or settings control, load the \`conch-control\` skill, inspect current IDs with \`conch_sessions\`, and perform the requested action. Respect manual mode and report refusals.

If publication is unavailable, leave the result in your reply. Where supported, use one final \`conch:review <summary> | <link>\` line; do not retry under another session’s identity.`,

  /** The skill's frontmatter description, which Claude Code carries always-on. */
  skillDescription:
    "Publish a meaningful result for the user to inspect with review_to_front, and see or steer their other Claude Code and Codex sessions when asked. Use when you have a result worth inspecting, or when asked what the other sessions are doing.",

  /** What a session with no conch tools should conclude, and not do. */
  missingTools:
    "If you have no `conch_*` tools, the conch plugin is not loaded in this session. Say so, and check whether it is installed and enabled (`claude plugin list`) before suggesting anything; do not reinstall or restart on your own. When it is missing, `conch install-plugin` is the person's to run.",

  tools: {
    conch_sessions:
      "Read live session state and IDs, and `caller`: whether conch verified which session you are. This is not complete conversation history.",
    conch_wake:
      "At the user’s request, open the microphone addressed to a session. Defaults to your verified session. Does not stage a scene.",
    conch_recite:
      "At the user’s request, read a session’s latest assistant reply aloud. Defaults to your verified session. Does not open its workspace.",
    conch_speak:
      `Speak a requested short confirmation, up to ${MAX_SPEAK_CHARS} characters. Respect manual mode; do not duplicate replies or narrate progress.`,
    conch_mode:
      "Set a session to manual or automatic speech and listening. Defaults to your verified session. Change all sessions only when explicitly requested.",
    conch_rename:
      "Persist the user-requested display label for a session. Prefer its ID; ambiguous names are refused.",
    conch_config:
      "Read settings or change a user-requested supported voice or timing setting. Changes affect the running daemon.",
    conch_transcript_tail:
      "Read the last sentences of a live session’s latest assistant reply. Does not retrieve full history or verify tool results.",
    review_to_front:
      "Publish your session’s result for the user to inspect, with a concise summary and optional artifact or conversation scene. The user's pill click stages it. Publishing does not open applications or finish the running turn.",
  },
};

export type AgentInstructions = typeof AGENT_INSTRUCTIONS;
export type ConchToolName = keyof AgentInstructions["tools"];

/** The plugin's AGENTS.md: what every Codex session carries before anything is asked. */
export function renderAgentsMd(text: AgentInstructions = AGENT_INSTRUCTIONS): string {
  return `# conch\n\n${text.alwaysOn}\n`;
}

/** The conch-control skill: the long-form prose, with the always-on text where it says `{{ALWAYS_ON}}`. */
export function renderSkillMd(prose: string = conchControlProse, text: AgentInstructions = AGENT_INSTRUCTIONS): string {
  if (!prose.includes("{{ALWAYS_ON}}")) throw new Error("conch-control prose has no {{ALWAYS_ON}} placeholder");
  return `---\nname: conch-control\ndescription: ${text.skillDescription}\n---\n\n${prose.replace("{{ALWAYS_ON}}", text.alwaysOn)}`;
}

/** The help session's "What you can do from here", in place of `{{CONCH_SECTION}}`. */
export function renderHelpConchSection(text: AgentInstructions = AGENT_INSTRUCTIONS): string {
  const tools = Object.entries(text.tools).map(([name, description]) => `- \`${name}\`: ${description}`);
  return [
    "## What you can do from here",
    "",
    "Your conch tools come from the plugin. Load the `conch-control` skill for how to use them.",
    "",
    ...tools,
    "",
    text.missingTools,
    "",
    "What every session is told about publishing results:",
    "",
    ...text.alwaysOn.split("\n").map((line) => (line ? `> ${line}` : ">")),
  ].join("\n");
}

/**
 * The marketplace serves `plugin/plugins/conch` straight from git, so the
 * generated AGENTS.md and SKILL.md are checked in. `bun src/agent-instructions.ts`
 * rewrites both; a test fails until they match.
 */
if (import.meta.main) {
  const pluginRoot = join(import.meta.dir, "..", "plugin", "plugins", "conch");
  const skill = join(pluginRoot, "skills", "conch-control", "SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(join(pluginRoot, "AGENTS.md"), renderAgentsMd());
  writeFileSync(skill, renderSkillMd());
}

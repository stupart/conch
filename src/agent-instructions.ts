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
 * - the MCP server's `instructions` (`initialize` in mcp.ts), which Claude Code carries always-on
 *
 * A leaf module: the help session imports it, and must stay a leaf.
 */

/** A `conch_speak` is a confirmation, not a narration; longer is refused, never cut. */
export const MAX_SPEAK_CHARS = 600;

/**
 * The longest the server's `instructions` may be. Claude Code cuts them at 2048 characters
 * (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`, 2.1.280) and adds "… [truncated]"; well under that,
 * so every line of it arrives, and short enough to sit in every session's context for nothing.
 */
export const SERVER_INSTRUCTIONS_MAX = 500;

/**
 * The longest `review_to_front`'s own description may be. 2026-10-05: Tyler asked whether anything in the MCP made
 * agents less likely to show what they do in conch. It had: the description grew from 403 characters (v0.3.0) to
 * 2,036, just under Claude Code's 2048 cut, and read as a list of mechanics and obligations (copies, verdicts,
 * surfaces states, login walls, approval rules) with when to publish buried in it, so publishing looked like a heavy,
 * careful act rather than a habit. The description says when and why to publish, what to pass and what the result
 * means, in a few lines; the mechanics live in the parameters' own descriptions and the conch-control skill.
 */
export const REVIEW_TO_FRONT_DESCRIPTION_MAX = 1000;

export const AGENT_INSTRUCTIONS = {
  /**
   * What every session is told about publishing. 2026-10-05: it says what counts (a plan, a diff or PR, not only a
   * finished page) and to publish as you go, not only at the end; it used to say "a meaningful result", which read as
   * the final one. "Not after every edit" stays, so versions don't pile up.
   */
  alwaysOn: `conch connects this session to the user’s Mac workspace, floating overlay, and iPhone.

Whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), publish it with \`review_to_front\` as you go, not only at the end: a short summary and the best artifact link. Then tell the user where it landed from the result’s \`surfaces\`, not what you assume. When the thing to look at has no link (an app window, the Simulator, a terminal, a design), pass its \`kind\` and say where to look in the summary. For a written explanation, request a conversation scene (\`scene: {v: 1, target: {kind: "conversation"}}\`) and keep the complete explanation in your normal reply.

A link is an http(s) URL, or an absolute path to a file or a folder (shown as its file tree) under this session’s folders: where it started, where it is now, its git repository, \`conch_working_folders\`, or a temp folder (/tmp, or macOS’s per-user /var/folders/…/T), which conch copies when it files the link, so a cleaned temp folder can’t take it away. Never a hidden file, key or executable.

To show part of a web page, use \`conch_capture\` rather than screenshotting a browser.

Publishing makes the result available without interrupting the user, who chooses when to open it. Do not open applications, rearrange windows, or start the microphone as a publication side effect. Publish again whenever it changes in a way worth seeing, not after every edit: the same link or \`key\` files the artifact's next version. \`conch_deliverables\` lists what you have published; \`review_remove\` takes back one that is wrong or obsolete.

Omit \`session\` when publishing. Never attribute work to another session or invent surface references.

If your work is in a folder other than the one this session started in, say so once with \`conch_working_folders\`; conch’s file tree and sidebar follow it.

For user-requested session, audio, or settings control, load the \`conch-control\` skill, inspect current IDs with \`conch_sessions\`, and perform the requested action. Respect manual mode and report refusals.

If publication is unavailable, leave the result in your reply and end it with one \`conch:review <summary> | <link>\` line (only the last counts, so link a folder for several things); do not retry under another session’s identity. A refused link is dropped and the summary kept; conch tells the user and you why.`,

  /**
   * What the MCP server says in its `initialize` reply (`instructions`), which Claude Code puts in
   * every session that loads the plugin, where the skill is only a name until it is loaded and
   * AGENTS.md reaches Codex alone. A Claude Code session used to learn conch was watching only if
   * it went looking. Short on purpose: Claude Code cuts server instructions past 2048 characters,
   * and this is a pointer, the skill is the manual (`SERVER_INSTRUCTIONS_MAX`). 2026-10-05: it says to publish as you
   * go, not only at the end, as the always-on text and `review_to_front` now do.
   */
  serverInstructions:
    "This session is watched by conch: the user follows it from conch’s Mac app and their iPhone, often away from the desk. Whenever there is something to look at (a page, image, file, folder, build or app state), as you go and not only at the end, publish it with review_to_front instead of only mentioning a path, then tell them where it landed from the result’s surfaces. A file in /tmp or macOS’s /var/folders/…/T is copied into conch. Load the conch-control skill (conch:conch-control) for details.",

  /** The skill's frontmatter description, which Claude Code carries always-on. */
  skillDescription:
    "Publish what the user should look at (a page, image, file, folder, build or app state) with review_to_front, and see or steer their other Claude Code and Codex sessions when asked. Use when there is something for the user to look at, or when asked what the other sessions are doing.",

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
    // 2026-10-05: when and why first, then what to pass, then what the result means; the mechanics are in the
    // parameters (mcp.ts) and the skill (`REVIEW_TO_FRONT_DESCRIPTION_MAX` says why).
    review_to_front:
      "Publish whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), as you go, not only at the end. It’s one call, it doesn’t interrupt them, and it’s how they follow your work from conch’s Mac app and their phone. Pass a one-line summary of what it is and what to check, and the best single artifact as link (a URL, or a path to a file or folder) with its kind; with nothing to link (an app window, the Simulator), say where to look in the summary. Publishing the same link or key again adds its next version, not a second entry. It opens nothing and doesn’t end your turn: the user’s click on the pill brings it forward. The result says where it landed (surfaces) and any warning or relabel to act on; tell the user from that, not from what you assume.",
    conch_history:
      "Read a page of recorded session history, including coverage and continuation cursors.",
    conch_item:
      "Read the full recorded content of an item in bounded chunks.",
    conch_working_folders:
      "Tell conch the folder(s) this session is actually working in, when they differ from where it started; conch’s file tree, file viewer and sidebar grouping follow them, and your deliverable links may sit under them. Absolute or relative to your cwd; each must exist. Your own session only.",
    conch_on_screen:
      "Read what is on the user’s screen and which session owns it: the surface (a file, page, terminal, simulator, design tool, app or conch’s own window), the session and deliverable it resolved to, a confidence and the reason. It follows the front app as the user moves between apps; without the Accessibility permission it knows the app but not the file or page in it.",
    conch_deliverables:
      "List the deliverables your session holds, newest first: each filing's id, artifact, version, kind, summary, link, when it was filed and looked at, and whether a newer version supersedes it. Your own session only.",
    review_remove:
      "Remove a deliverable you published that is wrong or obsolete: one filing by id, or every version of an artifact. Your own session only. A newer version already supersedes an older one, so remove only what should not be looked at.",
    conch_capture:
      "Capture a web page, or one part of it, as a PNG drawn by conch's Mac app rather than a browser you drive: it loads the page at the viewport size, waits for it to settle (fonts, the images near the part, the layout no longer moving), scrolls the target (a selector or a quote) to the middle and captures it with a margin. Returns the file's path, its size in pixels, the target's box in them, the page's final URL and title, and whether it showed a sign-in screen; with mark, review_to_front marks round the target on the image; with publish, files it as your deliverable in the same call. Pages are drawn with the sign-ins of conch's own review pane, not your browser's, so a page behind a login needs the user to sign in there once. Needs conch's Mac app open; takes up to about 40 seconds.",
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

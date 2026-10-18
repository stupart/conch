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
   *
   * 2026-10-16: the pane beside the conversation is the Workdesk, of typed items (Tyler: "deliverable is a type,
   * borwser is a type"), and agents are told to browse for the user in conch's browser so he can watch, to leave a
   * sign-in to him, and to show an Atlas page that matters with `atlas_show` ("are u showing me the atals pages in
   * conch?"). Said in the same 410-word budget: the detail is the skill's (docs/conch-control-skill.md).
   */
  alwaysOn: `conch shows this session in the user’s Mac app, floating overlay and iPhone. Its Mac app gives you a Workdesk of typed items beside the conversation: deliverables, browser tabs, files, shell, terminal. Show your work there: results with \`review_to_front\`, pages with \`browser_open\`.

Whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), publish it with \`review_to_front\` as you go, not only at the end: a short summary and the best artifact link. Tell the user where it landed from the result’s \`surfaces\`. With no link (an app window, the Simulator), pass its \`kind\` and say where to look. For a written explanation, use scene kind \`conversation\` and keep it in your reply.

A link is an http(s) URL, or an absolute path to a file or a folder (shown as its file tree) under this session’s folders: where it started, where it is now, its git repository, \`conch_working_folders\`, or a temp folder (/tmp, or macOS’s per-user /var/folders/…/T), which conch copies when it files the link, so a cleaned temp folder can’t take it away. Never a hidden file, key or executable.

Browse for the user with conch’s \`browser_*\` tools so they can watch in the Workdesk; other browser tools are fine when they ask or the task needs them. At a sign-in, ask them to sign in in the tab with \`browser_ask\`; never type passwords. \`conch_capture\` shows part of a page. \`open <url>\` lands in the Workdesk; \`CONCH_OPEN_EXTERNAL=1 open <url>\` uses the default browser. Show an Atlas page you read or wrote that matters to the user with \`atlas_show\`.

Publishing makes the result available without interrupting the user: open no apps, move no windows, start no microphone. Publish again whenever it changes in a way worth seeing, not after every edit: the same link or \`key\` files its next version. \`conch_deliverables\` lists yours; \`review_remove\` takes back a wrong one.

Omit \`session\` when publishing; never attribute work to another session. Working outside the folder this session started in? Say so once with \`conch_working_folders\`.

To control sessions, audio or settings when asked, load the \`conch-control\` skill and check IDs with \`conch_sessions\`; respect manual mode and report refusals.

If you can't publish, end your reply with one \`conch:review <summary> | <link>\` line (only the last counts, so link a folder for several things). A refused link is dropped and the summary kept; conch tells the user and you why.`,

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
      "Capture a web page, or one part of it, as a PNG drawn by conch's Mac app rather than a browser you drive: it loads the page at the viewport size, waits for it to settle (fonts, the images near the part, the layout no longer moving), scrolls the target (a selector or a quote) to the middle and captures it with a margin. Returns the file's path, its size in pixels, the target's box in them, the page's final URL and title, and whether it showed a sign-in screen; with mark, review_to_front marks round the target on the image; with publish, files it as your deliverable in the same call. Pages are drawn with the sign-ins of conch's own review pane, not your browser's (the Default profile of conch's browser shares them), so a page behind a login needs the user to sign in there once: open it with browser_open and ask them to. Needs conch's Mac app open; takes up to about 40 seconds.",
    // The Workbench (browser-workbench.ts), 2026-10-11: conch's own browser, as tabs in the Mac app's Workdesk. 2026-10-16: the
    // user opens tabs there too (to sign in), and agents are told to browse in it so he can watch.
    browser_open:
      "Open a page in conch's in-app browser: a live tab in the user's Workdesk in conch's Mac app, where the user can watch and take over by clicking and typing in it. Use it whenever you browse on the user's behalf, so they can see what you do; other browser tools (Claude in Chrome, Playwright, computer use) are for when they ask for them or the task needs them. Tabs are signed in per account profile (profile names one, by name or id; Default shares the sign-ins of conch's review pane), so a page behind the user's login works once they have signed in there. Without tab it opens a new tab; with tab it goes to url in that tab. Returns the tab's id, URL and title, and signedIn: whether that profile is signed in to the site, as conch last read its cookies (false with signedInOn naming the profiles that are; absent when conch can't say). Not signed in: ask the user to sign in in the tab with browser_ask before going on. Needs conch's Mac app open.",
    browser_read:
      "Read a tab of conch's in-app browser (your most recent when tab is omitted): its title and URL, its visible text (trimmed), its links and buttons each with a short ref for browser_click, and its form fields (label, name, type, value; never a password's or a hidden field's value). Refs last until the page changes: read again after it navigates.",
    browser_click:
      "Click in a tab of conch's in-app browser, as the user would: target is a ref from browser_read, a CSS selector, or the visible text of a link or button (a string tries them in that order; {ref}, {selector} or {text} says which). Returns the page's URL and title afterwards. The user sees it happen: conch marks where you clicked.",
    browser_type:
      "Type into a field in a tab of conch's in-app browser: target is a ref from browser_read, a CSS selector or the field's visible label; submit presses Return. The user sees the field fill. Agents don't type passwords: a password field is refused. At a sign-in, ask the user to sign in themselves in the tab, with browser_ask, and wait for their word.",
    browser_screenshot:
      "A PNG of what a tab of conch's in-app browser shows now (your most recent when tab is omitted), written to conch's capture folder. Returns its path and size, which review_to_front can publish. For one part of a page, conch_capture.",
    browser_tabs:
      "List your session's tabs in conch's in-app browser: id, URL, title, profile, signedIn (whether that profile is signed in to the tab's site, as browser_open says), and which is current (the one a command naming no tab runs in). openedBy \"user\" marks a tab the user opened in the Workdesk, often to sign in for you: act in it once they say so. paused marks one they have taken over: your commands there are refused until they hand it back. ask is your last browser_ask there: its reason and state, waiting until the user answers it (done: they pressed Done; signed-in: conch saw the profile sign in).",
    // 2026-10-18, Tyler, after an agent asked him in words to sign in to Mobbin in a tab: "the tab didn't get any sort of
    // emphasis and it was all the way on the left so i missed it". The ask is the tab's own, where he will act on it.
    browser_ask:
      "Ask the user to do something in a tab of conch's in-app browser that only they should do: sign in, pass a captcha, approve a consent screen, pick an account. reason is one short line they read on the tab (\"Sign in to Mobbin\"). conch marks the tab Needs you, brings it to the front of their Workdesk and shows their session as needing them, with Done under the tab's address bar. Then say in a line what you asked and stop: when they press Done, or conch sees the tab's profile sign in to the site you asked on, you get a message saying so (\"Done: Sign in to Mobbin …\"), and browser_tabs shows the ask's state. Your own click, type or open in the tab withdraws it. A new ask in the tab replaces the last.",
    browser_close:
      "Close one of your session's tabs in conch's in-app browser, by id.",
    // 2026-10-16, Tyler: "are u showing me the atals pages in conch? if not please do". Atlas has no web view of a page.
    atlas_show:
      "Show the user an Atlas wiki page in their Workdesk. Atlas has no web view of a page, so pass its Atlas path and the Markdown you read or wrote with your Atlas tools: conch saves it to ~/Documents/conch-notes/atlas/<path> and files it as a markdown deliverable keyed atlas:<path> (the same page again is its next version), with a summary naming the path. Use it whenever an Atlas page you read or changed matters to the user. conch never fetches Atlas itself. The result is review_to_front's, plus where the copy is.",
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

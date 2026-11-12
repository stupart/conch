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
 * - every MCP tool description (`buildMcpTools` in mcp.ts), the moved ones' too (`movedToolDescription`)
 * - the MCP server's `instructions` (`initialize` in mcp.ts), which Claude Code carries always-on
 * - `conch agent help`, its list and each command's own (`renderAgentHelp`, `renderAgentCommandHelp`)
 *
 * 2026-11-11, Tyler: "I would also like to add a cli cause I think it might be better to put all our stuff in for agents
 * to use without killing context and then the mcp can be more minimal?" Every session carried 28 tool schemas (33.6 KB
 * of `tools/list`) whether it used them or not, and most never did: in 30 days of calls, 7 tools had none and 6 had
 * under 5. So conch's tools are a CLI, `conch agent …` (`AGENT_COMMANDS`), whose help an agent reads when it needs it;
 * the MCP keeps `review_to_front`, which every session is told to call as it goes and which takes nested input (a
 * scene in 45% of 778 calls), and `conch_run`, the same CLI for a shell that can't reach conch (agent-cli.ts says when).
 *
 * A leaf module: the help session imports it, and must stay a leaf.
 */

/** A `conch agent speak` is a confirmation, not a narration; longer is refused, never cut. */
export const MAX_SPEAK_CHARS = 600;

/** A `conch agent notify` body: a line or two on a lock screen. notice-wire.ts `NOTICE_BODY_MAX` is this. */
export const NOTICE_BODY_MAX_CHARS = 280;

/**
 * The longest the server's `instructions` may be. Claude Code cuts them at 2048 characters
 * (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`, 2.1.280) and adds "… [truncated]"; well under that,
 * so every line of it arrives, and short enough to sit in every session's context for nothing.
 * 2026-10-19: 500 became 1,200 for the ToolSearch line (`serverInstructions` says why).
 */
export const SERVER_INSTRUCTIONS_MAX = 1_200;

/** The cut Claude Code makes to a server's instructions (2.1.280); `SERVER_INSTRUCTIONS_MAX` stays well under it. */
export const CLAUDE_CODE_INSTRUCTIONS_CUT = 2_048;

/**
 * Why Claude Code sessions are told to publish from the shell. 2026-10-18 review: no Claude Code agent loaded conch_capture
 * or browser_* through ToolSearch, and they wrote 686 Playwright screenshot scripts instead, so the instructions gave a
 * one-line `select:` preload. 2026-11-11: the page tools became `conch agent` commands, and only review_to_front was left
 * to preload; but of 268 conch schemas ToolSearch loaded in 7 days, 138 were loads again after a compaction had unloaded
 * them, and only 4 a second load with none between, so "load it once" can't hold. `conch agent publish` is the same
 * handler with nothing to load, so the instructions name it instead of a ToolSearch line (`serverInstructions`).
 */
export const PUBLISH_FROM_SHELL = "conch agent publish \"<summary>\" <link>";

/**
 * The longest `review_to_front`'s own description may be. 2026-10-05: Tyler asked whether anything in the MCP made
 * agents less likely to show what they do in conch. It had: the description grew from 403 characters (v0.3.0) to
 * 2,036, just under Claude Code's 2048 cut, and read as a list of mechanics and obligations (copies, verdicts,
 * surfaces states, login walls, approval rules) with when to publish buried in it, so publishing looked like a heavy,
 * careful act rather than a habit. The description says when and why to publish, what to pass and what the result
 * means, in a few lines; the mechanics live in the parameters' own descriptions and the conch-control skill.
 */
export const REVIEW_TO_FRONT_DESCRIPTION_MAX = 1000;

/** The longest `conch agent help` may be: what an agent pays, once, to learn every command. */
export const AGENT_HELP_MAX = 3_200;

/** One `conch agent` command, as agents are told it. Its arguments are parsed by agent-commands.ts. */
export interface AgentCommandText {
  /** The words after `conch agent`. */
  name: string;
  /** The handler it runs in mcp.ts: an MCP tool's (listed, or moved here from the MCP), or a CLI-only command's. */
  tool: string;
  /** Its synopsis, after `conch agent`. */
  usage: string;
  /** One line, for the list. */
  summary: string;
  /** What `conch agent help <name>` says beyond the usage: when to use it, what it answers. */
  help: string;
  /** Its heading in the list. */
  group: string;
}

/**
 * Every `conch agent` command, in the order `conch agent help` lists them. The help is what the MCP tool descriptions
 * said, in the CLI's words; the long form is the conch-control skill. A test holds agent-commands.ts's parsers to these:
 * a command each, and every `--flag` a usage names.
 */
export const AGENT_COMMANDS: readonly AgentCommandText[] = [
  {
    name: "publish",
    tool: "review_to_front",
    group: "Show your work",
    usage: "publish <summary> [link] [--kind K] [--key K] [--focus PATH]... [--scene auto|link|conversation|terminal] [--inspect LINE] [--marks JSON] [--approve LABEL]",
    summary: "file a deliverable for the user (the review_to_front tool, from a shell)",
    // 2026-11-11: what review_to_front's parameters used to say, here, where an agent reads it when it needs it; the
    // schema has a line each (mcp.ts says why).
    help: [
      "The review_to_front tool, from your shell, with nothing to load. Publish whenever there is something the user would look at, as you go: it opens nothing and doesn't end your turn.",
      "summary: one line, at most 200 characters, what it is and what to check; longer is cut, and the answer's summaryTruncated says so. The detail belongs in your reply.",
      "link: an http(s) URL, or a path (relative to your shell's folder) to a file or folder under this session's folders (where it started, where it is now, its git repository, `conch agent folders`) or a temp folder (/tmp, /var/folders/…/T); never a hidden file, key or executable. A file or folder in a temp folder is filed as conch's own copy, so cleaning the temp folder can't take it away: the answer's link is the copy (notCopied says why not, over 64 MB or 500 files). A folder shows as its file tree: --focus names a path in it to point at (repeat it, up to 12).",
      "--kind: page (a local html file), url (a live page or dev server), folder (a directory shown as its file tree), image, video, audio, pdf, markdown, text, app (a Mac app window), simulator (the iOS Simulator or a device build), terminal, design (Figma and the like), document (Keynote, Word, Pages and the like) or other; read off the link when omitted. app, simulator, terminal, design and other may go without a link: the summary then says where to look.",
      "--key names the artifact, so publishing it again is its next version; the link when omitted (a file's real path, a URL without its fragment), else the summary. Use it when the link changes between versions.",
      "--scene is what the pill click brings forward: auto (the link, else conch's window, else your terminal), link, conversation (conch's window on your session: for a written explanation, kept whole in your reply) or terminal. --inspect is one line on what to check.",
      "--marks draws ink over what you published, where conch shows it: its own panel or side panel, or the user's canvas, never over a browser or another app, so a result with marks opens in conch's panel. As JSON: [{\"id\":\"cta\",\"kind\":\"box\",\"frame\":{\"selector\":\".hero .cta\"},\"label\":\"Moved up\"}]. kind is arrow, box, ellipse, highlight, text (needs a label), pin or stroke; frame is exactly one of selector or quote (in the page you link, which conch finds itself: no numbers), image (an absolute path) or canvas (its id). On an image or a canvas: rect [x, y, w, h] for box, ellipse and highlight, at [x, y] for pin and text (and to, for an arrow's head), 2-64 pts for stroke, as fractions 0-1 from the top left, or pixels with \"units\":\"px\" (and \"size\":[w, h] of the picture you measured on). No colour: conch draws them in your colour. Up to 12, 4096 bytes in all; the skill has more.",
      "--approve LABEL asks for the user's yes, only when you are waiting on it to proceed, never by default: they get Approve, and about 10 s after they press it you get \"Approved: LABEL.\" (\"\" for no label).",
      "The answer: outcome filed (accepted and unconfirmed from an older conch), the artifact and version it is, and surfaces, where the user can see it (mac showing, running or not-running; phone connected, paired-not-connected, unpaired or off; audio mac, phone, other-mac or manual): tell the user from that. It repeats nothing you passed: a link only when conch filed another (a copy, or an absolute path), a kind only when it read one off the link. For a live page conch looks for a login wall: warning says what to do about a sign-in page, with access (what the Mac, with its review pane's sign-ins, and a device without them were shown) and snapshot (the Mac's picture, which the phone shows first). relabel suggests a new label for your session. deliverables lists each filing's id.",
    ].join("\n\n"),
  },
  {
    name: "capture",
    tool: "conch_capture",
    group: "Show your work",
    usage: "capture <url> [--selector CSS | --quote TEXT] [--size WxH] [--full] [--mark KIND] [--mark-label TEXT] [--publish SUMMARY] [--key K]",
    summary: "a PNG of a web page, or one part of it, drawn by conch's Mac app",
    help: "Use it rather than writing a Playwright screenshot script. conch loads the page at the size (1440x900 unless --size; a phone is 390x844), waits for it to settle, scrolls the part (--selector or --quote, the words as they appear) to the middle and captures it with a margin; --full draws the whole page. The url is an http(s) URL or a local .html file under this session's folders or /tmp. The answer: the file's path (read it to see it), its size, the part's box, the page's final URL and title, and loginWall when it showed a sign-in screen. --mark (box, highlight, ellipse, arrow, pin or text, which needs --mark-label) marks the part; --publish files the capture as your deliverable in the same step. Pages are drawn with the sign-ins of conch's review pane, not your browser's: a page behind a login needs the user to sign in there once (browser open, then browser ask). Needs conch's Mac app open; takes up to about 40 seconds.",
  },
  {
    name: "deliverables",
    tool: "conch_deliverables",
    group: "Show your work",
    usage: "deliverables",
    summary: "what your session holds, newest first",
    help: "Each filing's id, artifact, version, kind, summary, link, when it was filed and looked at, and whether a newer version supersedes it. Your own session only.",
  },
  {
    name: "unpublish",
    tool: "review_remove",
    group: "Show your work",
    usage: "unpublish <id> | unpublish --artifact ARTIFACT",
    summary: "take back a deliverable that is wrong (one filing, or every version)",
    help: "One filing by its id, or every version of an artifact with --artifact. Your own session only. A newer version already supersedes an older one, so remove only what should not be looked at.",
  },
  {
    name: "folders",
    tool: "conch_working_folders",
    group: "Show your work",
    usage: "folders <dir>...",
    summary: "tell conch the folders you actually work in",
    help: "When they differ from where this session started: conch's file tree, file viewer and sidebar grouping follow them, and your deliverable links may sit under them. Relative to your shell's folder; each must exist; the first is where the file tree opens. Once is enough, again only if you move. Your own session only.",
  },
  // 2026-10-16, Tyler: "are u showing me the atals pages in conch? if not please do". Atlas has no web view of a page.
  // 2026-11-11: the Markdown comes from a file, not the call: a page is no longer pasted into the agent's context twice.
  {
    name: "atlas",
    tool: "atlas_show",
    group: "Show your work",
    usage: "atlas <path> --file MARKDOWN [--summary LINE]",
    summary: "show the user an Atlas wiki page you read or wrote",
    help: "Atlas has no web view of a page, so pass its Atlas path (projects/conch/plan.md) and a file holding the Markdown you read or wrote with your Atlas tools (--file - reads it from stdin). conch saves it to ~/Documents/conch-notes/atlas/<path> and files it as a markdown deliverable keyed atlas:<path>, so the same page again is its next version. conch never fetches Atlas itself. The answer is publish's, plus where the copy is.",
  },
  // The Workbench (browser-workbench.ts), 2026-10-11: conch's own browser, as tabs in the Mac app's Workdesk. 2026-10-16: the
  // user opens tabs there too (to sign in), and agents are told to browse in it so he can watch.
  {
    name: "browser open",
    tool: "browser_open",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser open <url> [--profile P] [--tab T]",
    summary: "a live tab in the user's Workdesk",
    help: "Use conch's browser whenever you browse on the user's behalf, so they can see what you do and take over; other browser tools (Claude in Chrome, Playwright, computer use) are for when they ask for them or the task needs them. Tabs are signed in per account profile (--profile, by name or id; Default shares conch's review pane's sign-ins). Without --tab it opens a new tab; with it, goes to url in that tab. The answer: the tab's id, URL and title, and signedIn, whether that profile is signed in to the site (false with signedInOn naming the profiles that are). Not signed in: ask the user with browser ask before going on. Needs conch's Mac app open.",
  },
  {
    name: "browser read",
    tool: "browser_read",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser read [--tab T] [--page N | --find WORDS | --section HEADING] [--selector CSS] [--full]",
    summary: "a page of a tab's words, and its links, buttons and fields with refs",
    // 2026-11-11: one page of the words by default (browser-read.ts says why), and the ways to the rest.
    help: "Your most recent tab when --tab is omitted. It shows the page's title and URL, one page of its words (about 2,000 characters), the page's sections, and the links, buttons and fields in those words, a same-site link by its path; its last line, more:, says what else there is. --page N shows the next pages; --find WORDS only the lines, links, buttons and fields that say them (any case); --section HEADING the words under that heading; --selector CSS reads only that part of the page; --full the whole read, every word, link, button and field. Links and buttons each come with a short ref (e12) for browser click, fields with their label, name, type and value (never a password's or a hidden field's value). Refs are the same in every view of a page and last until it changes: read again after it navigates.",
  },
  {
    name: "browser click",
    tool: "browser_click",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser click <target> [--tab T] | browser click (--ref R | --selector CSS | --text WORDS) [--tab T]",
    summary: "click a ref, a CSS selector or a link's or button's words",
    help: "A bare target is tried as a ref from browser read, then a CSS selector, then visible text; --ref, --selector or --text says which. The answer is the page's URL and title afterwards. The user sees it happen: conch marks where you clicked. \"nothing you can click says …\" means read the page again: its words or refs have changed.",
  },
  {
    name: "browser type",
    tool: "browser_type",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser type <target> <text> [--submit] [--tab T] | browser type (--ref R | --selector CSS | --label LABEL) <text> [--submit]",
    summary: "type into a field (it replaces what the field holds)",
    help: "The target is a ref from browser read, a CSS selector or the field's visible label (--ref, --selector or --label says which); --submit presses Return. The user sees the field fill. Agents don't type passwords: a password field is refused. At a sign-in, ask the user to sign in themselves with browser ask, and wait for their word.",
  },
  {
    name: "browser screenshot",
    tool: "browser_screenshot",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser screenshot [--tab T]",
    summary: "a PNG of what a tab shows now",
    help: "Written to conch's capture folder; the answer is its path and size, which publish can file. For one part of a page, capture.",
  },
  {
    name: "browser tabs",
    tool: "browser_tabs",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser tabs",
    summary: "your session's tabs, and which is current",
    help: "Each tab's id, URL, title, profile, signedIn, and which is current (the one a command naming no tab runs in). openedBy user marks a tab the user opened in the Workdesk, often to sign in for you: act in it once they say so. paused marks one they have taken over: your commands there are refused until they hand it back. ask is your last browser ask there and its state.",
  },
  // 2026-10-18, Tyler, after an agent asked him in words to sign in to Mobbin in a tab: "the tab didn't get any sort of
  // emphasis and it was all the way on the left so i missed it". The ask is the tab's own, where he will act on it.
  {
    name: "browser ask",
    tool: "browser_ask",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser ask <reason> [--tab T]",
    summary: "ask the user to sign in (or pass a captcha, approve a consent) in a tab",
    help: "The reason is one short line they read on the tab (\"Sign in to Mobbin\"). conch marks the tab Needs you, brings it forward in their Workdesk and shows the session as needing them, with Done under the address bar. Say in a line what you asked and stop: when they press Done, or conch sees the profile sign in, you get a message saying so. Your own click, type or open in the tab withdraws it.",
  },
  {
    name: "browser close",
    tool: "browser_close",
    group: "Browse for the user, in conch's browser, where they can watch",
    usage: "browser close <tab>",
    summary: "close one of your tabs",
    help: "By its id, from browser tabs. A session may keep only a few tabs open: close the ones you are done with.",
  },
  // 2026-10-18 review: the tool returned the whole published state, 272K-455K characters, too large for every Claude Code
  // call; the compact list is one line a session here.
  {
    name: "sessions",
    tool: "conch_sessions",
    group: "Sessions",
    usage: "sessions [query] [--detail]",
    summary: "the live sessions, one line each, and which one you are",
    help: "Each session's id, status (working, waiting, needs), label, backend, folder, account and last activity; you marks yours, and toolsStale one whose conch tools are out of date. The query narrows it (an id, its first 4+ characters, or part of a label); --detail gives that one session's full row. The first line says whether conch verified which session you are. Also lists conch's Claude sign-ins, for start --sign-in. Not conversation history: tail reads a session's latest reply.",
  },
  // 2026-10-18 review: one Codex thread polled it 33 times to wait on a session, and 18 replies were "". 2026-11-11: 13
  // calls named a session that matched none (failure ticket #17); the refusal now lists the live ones.
  {
    name: "tail",
    tool: "conch_transcript_tail",
    group: "Sessions",
    usage: "tail <session> [--wait SECONDS] [--since CURSOR] [--sentences N]",
    summary: "the last sentences of a session's latest reply, with its status and a cursor",
    help: "To wait for a session, pass the cursor back with --since and --wait (at most 30 seconds): it returns as soon as there is new text, or says there is none, rather than you polling. When its status is waiting, its text is the answer; needs means it is asking the user something. Not full history (history), and not proof its tools succeeded.",
  },
  {
    name: "history",
    tool: "conch_history",
    group: "Sessions",
    usage: "history <session> [--branch ID] [--before CURSOR] [--limit N]",
    summary: "a page of a session's recorded history",
    help: "The session is a recorded session id or an exact live id (self is your own, verified); labels are not ids. Pass previousCursor back as --before for the page before. Coverage says what the records hold.",
  },
  {
    name: "item",
    tool: "conch_item",
    group: "Sessions",
    usage: "item <session> <item> [--cursor CURSOR]",
    summary: "one recorded item in full, in bounded chunks",
    help: "The item id comes from history; pass nextBodyCursor back as --cursor for the next chunk.",
  },
  // 2026-11-10, Tyler, on choosing which account a session runs on: "one session [uses] another account to create a
  // fable agent using conch for me since [this one is] out of credits". One start, then one wait for the answer.
  {
    name: "start",
    tool: "conch_start",
    group: "Sessions",
    usage: "start [--backend claude|codex] [--folder DIR] [--sign-in ACCOUNT] [--model M] [--effort E] [--prompt TEXT] [--host terminal|background] [--label L]",
    summary: "start a new session through conch, on a chosen Claude account",
    help: "At the user's request. In your shell's folder unless --folder names another; in a Terminal window, or conch's background host. --sign-in is one of conch's Claude sign-ins by label or id (sessions lists them); left out, Default's own rotating login. --prompt is its first message (one line, at most 2,000 characters), which it starts on at once. The answer waits until conch sees it running (its id and label), or says what stopped it: say it started only from that. To bring back its answer, tail it with --wait. Use this rather than `conch start`, which can't tell you either.",
  },
  // 2026-10-18 review: an agent asked to fork ran `conch start --resume … --fork-session`, which started Claude Code under
  // the wrong account; conch said "opened", the fork had died at once, and the agent told Tyler it was open.
  {
    name: "fork",
    tool: "conch_fork",
    group: "Sessions",
    usage: "fork [session] [--label L]",
    summary: "the same conversation again as a new session beside it",
    help: "At the user's request: same account, folder and flags, holding its deliverables, as the Fork in conch's Mac app. Your own session unless one is named. The answer waits until conch sees the fork running (its id and label), or gives the error that stopped it: say a fork is open only when it says so. Use it rather than `conch start --resume`.",
  },
  {
    name: "rename",
    tool: "conch_rename",
    group: "Sessions",
    usage: "rename <session> <label>",
    summary: "save the display label the user asked for",
    help: "Prefer the session's id; a name that fits several sessions is refused with the candidates.",
  },
  // 2026-11-10, Tyler: "we should also add a way for me to let sessions send me messages on my phone via conch that
  // ping and show notification". When to use it comes first: a ping is for what he asked to hear, never chatter.
  {
    name: "notify",
    tool: "conch_notify",
    group: "The user's phone, voice and settings",
    usage: "notify <body> [--title T] [--session S] [--link URL]",
    summary: "ping the user's iPhone and Mac, only when they asked to be told",
    help: `A notification with sound on their iPhone (even with conch closed there) and on the Mac; a tap opens your session (or --session's). Only when they asked to be told ("ping me when the deploy is done"), or when you are blocked on them and they asked to be pinged for that. Never for progress, never to repeat a reply conch already reads aloud. The body is one or two sentences, at most ${NOTICE_BODY_MAX_CHARS} characters; the title defaults to your session's name; --link (http(s)) rides along. A few per session per hour, and the same words aren't sent twice. The answer says where it went and why not elsewhere: tell the user that.`,
  },
  {
    name: "speak",
    tool: "conch_speak",
    group: "The user's phone, voice and settings",
    usage: "speak <text> [--voice V]",
    summary: `say a short confirmation aloud (at most ${MAX_SPEAK_CHARS} characters)`,
    help: "At the user's request: confirm an action, or read a short answer they asked for. Respect manual mode (it is held then, and the answer says so); do not repeat your reply or narrate progress.",
  },
  {
    name: "wake",
    tool: "conch_wake",
    group: "The user's phone, voice and settings",
    usage: "wake [session]",
    summary: "open the microphone at a session, at the user's request",
    help: "Your own session when none is named (it must be verified). Audio only: it opens no workspace. The answer's audio line says where it went (this Mac, the phone when it holds the audio, or refused because another Mac has it): tell the user.",
  },
  {
    name: "recite",
    tool: "conch_recite",
    group: "The user's phone, voice and settings",
    usage: "recite [session]",
    summary: "read a session's latest reply aloud, at the user's request",
    help: "Your own session when none is named (it must be verified). Audio only: it opens no workspace. The answer's audio line says where it went.",
  },
  {
    name: "mode",
    tool: "conch_mode",
    group: "The user's phone, voice and settings",
    usage: "mode pause|resume [--session S | --all]",
    summary: "manual (pause) or automatic (resume) speech and listening",
    help: "Your own session unless --session names another; --all switches every session, only when the user asked for exactly that. A resume is refused while the user put conch in manual themselves.",
  },
  {
    name: "on-screen",
    tool: "conch_on_screen",
    group: "The user's phone, voice and settings",
    usage: "on-screen",
    summary: "what is on the user's screen and which session owns it",
    help: "The surface (a file, page, terminal, simulator, design tool, app or conch's own window), the session and deliverable it resolved to, a confidence and the reason. Without the Accessibility permission it knows the app but not the file or page in it.",
  },
  {
    name: "config",
    tool: "conch_config",
    group: "The user's phone, voice and settings",
    usage: "config [key [value]] [--unset]",
    summary: "read settings, or change a voice or timing setting the user asked for",
    help: "With no key, every setting; with a key, that one. Only end-silence, voice-speed, haiku-timeout, read-full, announce-summary and whisper-idle-unload can be set or unset by an agent; any other key is refused with the `conch set` command the user can run. Changes reach the running daemon.",
  },
  // 2026-11-11, Tyler: "Also tool for them to submit bugs if possible." A ticket in conch's own failure loop
  // (bug-report.ts), never a public issue: the repository is public, and a ticket holds the user's sessions and words.
  {
    name: "bug",
    tool: "conch_bug",
    group: "conch itself",
    usage: "bug <title> --happened TEXT --expected TEXT [--area WORD] [--evidence PATH-OR-LINE]...",
    summary: "file a bug about conch, privately, as a failure ticket",
    help: "When conch itself got something wrong that its own records can't show (a pill that never lit, a tab that opened in the wrong session, a wrong answer from a command). The title is one line; --happened and --expected say what you saw and what you expected; --evidence (repeat it) is a file path or a line of output, kept as written (a file is not copied). It becomes a ticket in Settings › Failures on this Mac, never anything public: conch's repository is public, and a ticket holds session names and the user's words. The same bug again counts on its ticket. The answer gives the ticket's number: tell the user it. A few per session per hour.",
  },
  // 2026-11-11: every refusal of an unverified caller raised the question this answers.
  {
    name: "whoami",
    tool: "conch_whoami",
    group: "conch itself",
    usage: "whoami",
    summary: "which session conch says this shell is, and how it knows",
    help: "Commands that act on your own session (publish, folders, browser, deliverables) need conch to verify it. From a shell, conch walks up from the command's own process to the session that started it; a Codex app-server thread is named by CODEX_THREAD_ID. When it can't, this says why, and those commands are refused rather than acting for any session.",
  },
];

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
   *
   * 2026-11-11: everything but publishing is `conch agent …` in the shell, and `conch bug` files what conch got wrong.
   * Codex carries this in every session (AGENTS.md), so the link's rules are said in fewer words: the same folders.
   */
  alwaysOn: `conch shows this session in the user’s Mac app, floating overlay and iPhone. Its Mac app gives you a Workdesk of typed items beside the conversation: deliverables, browser tabs, files, shell, terminal. Show your work there: results with \`review_to_front\`, pages with \`conch agent browser open\`.

Whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), publish it with \`review_to_front\` as you go, not only at the end: a short summary and the best artifact link. Tell the user where it landed from the result’s \`surfaces\`. With no link (an app window, the Simulator), pass its \`kind\` and say where to look. For a written explanation, use scene kind \`conversation\` and keep it in your reply.

A link is an http(s) URL, or a path to a file or a folder (shown as its file tree) under this session’s folders (where it started or is now, its git repository, \`conch agent folders\`) or a temp folder (/tmp, /var/folders/…/T), which conch copies so cleaning it can’t take it away. Never a hidden file, key or executable.

Everything else is a command in your shell: \`conch agent help\` lists them; if your shell can’t reach conch (a sandbox), the \`conch_run\` tool runs the same words. Browse for the user with \`conch agent browser …\` so they can watch in the Workdesk; other browser tools are fine when they ask or the task needs them. At a sign-in, ask them to sign in in the tab with \`conch agent browser ask\`; never type passwords. \`conch agent capture <url>\` shows part of a page. \`open <url>\` lands in the Workdesk; \`CONCH_OPEN_EXTERNAL=1 open <url>\` uses the default browser. Show an Atlas page that matters to the user with \`conch agent atlas\`.

Publishing makes the result available without interrupting the user: open no apps, move no windows, start no microphone. Publish again whenever it changes in a way worth seeing, not after every edit: the same link or \`key\` files its next version. \`conch agent deliverables\` lists yours; \`conch agent unpublish\` takes back a wrong one.

Omit \`session\` when publishing; never attribute work to another session. Working outside the folder this session started in? Say so once with \`conch agent folders <dir>\`.

To control sessions, audio or settings when asked, load the \`conch-control\` skill and check IDs with \`conch agent sessions\`; respect manual mode and report refusals. When conch itself gets something wrong, \`conch bug\` files a private ticket for the user.

If you can't publish, end your reply with one \`conch:review <summary> | <link>\` line (only the last counts, so link a folder for several things). A refused link is dropped and the summary kept; conch tells the user and you why.`,

  /**
   * What the MCP server says in its `initialize` reply (`instructions`), which Claude Code puts in
   * every session that loads the plugin, where the skill is only a name until it is loaded and
   * AGENTS.md reaches Codex alone. A Claude Code session used to learn conch was watching only if
   * it went looking. Short on purpose: Claude Code cuts server instructions past 2048 characters,
   * and this is a pointer, the skill is the manual (`SERVER_INSTRUCTIONS_MAX`). 2026-10-05: it says to publish as you
   * go, not only at the end, as the always-on text and `review_to_front` now do. 2026-11-11: the rest is the CLI, and
   * publishing is too, where the tool is deferred (`PUBLISH_FROM_SHELL` says why), in fewer words than the ToolSearch line.
   */
  serverInstructions:
    "This session is watched by conch: the user follows it from conch’s Mac app and their iPhone, often away from the desk. Whenever there is something to look at (a page, image, file, folder, build or app state), as you go and not only at the end, publish it with review_to_front instead of only mentioning a path, then tell them where it landed from the result’s surfaces. A file in /tmp or macOS’s /var/folders/…/T is copied into conch."
    + ` In your shell that is \`${PUBLISH_FROM_SHELL}\`, with nothing to load: use it rather than a ToolSearch for the tool.`
    + " Everything else conch does is a command in your shell: `conch agent help` lists them. For a picture of a page or one part of it, use `conch agent capture <url>` rather than writing a Playwright screenshot script; to click through a page and check it, `conch agent browser`. To fork a session, `conch agent fork`. When conch itself gets something wrong, `conch bug`. Details: the conch-control skill (conch:conch-control).",

  /** The skill's frontmatter description, which Claude Code carries always-on. */
  skillDescription:
    "Publish what the user should look at (a page, image, file, folder, build or app state) with review_to_front, and see or steer their other Claude Code and Codex sessions with `conch agent` when asked. Use when there is something for the user to look at, or when asked about the other sessions.",

  /** What a session with no conch tools should conclude, and not do. */
  missingTools:
    "If you have no `review_to_front` tool, the conch plugin is not loaded in this session; if `conch agent help` isn't found either, conch isn't installed. Say so, and check whether the plugin is installed and enabled (`claude plugin list`) before suggesting anything; do not reinstall or restart on your own. When it is missing, `conch install-plugin` is the person's to run.",

  /** The tools a session's `tools/list` holds (mcp.ts `MCP_LISTED_TOOLS`). Everything else is `AGENT_COMMANDS`. */
  tools: {
    // 2026-10-05: when and why first, then what to pass, then what the result means; the mechanics are in the
    // parameters (mcp.ts) and the skill (`REVIEW_TO_FRONT_DESCRIPTION_MAX` says why).
    review_to_front:
      "Publish whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), as you go, not only at the end. It’s one call, it doesn’t interrupt them or end your turn, and it’s how they follow your work from conch’s Mac app and phone. Pass a one-line summary and the best single artifact as link (none for an app window or the Simulator: say where to look). Publishing the same link or key again adds its next version. More: `conch agent help publish`. The result says where it landed (surfaces) and any warning or relabel to act on; tell the user from that, not from what you assume.",
    // 2026-11-11: the CLI, through this server, for a shell that can't reach conch's socket (Codex's sandbox) or can't
    // show which session it is (an older Codex app-server thread). Not the way in: the shell is. Kept to two lines.
    conch_run:
      "Run one conch agent command here, exactly as `conch agent <command>` runs in your shell (`conch agent help` lists them), for when your shell can't reach conch (a sandbox refuses its socket) or can't show which session you are. Paths are relative to where this session started.",
  },
};

export type AgentInstructions = typeof AGENT_INSTRUCTIONS;

/** The command a tool moved to, by the tool's name; undefined for one that didn't. */
export function commandForTool(tool: string, commands: readonly AgentCommandText[] = AGENT_COMMANDS): AgentCommandText | undefined {
  return commands.find((command) => command.tool === tool);
}

/**
 * What a moved tool says in the list of a session that still has it (mcp.ts lists them to a session started before the
 * move, so a task under way isn't left calling a tool that went): where it went, and that it still works here.
 */
export function movedToolDescription(tool: string, commands: readonly AgentCommandText[] = AGENT_COMMANDS): string {
  const command = commandForTool(tool, commands);
  if (!command) throw new Error(`${tool} moved to no conch agent command`);
  return `Moved to conch's CLI: \`conch agent ${command.usage}\` in your shell (\`conch agent help ${command.name}\`). Still answered here, as before, because this session started before the move; a restart leaves only the CLI.`;
}

/** `conch agent help`: every command on one screen, by group. */
export function renderAgentHelp(commands: readonly AgentCommandText[] = AGENT_COMMANDS): string {
  const lines = [
    "conch agent <command> [--json]: conch's tools for agents, from your shell. Text by default, --json for JSON; `conch agent help <command>` (or <command> --help) says more.",
    "conch knows which session you are from the shell's process tree (whoami says how); a command on your own session is refused when it can't tell.",
  ];
  let group = "";
  for (const command of commands) {
    if (command.group !== group) {
      group = command.group;
      lines.push("", `${group}:`);
    }
    lines.push(`  ${command.name.padEnd(18)} ${command.summary}`);
  }
  lines.push("", "Publishing as you go is also the review_to_front MCP tool; conch_run runs any of these where the shell can't reach conch.");
  return lines.join("\n");
}

/** `conch agent help <command>`: its usage, then what to know. */
export function renderAgentCommandHelp(command: AgentCommandText): string {
  return [`usage: conch agent ${command.usage}`, "", command.help, "", "--json prints the answer as JSON."].join("\n");
}

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
export function renderHelpConchSection(text: AgentInstructions = AGENT_INSTRUCTIONS, commands: readonly AgentCommandText[] = AGENT_COMMANDS): string {
  const tools = Object.entries(text.tools).map(([name, description]) => `- \`${name}\`: ${description}`);
  const cli = commands.map((command) => `- \`conch agent ${command.name}\`: ${command.summary}.`);
  return [
    "## What you can do from here",
    "",
    "Your conch tools are a CLI, `conch agent …` (`conch agent help` lists it), and two MCP tools from the plugin. Load the `conch-control` skill for how to use them.",
    "",
    ...tools,
    "",
    ...cli,
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

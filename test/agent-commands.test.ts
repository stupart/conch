import { describe, expect, test } from "bun:test";
import {
  AGENT_COMMAND_PARSERS,
  AgentUsageError,
  cliWording,
  parseAgentCommand,
  renderAgentAnswer,
  renderLines,
  splitCommandLine,
  usageErrorText,
} from "../src/agent-commands.ts";
import { AGENT_COMMANDS, AGENT_HELP_MAX, AGENT_INSTRUCTIONS, commandForTool, renderAgentHelp } from "../src/agent-instructions.ts";
import { AGENT_ONLY_HANDLERS, MCP_MOVED_TOOL_NAMES, MCP_TOOLS } from "../src/mcp.ts";

/**
 * `conch agent`'s words (agent-commands.ts). 2026-11-11, Tyler: "I would also like to add a cli cause I think it might be
 * better to put all our stuff in for agents to use without killing context and then the mcp can be more minimal?"
 * Each command reads its words into the arguments of the MCP tool it replaced, says what was wrong when it can't, and
 * prints the answer short.
 */

const run = (argv: string[], cwd = "/work/site") => {
  const parsed = parseAgentCommand(argv, { cwd, readFile: (path) => `# read ${path}`, readStdin: () => "# from stdin" });
  if (parsed.kind !== "run") throw new Error(`expected a command, got help: ${parsed.text.slice(0, 80)}`);
  return parsed;
};

const refused = (argv: string[]): AgentUsageError => {
  try {
    parseAgentCommand(argv, { cwd: "/work/site" });
  } catch (error) {
    if (error instanceof AgentUsageError) return error;
    throw error;
  }
  throw new Error(`expected ${argv.join(" ")} to be refused`);
};

describe("the commands are the contract's", () => {
  test("every command has a parser, every parser a command, and each runs a handler conch has", () => {
    expect(Object.keys(AGENT_COMMAND_PARSERS).sort()).toEqual(AGENT_COMMANDS.map((command) => command.name).sort());
    const handlers = new Set<string>([...MCP_TOOLS.map((tool) => tool.name), ...AGENT_ONLY_HANDLERS]);
    for (const command of AGENT_COMMANDS) expect(handlers.has(command.tool)).toBe(true);
    expect(new Set(AGENT_COMMANDS.map((command) => command.name)).size).toBe(AGENT_COMMANDS.length);
  });

  test("a usage names exactly the flags its command takes", () => {
    for (const command of AGENT_COMMANDS) {
      const named = new Set([...command.usage.matchAll(/--([a-z][a-z-]*)/g)].map((match) => match[1]!));
      expect([...named].sort()).toEqual(Object.keys(AGENT_COMMAND_PARSERS[command.name]!.flags).sort());
    }
  });

  test("every tool that left the MCP is a command, and the MCP lists only publishing and conch_run", () => {
    expect(Object.keys(AGENT_INSTRUCTIONS.tools)).toEqual(["review_to_front", "conch_run"]);
    expect(MCP_MOVED_TOOL_NAMES.length).toBe(MCP_TOOLS.length - 2);
    for (const tool of MCP_MOVED_TOOL_NAMES) expect(commandForTool(tool)?.tool).toBe(tool);
    // Publishing is both: the tool every session calls, and a command for a shell.
    expect(commandForTool("review_to_front")?.name).toBe("publish");
  });

  test("conch agent help is every command on one screen, under its budget", () => {
    const help = renderAgentHelp();
    expect(help.length).toBeLessThanOrEqual(AGENT_HELP_MAX);
    for (const command of AGENT_COMMANDS) expect(help).toContain(`  ${command.name}`);
    expect(help).toContain("--json");
    expect(help).toContain("whoami");
    expect(parseAgentCommand([])).toEqual({ kind: "help", text: help });
    expect(parseAgentCommand(["help", "browser", "click"])).toMatchObject({ kind: "help", text: expect.stringContaining("usage: conch agent browser click") });
    expect(parseAgentCommand(["capture", "--help"])).toMatchObject({ kind: "help", text: expect.stringContaining("Playwright") });
  });
});

describe("words to arguments", () => {
  test("publish: a summary and a link, made absolute against the shell's folder, and the scene from its flags", () => {
    expect(run(["publish", "The pricing page", "dist/pricing.html"])).toMatchObject({
      tool: "review_to_front",
      args: { summary: "The pricing page", link: "/work/site/dist/pricing.html" },
      json: false,
    });
    expect(run(["publish", "Live", "http://localhost:3000/pricing", "--kind", "url"]).args).toEqual({ summary: "Live", link: "http://localhost:3000/pricing", kind: "url" });
    const full = run(["publish", "Module layout", "src", "--focus", "src/a.ts", "--focus=test/", "--scene", "link", "--inspect", "Check the split", "--marks", '[{"id":"a","kind":"box","frame":{"selector":".a"}}]', "--approve", "Open the PR", "--key", "layout", "--json"]);
    expect(full.args).toEqual({
      summary: "Module layout",
      link: "/work/site/src",
      key: "layout",
      focus: ["src/a.ts", "test/"],
      scene: { v: 1, target: { kind: "link" }, inspect: "Check the split", marks: [{ id: "a", kind: "box", frame: { selector: ".a" } }] },
      approval: { label: "Open the PR" },
    });
    expect(full.json).toBe(true);
    expect(run(["publish", "Ready?", "--approve", ""]).args.approval).toEqual({});
    expect(refused(["publish", "two", "words", "too many"]).message).toContain("quote an argument that has spaces in it");
    expect(refused(["publish", "x", "--marks", "{not json"]).message).toContain("--marks takes JSON");
  });

  test("capture: the part, the size, the mark and the publish, as the tool took them", () => {
    expect(run(["capture", "https://site.dev", "--selector", ".hero", "--size", "390x844", "--full", "--mark", "box", "--mark-label", "Moved up", "--publish", "The hero at phone width", "--key", "hero"]).args).toEqual({
      url: "https://site.dev",
      target: { selector: ".hero" },
      viewport: { width: 390, height: 844 },
      fullPage: true,
      mark: { kind: "box", label: "Moved up" },
      publish: { summary: "The hero at phone width", key: "hero" },
    });
    expect(run(["capture", "page.html", "--quote", "Start free trial", "--mark", "highlight"]).args).toEqual({
      url: "/work/site/page.html", target: { quote: "Start free trial" }, mark: "highlight",
    });
    expect(refused(["capture", "https://x.dev", "--selector", "a", "--quote", "b"]).message).toBe("pass one of --selector or --quote, not both");
    expect(refused(["capture", "https://x.dev", "--size", "big"]).message).toContain("--size is WIDTHxHEIGHT");
    expect(refused(["capture", "https://x.dev", "--key", "k"]).message).toContain("pass --publish too");
    // 2026-10-18 review: agents guessed argument names. An unknown flag names the ones there are.
    const sel = refused(["capture", "https://x.dev", "--sel", ".a"]);
    expect(sel.message).toBe("unknown option --sel; it takes --selector, --quote, --size, --full, --mark, --mark-label, --publish, --key");
    expect(usageErrorText(sel)).toContain("\nusage: conch agent capture <url>");
  });

  test("the browser: a bare target, or the flag that says what kind it is", () => {
    expect(run(["browser", "click", "e12"]).args).toEqual({ target: "e12" });
    expect(run(["browser", "click", "--text", "Sign in", "--tab", "t2"]).args).toEqual({ tab: "t2", target: { text: "Sign in" } });
    expect(run(["browser", "type", "#email", "me@example.com", "--submit"]).args).toEqual({ target: "#email", text: "me@example.com", submit: true });
    expect(run(["browser", "type", "--label", "Email", "me@example.com"]).args).toEqual({ target: { text: "Email" }, text: "me@example.com" });
    expect(run(["browser", "ask", "Sign", "in", "to", "Mobbin"]).args).toEqual({ reason: "Sign in to Mobbin" });
    expect(run(["browser", "open", "https://mobbin.com", "--profile", "Work"]).tool).toBe("browser_open");
    expect(run(["browser", "screenshot"]).tool).toBe("browser_screenshot");
    expect(refused(["browser", "click", "e1", "--ref", "e2"]).message).toContain("name two targets");
    expect(refused(["browser", "click"]).message).toContain("the target is missing");
    expect(refused(["browser"]).message).toContain("browser takes a command: open, read, click, type, screenshot, tabs, ask, close");
  });

  // 2026-11-11: a read is one page of the words unless it asks for another part, or all of it (browser-read.ts).
  test("browser read: a page, the words to find, a section, a part by selector, or all of it", () => {
    expect(run(["browser", "read"]).args).toEqual({});
    expect(run(["browser", "read", "--page", "2", "--tab", "t1"]).args).toEqual({ tab: "t1", page: 2 });
    expect(run(["browser", "read", "--find", "Sign in"]).args).toEqual({ find: "Sign in" });
    expect(run(["browser", "read", "--section", "Install", "--selector", "main"]).args).toEqual({ section: "Install", selector: "main" });
    expect(run(["browser", "read", "--full"]).args).toEqual({ full: true });
    expect(refused(["browser", "read", "--page", "two"]).message).toBe('--page takes a whole number, not "two"');
    expect(refused(["browser", "read", "--page", "0"]).message).toBe("--page counts from 1");
    expect(refused(["browser", "read", "pricing"]).message).toContain('unexpected "pricing"');
  });

  test("aliases an agent might type land on the command", () => {
    expect(run(["tab", "click", "e3"]).tool).toBe("browser_click");
    expect(run(["browser", "shot"]).tool).toBe("browser_screenshot");
    expect(run(["pause"]).args).toEqual({ action: "pause" });
    expect(run(["resume", "--all"]).args).toEqual({ action: "resume", scope: "all" });
    expect(run(["review_to_front", "x"]).tool).toBe("review_to_front");
  });

  test("sessions, tail, start, mode, config, bug and the rest", () => {
    expect(run(["sessions"]).args).toEqual({});
    expect(run(["sessions", "api", "--detail"]).args).toEqual({ session: "api", detail: true });
    expect(refused(["sessions", "--detail"]).message).toContain("--detail shows one session in full");
    expect(run(["tail", "1a2b3c4d", "--wait", "30", "--since", "c1", "--sentences", "5"]).args).toEqual({ session: "1a2b3c4d", wait: 30, since: "c1", sentences: 5 });
    expect(refused(["tail", "x", "--sentences", "many"]).message).toContain("--sentences takes a whole number");
    // A start is in the shell's folder unless it names another.
    expect(run(["start", "--sign-in", "Work Max", "--model", "fable", "--prompt", "Look into X"]).args).toEqual({ folder: "/work/site", signIn: "Work Max", model: "fable", prompt: "Look into X" });
    expect(run(["start", "--folder", "../other"]).args.folder).toBe("/work/other");
    expect(run(["mode", "pause", "--session", "abc1"]).args).toEqual({ action: "pause", session: "abc1" });
    expect(refused(["mode", "off"]).message).toContain("mode is pause (manual) or resume (automatic)");
    expect(run(["config", "voice-speed", "1.2"]).args).toEqual({ key: "voice-speed", value: "1.2" });
    expect(run(["config", "voice-speed", "--unset"]).args).toEqual({ key: "voice-speed", unset: true });
    expect(run(["folders", "src", "/abs/dir"]).args).toEqual({ folders: ["/work/site/src", "/abs/dir"] });
    expect(run(["rename", "abc1", "the", "api", "work"]).args).toEqual({ session: "abc1", label: "the api work" });
    expect(run(["unpublish", "r-1"]).args).toEqual({ id: "r-1" });
    expect(run(["unpublish", "--artifact", "hero"]).args).toEqual({ artifact: "hero" });
    expect(run(["atlas", "projects/conch/plan.md", "--file", "plan.md"]).args).toEqual({ path: "projects/conch/plan.md", markdown: "# read /work/site/plan.md" });
    expect(run(["atlas", "projects/conch/plan.md", "--file", "-"]).args.markdown).toBe("# from stdin");
    expect(run(["notify", "The", "deploy", "finished", "--link", "https://x.dev"]).args).toEqual({ body: "The deploy finished", link: "https://x.dev" });
    expect(run(["bug", "The pill never lit", "--happened", "published, no pill", "--expected", "the pill", "--evidence", "/tmp/a.png", "--evidence", "line 2", "--area", "publish"]).args).toEqual({
      title: "The pill never lit", happened: "published, no pill", expected: "the pill", area: "publish", evidence: ["/tmp/a.png", "line 2"],
    });
    expect(run(["whoami"]).tool).toBe("conch_whoami");
    expect(refused(["frobnicate"]).message).toContain("no conch agent command \"frobnicate\"");
    expect(refused(["sesions"]).message).toContain("did you mean `sessions`");
  });

  test("`--` ends the flags, for words that start with a dash", () => {
    expect(run(["speak", "--", "-5 degrees outside"]).args).toEqual({ text: "-5 degrees outside" });
  });
});

describe("conch_run's command line", () => {
  test("split as a shell would, quotes and escapes, nothing expanded, and a leading `conch agent` dropped", () => {
    expect(splitCommandLine(`browser click "Sign in"`)).toEqual(["browser", "click", "Sign in"]);
    expect(splitCommandLine(`conch agent publish 'It'\\''s done' /tmp/a.png`)).toEqual(["publish", "It's done", "/tmp/a.png"]);
    expect(splitCommandLine(`tail $HOME --wait 30`)).toEqual(["tail", "$HOME", "--wait", "30"]);
    expect(splitCommandLine(`notify "a \\"quoted\\" word" ""`)).toEqual(["notify", "a \"quoted\" word", ""]);
    expect(() => splitCommandLine(`browser click "Sign in`)).toThrow("unclosed double quote");
  });
});

describe("answers, short", () => {
  test("a tool that is a command now is named as the command", () => {
    expect(cliWording("close one (browser_close) first")).toBe("close one (conch agent browser close) first");
    expect(cliWording("check conch_sessions before forking again")).toBe("check conch agent sessions before forking again");
    // Publishing is still a tool, and a tool's full name is not a word to change.
    expect(cliWording("use review_to_front, or mcp__plugin_conch_conch__browser_open")).toBe("use review_to_front, or mcp__plugin_conch_conch__browser_open");
  });

  test("a field a line, a list an item a line, a long text as a block; --json the answer whole", () => {
    const value = { outcome: "filed", id: "r-1", surfaces: { mac: "running", phone: "off" }, focus: ["a.ts", "b/"], note: "line one\nline two" };
    expect(renderLines(value)).toEqual([
      "outcome: filed",
      "id: r-1",
      "surfaces: mac=running phone=off",
      "focus: a.ts, b/",
      "note:",
      "  line one",
      "  line two",
    ]);
    const publish = AGENT_COMMANDS.find((command) => command.name === "publish")!;
    expect(renderAgentAnswer(publish, value, true)).toBe(JSON.stringify(value));
    expect(renderAgentAnswer(publish, { note: "see conch_deliverables" }, true)).toBe(JSON.stringify({ note: "see conch agent deliverables" }));
  });

  test("sessions: who you are, then a session a line", () => {
    const sessions = AGENT_COMMANDS.find((command) => command.name === "sessions")!;
    const now = Date.parse("2026-11-11T12:00:00Z");
    const text = renderAgentAnswer(sessions, {
      caller: { status: "verified", sessionId: "s-1", label: "Alpha" },
      mode: { paused: true, muted: false },
      sessions: [
        { id: "s-1", label: "Alpha", backend: "claude", status: "working", cwd: "/work/a", account: "Default", lastActivity: "2026-11-11T11:55:00Z", alive: true, you: true, agents: 2 },
        { id: "s-2", label: "Beta", backend: "codex", status: "waiting", lastActivity: "2026-11-11T09:00:00Z", alive: true, toolsStale: { missing: ["conch_run"] } },
      ],
      claudeSignIns: [{ label: "Work Max", id: "abc-1" }],
      total: 2,
    }, false, now);
    expect(text.split("\n")).toEqual([
      'you: s-1 "Alpha" (verified)',
      "conch: manual mode",
      's-1  working  "Alpha"  (claude, Default)  /work/a  5m ago  ← you  2 subagents',
      's-2  waiting  "Beta"  (codex)  3h ago  tools stale (missing conch_run)',
      "claude sign-ins (start --sign-in): Work Max (abc-1)",
    ]);
  });

  test("browser read, compact: where in the page it is, its sections, the refs, then the way to more in flags", () => {
    const read = AGENT_COMMANDS.find((command) => command.name === "browser read")!;
    const answer = {
      tab: "t1", url: "https://site.dev/docs", title: "Docs", text: "Install\nRun it",
      page: { at: 1, of: 3 }, sections: ["Install", "Deploy"],
      links: [{ ref: "e1", text: "Pricing", href: "/pricing" }], buttons: [], fields: [],
      hidden: { links: 2 }, more: "page: 2 for page 2 of 3; …",
    };
    expect(renderAgentAnswer(read, answer, false).split("\n")).toEqual([
      "tab t1: Docs",
      "https://site.dev/docs",
      "page 1 of 3",
      "sections: Install · Deploy",
      "",
      "Install",
      "Run it",
      "",
      'link e1 "Pricing" /pricing',
      "more: --page 2 for page 2 of 3; 2 more links in this part; --find WORDS, --section HEADING or --selector CSS to narrow it; --full for the whole read",
    ]);
    // --json says the way to more in flags too: this is the shell's answer, not the MCP tool's.
    expect(JSON.parse(renderAgentAnswer(read, answer, true)).more).toStartWith("--page 2 for page 2 of 3");
    const found = renderAgentAnswer(read, { tab: "t1", url: "https://site.dev/docs", title: "Docs", find: "deploy", lines: 1, text: "Deploy it", links: [], buttons: [], fields: [] }, false);
    expect(found.split("\n")[2]).toBe('lines that say "deploy": 1');
  });

  test("browser read: the page, then its refs a line each, never a password's value", () => {
    const read = AGENT_COMMANDS.find((command) => command.name === "browser read")!;
    const text = renderAgentAnswer(read, {
      tab: "t1", url: "https://site.dev/login", title: "Log in", text: "Welcome back",
      links: [{ ref: "e1", text: "Pricing", href: "https://site.dev/pricing" }],
      buttons: [{ ref: "e2", text: "Sign in" }],
      fields: [{ ref: "e3", type: "email", label: "Email", value: "me@example.com" }, { ref: "e4", type: "password", label: "Password" }],
    }, false);
    expect(text.split("\n")).toEqual([
      "tab t1: Log in",
      "https://site.dev/login",
      "",
      "Welcome back",
      "",
      'link e1 "Pricing" https://site.dev/pricing',
      'button e2 "Sign in"',
      'field e3 email "Email" = "me@example.com"',
      'field e4 password "Password"',
    ]);
  });
});

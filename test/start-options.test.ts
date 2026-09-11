import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentAdapters, BYPASS_OPTION, claudeAdapter, codexAdapter } from "../src/agent-adapter.ts";
import {
  startRequestFromArgv,
  startUsage,
  terminalSessionCommand,
} from "../src/session-lifecycle.ts";
import { validateControlMessage } from "../src/settings.ts";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

// A missing token has index -1: ordering alone would reward a deletion.
function expectBefore(source: string, first: string, second: string) {
  expect(source).toContain(first);
  expect(source).toContain(second);
  expect(source.indexOf(first)).toBeLessThan(source.indexOf(second));
}

describe("the start-options table (C1)", () => {
  test.each(agentAdapters().map((adapter) => [adapter.displayName, adapter] as const))(
    "%s: every entry has a flag, a kind and the CLI's help; enums have choices; names are unique",
    (_, adapter) => {
      expect(adapter.startOptions.length).toBeGreaterThan(0);
      const names = new Set<string>();
      for (const entry of adapter.startOptions) {
        expect(entry.name).toMatch(/^[a-z][a-z-]*$/);
        expect(entry.flag).toMatch(/^--[a-z][a-z-]*$/);
        expect(["enum", "bool", "string"]).toContain(entry.kind);
        expect(entry.help.length).toBeGreaterThan(10);
        if (entry.kind === "enum") expect(entry.choices?.length ?? 0).toBeGreaterThan(1);
        else expect(entry.choices).toBeUndefined();
        expect(names.has(entry.name)).toBe(false);
        names.add(entry.name);
      }
      const bypass = adapter.startOptions.find((entry) => entry.name === BYPASS_OPTION);
      expect(bypass?.kind).toBe("bool");
      expect(bypass?.flag).toBe(adapter.bypassPermissionsFlag);
    },
  );

  test("lists what each CLI's --help offers, and nothing free-form", () => {
    // `claude --help` 2.1.266 and `codex --help` 0.153.4, read on this Mac.
    expect(claudeAdapter.startOptions.map((entry) => entry.flag))
      .toEqual(["--model", "--permission-mode", "--dangerously-skip-permissions", "--effort", "--fork-session"]);
    expect(codexAdapter.startOptions.map((entry) => entry.flag))
      .toEqual(["--model", "--sandbox", "--ask-for-approval", "--dangerously-bypass-approvals-and-sandbox", "--profile"]);
    // Tool lists, extra directories and raw config overrides cannot be validated; they stay out.
    for (const adapter of agentAdapters()) {
      for (const entry of adapter.startOptions) expect(entry.flag).not.toMatch(/tools|add-dir|config|^-c$/);
    }
  });
});

describe("start-option validation", () => {
  const start = { kind: "session-start" as const, backend: "claude" as const, cwd: "/w" };

  test("accepts every table option with a fitting value, and carries exactly those", () => {
    const options = {
      model: "opus",
      "permission-mode": "plan",
      "bypass-permissions": false,
      effort: "high",
      "fork-session": true,
    };
    expect(validateControlMessage({ ...start, resumeSessionId: "abc", options }))
      .toEqual({ ok: true, value: { ...start, resumeSessionId: "abc", options } });
    expect(validateControlMessage(start)).toEqual({ ok: true, value: start });
    expect(validateControlMessage({ ...start, backend: "codex", options: { sandbox: "read-only", profile: "work" } }))
      .toEqual({ ok: true, value: { ...start, backend: "codex", options: { sandbox: "read-only", profile: "work" } } });
  });

  test.each([
    [
      { yolo: true },
      'Claude Code has no start option "yolo" (it offers model, permission-mode, bypass-permissions, effort, fork-session)',
    ],
    [
      { "permission-mode": "yolo" },
      '--permission-mode: "yolo" is not one of acceptEdits, auto, bypassPermissions, manual, dontAsk, plan — Permission mode to use for the session',
    ],
    [
      { "bypass-permissions": "yes" },
      "--dangerously-skip-permissions is on or off — Bypass all permission checks. Recommended only for sandboxes with no internet access.",
    ],
    [
      { effort: true },
      "--effort takes a value — Effort level for the current session (low, medium, high, xhigh, max)",
    ],
    [
      { model: "opus; rm -rf /" },
      "--model must be letters, digits, dots, underscores, colons, brackets or hyphens, starting with a letter or number — Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').",
    ],
    [
      { "fork-session": true },
      "--fork-session applies only to a resume — When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)",
    ],
  ])("refuses %j in the CLI's own words, at the socket and at a direct launch", (options, err) => {
    expect(validateControlMessage({ ...start, options })).toEqual({ ok: false, err });
    expect(() => terminalSessionCommand({ backend: "claude", cwd: "/w", options } as never)).toThrow(err);
  });

  test.each([["a string"], [["model", "opus"]], [null], [42]])("refuses options shaped as %j", (options) => {
    expect(validateControlMessage({ ...start, options })).toEqual({ ok: false, err: "options must be an object" });
  });

  test("one agent's option is refused for the other", () => {
    expect(validateControlMessage({ ...start, options: { sandbox: "read-only" } }).ok).toBe(false);
    expect(validateControlMessage({ ...start, backend: "codex", options: { effort: "high" } }).ok).toBe(false);
  });

  test("__proto__ is not a start option", () => {
    expect(validateControlMessage({ ...start, options: JSON.parse('{"__proto__": {"x": 1}}') }).ok).toBe(false);
  });
});

describe("the rendered command", () => {
  test("Claude: after the resume argument, in table order, shell-quoted", () => {
    expect(terminalSessionCommand({
      backend: "claude",
      cwd: "/w",
      resumeSessionId: "abc",
      options: { effort: "max", "fork-session": true, model: "claude-fable-5", "permission-mode": "plan", "bypass-permissions": true },
    })).toBe(
      "cd -- '/w' && exec claude --dangerously-skip-permissions --resume 'abc' --model 'claude-fable-5' --permission-mode 'plan' --effort 'max' --fork-session",
    );
  });

  test("Codex: after `resume <id>`, where the subcommand takes the same options", () => {
    // Verified against codex-cli 0.153.4: `codex resume x --sandbox bogus`
    // is rejected by name, so the flag is parsed there, not read as a prompt.
    expect(terminalSessionCommand({
      backend: "codex",
      cwd: "/w",
      resumeSessionId: "t1",
      options: { profile: "work", "ask-for-approval": "never", sandbox: "workspace-write", model: "gpt-5", "bypass-permissions": true },
    })).toBe(
      "cd -- '/w' && exec codex --dangerously-bypass-approvals-and-sandbox resume 't1' --model 'gpt-5' --sandbox 'workspace-write' --ask-for-approval 'never' --profile 'work'",
    );
  });

  test("the request's bypass toggle beats the persisted default, both ways", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w", bypassPermissions: true, options: { "bypass-permissions": false } }))
      .toBe("cd -- '/w' && exec claude");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", bypassPermissions: false, options: { "bypass-permissions": true } }))
      .toBe("cd -- '/w' && exec codex --dangerously-bypass-approvals-and-sandbox");
  });

  test("no options, or a false toggle, renders nothing extra", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w", options: {} })).toBe("cd -- '/w' && exec claude");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", bypassPermissions: true, options: { "bypass-permissions": false } }))
      .toBe("cd -- '/w' && exec codex");
  });

  test("a teleport keeps its argument first", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w", teleportSessionId: "s1", options: { effort: "low" } }))
      .toBe("cd -- '/w' && exec claude --teleport 's1' --effort 'low'");
  });
});

describe("conch start", () => {
  test("parses the agent, the fixed arguments and the table's options", () => {
    expect(startRequestFromArgv([
      "codex", "--cwd", "/w", "--resume", "t1", "--sandbox", "read-only", "--no-bypass-permissions", "--model", "gpt-5",
    ])).toEqual({
      backend: "codex",
      cwd: "/w",
      resumeSessionId: "t1",
      options: { sandbox: "read-only", "bypass-permissions": false, model: "gpt-5" },
    });
    expect(startRequestFromArgv([])).toEqual({ backend: "claude" });
    expect(startRequestFromArgv(["--effort", "high", "--bypass-permissions"]))
      .toEqual({ backend: "claude", options: { effort: "high", "bypass-permissions": true } });
  });

  test.each([
    [["--sandbox", "read-only"], "unknown argument --sandbox"],
    [["--no-model", "x"], "unknown argument --no-model"],
    [["--model"], "--model needs a value"],
    [["codex", "--sandbox", "bogus"], '--sandbox: "bogus" is not one of read-only, workspace-write, danger-full-access'],
    [["--fork-session"], "applies only to a resume"],
    [["codex", "--teleport", "x"], "Codex has no teleport"],
    [["--cwd"], "--cwd needs a value"],
  ])("refuses %j", (args, message) => {
    expect(() => startRequestFromArgv(args)).toThrow(message);
  });

  test("--help shows exactly the table, in the CLI's words", () => {
    for (const adapter of agentAdapters()) {
      const usage = startUsage(adapter);
      expect(usage).toContain(`${adapter.displayName} options:`);
      for (const entry of adapter.startOptions) {
        expect(usage).toContain(`--${entry.name}`);
        expect(usage).toContain(entry.help);
        for (const choice of entry.choices ?? []) expect(usage).toContain(choice);
        if (entry.kind === "bool") expect(usage).toContain(`--no-${entry.name}`);
      }
    }
  });

  test("the CLI routes `start` through the parser and the launcher, with the persisted default", () => {
    const cli = read("src/cli.ts");
    const from = cli.indexOf('case "start": {');
    expect(from).toBeGreaterThan(-1);
    const block = cli.slice(from, cli.indexOf('case "help-session": {', from));
    expect(block).toContain("startRequestFromArgv(rest)");
    expect(block).toContain("agentAdapters().map(startUsage)");
    expect(block).toContain("startTerminalSession({ bypassPermissions: cfg.bypassPermissions, ...request })");
    expect(cli).toContain("start [claude|codex] [options]");
  });

  test("the daemon hands the request's options to the launcher", () => {
    const source = read("src/daemon.ts");
    const from = source.indexOf("start: (message) =>");
    expect(from).toBeGreaterThan(-1);
    expect(source.slice(from, source.indexOf("folderTrusted:", from))).toContain("...message");
  });
});

/** The Swift spelling of one table entry, as both sheets write it. */
function swiftEntry(entry: (typeof claudeAdapter.startOptions)[number]): string {
  const kind = entry.kind === "bool"
    ? ".toggle"
    : entry.kind === "string"
    ? ".text"
    : `.choice([${(entry.choices ?? []).map((choice) => `"${choice}"`).join(", ")}])`;
  return `StartOption(name: "${entry.name}", kind: ${kind}, help: "${entry.help}"${entry.resumeOnly ? ", resumeOnly: true" : ""})`;
}

for (const [platform, path, resuming] of [
  ["Mac", "mac-app/conch-mac/ContentView.swift", "mode == .resume"],
  ["iOS", "mobile/conch-ios/conch-ios/LedgerView.swift", "resuming"],
] as const) {
  describe(`${platform} start sheet`, () => {
    const source = read(path);

    test("mirrors the table exactly: every entry, kind, choice and help line, per agent, and no others", () => {
      for (const adapter of agentAdapters()) {
        const head = `static let ${adapter.backend}: [StartOption] = [`;
        const from = source.indexOf(head);
        expect(from).toBeGreaterThan(-1);
        const list = source.slice(from, source.indexOf("]\n", from + head.length));
        for (const entry of adapter.startOptions) expect(list).toContain(swiftEntry(entry));
        expect(list.split("StartOption(name:").length - 1).toBe(adapter.startOptions.length);
      }
    });

    test("shows the chosen agent's table, resume-only entries only while resuming", () => {
      expect(source).toContain(`StartOption.table(for: effectiveBackend).filter { !$0.resumeOnly || ${resuming} }`);
      expect(source).toContain("ForEach(shownOptions)");
    });

    test("a toggle for booleans, a segmented control for enums, a field for strings, each with its help line", () => {
      expectBefore(source, "case .toggle:", "Toggle(option.name, isOn: toggleBinding(option.name))");
      // The mode picker near the top is segmented too, so look after the choice case.
      const choice = source.indexOf("case let .choice(choices):");
      expect(choice).toBeGreaterThan(-1);
      expect(source.slice(choice)).toContain(platform === "Mac"
        ? ".modifier(ChoiceStyle(segmented: choices.count <= 3))"
        : ".pickerStyle(.segmented)");
      if (platform === "Mac") expect(source).toContain("content.pickerStyle(.segmented)");
      expectBefore(source, "case .text:", "TextField(option.name, text: textBinding(option.name)");
      expectBefore(source, "TextField(option.name, text: textBinding(option.name)", "Text(option.help)");
      expect(source).toContain('Text("Default").tag("")');
    });

    test("the bypass toggle starts from the persisted setting, untouched toggles only", () => {
      expect(source).toContain(platform === "Mac"
        ? "await store.bypassPermissionsDefault()"
        : '$0.key == "bypass-permissions"');
      expectBefore(source, 'optionValues["bypass-permissions"] == nil', 'optionValues["bypass-permissions"] = .bool(value)');
    });

    test("sends exactly the shown options the person set", () => {
      expectBefore(source, "for option in shownOptions {", "if let value = optionValues[option.name]");
      expect(source).toContain("options: sentOptions");
    });
  });
}

describe("the option values reach the daemon", () => {
  test("Mac: the socket request carries `options`, and the store forwards them", () => {
    expect(read("mac-app/conch-mac/ConchSocketClient.swift")).toContain("let options: [String: ConchStartOptionValue]?");
    const store = read("mac-app/conch-mac/StateStore.swift");
    expect(store).toContain("options: options.isEmpty ? nil : options");
    expect(store).toContain('reply.snapshot["bypass-permissions"]?.value');
  });

  test("iOS: the bridge puts `options` on the wire", () => {
    expectBefore(read("mobile/conch-ios/conch-ios/BridgeClient.swift"), '"kind": "session-start"', 'message["options"] = options');
  });
});

describe("iOS: a bypass default the Mac never answered", () => {
  test("says the Mac's default applies, and sends nothing until the person picks", () => {
    const source = read("mobile/conch-ios/conch-ios/LedgerView.swift");
    const unknown = 'if option.name == "bypass-permissions", optionValues[option.name] == nil {';
    const menu = `Menu("uses your Mac's default")`;
    const on = 'Button("On") { optionValues[option.name] = .bool(true) }';
    const off = 'Button("Off") { optionValues[option.name] = .bool(false) }';
    expectBefore(source, "case .toggle:", unknown);
    expectBefore(source, unknown, menu);
    expectBefore(source, menu, on);
    expectBefore(source, on, off);
    expectBefore(source, off, "Toggle(option.name, isOn: toggleBinding(option.name))");
  });
});

import { describe, expect, test } from "bun:test";
import { startRequestFromArgv, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlMessage } from "../src/settings.ts";

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
    [{ yolo: true }, 'has no start option "yolo"'],
    [{ "permission-mode": "yolo" }, '"yolo" is not one of'],
    [{ "bypass-permissions": "yes" }, "is on or off"],
    [{ effort: true }, "--effort takes a value"],
    [{ model: "opus; rm -rf /" }, "--model must be letters"],
    [{ "fork-session": true }, "--fork-session applies only to a resume"],
  ])("refuses %j, at the socket and at a direct launch", (options, err) => {
    const result = validateControlMessage({ ...start, options });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.err).toContain(err);
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
    // Verified against codex-cli 0.154.0: `codex resume x --sandbox bogus`
    // is rejected by name, so the flag is parsed there, not read as a prompt.
    // No bypass here: Codex refuses that flag alongside these two (below).
    expect(terminalSessionCommand({
      backend: "codex",
      cwd: "/w",
      resumeSessionId: "t1",
      options: { profile: "work", "ask-for-approval": "never", sandbox: "workspace-write", "bypass-permissions": false },
    })).toBe(
      "cd -- '/w' && exec codex --no-daemon resume 't1' --sandbox 'workspace-write' --ask-for-approval 'never' --profile 'work'",
    );
  });

  test("the request's bypass toggle beats the persisted default, both ways", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w", bypassPermissions: true, options: { "bypass-permissions": false } }))
      .toBe("cd -- '/w' && exec claude");
    expect(terminalSessionCommand({ backend: "codex", cwd: "/w", bypassPermissions: false, options: { "bypass-permissions": true } }))
      .toBe("cd -- '/w' && exec codex --no-daemon --dangerously-bypass-approvals-and-sandbox");
  });

  /**
   * The launch Tyler pasted from his terminal, which never opened a session:
   *
   *   exec codex --dangerously-bypass-approvals-and-sandbox \
   *     -c 'projects."/Users/you/Projects".trust_level="trusted"' \
   *     --sandbox 'danger-full-access' --ask-for-approval 'never'
   *   error: the argument '--dangerously-bypass-approvals-and-sandbox' cannot
   *   be used with '--ask-for-approval <APPROVAL_POLICY>'
   *
   * Reproduced against the installed binary (codex-cli 0.154.0): exit 2, before
   * anything starts. Note that `--help` exits 0 with the same pair, so a dry run
   * cannot catch this — only these pins can.
   */
  describe("the mutually exclusive pair Codex refuses", () => {
    const projects = "/Users/you/Projects";
    const trusted = `-c 'projects."${projects}".trust_level="trusted"'`;

    test("Tyler's intent — full access, trusted folder, no approvals — is one coherent form", () => {
      // Both halves are the bypass flag's own job, so it is the whole command.
      expect(terminalSessionCommand({ backend: "codex", cwd: projects, bypassPermissions: true, trustFolder: true }))
        .toBe(`cd -- '${projects}' && exec codex --no-daemon --dangerously-bypass-approvals-and-sandbox ${trusted}`);
      expect(terminalSessionCommand({
        backend: "codex", cwd: projects, bypassPermissions: true, trustFolder: true, resumeSessionId: "0199-abc",
      })).toBe(`cd -- '${projects}' && exec codex --no-daemon --dangerously-bypass-approvals-and-sandbox ${trusted} resume '0199-abc'`);
    });

    test.each([
      ["the sheet's own toggle", { "bypass-permissions": true, sandbox: "danger-full-access" }, undefined, "--sandbox"],
      ["the sheet's own toggle", { "bypass-permissions": true, "ask-for-approval": "never" }, undefined, "--ask-for-approval"],
      // How it actually happened: the flag came from the persisted setting,
      // underneath options that carried no bypass key at all.
      ["the persisted setting", { sandbox: "danger-full-access" }, true, "--sandbox"],
      ["the persisted setting", { "ask-for-approval": "never" }, true, "--ask-for-approval"],
    ] as const)("refuses it when the flag comes from %s (%j), fresh and resumed", (_, options, bypassPermissions, flag) => {
      const message = `--dangerously-bypass-approvals-and-sandbox cannot be used with ${flag}: codex refuses both at once`;
      for (const resume of [undefined, "t1"]) {
        expect(() => terminalSessionCommand({
          backend: "codex",
          cwd: "/w",
          ...(bypassPermissions === undefined ? {} : { bypassPermissions }),
          ...(resume === undefined ? {} : { resumeSessionId: resume }),
          options: { ...options },
        })).toThrow(message);
      }
      // And at the socket, where the sheets and the phone send it.
      if (bypassPermissions === undefined) {
        expect(validateControlMessage({ kind: "session-start", backend: "codex", cwd: "/w", options: { ...options } }))
          .toEqual({ ok: false, err: expect.stringContaining(message) as unknown as string });
      }
    });

    test("no combination conch will emit ever carries both", () => {
      for (const sandbox of [undefined, "read-only", "workspace-write", "danger-full-access"]) {
        for (const approval of [undefined, "on-request", "never"]) {
          for (const bypass of [undefined, true, false]) {
            for (const persisted of [undefined, true, false]) {
              const options = {
                ...(sandbox === undefined ? {} : { sandbox }),
                ...(approval === undefined ? {} : { "ask-for-approval": approval }),
                ...(bypass === undefined ? {} : { "bypass-permissions": bypass }),
              };
              let command: string;
              try {
                command = terminalSessionCommand({
                  backend: "codex",
                  cwd: "/w",
                  ...(persisted === undefined ? {} : { bypassPermissions: persisted }),
                  options,
                });
              } catch {
                continue; // refused before launch, which is the point
              }
              if (command.includes("--dangerously-bypass-approvals-and-sandbox")) {
                expect(command).not.toContain("--sandbox");
                expect(command).not.toContain("--ask-for-approval");
              }
            }
          }
        }
      }
    });

    test("without the bypass flag the pair is Codex's own supported form, and still renders", () => {
      expect(terminalSessionCommand({
        backend: "codex", cwd: "/w", options: { sandbox: "danger-full-access", "ask-for-approval": "never" },
      })).toBe("cd -- '/w' && exec codex --no-daemon --sandbox 'danger-full-access' --ask-for-approval 'never'");
    });
  });

  test("a teleport keeps its argument first", () => {
    expect(terminalSessionCommand({ backend: "claude", cwd: "/w", teleportSessionId: "s1", options: { effort: "low" } }))
      .toBe("cd -- '/w' && exec claude --teleport 's1' --effort 'low'");
  });
});

describe("conch start", () => {
  test("parses the agent, the fixed arguments and the table's options", () => {
    expect(startRequestFromArgv([
      "codex", "--cwd", "/w", "--resume", "t1", "--sandbox", "read-only", "--no-bypass-permissions",
    ])).toEqual({
      backend: "codex",
      cwd: "/w",
      resumeSessionId: "t1",
      options: { sandbox: "read-only", "bypass-permissions": false },
    });
    // No `--model` for codex: it takes its model from its own config. Claude still has one, and the
    // "--model needs a value" case below is claude's (no agent argument), so the flag stays covered.
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
});

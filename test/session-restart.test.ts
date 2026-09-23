import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchRuntimeControlMessage, injectTimeoutFor } from "../src/daemon.ts";
import { readProcessArgs, restartRequest, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlMessage, validateControlResponse } from "../src/settings.ts";

/**
 * Restart: close a session, then resume the same conversation with the flags
 * it was started with, so an updated Claude Code or Codex takes effect without
 * retyping the command. Command lines below are the live ones measured
 * 2026-09-23 (`ps -o args=`, after the executable).
 */
const claudeRow = { sessionId: "2f266f8d-2cab-4137-b09e-77fc1066fbc1", backend: "claude" as const, cwd: "/Users/t/arch" };
const codexRow = { sessionId: "01a08ea0-9e2a-7563-863d-c9158fb22d16", backend: "codex" as const, cwd: "/Users/t/assets" };
const command = (built: ReturnType<typeof restartRequest>) => terminalSessionCommand(built.request);

describe("what a restart relaunches", () => {
  test("Claude: the same folder and conversation, bypass kept, the old --resume value ignored", () => {
    const built = restartRequest(claudeRow, ["--dangerously-skip-permissions", "--resume", "Arch", "Prime"]);
    expect(built.notCarriedOver).toEqual([]);
    expect(command(built)).toBe(
      "cd -- '/Users/t/arch' && exec claude --dangerously-skip-permissions --resume '2f266f8d-2cab-4137-b09e-77fc1066fbc1'",
    );
  });

  test("bypass stays off when the command line didn't have it, whatever the saved default", () => {
    const built = restartRequest(claudeRow, []);
    expect(terminalSessionCommand({ ...built.request, bypassPermissions: true })).not.toContain("--dangerously-skip-permissions");
  });

  test("every start-table flag carries over, spaced or with =", () => {
    const built = restartRequest(claudeRow, ["--model", "opus", "--effort=high", "--permission-mode", "plan"]);
    expect(built.notCarriedOver).toEqual([]);
    expect(command(built)).toEndWith("--model 'opus' --permission-mode 'plan' --effort 'high'");
  });

  test("flags that pick a conversation are dropped quietly: a restart always resumes this one", () => {
    const built = restartRequest(claudeRow, ["--continue", "--fork-session", "--session-id", "abc", "-r", "--model", "opus"]);
    expect(built.notCarriedOver).toEqual([]);
    expect(built.request.options).toEqual({ "bypass-permissions": false, model: "opus" });
    expect(built.request.resumeSessionId).toBe(claudeRow.sessionId);
  });

  test("a known flag with a value that fails validation is reported, never replayed", () => {
    const built = restartRequest(claudeRow, ["--model", "x;rm", "--effort", "ludicrous"]);
    expect(built.notCarriedOver).toEqual(["--model x;rm", "--effort ludicrous"]);
    expect(command(built)).not.toContain("x;rm");
  });

  test("Codex: resume by thread id; an unknown flag and its value come back as not carried over", () => {
    const built = restartRequest(codexRow, ["resume", codexRow.sessionId, "-c", "model_provider=openai", "--sandbox", "workspace-write"]);
    expect(built.notCarriedOver).toEqual(["-c model_provider=openai"]);
    expect(command(built)).toBe(
      "cd -- '/Users/t/assets' && exec codex resume '01a08ea0-9e2a-7563-863d-c9158fb22d16' --sandbox 'workspace-write'",
    );
  });

  test("an opening prompt is not a setting", () => {
    expect(command(restartRequest(codexRow, ["yolo"]))).toEndWith("exec codex resume '01a08ea0-9e2a-7563-863d-c9158fb22d16'");
  });

  test("two windows on one id: resumes the conversation id, not the window key", () => {
    const built = restartRequest({ ...claudeRow, sessionId: `${claudeRow.sessionId}#9215`, agentSessionId: claudeRow.sessionId }, []);
    expect(built.request.resumeSessionId).toBe(claudeRow.sessionId);
  });
});

describe("reading a live process's command line", () => {
  test("after the executable, as ps shows it; null for a pid that isn't running", async () => {
    // This test run's own process: `bun test …`.
    expect((await readProcessArgs(process.pid))?.[0]).toBe("test");
    expect(await readProcessArgs(999_999)).toBeNull();
  });
});

describe("the restart request on the wire", () => {
  test("session-close takes restart: true, and nothing else in that field", () => {
    expect(validateControlMessage({ kind: "session-close", sessionId: "s1", restart: true })).toEqual({
      ok: true,
      value: { kind: "session-close", sessionId: "s1", restart: true },
    });
    expect(validateControlMessage({ kind: "session-close", sessionId: "s1" })).toEqual({
      ok: true,
      value: { kind: "session-close", sessionId: "s1" },
    });
    expect(validateControlMessage({ kind: "session-close", sessionId: "s1", restart: "yes" }).ok).toBe(false);
    expect(validateControlMessage({ kind: "session-close", sessionId: "s1", restart: false }).ok).toBe(false);
  });

  test("the reply says it restarted and what didn't carry over", async () => {
    const calls: Array<[string, boolean | undefined]> = [];
    const options = {
      listResumable: () => ({ sessions: [], complete: true }),
      start: () => {},
      report: () => {},
      close: async (id: string, restart?: boolean) => {
        calls.push([id, restart]);
        return restart ? { notCarriedOver: ["-c model_provider=openai"] } : undefined;
      },
    };
    expect(await dispatchRuntimeControlMessage({ kind: "session-close", sessionId: "s1", restart: true }, options)).toEqual({
      handled: true,
      response: { kind: "session-closed", sessionId: "s1", restarted: true, notCarriedOver: ["-c model_provider=openai"] },
    });
    expect(await dispatchRuntimeControlMessage({ kind: "session-close", sessionId: "s2" }, options)).toEqual({
      handled: true,
      response: { kind: "session-closed", sessionId: "s2" },
    });
    expect(calls).toEqual([["s1", true], ["s2", false]]);
  });

  test("the reply validates, and a malformed notCarriedOver is refused", () => {
    expect(validateControlResponse({ kind: "session-closed", sessionId: "s1", restarted: true, notCarriedOver: ["-c x=y"] }).ok).toBe(true);
    expect(validateControlResponse({ kind: "session-closed", sessionId: "s1", notCarriedOver: "-c x=y" }).ok).toBe(false);
    expect(validateControlResponse({ kind: "session-closed", sessionId: "s1", notCarriedOver: [""] }).ok).toBe(false);
  });

  test("a restart gets longer than a close: it opens a Terminal window afterwards", () => {
    expect(injectTimeoutFor(JSON.stringify({ kind: "session-close", restart: true }))).toBe(20_000);
    expect(injectTimeoutFor(JSON.stringify({ kind: "session-close" }))).toBe(12_000);
  });
});

describe("the daemon's restart path, as source", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
  const at = daemon.indexOf("const closeLiveSession = async (sessionId: string, restart = false)");
  const body = daemon.slice(at, daemon.indexOf("\n  };", at));

  test("everything that can refuse runs before the close", () => {
    expect(at).toBeGreaterThan(-1);
    expect(body.length).toBeGreaterThan(800);
    const close = body.indexOf("await closeSession(session);");
    expect(close).toBeGreaterThan(-1);
    for (const guard of [
      "if (session.jobId) {",
      "const args = session.pid ? await readProcessArgs(session.pid) : null;",
      "relaunch = restartRequest(session, args);",
      "terminalSessionCommand(relaunch.request);",
    ]) {
      const index = body.indexOf(guard);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(close);
    }
    expect(body.indexOf("await startTerminalSession(relaunch.request);")).toBeGreaterThan(close);
  });

  test("a relaunch that fails after the close says the session is closed", () => {
    expect(body).toContain("closed, but could not open it again");
  });
});

describe("the Mac app's restart", () => {
  const app = (name: string) => readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", name), "utf8");
  const dashboard = app("DashboardView.swift");
  const store = app("StateStore.swift");
  const inspector = app("CapabilityInspectorView.swift");

  test("the session menu offers it, confirmed first, and not for a row with no terminal", () => {
    expect(dashboard).toMatch(/Button\("Restart session…"\) \{\s*sessionPendingRestart = row\s*\}\s*\.disabled\(row\.noTerminal != nil\)/);
    expect(dashboard).toMatch(/\.alert\(\s*"Restart [\s\S]*?Button\("Restart"\) \{[\s\S]*?store\.closeSession\(row, restart: true\)/);
  });

  test("a successful restart clears the row's message, or says what didn't carry over", () => {
    const finish = store.slice(store.indexOf("private func finishClose("), store.indexOf("func reportAppError"));
    expect(finish).toContain("notCarriedOver = closed.notCarriedOver ?? []");
    expect(finish).toMatch(/\} else if restart \{\s*[\s\S]*?rowMessages\[row\.id\] = notCarriedOver\.isEmpty\s*\? nil/);
  });

  test("the inspector offers Restart only where a newer version is already installed", () => {
    expect(inspector).toMatch(/if install\.restartToUpdate == true, let onRestart \{\s*Button\("Restart session", action: onRestart\)/);
    expect(inspector).toMatch(/onRestart: row\.noTerminal == nil \? \{\s*store\.closeSession\(row, restart: true\)/);
  });
});

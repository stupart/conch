import { describe, expect, test } from "bun:test";
import { dispatchRuntimeControlMessage, injectTimeoutFor } from "../src/daemon.ts";
import { CLOSE_TIMED_STEPS_MS, readProcessArgs, restartRequest, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlMessage, validateControlResponse } from "../src/settings.ts";

/**
 * Restart: close a session, then resume the same conversation with the flags
 * it was started with, so an updated Claude Code or Codex takes effect without
 * retyping the command. Command lines below are the live ones measured
 * 2026-09-23 (`ps -o args=`, after the executable).
 */
const claudeRow = { sessionId: "5e5e5e10-0010-4000-8000-000000000010", backend: "claude" as const, cwd: "/Users/t/morrow" };
const codexRow = { sessionId: "5e5e5e19-0019-7000-8000-000000000019", backend: "codex" as const, cwd: "/Users/t/assets" };
const command = (built: ReturnType<typeof restartRequest>) => terminalSessionCommand(built.request);

describe("what a restart relaunches", () => {
  test("Claude: the same folder and conversation, bypass kept, the old --resume value ignored", () => {
    const built = restartRequest(claudeRow, ["--dangerously-skip-permissions", "--resume", "Morrow", "Prime"]);
    expect(built.notCarriedOver).toEqual([]);
    expect(command(built)).toBe(
      "cd -- '/Users/t/morrow' && exec claude --dangerously-skip-permissions --resume '5e5e5e10-0010-4000-8000-000000000010'",
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
      "cd -- '/Users/t/assets' && exec codex --no-daemon resume '5e5e5e19-0019-7000-8000-000000000019' --sandbox 'workspace-write'",
    );
  });

  test("an opening prompt is not a setting", () => {
    expect(command(restartRequest(codexRow, ["yolo"]))).toEndWith("exec codex --no-daemon resume '5e5e5e19-0019-7000-8000-000000000019'");
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

  // The phone's answer comes through this budget: shorter than the close itself, and a close that worked
  // reads on the phone as a failed one.
  test("a close's budget outlasts the close's own timed steps, and a restart's (which opens a window after) outlasts a close's", () => {
    const close = injectTimeoutFor(JSON.stringify({ kind: "session-close" }));
    expect(close).toBeGreaterThanOrEqual(CLOSE_TIMED_STEPS_MS + 5_000);
    expect(injectTimeoutFor(JSON.stringify({ kind: "session-close", restart: true }))).toBeGreaterThan(close);
  });
});

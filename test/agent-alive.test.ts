import { describe, expect, test } from "bun:test";
import { confirmAgentStarted, lastTabLines, tabAgentState, type AgentStartWatch, type TabAgentState } from "../src/agent-alive.ts";

/**
 * 2026-10-18: `conch start … --resume … --fork-session` said "opened Claude Code in Terminal" and exited 0 for a Claude
 * Code that had already exited, and the agent told the user the fork was open. A start now says "opened" only once the
 * agent is running in its tab.
 */
describe("what a tab is running", () => {
  test("the agent, by its executable or a runtime running it; its shell alone; nothing; or unknown", () => {
    expect(tabAgentState(["login -pf alex", "claude --resume 162f2800 --fork-session"], "claude")).toBe("running");
    expect(tabAgentState(["node /opt/homebrew/bin/claude --resume x"], "claude")).toBe("running");
    expect(tabAgentState(["/Users/alex/.codex/bin/codex fork x"], "codex")).toBe("running");
    expect(tabAgentState(["login -pf alex", "-zsh"], "claude")).toBe("starting");
    // A child it left (an MCP server, caffeinate) is not the agent.
    expect(tabAgentState(["bun run /Users/alex/conch/src/cli.ts mcp"], "claude")).toBe("starting");
    expect(tabAgentState([], "claude")).toBe("gone");
    expect(tabAgentState(null, "claude")).toBe("unknown");
  });

  test("the last lines a tab showed, without Terminal's own sign-off", () => {
    expect(lastTabLines("Last login: Sat\n$ claude --resume x\nNo conversation found with session ID: x\n\n[Process completed]\n"))
      .toBe("Last login: Sat\n$ claude --resume x\nNo conversation found with session ID: x");
    expect(lastTabLines("a\nb\nc\nd\ne\nf\ng\nh", 3)).toBe("f\ng\nh");
    expect(lastTabLines("\n\n")).toBeUndefined();
    expect(lastTabLines(null)).toBeUndefined();
  });
});

describe("confirming a start", () => {
  function fake(states: (at: number) => TabAgentState): AgentStartWatch {
    let clock = 0;
    return {
      state: async () => states(clock),
      lastWords: async () => "No conversation found with session ID: 162f2800",
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    };
  }

  test("running steadily: up", async () => {
    expect(await confirmAgentStarted(fake(() => "running"))).toEqual({ ok: true, state: "running" });
    expect(await confirmAgentStarted(fake((at) => (at < 1_500 ? "starting" : "running")))).toEqual({ ok: true, state: "running" });
  });

  test("gone after it ran: not up, with what its tab said", async () => {
    expect(await confirmAgentStarted(fake((at) => (at < 1_000 ? "running" : "gone")))).toEqual({
      ok: false,
      why: "exited as soon as it started",
      lastWords: "No conversation found with session ID: 162f2800",
    });
  });

  test("never past its shell: not up", async () => {
    expect(await confirmAgentStarted(fake(() => "starting"), { withinMs: 4_000 })).toMatchObject({ ok: false, why: "never started: its tab is still at the shell" });
  });

  test("a tab conch can't read is not called dead", async () => {
    expect(await confirmAgentStarted(fake(() => "unknown"))).toEqual({ ok: true, state: "unknown" });
  });
});

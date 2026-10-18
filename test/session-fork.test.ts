import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TabAgentState } from "../src/agent-alive.ts";
import { applyRuntimeControlMessage } from "../src/control-server.ts";
import type { PanelSessionState, SessionReview } from "../src/panel.ts";
import { awaitForkStart, forkRequest, inheritedState, pendingForkFor, type PendingFork } from "../src/session-fork.ts";
import { terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlMessage, validateControlResponse } from "../src/settings.ts";

// 2026-10-09, Tyler: "we should make it easier to fork sessions in app and have them bring over a snapshot of the current
// conch plugin review / deliverables that the last session had when u fork. (just did a bunch of forks but had to do it
// through terminal)".
const ID = "11111111-2222-4333-8444-555555555555";
const session = { sessionId: ID, backend: "claude" as const, cwd: "/Users/alex/acme-web" };

describe("starting a fork", () => {
  test("Claude Code's own fork of the same conversation, in the same folder with the same flags", () => {
    const fork = forkRequest({ ...session, claudeAccountId: "work" }, ["--dangerously-skip-permissions", "--resume", ID]);
    expect(fork.request).toMatchObject({ backend: "claude", resumeSessionId: ID, cwd: "/Users/alex/acme-web", claudeAccountId: "work" });
    expect(fork.request.options?.["fork-session"]).toBe(true);
  });

  test("a Codex session with Codex's own `codex fork <id>`", () => {
    const fork = forkRequest({ ...session, backend: "codex", codexAccountId: "work" }, ["resume", ID]);
    expect(fork.request).toMatchObject({ backend: "codex", resumeSessionId: ID, fork: true, codexAccountId: "work" });
    expect(fork.request.options?.["fork-session"]).toBeUndefined();
    expect(terminalSessionCommand({ ...fork.request, codexAccountId: undefined })).toContain(` fork '${ID}'`);
  });

  test("a Claude background job: its conversation, in conch's background host, saying its flags couldn't come", () => {
    const fork = forkRequest({ ...session, jobId: "f31f0d15", agentSessionId: ID, claudeAccountId: "work" }, []);
    expect(fork.request).toEqual({ backend: "claude", host: "background", resumeSessionId: ID, cwd: "/Users/alex/acme-web",
      claudeAccountId: "work", options: { "fork-session": true } });
    expect(fork.notCarriedOver).toEqual(["the flags it was started with (a background job's can't be read)"]);
  });

  test("the request names the session to fork, and nothing else", () => {
    expect(validateControlMessage({ kind: "session-fork", sessionId: ID })).toEqual({ ok: true, value: { kind: "session-fork", sessionId: ID } });
    // Checked as session-close's is; an id the daemon doesn't hold is refused there ("session is not live").
    expect(validateControlMessage({ kind: "session-fork" }).ok).toBe(false);
    expect(validateControlMessage({ kind: "session-fork", sessionId: "" }).ok).toBe(false);
  });
});

describe("recognising the fork when it appears", () => {
  const pending: PendingFork[] = [{ parentId: ID, conversationId: ID, label: "Landing page hero", at: 1_000_000 }];
  const child = { sessionId: "99999999-2222-4333-8444-555555555555", startedAt: 1_002_000 };

  test("a process resuming that conversation with --fork-session, started after the fork was asked for", () => {
    expect(pendingForkFor(child, ["--resume", ID, "--fork-session"], pending)).toBe(pending[0]);
    expect(pendingForkFor(child, ["-r", ID, "--fork-session"], pending)).toBe(pending[0]);
  });

  test("a Codex fork, `codex fork <id>`, after any global flags", () => {
    expect(pendingForkFor(child, ["--dangerously-bypass-approvals-and-sandbox", "fork", ID, "-c", "model=x"], pending)).toBe(pending[0]);
    expect(pendingForkFor(child, ["resume", ID], pending)).toBeUndefined();
  });

  test("not without --fork-session, not another conversation, not one started before, and never the original", () => {
    expect(pendingForkFor(child, ["--resume", ID], pending)).toBeUndefined();
    expect(pendingForkFor(child, ["--resume", "other", "--fork-session"], pending)).toBeUndefined();
    expect(pendingForkFor({ ...child, startedAt: 900_000 }, ["--resume", ID, "--fork-session"], pending)).toBeUndefined();
    expect(pendingForkFor({ sessionId: ID, startedAt: 1_002_000 }, ["--resume", ID, "--fork-session"], pending)).toBeUndefined();
    expect(pendingForkFor(child, null, pending)).toBeUndefined();
  });
});

describe("the fork holds its parent's deliverables", () => {
  const review = (id: string, extra: Partial<SessionReview> = {}): SessionReview =>
    ({ id, summary: `result ${id}`, at: 1, link: `/Users/alex/acme-web/${id}.png`, ...extra }) as SessionReview;
  const parent: PanelSessionState = {
    label: "Landing page hero", status: "waiting", at: 5,
    reviews: [review("a", { viewedAt: 3 }), review("b")], review: review("b"), versions: { hero: 2 },
  };

  test("the same deliverables and versions, looked at already, the parent's current one current", () => {
    const state = inheritedState(parent, undefined, "Landing page hero", 42)!;
    expect(state.reviews?.map((held) => [held.id, held.viewedAt])).toEqual([["a", 3], ["b", 42]]);
    expect(state.review?.id).toBe("b");
    expect(state.versions).toEqual({ hero: 2 });
    // No latch of its own: the oldest truth, so the registry decides its status.
    expect(state).toMatchObject({ label: "Landing page hero", status: "waiting", at: 0 });
  });

  test("a fork that already has a state keeps it, and a parent holding nothing gives nothing", () => {
    const own: PanelSessionState = { label: "Landing page hero · fork", status: "working", at: 9 };
    expect(inheritedState(parent, own, "x", 42)).toMatchObject({ label: "Landing page hero · fork", status: "working", at: 9 });
    expect(inheritedState({ label: "x", status: "waiting", at: 1 }, undefined, "x", 42)).toBeUndefined();
    expect(inheritedState(undefined, undefined, "x", 42)).toBeUndefined();
  });
});

/**
 * 2026-10-18 review: an agent asked to fork had no conch tool for it, ran `conch start --resume … --fork-session`, was told
 * "opened" for a Claude Code that died at once, and told Tyler the fork was open. An agent's fork (`conch_fork`) goes
 * through the daemon's own and waits until conch has seen it running, or says why it didn't start.
 */
describe("an agent's fork, waited on", () => {
  test("the request may carry the fork's label and ask to wait; the reply names the fork once it is seen", async () => {
    expect(validateControlMessage({ kind: "session-fork", sessionId: ID, label: "  Marketing pass ", wait: true }))
      .toEqual({ ok: true, value: { kind: "session-fork", sessionId: ID, label: "Marketing pass", wait: true } });
    expect(validateControlMessage({ kind: "session-fork", sessionId: ID, wait: false }).ok).toBe(false);
    expect(validateControlMessage({ kind: "session-fork", sessionId: ID, label: 7 }).ok).toBe(false);
    expect(validateControlResponse({ kind: "session-forked", sessionId: ID, forkId: "99999999-2222-4333-8444-555555555555", label: "Marketing pass" }))
      .toEqual({ ok: true, value: { kind: "session-forked", sessionId: ID, forkId: "99999999-2222-4333-8444-555555555555", label: "Marketing pass" } });
    expect(validateControlResponse({ kind: "session-forked", sessionId: ID, running: "Terminal (ttys012)" }))
      .toEqual({ ok: true, value: { kind: "session-forked", sessionId: ID, running: "Terminal (ttys012)" } });
    expect(validateControlResponse({ kind: "session-forked", sessionId: ID, running: 3 }).ok).toBe(false);

    const asked: unknown[] = [];
    const reply = await applyRuntimeControlMessage({ kind: "session-fork", sessionId: ID, label: "Marketing pass", wait: true }, {
      listResumable: () => ({ sessions: [], complete: true }) as never,
      start: () => undefined,
      close: () => undefined,
      report: () => undefined,
      async fork(sessionId, options) {
        asked.push({ sessionId, options });
        return { notCarriedOver: [], forkId: "fork-1", label: "Marketing pass" };
      },
    });
    expect(asked).toEqual([{ sessionId: ID, options: { label: "Marketing pass", wait: true } }]);
    expect(reply).toEqual({ kind: "session-forked", sessionId: ID, forkId: "fork-1", label: "Marketing pass" });
  });

  /** A watch on a fake clock: each sleep moves it on, and the tab says what `states` says at that time. */
  function watch(states: (at: number) => TabAgentState, adoptAt?: number, words = "No conversation found with session ID: 162f2800") {
    let clock = 0;
    let adopt: ((seen: { forkId: string; label: string }) => void) | undefined;
    const adopted = new Promise<{ forkId: string; label: string }>((resolve) => { adopt = resolve; });
    const looks: number[] = [];
    return {
      looks,
      watch: {
        adopted,
        state: async () => states(clock),
        lastWords: async () => words,
        look: () => looks.push(clock),
        where: "Terminal (ttys012)",
        async sleep(ms: number) {
          clock += ms;
          if (adoptAt !== undefined && clock >= adoptAt) adopt?.({ forkId: "fork-1", label: "Landing page hero · fork" });
        },
        now: () => clock,
      },
    };
  }

  test("adopted: the fork's id and label", async () => {
    const { watch: w, looks } = watch(() => "running", 3_000);
    expect(await awaitForkStart(w)).toEqual({ forkId: "fork-1", label: "Landing page hero · fork" });
    // It asked for registry reads while it waited, so adoption isn't left to the 20 s timer.
    expect(looks.length).toBeGreaterThan(0);
  });

  test("the agent exits at once: the error says so, with what its tab showed", async () => {
    const { watch: w } = watch((at) => (at < 2_000 ? "running" : "gone"));
    await expect(awaitForkStart(w)).rejects.toThrow(
      "the fork's agent exited as soon as it started, in Terminal (ttys012). Its tab shows:\nNo conversation found with session ID: 162f2800",
    );
  });

  test("a tab gone before conch saw its agent gets a moment's grace, then counts", async () => {
    const { watch: w } = watch(() => "gone");
    const started = Date.now();
    await expect(awaitForkStart(w, { graceMs: 6_000 })).rejects.toThrow("exited as soon as it started");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("running but not yet seen by the deadline: where it runs, not an error", async () => {
    const { watch: w } = watch(() => "running");
    expect(await awaitForkStart(w, { withinMs: 10_000 })).toEqual({ running: "Terminal (ttys012)" });
  });

  test("a tab still at its shell when the wait runs out never started its agent", async () => {
    const { watch: w } = watch(() => "starting", undefined, "cd: no such file or directory: /Users/alex/gone");
    await expect(awaitForkStart(w, { withinMs: 10_000 })).rejects.toThrow("the fork's tab never started its agent, in Terminal (ttys012). Its tab shows:\ncd: no such file");
  });

  test("the daemon's fork waits on these, and adoption tells the waiter its label", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");
    const fork = daemon.slice(daemon.indexOf("const forkLiveSession = async ("), daemon.indexOf("const adoptForks = async"));
    expect(fork).toContain("await awaitForkStart({");
    expect(fork).toContain("tabAgentState(await terminalTabCommands(tty), executable)");
    expect(fork).toContain("lastTabLines(await readTerminalTab(tty))");
    const adopt = daemon.slice(daemon.indexOf("const adoptForks = async"));
    expect(adopt).toContain("match.forkLabel ?? `${match.label} · fork`");
    expect(adopt).toContain("forkWaiters.get(match)?.({ forkId: session.sessionId, label: forkLabel });");
  });
});

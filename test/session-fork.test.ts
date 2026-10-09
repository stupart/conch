import { describe, expect, test } from "bun:test";
import type { PanelSessionState, SessionReview } from "../src/panel.ts";
import { forkRequest, inheritedState, pendingForkFor, type PendingFork } from "../src/session-fork.ts";
import { validateControlMessage } from "../src/settings.ts";

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

  test("not a Codex session, nor a Claude background job, which conch can't relaunch yet", () => {
    expect(() => forkRequest({ ...session, backend: "codex" }, [])).toThrow("Codex sessions can't be forked");
    expect(() => forkRequest({ ...session, jobId: "f31f0d15" }, [])).toThrow("background job can't be forked");
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

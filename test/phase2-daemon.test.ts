import { describe, expect, test } from "bun:test";
import {
  choiceReplyForConversation,
  dispatchRuntimeControlMessage,
  injectTimeoutFor,
  shouldReportMissingCodexPid,
} from "../src/daemon.ts";
import { buildConversation } from "../src/conversation.ts";
import { buildPublishedState, type PanelModel } from "../src/panel.ts";
import {
  isControlMessageCandidate,
  validateControlMessage,
  validateControlResponse,
} from "../src/settings.ts";

describe("Phase 2 runtime controls", () => {
  test("validates the app wire shapes and rejects hostile variants", () => {
    for (const message of [
      { kind: "resumable" },
      { kind: "resumable", query: "conch", limit: 25 },
      { kind: "session-start", backend: "claude" },
      { kind: "session-start", backend: "codex", resumeSessionId: "thread-1", cwd: "/tmp/repo" },
      { kind: "session-close", sessionId: "session-1" },
      { kind: "app-error", source: "ios", operation: "send", message: "offline", state: { connected: false } },
      { kind: "app-error", source: "mac", operation: "clipboard", message: "fallback", sessionId: "session-1", state: {} },
    ]) {
      expect(isControlMessageCandidate(message)).toBe(true);
      expect(validateControlMessage(message).ok).toBe(true);
    }
    for (const message of [
      { kind: "resumable", query: 42 },
      { kind: "resumable", limit: 0 },
      { kind: "resumable", limit: 501 },
      { kind: "session-start", backend: "other" },
      { kind: "session-start", backend: "claude", cwd: "relative" },
      { kind: "session-close", sessionId: "" },
      { kind: "app-error", source: "daemon", operation: "send", message: "no", state: {} },
      { kind: "app-error", source: "ios", operation: "", message: "no", state: [] },
    ]) expect(validateControlMessage(message).ok).toBe(false);
  });

  test("acks start, clean close, and recorded error only after their side effect resolves", async () => {
    const calls: string[] = [];
    expect(await dispatchRuntimeControlMessage(
      { kind: "session-start", backend: "codex", resumeSessionId: "thread-1" },
      {
        listResumable: () => ({ sessions: [], complete: true }),
        start: (message) => { calls.push(`start:${message.resumeSessionId}`); },
        close: () => {},
        report: () => {},
      },
    )).toEqual({ handled: true, response: { kind: "session-started", backend: "codex", resumed: true } });

    let release!: () => void;
    const closed = dispatchRuntimeControlMessage(
      { kind: "session-close", sessionId: "session-1" },
      {
        listResumable: () => ({ sessions: [], complete: true }),
        start: () => {},
        close: () => new Promise<void>((resolve) => { release = resolve; }),
        report: () => {},
      },
    );
    let settled = false;
    void closed.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await closed).toEqual({ handled: true, response: { kind: "session-closed", sessionId: "session-1" } });

    expect(await dispatchRuntimeControlMessage(
      { kind: "app-error", source: "mac", operation: "send", message: "failed", state: { draft: 4 } },
      {
        listResumable: () => ({ sessions: [], complete: true }),
        start: () => {},
        close: () => {},
        report: (message) => { calls.push(`error:${message.source}`); },
      },
    )).toEqual({ handled: true, response: { kind: "app-error-ack" } });
    expect(calls).toEqual(["start:thread-1", "error:mac"]);
  });

  test("returns resumable rows and completeness through runtime dispatch", async () => {
    const sessions = [{
      sessionId: "thread-1",
      backend: "codex" as const,
      label: "Relay work",
      cwd: "/tmp/conch",
      updatedAt: 1_786_000_000_000,
    }];
    expect(await dispatchRuntimeControlMessage(
      { kind: "resumable", query: "relay", limit: 20 },
      {
        listResumable: (message) => {
          expect(message).toEqual({ kind: "resumable", query: "relay", limit: 20 });
          return { sessions, complete: false };
        },
        start: () => {},
        close: () => {},
        report: () => {},
      },
    )).toEqual({
      handled: true,
      response: { kind: "resumable", sessions, complete: false },
    });
  });

  test("lifecycle acknowledgements round-trip through the control client validator", () => {
    expect(validateControlResponse({ kind: "session-started", backend: "claude", resumed: false }).ok).toBe(true);
    expect(validateControlResponse({ kind: "session-closed", sessionId: "s1" }).ok).toBe(true);
    expect(validateControlResponse({ kind: "app-error-ack" }).ok).toBe(true);
    expect(validateControlResponse({
      kind: "resumable",
      sessions: [{
        sessionId: "s1",
        backend: "claude",
        label: "Conch",
        cwd: "/tmp/conch",
        updatedAt: 1_786_000_000_000,
      }],
      complete: true,
    }).ok).toBe(true);
  });

  test("the phone waits long enough for native Terminal lifecycle work", () => {
    expect(injectTimeoutFor(JSON.stringify({ kind: "session-start" }))).toBe(8_000);
    expect(injectTimeoutFor(JSON.stringify({ kind: "session-close" }))).toBe(12_000);
  });
});

describe("Phase 2 session metadata", () => {
  test("a Codex pid failure reports once until routing recovers", () => {
    const reported = new Set<string>();
    const missing = { sessionId: "c1", backend: "codex" as const, pid: 0 };
    expect(shouldReportMissingCodexPid(missing, reported)).toBe(true);
    expect(shouldReportMissingCodexPid(missing, reported)).toBe(false);
    expect(shouldReportMissingCodexPid({ ...missing, pid: 42 }, reported)).toBe(false);
    expect(shouldReportMissingCodexPid(missing, reported)).toBe(true);
    expect(shouldReportMissingCodexPid({ sessionId: "a", backend: "claude", pid: 0 }, reported)).toBe(false);
  });

  test("published rows carry a proportional context numerator and denominator", () => {
    const model: PanelModel = {
      rows: [{
        sessionId: "s1", label: "repo", backend: "claude", status: "waiting",
        paused: false, muted: false, liveGlyph: null, active: false, navSelected: false,
      }],
      mode: { muted: false, paused: false, holding: 0 },
      live: { state: "idle", label: "", partial: "" },
      reply: null,
      panelOpen: true,
    };
    const published = buildPublishedState(model, new Map(), new Set(), 1, {
      contextForSessionId: () => ({ usedTokens: 160_000, limitTokens: 200_000 }),
    });
    expect(published.rows[0]?.context).toEqual({ usedTokens: 160_000, limitTokens: 200_000 });
  });
});

describe("question replies", () => {
  test("voice ordinals become the exact option label while free text remains unchanged", () => {
    const conversation = buildConversation("s1", [JSON.stringify({
      type: "assistant",
      uuid: "a1",
      message: { content: [{
        type: "tool_use",
        id: "ask1",
        name: "AskUserQuestion",
        input: { questions: [{
          header: "Destination",
          question: "Where should it go?",
          options: [{ label: "Linear" }, { label: "Export PDF" }],
          multiSelect: false,
        }] },
      }] },
    })], "claude");
    expect(choiceReplyForConversation("the second one", conversation)).toBe("Export PDF");
    expect(choiceReplyForConversation("what do you recommend", conversation)).toBe("what do you recommend");
  });

  test("Codex request_user_input becomes a canonical answerable question", () => {
    const conversation = buildConversation("c1", [JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "q1",
        call_id: "call-q1",
        name: "request_user_input",
        input: JSON.stringify({ questions: [{
          header: "Format",
          question: "Which format?",
          options: [{ label: "Markdown" }, { label: "PDF" }],
        }] }),
      },
    })], "codex");
    const item = conversation.items["tool:call-q1"];
    expect(item?.tool?.kind).toBe("question");
    expect(item?.question?.options.map((option) => option.label)).toEqual(["Markdown", "PDF"]);
    expect(choiceReplyForConversation("PDF", conversation)).toBe("PDF");
  });
});

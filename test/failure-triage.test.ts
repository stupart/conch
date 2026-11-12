import { describe, expect, test } from "bun:test";
import { failureIdentity } from "../src/failure-signature.ts";
import { ALERT_AT_COUNT, alertWorthy, failureBlame, failureTool, notAFailure, retiredByRule, sendFailureMessage } from "../src/failure-triage.ts";

// Whose failure a ticket is (failure-triage.ts). Every message here is made up, in the shape conch's tools answer.

const blame = (origin: "daemon" | "mac" | "mcp", operation: string, message: string) => failureBlame(failureIdentity(origin, operation, message));

describe("whose failure it is", () => {
  test("an argument a tool rejected, or a refusal, is the agent's call", () => {
    expect(blame("mcp", "review_to_front input-error", "unknown argument \"colour\"")).toBe("agent");
    expect(blame("mcp", "conch_transcript_tail input-error", "no live session matching \"Some name\"")).toBe("agent");
    expect(blame("mcp", "conch_mode refused", "refused: that session isn't yours to change")).toBe("agent");
  });

  test("a tool that failed because the agent's target wasn't there, or it was over a stated limit, is the agent's", () => {
    for (const message of [
      "failed: nothing on the page matches \"Sign up\"",
      "failed: nothing you can click says \"Continue\"",
      "failed: \"div>>a\" isn't a valid CSS selector",
      "failed: li \"Plans\" isn't a field you can type in",
      "failed: there's no e12 on this page; read it again (browser_read) for fresh refs",
      "failed: e4 is gone from the page (it changed); read it again for fresh refs",
      "failed: this session has 6 tabs open; close one (browser_close) first",
      "failed: the words \"Pricing\" aren't visible on the page.",
      "failed: the words \"Pricing\" aren't on the page as written; it has \"Prices\".",
      "failed: the page didn't load: The certificate for this server is invalid.",
      "failed: nothing removed: \"a session\" holds no deliverable with artifact hero",
      "failed: conch's Mac app isn't running, so its browser isn't open; open it and try again",
    ]) {
      expect([message, blame("mcp", "browser_click failed", message)]).toEqual([message, "agent"]);
    }
  });

  test("a tool that failed any other way is conch's, until a rule says otherwise", () => {
    expect(blame("mcp", "browser_click failed", "failed: conch's daemon didn't answer the browser (read ECONNRESET)")).toBe("conch");
    expect(blame("mcp", "conch_capture failed", "failed: the target is on the page but conch couldn't bring it into view.")).toBe("conch");
    expect(blame("mcp", "browser_read failed", "failed: conch daemon is not running, so its browser isn't either")).toBe("conch");
  });

  test("everything the daemon, the apps and the hook record is conch's", () => {
    expect(blame("daemon", "inject", "Typed, but the session never took it.")).toBe("conch");
    // Even words an MCP rule matches: only an agent's call can be the agent's.
    expect(blame("mac", "open-deliverable", "nothing on the page matches \"x\"")).toBe("conch");
  });

  test("an MCP ticket's tool is its operation's first word; no other origin has one", () => {
    expect(failureTool("mcp", "browser_click failed")).toBe("browser_click");
    expect(failureTool("daemon", "inject")).toBeUndefined();
  });
});

describe("what is worth an alert", () => {
  const ticket = { blame: "conch" as const, status: "open", operation: "open-deliverable", count: 1 };

  test("a delivery that failed, one that keeps happening, or one that came back after its fix", () => {
    expect(alertWorthy(ticket)).toBe(false);
    expect(alertWorthy({ ...ticket, operation: "inject" })).toBe(true);
    expect(alertWorthy({ ...ticket, operation: "permission-answer" })).toBe(true);
    expect(alertWorthy({ ...ticket, count: ALERT_AT_COUNT })).toBe(true);
    expect(alertWorthy({ ...ticket, reopened: 1 })).toBe(true);
  });

  test("never an agent's call, a quiet ticket, or one put away", () => {
    const loud = { ...ticket, operation: "inject", count: 40 };
    expect(alertWorthy({ ...loud, blame: "agent" })).toBe(false);
    expect(alertWorthy({ ...loud, staleAt: 1 })).toBe(false);
    expect(alertWorthy({ ...loud, status: "ignored" })).toBe(false);
    expect(alertWorthy({ ...loud, status: "fixing" })).toBe(false);
  });
});

describe("what is no failure at all", () => {
  const generic = "Could not deliver the prompt. Review the recovered draft before retrying.";

  test("a send that went in, or that conch declined on purpose and said why, is passed over", () => {
    for (const code of ["transcript-advanced", "provider-turn-started", "prompt-new-session", "session-awaiting-answer", "session-awaiting-permission"]) {
      expect([code, notAFailure({ operation: "inject", message: generic, state: { code } })]).toEqual([code, true]);
    }
    // One that didn't go, for a reason conch could do better on, is filed.
    for (const code of ["clipboard-unpreservable", "delivery-unconfirmed", "front-window-changed", undefined]) {
      expect([code, notAFailure({ operation: "inject", message: generic, state: code ? { code } : {} })]).toEqual([code, false]);
    }
  });

  test("a card answered after its prompt had gone is passed over; one conch can't answer at all is filed", () => {
    expect(notAFailure({ operation: "permission-answer", message: "Could not answer the permission: that permission is no longer waiting" })).toBe(true);
    expect(notAFailure({ operation: "question-answer", message: "Could not answer the question: that question is no longer the one waiting" })).toBe(true);
    expect(notAFailure({ operation: "permission-answer", message: "Could not answer the permission: conch can't answer this agent's permission prompt; answer it in the terminal" })).toBe(false);
    expect(notAFailure({ operation: "permission-answer", message: "Could not answer the permission: could not reach the session's window" })).toBe(false);
  });

  test("a close that stopped to ask, and a model change the session's state refused, are passed over", () => {
    expect(notAFailure({ operation: "session-close", message: "Claude Code is asking before it stops 2 background tasks: \"a\" and \"b\". Close again to stop them and exit." })).toBe(true);
    expect(notAFailure({ operation: "session-close", message: "Ctrl-D was sent, but the background session is still running after 15 s." })).toBe(false);
    expect(notAFailure({ operation: "session-settings", message: "Could not change \"x\" to high: the session is working; change it when its turn is over" })).toBe(true);
    // conch offered a model the session doesn't have: that one is filed.
    expect(notAFailure({ operation: "session-settings", message: "Could not change \"x\" to nonesuch: \"nonesuch\" is not in this session's model list (A, B)" })).toBe(false);
  });

  test("a ticket filed before its kind was passed over is retired, by its example, even with its state cut short", () => {
    expect(retiredByRule({ operation: "inject", example: { message: "The Return was lost; the prompt went in after 1 re-send.", state: "{\"chars\":12,\"code\":\"transcript-advanced\",\"steps\":[\"…" } })).toBe(true);
    expect(retiredByRule({ operation: "inject", example: { message: "Typed, but the session never took it.", state: "{\"code\":\"delivery-unconfirmed\"}" } })).toBe(false);
    expect(retiredByRule({ operation: "permission-answer", example: { message: "Could not answer the permission: that permission is no longer waiting" } })).toBe(true);
  });

  test("the generic send failure is filed under its cause, so each cause is a ticket of its own", () => {
    const one = failureIdentity("daemon", "inject", sendFailureMessage(generic, "clipboard-unpreservable"));
    const two = failureIdentity("daemon", "inject", sendFailureMessage(generic, "hosted-session-not-open"));
    expect(one.title).toBe("Could not deliver the prompt (clipboard-unpreservable).");
    expect(one.key).not.toBe(two.key);
    expect(sendFailureMessage(generic, undefined)).toBe(generic);
    expect(sendFailureMessage("Typed, but the session never took it.", "delivery-unconfirmed")).toBe("Typed, but the session never took it.");
    expect(sendFailureMessage(generic, "Not A Code!")).toBe(generic);
  });
});

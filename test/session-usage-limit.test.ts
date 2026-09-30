import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sessionUsageLimitFromLines as limit } from "../src/session-usage-limit.ts";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";

const timestamp = "2026-09-30T01:00:00Z";
const text = "You've hit your weekly limit · resets Oct 3 at 9pm (Australia/Sydney)";
const claude = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "assistant", timestamp, error: "rate_limit", isApiErrorMessage: true,
  message: { model: "<synthetic>", content: [{ type: "text", text }] }, ...over,
});
const codex = (payload: Record<string, unknown>) => JSON.stringify({ type: "event_msg", timestamp, payload });

test("Claude's recorded quota failure survives metadata and a torn final line", () => {
  expect(limit([claude(), '{"type":"progress"}', "{torn"], "claude")).toBe(text);
  expect(limit([claude({ message: {} })], "claude")).toBe("Usage limit reached");
});

test("ordinary chat, quoted errors and tool output cannot mark a session exhausted", () => {
  expect(limit([claude({ type: "user" })], "claude")).toBeUndefined();
  expect(limit([claude({ error: undefined, isApiErrorMessage: false,
    message: { model: "claude-opus", content: [{ type: "text", text }] } })], "claude")).toBeUndefined();
  expect(limit([codex({ type: "user_message", message: text })], "codex")).toBeUndefined();
  expect(limit([codex({ type: "exec_command_end", output: text })], "codex")).toBeUndefined();
});

test("a successful Claude response clears the limit; a retry prompt alone does not", () => {
  expect(limit([claude(), JSON.stringify({ type: "user", message: { content: "try again" } })], "claude")).toBe(text);
  expect(limit([claude(), claude({ error: undefined, isApiErrorMessage: false,
    message: { model: "claude-opus", content: [{ type: "tool_use", name: "Read" }] } })], "claude")).toBeUndefined();
  expect(limit([claude(), claude({ error: "authentication_error", message: { content: "Sign in again" } })], "claude")).toBeUndefined();
});

test("inherited errors do not exhaust a new account's window", () => {
  const startedAt = Date.parse(timestamp) + 1;
  expect(limit([claude()], "claude", { sessionId: "new-window", startedAt })).toBeUndefined();
  expect(limit([claude({ timestamp: new Date(startedAt + 1).toISOString() })], "claude",
    { sessionId: "new-window", startedAt })).toBe(text);
});

test("Codex's failed turn reports its usage limit and clears on a successful turn or reply", () => {
  const failed = codex({ type: "task_complete", error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } });
  expect(limit([failed], "codex")).toBe("You've hit your usage limit.");
  expect(limit([codex({ type: "task_complete", error: { codex_error_info: "usage_limit_exceeded" } })], "codex")).toBe("Usage limit reached");
  expect(limit([codex({ type: "task_complete", error: { message: text } })], "codex")).toBe(text);
  expect(limit([failed, codex({ type: "task_complete", last_agent_message: "Done" })], "codex")).toBeUndefined();
  expect(limit([failed, codex({ type: "agent_message", message: "Working again" })], "codex")).toBeUndefined();
  expect(limit([failed, codex({ type: "task_complete", error: { message: "Authentication failed" } })], "codex")).toBeUndefined();
});

test("two windows sharing a transcript use their own branch, and ambiguity stays unknown", () => {
  const lines = [
    JSON.stringify({ type: "user", uuid: "root", timestamp }),
    JSON.stringify({ type: "last-prompt", leafUuid: "root" }),
    JSON.stringify({ type: "bridge-session", bridgeSessionId: "cse_limited" }),
    claude({ uuid: "limited", parentUuid: "root" }),
    JSON.stringify({ type: "last-prompt", leafUuid: "root" }),
    JSON.stringify({ type: "bridge-session", bridgeSessionId: "cse_available" }),
    claude({ uuid: "available", parentUuid: "root", error: undefined, isApiErrorMessage: false,
      message: { model: "claude-opus", content: [{ type: "text", text: "Resumed" }] } }),
  ];
  expect(limit(lines, "claude", { sessionId: "shared#1", bridgeSessionId: "session_limited" })).toBe(text);
  expect(limit(lines, "claude", { sessionId: "shared#2", bridgeSessionId: "session_available" })).toBeUndefined();
  expect(limit(lines, "claude", { sessionId: "shared#3" })).toBeUndefined();
});

test("publication preserves the failure without changing session status, muting, or deliverables", () => {
  const model = buildPanelModel({
    sessions: [{ sessionId: "limited", name: "Limited" }, { sessionId: "available", name: "Available" }],
    sessionStates: new Map([["limited", { label: "Limited", status: "waiting", at: 1,
      review: { summary: "Existing work", at: 1, id: "review" } }]]),
    pausedSessionIds: new Set(), live: { state: "idle", label: "", partial: "" },
    mode: { muted: false, paused: false, holding: 0 }, activeSessionId: null, navSelectedId: null,
    usageLimitBySessionId: new Map([["limited", text]]),
  });
  const published = buildPublishedState("test", model, new Map(), new Set(), 1);
  expect(published.rows.find(row => row.id === "limited")).toMatchObject({
    usageLimit: text, status: "waiting", paused: false, review: { summary: "Existing work" },
  });
  expect(published.rows.find(row => row.id === "available")).not.toHaveProperty("usageLimit");
});

test("both apps show a distinct limit glyph and subdued name, keeping the row selectable", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const mac = read("mac-app/conch-mac/DashboardView.swift");
  const phone = read("mobile/conch-ios/conch-ios/LedgerView.swift");
  const phoneModels = read("mobile/conch-ios/conch-ios/Models.swift");
  expect(mac).toContain('return "hourglass.circle"');
  expect(phoneModels).toContain('case .usageLimit: "hourglass.circle"');
  expect(mac).toContain("row.usageLimit == nil ? ConchPalette.textPrimary : ConchPalette.textDim");
  expect(phone).toContain("row.usageLimit == nil ? Palette.textPrimary : Palette.textDim");
  for (const source of [mac, phoneModels]) {
    expect(source).toContain('row.usageLimit != nil, row.live != "listening", row.live != "recording"');
    expect(source).toContain('"Usage limit reached"');
    expect(source).not.toContain(".disabled(row.usageLimit");
  }
});

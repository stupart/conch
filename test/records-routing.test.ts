import { expect, test } from "bun:test";
import { recordSessionFor } from "../src/records-routing.ts";
import { recordKey } from "../src/records-types.ts";

test("two window routes for one native session share a record identity", () => {
  const first = recordSessionFor("device", { sessionId: "native#1", agentSessionId: "native", backend: "claude" }, { sessionId: "native#1" });
  const second = recordSessionFor("device", { sessionId: "native#2", agentSessionId: "native", backend: "claude" }, { sessionId: "native#2" });
  expect(first?.id).toBe(recordKey("device", "claude", "native"));
  expect(second?.id).toBe(first?.id);
});

test("captured receipt identity wins over a later window mapping", () => {
  const found = recordSessionFor("device", { sessionId: "native#1", agentSessionId: "new", backend: "claude" },
    { sessionId: "native#1", nativeId: "original", provider: "codex" });
  expect(found?.id).toBe(recordKey("device", "codex", "original"));
  expect(recordSessionFor("device", undefined, { sessionId: "unknown" })).toBeUndefined();
  expect(recordSessionFor("device", undefined, { sessionId: "native#1", provider: "claude" })).toBeUndefined();
});

test("Claude sidechains use the same parent-scoped identity as discovery", () => {
  const found = recordSessionFor("device", { sessionId: "agent:short", parentSessionId: "parent", backend: "claude",
    transcriptPath: "/fixture/projects/project/parent/subagents/agent-short.jsonl" }, { sessionId: "agent:short" });
  expect(found?.nativeId).toBe("parent/agent-short");
  expect(found?.parentNativeId).toBe("parent");
});

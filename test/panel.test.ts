import { expect, test, describe } from "bun:test";
import { reconcileStatus, registryToPanel } from "../src/panel.ts";

describe("registryToPanel — maps Claude Code's status vocabulary", () => {
  test("idle → waiting (turn done)", () => expect(registryToPanel("idle")).toBe("waiting"));
  test("busy/running/shell → working", () => {
    expect(registryToPanel("busy")).toBe("working");
    expect(registryToPanel("running")).toBe("working");
    expect(registryToPanel("shell")).toBe("working");
  });
  test("waiting/blocked → needs (blocked on input)", () => {
    expect(registryToPanel("waiting")).toBe("needs");
    expect(registryToPanel("blocked")).toBe("needs");
  });
  test("unknown/undefined → null (defer to the latch)", () => {
    expect(registryToPanel("something-new")).toBeNull();
    expect(registryToPanel(undefined)).toBeNull();
  });
});

describe("reconcileStatus — BUG A: newer signal wins, so the panel never sticks", () => {
  test("stale 'waiting' latch is overridden by a NEWER busy registry (the core bug)", () => {
    // Prior Stop latched "waiting" at 1000; session resumed (registry busy at 2000)
    // without firing UserPromptSubmit. Registry is newer → working.
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 2000 }, { status: "waiting", at: 1000 })).toBe("working");
  });

  test("a just-received 'working' latch wins over an older idle registry (no flicker)", () => {
    // You just submitted (working latched at 2000); registry hasn't flipped yet (idle at 1000).
    expect(reconcileStatus({ status: "idle", statusUpdatedAt: 1000 }, { status: "working", at: 2000 })).toBe("working");
  });

  test("a plain busy session with no latch shows working — never nags", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 1000 }, undefined)).toBe("working");
  });

  test("registry 'waiting'/'blocked' surfaces as needs even with no latch", () => {
    expect(reconcileStatus({ status: "waiting", statusUpdatedAt: 1000 }, undefined)).toBe("needs");
    expect(reconcileStatus({ status: "blocked", statusUpdatedAt: 1000 }, undefined)).toBe("needs");
  });

  test("idle registry (newer than latch) shows waiting", () => {
    expect(reconcileStatus({ status: "idle", statusUpdatedAt: 2000 }, { status: "working", at: 1000 })).toBe("waiting");
  });

  test("a fresh 'needs' latch wins over an older registry status", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 1500 }, { status: "needs", at: 2000 })).toBe("needs");
  });

  test("needs auto-clears once the session moves on (registry status is newer)", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 3000 }, { status: "needs", at: 2000 })).toBe("working");
  });

  test("tie (equal timestamps) goes to the latch", () => {
    expect(reconcileStatus({ status: "busy", statusUpdatedAt: 2000 }, { status: "needs", at: 2000 })).toBe("needs");
  });

  test("no registry status falls back to the latched value", () => {
    expect(reconcileStatus({}, { status: "working", at: 1000 })).toBe("working");
  });

  test("no registry status and no latch → null (dim idle)", () => {
    expect(reconcileStatus({}, undefined)).toBeNull();
  });
});

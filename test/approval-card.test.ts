import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPanelModel, buildPublishedState } from "../src/panel.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";

/**
 * A permission prompt ("confirm") showed only as the red needs mark: the Mac had nothing to
 * answer it with. Tyler: "it was a confirm thing but it wasn't surfacing in conch".
 */
describe("the permission prompt on the published row", () => {
  const publish = (registry: string, asked: string[], approval = { id: "tu_1", name: "Bash", summary: "git push origin main" } as any) => {
    const model = buildPanelModel({
      sessions: [{ sessionId: "s", name: "S", status: registry, statusUpdatedAt: 1_000 }],
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      now: 10_000,
    });
    return buildPublishedState("device", model, new Map(), new Set(), 10_000, {
      transcriptPathForSessionId: () => "/t/s.jsonl",
      approvalForSessionId: (sessionId, path) => { asked.push(`${sessionId}@${path}`); return approval; },
    }).rows[0]!;
  };

  test("a row that needs you carries what it is asking", () => {
    // Claude Code's registry says `waiting` while its permission dialog is up.
    const asked: string[] = [];
    expect(publish("waiting", asked).approval).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
    expect(asked).toEqual(["s@/t/s.jsonl"]);
  });

  test("only a row that needs you is asked: no transcript read for the rest", () => {
    const asked: string[] = [];
    expect(publish("busy", asked).approval).toBeUndefined();
    expect(publish("idle", asked).approval).toBeUndefined();
    expect(asked).toEqual([]);
  });

  test("a prompt conch cannot press keys at says so", () => {
    expect(publish("waiting", [], { id: "c1", name: "shell", summary: "rm -rf build", answerable: false }).approval)
      .toEqual({ id: "c1", name: "shell", summary: "rm -rf build", answerable: false });
  });
});

describe("the approve field on the socket", () => {
  const event = (extra: Record<string, unknown>, type = "inject") =>
    validateSocketTurnEvent({ type, sessionId: "s1", label: "alpha", announce: "Allow Bash", ...extra });

  test("once, always or deny, naming the prompt", () => {
    for (const kind of ["once", "deny"]) expect(event({ approve: { kind, id: "tu_1" } }).ok).toBe(true);
    // Never "always": what it grants differs per tool and can't be shown before it's pressed.
    expect(event({ approve: { kind: "always", id: "tu_1" } }).ok).toBe(false);
  });

  test("anything else is refused before it can reach a keyboard", () => {
    for (const approve of [{ kind: "yes", id: "tu_1" }, { kind: "once" }, { kind: "once", id: "" }, "once", { kind: "once", id: "x".repeat(201) }]) {
      expect(event({ approve }).ok).toBe(false);
    }
    expect(event({ approve: { kind: "once", id: "tu_1" }, answers: [{ choices: [0] }] }).ok).toBe(false);
    expect(event({ approve: { kind: "once", id: "tu_1" } }, "wake").ok).toBe(false);
  });
});

describe("the Mac card, as source (conch-mac has no XCTest target)", () => {
  const stack = readFileSync(`${import.meta.dir}/../mac-app/conch-mac/ConversationStackView.swift`, "utf8");
  const dashboard = readFileSync(`${import.meta.dir}/../mac-app/conch-mac/DashboardView.swift`, "utf8");

  test("the conversation shows the prompt, with Allow / Deny where conch can answer", () => {
    expect(stack).toMatch(/if let approval \{\s*approvalCard\(approval\)\s*\}/);
    const card = stack.slice(stack.indexOf("private func approvalCard("), stack.indexOf("private func approvalButton("));
    expect(card.length).toBeGreaterThan(400);
    // The refusal comes first: no buttons for a dialog conch can't press, or with no terminal.
    const refuse = card.indexOf("if approval.answerable == false || onApprove == nil {");
    const buttons = card.indexOf('approvalButton("Allow", kind: "once", primary: true)');
    expect(refuse).toBeGreaterThan(-1);
    expect(card.indexOf("} else if let noTerminal {")).toBeGreaterThan(refuse);
    expect(buttons).toBeGreaterThan(card.indexOf("} else if let noTerminal {"));
    expect(card).toContain('approvalButton("Deny", kind: "deny", primary: false)');
    // Its second option grants something different per tool; a blind button would be a lie.
    expect(card).not.toContain('kind: "always"');
  });

  test("a button sends the answer with the prompt's id, through the one send door", () => {
    expect(dashboard).toMatch(/onApprove: \{ kind in\s*guard let approval = row\.approval else \{ return \}[\s\S]*?store\.send\(\.inject\([\s\S]*?approve: ConchApproval\(kind: kind, id: approval\.id\)/);
  });
});

describe("the phone card, as source (conch-ios has no XCTest target)", () => {
  const read = (name: string) => readFileSync(`${import.meta.dir}/../mobile/conch-ios/conch-ios/${name}`, "utf8");
  const session = read("SessionView.swift");

  test("the row's prompt is decoded, answerable included", () => {
    const models = read("Models.swift");
    expect(models).toContain("approval = try? c.decodeIfPresent(PendingApproval.self, forKey: .approval)");
    expect(models).toContain("var answerable: Bool?");
  });

  test("the session shows the prompt, with Allow / Deny where conch can answer", () => {
    expect(session).toMatch(/if let approval = row\?\.approval \{\s*ApprovalCard\(/);
    const card = session.slice(session.indexOf("private struct ApprovalCard: View {"), session.indexOf("private struct ReviewCard: View {"));
    expect(card.length).toBeGreaterThan(400);
    expect(card).toContain('Text("Wants to use \\(approval.name)")');
    const refuse = card.indexOf("if approval.answerable == false {");
    const noTerminal = card.indexOf("} else if let noTerminal {");
    const buttons = card.indexOf('button("Allow", kind: "once", primary: true)');
    expect(refuse).toBeGreaterThan(-1);
    expect(noTerminal).toBeGreaterThan(refuse);
    expect(buttons).toBeGreaterThan(noTerminal);
    expect(card).toContain('button("Deny", kind: "deny", primary: false)');
    expect(card).not.toContain('kind: "always"');
  });

  test("a button sends the answer with the prompt's id, and refuses a prompt conch can't press", () => {
    const approve = session.slice(session.indexOf("private func approve(_ kind: String) {"), session.indexOf("/// Whether the agent is still waiting on this exact question"));
    expect(approve).toContain("guard let approval = row?.approval, approval.answerable != false,");
    expect(approve).toContain("row?.noTerminal == nil, !optionReplyInFlight else { return }");
    expect(approve).toContain("approve: (kind: kind, id: approval.id)");
    expect(read("BridgeClient.swift")).toContain('if let approve { payload["approve"] = ["kind": approve.kind, "id": approve.id] }');
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The phone's transcript folds a run of consecutive tool steps into one line, with the rule
 * the Mac already uses (ConchDesign/ToolFolding, tested by `swift test`). What is pinned here
 * is the WIRING — CI never builds the iOS app, so a phone that quietly stopped folding, or
 * folded the one row a person must act on, would reach a device rather than a red check.
 */
const root = join(import.meta.dir, "..");
const stack = readFileSync(join(root, "mobile", "conch-ios", "conch-ios", "ConversationStack.swift"), "utf8");

/** A function's body: from its declaration to the first 4-space-indented close after it. */
function fn(name: string): string {
  const at = stack.indexOf(name);
  expect(at, `missing: ${name}`).toBeGreaterThan(-1);
  const end = stack.indexOf("\n    }\n", at);
  expect(end, `unterminated: ${name}`).toBeGreaterThan(at);
  const body = stack.slice(at, end);
  expect(body.length, `${name} is too short to be the function`).toBeGreaterThan(120);
  return body;
}

describe("the phone folds a run of tool steps", () => {
  test("the rule is the shared one, fed the wire's own stamps", () => {
    expect(stack).toContain("import ConchDesign");
    // `at` is passed raw. The rule converts milliseconds; a caller that converted first would
    // be a thousand times off once the rule started doing it.
    expect(fn("private func folds(in items: [ConversationItem]) -> FoldIndex {")).toContain(
      "ToolFolding.runs(for: items.map { (id: $0.id, isTool: foldable($0), at: $0.at) })",
    );
  });

  test("a question and a plan never fold", () => {
    const foldable = fn("private func foldable(_ item: ConversationItem) -> Bool {");
    expect(foldable).toContain('guard item.kind == "tool" else { return false }');
    expect(foldable).toContain("if let asked = item.question, !asked.options.isEmpty { return false }");
    expect(foldable).toContain("if let plan = item.plan, !plan.isEmpty { return false }");
  });

  test("both lists fold, so recorded history reads the same as the live window", () => {
    const body = stack.slice(stack.indexOf("var body: some View {"), stack.indexOf("private var historyHeader"));
    expect(body.length).toBeGreaterThan(400);
    expect(body).toContain("foldedRow(for: item, in: recorded, folds: recordedFolds).id(item.id)");
    expect(body).toContain("foldedRow(for: item, in: conversation.items, folds: liveFolds).id(item.id)");
    // No loop draws a bare row any more.
    expect(body).not.toContain("row(item).id(item.id)");
  });

  test("the fold draws the summary, hides its members, and opens on its own state", () => {
    const folded = fn("private func foldedRow(for item: ConversationItem, in items: [ConversationItem], folds: FoldIndex) -> some View {");
    expect(folded.length).toBeGreaterThan(600);
    expect(folded).toContain("Text(run.summary)");
    expect(folded).toContain("} else if folds.memberOf[item.id] != nil {\n            EmptyView()");
    // A run is named by its first step. Opening it must not also open that step's output.
    expect(folded).toContain("openRunIDs");
    expect(folded).not.toContain("expandedToolIDs");
  });
});

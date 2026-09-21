import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An answered question on the phone collapses to one line naming what was decided, with the
 * rule the Mac already uses (ConchDesign/QuestionOutcome, tested by `swift test`). Pinned here
 * is the WIRING: CI never builds the iOS app, so a phone that collapsed a RUNNING question —
 * the one row a person must act on — would reach a device rather than a red check.
 */
const root = join(import.meta.dir, "..");
const stack = readFileSync(join(root, "mobile", "conch-ios", "conch-ios", "ConversationStack.swift"), "utf8");

function sliceFrom(start: string, end: string): string {
  const at = stack.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const to = stack.indexOf(end, at + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  const slice = stack.slice(at, to);
  expect(slice.length, `${start} is too short to be the block`).toBeGreaterThan(300);
  return slice;
}

describe("an answered question collapses to what it decided", () => {
  test("the tool row asks the shared rule, and only for a finished call", () => {
    expect(stack).toContain("import ConchDesign");
    const tool = sliceFrom('case "tool":', 'case "material":');
    expect(tool).toContain("QuestionOutcome.summary(");
    expect(tool).toContain("QuestionOutcome.chosen(");
    // A running question is still the thing the session is blocked on: every option pressable.
    expect(tool).toContain('if item.tool?.status != "running",');
    expect(tool).toContain("answeredQuestionRow(decided)");
    // The fallback survives: when the answer names no option, the block renders as before.
    expect(tool).toContain('isActive: item.tool?.status == "running"');
  });

  test("the collapsed line is not a button", () => {
    const collapsed = sliceFrom("private func answeredQuestionRow(_ decided: String) -> some View {", "\n    }\n");
    expect(collapsed).toContain("Text(decided)");
    // Leaving it tappable is how an earlier choice gets sent to answer a later prompt.
    expect(collapsed).not.toContain("Button");
  });
});

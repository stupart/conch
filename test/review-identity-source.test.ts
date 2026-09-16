import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A deliverable's identity is its session plus its FILING time, which the
 * daemon now carries unchanged through later events. The apps key the pane,
 * the row pulse, the sheet reload and the notification on that identity, and
 * show the star only when the session is not working. The executable half is
 * in voice-loop.test.ts; this pins the Swift readers of it.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

describe("Mac", () => {
  const review = read("mac-app/conch-mac/ReviewView.swift");
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const content = read("mac-app/conch-mac/ContentView.swift");

  test("ReviewItem is identified by the row and the review's own time, and knows readiness", () => {
    expect(review).toContain("let timestampIdentity = review.at.map");
    expect(review).toContain("id = [row.id, timestampIdentity]");
    expect(review).toContain("isReady = row.status != .working");
  });

  // A new deliverable no longer moves the pane at all — it would take someone off the one
  // they are inspecting. It arrives as a preview inline in the conversation, and only a press
  // changes the page (workspace-state-source.test.ts). What still keys on the identity is the
  // row's pulse: the row asking to be looked at, where nobody is reading anything.
  test("a new deliverable pulses its row without taking the pane from the reader", () => {
    expect(dashboard).not.toContain(".onChange(of: selectedReview?.id)");
    expect(dashboard).toContain(".onChange(of: reviewIdentity)");
  });

  test("the star and the review age apply only when the session is not working", () => {
    expect(dashboard).toContain("if (row.review != nil && row.status != .working) || row.status == .review {");
    expect(dashboard).toContain("let timestamp = (row.status != .working ? row.review?.at : nil) ?? row.at");
    expect(dashboard).not.toContain("if row.review != nil || row.status == .review {");
    expect(dashboard).not.toContain("let timestamp = row.review?.at ?? row.at");
  });

  test("a review notifies once, when it is ready, not whenever it is published", () => {
    const ready = content.indexOf(".onChange(of: readyReviewIDs)");
    const all = content.indexOf(".onChange(of: reviewIDs)");
    const post = content.indexOf("ReviewNotifications.shared.postOnce(for: review)");
    expect(content).toContain("Set(reviewItems.filter(\\.isReady).map(\\.id))");
    expect(ready).toBeGreaterThan(-1);
    expect(all).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(ready);
    expect(post).toBeLessThan(all);
    expect(content.split("postOnce(").length - 1).toBe(1);
  });
});

describe("iPhone", () => {
  const models = read("mobile/conch-ios/conch-ios/Models.swift");
  const ledger = read("mobile/conch-ios/conch-ios/LedgerView.swift");
  const session = read("mobile/conch-ios/conch-ios/SessionView.swift");
  const sheet = read("mobile/conch-ios/conch-ios/DeliverableSheet.swift");

  test("the star applies only when the session is not working", () => {
    expect(models).toContain('if row.review != nil, row.status != "working" { self = .review; return }');
    expect(models).not.toContain("if row.review != nil { self = .review; return }");
    expect(ledger).toContain('(row.status != "working" ? row.review?.at : nil) ?? row.at');
    expect(ledger).not.toContain("row.review?.at ?? row.at");
    expect(session).toContain("if !isTalkingHere, mark != .review {");
  });

  test("the sheet reloads on a new deliverable identity, not on a routine republish", () => {
    expect(sheet).toContain('.task(id: "\\(review.link ?? "")\\u{1F}\\(review.at ?? 0)")');
    expect(sheet).not.toContain(".task(id: review.link)");
  });
});

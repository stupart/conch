import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The apps' half of typed deliverables. Neither app has an XCTest target, so this reads the
 * source: the grouping rule itself is tested by `swift test` (WorkspaceTests), and what these
 * guard is the wiring — that the decoders read the new fields as optional, that the tabs group
 * by the daemon's artifact, and that Remove reaches the daemon and says why when it refuses.
 */
const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const between = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
};

const dashboard = read("mac-app/conch-mac/DashboardView.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
const macModels = read("mac-app/conch-mac/Models.swift");
const review = read("mac-app/conch-mac/ReviewView.swift");
const iosModels = read("mobile/conch-ios/conch-ios/Models.swift");

describe("the Mac removes a deliverable from its tab", () => {
  test("the tab's context menu offers Remove, and only where the daemon can do it", () => {
    const tab = between(dashboard, "private struct DeliverableTab: View {", "private static func menuLine(");
    expect(tab).toContain("let remove: (() -> Void)?");
    expect(tab).toContain(".contextMenu {");
    expect(tab).toContain('Button("Remove", role: .destructive, action: remove)');
    const strip = between(dashboard, "private func deliverableTabs(for row: SessionRow)", "private func conversationBody(");
    expect(strip).toContain("remove: (state?.features?.deliverables ?? 0) >= 2");
    expect(strip).toContain("store.removeDeliverable(sessionId: row.id, artifact: group.id)");
  });

  test("the store sends review-remove and puts the daemon's refusal on the row", () => {
    const remove = between(store, "func removeDeliverable(sessionId: String, artifact: String) {", "func openInTerminal(");
    expect(remove).toContain("ConchSessionCommandRequest(sessionId: sessionId, command: .reviewRemove, artifact: artifact)");
    expect(remove).toContain("case let .error(error)?: failure = error.error");
    expect(remove).toContain("self?.rowMessages[sessionId] = failure");
    expect(socket).toContain('case reviewRemove = "review-remove"');
    expect(socket).toContain("let artifact: String?");
    expect(socket).toContain("self.artifact = artifact");
  });

  test("the tabs group by the daemon's artifact", () => {
    expect(dashboard).toContain("DeliverableVersion(id: $0.id, link: $0.link, artifact: $0.artifact)");
    expect(review).toContain("artifact = review.artifact");
  });
});

describe("the daemon removes through its ledger", () => {
  // The daemon's controller is a closure inside `runOwnedDaemon`; the rule it runs is
  // `SessionLedger.removeDeliverables`, tested in deliverables.test.ts. This pins the wiring.
  test("review-remove reaches the ledger and the apps hear of it", () => {
    const daemon = read("src/daemon.ts");
    const remove = between(daemon, "    removeReview: (target, which) => {", "    dismiss: (target) => {");
    expect(remove).toContain("if (!ledger.removeDeliverables(target.sessionId, which)) return false;");
    expect(remove).toContain("void renderSessionPanel();");
    expect(remove).toContain("return true;");
  });
});

describe("both apps read a deliverable's artifact, version and kind as optional", () => {
  test("the Mac decodes them without failing a review that lacks them", () => {
    const info = between(macModels, "struct ReviewInfo: Decodable", "private static func decodeTimestamp(");
    for (const key of ["artifact", "version", "kind"]) expect(info).toContain(`case ${key}`);
    expect(info).toContain("artifact = try? container.decodeIfPresent(String.self, forKey: .artifact)");
    expect(info).toContain("version = try? container.decodeIfPresent(Int.self, forKey: .version)");
    expect(info).toContain("kind = try? container.decodeIfPresent(String.self, forKey: .kind)");
  });

  test("the phone does too", () => {
    const decoded = between(iosModels, "struct Review: Decodable, Equatable {", "private enum CodingKeys: String, CodingKey {\n            case id, label");
    expect(decoded).toContain("case summary, link, at, scene, id, viewedAt, artifact, version, kind");
    expect(decoded).toContain("artifact = try? c.decodeIfPresent(String.self, forKey: .artifact)");
    expect(decoded).toContain("version = try? c.decodeIfPresent(Int.self, forKey: .version)");
    expect(decoded).toContain("kind = try? c.decodeIfPresent(String.self, forKey: .kind)");
  });
});

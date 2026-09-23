import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/** conch-mac has no XCTest target, so the sidebar's mapping is pinned as source. */
const read = (name: string) => readFileSync(`${import.meta.dir}/../mac-app/conch-mac/${name}`, "utf8");

test("a working row whose agents are the only thing running gets its own mark and meaning", () => {
  const dashboard = read("DashboardView.swift");
  const init = dashboard.slice(dashboard.indexOf("    init(row: SessionRow) {"), dashboard.indexOf("    var symbol: String {"));
  expect(init.length).toBeGreaterThan(300);
  expect(init).toMatch(/if row\.status == \.working && row\.waitingOnAgents \{\s*self = \.waitingOnAgents/);
  expect(dashboard).toContain('return "Waiting on its agents — you can talk to it"');
  expect(dashboard).toMatch(/case \.waitingOnAgents:\s*\/\/[^\n]*\n\s*return "person\.2\.fill"/);
  expect(read("Models.swift")).toContain("(try? container.decodeIfPresent(Bool.self, forKey: .waitingOnAgents)) ?? false");
  expect(read("ContentView.swift")).toContain('meaning: "Its agents are working — you can talk to it"');
});

test("the phone gives the same row the same mark, and says it can be talked to", () => {
  const models = readFileSync(`${import.meta.dir}/../mobile/conch-ios/conch-ios/Models.swift`, "utf8");
  expect(models).toContain("waitingOnAgents = (try? c.decodeIfPresent(Bool.self, forKey: .waitingOnAgents)) ?? false");
  const mark = models.slice(models.indexOf("enum StatusMark {"), models.indexOf("func relativeAge("));
  expect(mark.length).toBeGreaterThan(300);
  expect(mark).toContain('case "working" where row.waitingOnAgents: self = .waitingOnAgents');
  expect(mark).toMatch(/case \.waitingOnAgents: "person\.2\.fill"/);
  expect(mark).toContain("case .waiting, .waitingOnAgents: Palette.waiting");
  expect(mark).toContain('case .waitingOnAgents: "Waiting on its agents — you can talk to it"');
  // The one line beside a glyph cut the sentence off at "you…"; the whole of it is still read out.
  expect(mark).toContain('self == .waitingOnAgents ? "Agents working — talk to it" : meaning');
  const session = readFileSync(`${import.meta.dir}/../mobile/conch-ios/conch-ios/SessionView.swift`, "utf8");
  expect(session).toMatch(/Text\(mark\.caption\)[\s\S]{0,200}\.accessibilityLabel\(mark\.meaning\)/);
});

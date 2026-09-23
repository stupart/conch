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

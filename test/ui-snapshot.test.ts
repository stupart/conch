import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// scripts/ui-snapshot.sh photographs the apps without the screen: the Mac app
// draws its own window (DebugSnapshot via `conch shot`), and a headless
// simulator renders a published-state fixture through the phone's DEBUG-only
// fixture mode. These pin that the fixture mode cannot reach Release, that it
// goes through the app's real decoder, and that the script keeps its hands off
// the screen and off any simulator it did not boot. Presence before absence.

const repo = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const iosDir = join(repo, "mobile", "conch-ios", "conch-ios");
const iosSources = readdirSync(iosDir)
  .filter((name) => name.endsWith(".swift"))
  .map((name) => readFileSync(join(iosDir, name), "utf8"));

/** How often `marker` appears, failing if any occurrence is outside an `#if DEBUG` branch. */
function debugOnlyCount(source: string, marker: string): number {
  let count = 0;
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + marker.length)) {
    count++;
    const before = source.slice(0, at);
    const opened = before.lastIndexOf("#if DEBUG");
    expect(opened).toBeGreaterThan(-1);
    // Neither closed nor switched to the #else branch since it opened.
    expect(Math.max(before.lastIndexOf("#endif"), before.lastIndexOf("#else"))).toBeLessThan(opened);
  }
  return count;
}

describe("phone fixture mode", () => {
  test("exists only in DEBUG: every mention, in every iOS source file, sits inside #if DEBUG", () => {
    for (const marker of ["conchFixture", "FixtureTransport", "fixtureURL"]) {
      const total = iosSources.reduce((sum, source) => sum + debugOnlyCount(source, marker), 0);
      expect(total).toBeGreaterThan(0);
    }
    // The ways in: the fixture file, the session to open, where it opens, the sheet to raise.
    const all = iosSources.join("\n");
    expect(all).toContain('UserDefaults.standard.string(forKey: "conchFixture")');
    expect(all).toContain('UserDefaults.standard.string(forKey: "conchFixtureSession")');
    expect(all).toContain('UserDefaults.standard.bool(forKey: "conchFixtureTop")');
    expect(all).toContain('UserDefaults.standard.bool(forKey: "conchFixtureReview")');
  });

  test("the fixture reaches the UI through the app's own decoder, and deliverables are copies", () => {
    const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");
    expect(bridge).toContain("JSONDecoder().decode(PublishedState.self, from: data)");
    const start = bridge.indexOf("final class FixtureTransport: BridgeTransport");
    expect(start).toBeGreaterThan(-1);
    const fixture = bridge.slice(start, bridge.indexOf("#endif", start));
    expect(fixture).toContain("onStateData?(data)");
    // The deliverable sheet deletes the file it is handed on dismiss.
    expect(fixture).toContain("copyItem(at:");
    expect(fixture).not.toContain("JSONDecoder");
    expect(fixture).not.toContain("moveItem");
  });

  test("the showcase fixture carries every state the phone has to draw", () => {
    const state = JSON.parse(read("mobile/conch-ios/fixtures/showcase.json"));
    const rows: any[] = state.rows;
    expect(rows.some((row) => row.backend === "claude")).toBe(true);
    expect(rows.some((row) => row.backend === "codex" && row.noTerminal)).toBe(true);
    expect(rows.some((row) => row.parentSessionId)).toBe(true);
    expect(rows.some((row) => row.status === "needs")).toBe(true);

    const items: any[] = Object.values(state.conversations).flatMap((c: any) => c.items);
    expect(items.some((item) => item.question?.options?.length > 1)).toBe(true);
    expect(items.some((item) => item.tool?.kind === "command_execution")).toBe(true);
    expect(items.some((item) => item.tool?.kind === "subagent")).toBe(true);

    const reply = state.conversations["claude-readability"].items.at(-1);
    expect(reply.kind).toBe("assistant");
    for (const piece of ["## ", "\n- ", "\n1. ", " `", "```swift", "| --- |", "](docs/architecture.md)", "](https://"]) {
      expect(reply.text).toContain(piece);
    }
    // The daemon caps a published item at 4,000 chars; a fixture past it lies.
    expect(reply.text.length).toBeLessThanOrEqual(4_000);

    const review = rows.find((row) => row.id === "claude-readability").review;
    expect(existsSync(join(repo, review.link))).toBe(true);
  });
});

describe("ui-snapshot.sh", () => {
  const script = read("scripts/ui-snapshot.sh");
  const code = script.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");

  test("boots only a shut-down simulator, headless, and always shuts it down", () => {
    expect(code).toContain("grep '(Shutdown)'");
    expect(code).toContain('xcrun simctl boot "$udid"');
    expect(code).toContain("trap 'xcrun simctl shutdown \"$udid\"");
    expect(code.indexOf("trap '")).toBeLessThan(code.indexOf('xcrun simctl boot "$udid"'));
    expect(code).not.toMatch(/open\s+(-\S+\s+)*-a\s+Simulator/);
  });

  test("never captures the screen: the Mac shot is the app drawing itself", () => {
    expect(code).toContain('bun "$root/src/cli.ts" shot "$out"');
    expect(code).toContain('xcrun simctl io "$udid" screenshot');
    expect(code).not.toContain("screencapture");
  });
});

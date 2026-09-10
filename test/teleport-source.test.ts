import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const mac = read("mac-app/conch-mac/ContentView.swift");
const ios = read("mobile/conch-ios/conch-ios/LedgerView.swift");
const socket = read("mac-app/conch-mac/ConchSocketClient.swift");
const store = read("mac-app/conch-mac/StateStore.swift");
const bridge = read("mobile/conch-ios/conch-ios/BridgeClient.swift");

// A missing token has index -1: ordering alone would reward a deleted warning.
function expectBefore(source: string, first: string, second: string) {
  expect(source).toContain(first);
  expect(source).toContain(second);
  expect(source.indexOf(first)).toBeLessThan(source.indexOf(second));
}

for (const [platform, source, location, folder] of [
  ["Mac", mac, "this Mac", String.raw`\(effectiveCwd.trimmingCharacters(in: .whitespacesAndNewlines))`],
  ["iOS", ios, "your Mac", String.raw`\(freshWorkingFolder ?? "the selected folder")`],
] as const) {
  describe(`${platform} teleport picker`, () => {
    test("offers Teleport by ID beside Resume, with Claude and a required folder", () => {
      expectBefore(source, 'case resume = "Resume"', 'case teleport = "Teleport by ID…"');
      expect(source).toContain('Picker("Session", selection: $mode)');
      expect(source).toContain("ForEach(StartMode.allCases)");
      expect(source).toContain("if mode == .teleport { return .claude }");
      expect(source).toContain('Text("Working folder")');
      expect(source).toContain('hasPrefix("/")');
      expect(source).toContain('teleportSessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty');
      expect(source).toContain('.disabled(!canStart)');
    });

    test("renders the full fork disclosure before the launch action", () => {
      const heading = 'Text("Teleport — create a local copy.")';
      const disclosure = `Text("Opens this Claude session in Terminal on ${location}, in ${folder}. New work stays on ${location} and does not update the original Claude app session. Requires internet access and the same Claude.ai account. Claude may switch Git branches and ask to stash local changes, including untracked files.")`;
      expectBefore(source, heading, disclosure);
      expectBefore(source, disclosure, '"Open in Terminal"');
    });

    test("sends the typed teleport id only in teleport mode", () => {
      expect(source).toContain('text: $teleportSessionId');
      expect(source).toContain("backend: effectiveBackend");
      expect(source).toContain("teleportSessionId: mode == .teleport ? teleportSessionId : nil");
      expect(source).toContain(platform === "Mac"
        ? "cwd: effectiveCwd"
        : "cwd: resuming ? resumeSelection?.cwd : freshWorkingFolder");
      expect(source).toContain(platform === "Mac"
        ? "resumeSessionId: mode == .resume ? resumeSelection?.sessionId : nil"
        : "resumeSessionId: resuming ? resumeSelection?.sessionId : nil");
    });

    test("acknowledges only opening Terminal, leaving cloud completion to Claude", () => {
      expect(source).toContain(`.alert("Opened in Terminal on ${location}", isPresented: $openedTeleport)`);
      expect(source).toContain("This does not confirm that the session downloaded or the workspace is ready.");
      expect(source).toContain("openedTeleport = true");
      if (platform === "Mac") {
        expectBefore(source, "openedTeleport = true", "let appeared = await waitForSession()");
      }
    });
  });
}

test("Mac encodes teleportSessionId through the store and socket request", () => {
  expect(store).toContain("teleportSessionId: String? = nil");
  expect(store).toContain("let teleport = Self.nonempty(teleportSessionId)");
  expect(store).toContain("teleportSessionId: teleport,");
  expect(socket).toContain("let teleportSessionId: String?");
  expect(socket).toContain("self.teleportSessionId = teleportSessionId");
});

test("iOS encodes teleportSessionId through the bridge request", () => {
  expect(bridge).toContain("teleportSessionId: String? = nil");
  expect(bridge).toContain('let teleportID = teleportSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""');
  expect(bridge).toContain('message["teleportSessionId"] = teleportID');
});

test("both Swift clients require the teleport acknowledgement for a teleport launch", () => {
  expect(socket).toContain("let teleported: Bool?");
  expect(store).toContain("(started.teleported == true) == (teleport != nil)");
  expect(bridge).toContain('(reply["teleported"] as? Bool == true) == !teleportID.isEmpty');
});

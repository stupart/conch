import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Tyler, 2026-10-08: "how do i get it to stop reading out loud? ... it also says space to cut in but that doesn't work
 * and yea how do i just turn it off and have it stop talking??" The Mac's keys, as that left them: Esc stops a reading
 * from anywhere, a bare r no longer reads anything aloud, and Read replies aloud heads Settings.
 */
const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const monitor = read("mac-app/conch-mac/DashboardInputMonitor.swift");
const content = read("mac-app/conch-mac/ContentView.swift");

describe("stopping a reading on the Mac", () => {
  test("Esc is offered to stop speech before any focus test, so the message box having the keyboard can't swallow it", () => {
    const handler = monitor.slice(monitor.indexOf("keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {"));
    const esc = handler.indexOf("event.keyCode == 53");
    const stop = handler.indexOf("onKey(.stopSpeaking)");
    const editable = handler.indexOf("if firstResponderIsEditableText() {");
    expect(esc).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(esc);
    expect(editable).toBeGreaterThan(stop);
  });

  test("Esc stops only while conch is reading, and is passed on otherwise", () => {
    const dispatch = content.slice(content.indexOf("case .stopSpeaking:"), content.indexOf("case .showKeyboardShortcuts:"));
    expect(dispatch).toContain('guard store.state?.live.state == "speaking" else { return false }');
    expect(dispatch).toContain("store.send(.stop())");
  });

  test("a bare r reads nothing aloud, and the shortcut list no longer offers it", () => {
    const keys = monitor.slice(monitor.indexOf("switch event.characters {"));
    expect(keys).not.toContain('case "r":');
    expect(monitor).not.toContain("case recite");
    expect(content).not.toContain('ShortcutHelpRow(command: "R", result: "Recite")');
    expect(content).toContain('ShortcutHelpRow(command: "Esc", result: "Stop reading aloud, from anywhere")');
  });

  test("Read replies aloud heads Settings on the Mac and the phone", () => {
    expect(read("mac-app/conch-mac/SettingsView.swift")).toContain('"speak": "Read replies aloud"');
    expect(read("mac-app/conch-mac/SettingsProtocol.swift")).toContain('if ($0.key == "speak") != ($1.key == "speak") { return $0.key == "speak" }');
    expect(read("mobile/conch-ios/conch-ios/ConchSetting.swift")).toContain('"speak": "Read replies aloud"');
    expect(read("mobile/conch-ios/conch-ios/SettingsView.swift")).toContain('if ($0.key == "speak") != ($1.key == "speak") { return $0.key == "speak" }');
  });
});

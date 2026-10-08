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

describe("the speaker button stops what it started", () => {
  // Tyler, 2026-10-08: "i want to be able to click the speak button again and it stops talking".
  const composer = read("mac-app/conch-mac/ComposerView.swift");
  test("while this session is read aloud, the speaker button stops it with the mic's own stop", () => {
    expect(composer).toContain('private var isReadingAloud: Bool { voiceState == "speaking" }');
    expect(composer).toContain("Button(action: isReadingAloud ? onTalk : onRecite) {");
    expect(composer).toContain('.help(isReadingAloud ? "Stop reading" : "Read the last reply again")');
    // onTalk stops an active exchange, and speaking is one: the button can't open the mic or start a second reading.
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain('|| state == "speaking" || state == "transcribing"');
    const talk = composer.slice(composer.indexOf("onTalk: {"), composer.indexOf("onRecite: {"));
    expect(talk.indexOf("if LiveState.isExchangeActive(voiceState(for: row)) {")).toBeLessThan(talk.indexOf("store.send(.stop())"));
  });
});

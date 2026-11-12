import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Which of the Mac app's files may picture the screen, stream it or ask for Screen Recording, and that the app itself never
// opens the microphone. 2026-11-11: these were the app-wide guards in canvas-source and canvas-show-source; the canvas's
// still and Show's recording, the two captures those files were about, went with the old overlays, so each list here is
// shorter by them and nothing has taken their place.

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Every Swift file in the Mac app, by name. */
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac"))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, read(`mac-app/conch-mac/${name}`)]),
);
/** The Mac files that mention `needle`. */
const filesWith = (needle: string): string[] => Object.keys(macSources).filter((name) => macSources[name]!.includes(needle)).sort();

describe("the screen", () => {
  test("nothing records it to a file, and only the Terminal tab streams it", () => {
    // The Terminal tab's stream (terminal-mirror-source.test.ts): one Terminal window, shown and never written anywhere,
    // only while its tab is on screen.
    expect(filesWith("SCStream(")).toEqual(["TerminalMirror.swift"]);
    expect(filesWith("startCapture(")).toEqual(["TerminalMirror.swift"]);
    expect(filesWith("SCRecordingOutput")).toEqual([]);
    expect(filesWith("AVAssetWriter")).toEqual([]);
  });

  test("a still is taken only of what was asked for, and the grant is asked for in one place", () => {
    // The phone's window snapshot (window-preview.test.ts): only on the daemon's request, of the app the session built,
    // and only with a grant already given. The annotate harness (scripts/annotate-e2e.ts) photographs conch's own window
    // alone, through the current process's content, which needs no grant and sees no one else's screen.
    expect(filesWith("SCScreenshotManager")).toEqual(["AnnotateHarness.swift", "WindowPreview.swift"]);
    const harness = macSources["AnnotateHarness.swift"]!;
    expect(harness).toContain("SCShareableContent.currentProcess");
    expect(harness).toContain("SCContentFilter(desktopIndependentWindow: shared)");
    expect(harness).not.toContain("CGRequestScreenCaptureAccess");
    expect(filesWith("SCShareableContent")).toEqual(["AnnotateHarness.swift", "TerminalMirror.swift", "WindowPreview.swift"]);
    // Settings' Screen Recording row checks too (Permissions.swift): a check, which neither captures nor asks.
    expect(filesWith("CGPreflightScreenCaptureAccess")).toEqual(["Permissions.swift", "TerminalMirror.swift", "WindowPreview.swift"]);
    // The ask is `ScreenRecordingGrant`'s, on a press (permissions-source.test.ts pins it).
    expect(filesWith("CGRequestScreenCaptureAccess")).toEqual(["Permissions.swift"]);
    // Deprecated in 14 and gone in 15.
    expect(filesWith("CGWindowListCreateImage")).toEqual([]);
  });

  test("what the screen context says is on screen reaches the app, and survives the store's rebuild", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain("showing = try? container.decodeIfPresent(Showing.self, forKey: .showing)");
    expect(models).toContain("&& showing == other.showing");
    expect(read("mac-app/conch-mac/StateStore.swift")).toContain("showing: sourceState.showing");
  });
});

describe("the microphone", () => {
  test("the app never opens it: listening is the daemon's, behind its one mic reservation", () => {
    expect(filesWith("captureMicrophone")).toEqual([]);
    for (const mic of ["AVAudioEngine", "AVAudioRecorder", "AVCaptureSession", "AVCaptureDeviceInput", "AVCaptureDevice.default", "microphoneCaptureDeviceID"]) {
      expect(filesWith(mic), mic).toEqual([]);
    }
    // The one mention of the mic is Settings' row: its grant read, and asked for on a press. Neither opens it.
    expect(filesWith("AVCaptureDevice")).toEqual(["Permissions.swift"]);
    const permissions = read("mac-app/conch-mac/Permissions.swift").replace(/\/\/.*$/gm, "");
    expect([...permissions.matchAll(/AVCaptureDevice\.(\w+)/g)].map((match) => match[1]).sort())
      .toEqual(["authorizationStatus", "authorizationStatus", "requestAccess"]);
    // Show's narration was the app's one ask of the daemon's recorder; it went with the canvas (2026-11-11).
    expect(filesWith('"narration-start"')).toEqual([]);
    expect(filesWith("sox")).toEqual([]);
  });
});

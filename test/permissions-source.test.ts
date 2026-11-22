import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import { ACCESSIBILITY_REFUSED, FRONT_TTY_SCRIPT, injectKey, injectKeys, injectText, type InjectTextOptions, type OsaResult } from "../src/inject.ts";

// A keystroke macOS refused is named for the permission that refused it, so the apps can point at the right switch.

describe("the daemon names a keystroke macOS refused for Accessibility", () => {
  const cfg = { autoSubmit: false, keystrokeFallback: true } as Config;
  /** Terminal raises the window and says the tab is in front; whatever types is answered with `typing`. */
  const refusing = (typing: OsaResult): InjectTextOptions => ({
    clipboardFallback: false,
    findTmuxPane: async () => null,
    ttyForPid: async () => "ttys001",
    sleep: async () => {},
    osa: async (lines) => {
      const script = lines.join("\n");
      if (script === FRONT_TTY_SCRIPT) return { text: "/dev/ttys001", timedOut: false, exitCode: 0 };
      if (script.includes("activate")) return { text: "ok", timedOut: false, exitCode: 0 };
      return typing;
    },
  });
  const refused = (stderr: string): OsaResult => ({ text: "", timedOut: false, exitCode: 1, stderr });

  test("System Events' words for it, in every form, are Accessibility's reason", async () => {
    for (const stderr of [
      "execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)",
      "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)",
      "execution error: System Events got an error: AppleEvent handler failed (-25211)",
    ]) {
      expect(ACCESSIBILITY_REFUSED.test(stderr), stderr).toBe(true);
      expect(await injectText(cfg, 42, "words", undefined, refusing(refused(stderr))))
        .toEqual({ via: "none", failed: true, reason: "accessibility-permission-denied" });
      expect(await injectKey(cfg, 42, "Enter", undefined, refusing(refused(stderr))))
        .toEqual({ via: "none", failed: true, reason: "accessibility-permission-denied" });
      expect(await injectKeys(cfg, 42, ["Enter"], undefined, refusing(refused(stderr))))
        .toEqual({ via: "none", failed: true, reason: "accessibility-permission-denied" });
    }
  });

  test("-1719 alone is AppleScript's Invalid index, not Accessibility; Automation keeps its own reason", async () => {
    const invalid = "execution error: Terminal got an error: Can’t get window 1. Invalid index. (-1719)";
    expect(ACCESSIBILITY_REFUSED.test(invalid)).toBe(false);
    expect(await injectText(cfg, 42, "words", undefined, refusing(refused(invalid))))
      .toEqual({ via: "none", failed: true, reason: "automation-failed" });
    expect(await injectText(cfg, 42, "words", undefined, refusing(refused("execution error: Not authorized to send Apple events to System Events. (-1743)"))))
      .toEqual({ via: "none", failed: true, reason: "automation-permission-denied" });
  });
});

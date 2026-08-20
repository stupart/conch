import { describe, expect, test } from "bun:test";
import { SessionStartOverlay } from "../src/session-start-overlay.ts";

describe("SessionStartOverlay", () => {
  test("chooses an agent and working folder before starting a fresh session", async () => {
    const starts: unknown[] = [];
    const lifecycle: string[] = [];
    const overlay = new SessionStartOverlay({
      controller: { start: async (request) => { starts.push(request); } },
      defaultCwd: "/Users/tyler",
      onOpen: () => lifecycle.push("open"),
      onClose: () => lifecycle.push("close"),
      onChange() {},
    });
    overlay.open();
    overlay.handleKey("\x1b[C");
    expect(overlay.model()?.rows[0]?.value).toBe("codex");
    overlay.handleKey("\x1b[B");
    overlay.handleKey("\r");
    for (let index = 0; index < "/Users/tyler".length; index++) overlay.handleKey("\x7f");
    overlay.handleKey("/Users/tyler/conch");
    overlay.handleKey("\r");
    overlay.handleKey("\x1b[B");
    overlay.handleKey("\r");
    expect(overlay.model()?.starting).toBeTrue();
    await Bun.sleep(0);

    expect(starts).toEqual([{ backend: "codex", cwd: "/Users/tyler/conch" }]);
    expect(overlay.isOpen()).toBeFalse();
    expect(lifecycle).toEqual(["open", "close"]);
  });

  test("a launch failure stays visible and the modal traps global keys", async () => {
    const overlay = new SessionStartOverlay({
      controller: { start: async () => { throw new Error("Terminal unavailable"); } },
      defaultCwd: "/tmp",
      onChange() {},
    });
    expect(overlay.handleKey("q")).toBeFalse();
    overlay.open();
    expect(overlay.handleKey("q")).toBeTrue();
    overlay.handleKey("\x1b[B");
    overlay.handleKey("\x1b[B");
    overlay.handleKey("\r");
    await Bun.sleep(0);
    expect(overlay.model()?.error).toBe("Terminal unavailable");
    expect(overlay.isOpen()).toBeTrue();
  });
});

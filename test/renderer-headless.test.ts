import { describe, expect, it } from "bun:test";
import { configureRenderer } from "../src/status.ts";

/**
 * The daemon must not draw when nobody can see it.
 *
 * Painting into a terminal whose reader has gone blocks inside write(2), and
 * the socket accept loop sits behind that write — the daemon stays alive in
 * `ps` while every phone request times out as "couldn't reach your Mac".
 */
describe("renderer selection", () => {
  const io = (stdout: boolean, stdin = stdout) => ({
    stdoutTTY: stdout,
    stdinTTY: stdin,
    columns: () => 100,
    dashboardColumns: () => 80,
    rows: () => 24,
    write: () => {},
    print: () => {},
    copy: async () => {},
  });

  it("draws nothing without a TTY, which is how launchd runs it", () => {
    expect(configureRenderer({}, io(false)).kind).toBe("headless");
  });

  it("honours an explicit headless request even on a TTY", () => {
    expect(configureRenderer({ CONCH_HEADLESS: "1" }, io(true)).kind).toBe("headless");
  });

  it("still draws a dashboard for a person at a terminal", () => {
    expect(configureRenderer({}, io(true)).kind).toBe("theater");
  });
});

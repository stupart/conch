import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TERMINAL_SCRIPT_TIMEOUT_MS, terminalTabLookup } from "../src/terminal-tab.ts";

// 2026-10-11, Tyler: "the asset generator and monorepo session won't let me send a message or open the terminal". Its
// tab was found by asking each of Terminal's tabs for its tty, one Apple event per tab; with the Mac's load past 250 that
// took up to 90 seconds, and conch gave up after four.
test("the tab is found in two Apple events, however many windows and tabs", () => {
  const script = terminalTabLookup("ttys010");
  expect(script.split('tell application "Terminal"')).toHaveLength(2);
  expect(script).toContain("set conchIds to id of every window");
  expect(script).toContain("set conchTtys to tty of every tab of every window");
  expect(script).toContain('if item ti of conchRow is "/dev/ttys010" then');
  // Nothing in the walk asks Terminal anything: it walks the two lists it was given.
  const walk = script.slice(script.indexOf("end tell"));
  expect(walk).not.toContain("tell application");
  expect(script).not.toMatch(/repeat with \w+ in (windows|tabs)/);
  // A window with one tab is still a list to walk.
  expect(script).toContain("if class of conchRow is not list then set conchRow to {conchRow}");
});

test("only a tty's name goes into the script", () => {
  for (const tty of ["ttys010", "ttys1", "tty-fixture"]) expect(() => terminalTabLookup(tty)).not.toThrow();
  for (const tty of ['ttys1" then do shell script "x', "ttys1\nend tell", "/dev/ttys010", "", "pts/1"]) {
    expect(() => terminalTabLookup(tty)).toThrow();
  }
});

test("every Terminal script conch runs finds its tab this way, and waits as long as a busy Mac takes", () => {
  for (const file of ["inject.ts", "terminal-mirror.ts", "session-lifecycle.ts"]) {
    const source = readFileSync(join(import.meta.dir, "../src", file), "utf8");
    expect(source).not.toMatch(/repeat with \w+ in tabs of/);
    expect(source).toContain("terminalTabLookup(tty)");
  }
  expect(TERMINAL_SCRIPT_TIMEOUT_MS).toBeGreaterThanOrEqual(15_000);
  const inject = readFileSync(join(import.meta.dir, "../src/inject.ts"), "utf8");
  expect(inject).toContain("undefined, { timeoutMs: TERMINAL_SCRIPT_TIMEOUT_MS });");
});

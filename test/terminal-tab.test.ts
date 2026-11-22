import { expect, test } from "bun:test";
import { terminalTabLookup } from "../src/terminal-tab.ts";

// 2026-10-11, Tyler: "the recipe app and backend session won't let me send a message or open the terminal". Its
// tab was found by asking each of Terminal's tabs for its tty, one Apple event per tab; with the Mac's load past 250 that
// took up to 90 seconds, and conch gave up after four.
test("the tab is found in two Apple events, however many windows and tabs", () => {
  const script = terminalTabLookup("ttys010");
  expect(script.split('tell application "Terminal"')).toHaveLength(2);
  expect(script).not.toMatch(/repeat with \w+ in (windows|tabs)/);
});

test("only a tty's name goes into the script", () => {
  for (const tty of ["ttys010", "ttys1", "tty-fixture"]) expect(() => terminalTabLookup(tty)).not.toThrow();
  for (const tty of ['ttys1" then do shell script "x', "ttys1\nend tell", "/dev/ttys010", "", "pts/1"]) {
    expect(() => terminalTabLookup(tty)).toThrow();
  }
});

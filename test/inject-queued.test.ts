import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Sending to a session that is already working.
 *
 * Both agents accept typed input mid-turn and queue it themselves, so this
 * already works — but neither writes the prompt to its transcript until it
 * STARTS that turn. conch confirmed delivery by watching the transcript grow,
 * which a busy session cannot do: the mark never moves, every retry re-presses
 * Return into a working session, and a message that queued perfectly is
 * reported as failed. The phone keeps the draft and you send it twice.
 *
 * Source guards, because reproducing this needs a live agent mid-turn.
 */
describe("a message sent to a busy session counts as queued", () => {
  const source = readFileSync(new URL("../src/daemon.ts", import.meta.url), "utf8");

  test("a busy session short-circuits transcript confirmation", () => {
    expect(source).toContain('panelSessions.get(event.sessionId)?.status === "busy"');
    expect(source).toContain("queued behind the running turn");
  });

  // The exemption must not become a hole in honest delivery: a blind keystroke
  // or a clipboard fallback has no evidence the words reached anything.
  test("only routes with real keystrokes in a real pane qualify", () => {
    expect(source).toContain(
      'const keysLanded = via === "tmux" || via === "osascript-focused";',
    );
    const guard = source.slice(source.indexOf("const keysLanded"));
    const branch = guard.slice(0, guard.indexOf("return true;"));
    expect(branch).toContain("keysLanded &&");
    expect(branch).not.toContain('"clipboard"');
  });
});

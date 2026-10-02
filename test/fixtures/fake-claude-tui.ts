import { appendFileSync } from "node:fs";
import { promptDigest } from "../../src/delivery-evidence.ts";

/**
 * A stand-in for Claude Code's terminal, for the delivery tests that type into a real tmux pane: its input box
 * as 2.1.280 draws it (the `❯` line under a rule), keys taken the way the real one takes them, and the two ways
 * a send has gone wrong there:
 *  - `startingMs`: still starting, with no box drawn yet, and every key dropped;
 *  - `lostReturns`: the words reach the box, and that many Returns are lost.
 * A submitted prompt is reported as the conch hook reports it: its fingerprint, with the time, on a line of
 * `evidence`.
 *
 *   bun fake-claude-tui.ts <evidence> [startingMs] [lostReturns]
 */
const [, , evidence, startingMs = "0", lostReturns = "0"] = process.argv;
if (!evidence) throw new Error("usage: fake-claude-tui.ts <evidence> [startingMs] [lostReturns]");
const readyAt = Date.now() + Number(startingMs);
let lost = Number(lostReturns);
let box = "";

const ready = () => Date.now() >= readyAt;
const draw = () => {
  const screen = ready()
    ? ["⏺ ready", "", `${"─".repeat(40)} alpha ─`, `❯ ${box}`, "─".repeat(48), "  ⏵⏵ bypass permissions on"]
    : ["✻ Starting…"];
  process.stdout.write(`\x1b[2J\x1b[H${screen.join("\r\n")}`);
};

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk: Buffer) => {
  if (!ready()) return;
  for (const key of chunk.toString("utf8")) {
    if (key === "\r") {
      if (lost > 0) { lost -= 1; continue; }
      if (box.trim()) appendFileSync(evidence, `${Date.now()} ${promptDigest(box)}\n`);
      box = "";
    } else if (key === "\x7f") {
      box = box.slice(0, -1);
    } else if (key >= " ") {
      box += key;
    }
  }
  draw();
});
draw();
if (!ready()) setTimeout(draw, readyAt - Date.now());

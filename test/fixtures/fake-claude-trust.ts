// Draws Claude Code's trust prompt after `delayMs`, takes Down/Up/Enter like it, and writes the choice to `out`. For
// `deafMs` after drawing it hears nothing, as Claude Code's menu does between its first paint and listening.
import { appendFileSync } from "node:fs";
const [, , out, delayMs = "0", deafMs = "0"] = process.argv;
let yes = false; let listening = false;
const draw = () => process.stdout.write("\x1b[2J\x1b[H" + [
  " Accessing workspace:", "", " /tmp/somewhere", "", " Quick safety check: Is this a project you created or one you trust?", "",
  `${yes ? "  " : " ❯"} No, exit`, `${yes ? " ❯" : "  "} Yes, I trust this folder`, "", " Enter to confirm · Esc to cancel",
].join("\r\n"));
process.stdin.setRawMode(true); process.stdin.resume();
setTimeout(() => { draw(); setTimeout(() => { listening = true; }, Number(deafMs)); }, Number(delayMs));
process.stdin.on("data", (chunk: Buffer) => {
  if (!listening) return;
  const s = chunk.toString("latin1");
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("\x1b[B", i)) { yes = !yes; i += 2; draw(); continue; }
    if (s.startsWith("\x1b[A", i)) { yes = !yes; i += 2; draw(); continue; }
    if (s[i] === "\r") { appendFileSync(out, yes ? "trusted\n" : "exited\n"); process.stdout.write("\x1b[2J\x1b[Hdone"); setTimeout(() => process.exit(0), yes ? 5_000 : 200); return; }
  }
});

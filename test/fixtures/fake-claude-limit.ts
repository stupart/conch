// Stands in for Claude Code stopped on its usage-limit menu (claude-limit-menu.ts): draws the menu with `rows` (stop,
// wait, funds, upgrade) and row `start` highlighted, takes Up/Down/Enter as its picker does, and writes each choice to
// `out` ("chose: <row>"). For `deafMs` after drawing it hears nothing, as a menu between its first paint and listening.
// "Stop and wait" puts it back at its prompt, holding `prefill` (Claude Code's own "continue", or nothing): what is typed
// there replaces that, as Claude Code's does, and Enter writes "said: <words>".
import { appendFileSync } from "node:fs";
const [, , out, rowsArg = "stop,wait,funds", start = "0", deafMs = "0", prefill = ""] = process.argv;
const LABELS: Record<string, string> = {
  stop: "Stop and wait for limit to reset",
  wait: "Wait here, then continue automatically at 10pm",
  funds: "Add funds to continue with usage credits",
  upgrade: "Upgrade your plan",
};
const rows = rowsArg!.split(",").map((key) => LABELS[key]!);
let at = Number(start);
let listening = false;
let mode: "menu" | "prompt" | "waiting" = "menu";
let box = "";
const rule = "─".repeat(72);
const draw = () => process.stdout.write("\x1b[2J\x1b[H" + [
  "❯ keep going on the importer", "",
  "⏺ Agent(Port the importer)", "  ⎿  You've hit your weekly limit · resets Nov 14 at 10pm", "",
  ...(mode === "menu"
    ? [rule, "  What do you want to do?", "", ...rows.map((label, index) => `  ${index === at ? "❯" : " "} ${index + 1}. ${label}`), "",
      "  Enter to confirm · Esc to cancel"]
    : mode === "prompt" ? [rule, `❯ ${box}`, rule, "  ? for shortcuts"] : ["  Waiting for the limit to reset…"]),
].join("\r\n"));
process.stdin.setRawMode(true); process.stdin.resume();
draw();
setTimeout(() => { listening = true; }, Number(deafMs));
process.stdin.on("data", (chunk: Buffer) => {
  if (!listening) return;
  const s = chunk.toString("utf8");
  for (let i = 0; i < s.length; i++) {
    if (mode === "menu") {
      if (s.startsWith("\x1b[A", i)) { at = Math.max(0, at - 1); i += 2; draw(); continue; }
      if (s.startsWith("\x1b[B", i)) { at = Math.min(rows.length - 1, at + 1); i += 2; draw(); continue; }
      if (s[i] === "\r") {
        appendFileSync(out!, `chose: ${rows[at]}\n`);
        mode = rows[at] === LABELS.stop ? "prompt" : "waiting";
        box = prefill!;
        draw();
      }
      continue;
    }
    if (mode !== "prompt") continue;
    if (s[i] === "\r") { appendFileSync(out!, `said: ${box}\n`); box = ""; draw(); continue; }
    if (s[i] === "\x7f") { box = box.slice(0, -1); draw(); continue; }
    if (s[i]! >= " ") { if (prefill && box === prefill) box = ""; box += s[i]; draw(); }
  }
});

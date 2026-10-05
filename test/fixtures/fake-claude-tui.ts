import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { promptDigest } from "../../src/delivery-evidence.ts";

/**
 * A stand-in for Claude Code's terminal, for the delivery tests that type into a real tmux pane: its input box
 * as 2.1.280 draws it (the `❯` line under a rule), keys taken the way the real one takes them, and the ways
 * a send has gone wrong there:
 *  - `startingMs`: still starting, with no box drawn yet, and every key dropped;
 *  - `lostReturns`: the words reach the box, and that many Returns are lost;
 *  - an unmarked burst: one read of over 800 characters outside a bracketed paste is lost (below).
 *
 * Pastes as 2.1.280 takes them: it turns bracketed paste on (`ESC [?2004h`) as it starts, and everything between
 * `ESC [200~` and `ESC [201~` is ONE paste, however many reads it arrives in, with its newlines kept as newlines.
 * A paste over 800 characters, or of more than two lines, shows in the box as `[Pasted text #1]` and is written
 * down wrapped in `<pasted_content>` tags, as Tyler's own 2.1.280 transcripts write it (an install signed in to no
 * account wrote the same paste plain, 2026-10-05; conch reads both).
 *
 * A submitted prompt is reported as the conch hook reports it: its fingerprint, with the time, and here the
 * prompt as written down too, on a line of `evidence`: `<ms> <digest> <JSON prompt>`. Given a `transcript`, it is
 * also written there as Claude Code's own user record.
 *
 *   bun fake-claude-tui.ts <evidence> [startingMs] [lostReturns] [transcript]
 */
const [, , evidence, startingMs = "0", lostReturns = "0", transcript] = process.argv;
if (!evidence) throw new Error("usage: fake-claude-tui.ts <evidence> [startingMs] [lostReturns] [transcript]");
const readyAt = Date.now() + Number(startingMs);
let lost = Number(lostReturns);
/** What the box shows: typed words, and a placeholder for each long paste. */
let box = "";
/** The long pastes behind the placeholders, in order: `[Pasted text #1]` is the first. */
let pastes: string[] = [];

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";
/** Claude Code 2.1.280's line between a paste shown in full and one shown as a placeholder, and between typing and a burst. */
const PASTE_CHARS = 800;
const PLACEHOLDER = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

const ready = () => Date.now() >= readyAt;
const draw = () => {
  const screen = ready()
    ? ["⏺ ready", "", `${"─".repeat(40)} alpha ─`, `❯ ${box.replace(/\n/g, "\r\n")}`, "─".repeat(48), "  ⏵⏵ bypass permissions on"]
    : ["✻ Starting…"];
  process.stdout.write(`\x1b[2J\x1b[H${screen.join("\r\n")}`);
};

const lines = (text: string) => (text.match(/\n/g) ?? []).length;

function takePaste(raw: string): void {
  const text = raw.replace(/\r\n|\r/g, "\n");
  if (text.length <= PASTE_CHARS && lines(text) <= 2) { box += text; return; }
  const id = pastes.push(text);
  box += lines(text) ? `[Pasted text #${id} +${lines(text)} lines]` : `[Pasted text #${id}]`;
}

function submit(): void {
  // What Claude Code writes down: each long paste in its tags, the rest as typed.
  const recorded = box.replace(PLACEHOLDER, (_, id: string) => {
    const tag = (Number(id) * 4099).toString(16).slice(-4).padStart(4, "0");
    return `\n\n<pasted_content id="${tag}">\n${pastes[Number(id) - 1] ?? ""}\n</pasted_content id="${tag}">\n`;
  });
  box = "";
  pastes = [];
  if (!recorded.trim()) return;
  appendFileSync(evidence!, `${Date.now()} ${promptDigest(recorded)} ${JSON.stringify(recorded)}\n`);
  if (transcript) {
    appendFileSync(transcript, JSON.stringify({
      type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: recorded },
    }) + "\n");
  }
}

function key(char: string): void {
  if (char === "\r") {
    if (lost > 0) { lost -= 1; return; }
    submit();
  } else if (char === "\x7f") {
    box = box.slice(0, -1);
  } else if (char >= " " || char === "\n") {
    box += char;
  }
}

/** Inside a bracketed paste, what has arrived of it so far; null between pastes. */
let paste: string | null = null;
/** The end of a read that may be the start of a marker the next read finishes. */
let held = "";
const decoder = new StringDecoder("utf8");

process.stdin.setRawMode(true);
process.stdin.resume();
// Like the real TUIs: ask the terminal (tmux, here) to mark pastes.
process.stdout.write("\x1b[?2004h");
process.stdin.on("data", (chunk: Buffer) => {
  if (!ready()) return;
  const input = held + decoder.write(chunk);
  held = "";
  // An unmarked burst: 2.1.280 takes a single read of over 800 characters as a paste of its own
  // (`key.length > 800` in its key handler), and tmux writes `send-keys -l` text in 1,022-byte reads. Sent
  // that way, 3,580 characters arrived as 1,022 + 1,022 + 1,022 + 514, and the prompt it recorded on
  // 2026-10-05 was exactly the last 514: none of the long reads survived. So none survive here.
  if (paste === null && !input.includes(OPEN) && input.length > PASTE_CHARS) { draw(); return; }
  let at = 0;
  while (at < input.length) {
    if (paste !== null) {
      const end = input.indexOf(CLOSE, at);
      if (end === -1) {
        const rest = input.slice(at);
        const partial = partialMarker(rest, CLOSE);
        paste += rest.slice(0, rest.length - partial);
        held = rest.slice(rest.length - partial);
        break;
      }
      takePaste(paste + input.slice(at, end));
      paste = null;
      at = end + CLOSE.length;
    } else if (input.startsWith(OPEN, at)) {
      paste = "";
      at += OPEN.length;
    } else if (input[at] === "\x1b" && partialMarker(input.slice(at), OPEN) === input.length - at) {
      held = input.slice(at);
      break;
    } else {
      key(input[at]!);
      at += 1;
    }
  }
  draw();
});
draw();
if (!ready()) setTimeout(draw, readyAt - Date.now());

/** How many characters at the end of `text` are the start of `marker`, cut off by the end of a read. */
function partialMarker(text: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/**
 * Daemon state, made visible twice over:
 *  - a live status line in the daemon's terminal (when it has a TTY)
 *  - /tmp/conch-state.json for anything else (menu-bar apps, status bars)
 */

export type ConchState = "idle" | "muted" | "paused" | "speaking" | "listening" | "recording" | "transcribing";

// Exported as a stable path for external consumers (menu-bar apps, status bars).
export const STATE_FILE = "/tmp/conch-state.json";

const GLYPHS: Record<ConchState, string> = {
  idle: "\x1b[2m◌ idle · space=wake m=mute p=pause ?=help\x1b[0m",
  muted: "\x1b[33m◌ muted\x1b[0m\x1b[2m · m to unmute\x1b[0m",
  paused: "\x1b[35m⏸ paused (away)\x1b[0m\x1b[2m · p or `conch resume` — holding your queue\x1b[0m",
  speaking: "\x1b[33m▶ speaking\x1b[0m",
  listening: "\x1b[32m● mic open\x1b[0m",
  recording: "\x1b[31m● recording\x1b[0m",
  transcribing: "\x1b[36m… transcribing\x1b[0m",
};

const tty = process.stdout.isTTY ?? false;
let statusLine = "";

export function setState(state: ConchState, label = "", partial = ""): void {
  void Bun.write(STATE_FILE, JSON.stringify({ state, label, partial, ts: Date.now() }) + "\n");
  if (!tty) return;
  let text = GLYPHS[state] + (label ? ` — ${label}` : "");
  if (partial) text += `  \x1b[2m▸\x1b[0m ${partial}`;
  statusLine = fitToWidth(text, (process.stdout.columns ?? 100) - 1);
  process.stdout.write("\r\x1b[K" + statusLine);
}

/** Print a log line without clobbering (or being clobbered by) the status line. */
export function logAbove(msg: string): void {
  if (tty && statusLine) process.stdout.write("\r\x1b[K");
  console.log(msg);
  if (tty && statusLine) process.stdout.write(statusLine);
}

function fitToWidth(text: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= width) return text;
  // overflow is always the partial-transcript tail; trim visible chars from the end
  let visible = 0;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      out += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (visible >= width - 1) break;
    out += text[i];
    visible++;
  }
  return out + "…\x1b[0m";
}

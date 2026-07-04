import { $ } from "bun";
import type { Config } from "./config.ts";

/**
 * Deliver a transcript into the session's prompt.
 *
 * Preferred: tmux send-keys targeted at the pane hosting the session's pid —
 * exact routing, works even when the pane isn't focused. Fallback (opt-in,
 * CONCH_KEYSTROKE_FALLBACK=1): osascript keystrokes into the frontmost app,
 * which is blind — only safe if you keep the session window focused.
 */
export async function injectText(
  cfg: Config,
  sessionPid: number | undefined,
  text: string,
): Promise<{ via: "tmux" | "osascript" | "none" }> {
  if (sessionPid) {
    const pane = await findTmuxPane(sessionPid);
    if (pane) {
      await $`tmux send-keys -t ${pane} -l ${text}`.quiet();
      if (cfg.autoSubmit) await $`tmux send-keys -t ${pane} Enter`.quiet();
      return { via: "tmux" };
    }
  }

  if (cfg.keystrokeFallback) {
    const script = [
      "on run argv",
      'tell application "System Events" to keystroke (item 1 of argv)',
      cfg.autoSubmit ? 'tell application "System Events" to keystroke return' : "",
      "end run",
    ].filter(Boolean);
    const args = script.flatMap((line) => ["-e", line]);
    await Bun.spawn(["osascript", ...args, "--", text], { stdout: "ignore", stderr: "ignore" }).exited;
    return { via: "osascript" };
  }

  return { via: "none" };
}

/** Press a single key in the session — Enter accepts a permission dialog's highlighted option, Escape dismisses it. */
export async function injectKey(
  cfg: Config,
  sessionPid: number | undefined,
  key: "Enter" | "Escape",
): Promise<{ via: "tmux" | "osascript" | "none" }> {
  if (sessionPid) {
    const pane = await findTmuxPane(sessionPid);
    if (pane) {
      await $`tmux send-keys -t ${pane} ${key}`.quiet();
      return { via: "tmux" };
    }
  }
  if (cfg.keystrokeFallback) {
    const keyCode = key === "Enter" ? 36 : 53;
    await Bun.spawn(
      ["osascript", "-e", `tell application "System Events" to key code ${keyCode}`],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    return { via: "osascript" };
  }
  return { via: "none" };
}

/** Find the tmux pane whose shell is an ancestor of the session's pid. */
async function findTmuxPane(sessionPid: number): Promise<string | null> {
  let panes: Array<{ pid: number; id: string }>;
  try {
    const out = await $`tmux list-panes -a -F "#{pane_pid} #{pane_id}"`.quiet().text();
    panes = out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, id] = line.split(" ");
        return { pid: Number(pid), id: id ?? "" };
      });
  } catch {
    return null; // no tmux server
  }
  if (!panes.length) return null;

  const ancestors = await ancestorPids(sessionPid);
  for (const pane of panes) {
    if (ancestors.has(pane.pid)) return pane.id;
  }
  return null;
}

async function ancestorPids(pid: number): Promise<Set<number>> {
  const seen = new Set<number>([pid]);
  let current = pid;
  for (let i = 0; i < 20 && current > 1; i++) {
    try {
      const out = await $`ps -o ppid= -p ${current}`.quiet().text();
      const ppid = Number(out.trim());
      if (!ppid || ppid <= 1 || seen.has(ppid)) break;
      seen.add(ppid);
      current = ppid;
    } catch {
      break;
    }
  }
  return seen;
}

import { readTerminalTab } from "./inject.ts";

/**
 * Whether an agent conch just started in a Terminal tab is running, by what the tab is running.
 *
 * Opening the tab is not starting the agent. 2026-10-18: `conch start claude --resume … --fork-session` printed "opened
 * Claude Code in Terminal" and exited 0 as soon as Terminal took the command; Claude Code started under the wrong account
 * profile, had no conversation to resume, and exited, and the agent that ran it told the user the fork was open. Every
 * start runs its agent with `exec` (`terminalSessionCommand`), so the agent replaces the tab's shell, and a tab running
 * nothing is a tab whose agent has gone.
 */

/** What a tab is running: the agent, only its shell still (the command not yet run, or stopped on an error), nothing, or unknown. */
export type TabAgentState = "running" | "starting" | "gone" | "unknown";

/** A tab's processes (`ps -t <tty> -o args=`) read as `TabAgentState`; null is a tab conch couldn't read. */
export function tabAgentState(commands: readonly string[] | null, executable: string): TabAgentState {
  if (commands === null) return "unknown";
  if (!commands.length) return "gone";
  const agent = new RegExp(`(^|/)${executable}$`);
  // The executable, or a runtime running it (`node …/bin/claude`): one of a command's first words.
  return commands.some((command) => command.trim().split(/\s+/).slice(0, 3).some((word) => agent.test(word))) ? "running" : "starting";
}

/** The last few lines a tab showed, for an error: what the agent said as it went ("No conversation found …"). */
export function lastTabLines(contents: string | null | undefined, lines = 6, max = 600): string | undefined {
  const shown = (contents ?? "").split("\n").map((line) => line.trimEnd())
    .filter((line) => line.trim() && line.trim() !== "[Process completed]");
  const tail = shown.slice(-lines).join("\n").trim();
  return tail ? tail.slice(-max) : undefined;
}

/** The command lines running in one Terminal tab, by its tty (`ttys012`); null when `ps` can't say. */
export async function terminalTabCommands(tty: string): Promise<string[] | null> {
  if (!/^ttys?\d+$/.test(tty)) return null;
  try {
    const child = Bun.spawn(["ps", "-t", tty, "-o", "args="], { stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    // `ps -t` exits 1 when the tty has no processes (or no longer exists), which is an answer, not a failure.
    if (await child.exited !== 0 && output.trim()) return null;
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

export interface AgentStartWatch {
  state(): Promise<TabAgentState>;
  lastWords(): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** A Terminal tab's own watch: its processes and its text. */
export function terminalTabWatch(tty: string, executable: string): AgentStartWatch {
  return {
    state: async () => tabAgentState(await terminalTabCommands(tty), executable),
    lastWords: async () => lastTabLines(await readTerminalTab(tty)),
    sleep: (ms) => Bun.sleep(ms),
    now: Date.now,
  };
}

/**
 * Whether the agent a start opened is up: running for `steadyMs` once seen, or still running when `withinMs` runs out.
 * Not up: it went (with what its tab last showed), or its tab never ran it. What `conch start` waits on before it says
 * "opened".
 */
export async function confirmAgentStarted(
  watch: AgentStartWatch,
  options: { withinMs?: number; steadyMs?: number; everyMs?: number } = {},
): Promise<{ ok: true; state: TabAgentState } | { ok: false; why: string; lastWords?: string }> {
  const { withinMs = 10_000, steadyMs = 3_000, everyMs = 500 } = options;
  const started = watch.now();
  let runningSince: number | undefined;
  for (;;) {
    const state = await watch.state();
    const now = watch.now();
    if (state === "unknown") return { ok: true, state };
    if (state === "gone") {
      const lastWords = await watch.lastWords().catch(() => undefined);
      return { ok: false, why: "exited as soon as it started", ...(lastWords ? { lastWords } : {}) };
    }
    if (state === "running") {
      runningSince ??= now;
      if (now - runningSince >= steadyMs) return { ok: true, state };
    }
    if (now - started >= withinMs) {
      if (state === "running") return { ok: true, state };
      const lastWords = await watch.lastWords().catch(() => undefined);
      return { ok: false, why: "never started: its tab is still at the shell", ...(lastWords ? { lastWords } : {}) };
    }
    await watch.sleep(everyMs);
  }
}

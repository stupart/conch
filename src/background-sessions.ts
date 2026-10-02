import { conchPane, conchTmux, paneTarget, qualifyPane, resolveTmux, tmuxServers } from "./tmux-binary.ts";
import { randomUUID } from "node:crypto";
import { probeCommand } from "./probe.ts";

/** A detached terminal owned by Conch. The tmux server outlives the app/daemon;
 * existing transcript, input, permission and stop paths still address the CLI. */
export const BACKGROUND_NAME = /^conch-[0-9a-f-]{36}$/;
type Probe = typeof probeCommand;

/**
 * Start a session on conch's own tmux server (`conchTmux`), never the user's default one.
 *
 * The agent runs without `TMUX` / `TMUX_PANE`. tmux sets both in every pane, and they point at the server the
 * pane is on: a plain `tmux kill-server` typed by the agent — or by any script it runs — would reach conch's
 * server through them and end every background session at once, the agent's own included (2026-10-02). Without
 * them, the agent's tmux commands address the user's default server, as they would from any terminal.
 */
export async function startBackgroundProcess(command: string, cwd: string, probe: Probe = probeCommand): Promise<{ name: string; pane: string }> {
  if (!resolveTmux().found) throw new Error("Background sessions need tmux. Reinstall Conch’s bundled helpers or install tmux, then try again.");
  const tmux = conchTmux();
  const name = `conch-${randomUUID()}`;
  const result = await probe([...tmux, "new-session", "-d", "-s", name, "-x", "140", "-y", "45", "-c", cwd,
    "-e", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "-P", "-F", "#{pane_id}",
    "/bin/zsh", "-lc", `export CONCH_BACKGROUND_PID=$$; unset TMUX TMUX_PANE; ${command}`], [0], 4_000);
  const pane = result?.trim();
  if (!pane || !/^%\d+$/.test(pane)) throw new Error("Could not start the background terminal. No Terminal window was opened.");
  // Kept running while empty, so a session that ends leaves the server up and a server that is gone always means
  // it was stopped (`background-recovery.ts`), never that its last session simply finished.
  await probe([...tmux, "set-option", "-g", "exit-empty", "off"], [0]);
  await Bun.sleep(150);
  const dead = await probe([...tmux, "display-message", "-p", "-t", pane, "#{pane_dead}"], [0]);
  if (dead?.trim() !== "0") throw new Error("The background process exited during startup. Try Terminal to see the provider’s startup error.");
  return { name, pane: conchPane(pane) };
}

/** An exact pane process and a Conch-owned name, never a folder/title match. On either server: one started
 * before conch had its own is still on the default server. The pane comes back named with its server. */
export async function managedBackgroundSession(pid: number, probe: Probe = probeCommand): Promise<{ name: string; pane: string } | undefined> {
  for (const server of tmuxServers()) {
    const rows = await probe([...server, "list-panes", "-a", "-F", "#{pane_pid} #{pane_id} #{session_name}"], [0]);
    for (const row of rows?.split("\n") ?? []) {
      const [owner, pane, name] = row.trim().split(/\s+/);
      if (Number(owner) === pid && /^%\d+$/.test(pane ?? "") && BACKGROUND_NAME.test(name ?? "")) {
        return { name: name!, pane: qualifyPane(server, pane!) };
      }
    }
  }
}

/** Only the exact Claude trust prompt, and only after the user agreed in Conch. */
export async function acceptBackgroundTrust(pane: string, probe: Probe = probeCommand): Promise<boolean> {
  const target = paneTarget(pane);
  if (!target) throw new Error("Invalid background pane");
  // 30 s: a resumed conversation can take far longer than a fresh one to reach the prompt, and a prompt
  // nobody answers holds the session off the list until someone finds it (2026-10-02, a resume left waiting).
  for (let attempt = 0; attempt < 120; attempt++) {
    const screen = await probe([...target.tmux, "capture-pane", "-p", "-t", target.pane], [0]);
    if (screen === null) return false;
    if (screen.includes("Yes, I trust this folder") && screen.includes("No, exit")) {
      // Claude's default is No. Down wraps to Yes without relying
      // on a terminal window or changing any global keyboard focus.
      return await probe([...target.tmux, "send-keys", "-t", target.pane, "Down", "Enter"], [0]) !== null;
    }
    await Bun.sleep(250);
  }
  return false;
}

/** Startup may be waiting on login before it has a conversation ID. */
export async function backgroundStartupPid(name: string, probe: Probe = probeCommand): Promise<number | undefined> {
  if (!BACKGROUND_NAME.test(name)) return;
  for (const server of tmuxServers()) {
    const rows = await probe([...server, "list-panes", "-a", "-F", "#{pane_pid} #{session_name}"], [0]);
    for (const row of rows?.split("\n") ?? []) {
      const [pid, owner] = row.trim().split(/\s+/);
      if (owner === name && /^[1-9]\d*$/.test(pid ?? "")) return Number(pid);
    }
  }
}

/**
 * The conch-owned background sessions on conch's own server right now, by name; null when that cannot be
 * read for any reason other than there being no server — which is an answer: none.
 */
export async function conchServerSessions(probe: Probe = probeCommand): Promise<Set<string> | null> {
  const rows = await probe([...conchTmux(), "list-sessions", "-F", "#{session_name}"], [0, 1]);
  if (rows === null) return null;
  return new Set(rows.split("\n").map((row) => row.trim()).filter((name) => BACKGROUND_NAME.test(name)));
}

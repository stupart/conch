import { defaultTmuxExecutable } from "./tmux-binary.ts";
import { randomUUID } from "node:crypto";
import { probeCommand } from "./probe.ts";

/** A detached terminal owned by Conch. The tmux server outlives the app/daemon;
 * existing transcript, input, permission and stop paths still address the CLI. */
export const BACKGROUND_NAME = /^conch-[0-9a-f-]{36}$/;
type Probe = typeof probeCommand;

export async function startBackgroundProcess(command: string, cwd: string, probe: Probe = probeCommand): Promise<{ name: string; pane: string }> {
  if (!Bun.which(defaultTmuxExecutable())) throw new Error("Background sessions need tmux. Reinstall Conch’s bundled helpers or install tmux, then try again.");
  const name = `conch-${randomUUID()}`;
  const result = await probe([defaultTmuxExecutable(), "new-session", "-d", "-s", name, "-x", "140", "-y", "45", "-c", cwd,
    "-e", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "-P", "-F", "#{pane_id}",
    "/bin/zsh", "-lc", `export CONCH_BACKGROUND_PID=$$; ${command}`], [0], 4_000);
  const pane = result?.trim();
  if (!pane || !/^%\d+$/.test(pane)) throw new Error("Could not start the background terminal. No Terminal window was opened.");
  await Bun.sleep(150);
  const dead = await probe([defaultTmuxExecutable(), "display-message", "-p", "-t", pane, "#{pane_dead}"], [0]);
  if (dead?.trim() !== "0") throw new Error("The background process exited during startup. Try Terminal to see the provider’s startup error.");
  return { name, pane };
}

/** An exact pane process and a Conch-owned name, never a folder/title match. */
export async function managedBackgroundSession(pid: number, probe: Probe = probeCommand): Promise<{ name: string; pane: string } | undefined> {
  const rows = await probe([defaultTmuxExecutable(), "list-panes", "-a", "-F", "#{pane_pid} #{pane_id} #{session_name}"], [0]);
  for (const row of rows?.split("\n") ?? []) {
    const [owner, pane, name] = row.trim().split(/\s+/);
    if (Number(owner) === pid && /^%\d+$/.test(pane ?? "") && BACKGROUND_NAME.test(name ?? "")) return { name: name!, pane: pane! };
  }
}

/** Only the exact Claude trust prompt, and only after the user agreed in Conch. */
export async function acceptBackgroundTrust(pane: string, probe: Probe = probeCommand): Promise<boolean> {
  if (!/^%\d+$/.test(pane)) throw new Error("Invalid background pane");
  for (let attempt = 0; attempt < 24; attempt++) {
    const screen = await probe([defaultTmuxExecutable(), "capture-pane", "-p", "-t", pane], [0]);
    if (screen === null) return false;
    if (screen.includes("Yes, I trust this folder") && screen.includes("No, exit")) {
      // Claude's default is No. Down wraps to Yes without relying
      // on a terminal window or changing any global keyboard focus.
      return await probe([defaultTmuxExecutable(), "send-keys", "-t", pane, "Down", "Enter"], [0]) !== null;
    }
    await Bun.sleep(250);
  }
  return false;
}

/** Startup may be waiting on login before it has a conversation ID. */
export async function backgroundStartupPid(name: string, probe: Probe = probeCommand): Promise<number | undefined> {
  if (!BACKGROUND_NAME.test(name)) return;
  const rows = await probe([defaultTmuxExecutable(), "list-panes", "-a", "-F", "#{pane_pid} #{session_name}"], [0]);
  for (const row of rows?.split("\n") ?? []) {
    const [pid, owner] = row.trim().split(/\s+/);
    if (owner === name && /^[1-9]\d*$/.test(pid ?? "")) return Number(pid);
  }
}

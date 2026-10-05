import { conchPane, conchTmux, paneTarget, qualifyPane, resolveTmux, tmuxServers } from "./tmux-binary.ts";
import { randomUUID } from "node:crypto";
import { probeCommand } from "./probe.ts";
import { claudeInputBoxText } from "./agent-adapter.ts";

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

/**
 * How typing a yes into Claude's trust prompt went: typed; not needed, because the session reached its input box
 * without asking (the folder was already trusted — a non-default account's trust can't be read beforehand, so the
 * app asks anyway); never shown before the wait ran out, the session still there; or the session is gone.
 */
export type BackgroundTrustOutcome = "answered" | "not asked" | "never appeared" | "the session ended";

/**
 * Only the exact Claude trust prompt, and only after the user agreed in Conch.
 *
 * 2026-10-05, Tyler: "trying to start a new session (background session with claude account) and it didn't start …
 * and the modal didn't close". This gave up on the first capture that failed — under load, a probe past its 2 s — and
 * after 30 s, and said so to no one: the session sat on the prompt. A failed look is a reason to look again; only the
 * pane being gone ends the wait early. 60 s: a resumed conversation can take far longer than a fresh one to reach
 * the prompt (2026-10-02, a resume left waiting). `waitMs` and `intervalMs` are for tests.
 */
export async function acceptBackgroundTrust(
  pane: string,
  probe: Probe = probeCommand,
  { waitMs = 60_000, intervalMs = 250 }: { waitMs?: number; intervalMs?: number } = {},
): Promise<BackgroundTrustOutcome> {
  const target = paneTarget(pane);
  if (!target) throw new Error("Invalid background pane");
  const deadline = Date.now() + waitMs;
  for (;;) {
    let pause = intervalMs;
    const screen = await probe([...target.tmux, "capture-pane", "-p", "-t", target.pane], [0]);
    if (screen === null) {
      if (await paneGone(target, probe)) return "the session ended";
    } else if (screen.includes("Yes, I trust this folder") && screen.includes("No, exit")) {
      // Claude's default is No, and Down wraps to Yes, without a terminal window or any global keyboard focus. Yes
      // already highlighted is a Down that landed from a send that reported failure: Enter alone, never Down again.
      const yesHighlighted = screen.split("\n").some((line) => line.includes("Yes, I trust this folder") && line.includes("❯"));
      const keys = yesHighlighted ? ["Enter"] : ["Down", "Enter"];
      if (await probe([...target.tmux, "send-keys", "-t", target.pane, ...keys], [0]) !== null) return "answered";
      // Keys that may have landed late are given time to show before the screen is believed again.
      pause = Math.max(intervalMs, 2_000);
    } else if (claudeInputBoxText(screen) !== null) {
      return "not asked";
    }
    if (Date.now() + pause > deadline) return await paneGone(target, probe) ? "the session ended" : "never appeared";
    await Bun.sleep(pause);
  }
}

/** Only an answer from tmux that the pane is gone, or its process exited; a look that failed says nothing. */
async function paneGone(target: { tmux: string[]; pane: string }, probe: Probe): Promise<boolean> {
  // Exit 1 with nothing listed is tmux with no server to ask: every pane on it is gone.
  const rows = await probe([...target.tmux, "list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"], [0, 1]);
  if (rows === null) return false;
  const row = rows.split("\n").map((line) => line.trim().split(/\s+/)).find(([id]) => id === target.pane);
  return !row || row[1] === "1";
}

/**
 * What the daemon says of a typed yes once it is known: a line in its log always, and an error to file when the
 * session is still there and still not past the prompt — the case that otherwise looks, from the app, exactly like a
 * session that is merely slow.
 */
export function backgroundTrustReport(name: string, outcome: BackgroundTrustOutcome): { line: string; error?: string } {
  const line = `trust prompt in ${name}: ${outcome}`;
  if (outcome !== "never appeared") return { line };
  return { line, error: `Claude's trust prompt never appeared in ${name}, so the yes from the app was not typed. It may be waiting at a login or other prompt: open its startup terminal.` };
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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * One Claude login that rotates across your Max accounts (2026-10-09, Tyler: "ideally its like one account that just
 * rotates to the next max account via logout and login when one hits its limit").
 *
 * claude-swap (MIT, realiti4/claude-swap; its dashboard is already adapted in claude-swap.ts) does the switching. It keeps
 * each account's credential and swaps the Default profile's login under Claude Code's own credential locks, so a swap
 * never collides with a token refresh, and a running session picks the new account up when Claude Code's Keychain cache
 * expires (about 30 s on macOS). conch installs it with the uv it carries, adds an account to it after an in-app sign-in
 * (`cswap add` captures whoever Default is signed in as), runs its auto-switcher while `claude-rotation` is on, and says
 * when it switched. Rotation is the Default profile's alone: conch's other profiles keep their own logins.
 */

/** Where `cswap` is: on PATH, or uv's tool bin, where `uv tool install` puts it. */
export function swapExecutable(which: (name: string) => string | null = Bun.which, home = conchHome()): string | undefined {
  const onPath = which("cswap");
  if (onPath) return onPath;
  const installed = join(home, ".local", "bin", "cswap");
  return existsSync(installed) ? installed : undefined;
}

/**
 * The Default profile's environment, which is the one rotation swaps: no CLAUDE_CONFIG_DIR (naming ~/.claude can select a
 * different Keychain entry), and nothing that would sign in another way.
 */
export function rotationEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

export interface CommandOutcome { ok: boolean; output: string }

async function run(argv: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandOutcome> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { ok: code === 0, output: `${out}${err}`.trim().slice(-2_000) };
  } finally {
    clearTimeout(timer);
  }
}

/** `uv tool install claude-swap`, with the uv conch carries (CONCH_UV) or the one on PATH. */
export async function installClaudeSwap(uv = process.env.CONCH_UV || Bun.which("uv") || ""): Promise<CommandOutcome> {
  if (!uv) return { ok: false, output: "conch couldn't find uv to install claude-swap with." };
  return run([uv, "tool", "install", "claude-swap"], process.env, 180_000);
}

/** `cswap add`: the account Default is signed in as now joins the rotation (updated in place if it's already there). */
export async function addSignedInAccountToRotation(cswap = swapExecutable()): Promise<CommandOutcome> {
  if (!cswap) return { ok: false, output: "claude-swap isn't installed." };
  return run([cswap, "add"], rotationEnvironment(), 60_000);
}

/** One line of `cswap auto --json` worth telling you about, or undefined for the rest (polls, sleeps, no-switch). */
export function describeSwapEvent(line: string): string | undefined {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  const who = (ref: unknown): string => {
    if (!ref || typeof ref !== "object") return "another account";
    const value = ref as Record<string, unknown>;
    return typeof value.email === "string" ? value.email : typeof value.number === "number" ? `account ${value.number}` : "another account";
  };
  switch (event.event) {
    case "switch": {
      if (event.dry_run === true || event.dryRun === true) return undefined;
      const why = event.trigger === "at-limit" ? "at its limit" : event.trigger === "failover" ? "unusable" : "near its limit";
      return `switched Claude from ${who(event.from)} (${why}) to ${who(event.to)}`;
    }
    case "all-exhausted":
      return "every Claude account in the rotation is at its limit; waiting for the first reset";
    case "account-quarantined":
      return `${who(event)} left the rotation: its sign-in has expired (sign it in again to bring it back)`;
    case "error":
      return event.transient === true ? undefined : `claude-swap: ${typeof event.message === "string" ? event.message.slice(0, 200) : "an error"}`;
    default:
      return undefined;
  }
}

/**
 * `cswap auto --json` while rotation is on: started, restarted with a growing pause if it stops on its own, stopped when
 * rotation goes off or the daemon does.
 */
export class RotationSupervisor {
  #child: ReturnType<typeof Bun.spawn> | undefined;
  #wanted = false;
  #restarts = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly report: (line: string) => void,
    private readonly executable: () => string | undefined = () => swapExecutable(),
  ) {}

  get running(): boolean {
    return this.#child !== undefined;
  }

  set(on: boolean): void {
    this.#wanted = on;
    if (on) this.#start();
    else this.stop();
  }

  stop(): void {
    this.#wanted = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#child?.kill();
    this.#child = undefined;
  }

  #start(): void {
    if (this.#child || !this.#wanted) return;
    const cswap = this.executable();
    if (!cswap) {
      this.report("account rotation is on, but claude-swap isn't installed");
      return;
    }
    const child = Bun.spawn([cswap, "auto", "--json"], { env: rotationEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    this.#child = child;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of child.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end; (end = buffer.indexOf("\n")) >= 0;) {
          const said = describeSwapEvent(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (said) this.report(said);
        }
      }
    })().catch(() => {});
    void child.exited.then((code) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      if (!this.#wanted) return;
      this.#restarts += 1;
      const pause = Math.min(300_000, 5_000 * 2 ** Math.min(this.#restarts, 6));
      this.report(`claude-swap's switcher stopped (exit ${code}); starting it again in ${Math.round(pause / 1000)} s`);
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#start();
      }, pause);
      this.#timer.unref?.();
    });
  }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_NAME } from "./background-sessions.ts";
import type { StartSessionRequest } from "./session-lifecycle.ts";
import { conchTmux, defaultTmux } from "./tmux-binary.ts";

/**
 * Background sessions come back when their tmux server dies under them.
 *
 * A background session lives in a tmux server, and a server can go: killed (`tmux kill-server` — on 2026-10-02
 * one run inside a session ended all seven of the user's, mid-task), crashed, or gone with a restart of the
 * Mac. Each session's conversation is still on disk, and conch knows exactly how it was launched; the user had
 * to find and resume every one by hand, and wondered whether they had really been turned off.
 *
 * So conch keeps, for each background session it can see, how to start it again (`restartRequest`, read from
 * its live command line, as conch's own Restart does), and decides on every complete registry read:
 *
 *  - still on its server: kept;
 *  - gone while its server still runs: it ended on its own (`/exit`, conch's Close, Ctrl-D) — forgotten. conch's
 *    own server is kept running while empty (`exit-empty off`, `startBackgroundProcess`) so that this always
 *    holds there; on the user's default server, where conch sets nothing, a server that vanished with only one
 *    of conch's sessions on it may simply have emptied, and that one is forgotten rather than guessed at;
 *  - its server gone: resumed, as a background session again — but only when its conversation is not running
 *    anywhere (a terminal, Claude Code's own background daemon, another resume), and at most a few times a day;
 *  - a server that could not be read: nothing is decided.
 *
 * A resumed session comes back between turns. Its history is intact; a step it was in the middle of is not
 * re-run, so the person picks up from there.
 */

export type BackgroundServer = "conch" | "default";

export interface BackgroundRecord {
  /** The tmux session it ran in: `conch-<uuid>`. */
  name: string;
  server: BackgroundServer;
  /** The conversation to resume. */
  conversationId: string;
  label: string;
  /** How to start it again, as a background session resuming `conversationId`. */
  request: StartSessionRequest;
  /** Epoch ms it was last seen running. */
  seenAt: number;
}

export interface ServerReading {
  state: "running" | "gone" | "unknown";
  /** conch's sessions on it, by name, with the pid of each one's pane. Empty unless running. */
  panes: Map<number, string>;
}

export interface RecoveryPlan {
  resume: BackgroundRecord[];
  /** Names whose records go: ended on purpose, running elsewhere, or out of tries. */
  forget: Array<{ name: string; why: string }>;
}

/** Tries per conversation in this many hours. */
export const RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_TRIES = 3;

export function planRecovery(input: {
  records: readonly BackgroundRecord[];
  servers: Readonly<Record<BackgroundServer, ServerReading>>;
  /** Every conversation the registry shows running, anywhere. */
  liveConversations: ReadonlySet<string>;
  /** Earlier recoveries, by conversation, epoch ms. */
  attempts: ReadonlyMap<string, readonly number[]>;
  now: number;
}): RecoveryPlan {
  const plan: RecoveryPlan = { resume: [], forget: [] };
  const running = (server: BackgroundServer) => new Set(input.servers[server].panes.values());
  const lostOnDefault = input.records.filter((record) => record.server === "default").length;
  for (const record of input.records) {
    const server = input.servers[record.server];
    if (server.state === "unknown") continue;
    if (server.state === "running") {
      if (!running(record.server).has(record.name)) plan.forget.push({ name: record.name, why: "ended on its own" });
      continue;
    }
    if (record.server === "default" && lostOnDefault < 2) {
      plan.forget.push({ name: record.name, why: "its server emptied" });
      continue;
    }
    if (input.liveConversations.has(record.conversationId)) {
      plan.forget.push({ name: record.name, why: "it is running elsewhere" });
      continue;
    }
    const recent = (input.attempts.get(record.conversationId) ?? []).filter((at) => input.now - at < RECOVERY_WINDOW_MS);
    if (recent.length >= RECOVERY_TRIES) {
      plan.forget.push({ name: record.name, why: `already brought back ${recent.length} times today` });
      continue;
    }
    plan.resume.push(record);
  }
  return plan;
}

/** What `list-panes` on a server says: its sessions, that there is no server, or no answer. */
export function readServerListing(exitCode: number, stdout: string, stderr: string): ServerReading {
  if (exitCode === 0) {
    const panes = new Map<number, string>();
    for (const row of stdout.split("\n")) {
      const [pid, name] = row.trim().split(/\s+/);
      if (/^[1-9]\d*$/.test(pid ?? "") && BACKGROUND_NAME.test(name ?? "")) panes.set(Number(pid), name!);
    }
    return { state: "running", panes };
  }
  // tmux's own words for a server that isn't there: no socket file, or a socket nothing listens on.
  return /no server running|error connecting to|No such file or directory|Connection refused/i.test(stderr)
    ? { state: "gone", panes: new Map() }
    : { state: "unknown", panes: new Map() };
}

async function readServer(tmux: string[]): Promise<ServerReading> {
  try {
    const child = Bun.spawn([...tmux, "list-panes", "-a", "-F", "#{pane_pid} #{session_name}"], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return readServerListing(code, stdout, stderr);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { state: "unknown", panes: new Map() };
  }
}

/** A session in the registry, as much of it as recovery reads. */
export interface ObservedSession {
  sessionId: string;
  agentSessionId?: string;
  label?: string;
  pid?: number;
  /** A Claude Code background job: hosted by Claude Code's own daemon, which a tmux server's end does not reach. */
  jobId?: string;
}

export interface BackgroundGuardOptions {
  file: string;
  /** How to start a session again (`restartRequest` over its live command line); null when it can't be read. */
  relaunchFor(session: ObservedSession): Promise<StartSessionRequest | null>;
  launch(request: StartSessionRequest): Promise<unknown>;
  log(message: string): void;
  readServers?(): Promise<Record<BackgroundServer, ServerReading>>;
  now?(): number;
}

interface Stored {
  records: BackgroundRecord[];
  attempts: Record<string, number[]>;
}

export class BackgroundGuard {
  readonly #options: BackgroundGuardOptions;
  #records = new Map<string, BackgroundRecord>();
  #attempts = new Map<string, number[]>();
  #running: Promise<void> | null = null;

  constructor(options: BackgroundGuardOptions) {
    this.#options = options;
    try {
      const stored = JSON.parse(readFileSync(options.file, "utf8")) as Stored;
      for (const record of stored.records ?? []) {
        if (record && BACKGROUND_NAME.test(record.name) && typeof record.conversationId === "string") this.#records.set(record.name, record);
      }
      for (const [id, times] of Object.entries(stored.attempts ?? {})) {
        if (Array.isArray(times)) this.#attempts.set(id, times.filter((at) => typeof at === "number"));
      }
    } catch {}
  }

  records(): BackgroundRecord[] {
    return [...this.#records.values()];
  }

  /**
   * After a COMPLETE registry read: note what runs, bring back what its server took with it. One at a time; a
   * read that arrives while one is under way is skipped, and the next one sees its result.
   */
  observe(sessions: readonly ObservedSession[], liveConversations: ReadonlySet<string>): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#observe(sessions, liveConversations).finally(() => { this.#running = null; });
    return this.#running;
  }

  async #observe(sessions: readonly ObservedSession[], liveConversations: ReadonlySet<string>): Promise<void> {
    const now = this.#options.now?.() ?? Date.now();
    const servers = await (this.#options.readServers ?? (async () => ({
      conch: await readServer(conchTmux()),
      default: await readServer(defaultTmux()),
    })))();
    let changed = false;

    // What runs now. A job Claude Code's own daemon hosts outlives any tmux server: nothing to record.
    for (const session of sessions) {
      if (!session.pid || session.jobId) continue;
      const server: BackgroundServer | undefined = servers.conch.panes.has(session.pid) ? "conch"
        : servers.default.panes.has(session.pid) ? "default" : undefined;
      if (!server) continue;
      const name = servers[server].panes.get(session.pid)!;
      const conversationId = session.agentSessionId ?? session.sessionId;
      const known = this.#records.get(name);
      if (known && known.conversationId === conversationId) {
        // Written back now and then, not on every read: the file is for after a restart, not a clock.
        if (now - known.seenAt > 5 * 60_000 || (session.label && session.label !== known.label)) {
          known.seenAt = now;
          known.label = session.label ?? known.label;
          changed = true;
        }
        continue;
      }
      const request = await this.#options.relaunchFor(session).catch(() => null);
      if (!request) continue;
      this.#records.set(name, {
        name, server, conversationId, label: session.label ?? conversationId,
        request: { ...request, host: "background", resumeSessionId: conversationId }, seenAt: now,
      });
      changed = true;
    }

    const plan = planRecovery({ records: this.records(), servers, liveConversations, attempts: this.#attempts, now });
    for (const { name, why } of plan.forget) {
      const record = this.#records.get(name);
      this.#records.delete(name);
      changed = true;
      if (record && why !== "ended on its own") this.#options.log(`not bringing back "${record.label}": ${why}`);
    }
    for (const record of plan.resume) {
      this.#records.delete(record.name);
      this.#attempts.set(record.conversationId, [...(this.#attempts.get(record.conversationId) ?? []), now]);
      changed = true;
      try {
        // It already ran in this folder: its trust was given then.
        await this.#options.launch({ ...record.request, trustFolder: true });
        this.#options.log(`brought back "${record.label}": its tmux server stopped, and it was not running anywhere`);
      } catch (error) {
        this.#options.log(`could not bring back "${record.label}": ${(error as Error).message}`);
      }
    }
    if (changed) this.#save();
  }

  #save(): void {
    const stored: Stored = { records: this.records(), attempts: Object.fromEntries(this.#attempts) };
    try {
      mkdirSync(dirname(this.#options.file), { recursive: true });
      const temp = `${this.#options.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
      renameSync(temp, this.#options.file);
    } catch {}
  }
}

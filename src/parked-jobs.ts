import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { adapterFor, claudeInputBoxText } from "./agent-adapter.ts";
import { hasConversation, liveTranscriptPath } from "./claude-title.ts";
import { jobLiveness } from "./dead-target.ts";
import type { TurnEvent } from "./hook.ts";
import { probeCommand } from "./probe.ts";
import { attachTerminalCommand } from "./session-lifecycle.ts";
import { currentName, type RegistrySnapshot, type SessionInfo } from "./sessions.ts";
import { conchTmux, resolveTmux } from "./tmux-binary.ts";

/**
 * Claude Code background agents parked waiting on you.
 *
 * A background agent (`claude --bg`, listed by `claude agents`) that stops to ask you something is `blocked` in its
 * job record, `<claude config>/jobs/<shortId>/state.json`, and Claude Code then stops its process. conch listed only
 * sessions with a live process, so an agent dropped out of every conch surface the moment it asked: on 2026-10-24
 * Tyler found two that had been waiting on him since Oct 21 ("Agent - Settings page a…" and "Copy edits -
 * Settings page a…"), with nothing anywhere showing them. `claude attach <shortId>` brings one back —
 * Claude Code respawns its process and the agent is an ordinary live background job again — and that is how they were
 * found: in a hidden `tmux -L conch` window, each was a live, waiting row within ~12 s, with nothing sent to it.
 *
 * So each parked job is a row (`parkedSessions`), under its conversation's id: the id its live row has once anything
 * attaches, so the two are one row that comes back to life, never two. Its record says what it waits on (`needs`),
 * which is the row's question. Opening it (the apps' "Open in Terminal") attaches a Terminal window, as for any job
 * no window is attached to; a reply to it (voice, phone, typed) first attaches it out of sight on conch's own tmux
 * server and waits for it to come up (`ParkedJobAttacher`), then goes in through the ordinary inject path.
 *
 * Not to be confused with `parkedJobId` in sessions.ts, Claude Code's own word for a WINDOW parked on a job it moved
 * into the background. That window is live; a parked job here has no process at all.
 */

/**
 * How long a parked job stays a row: two weeks since its record last changed. Long enough that a week away — the way
 * a question actually gets forgotten; the two found on 2026-10-24 had waited three days — never hides one. Past it, a
 * question has almost always been overtaken by the work around it (its branch moved on, its PRs merged), and putting
 * it at the top of the list in the needs colour would be noise; it is still in `claude agents --all` and in conch's
 * Resume. Claude Code deletes job records itself after its own retention (`cleanupPeriodDays`, 30 days by default).
 */
export const PARKED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** How long a reply waits for a parked job to come back before saying it couldn't. A resumed conversation can be slow. */
export const PARKED_ATTACH_WAIT_MS = 60_000;

/** The hidden window a reply attaches a parked job in, on conch's own tmux server. The name Tyler's own fix used. */
export const PARKED_ATTACH_PREFIX = "conch-attach-";

/** A job's short id as Claude Code prints it, the same rule `claude attach` is given (session-lifecycle.ts). */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** Claude Code's `needs` for a job that never had a prompt (2.1.309, `Cb`): a spare slot, not an agent waiting on you. */
const UNSTARTED_NEEDS = "send a prompt to start";
/** A question longer than this is cut: it is a row's second line, and the conversation holds all of it. */
const MAX_NEEDS = 280;

/** One parked job, as much of its record as conch shows. */
export interface ParkedJob {
  /** The short id `claude attach` takes: its `daemonShort`, which also names its folder. */
  jobId: string;
  /** Its conversation: the row's id, parked or live. */
  sessionId: string;
  name?: string;
  cwd?: string;
  /** What it waits on you for, in its own words (`needs`, else its `detail`), as one line. */
  needs?: string;
  /** Epoch ms its record last changed (`updatedAt`): when it parked, near enough. */
  since: number;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_NEEDS ? `${flat.slice(0, MAX_NEEDS - 1).trimEnd()}…` : flat;
}

/**
 * A job record that is waiting on you, or null. Claude Code's own rules for the job it would wake (2.1.309): `blocked`
 * (`bgt`), unless it is an `exec` job with no flags to respawn it with (`_v`), or blocked only because it never had a
 * prompt (`dn`). Only jobs Claude Code's daemon hosts: `claude attach` is what brings one back. `fallbackSince` is the
 * file's mtime, for a record with no readable `updatedAt`.
 */
export function parkedJobFromState(folder: string, value: unknown, fallbackSince?: number): ParkedJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.state !== "blocked") return null;
  if (state.template === "exec" && (!Array.isArray(state.respawnFlags) || state.respawnFlags.length === 0)) return null;
  if (state.intent === "" && state.needs === UNSTARTED_NEEDS) return null;
  if (state.backend !== undefined && state.backend !== "daemon") return null;
  const sessionId = text(state.sessionId);
  if (!sessionId || !SESSION_ID.test(sessionId)) return null;
  const jobId = text(state.daemonShort) ?? folder;
  if (!JOB_ID.test(jobId)) return null;
  const since = Date.parse(text(state.updatedAt) ?? "") || fallbackSince;
  if (!since || !Number.isFinite(since)) return null;
  const needs = text(state.needs) ?? text(state.detail);
  const name = text(state.name);
  const cwd = text(state.cwd);
  return {
    jobId,
    sessionId,
    since,
    ...(name ? { name: name.trim() } : {}),
    ...(cwd?.startsWith("/") ? { cwd } : {}),
    ...(needs ? { needs: oneLine(needs) } : {}),
  };
}

/**
 * Every job record in a Claude config folder that is waiting on you, read on the dashboard's own refresh and only as
 * far as something changed: the folder is listed again only when its mtime moves (a job came or went), and a record
 * is parsed again only when its own mtime or size does. A record caught mid-write keeps its last good reading.
 */
export class ParkedJobReader {
  readonly #listings = new Map<string, { mtimeMs: number; folders: string[] }>();
  readonly #records = new Map<string, { mtimeMs: number; size: number; job: ParkedJob | null }>();

  read(claudeDir: string): ParkedJob[] {
    const dir = join(claudeDir, "jobs");
    let mtimeMs: number;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      this.#listings.delete(dir);
      this.#forget(dir, []);
      return []; // no jobs folder: an account that never ran a background agent
    }
    let listing = this.#listings.get(dir);
    if (!listing || listing.mtimeMs !== mtimeMs) {
      let folders: string[];
      try {
        folders = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && JOB_ID.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        return listing ? this.#jobs(dir, listing.folders) : [];
      }
      listing = { mtimeMs, folders };
      this.#listings.set(dir, listing);
      this.#forget(dir, folders);
    }
    return this.#jobs(dir, listing.folders);
  }

  #jobs(dir: string, folders: readonly string[]): ParkedJob[] {
    const jobs: ParkedJob[] = [];
    for (const folder of folders) {
      const path = join(dir, folder, "state.json");
      let stat: { mtimeMs: number; size: number };
      try {
        stat = statSync(path);
      } catch {
        this.#records.delete(path);
        continue;
      }
      let known = this.#records.get(path);
      if (!known || known.mtimeMs !== stat.mtimeMs || known.size !== stat.size) {
        let job: ParkedJob | null;
        try {
          job = parkedJobFromState(folder, JSON.parse(readFileSync(path, "utf8")), stat.mtimeMs);
        } catch {
          if (known?.job) jobs.push(known.job);
          continue; // torn mid-write: read again next time, and until then the last good reading stands
        }
        known = { mtimeMs: stat.mtimeMs, size: stat.size, job };
        this.#records.set(path, known);
      }
      if (known.job) jobs.push(known.job);
    }
    return jobs;
  }

  /** Drops the readings of records whose folders are gone. */
  #forget(dir: string, kept: readonly string[]): void {
    const keep = new Set(kept.map((folder) => join(dir, folder, "state.json")));
    for (const path of this.#records.keys()) {
      if (path.startsWith(`${dir}/`) && !keep.has(path)) this.#records.delete(path);
    }
  }
}

const defaultReader = new ParkedJobReader();

/** An account whose jobs are read: its id and label for the row, and its Claude config folder. */
export interface ParkedAccount {
  id: string;
  label: string;
  configDir: string;
}

export interface ParkedSessionsOptions {
  now?: number;
  reader?: ParkedJobReader;
}

/**
 * The parked jobs of these accounts, as rows beside the live ones in `live`. A job is a row while it is waiting on you
 * (`parkedJobFromState`), nothing live has its conversation or its job (no row, no registry entry, no id salvaged from
 * a torn one), and it changed within `PARKED_WINDOW_MS`. One row per conversation, the first account's when two hold
 * the same one. A job whose transcript holds no conversation is a spare, as `unusedBackgroundJob` judges a live one,
 * and is no row either.
 *
 * Claude Code's roster lists a job coming back a second or two before its process writes a registry entry; the row
 * stays parked until then rather than leaving the list in between, so it goes from parked to live in place.
 */
export function parkedSessions(
  accounts: readonly ParkedAccount[],
  live: Pick<RegistrySnapshot, "infos" | "liveIds">,
  options: ParkedSessionsOptions = {},
): SessionInfo[] {
  const now = options.now ?? Date.now();
  const reader = options.reader ?? defaultReader;
  const taken = new Set<string>(live.liveIds);
  const liveJobs = new Set<string>();
  for (const info of live.infos) {
    taken.add(info.sessionId);
    if (info.agentSessionId) taken.add(info.agentSessionId);
    if (info.jobId) liveJobs.add(`${info.claudeAccountId ?? "default"}\u0000${info.jobId}`);
  }
  const rows: SessionInfo[] = [];
  for (const account of accounts) {
    for (const job of reader.read(account.configDir)) {
      if (now - job.since > PARKED_WINDOW_MS) continue;
      if (taken.has(job.sessionId) || liveJobs.has(`${account.id}\u0000${job.jobId}`)) continue;
      const row = parkedSessionInfo(job, account);
      if (!row) continue;
      taken.add(job.sessionId);
      rows.push(row);
    }
  }
  return rows;
}

/**
 * One parked job as a session row: the shape `toInfo` gives a live background job no window is attached to, so every
 * path that knows job rows knows this one — pid 0 (nothing to type into until it is attached), its `jobId` (what
 * `claude attach` and `claude stop` name), its account — plus `parked`. Its registry-style status is `idle`, what
 * Claude Code's own registry says of the same job once it runs again; the panel shows it as needing you
 * (`reconcilePanelState`). No `noTerminal`: a reply reaches it (`ParkedJobAttacher`), so the apps keep their composer.
 * Named as its live row will be (`currentName`), so attaching never renames it.
 */
export function parkedSessionInfo(job: ParkedJob, account: ParkedAccount): SessionInfo | null {
  const transcriptPath = liveTranscriptPath(account.configDir, job.cwd, job.sessionId)
    ?? adapterFor("claude").findTranscript(job.sessionId, { claudeDir: account.configDir });
  if (transcriptPath && !hasConversation(transcriptPath)) return null;
  const info: SessionInfo = {
    sessionId: job.sessionId,
    ...(job.name ? { name: job.name } : {}),
    ...(job.cwd ? { cwd: job.cwd } : {}),
    pid: 0,
    jobId: job.jobId,
    kind: "bg",
    entrypoint: "cli",
    status: "idle",
    statusUpdatedAt: job.since,
    claudeAccountId: account.id,
    claudeConfigDir: account.configDir,
    accountLabel: account.label,
    ...(transcriptPath ? { transcriptPath } : {}),
    parked: { since: job.since, ...(job.needs ? { needs: job.needs } : {}) },
  };
  return currentName(info, account.configDir);
}

type Probe = typeof probeCommand;

export interface ParkedJobAttacherDeps {
  /** The row the dashboard last committed for a session. */
  row(sessionId: string): SessionInfo | undefined;
  /** A registry read, committed to the rows: resolves once `row` answers from it. */
  refresh(): Promise<void>;
  label(sessionId: string): string;
  log(line: string): void;
  /** Injectable so tests never reach a real tmux server or roster. */
  probe?: Probe;
  tmux?(): string[];
  /** Whether conch has a tmux to run the hidden window in. */
  tmuxFound?(): boolean;
  /** Whether Claude Code's daemon runs the job now (`jobLiveness`): its roster lists it before its registry entry lands. */
  jobLive?(claudeDir: string, jobId: string): boolean;
  /** The command a window runs to attach the job (`attachTerminalCommand`). */
  attachCommand?(jobId: string, cwd: string | undefined, accountId: string | undefined): string;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  waitMs?: number;
  intervalMs?: number;
}

/**
 * Brings a parked job back for a reply: `claude attach <jobId>` in a hidden window on conch's own tmux server, then a
 * wait until its row is live again — a registry entry, and the attach process as its pid (`attachedWindow` finds it
 * from `ps`) — and the window shows Claude Code's input box, so the words aren't typed into a screen still drawing.
 *
 * One attach per job at a time: a second reply while the first waits shares its wait. A window of that name already
 * there while Claude Code's roster says the job isn't running is a viewer left on the job after it stopped, which
 * reaches nothing (dead-target.ts), so its pane is started again with a fresh attach rather than trusted. A job its
 * roster already lists (a Terminal window opened from the app, say) is only waited for.
 *
 * The window stays after the reply, as Tyler's own did: it is the job's viewer from then on, what conch types the next
 * reply into, and it leaves with the job. Not one of conch's background sessions (`BACKGROUND_NAME` doesn't match it),
 * so background recovery never resumes it.
 */
export class ParkedJobAttacher {
  readonly #deps: ParkedJobAttacherDeps;
  readonly #pending = new Map<string, Promise<SessionInfo>>();

  constructor(deps: ParkedJobAttacherDeps) {
    this.#deps = deps;
  }

  /**
   * The event re-routed to the live window when its row is parked; the event as it was otherwise. Throws, with a
   * sentence an app can show (`ConchSendFailure.written`), when the job couldn't be brought back.
   */
  async forDelivery(event: TurnEvent): Promise<TurnEvent> {
    const session = this.#deps.row(event.sessionId);
    if (!session?.parked || !session.jobId) return event;
    const live = await this.bringBack(session);
    return {
      ...event,
      pid: live.pid,
      ...(live.cwd ? { cwd: live.cwd } : {}),
      ...(live.transcriptPath ? { transcriptPath: live.transcriptPath } : {}),
    };
  }

  bringBack(session: SessionInfo): Promise<SessionInfo> {
    const pending = this.#pending.get(session.sessionId);
    if (pending) return pending;
    const run = this.#bringBack(session).finally(() => this.#pending.delete(session.sessionId));
    this.#pending.set(session.sessionId, run);
    return run;
  }

  async #bringBack(session: SessionInfo): Promise<SessionInfo> {
    const deps = this.#deps;
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? Bun.sleep;
    const probe = deps.probe ?? probeCommand;
    const tmux = (deps.tmux ?? conchTmux)();
    const jobId = session.jobId!;
    const name = `${PARKED_ATTACH_PREFIX}${jobId}`;
    const label = deps.label(session.sessionId);
    const started = now();
    const fail = (why: string): never => {
      deps.log(`could not bring back parked "${label}" for a reply (claude attach ${jobId}): ${why}`);
      throw new Error(`couldn't bring the parked session back: ${why}. Open it in Terminal and send again`);
    };

    const claudeDir = session.claudeConfigDir;
    const running = claudeDir !== undefined
      && (deps.jobLive ?? ((dir: string, id: string) => jobLiveness(dir, id).state === "live"))(claudeDir, jobId);
    let how = "already coming back";
    if (!running) {
      if (!(deps.tmuxFound ?? (() => resolveTmux().found))()) fail("conch has no tmux to attach it in");
      const cwd = session.cwd && existsSync(session.cwd) ? session.cwd : undefined;
      let command: string;
      try {
        command = (deps.attachCommand ?? attachTerminalCommand)(jobId, cwd, session.claudeAccountId);
      } catch (error) {
        return fail((error as Error).message);
      }
      // Without TMUX / TMUX_PANE, as conch's background sessions run (`startBackgroundProcess`): a tmux command
      // anything in it runs then reaches the user's default server, never conch's.
      const shell = ["/bin/zsh", "-lc", `unset TMUX TMUX_PANE; ${command}`];
      const sessions = await probe([...tmux, "list-sessions", "-F", "#{session_name}"], [0, 1]);
      const stale = sessions?.split("\n").some((line) => line.trim() === name) === true;
      const result = stale
        ? await probe([...tmux, "respawn-pane", "-k", "-t", `=${name}:`, ...shell], [0], 4_000)
        : await probe([...tmux, "new-session", "-d", "-s", name, "-x", "200", "-y", "50",
          ...(cwd ? ["-c", cwd] : []), "-e", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, ...shell], [0], 4_000);
      if (result === null) fail(`tmux would not ${stale ? "restart" : "open"} its window`);
      // As `startBackgroundProcess` keeps it: a server that is gone always means it was stopped (background-recovery.ts).
      await probe([...tmux, "set-option", "-g", "exit-empty", "off"], [0]);
      how = stale ? `restarted the attach in tmux ${name}` : `hidden in tmux ${name}`;
    }

    const deadline = started + (deps.waitMs ?? PARKED_ATTACH_WAIT_MS);
    const interval = deps.intervalMs ?? 1_000;
    let liveSince: number | undefined;
    for (;;) {
      await deps.refresh().catch(() => {});
      const row = deps.row(session.sessionId);
      if (row && !row.parked && row.pid && row.pid > 0) {
        liveSince ??= now();
        // The input box, read from the window conch opened. One a Terminal window opened isn't conch's to read; and a
        // screen that never shows one still takes the words once the row has been live a while (the send re-presses
        // Return for words left in the box).
        const screen = running ? null : await probe([...tmux, "capture-pane", "-p", "-t", `=${name}:`], [0]);
        if (running || (screen !== null && claudeInputBoxText(screen) !== null) || now() - liveSince >= 10_000) {
          deps.log(`brought back parked "${label}" for a reply (claude attach ${jobId}, ${how}): live in ${((now() - started) / 1000).toFixed(1)}s`);
          return row;
        }
      } else if (!running) {
        // The attach ending before the job came back (a job Claude Code can't wake) takes its window with it.
        const sessions = await probe([...tmux, "list-sessions", "-F", "#{session_name}"], [0, 1]);
        if (sessions !== null && !sessions.split("\n").some((line) => line.trim() === name)) {
          fail(`claude attach ${jobId} exited before the session came back`);
        }
      }
      if (now() + interval > deadline) {
        fail(`it didn't come back within ${Math.round((deps.waitMs ?? PARKED_ATTACH_WAIT_MS) / 1000)} seconds`);
      }
      await sleep(interval);
    }
  }
}

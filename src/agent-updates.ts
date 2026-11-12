import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentAdapters, type AgentAdapter, type SessionBackend } from "./agent-adapter.ts";
import { describeInstallLocation, readInstalledVersion } from "./agent-install.ts";
import { conchHome } from "./home.ts";
import { readProcessIdentity } from "./process-identity.ts";
import { installerSandboxRefusal, spawnInstaller } from "./setup.ts";
import { isNewer, parseVersion } from "./version-check.ts";
import { type AgentInstallChannel, type AgentUpdatesReply, type AgentUpdatesRequest, type AgentUpdatesRow } from "./agent-updates-wire.ts";

export * from "./agent-updates-wire.ts";

/**
 * Keep the agent CLIs up to date by itself (Tyler, 2026-11-09, on finding his Claude Code 12 releases behind and
 * missing a new model: "can we have a way for this to happen through conch automatically?").
 *
 * What this does and doesn't do:
 *  - It reads where each CLI really lives. A Homebrew cask we can name is upgraded by Homebrew, with that cask alone
 *    named. Anything else (native installer, npm, a version manager, the desktop app) is left alone and said so:
 *    conch never moves an install to another channel.
 *  - It never restarts or touches a session; Tyler has been firm on that. A new version waits for the session to end,
 *    and the app only says so.
 *
 * Why the old version's folder has to outlive `brew upgrade`: a running agent keeps executing its binary, but
 * re-invokes it by path. Claude Code 2.1.309's bundled JS: `{mode:"embedded",command:process.execPath,args:["--no-config"],
 * argv0:"rg"}`, used for every Grep and Glob; `Eu({pinToCurrentBinary:!0})` (i.e. `process.execPath`) for `--bg-pty-host`,
 * spare hosts, teammates and scheduled runs; the shell's `rg` function reads `CLAUDE_CODE_EXECPATH`. Codex 0.164.0 puts its
 * version's `codex-path/` (its `rg`) first on every child's PATH. And `brew upgrade --cask` renames the version folder
 * to `<version>.upgrading` and deletes it (cask/installer.rb `backup`, `finalize_upgrade`), so all of that fails with
 * ENOENT for the rest of the session: on this Mac there is no other `rg` to fall back to. So before upgrading, the
 * version folder is cloned (`cp -c`, APFS: no extra disk until the original goes) into conch's own folder, a symlink
 * puts it back at the old path the moment Homebrew vacates it, and both go only when the last process running it has
 * exited (`sweep`).
 *
 * Homebrew doesn't mind: its idea of what's installed comes only from `.metadata/<version>/<timestamp>/Casks/<token>.*`
 * (Caskroom.cask_installed_version, Cask#timestamped_versions), and a version folder with no metadata isn't looked at by
 * `brew list/info/doctor/cleanup`. A rollback's `restore_backup` does `rm_r` on the old path (taking the link, not its
 * target), then renames `.upgrading` back, so the link must not reappear in that gap: it's planted once per upgrade.
 */

/** How one agent's CLI is installed on this Mac, read from where the binary really lives. */
export interface DetectedAgentInstall {
  channel: AgentInstallChannel;
  /** The file behind the name on PATH, symlinks resolved; null when there is none. */
  path: string | null;
  /** From the Caskroom folder's name, for a cask. Null otherwise: `--version` is slow, so `readVersion` asks it once a pass. */
  version: string | null;
  /** How it's installed, in the words the app shows. */
  source: string;
  /** The cask token, and the Homebrew prefix it lives under: `<prefix>/bin/brew` is the Homebrew that owns it. */
  cask?: string;
  prefix?: string;
  /** `Caskroom/<cask>/<version>`: the folder an upgrade takes away. */
  stagedPath?: string;
}

const CASKROOM_PATH_RE = /^(.*)\/Caskroom\/([^/]+)\/([^/]+)\//;

/** What `detectAgentInstall` needs from the world, as seams. */
export interface InstallProbe {
  which(executable: string): string | null;
  realpath(path: string): string;
  /** Used for Homebrew's markers: `<prefix>/bin/brew` and the cask's `.metadata`. */
  exists(path: string): boolean;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** Where `adapter`'s CLI came from. Channel `missing` when it isn't on PATH or its path can't be resolved. */
export function detectAgentInstall(adapter: Pick<AgentAdapter, "executable" | "ownInstallerRoots">, probe: InstallProbe): DetectedAgentInstall {
  const missing: DetectedAgentInstall = { channel: "missing", path: null, version: null, source: "Not installed" };
  const named = probe.which(adapter.executable);
  if (!named) return missing;
  let path: string;
  try {
    path = probe.realpath(named);
  } catch {
    return missing;
  }
  const cask = CASKROOM_PATH_RE.exec(path);
  if (cask) {
    const [, prefix, token, version] = cask as unknown as [string, string, string, string];
    // A cask we can name: a token, a real Caskroom entry with Homebrew's own metadata, and that Homebrew's `brew`.
    if (validCaskToken(token) && parseVersion(version) && probe.exists(join(prefix, "bin", "brew"))
      && probe.exists(join(prefix, "Caskroom", token, ".metadata"))) {
      return {
        channel: "homebrew-cask", path, version, source: `Homebrew cask ${token}`,
        cask: token, prefix, stagedPath: join(prefix, "Caskroom", token, version),
      };
    }
    return { channel: "not-managed", path, version: null, source: "Homebrew, in a shape conch can't name" };
  }
  if (adapter.ownInstallerRoots(probe.home, probe.env).some((root) => path.startsWith(`${root}/`))) {
    return { channel: "updates-itself", path, version: null, source: "Its own installer, which updates itself" };
  }
  const location = describeInstallLocation(path);
  if (location.kind === "claude-desktop-app") return { channel: "updates-itself", path, version: null, source: "An app bundle that updates with its app" };
  if (location.kind === "npm-global") return { channel: "not-managed", path, version: null, source: "npm, not managed by conch" };
  return { channel: "not-managed", path, version: null, source: "Not managed by conch" };
}

/** A token Homebrew could mean, and nothing a shell or a URL would read as more: argv and a URL path both get it verbatim. */
export function validCaskToken(token: string): boolean {
  return /^[a-z0-9][a-z0-9@._+-]{0,127}$/.test(token);
}

const FETCH_TIMEOUT_MS = 15_000;

/** The newest version the cask publishes: Homebrew's own view, which trails npm a little (2026-11-09: 2.1.319 here, 2.1.321 on npm). */
export async function fetchLatestCaskVersion(
  cask: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ version: string } | { error: string }> {
  if (!validCaskToken(cask)) return { error: `not a cask name: ${cask}` };
  try {
    const response = await fetchImpl(`https://formulae.brew.sh/api/cask/${cask}.json`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { error: `formulae.brew.sh said ${response.status}` };
    const body = await response.json() as { version?: unknown };
    // A cask version may carry a build after a comma (`1.2.3,abc`); the release is before it.
    const version = typeof body?.version === "string" ? body.version.split(",")[0]! : "";
    if (!parseVersion(version)) return { error: `formulae.brew.sh gave no version conch can read for ${cask}` };
    return { version };
  } catch (error) {
    return { error: `couldn't reach formulae.brew.sh: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A few minutes after the daemon starts, jittered so a restart loop can't hammer brew or the API. */
export const CHECK_FIRST_MIN_MS = 3 * MINUTE;
export const CHECK_FIRST_JITTER_MS = 4 * MINUTE;
/** Then every few hours, jittered. */
export const CHECK_EVERY_MS = 4 * HOUR;
export const CHECK_JITTER_MS = 2 * HOUR;
/** How often old versions are looked at to see if the last session on them has gone. */
export const SWEEP_EVERY_MS = 15 * MINUTE;
/**
 * The download is most of it. Past this, brew is stopped: SIGTERM, then SIGKILL. Long, because stopping `brew upgrade`
 * partway (between its `backup` and its new install, which no rescue covers) leaves the CLI missing until reinstalled.
 */
export const BREW_TIMEOUT_MS = 15 * MINUTE;
const BREW_KILL_GRACE_MS = 10_000;
/** How often the old path is checked while brew runs: about the longest a Grep or Glob can find it missing. */
export const HOLD_POLL_MS = 50;

/** Failed upgrades wait longer each time, and across restarts, so a broken one can never become a retry loop. */
export function backoffMs(failures: number): number {
  const steps = [6 * HOUR, 24 * HOUR, 3 * DAY, 7 * DAY];
  return steps[Math.min(Math.max(failures, 1), steps.length) - 1]!;
}

/** What brew reported, for the failure line. */
export interface BrewResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  /** The last of its output, for a failure only. Never logged whole. */
  tail: string;
}

/**
 * `brew upgrade --cask <cask>`'s environment. Each is deliberate:
 *  - HOMEBREW_NO_AUTO_UPDATE: no `brew update` first, so this never updates Homebrew itself or a tap.
 *  - HOMEBREW_FORCE_API_AUTO_UPDATE + HOMEBREW_API_AUTO_UPDATE_SECS=0: but `NO_AUTO_UPDATE` alone also freezes the cask
 *    JSON brew reads (api.rb `fetch_api_files!` sets `stale_seconds = nil`), up to a week stale, and brew would answer
 *    "the latest version is already installed" to a version conch just saw on formulae.brew.sh. This pair revalidates that
 *    one file (an ETag round trip) and nothing else, in the shape Homebrew offers for exactly this.
 *  - HOMEBREW_NO_INSTALL_CLEANUP: a `brew upgrade` can trigger Homebrew's periodic cleanup, which deletes old versions of
 *    every other package, and conch only ever names one cask.
 *  - NONINTERACTIVE / HOMEBREW_NO_ENV_HINTS: nobody answers it here; the output is only read on failure.
 */
export function brewUpgradeEnvironment(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return {
    ...env,
    HOMEBREW_NO_AUTO_UPDATE: "1",
    HOMEBREW_FORCE_API_AUTO_UPDATE: "1",
    HOMEBREW_API_AUTO_UPDATE_SECS: "0",
    HOMEBREW_NO_INSTALL_CLEANUP: "1",
    HOMEBREW_NO_ENV_HINTS: "1",
    NONINTERACTIVE: "1",
    NO_COLOR: "1",
  };
}

/** The tail kept for a failure: enough to say why, short enough to sit in a state file and a Settings line. */
export const BREW_TAIL_CHARS = 1_200;

/**
 * `<prefix>/bin/brew upgrade --cask <cask>`. Refuses, before anything is spawned, in a conch with a stand-in home (its
 * tests, an e2e, `CONCH_HOME`), as setup's installer does: an e2e once ran a real `brew install` on Tyler's Mac.
 */
export async function runBrewUpgrade(
  brew: string,
  cask: string,
  seams: { env?: NodeJS.ProcessEnv; accountHome?: () => string; spawn?: typeof spawnInstaller; timeoutMs?: number } = {},
): Promise<BrewResult> {
  const env = seams.env ?? process.env;
  const refused = installerSandboxRefusal(env, seams.accountHome);
  if (refused) return { ok: false, code: null, timedOut: false, tail: `${refused}, so it won't run brew` };
  if (!validCaskToken(cask)) return { ok: false, code: null, timedOut: false, tail: `not a cask name: ${cask}` };
  let tail = "";
  const run = (seams.spawn ?? spawnInstaller)(
    [brew, "upgrade", "--cask", cask],
    (text) => { tail = `${tail}${text}`.slice(-BREW_TAIL_CHARS); },
    { env: brewUpgradeEnvironment(env), graceMs: BREW_KILL_GRACE_MS },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    run.kill();
  }, seams.timeoutMs ?? BREW_TIMEOUT_MS);
  try {
    const code = await run.exited;
    return { ok: code === 0 && !timedOut, code, timedOut, tail };
  } finally {
    clearTimeout(timer);
  }
}

/** A version folder conch cloned before upgrading, and where it put it. */
export interface KeptVersion {
  cask: string;
  version: string;
  prefix: string;
  stagedPath: string;
  keptPath: string;
  at: number;
}

export interface AgentUpdateRecord {
  /** The last version on disk, for a CLI conch can't read a version off the path of. */
  installed?: string;
  checkedAt?: number;
  newest?: string;
  updatedAt?: number;
  updatedFrom?: string;
  updatedTo?: string;
  failure?: { at: number; phase: "check" | "update"; message: string; output?: string };
  /** Upgrade failures in a row, and when one may next be tried: cleared by a success. */
  failures?: number;
  nextAttemptAt?: number;
}

export interface AgentUpdatesState {
  agents: Record<string, AgentUpdateRecord>;
  kept: KeptVersion[];
}

function emptyState(): AgentUpdatesState {
  return { agents: {}, kept: [] };
}

/** Never throws: a missing or unreadable file starts over, and the next upgrade writes it again. */
export function readAgentUpdatesState(path: string): AgentUpdatesState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentUpdatesState>;
    if (!parsed || typeof parsed !== "object") return emptyState();
    const agents = parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {};
    const kept = Array.isArray(parsed.kept) ? parsed.kept.filter(isKeptVersion) : [];
    return { agents, kept };
  } catch {
    return emptyState();
  }
}

function isKeptVersion(value: unknown): value is KeptVersion {
  const kept = value as KeptVersion;
  return Boolean(kept) && typeof kept.cask === "string" && typeof kept.version === "string" && typeof kept.prefix === "string"
    && typeof kept.stagedPath === "string" && typeof kept.keptPath === "string" && typeof kept.at === "number";
}

function writeState(path: string, state: AgentUpdatesState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    renameSync(temp, path);
  } catch {
    // Never fatal: the next successful write says it again.
  }
}

/** `cp -c` is APFS's copy-on-write clone (no disk until the original is deleted), and falls back to a copy off APFS. */
export async function cloneFolder(from: string, to: string): Promise<void> {
  mkdirSync(dirname(to), { recursive: true });
  const proc = Bun.spawn(["/bin/cp", "-cRp", from, to], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(stderr.trim() || `cp exited ${code}`);
}

/** Put the old path back, as a link into the clone, once Homebrew has gone from it. True when there's nothing left to do. */
export function placeBack(stagedPath: string, keptPath: string): boolean {
  try {
    lstatSync(stagedPath);
    return false; // Homebrew hasn't moved it yet.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    symlinkSync(keptPath, stagedPath);
    return true;
  } catch (error) {
    // Something got there first; never fight over it.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
    return false;
  }
}

/**
 * While brew runs: the old path comes back within one poll of Homebrew renaming it away (it is gone from that rename until
 * Homebrew finishes, seconds in which a Grep would otherwise fail). Once only, and only while brew is running: a rollback
 * `rm_r`s the old path and renames `.upgrading` back, and a link reappearing there would stop that rename.
 */
export function holdOldPath(stagedPath: string, keptPath: string, intervalMs = HOLD_POLL_MS): { stop(): void } {
  const timer = setInterval(() => {
    if (placeBack(stagedPath, keptPath)) clearInterval(timer);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function isOurLink(stagedPath: string, keptPath: string): boolean {
  try {
    return lstatSync(stagedPath).isSymbolicLink() && readlinkSync(stagedPath) === keptPath;
  } catch {
    return false;
  }
}

/** The running version a binary's own path says, whether it's in the Caskroom, mid-upgrade, or in conch's clone. */
export function versionFromExecutable(executable: string): string | null {
  const match = /\/(?:Caskroom\/[^/]+|agent-updates\/kept\/[^/]+)\/(\d+\.\d+\.\d+)(?:\.upgrading)?\//.exec(executable);
  return match ? match[1]! : null;
}

/** The session a row belongs to, as far as its executable: what `olderSessions` counts. Read only. */
export interface RunningSession {
  backend: SessionBackend | undefined;
  executable: string;
}

/** Everything the updater needs from the world: real by default, injected in tests. */
export interface AgentUpdaterDeps {
  statePath: string;
  keptRoot: string;
  /** Why this conch mustn't run brew at all (its tests, a stand-in home); null when it may. Checked before anything runs. */
  refused(): string | null;
  /** The `agent-auto-update` setting, read live: off is off at once. */
  enabled(): boolean;
  now(): number;
  random(): number;
  log(line: string): void;
  adapters(): AgentAdapter[];
  probe: InstallProbe;
  readVersion(path: string): Promise<string | null>;
  latestCaskVersion(cask: string): Promise<{ version: string } | { error: string }>;
  clone(from: string, to: string): Promise<void>;
  upgrade(brew: string, cask: string): Promise<BrewResult>;
  /** The live processes' executables; null when they couldn't be read, and then nothing old is removed. */
  runningExecutables(): Promise<string[] | null>;
  /** Live sessions' executables, read only. */
  sessions(): RunningSession[];
  setTimer(run: () => void, ms: number): unknown;
  holdPollMs: number;
}

export class AgentUpdater {
  private state: AgentUpdatesState;
  private updating = new Set<SessionBackend>();
  private queue: Promise<unknown> = Promise.resolve();
  private checkTimer: unknown = null;

  constructor(private readonly deps: AgentUpdaterDeps) {
    this.state = readAgentUpdatesState(deps.statePath);
  }

  start(): void {
    if (this.deps.refused()) return;
    if (this.checkTimer !== null) return;
    this.scheduleCheck(true);
    this.deps.setTimer(() => this.periodicSweep(), SWEEP_EVERY_MS);
    // A folder still held from before a restart: if everything on it went while the daemon was down, it can go now.
    void this.serialize(() => this.sweep());
  }

  private scheduleCheck(first: boolean): void {
    const delay = first
      ? CHECK_FIRST_MIN_MS + this.deps.random() * CHECK_FIRST_JITTER_MS
      : CHECK_EVERY_MS + this.deps.random() * CHECK_JITTER_MS;
    this.checkTimer = this.deps.setTimer(() => {
      void this.serialize(() => this.checkAll()).finally(() => this.scheduleCheck(false));
    }, delay);
  }

  private periodicSweep(): void {
    void this.serialize(() => this.sweep()).finally(() => {
      this.deps.setTimer(() => this.periodicSweep(), SWEEP_EVERY_MS);
    });
  }

  /** One at a time, scheduled passes and "Update now" alike. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** One pass over every agent, in turn, then a look at what's kept. The schedule runs it through the queue. */
  async checkAll(): Promise<void> {
    for (const adapter of this.deps.adapters()) {
      if (!this.deps.enabled()) return;
      await this.checkOne(adapter, false);
    }
    await this.sweep();
  }

  /** "Update now": once, off or not, past any backoff. Still only a cask conch can name, and still only that cask. */
  updateNow(backend: SessionBackend): Promise<AgentUpdatesReply> {
    return this.serialize(async () => {
      const adapter = this.deps.adapters().find((candidate) => candidate.backend === backend);
      if (adapter) await this.checkOne(adapter, true);
      return this.status();
    });
  }

  private recordFor(backend: SessionBackend): AgentUpdateRecord {
    return (this.state.agents[backend] ??= {});
  }

  private save(): void {
    writeState(this.deps.statePath, this.state);
  }

  private async checkOne(adapter: AgentAdapter, manual: boolean): Promise<void> {
    if (this.deps.refused()) return;
    const record = this.recordFor(adapter.backend);
    const install = detectAgentInstall(adapter, this.deps.probe);
    if (install.channel !== "homebrew-cask") {
      // Left alone: not checked, not upgraded. The version is only for Settings.
      if (install.path && !install.version) {
        const version = await this.deps.readVersion(install.path);
        if (version) record.installed = version;
      }
      this.save();
      return;
    }
    record.installed = install.version ?? undefined;
    const latest = await this.deps.latestCaskVersion(install.cask!);
    if ("error" in latest) {
      // An offline laptop isn't a failure worth a retry policy: said quietly, cleared by the next good check.
      record.failure = { at: this.deps.now(), phase: "check", message: latest.error };
      this.save();
      this.deps.log(`agent-updates: ${adapter.displayName}: check failed: ${latest.error}`);
      return;
    }
    record.checkedAt = this.deps.now();
    record.newest = latest.version;
    if (record.failure?.phase === "check") delete record.failure;
    if (!isNewer(latest.version, install.version!)) {
      this.save();
      return;
    }
    if (!manual && record.nextAttemptAt !== undefined && this.deps.now() < record.nextAttemptAt) {
      this.save();
      return;
    }
    // The check took a moment: off is off.
    if (!manual && !this.deps.enabled()) {
      this.save();
      return;
    }
    this.save();
    await this.upgrade(adapter, install, record);
  }

  private async upgrade(adapter: AgentAdapter, install: DetectedAgentInstall, record: AgentUpdateRecord): Promise<void> {
    const from = install.version!;
    const name = adapter.displayName;
    this.updating.add(adapter.backend);
    let kept: KeptVersion;
    try {
      kept = await this.keep(install);
    } catch (error) {
      this.updating.delete(adapter.backend);
      // Nothing has been touched yet, and without a copy an upgrade would strand every running session on this version.
      this.fail(record, name, `couldn't keep a copy of ${from} before upgrading, so didn't upgrade: ${errorMessage(error)}`);
      return;
    }
    let result: BrewResult;
    const hold = holdOldPath(install.stagedPath!, kept.keptPath, this.deps.holdPollMs);
    try {
      result = await this.deps.upgrade(join(install.prefix!, "bin", "brew"), install.cask!);
    } catch (error) {
      result = { ok: false, code: null, timedOut: false, tail: errorMessage(error) };
    } finally {
      hold.stop();
      this.updating.delete(adapter.backend);
    }
    // brew has gone: the one thing left to do for the old path. If it's still a real folder, Homebrew never left it.
    placeBack(install.stagedPath!, kept.keptPath);

    const after = detectAgentInstall(adapter, this.deps.probe);
    if (result.ok && after.version && isNewer(after.version, from)) {
      record.updatedAt = this.deps.now();
      record.updatedFrom = from;
      record.updatedTo = after.version;
      record.installed = after.version;
      delete record.failure;
      delete record.failures;
      delete record.nextAttemptAt;
      this.save();
      this.deps.log(`agent-updates: ${name} updated ${from} -> ${after.version}`);
      await this.sweep();
      return;
    }

    // Homebrew never left the folder, or rolled it back: there is nothing to keep it for.
    if (this.isRealFolder(install.stagedPath!)) this.dropKept(kept);
    let message = result.timedOut
      ? `brew upgrade --cask ${install.cask} ran past ${BREW_TIMEOUT_MS / MINUTE} minutes and was stopped`
      : result.ok
        ? `brew upgrade --cask ${install.cask} finished but ${name} is still ${after.version ?? from}`
        : `brew upgrade --cask ${install.cask} failed${result.code === null ? "" : ` (exit ${result.code})`}`;
    if (after.channel === "missing") message += `; ${adapter.executable} isn't on PATH now, run brew reinstall --cask ${install.cask}`;
    this.fail(record, name, message, result.tail);
  }

  private fail(record: AgentUpdateRecord, name: string, message: string, output?: string): void {
    record.failure = { at: this.deps.now(), phase: "update", message, ...(output ? { output } : {}) };
    record.failures = (record.failures ?? 0) + 1;
    record.nextAttemptAt = this.deps.now() + backoffMs(record.failures);
    this.save();
    // One line, no brew output: `BrewResult.tail` is for Settings to show.
    this.deps.log(`agent-updates: ${name}: ${message}`);
  }

  /** Clones the version folder, then records it, so a daemon that dies between the two can't leave an orphan it won't sweep. */
  private async keep(install: DetectedAgentInstall): Promise<KeptVersion> {
    const keptPath = join(this.deps.keptRoot, install.cask!, install.version!);
    const already = this.state.kept.find((entry) => entry.cask === install.cask && entry.version === install.version);
    if (already && existsSync(already.keptPath)) return already;
    const entry: KeptVersion = {
      cask: install.cask!, version: install.version!, prefix: install.prefix!, stagedPath: install.stagedPath!, keptPath, at: this.deps.now(),
    };
    this.state.kept = [...this.state.kept.filter((kept) => kept !== already), entry];
    this.save();
    const partial = `${keptPath}.partial`;
    rmSync(partial, { recursive: true, force: true });
    await this.deps.clone(install.stagedPath!, partial);
    renameSync(partial, keptPath);
    return entry;
  }

  private isRealFolder(path: string): boolean {
    try {
      const stat = lstatSync(path);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private dropKept(kept: KeptVersion): void {
    if (isOurLink(kept.stagedPath, kept.keptPath)) this.removeLink(kept);
    rmSync(kept.keptPath, { recursive: true, force: true });
    this.state.kept = this.state.kept.filter((entry) => entry !== kept);
    this.save();
  }

  private removeLink(kept: KeptVersion): void {
    try {
      unlinkSync(kept.stagedPath);
      // The cask's own folder, if that was the last thing in it (it had been uninstalled): Homebrew's rmdir gave up on our link.
      try { rmdirSync(dirname(kept.stagedPath)); } catch {}
    } catch {}
  }

  /** Whether any process is still running from this version: its Caskroom folder, Homebrew's mid-upgrade name for it, or the clone. */
  private stillInUse(kept: KeptVersion, running: readonly string[]): boolean {
    const prefixes = [`${kept.stagedPath}/`, `${kept.stagedPath}.upgrading/`, `${kept.keptPath}/`];
    return running.some((executable) => prefixes.some((prefix) => executable.startsWith(prefix)));
  }

  /** Looks at each kept version and removes the ones nothing runs from any more. Public for the daemon's tests and restarts. */
  async sweep(): Promise<void> {
    if (!this.state.kept.length) return;
    const running = await this.deps.runningExecutables();
    // Can't tell: wait. A kept copy costs disk; removing a live one costs every Grep in a session.
    if (running === null) return;
    const inUse = [...running, ...this.deps.sessions().map((session) => session.executable)];
    for (const kept of [...this.state.kept]) {
      // Homebrew's own word that this version is installed again (a reinstall, a downgrade): it's writing through our
      // link, so the link stays. `.metadata/<version>` is what `brew` itself reads.
      const reinstalled = existsSync(join(kept.prefix, "Caskroom", kept.cask, ".metadata", kept.version));
      if (this.stillInUse(kept, inUse)) {
        // Still needed, and the daemon that was holding the old path may have died mid-upgrade: put the link back.
        if (!reinstalled) placeBack(kept.stagedPath, kept.keptPath);
        continue;
      }
      if (reinstalled) continue;
      this.dropKept(kept);
      this.deps.log(`agent-updates: nothing runs ${kept.cask} ${kept.version} any more; removed its kept copy`);
    }
  }

  /** Fresh detection, the record, and how many live sessions are behind. Cheap enough for the app to ask whenever it shows. */
  status(): AgentUpdatesReply {
    return {
      kind: "agent-updates",
      auto: this.deps.enabled(),
      agents: this.deps.adapters().map((adapter) => this.rowFor(adapter)),
    };
  }

  private rowFor(adapter: AgentAdapter): AgentUpdatesRow {
    const record = this.recordFor(adapter.backend);
    const install = detectAgentInstall(adapter, this.deps.probe);
    const installed = install.version ?? record.installed ?? null;
    const older = this.olderSessions(adapter, install, installed);
    return {
      backend: adapter.backend,
      displayName: adapter.displayName,
      channel: install.channel,
      source: install.source,
      installed,
      newest: record.newest ?? null,
      ...(install.cask ? { cask: install.cask } : {}),
      ...(record.checkedAt ? { checkedAt: record.checkedAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
      ...(record.updatedFrom ? { updatedFrom: record.updatedFrom } : {}),
      ...(record.updatedTo ? { updatedTo: record.updatedTo } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      canUpdate: install.channel === "homebrew-cask",
      updating: this.updating.has(adapter.backend),
      olderSessions: older,
    };
  }

  private olderSessions(adapter: AgentAdapter, install: DetectedAgentInstall, installed: string | null): { count: number; versions: string[] } {
    if (!installed || install.channel !== "homebrew-cask") return { count: 0, versions: [] };
    const versions = this.deps.sessions()
      .filter((session) => (session.backend ?? "claude") === adapter.backend)
      .flatMap((session) => {
        const version = versionFromExecutable(session.executable);
        return version && isNewer(installed, version) ? [version] : [];
      });
    const distinct = [...new Set(versions)].sort((a, b) => (isNewer(a, b) ? -1 : 1));
    return { count: versions.length, versions: distinct };
  }

  /** The app's question: status, or an "Update now" that waits its turn. */
  handle(message: AgentUpdatesRequest): Promise<AgentUpdatesReply> | AgentUpdatesReply {
    if (message.action === "update-now" && message.backend) return this.updateNow(message.backend);
    return this.status();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lists every process's executable, by `proc_pidpath`, so a deleted-while-running binary still says its path. */
export async function listRunningExecutables(timeoutMs = 10_000): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(["/bin/ps", "-axo", "pid="], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    try {
      const output = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) return null;
      const executables: string[] = [];
      for (const line of output.split("\n")) {
        const pid = Number(line.trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) continue;
        const identity = readProcessIdentity(pid);
        if (identity) executables.push(identity.executable);
      }
      return executables;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** The file behind `agent-updates.json`: beside conch's other state, and the clones beside it. */
export function agentUpdatesPaths(configDir: string): { statePath: string; keptRoot: string } {
  return { statePath: join(configDir, "agent-updates.json"), keptRoot: join(configDir, "agent-updates", "kept") };
}

/** The real seams: Homebrew, the API, the process list, and timers. `start` checks the sandbox before any of it runs. */
export function agentUpdaterDeps(options: {
  configDir: string;
  enabled: () => boolean;
  log: (line: string) => void;
  sessions: () => RunningSession[];
}): AgentUpdaterDeps {
  const { statePath, keptRoot } = agentUpdatesPaths(options.configDir);
  return {
    statePath,
    keptRoot,
    refused: () => installerSandboxRefusal(process.env),
    enabled: options.enabled,
    log: options.log,
    sessions: options.sessions,
    now: () => Date.now(),
    random: () => Math.random(),
    adapters: () => agentAdapters(),
    probe: {
      which: (executable) => Bun.which(executable),
      realpath: (path) => realpathSync(path),
      exists: (path) => existsSync(path),
      home: conchHome(),
      env: process.env,
    },
    readVersion: (path) => readInstalledVersion(path, 5_000),
    latestCaskVersion: (cask) => fetchLatestCaskVersion(cask),
    clone: cloneFolder,
    upgrade: (brew, cask) => runBrewUpgrade(brew, cask),
    runningExecutables: () => listRunningExecutables(),
    setTimer: (run, ms) => {
      const timer = setTimeout(run, ms);
      timer.unref?.();
      return timer;
    },
    holdPollMs: HOLD_POLL_MS,
  };
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { probeCommand } from "./probe.ts";
import type { Probe } from "./screen-context.ts";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readProcessIdentity } from "./process-identity.ts";
import {
  decodeLedgerMemory,
  PROCESS_KINDS,
  limaInstance,
  parseCwds,
  parseLifetime,
  parseLimaInstances,
  parseListenerPorts,
  parsePsTable,
  parseSessionEnvironments,
  processKey,
  ProcessForest,
  vmFromInstance,
  type Evidence,
  type LedgerMemory,
  type LedgerSession,
  type ProcessRow,
  type ProcessTable,
  type ProcessTableSource,
  type ResourceAction,
  type ResourceEntry,
  type ResourceLedger,
  type ResourceOwner,
  type ResourceReply,
  type ResourceRequest,
  type ResourceTarget,
  type SessionEnvironment,
} from "./resource-ledger.ts";

/**
 * How the ledger looks at the Mac, and stops what Tyler asks it to (resource-ledger.ts is the model).
 *
 * The cost, which the efficiency evals hold the daemon to: one look at the process table every `RESOURCE_SAMPLE_MS`
 * (30 s), never more often however often it is asked. Measured on 2026-11-11 with 2,261 processes: one
 * `ps -Ao …,args=` takes 0.12 s of CPU. Everything else is read only for what is new since the last look:
 *  - the listening ports (`lsof -iTCP -sTCP:LISTEN`, 0.08 s) when a process conch could own appeared since the last
 *    read, else every five minutes;
 *  - an orphan's environment, once in its life, and only for the top of a group that nothing else ties to a session;
 *  - a Virtualization process's open files, once, for which VM it runs;
 *  - a new resource's working folder, once;
 *  - a booted simulator's name from its `device.plist`, once per device.
 * The memory file is written only when what it holds changed.
 */

export const RESOURCE_SAMPLE_MS = 30_000;
/** The listening ports are read again after this long even when nothing new appeared: a server can start listening late. */
export const LISTENERS_REFRESH_MS = 5 * 60_000;
/** How long a stop waits after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 5_000;

/** The one `ps` the ledger makes of its own, until the daemon's shared look feeds it (`ProcessTableSource`). */
export function psProcessTable(probe: Probe = probeCommand): ProcessTableSource {
  return async () => {
    const text = await probe(["ps", "-Ao", "uid=,pid=,ppid=,pcpu=,rss=,lstart=,args="], [0], 5_000);
    if (text === null) return null;
    const rows = parsePsTable(text);
    return rows.length ? rows : null;
  };
}

/** Where the ledger's memory lives; the suite points it elsewhere (test/preload.ts sets CONCH_CONFIG_DIR). */
export function resourceMemoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONCH_RESOURCES_FILE || join(env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "resources.json");
}

export function loadResourceMemory(path: string = resourceMemoryPath()): LedgerMemory {
  try {
    return decodeLedgerMemory(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return decodeLedgerMemory(undefined);
  }
}

export function saveResourceMemory(memory: LedgerMemory, path: string = resourceMemoryPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(memory)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } catch { /* best effort: the next change writes it again */ }
}

/** A booted simulator's name, from the XML `device.plist` CoreSimulator keeps for each device. */
export function simulatorName(udid: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | undefined {
  try {
    const plist = read(join(conchHome(), "Library", "Developer", "CoreSimulator", "Devices", udid, "device.plist"));
    const name = /<key>name<\/key>\s*<string>([^<]{1,80})<\/string>/.exec(plist)?.[1];
    return name?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  } catch {
    return undefined;
  }
}

let rusage: ((pid: number, buffer: BigUint64Array) => number) | null | undefined;

/**
 * A process's physical footprint (`proc_pid_rusage`, RUSAGE_INFO_V2's `ri_phys_footprint`), the memory Activity Monitor
 * shows; undefined when it can't be read. A call, not a spawn: about a microsecond (measured 2026-11-11).
 */
export function physicalFootprint(pid: number): number | undefined {
  if (rusage === undefined) {
    try {
      const library = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
      rusage = (target, buffer) => library.symbols.proc_pid_rusage(target, 2, ptr(buffer));
    } catch {
      rusage = null;
    }
  }
  if (!rusage) return undefined;
  const buffer = new BigUint64Array(40);
  try {
    return rusage(pid, buffer) === 0 ? Number(buffer[9]) : undefined;
  } catch {
    return undefined;
  }
}

export interface ResourceSamplerOptions {
  ledger: ResourceLedger;
  /** The live sessions and whether the read was whole; null before the first registry read. */
  sessions(): { sessions: readonly LedgerSession[]; complete: boolean } | null;
  table?: ProcessTableSource;
  probe?: Probe;
  /** conch's own processes: the daemon, and the app that hosts it. */
  ownPids?: ReadonlySet<number>;
  uid?: number;
  intervalMs?: number;
  now?(): number;
  /** Something the apps show changed. */
  onChange?(): void;
  saveMemory?(memory: LedgerMemory): void;
  readSimulatorName?(udid: string): string | undefined;
  /** A process's memory (`physicalFootprint`); undefined falls back to its resident size. */
  memoryOf?(pid: number): number | undefined;
  log?(line: string): void;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

export class ResourceSampler {
  private running: Promise<void> | null = null;
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private lastListenersAt = Number.NEGATIVE_INFINITY;
  private listeners: Map<number, number[]> | null = null;
  private seenKeys = new Set<string>();
  /** What was new at the last look: one still running now has lived through a look, and may have started listening. */
  private newKeys = new Set<string>();
  private savedMemory = "";
  /** The last table, for resolving a declaration without another look. */
  private lastTable: ProcessTable = [];
  private readonly table: ProcessTableSource;
  private readonly probe: Probe;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: ResourceSamplerOptions) {
    this.probe = options.probe ?? probeCommand;
    this.table = options.table ?? psProcessTable(this.probe);
    this.intervalMs = options.intervalMs ?? RESOURCE_SAMPLE_MS;
    this.now = options.now ?? Date.now;
    this.savedMemory = JSON.stringify(options.ledger.memory);
  }

  /**
   * One look, unless one is under way or the last was less than an interval ago. `force`: right after Tyler's own
   * action (a stop), so what he stopped leaves the list now rather than at the next look.
   */
  sample(force = false): Promise<void> {
    if (this.running) return this.running;
    if (!force && this.now() - this.lastSampleAt < this.intervalMs * 0.9) return Promise.resolve();
    this.lastSampleAt = this.now();
    this.running = this.look().catch((error) => this.options.log?.(`resources: a look failed: ${error}`)).finally(() => { this.running = null; });
    return this.running;
  }

  private async look(): Promise<void> {
    const { ledger } = this.options;
    const read = this.options.sessions();
    if (!read) return;
    const table = await this.table();
    if (!table) return;
    this.lastTable = table;
    const now = this.now();
    const forest = new ProcessForest(table, read.sessions, this.options.ownPids ?? new Set(), this.options.uid);
    const wanted = ledger.wanted(forest);

    // Ports again only when something conch could own has lived through a look since it appeared (a passing command
    // never does), or it has been a while. On a busy Mac some agent starts a command every look; few outlive it.
    const keys = new Set<string>();
    for (const row of table) {
      const placement = forest.place(row.pid);
      // What could be a session's: run through its shell, an orphan, or under an agent conch has no row for. Never a
      // session's own MCP servers, an app's or the system's.
      if (placement && !placement.foreign && (!placement.session || placement.viaShell)) keys.add(processKey(row.pid, row.startedAt));
    }
    const fresh = [...this.newKeys].some((key) => keys.has(key));
    // The first look reads them anyway: then nothing is new.
    this.newKeys = this.listeners ? new Set([...keys].filter((key) => !this.seenKeys.has(key))) : new Set();
    this.seenKeys = keys;
    if (fresh || now - this.lastListenersAt >= LISTENERS_REFRESH_MS || !this.listeners) {
      const text = await this.probe(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], [0, 1], 3_000);
      if (text !== null) {
        this.listeners = parseListenerPorts(text);
        this.lastListenersAt = now;
      }
    }

    const environment = new Map<number, SessionEnvironment>();
    for (const batch of chunks(wanted.environment, 100)) {
      const text = await this.probe(["ps", "-Eww", "-o", "pid=,command=", "-p", batch.join(",")], [0, 1], 3_000);
      // A pid that can't be read (gone, or not ours) is still answered, as nothing: it is never asked again.
      const parsed = text === null ? new Map<number, SessionEnvironment>() : parseSessionEnvironments(text);
      for (const pid of batch) environment.set(pid, parsed.get(pid) ?? {});
    }
    const vmInstances = wanted.vmFiles.length
      ? parseLimaInstances(await this.probe(["lsof", "-a", "-p", wanted.vmFiles.join(","), "-Fn"], [0, 1], 3_000) ?? "")
      : new Map<number, string>();
    const cwds = wanted.cwd.length
      ? parseCwds(await this.probe(["lsof", "-a", "-p", wanted.cwd.join(","), "-d", "cwd", "-Fn"], [0, 1], 3_000) ?? "")
      : new Map<number, string>();
    // Asked and not answered is an answer too: a folder is read once in a process's life.
    for (const pid of wanted.cwd) if (!cwds.has(pid)) cwds.set(pid, "");
    const simulatorNames = new Map<string, string>();
    for (const udid of wanted.simulators) {
      const name = (this.options.readSimulatorName ?? simulatorName)(udid);
      if (name) simulatorNames.set(udid, name);
    }
    const footprint = this.options.memoryOf ?? physicalFootprint;
    const evidence: Evidence = {
      listeners: this.listeners, environment, vmInstances, cwds, simulatorNames,
      memoryOf: (row) => footprint(row.pid) ?? row.rss,
    };
    let changed = ledger.observe(forest, evidence, now, read.complete);
    changed = await this.autoBackground(now) || changed;
    const memory = JSON.stringify(ledger.memory);
    if (memory !== this.savedMemory) {
      this.savedMemory = memory;
      (this.options.saveMemory ?? saveResourceMemory)(ledger.memory);
    }
    if (changed) this.options.onChange?.();
  }

  /**
   * `agent-auto-background`: while agents are over their CPU budget, a heavy leftover goes to macOS's background band.
   * It still runs, after what Tyler is doing; nothing is stopped or paused, and Restore priority takes it back.
   */
  private async autoBackground(now: number): Promise<boolean> {
    let moved = false;
    for (const entry of this.options.ledger.autoBackgroundCandidates(now)) {
      const done = await controlResource(entry, "lower", { table: async () => this.lastTable, probe: this.probe });
      if (!done.ok) continue;
      this.options.ledger.markLowered(entry, "auto", now);
      this.options.log?.(`resources: agents are over their CPU budget; lowered the priority of ${entry.title} (${entry.id}${entry.owner ? `, ${entry.owner.label}'s` : ""})`);
      moved = true;
    }
    return moved;
  }

  /** The table the last look read. */
  latestTable(): ProcessTable {
    return this.lastTable;
  }

  /** After a decision, so the apps hear it now rather than at the next look. */
  persist(): void {
    const memory = JSON.stringify(this.options.ledger.memory);
    if (memory === this.savedMemory) return;
    this.savedMemory = memory;
    (this.options.saveMemory ?? saveResourceMemory)(this.options.ledger.memory);
  }
}

// MARK: stopping, only ever when asked

export interface StopDependencies {
  /** A fresh table: a stop acts on what runs now, not on the last look. Read again before a SIGKILL. */
  table: ProcessTableSource;
  probe?: Probe;
  signal?(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** Whether a pid still exists (`kill -0`): polled while it is given time to quit. */
  alive?(pid: number): boolean;
  graceMs?: number;
  sleep?(ms: number): Promise<void>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sameSecond = (a: number, b: number) => Math.floor(a / 1000) === Math.floor(b / 1000);

/**
 * Stop one resource gracefully: `colima stop`, `limactl stop`, `xcrun simctl shutdown`, or SIGTERM to its group (the
 * top of it and everything under it, as a fresh table has them), then, after a wait, SIGKILL to whatever is still
 * there. A pid is signalled only while it is the process conch recorded: the same pid with the same start, in a table
 * read just before the signal.
 */
export async function stopResource(entry: ResourceEntry, deps: StopDependencies): Promise<{ ok: true } | { ok: false; error: string }> {
  const probe = deps.probe ?? probeCommand;
  if (entry.kind === "vm" && entry.vm) {
    const argv = entry.vm.tool === "colima"
      ? ["colima", "stop", ...(entry.vm.name === "default" ? [] : ["--profile", entry.vm.name])]
      : ["limactl", "stop", entry.vm.name];
    return await probe(argv, [0], 180_000) === null ? { ok: false, error: `${argv.slice(0, 2).join(" ")} failed` } : { ok: true };
  }
  if (entry.kind === "simulator" && entry.udid) {
    return await probe(["xcrun", "simctl", "shutdown", entry.udid], [0], 60_000) === null
      ? { ok: false, error: "xcrun simctl shutdown failed" } : { ok: true };
  }
  const now = await groupNow(entry, deps.table);
  if ("error" in now) return { ok: false, error: now.error };
  const group = now.group;
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name));
  const alive = deps.alive ?? pidAlive;
  const sleep = deps.sleep ?? ((ms) => Bun.sleep(ms));
  const sent: ProcessRow[] = [];
  for (const row of group) {
    try {
      signal(row.pid, "SIGTERM");
      sent.push(row);
    } catch { /* gone already */ }
  }
  if (!sent.length) return { ok: false, error: "nothing in it could be signalled" };
  const grace = deps.graceMs ?? STOP_GRACE_MS;
  for (let waited = 0; waited < grace && sent.some((row) => alive(row.pid)); waited += 250) await sleep(250);
  const left = sent.filter((row) => alive(row.pid));
  if (!left.length) return { ok: true };
  // Still there after the wait: SIGKILL, to what is still the same process by a fresh table.
  const after = new Map(((await deps.table()) ?? []).map((row) => [row.pid, row]));
  for (const row of left) {
    const now = after.get(row.pid);
    if (!now || !sameSecond(now.startedAt, row.startedAt)) continue;
    try {
      signal(row.pid, "SIGKILL");
    } catch { /* gone in between */ }
  }
  return { ok: true };
}

/** A resource's group as it runs now: the top as recorded (else the process it is named for), and everything under it. */
async function groupNow(entry: ResourceEntry, read: ProcessTableSource): Promise<{ group: ProcessRow[] } | { error: string }> {
  const table = await read();
  if (!table) return { error: "couldn't read the process table" };
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const matches = (point: { pid: number; startedAt: number }) => {
    const row = byPid.get(point.pid);
    return row !== undefined && sameSecond(row.startedAt, point.startedAt);
  };
  const top = matches(entry.root) ? entry.root : matches(entry.anchor) ? entry.anchor : undefined;
  if (!top) return { error: "it is no longer running as the process conch recorded" };
  return { group: [byPid.get(top.pid)!, ...new ProcessForest(table, []).descendants(top.pid)] };
}

export interface ControlDependencies {
  table: ProcessTableSource;
  probe?: Probe;
  signal?(pid: number, signal: "SIGSTOP" | "SIGCONT"): void;
}

/** `taskpolicy -b|-B -p <pid>` for each: macOS's background band, and back. Says which it couldn't. */
async function setBackground(rows: readonly ProcessRow[], on: boolean, probe: Probe): Promise<{ ok: true } | { ok: false; error: string }> {
  let failed = 0;
  for (const row of rows) if (await probe(["taskpolicy", on ? "-b" : "-B", "-p", String(row.pid)], [0], 3_000) === null) failed += 1;
  return failed === rows.length && rows.length ? { ok: false, error: "taskpolicy refused every process in it" } : { ok: true };
}

/**
 * Hold a resource (SIGSTOP to its group as it runs now) or let it go on (SIGCONT); move it to macOS's background band
 * (`taskpolicy -b`), where it runs only after what the person is doing, or back (`-B`). Each only on Tyler's word, but
 * `lower` by `agent-auto-background`. Process groups only: a VM or a simulator is stopped, never held.
 */
export async function controlResource(
  entry: ResourceEntry,
  action: "hold" | "resume" | "lower" | "restore",
  deps: ControlDependencies,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!PROCESS_KINDS.has(entry.kind)) return { ok: false, error: `a ${entry.kind === "vm" ? "VM" : entry.kind} can be stopped, not ${action === "hold" || action === "resume" ? "held" : "reprioritised"}` };
  const now = await groupNow(entry, deps.table);
  if ("error" in now) return { ok: false, error: now.error };
  if (action === "lower" || action === "restore") return setBackground(now.group, action === "lower", deps.probe ?? probeCommand);
  const signal = deps.signal ?? ((pid, name) => process.kill(pid, name));
  let sent = 0;
  for (const row of now.group) {
    try {
      signal(row.pid, action === "hold" ? "SIGSTOP" : "SIGCONT");
      sent += 1;
    } catch { /* gone */ }
  }
  return sent ? { ok: true } : { ok: false, error: "nothing in it could be signalled" };
}

/** A whole session to the background band or back: its own process and everything under it, as they run now. */
export async function controlSession(session: LedgerSession, action: "lower" | "restore", deps: Pick<ControlDependencies, "table" | "probe">): Promise<{ ok: true } | { ok: false; error: string }> {
  const table = await deps.table();
  if (!table) return { ok: false, error: "couldn't read the process table" };
  const forest = new ProcessForest(table, []);
  const rows = session.pids.flatMap((pid) => (forest.byPid.has(pid) ? [forest.byPid.get(pid)!, ...forest.descendants(pid)] : []));
  if (!rows.length) return { ok: false, error: "its processes aren't running" };
  return setBackground(rows, action === "lower", deps.probe ?? probeCommand);
}

// MARK: requests

export interface ResourceRequestDependencies {
  ledger: ResourceLedger;
  sampler: ResourceSampler;
  /**
   * Who is asking: a session (an agent's shell), a person (a terminal no session started, or the Mac app, which sends
   * no pid), or someone conch can't place (`reason`).
   */
  caller(callerPid: number | undefined): Promise<{ session?: LedgerSession; person?: true; reason?: string }>;
  stop(entry: ResourceEntry): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Hold, resume, lower or restore a resource (`controlResource`). */
  control(entry: ResourceEntry, action: "hold" | "resume" | "lower" | "restore"): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Lower or restore a whole session (`controlSession`). */
  controlSession(session: LedgerSession, action: "lower" | "restore"): Promise<{ ok: true } | { ok: false; error: string }>;
  /** The process listening on a port (`portListenerLookup`). */
  listenerPid?(port: number): Promise<number | undefined>;
  onChange(): void;
  log(line: string): void;
  now?(): number;
}

const agentIdOf = (session: LedgerSession) => session.agentSessionId ?? session.sessionId;

/** A `resources`, `resource-decide` or `resource-add`, answered. */
export async function handleResourceRequest(request: ResourceRequest, deps: ResourceRequestDependencies): Promise<ResourceReply> {
  const now = deps.now?.() ?? Date.now();
  const { ledger } = deps;
  if (request.kind === "resources") return { kind: "resources", resources: ledger.published(now) };

  if (request.kind === "resource-decide") {
    const entry = ledger.find(request.id);
    if (!entry) return { kind: "resource-error", error: `nothing running is ${request.id}: \`conch resources\` lists what is` };
    const caller = await deps.caller(request.callerPid);
    // An agent may decide for what is its own session's, like a `kill` of its own. Anything else is Tyler's to decide.
    if (!caller.person) {
      const mine = caller.session && entry.owner && entry.owner.agentSessionId === agentIdOf(caller.session);
      if (!mine) {
        const whose = entry.owner ? `${entry.owner.label}'s` : "no session's";
        return { kind: "resource-error", error: `${entry.title} is ${whose}, so it is the user's to ${request.action}: the Mac app's Still running, or \`conch resources\` in a terminal` + (caller.reason ? ` (${caller.reason})` : "") };
      }
    }
    if (request.action === "stop") {
      ledger.markStopping(entry, now);
      deps.onChange();
      deps.log(`resources: stopping ${entry.title} (${entry.id}${entry.owner ? `, ${entry.owner.label}'s` : ", unowned"}), as asked`);
      const stopped = await deps.stop(entry);
      if (!stopped.ok) {
        ledger.stopFailed(entry, stopped.error, deps.now?.() ?? Date.now());
        deps.onChange();
        deps.log(`resources: couldn't stop ${entry.title} (${entry.id}): ${stopped.error}`);
        return { kind: "resource-error", error: `couldn't stop ${entry.title}: ${stopped.error}` };
      }
      void deps.sampler.sample(true);
      return { kind: "resource-done", id: entry.id, action: "stop", title: entry.title, state: "stopping", message: `stopped ${entry.title}` };
    }
    if (request.action === "hold" || request.action === "resume" || request.action === "lower" || request.action === "restore") {
      const done = await deps.control(entry, request.action);
      if (!done.ok) return { kind: "resource-error", error: `couldn't ${request.action} ${entry.title}: ${done.error}` };
      if (request.action === "hold" || request.action === "resume") ledger.markHeld(entry, request.action === "hold", now);
      else ledger.markLowered(entry, request.action === "lower" ? "you" : null, now);
      deps.sampler.persist();
      deps.onChange();
      deps.log(`resources: ${request.action} ${entry.title} (${entry.id}), as asked`);
      const said = { hold: `paused ${entry.title}; Resume lets it go on`, resume: `${entry.title} goes on`, lower: `${entry.title} runs after everything else now; Restore priority takes it back`, restore: `${entry.title} runs at its usual priority again` };
      return { kind: "resource-done", id: entry.id, action: request.action, title: entry.title, state: ledger.stateOf(entry, now).state, message: said[request.action] };
    }
    ledger.decide(entry.id, request.action, now);
    deps.sampler.persist();
    deps.onChange();
    deps.log(`resources: ${request.action === "keep" ? "keeping" : "asking later about"} ${entry.title} (${entry.id})`);
    const state = ledger.stateOf(entry, now).state;
    return {
      kind: "resource-done", id: entry.id, action: request.action, title: entry.title, state,
      message: request.action === "keep" ? `keeping ${entry.title}; conch won't ask about it again` : `conch will ask about ${entry.title} again in 4 hours`,
    };
  }

  if (request.kind === "resource-session") {
    // A whole session to the background band, or back: the throttle the budget offers for a session that is over it.
    const session = ledger.liveSession(request.sessionId);
    if (!session) return { kind: "resource-error", error: `no live session is ${request.sessionId}` };
    const caller = await deps.caller(request.callerPid);
    if (!caller.person) return { kind: "resource-error", error: `lowering a session's priority is the user's to do: Settings › Resources${caller.reason ? ` (${caller.reason})` : ""}` };
    const done = await deps.controlSession(session, request.action);
    if (!done.ok) return { kind: "resource-error", error: `couldn't ${request.action} ${session.label}: ${done.error}` };
    ledger.markSessionLowered(session, request.action === "lower", now);
    deps.sampler.persist();
    deps.onChange();
    deps.log(`resources: ${request.action} the priority of ${session.label}, as asked`);
    return {
      kind: "resource-done", id: session.sessionId, action: request.action, title: session.label,
      message: request.action === "lower" ? `${session.label} runs after everything else now` : `${session.label} runs at its usual priority again`,
    };
  }

  // resource-add: a session's own declaration, from its shell.
  const caller = await deps.caller(request.callerPid);
  if (!caller.session) {
    return { kind: "resource-error", error: `conch can't tell which session is asking${caller.reason ? ` (${caller.reason})` : ""}: run it from the session's own shell` };
  }
  const lifetime = parseLifetime(request.until, now);
  if ("error" in lifetime) return { kind: "resource-error", error: lifetime.error };
  const resolved = await resolveTarget(request.target, deps.sampler.latestTable(), deps.listenerPid);
  if ("error" in resolved) return { kind: "resource-error", error: resolved.error };
  const owner: ResourceOwner = { agentSessionId: agentIdOf(caller.session), sessionId: caller.session.sessionId, label: caller.session.label, how: "declared" };
  ledger.declare(resolved.identity, { owner, lifetime, ...(request.why ? { why: request.why } : {}), at: now });
  deps.sampler.persist();
  deps.onChange();
  deps.log(`resources: ${caller.session.label} declared ${resolved.title} ${request.until}`);
  return {
    kind: "resource-done", id: resolved.identity, action: "add", title: resolved.title,
    message: `${resolved.title} is ${caller.session.label}'s, ${request.until === "keep" ? "kept" : `until ${request.until}`}; it shows in \`conch resources\` from the next look (within 30 s)`,
  };
}

/** What a declaration names, as the ledger's identity for it. */
export async function resolveTarget(
  target: ResourceTarget,
  table: ProcessTable,
  listenerPid?: (port: number) => Promise<number | undefined>,
  startedAt: (pid: number) => number | undefined = (pid) => readProcessIdentity(pid)?.birthTimeMs,
): Promise<{ identity: string; title: string } | { error: string }> {
  if ("simulator" in target) {
    const booted = table.flatMap((row) => {
      if (!/(^|\/)launchd_sim\s/.test(row.args)) return [];
      const udid = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/.exec(row.args)?.[0];
      return udid ? [{ udid, row, name: simulatorName(udid) }] : [];
    });
    const wanted = target.simulator.trim();
    const found = wanted.toLowerCase() === "booted"
      ? (booted.length === 1 ? booted : [])
      : booted.filter((sim) => sim.udid.toLowerCase() === wanted.toLowerCase() || sim.name === wanted);
    if (found.length !== 1) {
      return { error: wanted.toLowerCase() === "booted" && booted.length > 1
        ? `${booted.length} simulators are booted: name one by its UDID`
        : `no booted simulator is ${wanted}${booted.length ? ` (booted: ${booted.map((sim) => sim.name ?? sim.udid).join(", ")})` : ""}` };
    }
    const sim = found[0]!;
    return { identity: `sim:${sim.udid}@${Math.floor(sim.row.startedAt / 1000)}`, title: `${sim.name ?? sim.udid.slice(0, 8)} simulator` };
  }
  if ("vm" in target) {
    const instances = target.vm === "default" || target.vm === "colima" ? ["colima"] : [`colima-${target.vm}`, target.vm];
    const agent = table.find((row) => /(^|\/)limactl\s+hostagent\b/.test(row.args) && instances.includes(limaInstance(row.args) ?? ""));
    if (!agent) return { error: `no running colima or lima VM is ${target.vm}` };
    const vm = vmFromInstance(limaInstance(agent.args)!);
    return { identity: `vm:${limaInstance(agent.args)}@${Math.floor(agent.startedAt / 1000)}`, title: `${vm.tool} ${vm.name}` };
  }
  let pid = "pid" in target ? target.pid : undefined;
  if ("port" in target) {
    pid = await listenerPid?.(target.port);
    if (!pid) return { error: `nothing is listening on port ${target.port}` };
  }
  const row = table.find((each) => each.pid === pid);
  const start = row?.startedAt ?? startedAt(pid!);
  if (start === undefined || !Number.isFinite(start)) return { error: `no process ${pid} is running` };
  return { identity: processKey(pid!, start), title: row ? `pid ${pid} (${row.args.split(/\s/, 1)[0]?.split("/").pop()})` : `pid ${pid}` };
}

export type { ResourceAction };

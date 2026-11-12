/**
 * Load: green, yellow and red for what each session is using, and the budget agents may use together.
 *
 * Tyler, 2026-11-11: "long term conch should probably show in its UI with green, yellow, red what sessions are using what
 * in some view in settings or something and this can be connected to the who owns what idea … Long term u should prob
 * be setting the 'budget' for how much continuous load agents can use in conch."
 *
 * Every figure here is sustained: CPU is the mean of the looks in the last five minutes (`SUSTAIN_WINDOW_MS`), never
 * one look, so a test run that pegs a core for twenty seconds stays green and a dev server that idles at 90% for an hour
 * does not. Memory is the physical footprint, as Activity Monitor counts it. Pure: the ledger feeds it samples.
 */

export type Level = "green" | "yellow" | "red";

/** The window CPU is averaged over. */
export const SUSTAIN_WINDOW_MS = 5 * 60_000;
/** A mean of fewer looks than this (a minute at 30 s apart) says nothing about sustained load yet. */
export const SUSTAIN_MIN_LOOKS = 3;

const GB = 1024 ** 3;

/**
 * One resource. CPU in per cent of one core: half a core for five minutes is worth a look, two cores is too much for
 * something left running. Memory: 2 GB is a big dev server; 8 GB is a VM or a simulator, which is what they cost.
 * Past its lifetime: asking is yellow, still asking a day later is red; unowned for a day is yellow.
 */
export const RESOURCE_THRESHOLDS = {
  cpu: { yellow: 50, red: 200 },
  memory: { yellow: 2 * GB, red: 8 * GB },
  overdueRedMs: 24 * 60 * 60_000,
  unownedYellowMs: 24 * 60 * 60_000,
} as const;

/**
 * One session: its own process, everything under it (its MCP servers, the commands it runs) and what it left running.
 * A working agent with its MCP servers sits under a core; a build or a test gate takes one or two for minutes, which is
 * fine and yellow; three for five minutes is red. Memory: 4 GB and 12 GB.
 */
export const SESSION_THRESHOLDS = {
  cpu: { yellow: 100, red: 300 },
  memory: { yellow: 4 * GB, red: 12 * GB },
} as const;

/** The budget turns yellow at three quarters used, red past it. */
export const BUDGET_YELLOW = 0.75;

const RANK: Record<Level, number> = { green: 0, yellow: 1, red: 2 };
export const worse = (a: Level, b: Level): Level => (RANK[b] > RANK[a] ? b : a);

/** CPU looks per key (a resource's identity, a session, the total), the last `SUSTAIN_WINDOW_MS` of them. */
export class CpuHistory {
  private looks = new Map<string, Array<{ at: number; cpu: number }>>();

  record(key: string, at: number, cpu: number): void {
    const list = (this.looks.get(key) ?? []).filter((look) => at - look.at < SUSTAIN_WINDOW_MS);
    list.push({ at, cpu });
    this.looks.set(key, list);
  }

  /** The mean over the window, and whether there are enough looks for it to mean "sustained". */
  sustained(key: string, now: number): { cpu: number; sustained: boolean } | undefined {
    const list = (this.looks.get(key) ?? []).filter((look) => now - look.at < SUSTAIN_WINDOW_MS);
    if (!list.length) return undefined;
    return { cpu: list.reduce((sum, look) => sum + look.cpu, 0) / list.length, sustained: list.length >= SUSTAIN_MIN_LOOKS };
  }

  /** Forget keys not looked at this time. */
  keep(keys: ReadonlySet<string>): void {
    for (const key of this.looks.keys()) if (!keys.has(key)) this.looks.delete(key);
  }
}

export function coresText(percentOfOneCore: number): string {
  const cores = percentOfOneCore / 100;
  return cores >= 0.95 ? `${cores.toFixed(1)} cores` : `${Math.round(percentOfOneCore)}% of a core`;
}

function gbText(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** A level from CPU (only once sustained) and memory against a pair of thresholds, with why, worst first. */
export function loadLevel(
  usage: { cpu?: { cpu: number; sustained: boolean }; memory: number },
  thresholds: { cpu: { yellow: number; red: number }; memory: { yellow: number; red: number } },
): { level: Level; reasons: string[] } {
  const found: Array<{ level: Level; reason: string }> = [];
  if (usage.cpu?.sustained) {
    const cpu = usage.cpu.cpu;
    if (cpu >= thresholds.cpu.red) found.push({ level: "red", reason: `${coresText(cpu)} for 5 min` });
    else if (cpu >= thresholds.cpu.yellow) found.push({ level: "yellow", reason: `${coresText(cpu)} for 5 min` });
  }
  if (usage.memory >= thresholds.memory.red) found.push({ level: "red", reason: `${gbText(usage.memory)} of memory` });
  else if (usage.memory >= thresholds.memory.yellow) found.push({ level: "yellow", reason: `${gbText(usage.memory)} of memory` });
  found.sort((a, b) => RANK[b.level] - RANK[a.level]);
  return { level: found.reduce<Level>((level, each) => worse(level, each.level), "green"), reasons: found.map((each) => each.reason) };
}

/** One resource's level: its load, then how long past its lifetime it has run. */
export function resourceLevel(
  resource: { cpu?: { cpu: number; sustained: boolean }; memory: number; state: string; startedAt: number; dueSince?: number },
  now: number,
): { level: Level; reasons: string[] } {
  const load = loadLevel(resource, RESOURCE_THRESHOLDS);
  let level = load.level;
  const reasons = [...load.reasons];
  if (resource.state === "asking") {
    const overdue = resource.dueSince !== undefined && now - resource.dueSince >= RESOURCE_THRESHOLDS.overdueRedMs;
    level = worse(level, overdue ? "red" : "yellow");
    reasons.push(overdue ? "past its time for over a day" : "past its time");
  } else if (resource.state === "unowned" && now - resource.startedAt >= RESOURCE_THRESHOLDS.unownedYellowMs) {
    level = worse(level, "yellow");
    reasons.push("no one's, for over a day");
  }
  return { level, reasons };
}

export interface BudgetSettings {
  /** Percent of this Mac's cores (`agent-budget-cpu`). */
  cpuPercent: number;
  /** Percent of its memory (`agent-budget-memory`). */
  memoryPercent: number;
  /** `agent-auto-background`. */
  autoBackground: boolean;
}

export interface Machine {
  cores: number;
  /** Bytes. */
  memory: number;
}

/** What one owner uses: a live session's tree and leftovers, an ended session's leftovers, or everything unowned. */
export interface SessionUsage {
  /** The agent's session id, or "unowned". */
  key: string;
  /** Its row, while it is live. */
  sessionId?: string;
  label: string;
  live: boolean;
  /** Per cent of one core, the mean over the window. */
  cpu: number;
  sustained: boolean;
  memory: number;
  /** How many listed resources are its. */
  resources: number;
  level: Level;
  reasons: string[];
  /** Over the budget: one of the sessions that together make up what is over it. */
  over?: true;
  /** Its processes are in the background band (`taskpolicy -b`), by Tyler's word. */
  lowered?: true;
}

export interface PublishedBudget {
  cpuPercent: number;
  memoryPercent: number;
  autoBackground: boolean;
  cores: number;
  /** The budget: per cent of one core, and bytes. */
  cpuLimit: number;
  memoryLimit: number;
  /** What every agent uses together, sustained; unowned things don't count. */
  cpu: number;
  sustained: boolean;
  memory: number;
  level: Level;
  /** The sessions that make up what is over, heaviest first. */
  over: string[];
  /** Why it is the level it is, in a few words. */
  reason: string;
}

/**
 * Usage against the budget. Over it, the heaviest sessions are named until what is left fits: those are the ones that
 * holding or lowering would bring it back under. Weighed by whichever of CPU or memory is further over.
 */
export function budgetOf(settings: BudgetSettings, machine: Machine, sessions: readonly SessionUsage[], total: { cpu: number; sustained: boolean; memory: number }): PublishedBudget {
  const cpuLimit = machine.cores * settings.cpuPercent;
  const memoryLimit = machine.memory * settings.memoryPercent / 100;
  const cpuShare = total.sustained ? total.cpu / cpuLimit : 0;
  const memoryShare = total.memory / memoryLimit;
  const share = Math.max(cpuShare, memoryShare);
  const level: Level = share > 1 ? "red" : share >= BUDGET_YELLOW ? "yellow" : "green";
  const over: string[] = [];
  if (level === "red") {
    const agents = sessions.filter((session) => session.key !== "unowned")
      .map((session) => ({ session, weight: Math.max(cpuShare > 1 ? session.cpu / cpuLimit : 0, memoryShare > 1 ? session.memory / memoryLimit : 0) }))
      .filter((each) => each.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    let cpu = total.cpu;
    let memory = total.memory;
    for (const { session } of agents) {
      if ((cpuShare <= 1 || cpu <= cpuLimit) && (memoryShare <= 1 || memory <= memoryLimit)) break;
      over.push(session.key);
      cpu -= session.cpu;
      memory -= session.memory;
    }
  }
  const parts = [`${coresText(total.cpu)} of ${coresText(cpuLimit)}${total.sustained ? "" : " (not yet 5 min)"}`, `${gbText(total.memory)} of ${gbText(memoryLimit)}`];
  return {
    cpuPercent: settings.cpuPercent,
    memoryPercent: settings.memoryPercent,
    autoBackground: settings.autoBackground,
    cores: machine.cores,
    cpuLimit,
    memoryLimit,
    cpu: Math.round(total.cpu),
    sustained: total.sustained,
    memory: total.memory,
    level,
    over,
    reason: `agents are using ${parts.join(" and ")}`,
  };
}

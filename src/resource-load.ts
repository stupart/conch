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
  /** `agent-budget-cpu`, as `parseCpuBudget` keeps it: "75%" or "14 cores". */
  cpu: string;
  /** `agent-budget-memory`, as `parseMemoryBudget` keeps it: "60%" or "100 GB". */
  memory: string;
  /** `agent-auto-background`. */
  autoBackground: boolean;
}

export interface Machine {
  cores: number;
  /** Bytes. */
  memory: number;
}

// MARK: the budget's settings, as a share or as an amount

/**
 * A budget is a share of this Mac or an amount of it (2026-11-12). Tyler: "should we make it 14 cores and 100GB just to
 * be cleaner?" conch runs on other Macs too, so the defaults stay shares (75% and 60%), and either form is taken:
 * `agent-budget-cpu` 75% or 14 (14 cores), `agent-budget-memory` 60% or 100 GB. A GB is a GiB, 1024³ bytes, as
 * Activity Monitor counts memory. Kept as written, canonical ("14 cores", "100 GB"), so it reads back in its own unit.
 */
export type BudgetAmount = { percent: number } | { cores: number } | { gib: number };

const number = (text: string) => (/^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN);
const tidy = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10));
const gibOf = (bytes: number) => bytes / GB;

/** "75%", "14", "14 cores", "13.5 core" (or a JSON number of cores), checked against this Mac: "75%" or "14 cores". */
export function parseCpuBudget(raw: unknown, machine: Machine): { ok: true; value: string } | { ok: false; err: string } {
  const usage = `a share of this Mac's ${machine.cores} cores (like 75%) or a number of cores (like ${Math.min(14, machine.cores)}), at most ${machine.cores}`;
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const share = /^(\S+?)\s*%$/.exec(text);
  if (share) {
    const percent = number(share[1]!);
    if (!(percent > 0 && percent <= 100)) return { ok: false, err: `expected ${usage}; a share is more than 0% and at most 100%, not "${raw}"` };
    return { ok: true, value: `${tidy(percent)}%` };
  }
  const cores = number(/^(\S+?)\s*(cores?|c)?$/.exec(text)?.[1] ?? "");
  if (!Number.isFinite(cores)) return { ok: false, err: `expected ${usage}, not "${String(raw)}"` };
  if (cores <= 0) return { ok: false, err: `expected ${usage}; 0 cores would leave agents nothing` };
  if (cores > machine.cores) return { ok: false, err: `expected ${usage}; this Mac has ${machine.cores} cores, not ${tidy(cores)}` };
  return { ok: true, value: `${tidy(cores)} ${cores === 1 ? "core" : "cores"}` };
}

/** "60%", "100GB", "100 GB", "100G", "100 GiB", checked against this Mac: "60%" or "100 GB". A bare number isn't one. */
export function parseMemoryBudget(raw: unknown, machine: Machine): { ok: true; value: string } | { ok: false; err: string } {
  const total = gibOf(machine.memory);
  const usage = `a share of this Mac's memory (like 60%) or an amount in GB (like ${Math.min(100, Math.floor(total))} GB; GiB, as Activity Monitor counts), at most ${tidy(total)} GB`;
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const share = /^(\S+?)\s*%$/.exec(text);
  if (share) {
    const percent = number(share[1]!);
    if (!(percent > 0 && percent <= 100)) return { ok: false, err: `expected ${usage}; a share is more than 0% and at most 100%, not "${raw}"` };
    return { ok: true, value: `${tidy(percent)}%` };
  }
  const amount = /^(\S+?)\s*(g|gb|gib)$/.exec(text);
  const gib = number(amount?.[1] ?? "");
  if (!amount || !Number.isFinite(gib)) return { ok: false, err: `expected ${usage}, not "${String(raw)}"` };
  if (gib <= 0) return { ok: false, err: `expected ${usage}; 0 GB would leave agents nothing` };
  // A hair over, for a total that isn't a whole number of GiB.
  if (gib > total + 0.05) return { ok: false, err: `expected ${usage}; this Mac has ${tidy(total)} GB, not ${tidy(gib)}` };
  return { ok: true, value: `${tidy(gib)} GB` };
}

/** What a kept setting says: a share, cores, or GiB. Something unreadable is the default's share. */
export function budgetAmount(text: string, fallbackPercent: number): BudgetAmount {
  const value = text.trim().toLowerCase();
  const share = /^([\d.]+)%$/.exec(value);
  if (share) return { percent: Number(share[1]) };
  const cores = /^([\d.]+) cores?$/.exec(value);
  if (cores) return { cores: Number(cores[1]) };
  const gib = /^([\d.]+) gb$/.exec(value);
  if (gib) return { gib: Number(gib[1]) };
  return { percent: fallbackPercent };
}

/** The CPU budget in per cent of one core, never more than the Mac has. */
export function cpuLimitOf(setting: string, machine: Machine): number {
  const amount = budgetAmount(setting, 75);
  const cores = "cores" in amount ? amount.cores : "percent" in amount ? machine.cores * amount.percent / 100 : machine.cores * 0.75;
  return Math.min(machine.cores, cores) * 100;
}

/** The memory budget in bytes, never more than the Mac has. */
export function memoryLimitOf(setting: string, machine: Machine): number {
  const amount = budgetAmount(setting, 60);
  const bytes = "gib" in amount ? amount.gib * GB : "percent" in amount ? machine.memory * amount.percent / 100 : machine.memory * 0.6;
  return Math.min(machine.memory, bytes);
}

/** In the unit it was set in, the other beside it: "14 cores (78% of 18)", "75% of 18 cores (13.5)". */
export function cpuBudgetText(setting: string, machine: Machine): string {
  const amount = budgetAmount(setting, 75);
  if ("cores" in amount) return `${tidy(amount.cores)} ${amount.cores === 1 ? "core" : "cores"} (${Math.round(amount.cores / machine.cores * 100)}% of ${machine.cores})`;
  const percent = "percent" in amount ? amount.percent : 75;
  return `${tidy(percent)}% of ${machine.cores} cores (${tidy(machine.cores * percent / 100)})`;
}

/** "100 GB (78% of 128 GB)", "60% of 128 GB (76.8 GB)". */
export function memoryBudgetText(setting: string, machine: Machine): string {
  const amount = budgetAmount(setting, 60);
  const total = gibOf(machine.memory);
  if ("gib" in amount) return `${tidy(amount.gib)} GB (${Math.round(amount.gib / total * 100)}% of ${tidy(total)} GB)`;
  const percent = "percent" in amount ? amount.percent : 60;
  return `${tidy(percent)}% of ${tidy(total)} GB (${tidy(total * percent / 100)} GB)`;
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
  /** The settings as kept ("75%", "14 cores"; "60%", "100 GB"), and as said in both units (`cpuBudgetText`). */
  cpuSetting: string;
  memorySetting: string;
  cpuText: string;
  memoryText: string;
  autoBackground: boolean;
  cores: number;
  /** This Mac's memory, bytes. */
  memoryTotal: number;
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
  const cpuLimit = cpuLimitOf(settings.cpu, machine);
  const memoryLimit = memoryLimitOf(settings.memory, machine);
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
    cpuSetting: settings.cpu,
    memorySetting: settings.memory,
    cpuText: cpuBudgetText(settings.cpu, machine),
    memoryText: memoryBudgetText(settings.memory, machine),
    autoBackground: settings.autoBackground,
    cores: machine.cores,
    memoryTotal: machine.memory,
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

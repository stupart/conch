import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * Which live sessions can't get conch's current MCP tools, so the app can offer to restart them.
 *
 * A session starts conch's MCP server once and keeps the tools it loaded then. Since 15 Oct a running server can hand
 * over to a newer conch's (mcp-handoff.ts), but only a server started after that can. 2026-10-18 review: 18 of the 21
 * running `conch mcp` processes started before it, the oldest on 22 Sep, so they could never get the browser tools,
 * and no agent in a session that lacked them ever used them; agents drove Chrome, Playwright and computer use instead.
 *
 * So each server says what it has: a small file of its own (`McpServerReport`) beside conch's other files, written when
 * it starts and when its client initializes, removed when it exits. The daemon reads them, with the `conch mcp`
 * processes on the Mac (a server older than reports says nothing, and is found by its process instead), and marks each
 * live session whose server can't get the current tools: `toolsStale` on its row in the sessions file.
 */

export interface McpServerReport {
  v: 1;
  /** This server's pid. */
  pid: number;
  /** The session process it serves (a hand-off's fresh server names the session, not the server it replaced). */
  sessionPid: number;
  /** Its toolset fingerprint (`MCP_TOOLSET`). */
  toolset: string;
  /** Its tools' names. */
  tools: string[];
  /** Whether it can hand over to a newer conch's server (mcp-handoff.ts); a server a hand-off started cannot. */
  handoff: boolean;
  version: string;
  /** Epoch ms. */
  startedAt: number;
  /** The agent it serves, once its `initialize` has said. */
  client?: "claude" | "codex";
}

/** What the daemon puts on a session's row: the tools it is missing, and why it won't get them without a restart. */
export interface ToolsStale {
  missing: string[];
  /** reported: its server said which tools it has. estimated: a server too old to say, judged by when it started. */
  basis: "reported" | "estimated";
  /** When its conch MCP server started, ISO 8601. */
  serverStartedAt: string;
  why: string;
  fix: string;
}

/** Where the reports live; the suite points it at its own root (test/preload.ts sets CONCH_CONFIG_DIR). */
export function mcpServersDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CONCH_MCP_SERVERS_DIR || join(env.CONCH_CONFIG_DIR ?? join(conchHome(), ".config", "conch"), "mcp-servers");
}

/** Write one server's report; best effort, like the call log: nothing here may break a server. */
export function writeMcpServerReport(report: McpServerReport, dir: string = mcpServersDir()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${report.pid}.json`);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch {}
}

export function removeMcpServerReport(pid: number, dir: string = mcpServersDir()): void {
  try {
    rmSync(join(dir, `${pid}.json`), { force: true });
  } catch {}
}

function isReport(value: unknown): value is McpServerReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Record<string, unknown>;
  return report.v === 1 && Number.isSafeInteger(report.pid) && Number.isSafeInteger(report.sessionPid)
    && typeof report.toolset === "string" && Array.isArray(report.tools) && report.tools.every((tool) => typeof tool === "string")
    && typeof report.handoff === "boolean" && typeof report.startedAt === "number";
}

/** Whether a pid is running: signal 0, where a process we may not signal still counts. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The reports of servers still running; a dead server's file is removed. */
export function readMcpServerReports(dir: string = mcpServersDir(), alive: (pid: number) => boolean = pidAlive): McpServerReport[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const reports: McpServerReport[] = [];
  for (const name of names) {
    let report: unknown;
    try {
      report = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (!isReport(report)) continue;
    if (alive(report.pid)) reports.push(report);
    else removeMcpServerReport(report.pid, dir);
  }
  return reports;
}

/** A `conch mcp` process on this Mac. */
export interface McpServerProcess {
  pid: number;
  ppid: number;
  /** Epoch ms. */
  startedAt: number;
}

/** `conch mcp`, installed or from a checkout (`bun run …/Conch/src/cli.ts mcp`). */
export function isConchMcpCommand(args: string): boolean {
  return /(?:^|\/)conch\s+mcp(?:\s|$)/i.test(args) || /conch[^\s]*\/src\/cli\.ts\s+mcp(?:\s|$)/i.test(args);
}

/** `ps -axo pid=,ppid=,lstart=,args=`, read: lstart is five words of local time ("Thu Oct  8 23:12:53 2026"). */
export function parseMcpServerProcesses(output: string): McpServerProcess[] {
  const servers: McpServerProcess[] = [];
  for (const line of output.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words.length < 8) continue;
    const pid = Number(words[0]);
    const ppid = Number(words[1]);
    const startedAt = Date.parse(words.slice(2, 7).join(" "));
    const args = words.slice(7).join(" ");
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(startedAt) || !isConchMcpCommand(args)) continue;
    servers.push({ pid, ppid, startedAt });
  }
  return servers;
}

/** Every `conch mcp` process on this Mac; null when `ps` can't say. */
export async function listMcpServerProcesses(): Promise<McpServerProcess[] | null> {
  try {
    const child = Bun.spawn(["ps", "-axo", "pid=,ppid=,lstart=,args="], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, LC_ALL: "C" },
    });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) return null;
    return parseMcpServerProcesses(output);
  } catch {
    return null;
  }
}

/** When the hand-off landed (#561 merged): a server started before it can never take a newer conch's tools. */
export const MCP_HANDOFF_LANDED = Date.parse("2026-10-15T23:02:44Z");

/**
 * The tools a server too old to report could have had: every tool of the build before reports (this change), and for
 * the newer of them, when they landed. A server that says nothing predates reports, so it lacks every tool not here.
 */
export const MCP_TOOLS_BEFORE_REPORTS: Readonly<Record<string, number>> = {
  conch_sessions: 0, conch_wake: 0, conch_recite: 0, conch_speak: 0, conch_mode: 0, conch_rename: 0, conch_config: 0,
  conch_transcript_tail: 0, review_to_front: 0, conch_history: 0, conch_item: 0, conch_working_folders: 0, conch_on_screen: 0,
  conch_deliverables: 0, review_remove: 0, conch_capture: 0,
  // #548, the Workbench's browser_* tools.
  browser_open: Date.parse("2026-10-12T11:20:35Z"), browser_read: Date.parse("2026-10-12T11:20:35Z"),
  browser_click: Date.parse("2026-10-12T11:20:35Z"), browser_type: Date.parse("2026-10-12T11:20:35Z"),
  browser_screenshot: Date.parse("2026-10-12T11:20:35Z"), browser_tabs: Date.parse("2026-10-12T11:20:35Z"),
  browser_close: Date.parse("2026-10-12T11:20:35Z"),
  // #561, with the hand-off.
  atlas_show: MCP_HANDOFF_LANDED,
};

/**
 * How long after this daemon starts a server that can hand over is given to do it before its session is called
 * stale: its own look comes at most every 5 minutes when idle (`MCP_HANDOFF_IDLE_CHECK_MS`), then a fresh server's start.
 */
export const HANDOFF_GRACE_MS = 7 * 60_000;

const FIX = "restart this session (close it and resume it) to get conch's current tools";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Whether one session's conch MCP server can't get the current tools, and which it is missing; undefined when it can. */
export function toolsStaleFor(options: {
  sessionPid: number | undefined;
  reports: readonly McpServerReport[];
  /** The `conch mcp` processes; null when they couldn't be listed, which leaves a silent server unjudged. */
  processes: readonly McpServerProcess[] | null;
  currentTools: readonly string[];
  currentToolset: string;
  now: number;
  /** When this daemon (and so its toolset) started. */
  since: number;
  graceMs?: number;
}): ToolsStale | undefined {
  const { sessionPid, currentTools, now } = options;
  if (!sessionPid) return undefined;
  const settling = now - options.since < (options.graceMs ?? HANDOFF_GRACE_MS);
  // The newest server serving it: after a hand-off, the fresh one.
  const reported = options.reports.filter((report) => report.sessionPid === sessionPid).sort((a, b) => b.startedAt - a.startedAt)[0];
  if (reported) {
    if (reported.toolset === options.currentToolset) return undefined;
    const has = new Set(reported.tools);
    const missing = currentTools.filter((tool) => !has.has(tool));
    if (!missing.length || (reported.handoff && settling)) return undefined;
    return {
      missing,
      basis: "reported",
      serverStartedAt: new Date(reported.startedAt).toISOString(),
      why: reported.handoff
        ? "its conch MCP server could take a newer conch's tools but hasn't"
        : "its conch MCP server was started by a hand-off, and can't take a newer conch's tools again",
      fix: FIX,
    };
  }
  const server = options.processes?.filter((process) => process.ppid === sessionPid).sort((a, b) => b.startedAt - a.startedAt)[0];
  // No conch MCP server at all (the plugin isn't loaded there, or its servers can't be listed): nothing to say.
  if (!server) return undefined;
  const canHandOver = server.startedAt >= MCP_HANDOFF_LANDED;
  if (canHandOver && settling) return undefined;
  const missing = currentTools.filter((tool) => {
    const landed = MCP_TOOLS_BEFORE_REPORTS[tool];
    return landed === undefined || landed > server.startedAt;
  });
  if (!missing.length) return undefined;
  return {
    missing,
    basis: "estimated",
    serverStartedAt: new Date(server.startedAt).toISOString(),
    why: canHandOver
      ? `its conch MCP server (started ${day(server.startedAt)}) hasn't taken the current tools`
      : `its conch MCP server started ${day(server.startedAt)}, before a running server could take a newer conch's tools (${day(MCP_HANDOFF_LANDED)})`,
    fix: FIX,
  };
}

/** The sessions file's rows with each one's `toolsStale`, by row id. */
export function withToolsStale<State extends { rows: readonly object[] }>(state: State, stale: ReadonlyMap<string, ToolsStale>): State {
  if (!stale.size) return state;
  return {
    ...state,
    rows: state.rows.map((row) => {
      const id = (row as { id?: unknown }).id;
      const found = typeof id === "string" ? stale.get(id) : undefined;
      return found ? { ...row, toolsStale: found } : row;
    }),
  };
}

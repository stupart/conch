import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

/**
 * The compute and latency halves of `conch evals` (evals.ts): a test conch, never the live one.
 *
 * A daemon from this checkout in its own temporary home (its own socket, sessions file, state file, log, Claude and
 * Codex folders; the engine's paths set to files that don't exist, speech and phone off), with fixture Claude sessions
 * whose transcripts are sized like real ones and whose processes are `sleep`s. It runs under the census
 * (evals-census.ts), which counts every file and process it touches. The harness lets it settle, measures a window at
 * rest, probes its latencies, then a window under a scripted load: three sessions working (their transcripts growing
 * four times a second, their registry rows busy, hook events arriving), the control socket pinged ten times a second
 * and an agent calling conch_sessions once a second. Everything the harness starts it stops by pid; the temporary home
 * is removed. The recipe is scripts/daemon-watchdog-e2e.ts's.
 *
 * The in-process micro-benchmarks (registry, transcripts, published state, inject pre-flight) run in a child with the
 * same temporary home, so no module ever resolves the real ~/.claude or ~/.config/conch. The live daemon, app and MCP
 * servers are only looked at, with `ps` and one `stat` of the published sessions file: no signal, no socket.
 */

const REPO = resolve(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const CENSUS = join(REPO, "src", "evals-census.ts");
const LIVE_PATHS = ["/tmp/conch.sock", "/tmp/conch-sessions.json", "/tmp/conch-state.json", "/tmp/conch-daemon.log"];
/** Transcript sizes, cycled over the fixture sessions: live transcripts on the Mac this was built on ran 1-900 MB. */
export const FIXTURE_MB = [0.5, 1, 2, 4, 8, 16, 32, 64];

export interface Stats { n: number; p50: number; p90: number; mean: number; max: number }

/** Nearest-rank quantiles, rounded to 0.1. */
export function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]! : 0;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { n: sorted.length, p50: round(at(0.5)), p90: round(at(0.9)), mean: round(sorted.reduce((s, v) => s + v, 0) / Math.max(1, sorted.length)), max: round(sorted.at(-1) ?? 0) };
}

/** `ps`'s cputime ("1:02.50", "1:02:03", "2-01:02:03") in seconds. */
export function parseCpuTime(text: string): number {
  const [days, rest] = text.includes("-") ? [Number(text.split("-")[0]), text.split("-")[1]!] : [0, text];
  const parts = rest.split(":").map(Number);
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return days * 86_400 + seconds;
}

/** `ps`'s etime ("05:06", "02:03:04", "5-23:37:46") in seconds. */
export const parseElapsed = parseCpuTime;

// ---- fixtures ----

interface FixtureSession { sessionId: string; label: string; cwd: string; transcript: string; pid: number; bytes: number }

const fixtureId = (index: number) => `e7a1e7a1-0000-4000-8000-${String(index).padStart(12, "0")}`;
const OUTPUT_LINE = "src/panel.ts:1204 ✓ builds rows for every live session (3 ms)\n";

/** One Claude Code turn, as its transcript writes it: a prompt, a tool call and its result, a reply. */
function turnLines(sessionId: string, cwd: string, turn: number, outputBytes: number): string {
  const at = new Date(Date.UTC(2026, 10, 1) + turn * 30_000).toISOString();
  const base = { sessionId, cwd, timestamp: at, isSidechain: false, userType: "external" };
  const id = (part: string) => `${sessionId.slice(0, 8)}-${turn}-${part}`;
  const output = OUTPUT_LINE.repeat(Math.max(1, Math.ceil(outputBytes / OUTPUT_LINE.length)));
  return [
    { ...base, type: "user", uuid: id("u"), parentUuid: turn ? `${sessionId.slice(0, 8)}-${turn - 1}-r` : null, promptSource: "typed", origin: { kind: "human" }, message: { role: "user", content: `Fixture request ${turn}: run the tests and say what changed.` } },
    { ...base, type: "assistant", uuid: id("a"), parentUuid: id("u"), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Running the tests first." }, { type: "tool_use", id: `toolu_${id("t")}`, name: "Bash", input: { command: "bun test test/panel.test.ts", description: "Run the panel tests" } }] } },
    { ...base, type: "user", uuid: id("o"), parentUuid: id("a"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id("t")}`, content: output }] } },
    { ...base, type: "assistant", uuid: id("r"), parentUuid: id("o"), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: `Turn ${turn}: the panel tests pass. Two files changed: src/panel.ts builds rows once per publish, and its test covers a session with no transcript. Nothing else moved.` }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function writeTranscript(path: string, sessionId: string, cwd: string, megabytes: number): { bytes: number; turns: number } {
  const target = Math.round(megabytes * 1024 * 1024);
  const chunks: string[] = [];
  let bytes = 0;
  let turn = 0;
  while (bytes < target) {
    const lines = turnLines(sessionId, cwd, turn++, 1_500 + ((turn * 7919) % 9_000));
    chunks.push(lines);
    bytes += Buffer.byteLength(lines);
  }
  writeFileSync(path, chunks.join(""));
  return { bytes, turns: turn };
}

interface Fixture {
  root: string;
  env: Record<string, string>;
  claudeDir: string;
  sessionsFile: string;
  socket: string;
  census: string;
  sessions: FixtureSession[];
  sleepers: Array<ReturnType<typeof Bun.spawn>>;
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

function registryWrite(claudeDir: string, session: FixtureSession, status: string): void {
  const file = join(claudeDir, "sessions", `${session.pid}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify({
    pid: session.pid, sessionId: session.sessionId, cwd: session.cwd, name: session.label,
    startedAt: Date.UTC(2026, 10, 1), kind: "interactive", entrypoint: "cli", status,
  }));
  renameSync(`${file}.tmp`, file);
}

export function buildFixture(count: number): Fixture {
  // A short /tmp path: a unix socket's must fit sockaddr_un.
  const root = mkdtempSync("/tmp/conch-ev-");
  const home = join(root, "home");
  const claudeDir = join(root, "claude");
  const none = join(root, "none");
  for (const dir of [home, join(claudeDir, "sessions"), join(claudeDir, "projects"), none, join(root, "codex"), join(root, "config")]) mkdirSync(dir, { recursive: true });
  const socket = join(root, "conch.sock");
  const sessionsFile = join(root, "sessions.json");
  const census = join(root, "census");
  const log = join(root, "daemon.log");
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    CONCH_HOME: home,
    TMPDIR: `${root}/`,
    CONCH_USER_TEMP_DIR: root,
    CONCH_STARTED_BY: "app",
    CONCH_SOCKET: socket,
    CONCH_CONFIG_DIR: join(root, "config"),
    CLAUDE_CONFIG_DIR: claudeDir,
    CODEX_HOME: join(root, "codex"),
    CONCH_LOG_FILE: log,
    CONCH_STATE_FILE: join(root, "state.json"),
    CONCH_SESSIONS_FILE: sessionsFile,
    CONCH_REVIEWS_FILE: join(root, "reviews.json"),
    CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
    CONCH_MCP_USAGE_FILE: join(root, "mcp-usage.jsonl"),
    CONCH_INJECT_DEBUG_LOG: join(root, "inject-debug.log"),
    CONCH_TMUX_SOCKET: `conch-evals-${process.pid}`,
    // And the default server too (background-recovery.ts lists both): its socket folder is the fixture's.
    TMUX_TMPDIR: root,
    CONCH_WHISPER_PORT: String(freePort()),
    CONCH_APP_BUNDLE: join(root, "no-app"),
    CONCH_SEASHELL_ROOT: join(root, "no-seashell"),
    // Paths that do not exist: an explicit model that is missing is never downloaded.
    CONCH_WHISPER_CLI: join(none, "whisper-cli"),
    CONCH_WHISPER_SERVER: join(none, "whisper-server"),
    CONCH_WHISPER_MODEL: join(none, "model.bin"),
    CONCH_VAD_MODEL: join(none, "vad.bin"),
    CONCH_SOX: join(none, "sox"),
    CONCH_TTS: "say",
    CONCH_SPEAK: "0",
    CONCH_BELL: "0",
    CONCH_MIC_CUES: "0",
    CONCH_PHONE: "0",
    CONCH_ANNOUNCE_SUMMARY: "0",
    CONCH_EVALS_CENSUS: census,
    CONCH_EVALS_SRC: join(REPO, "src"),
    CONCH_EVALS_CENSUS_PATHS: JSON.stringify([
      [join(claudeDir, "sessions"), "registry"],
      [join(claudeDir, "projects"), "transcripts"],
      [claudeDir, "claude"],
      [join(root, "codex"), "codex"],
      // The file and the temporary it is renamed from (`publishSessionsFile`: `.<name>.<pid>….tmp` beside it).
      [sessionsFile, "sessions-file"],
      [join(root, ".sessions.json."), "sessions-file"],
      [join(root, "state.json"), "state-file"],
      [join(root, ".state.json."), "state-file"],
      [log, "log"],
      [join(root, "config"), "config"],
      [home, "home"],
      [root, "temp"],
    ]),
  };
  for (const path of [socket, sessionsFile, env.CONCH_STATE_FILE!, log]) {
    if (LIVE_PATHS.includes(path)) throw new Error(`refusing a live path: ${path}`);
  }
  const sessions: FixtureSession[] = [];
  const sleepers: Fixture["sleepers"] = [];
  for (let index = 0; index < count; index++) {
    const sessionId = fixtureId(index);
    const cwd = join(root, "work", `project-${index}`);
    mkdirSync(cwd, { recursive: true });
    const project = join(claudeDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${sessionId}.jsonl`);
    const { bytes } = writeTranscript(transcript, sessionId, cwd, FIXTURE_MB[index % FIXTURE_MB.length]!);
    // The session's own process: something alive at the registry's pid, as a real agent is, with no terminal.
    const sleeper = Bun.spawn(["/bin/sleep", "3600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    sleepers.push(sleeper);
    const session = { sessionId, label: `fixture ${index}`, cwd, transcript, pid: sleeper.pid, bytes };
    sessions.push(session);
    registryWrite(claudeDir, session, "idle");
  }
  return { root, env, claudeDir, sessionsFile, socket, census, sessions, sleepers };
}

// ---- the census, read ----

interface CensusFile { at: number; cpuMicros: number; rss: number; calls: Record<string, number>; sites?: Record<string, number>; written: Record<string, number>; spawned: Record<string, number> }
interface CensusSnapshot { at: number; cpuMicros: number; rss: number; threads: number; calls: Map<string, number>; sites: Map<string, number>; written: Map<string, number>; spawned: Map<string, number> }

function readCensus(base: string): CensusSnapshot | null {
  const dir = join(base, "..");
  const prefix = `${base.slice(dir.length + 1)}.`;
  let main: CensusFile | null = null;
  const files: CensusFile[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as CensusFile;
      files.push(value);
      if (name === `${prefix}main.json`) main = value;
    } catch {}
  }
  if (!main) return null;
  const sum = (pick: (file: CensusFile) => Record<string, number>) => {
    const out = new Map<string, number>();
    for (const file of files) for (const [key, value] of Object.entries(pick(file))) out.set(key, (out.get(key) ?? 0) + value);
    return out;
  };
  return { at: main.at, cpuMicros: main.cpuMicros, rss: main.rss, threads: files.length, calls: sum((f) => f.calls), sites: sum((f) => f.sites ?? {}), written: sum((f) => f.written), spawned: sum((f) => f.spawned) };
}

async function freshCensus(base: string, after: number, timeoutMs = 3_000): Promise<CensusSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = readCensus(base);
    if (snapshot && snapshot.at > after) return snapshot;
    await Bun.sleep(100);
  }
  return readCensus(base);
}

export interface WindowCost {
  seconds: number;
  /** The daemon's CPU over the window, every thread, as a share of one core. */
  cpuPercent: number;
  rssMB: number;
  /**
   * Per minute: file calls by `<call> <what it touched>` and by the conch function that made them, processes started
   * (and from where), KB written by where.
   */
  perMinute: {
    fsCalls: number; fs: Record<string, number>; fsBySite: Record<string, number>; spawns: number; spawned: Record<string, number>;
    writtenKB: Record<string, number>;
    /** Rewrites of the published sessions file, the one the Mac app and every conch_sessions read. */
    publishedWrites: number;
  };
}

function windowCost(before: CensusSnapshot, after: CensusSnapshot): WindowCost {
  const seconds = Math.max(0.001, (after.at - before.at) / 1000);
  const perMinute = (a: Map<string, number>, b: Map<string, number>, scale = 1) => {
    const out: Record<string, number> = {};
    for (const [key, value] of b) {
      const delta = value - (a.get(key) ?? 0);
      if (delta > 0) out[key] = Math.round((delta / seconds) * 60 * scale * 10) / 10;
    }
    return Object.fromEntries(Object.entries(out).sort(([, x], [, y]) => y - x));
  };
  const fs = perMinute(before.calls, after.calls);
  const top = (record: Record<string, number>, count: number) => Object.fromEntries(Object.entries(record).slice(0, count));
  const spawned = perMinute(before.spawned, after.spawned);
  // One rename per publish (`publishSessionsFile` writes a temporary beside it and renames it over).
  const publishedWrites = (fs["renameSync sessions-file"] ?? 0) + (fs["Bun.write sessions-file"] ?? 0);
  return {
    seconds: Math.round(seconds * 10) / 10,
    cpuPercent: Math.round(((after.cpuMicros - before.cpuMicros) / 1e6 / seconds) * 1000) / 10,
    rssMB: Math.round(after.rss / 1024 / 1024),
    perMinute: {
      fsCalls: Math.round(Object.values(fs).reduce((s, v) => s + v, 0)),
      fs: top(fs, 14),
      fsBySite: top(perMinute(before.sites, after.sites), 14),
      spawns: Math.round(Object.values(spawned).reduce((s, v) => s + v, 0) * 10) / 10,
      spawned: top(spawned, 12),
      writtenKB: perMinute(before.written, after.written, 1 / 1024),
      publishedWrites: Math.round(publishedWrites * 10) / 10,
    },
  };
}

// ---- talking to the test daemon ----

/** One control-socket request and its one-line reply, timed from connect to the reply's newline. */
export function controlRoundTrip(socket: string, message: unknown, timeoutMs = 2_000): Promise<{ ms: number; reply: string | null }> {
  return new Promise((done) => {
    const started = performance.now();
    const sock = connect({ path: socket, allowHalfOpen: true });
    let data = "";
    const finish = (reply: string | null) => {
      clearTimeout(timer);
      sock.destroy();
      done({ ms: performance.now() - started, reply });
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("connect", () => sock.write(`${JSON.stringify(message)}\n`));
    sock.on("data", (chunk) => {
      data += chunk.toString();
      const end = data.indexOf("\n");
      if (end >= 0) finish(data.slice(0, end));
    });
    sock.on("end", () => finish(data || null));
    sock.on("error", () => finish(null));
  });
}

/** A hook's hand-off as hook.ts sends it: one JSON line, nothing read back. */
function sendEvent(socket: string, event: Record<string, unknown>): Promise<void> {
  return new Promise((done) => {
    const sock = connect(socket);
    const timer = setTimeout(() => { sock.destroy(); done(); }, 500);
    sock.on("connect", () => { sock.end(`${JSON.stringify(event)}\n`); clearTimeout(timer); done(); });
    sock.on("error", () => { clearTimeout(timer); done(); });
  });
}

/** A JSON-RPC client over a `conch mcp` server's stdio, as an agent is. */
class McpStdio {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly waiting = new Map<number, (line: { ms: number; message: Record<string, unknown>; bytes: number }) => void>();
  private nextId = 1;
  readonly startedAt = performance.now();

  constructor(argv: string[], env: Record<string, string>) {
    this.proc = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    void this.read();
  }

  get pid(): number { return this.proc.pid; }

  private async read(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          const resolveIt = typeof message.id === "number" ? this.waiting.get(message.id) : undefined;
          if (resolveIt) {
            this.waiting.delete(message.id as number);
            resolveIt({ ms: 0, message, bytes: Buffer.byteLength(line) });
          }
        } catch {}
      }
    }
  }

  async request(method: string, params?: unknown, timeoutMs = 20_000): Promise<{ ms: number; message: Record<string, unknown> | null; bytes: number }> {
    const id = this.nextId++;
    const started = performance.now();
    const answer = new Promise<{ ms: number; message: Record<string, unknown>; bytes: number }>((done) => this.waiting.set(id, done));
    const stdin = this.proc.stdin as unknown as { write(text: string): void; flush?(): void };
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    stdin.flush?.();
    const timeout = Bun.sleep(timeoutMs).then(() => null);
    const result = await Promise.race([answer, timeout]);
    if (!result) {
      this.waiting.delete(id);
      return { ms: performance.now() - started, message: null, bytes: 0 };
    }
    return { ms: performance.now() - started, message: result.message, bytes: result.bytes };
  }

  notify(method: string): void {
    const stdin = this.proc.stdin as unknown as { write(text: string): void; flush?(): void };
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    stdin.flush?.();
  }

  async close(): Promise<void> {
    try { (this.proc.stdin as unknown as { end(): void }).end(); } catch {}
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(2_000).then(() => false)]);
    if (!exited) try { this.proc.kill("SIGKILL"); } catch {}
  }
}

/**
 * The MCP server started as a session starts it, from a stand-in parent: conch knows the calling session by the
 * server's parent process, and the stand-in, registered as a fixture session, has no terminal for anything to read.
 */
function mcpThroughStandIn(env: Record<string, string>): McpStdio {
  const script = "const p = Bun.spawn(JSON.parse(process.env.CONCH_EVALS_ARGV), { stdin: 'inherit', stdout: 'inherit', stderr: 'ignore' }); process.exit(await p.exited);";
  return new McpStdio([process.execPath, "-e", script], { ...env, CONCH_EVALS_ARGV: JSON.stringify([process.execPath, CLI, "mcp"]) });
}

function childPid(parent: number): number | undefined {
  const result = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(parent)], { stdout: "pipe", stderr: "ignore" });
  const pid = Number(result.stdout.toString().trim().split("\n")[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function rssMB(pid: number): number | undefined {
  const result = Bun.spawnSync(["/bin/ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  const kb = Number(result.stdout.toString().trim());
  return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : undefined;
}

async function timedProcess(argv: string[], env: Record<string, string>, stdin?: string): Promise<{ ms: number; code: number }> {
  const started = performance.now();
  const proc = Bun.spawn(argv, { env, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "ignore", stderr: "ignore" });
  if (stdin !== undefined) {
    const sink = proc.stdin as unknown as { write(text: string): void; end(): void };
    sink.write(stdin);
    sink.end();
  }
  const code = await proc.exited;
  return { ms: performance.now() - started, code };
}

// ---- the run ----

export interface HarnessOptions {
  compute: boolean;
  latency: boolean;
  seconds: number;
  sessions: number;
  live: boolean;
  progress(line: string): void;
}

export async function runHarness(options: HarnessOptions): Promise<{ compute?: Record<string, unknown>; latency?: Record<string, unknown> }> {
  const { progress } = options;
  progress(`building ${options.sessions} fixture sessions in a temporary home`);
  const fixture = buildFixture(options.sessions);
  const compute: Record<string, unknown> = {};
  const latency: Record<string, unknown> = {};
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let standIn: { pid: number; session: FixtureSession } | undefined;
  try {
    const fixtureMB = Math.round(fixture.sessions.reduce((s, x) => s + x.bytes, 0) / 1024 / 1024);
    progress(`starting a test daemon (fixtures ${fixtureMB} MB; socket ${fixture.socket})`);
    const launched = performance.now();
    daemon = Bun.spawn([process.execPath, "--preload", CENSUS, CLI, "daemon"], { env: fixture.env, cwd: fixture.root, stdin: "ignore", stdout: "ignore", stderr: "ignore" });

    // Up: answering pings, and every fixture session published.
    let firstPong: number | undefined;
    let published: number | undefined;
    const upBy = Date.now() + 60_000;
    while (Date.now() < upBy && (firstPong === undefined || published === undefined)) {
      if (firstPong === undefined && (await controlRoundTrip(fixture.socket, { kind: "ping" }, 500)).reply?.includes("pong")) firstPong = performance.now() - launched;
      if (published === undefined) {
        try {
          const rows = (JSON.parse(readFileSync(fixture.sessionsFile, "utf8")) as { rows?: unknown[] }).rows ?? [];
          if (rows.length >= fixture.sessions.length) published = performance.now() - launched;
        } catch {}
      }
      await Bun.sleep(100);
    }
    if (firstPong === undefined) throw new Error("the test daemon never answered a ping");

    // Settled: three one-second samples under 5% of a core in a row, or 45 s.
    const settleStart = Date.now();
    let quiet = 0;
    let previous = await freshCensus(fixture.census, 0);
    const startupCpu = previous?.cpuMicros ?? 0;
    while (Date.now() - settleStart < 45_000 && quiet < 3) {
      await Bun.sleep(1_000);
      const now = readCensus(fixture.census);
      if (now && previous && now.at > previous.at) {
        quiet = (now.cpuMicros - previous.cpuMicros) / ((now.at - previous.at) * 1000) < 0.05 ? quiet + 1 : 0;
        previous = now;
      }
    }
    const settled = readCensus(fixture.census);
    const startup = {
      firstPongMs: Math.round(firstPong),
      ...(published !== undefined ? { allSessionsPublishedMs: Math.round(published) } : {}),
      settleSeconds: Math.round((Date.now() - settleStart) / 100) / 10,
      settled: quiet >= 3,
      cpuSecondsToSettle: settled ? Math.round(settled.cpuMicros / 1e5) / 10 : undefined,
      cpuSecondsBeforeFirstCensus: Math.round(startupCpu / 1e5) / 10,
    };

    // At rest.
    let rest: WindowCost | undefined;
    if (options.compute) {
      progress(`daemon at rest for ${options.seconds} s`);
      const before = await freshCensus(fixture.census, Date.now());
      await Bun.sleep(options.seconds * 1000);
      const after = await freshCensus(fixture.census, Date.now());
      if (before && after) rest = windowCost(before, after);
    }

    // Latency, against the daemon at rest.
    const tools: Record<string, unknown> = {};
    if (options.latency) {
      progress("latency: control socket, hooks, MCP server");
      const pings: number[] = [];
      for (let i = 0; i < 200; i++) pings.push((await controlRoundTrip(fixture.socket, { kind: "ping" })).ms);
      latency.controlPing = stats(pings);
      const configs: number[] = [];
      for (let i = 0; i < 20; i++) configs.push((await controlRoundTrip(fixture.socket, { kind: "get-config" })).ms);
      latency.controlGetConfig = stats(configs);

      const target = fixture.sessions.find((s) => s.bytes >= 8 * 1024 * 1024) ?? fixture.sessions.at(-1)!;
      const hookEnv = { ...fixture.env };
      delete hookEnv.CONCH_EVALS_CENSUS;
      const runs = async (payload: Record<string, unknown>, count: number) => {
        const times: number[] = [];
        for (let i = 0; i < count; i++) times.push((await timedProcess([process.execPath, CLI, "hook"], hookEnv, JSON.stringify(payload))).ms);
        return stats(times);
      };
      latency.hook = {
        transcriptMB: Math.round(target.bytes / 1024 / 1024),
        userPromptSubmit: await runs({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId, transcript_path: target.transcript, cwd: target.cwd, prompt: "evals: a prompt" }, 6),
        stop: await runs({ hook_event_name: "Stop", session_id: target.sessionId, transcript_path: target.transcript, cwd: target.cwd }, 6),
      };
      const versions: number[] = [];
      for (let i = 0; i < 5; i++) versions.push((await timedProcess([process.execPath, CLI, "version"], hookEnv)).ms);
      latency.cliVersion = stats(versions);

      // MCP: cold starts, then one server as a session holds it.
      const cold: number[] = [];
      for (let i = 0; i < 4; i++) {
        const server = new McpStdio([process.execPath, CLI, "mcp"], hookEnv);
        const reply = await server.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "evals" }, capabilities: {} });
        if (reply.message) cold.push(performance.now() - server.startedAt);
        await server.close();
      }
      const mcp: Record<string, unknown> = { coldStartToInitializeMs: stats(cold) };
      const server = mcpThroughStandIn(hookEnv);
      const init = await server.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "evals" }, capabilities: {} });
      server.notify("notifications/initialized");
      // Register the stand-in as the calling session.
      const callerTranscriptDir = join(fixture.claudeDir, "projects", "-evals-caller");
      mkdirSync(callerTranscriptDir, { recursive: true });
      const caller: FixtureSession = { sessionId: fixtureId(999), label: "evals caller", cwd: fixture.root, transcript: join(callerTranscriptDir, `${fixtureId(999)}.jsonl`), pid: server.pid, bytes: 0 };
      writeFileSync(caller.transcript, turnLines(caller.sessionId, caller.cwd, 0, 2_000));
      registryWrite(fixture.claudeDir, caller, "busy");
      standIn = { pid: server.pid, session: caller };
      const lists: number[] = [];
      let listBytes = 0;
      for (let i = 0; i < 10; i++) {
        const listed = await server.request("tools/list");
        lists.push(listed.ms);
        listBytes = listed.bytes;
      }
      mcp.toolsList = { ...stats(lists), bytes: listBytes };
      const served = new Set(((init.message?.result as { tools?: unknown })?.tools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? []);
      const listedTools = (((await server.request("tools/list")).message?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((tool) => tool.name);
      for (const name of listedTools) served.add(name);
      const someone = fixture.sessions.at(-1)!;
      const calls: Array<[string, string, Record<string, unknown>]> = [
        ["conch_sessions", "conch_sessions", {}],
        ["conch_sessions detail", "conch_sessions", { session: someone.sessionId, detail: true }],
        ["conch_transcript_tail", "conch_transcript_tail", { session: someone.sessionId }],
        ["conch_config", "conch_config", {}],
        ["conch_deliverables", "conch_deliverables", {}],
        ["conch_history", "conch_history", {}],
        ["conch_on_screen", "conch_on_screen", {}],
      ];
      await Bun.sleep(1_500); // the daemon notices the caller's registry row (it watches the folder)
      for (const [label, name, args] of calls) {
        if (!served.has(name)) continue;
        const times: number[] = [];
        let bytes = 0;
        let ok = true;
        for (let i = 0; i < 6; i++) {
          const reply = await server.request("tools/call", { name, arguments: args });
          times.push(reply.ms);
          const result = reply.message?.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
          bytes = Buffer.byteLength((result?.content ?? []).map((part) => part.text ?? "").join(""));
          ok = !!result && !result.isError;
        }
        tools[label] = { ...stats(times), replyBytes: bytes, ok };
      }
      mcp.toolCalls = tools;
      const serverPid = childPid(server.pid);
      const serverRss = serverPid ? rssMB(serverPid) : undefined;
      if (serverRss !== undefined) {
        mcp.serverRssMB = serverRss;
        compute.mcpServerRssMB = serverRss;
      }
      latency.mcp = mcp;
      await server.close();
      // Its session ended: Claude Code removes the registry row of a session that exits.
      rmSync(join(fixture.claudeDir, "sessions", `${caller.pid}.json`), { force: true });
    }

    // Under load.
    if (options.compute) {
      progress(`daemon under a scripted load for ${options.seconds} s`);
      const working = fixture.sessions.slice(0, Math.min(3, fixture.sessions.length));
      for (const session of working) registryWrite(fixture.claudeDir, session, "busy");
      const server = mcpThroughStandIn({ ...fixture.env, CONCH_EVALS_CENSUS: "" });
      await server.request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "evals" }, capabilities: {} });
      const before = await freshCensus(fixture.census, Date.now());
      const until = Date.now() + options.seconds * 1000;
      const pingTimes: number[] = [];
      const sessionsCalls: number[] = [];
      let turn = 100_000;
      const appending = (async () => {
        while (Date.now() < until) {
          for (const session of working) appendFileSync(session.transcript, turnLines(session.sessionId, session.cwd, turn++, 2_000));
          await Bun.sleep(250);
        }
      })();
      const pinging = (async () => {
        while (Date.now() < until) {
          pingTimes.push((await controlRoundTrip(fixture.socket, { kind: "ping" })).ms);
          await Bun.sleep(100);
        }
      })();
      const hooking = (async () => {
        let index = 0;
        while (Date.now() < until) {
          const session = working[index++ % working.length]!;
          await sendEvent(fixture.socket, { type: "working", sessionId: session.sessionId, label: session.label, cwd: session.cwd, announce: "", transcriptPath: session.transcript, pid: session.pid, eventAt: Date.now() });
          await Bun.sleep(2_000);
        }
      })();
      const agent = (async () => {
        while (Date.now() < until) {
          sessionsCalls.push((await server.request("tools/call", { name: "conch_sessions", arguments: {} })).ms);
          await Bun.sleep(1_000);
        }
      })();
      await Promise.all([appending, pinging, hooking, agent]);
      const after = await freshCensus(fixture.census, Date.now());
      await server.close();
      for (const session of working) registryWrite(fixture.claudeDir, session, "idle");
      const load = before && after ? windowCost(before, after) : undefined;
      if (options.latency) {
        latency.controlPingUnderLoad = stats(pingTimes);
        latency.conchSessionsUnderLoad = stats(sessionsCalls);
      }
      let publishedBytes: number | undefined;
      try { publishedBytes = statSync(fixture.sessionsFile).size; } catch {}
      compute.testDaemon = {
        sessions: fixture.sessions.length,
        fixtureMB,
        startup,
        ...(rest ? { rest } : {}),
        ...(load ? { load: { ...load, script: "3 sessions busy, transcripts +4 turns/s, a hook event every 2 s, 10 pings/s, conch_sessions 1/s" } } : {}),
        ...(publishedBytes !== undefined ? { publishedStateKB: Math.round(publishedBytes / 1024) } : {}),
      };
    } else if (options.latency) latency.daemonStartup = startup;

    // Stop the daemon before the micro-benchmarks, so it doesn't share the cores with them.
    daemon.kill("SIGTERM");
    if (!(await Promise.race([daemon.exited.then(() => true), Bun.sleep(5_000).then(() => false)]))) daemon.kill("SIGKILL");
    daemon = undefined;

    if (options.latency) {
      progress("latency: registry, transcripts, published state, inject pre-flight (in a child with the fixture home)");
      const bench = Bun.spawn([process.execPath, import.meta.path, "bench", fixture.root], {
        env: { ...fixture.env, CONCH_EVALS_CENSUS: "", CONCH_EVALS_FIXTURE: JSON.stringify(fixture.sessions) },
        stdout: "pipe", stderr: "pipe",
      });
      const [text, errors, code] = await Promise.all([new Response(bench.stdout).text(), new Response(bench.stderr).text(), bench.exited]);
      if (code === 0) Object.assign(latency, JSON.parse(text.trim().split("\n").at(-1) ?? "{}"));
      else latency.benchError = errors.trim().split("\n").slice(-3).join(" ");
      progress("latency: whisper on a spoken fixture, if the engine is installed");
      latency.whisper = await whisperFixture(fixture.root);
    }
    if (options.compute && options.live) {
      progress("compute: the live daemon, app and MCP servers, read with ps (5 s)");
      compute.live = await observeLive();
    }
  } finally {
    if (daemon) {
      try { daemon.kill("SIGKILL"); } catch {}
    }
    for (const proc of fixture.sleepers) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    if (standIn) {
      try { process.kill(standIn.pid, "SIGKILL"); } catch {}
    }
    rmSync(fixture.root, { recursive: true, force: true });
  }
  return {
    ...(options.compute ? { compute } : {}),
    ...(options.latency ? { latency } : {}),
  };
}

// ---- whisper, if it is installed ----

const WHISPER_SENTENCE = "Open the conch daemon and check whether the build session is still working, then publish the diff.";

export function wordErrorRate(said: string, heard: string): number {
  const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  const a = words(said);
  const b = words(heard);
  if (!a.length) return b.length ? 1 : 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! : 1 + Math.min(previous[j]!, row[j - 1]!, previous[j - 1]!);
    previous = row;
  }
  return Math.round((previous[b.length]! / a.length) * 1000) / 1000;
}

async function whisperFixture(root: string): Promise<Record<string, unknown>> {
  const { resolveSpeechEngine } = await import("./speech-engine.ts");
  // The real engine's paths, read only; nothing is downloaded and the live daemon's whisper-server is never asked.
  const engine = resolveSpeechEngine();
  if (!engine.whisperCli.found || !engine.whisperModel.found) return { skipped: `engine not installed (whisper-cli ${engine.whisperCli.found ? "found" : "missing"}, model ${engine.whisperModel.found ? "found" : "missing"})` };
  const wav = join(root, "fixture.wav");
  const say = Bun.spawnSync(["/usr/bin/say", "-o", wav, "--data-format=LEI16@16000", WHISPER_SENTENCE], { stdout: "ignore", stderr: "ignore" });
  if (say.exitCode !== 0 || !existsSync(wav)) return { skipped: "`say` could not write the fixture" };
  const audioSeconds = Math.round(((statSync(wav).size - 44) / 32_000) * 10) / 10;
  // transcribe.ts's cold path, flag for flag.
  const argv = [
    engine.whisperCli.path, "-m", engine.whisperModel.path,
    ...(engine.vadModel.found ? ["-vm", engine.vadModel.path, "--vad", "--vad-speech-pad-ms", "300"] : []),
    "-f", wav, "-l", "en", "-t", "6", "-nt", "-np", "-mc", "0",
  ];
  const runs: number[] = [];
  let heard = "";
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return { skipped: `whisper-cli exited ${code}` };
    runs.push(performance.now() - started);
    heard = text.trim();
  }
  const cold = stats(runs);
  return {
    engine: engine.whisperCli.source,
    model: engine.whisperModel.path.split("/").at(-1),
    audioSeconds,
    firstRunMs: Math.round(runs[0]!),
    warmMs: stats(runs.slice(1)),
    realTimeFactor: Math.round((cold.p50 / 1000 / audioSeconds) * 100) / 100,
    wordErrorRate: wordErrorRate(WHISPER_SENTENCE, heard),
  };
}

// ---- the live processes, read only ----

interface PsRow { pid: number; ppid: number; rssKB: number; cpuSeconds: number; elapsedSeconds: number; command: string }

function psRows(): PsRow[] {
  const result = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,rss=,cputime=,etime=,command="], { stdout: "pipe", stderr: "ignore" });
  return result.stdout.toString().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKB: Number(match[3]), cpuSeconds: parseCpuTime(match[4]!), elapsedSeconds: parseElapsed(match[5]!), command: match[6]! }] : [];
  });
}

/** Which of conch's live processes a `ps` command line is, if any. Exported for the tests. */
export function liveRole(command: string): "daemon" | "app" | "mcp" | null {
  if (command.includes("evals-census.ts") || command.includes("/tmp/conch-ev-")) return null;
  if (/conch\.app\/Contents\/MacOS\//.test(command)) return "app";
  if (/(?:\bcli\.ts|conch-daemon|\bconch)\s+daemon\b/.test(command) || /\/conch-daemon(?:\s|$)/.test(command)) return "daemon";
  if (/(?:\bcli\.ts|\bconch)\s+mcp\b|conch-mcp\b/.test(command)) return "mcp";
  return null;
}

export async function observeLive(exclude: readonly number[] = [], windowMs = 5_000): Promise<Record<string, unknown>> {
  const all = psRows();
  const pick = (rows: PsRow[]) => rows.filter((row) => !exclude.includes(row.pid) && row.pid !== process.pid).map((row) => ({ ...row, role: liveRole(row.command) })).filter((row) => row.role);
  const first = pick(all);
  // What the live daemon itself runs (its TTS worker, a whisper-server, sox, tmux): its children, by program.
  const daemons = new Set(first.filter((row) => row.role === "daemon").map((row) => row.pid));
  const children: Record<string, { processes: number; rssMB: number }> = {};
  for (const row of all) {
    if (!daemons.has(row.ppid)) continue;
    const program = /tts-worker/.test(row.command) ? "tts-worker (python)" : row.command.split(" ")[0]!.split("/").at(-1)!;
    const entry = children[program] ?? { processes: 0, rssMB: 0 };
    entry.processes += 1;
    entry.rssMB += Math.round(row.rssKB / 1024);
    children[program] = entry;
  }
  // The published sessions file's size and how often it is rewritten: a stat every 100 ms, never a read.
  const sessionsFile = "/tmp/conch-sessions.json";
  let changes = 0;
  let lastMtime = existsSync(sessionsFile) ? statSync(sessionsFile).mtimeMs : 0;
  const started = Date.now();
  while (Date.now() - started < windowMs) {
    await Bun.sleep(100);
    try {
      const mtime = statSync(sessionsFile).mtimeMs;
      if (mtime !== lastMtime) { changes += 1; lastMtime = mtime; }
    } catch {}
  }
  const seconds = (Date.now() - started) / 1000;
  const second = new Map(pick(psRows()).map((row) => [row.pid, row]));
  const describe = (role: "daemon" | "app" | "mcp") => {
    const rows = first.filter((row) => row.role === role);
    if (!rows.length) return undefined;
    const windowCpu = rows.reduce((sum, row) => sum + Math.max(0, (second.get(row.pid)?.cpuSeconds ?? row.cpuSeconds) - row.cpuSeconds), 0);
    return {
      processes: rows.length,
      rssMB: Math.round(rows.reduce((sum, row) => sum + row.rssKB, 0) / 1024),
      // CPU over its whole life (cputime / elapsed), and over this window; both as a share of one core.
      lifetimeCpuPercent: Math.round((rows.reduce((s, r) => s + r.cpuSeconds, 0) / Math.max(1, rows.reduce((s, r) => s + r.elapsedSeconds, 0))) * 1000) / 10,
      windowCpuPercent: Math.round((windowCpu / seconds) * 1000) / 10,
      uptimeHours: Math.round((Math.max(...rows.map((r) => r.elapsedSeconds)) / 3600) * 10) / 10,
    };
  };
  let publishedKB: number | undefined;
  try { publishedKB = Math.round(statSync(sessionsFile).size / 1024); } catch {}
  return {
    note: "this Mac's running conch, read with ps; uncontrolled: whatever it was doing in this window",
    windowSeconds: Math.round(seconds * 10) / 10,
    ...(describe("daemon") ? { daemon: describe("daemon") } : {}),
    ...(describe("app") ? { app: describe("app") } : {}),
    ...(describe("mcp") ? { mcpServers: describe("mcp") } : {}),
    ...(Object.keys(children).length ? { daemonChildren: children } : {}),
    ...(publishedKB !== undefined ? { publishedState: { kb: publishedKB, rewritesPerMinute: Math.round((changes / seconds) * 60 * 10) / 10 } } : {}),
  };
}

// ---- the micro-benchmarks, in a child whose home is the fixture's ----

async function timeEach(count: number, work: () => unknown): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await work();
    times.push(performance.now() - started);
  }
  return times;
}

async function bench(root: string): Promise<Record<string, unknown>> {
  if (!root.startsWith("/tmp/conch-ev-") || process.env.CONCH_HOME !== join(root, "home")) throw new Error("bench runs only in a fixture home");
  const sessions = JSON.parse(process.env.CONCH_EVALS_FIXTURE ?? "[]") as FixtureSession[];
  const claudeDir = process.env.CLAUDE_CONFIG_DIR!;
  const out: Record<string, unknown> = {};

  const { registrySnapshot } = await import("./sessions.ts");
  out.registrySnapshot = { sessions: sessions.length, ...stats(await timeEach(20, () => registrySnapshot(claudeDir))) };

  const { readConversationTail, keepConversationTails } = await import("./conversation.ts");
  const { transcriptFormatFor } = await import("./agent-adapter.ts");
  const biggest = [...sessions].sort((a, b) => b.bytes - a.bytes)[0]!;
  keepConversationTails([biggest.transcript]);
  const read = () => readConversationTail(biggest.transcript, biggest.sessionId, transcriptFormatFor(biggest.transcript));
  const cold = await timeEach(1, read);
  const warm = await timeEach(10, read);
  const appended: number[] = [];
  for (let i = 0; i < 5; i++) {
    appendFileSync(biggest.transcript, turnLines(biggest.sessionId, biggest.cwd, 200_000 + i, 2_000));
    appended.push(...await timeEach(1, read));
  }
  out.transcriptTail = { transcriptMB: Math.round(biggest.bytes / 1024 / 1024), coldMs: Math.round(cold[0]! * 10) / 10, unchanged: stats(warm), afterAppend: stats(appended) };

  const { transcriptMark } = await import("./snippet.ts");
  out.transcriptMark = { transcriptMB: Math.round(biggest.bytes / 1024 / 1024), note: "the inject's prompt count, with no cursor", ...stats(await timeEach(3, () => transcriptMark(biggest.transcript))) };

  const { deadTarget } = await import("./dead-target.ts");
  out.injectPreflight = { note: "deadTarget on a live pid: the kernel's answer and `ps -o args=`", ...stats(await timeEach(10, () => deadTarget(claudeDir, { pid: sessions[0]!.pid }))) };

  out.ps = stats(await timeEach(10, () => Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" })));

  const { buildPanelModel, buildPublishedState } = await import("./panel.ts");
  const { getLiveState } = await import("./status.ts");
  const snapshot = await registrySnapshot(claudeDir);
  const infos = snapshot?.infos ?? [];
  let bytes = 0;
  const build = () => {
    const model = buildPanelModel({
      sessions: infos, sessionStates: new Map(), pausedSessionIds: new Set(), live: getLiveState(),
      mode: { muted: false, paused: false, holding: 0 }, activeSessionId: null, navSelectedId: null, now: Date.now(),
    });
    const text = JSON.stringify(buildPublishedState("evals", model, new Map(), new Set(), Date.now(), {}));
    bytes = text.length;
  };
  out.publishedStateRows = { sessions: infos.length, note: "rows only: the daemon adds conversations, activity and deliverables", ...stats(await timeEach(20, build)), bytes };

  const sessionsFile = process.env.CONCH_SESSIONS_FILE!;
  if (existsSync(sessionsFile)) {
    const text = readFileSync(sessionsFile, "utf8");
    const copy = join(root, "published-copy.json");
    out.publishedStateFile = {
      kb: Math.round(Buffer.byteLength(text) / 1024),
      parse: stats(await timeEach(20, () => JSON.parse(text))),
      stringify: stats(await timeEach(20, () => JSON.stringify(JSON.parse(text)))),
      writeAndRename: stats(await timeEach(20, () => { writeFileSync(`${copy}.tmp`, text); renameSync(`${copy}.tmp`, copy); })),
    };
  }
  return out;
}

if (import.meta.main && process.argv[2] === "bench") {
  try {
    console.log(JSON.stringify(await bench(process.argv[3] ?? "")));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}

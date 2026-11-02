import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { profile } from "bun:jsc";

/**
 * Where the daemon's own CPU goes, measured on the running daemon (2026-11-02, Tyler: "why is the conch daemon using so
 * much? can we get more detail on exactly what that breakdown is?"). A macOS `sample` only says it waits and names no
 * JavaScript, and Bun's --cpu-prof has to be on from launch, which the app owns. JavaScriptCore's sampling profiler
 * (`bun:jsc` `profile`) can be run from inside for a set time and then stops, so `kill -USR2 <pid>` (or `conch profile`)
 * has the daemon profile itself and write what it found to `profiles/` in conch's config folder.
 *
 * The JS samples are the daemon's own thread: everything else (GC, Bun's I/O threads, the processes it starts) shows as
 * the gap between them and the process's CPU over the same window, which the report gives too.
 */

export interface ProfileFrame {
  name?: string;
  sourceURL?: string;
  line?: number;
  category?: string;
}

export interface ProfileTraces {
  interval?: number;
  traces?: Array<{ frames?: ProfileFrame[] }>;
}

const NO_LINE = 4294967295;

function where(frame: ProfileFrame): string {
  const file = frame.sourceURL ? basename(frame.sourceURL) : frame.category === "Host" ? "(native)" : "(bun)";
  return frame.line && frame.line !== NO_LINE ? `${file}:${frame.line}` : file;
}

function label(frame: ProfileFrame): string {
  return `${frame.name || "(anonymous)"} — ${where(frame)}`;
}

function top(counts: Map<string, number>, total: number, limit: number): string[] {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([key, count]) => `| ${count} | ${((count / Math.max(total, 1)) * 100).toFixed(1)}% | ${key.replaceAll("|", "\\|")} |`);
}

/** The report: JS-thread time by function (self and inclusive) and by file, beside the process's own CPU. */
export function profileReport(
  traces: ProfileTraces,
  window: { ms: number; cpuMicros: number; startedAt: string },
): string {
  const samples = traces.traces ?? [];
  const intervalMs = (traces.interval ?? 0.001) * 1000;
  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  const files = new Map<string, number>();
  for (const trace of samples) {
    const frames = trace.frames ?? [];
    if (!frames.length) continue;
    self.set(label(frames[0]!), (self.get(label(frames[0]!)) ?? 0) + 1);
    // Once per sample however often a function or file recurs in its stack.
    for (const key of new Set(frames.map(label))) inclusive.set(key, (inclusive.get(key) ?? 0) + 1);
    const ownFile = frames.find((frame) => frame.sourceURL?.includes("/src/"));
    const file = ownFile?.sourceURL ? basename(ownFile.sourceURL) : where(frames[0]!);
    files.set(file, (files.get(file) ?? 0) + 1);
  }
  const jsMs = samples.length * intervalMs;
  const cpuMs = window.cpuMicros / 1000;
  const percent = (ms: number) => `${((ms / Math.max(window.ms, 1)) * 100).toFixed(1)}% of one core`;
  return [
    `# conch daemon profile`,
    "",
    `Started ${window.startedAt}, ${(window.ms / 1000).toFixed(0)} s, pid ${process.pid}.`,
    "",
    `- Process CPU, every thread: ${cpuMs.toFixed(0)} ms (${percent(cpuMs)}).`,
    `- JavaScript on the daemon's thread: ${jsMs.toFixed(0)} ms (${percent(jsMs)}), ${samples.length} samples.`,
    `- Everything else (GC, Bun's I/O threads, native work off the JS thread): about ${Math.max(0, cpuMs - jsMs).toFixed(0)} ms.`,
    "",
    "## By conch source file (the innermost conch frame in each sample)",
    "",
    "| samples | share | file |", "|---|---|---|",
    ...top(files, samples.length, 25),
    "",
    "## Self time: the function running when sampled",
    "",
    "| samples | share | function |", "|---|---|---|",
    ...top(self, samples.length, 40),
    "",
    "## Inclusive time: the function anywhere on the stack",
    "",
    "| samples | share | function |", "|---|---|---|",
    ...top(inclusive, samples.length, 60),
    "",
  ].join("\n");
}

/** Profile the daemon's own thread for `ms`, then write the report to `dir`. Its path, once written. */
export async function profileDaemon(dir: string, ms: number): Promise<string> {
  const startedAt = new Date().toISOString();
  const before = process.cpuUsage();
  const began = performance.now();
  const result = await profile(() => Bun.sleep(ms), 1000) as unknown as { stackTraces?: ProfileTraces };
  const elapsed = performance.now() - began;
  const used = process.cpuUsage(before);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `daemon-${startedAt.replace(/[:.]/g, "-")}.md`);
  writeFileSync(path, profileReport(result.stackTraces ?? {}, { ms: elapsed, cpuMicros: used.user + used.system, startedAt }), { mode: 0o600 });
  return path;
}

/** How long a profile runs: `seconds` in the request file `conch profile` leaves, else 30; never more than 5 minutes. */
export function requestedProfileMs(dir: string): number {
  try {
    const seconds = Number(readFileSync(join(dir, "request"), "utf8").trim());
    rmSync(join(dir, "request"), { force: true });
    if (Number.isFinite(seconds) && seconds >= 1) return Math.min(seconds, 300) * 1000;
  } catch {}
  return 30_000;
}

/**
 * SIGUSR2 profiles the daemon (`profileDaemon`); one at a time. The pid goes in `dir` so `conch profile` can find it.
 */
export function installProfileSignal(dir: string, log: (line: string) => void): void {
  let running = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "daemon.pid"), `${process.pid}\n`, { mode: 0o600 });
  } catch {}
  process.on("SIGUSR2", () => {
    if (running) return;
    running = true;
    const ms = requestedProfileMs(dir);
    log(`profiling the daemon for ${ms / 1000} s`);
    void profileDaemon(dir, ms).then(
      (path) => log(`daemon profile written to ${path}`),
      (error) => log(`daemon profile failed: ${(error as Error).message}`),
    ).finally(() => { running = false; });
  });
}

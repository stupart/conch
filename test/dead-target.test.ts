import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadTarget, jobLiveness, lstartSeconds, type TargetProbes } from "../src/dead-target.ts";
import type { ProcessIdentity } from "../src/process-identity.ts";

/**
 * Is the terminal a row names still the session? (`src/dead-target.ts`)
 *
 * The first block runs over real processes this test starts itself — a stand-in
 * `claude attach` and a stand-in pty host — against a Claude home it writes, so the
 * signal is the one a real Mac gives: `ps` for the command line, the kernel for the
 * start time, and Claude Code's roster format for the job. Nobody's session is touched.
 */

const root = mkdtempSync(join(tmpdir(), "conch-dead-target-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let homes = 0;
/** A Claude home with this roster (`undefined`: none written) and these registry files. */
function claudeHome(roster?: unknown, registry: Record<string, string> = {}): string {
  const dir = join(root, `home-${++homes}`);
  mkdirSync(join(dir, "daemon"), { recursive: true });
  if (roster !== undefined) writeFileSync(join(dir, "daemon", "roster.json"), typeof roster === "string" ? roster : JSON.stringify(roster));
  if (Object.keys(registry).length) {
    mkdirSync(join(dir, "sessions"));
    for (const [name, text] of Object.entries(registry)) writeFileSync(join(dir, "sessions", name), text);
  }
  return dir;
}

/** What `LC_ALL=C TZ=UTC ps -o lstart=` says for a pid: the form Claude Code keeps as procStart. */
function lstart(pid: number): string {
  const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return out.stdout.toString().trim();
}

function args(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)]).stdout.toString().trim();
}

async function until(what: string, condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** A process whose command line reads `…/claude attach <jobId>`, as a real attach window's does. */
async function standInAttach(jobId: string) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "claude");
  writeFileSync(script, "#!/bin/sh\nsleep 30\n");
  chmodSync(script, 0o755);
  const proc = Bun.spawn(["/bin/sh", script, "attach", jobId], { stdout: "ignore", stderr: "ignore" });
  await until("the stand-in attach to show its arguments", () => args(proc.pid).endsWith(`claude attach ${jobId}`));
  return proc;
}

async function standInHost() {
  const proc = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  await until("the stand-in host to start", () => lstart(proc.pid) !== "");
  return proc;
}

describe("real processes, a written roster", () => {
  test("an attach window whose job is not in the roster is a stopped session", async () => {
    const attach = await standInAttach("f00dfeed");
    try {
      const home = claudeHome({ proto: 1, supervisorPid: 1, updatedAt: 1, workers: {} });
      expect(await deadTarget(home, { pid: attach.pid })).toEqual({
        reason: "session-stopped",
        jobId: "f00dfeed",
        detail: `pid ${attach.pid} is \`claude attach f00dfeed\`, and job f00dfeed is not in Claude Code's daemon roster`,
      });
    } finally { attach.kill(); }
  });

  test("an attach window on a live job is left alone, and a gone pty host or session inside it is not", async () => {
    const attach = await standInAttach("f00dfeed");
    const host = await standInHost();
    try {
      const worker = {
        pid: host.pid, procStart: lstart(host.pid), sessionId: "f00dfeed-0000-4000-8000-000000000000",
        replPid: process.pid, replProcStart: lstart(process.pid),
      };
      // The start times as Claude Code writes them, compared with the kernel's: the same process.
      expect(await deadTarget(claudeHome({ workers: { f00dfeed: worker } }), { pid: attach.pid })).toBeNull();

      // The pid is someone's, but not the process that started then: the host is gone.
      const reused = claudeHome({ workers: { f00dfeed: { ...worker, procStart: "Mon Jan  5 03:04:05 2026" } } });
      expect(await deadTarget(reused, { pid: attach.pid })).toMatchObject({
        reason: "session-stopped", detail: expect.stringContaining(`pty host (pid ${host.pid}) is gone`),
      });
      const replGone = claudeHome({ workers: { f00dfeed: { ...worker, replProcStart: "Mon Jan  5 03:04:05 2026" } } });
      expect(await deadTarget(replGone, { pid: attach.pid })).toMatchObject({
        reason: "session-stopped", detail: expect.stringContaining(`session process (pid ${process.pid}) is gone`),
      });

      host.kill();
      await host.exited;
      expect(await deadTarget(claudeHome({ workers: { f00dfeed: worker } }), { pid: attach.pid })).toMatchObject({
        reason: "session-stopped", jobId: "f00dfeed", detail: expect.stringContaining(`pty host (pid ${host.pid}) is gone`),
      });
    } finally { attach.kill(); host.kill(); }
  });

  test("a live terminal that is not an attach window is left alone, and its job's roster never read", async () => {
    const read: string[] = [];
    const probes: TargetProbes = { readText: (path) => { read.push(path); return null; } };
    expect(await deadTarget(claudeHome({ workers: {} }), { pid: process.pid }, probes)).toBeNull();
    expect(read).toEqual([]);
  });

  test("a registry entry whose process has exited is an ended session", async () => {
    const gone = await standInHost();
    gone.kill();
    await gone.exited;
    const home = claudeHome({ workers: {} });
    expect(await deadTarget(home, { pid: gone.pid })).toEqual({ reason: "session-ended", detail: `pid ${gone.pid} has exited` });
    // A window of a job that is itself gone: the job's stop is the thing to say.
    expect(await deadTarget(home, { pid: gone.pid, jobId: "f00dfeed" })).toMatchObject({ reason: "session-stopped", jobId: "f00dfeed" });
  });
});

describe("the rules, over probes", () => {
  const live = new Set([100, 200, 300]);
  const probes = (over: TargetProbes = {}): TargetProbes => ({
    alive: (pid) => live.has(pid),
    commandLine: async (pid) => pid === 100 ? "/opt/homebrew/bin/claude attach f31f0d15" : "claude --dangerously-skip-permissions",
    identity: () => null,
    ...over,
  });

  test("the window of a job that is still running only closed: nothing to say beyond what inject says", async () => {
    const home = claudeHome({ workers: { f31f0d15: { pid: 200 } } });
    expect(await deadTarget(home, { pid: 999, jobId: "f31f0d15" }, probes())).toBeNull();
  });

  test("a row's job counts even when the window is not an attach (a registry-parked window)", async () => {
    const home = claudeHome({ workers: {} });
    expect(await deadTarget(home, { pid: 300, jobId: "25d17f50" }, probes())).toMatchObject({
      reason: "session-stopped", jobId: "25d17f50",
      detail: "pid 300 is the window on job 25d17f50, and job 25d17f50 is not in Claude Code's daemon roster",
    });
  });

  test("a pid that came round again for another process is an ended session", async () => {
    const bound: ProcessIdentity = { pid: 300, birth: "1790406876.000001", birthTimeMs: 1790406876000, executable: "/opt/claude", ttyDevice: 1 };
    const other = { ...bound, birth: "1790407000.000002", birthTimeMs: 1790407000000 };
    expect(await deadTarget(claudeHome(), { pid: 300, processIdentity: bound }, probes({ identity: () => other })))
      .toMatchObject({ reason: "session-ended" });
    expect(await deadTarget(claudeHome(), { pid: 300, processIdentity: bound }, probes({ identity: () => bound }))).toBeNull();
    // An identity that cannot be read proves nothing.
    expect(await deadTarget(claudeHome(), { pid: 300, processIdentity: bound }, probes({ identity: () => null }))).toBeNull();
  });

  test("only positive evidence refuses: a torn roster, an unreadable one, a failed ps", async () => {
    expect(await deadTarget(claudeHome("{\"workers\":{\"f31"), { pid: 100 }, probes())).toBeNull();
    expect(await deadTarget(claudeHome(), { pid: 100 }, probes({ readText: () => { throw new Error("EACCES"); } }))).toBeNull();
    expect(await deadTarget(claudeHome({ workers: {} }), { pid: 100 }, probes({ commandLine: async () => null }))).toBeNull();
  });

  test("with no roster at all, the job's own registry entry decides; key files are never opened", async () => {
    const bg = (pid: number) => JSON.stringify({ pid, sessionId: "f31f0d15-df08-4ddf-80f6-c8c6ee8a59c6", kind: "bg", jobId: "f31f0d15" });
    const read: string[] = [];
    const reading = (over: TargetProbes = {}) => probes({
      readText: (path) => { read.push(path); try { return readFileSync(path, "utf8"); } catch { return null; } },
      ...over,
    });
    const other = JSON.stringify({ pid: 200, sessionId: "abc", kind: "interactive" });
    // The key file listed first, so only the filter keeps it shut.
    const withKey = reading({ listDir: () => ["200.key", "300.json", "200.json"] });
    expect(await deadTarget(claudeHome(undefined, { "200.json": bg(200), "200.key": "never read", "300.json": other }), { pid: 100 }, withKey))
      .toBeNull();
    expect(read.some((path) => path.endsWith(".key"))).toBe(false);
    expect(read.some((path) => path.endsWith("200.json"))).toBe(true);
    expect(await deadTarget(claudeHome(undefined, { "300.json": other }), { pid: 100 }, reading())).toMatchObject({
      reason: "session-stopped", detail: expect.stringContaining("has no entry in Claude Code's session registry"),
    });
    expect(await deadTarget(claudeHome(undefined, { "999.json": bg(999) }), { pid: 100 }, reading())).toMatchObject({
      reason: "session-stopped", detail: expect.stringContaining("names pid 999, which is gone"),
    });
    // A torn file could be the job's own.
    expect(await deadTarget(claudeHome(undefined, { "300.json": other, "301.json": "{\"pid\":30" }), { pid: 100 }, reading())).toBeNull();
    // No roster and no registry: nothing to go on.
    expect(jobLiveness(join(root, "nowhere"), "f31f0d15", probes())).toEqual({ state: "unknown" });
  });

  test("a job is found by its short id or its session id's prefix", () => {
    const home = claudeHome({ workers: { f31f0d15: { pid: 200, sessionId: "f31f0d15-df08-4ddf-80f6-c8c6ee8a59c6" } } });
    expect(jobLiveness(home, "f31f0d15", probes())).toEqual({ state: "live" });
    expect(jobLiveness(home, "f31f0d15-df08-4ddf-80f6-c8c6ee8a59c6", probes())).toEqual({ state: "live" });
    expect(jobLiveness(home, "25d17f50", probes())).toMatchObject({ state: "gone" });
  });

  test("Claude Code's start times read as UTC epoch seconds", () => {
    expect(lstartSeconds("Wed Sep 23 04:39:09 2026")).toBe(Date.UTC(2026, 8, 23, 4, 39, 9) / 1000);
    expect(lstartSeconds("Sat Sep  5 07:14:36 2026")).toBe(Date.UTC(2026, 8, 5, 7, 14, 36) / 1000);
    expect(lstartSeconds("23/09/2026 04:39:09")).toBeNull();
  });
});

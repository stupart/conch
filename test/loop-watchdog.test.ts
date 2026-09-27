import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREADCRUMB_MAX_BYTES, breadcrumb, loopWatchdogEnabled } from "../src/loop-watchdog.ts";

/**
 * The daemon's event loop, watched from a worker thread (src/loop-watchdog.ts). A watchdog is only tested by a loop
 * that really stops, so each case runs in its own process with short thresholds: a deliberate busy loop stands in for
 * the 2026-09-28 freeze, and the log it writes is read back.
 */

const WATCHDOG = join(import.meta.dir, "..", "src", "loop-watchdog.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "conch-loop-watchdog-"));
  roots.push(root);
  return { root, log: join(root, "daemon.log") };
}

/** Run `body` with the watchdog started on `log`, in a child with a hard deadline and a CPU limit of its own. */
async function child(log: string, body: string, options: { timeoutMs?: number; thresholds?: string } = {}) {
  const thresholds = options.thresholds ?? "heartbeatMs: 100, checkMs: 100, stallMs: 1000, repeatMs: 1000";
  const script = `
    const { startLoopWatchdog, breadcrumb } = await import(${JSON.stringify(WATCHDOG)});
    const watchdog = startLoopWatchdog({ logPath: ${JSON.stringify(log)}, ${thresholds} });
    const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    ${body}
  `;
  const started = performance.now();
  const proc = Bun.spawn(["/bin/sh", "-c", 'ulimit -t 30; exec "$0" --eval "$1"', process.execPath, script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, options.timeoutMs ?? 15_000);
  const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { out, err, exitCode, timedOut, ms: performance.now() - started, pid: proc.pid };
}

const lines = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

describe("the event-loop watchdog", () => {
  test("a held loop is logged with its breadcrumb, again while it lasts, and once more when it comes back", async () => {
    const { log } = scratch();
    const run = await child(log, `
      setTimeout(() => {
        breadcrumb("panel: live sub-agents of \\"conch\\"");
        busy(3_600);
        breadcrumb("after the stall");
        setTimeout(() => { watchdog.stop(); console.log("done"); }, 600);
      }, 300);
    `);
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.out.trim()).toBe("done");
    const logged = lines(log);
    // The daemon log's own format: `[conch M/D HH:MM:SS] …`.
    for (const line of logged) expect(line).toMatch(/^\[conch \d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}\] event loop /);
    const crumb = `last breadcrumb: "panel: live sub-agents of \\"conch\\"" (set in the last 0.1s before it stopped)`;
    const blocked = logged.filter((line) => line.includes("event loop blocked: no heartbeat for"));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toContain(crumb);
    const seconds = Number(/no heartbeat for (\d+\.\d)s/.exec(blocked[0]!)![1]);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThan(2.5);
    // Every `repeatMs` while it lasts: 3.6 s held against a 1 s stall and a 1 s repeat.
    const still = logged.filter((line) => line.includes("event loop still blocked"));
    expect(still.length).toBeGreaterThanOrEqual(1);
    for (const line of still) expect(line).toContain(crumb);
    const recovered = logged.filter((line) => line.includes("event loop recovered after"));
    expect(recovered).toHaveLength(1);
    // The breadcrumb it was stuck in, not the one written after it came back.
    expect(recovered[0]).toContain(crumb);
    expect(recovered[0]).not.toContain("after the stall");
    const heldFor = Number(/recovered after ~(\d+\.\d)s/.exec(recovered[0]!)![1]);
    expect(heldFor).toBeGreaterThanOrEqual(3);
    expect(heldFor).toBeLessThan(5.5);
    // In order: blocked, still…, recovered.
    expect(logged.indexOf(blocked[0]!)).toBeLessThan(logged.indexOf(recovered[0]!));
  }, 30_000);

  test("a loop that keeps turning writes nothing", async () => {
    const { log } = scratch();
    const run = await child(log, `
      breadcrumb("idle");
      // Short bursts well under the stall threshold, for 2.5 s.
      const tick = setInterval(() => busy(150), 200);
      setTimeout(() => { clearInterval(tick); watchdog.stop(); console.log("done"); }, 2_500);
    `);
    expect(run.exitCode).toBe(0);
    expect(run.out.trim()).toBe("done");
    expect(lines(log)).toEqual([]);
  }, 30_000);

  test("it never keeps the process alive: a process with nothing else to do exits at once", async () => {
    const { log } = scratch();
    // Production thresholds: a one-second heartbeat and a worker waking every second, neither holding the process.
    const run = await child(log, `console.log("returned");`, { thresholds: "" });
    expect(run.timedOut).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.out.trim()).toBe("returned");
    expect(run.ms).toBeLessThan(3_000);
  }, 30_000);

  test("time spent stopped is not a stalled loop: SIGSTOP in the middle of a short hold writes nothing", async () => {
    // The Mac sleeping, or `kill -STOP`, stops both threads. The loop here is held 0.3 s before the stop and about
    // 0.9 s after it, never the 2 s stall threshold; counting the 2.5 s it was stopped would call that a stall. The
    // hold runs past the stop on purpose: the worker then wakes first, before any heartbeat could reset its clock.
    const { root, log } = scratch();
    const ready = join(root, "ready");
    const proc = Bun.spawn(["/bin/sh", "-c", 'ulimit -t 30; exec "$0" --eval "$1"', process.execPath, `
      const { startLoopWatchdog } = await import(${JSON.stringify(WATCHDOG)});
      startLoopWatchdog({ logPath: ${JSON.stringify(log)}, heartbeatMs: 100, checkMs: 100, stallMs: 2000, repeatMs: 1000 });
      setTimeout(() => {
        require("node:fs").writeFileSync(${JSON.stringify(ready)}, "");
        const end = Date.now() + 3_700;
        while (Date.now() < end) {}
        setTimeout(() => process.exit(0), 1_500);
      }, 300);
    `], { stdout: "ignore", stderr: "pipe" });
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(ready)).toBe(true);
      await Bun.sleep(300);
      process.kill(proc.pid, "SIGSTOP");
      await Bun.sleep(2_500);
      process.kill(proc.pid, "SIGCONT");
      expect(await proc.exited).toBe(0);
    } finally {
      try { process.kill(proc.pid, "SIGKILL"); } catch {}
    }
    expect(lines(log)).toEqual([]);
  }, 30_000);

  test("a long breadcrumb is cut to its bytes at a character boundary", async () => {
    const { log } = scratch();
    const long = "é".repeat(BREADCRUMB_MAX_BYTES); // two bytes each: twice what fits
    const run = await child(log, `
      setTimeout(() => {
        breadcrumb(${JSON.stringify(long)});
        busy(1_600);
        setTimeout(() => { watchdog.stop(); console.log("done"); }, 400);
      }, 300);
    `);
    expect(run.exitCode).toBe(0);
    const blocked = lines(log).find((line) => line.includes("event loop blocked"));
    expect(blocked).toBeDefined();
    const text = JSON.parse(/last breadcrumb: ("(?:[^"\\]|\\.)*")/.exec(blocked!)![1]!) as string;
    expect(text).toBe("é".repeat(BREADCRUMB_MAX_BYTES / 2));
  }, 30_000);

  test("without a watchdog a breadcrumb costs nothing and throws nothing", () => {
    expect(() => breadcrumb("no watchdog in this process")).not.toThrow();
  });

  test("CONCH_LOOP_WATCHDOG=0 turns it off; anything else leaves it on", () => {
    expect(loopWatchdogEnabled({})).toBe(true);
    expect(loopWatchdogEnabled({ CONCH_LOOP_WATCHDOG: "1" })).toBe(true);
    expect(loopWatchdogEnabled({ CONCH_LOOP_WATCHDOG: " 0 " })).toBe(false);
    expect(loopWatchdogEnabled({ CONCH_LOOP_WATCHDOG: "0" })).toBe(false);
  });
});

/** The wiring nothing else runs: the daemon starts it and names the places it can stop. Pinned as text. */
describe("the daemon's breadcrumbs", () => {
  const source = (path: string) => readFileSync(join(import.meta.dir, "..", "src", path), "utf8");

  test("the daemon starts the watchdog on its own log before anything else can hold the loop", () => {
    const daemon = source("daemon.ts");
    const start = daemon.indexOf("async function runOwnedDaemon(");
    const body = daemon.slice(start, start + 600);
    expect(body).toContain("if (loopWatchdogEnabled()) startLoopWatchdog({ logPath: LOG_FILE });");
    expect(body.indexOf("prepareLogFile();")).toBeLessThan(body.indexOf("startLoopWatchdog"));
  });

  test("the sub-agent scan that froze the daemon, every timer, and the published-state build are named", () => {
    const daemon = source("daemon.ts");
    const loop = daemon.indexOf("for (const session of live) {");
    expect(daemon.slice(loop, loop + 400)).toContain("breadcrumb(`panel: live sub-agents of");
    for (const crumb of [
      'breadcrumb("timer: panel refresh (20 s)")',
      'breadcrumb("timer: codex turn watch")',
      'breadcrumb("timer: wake watch")',
      'breadcrumb("timer: audio holder expiry")',
      'breadcrumb("timer: phone speech latch")',
      'breadcrumb("panel: reading the session registry")',
      'breadcrumb("published state: building")',
      'breadcrumb("published state: writing the sessions file")',
      'breadcrumb("phone setup: publishing")',
      'breadcrumb("daemon: shutting down")',
    ]) expect(daemon).toContain(crumb);
    expect(source("server-supervisor.ts")).toContain("breadcrumb(`${this.service}: idle unload`)");
    expect(source("server-supervisor.ts")).toContain("breadcrumb(`${this.service}: retired child exited`)");
    expect(source("phone-setup.ts")).toContain('breadcrumb("phone setup: asking scutil for the computer name")');
    expect(source("phone-bridge.ts")).toContain("breadcrumb(`phone: ${req.method}");
    expect(source("phone-relay.ts")).toContain('breadcrumb("relay: dispatching a phone request")');
    expect(source("records-runtime.ts")).toContain('breadcrumb("records: handing the indexer its priorities")');
    expect(source("control-server.ts")).toContain("breadcrumb(`control: ");
  });
});

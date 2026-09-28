import { describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedLockProbe, LOCK_PROBE_TTL_MS, readCodexOpenThreadIds } from "../src/codex-threads.ts";

/**
 * The daemon ran `lsof` over Codex's writer locks on every render — 0.31 s of
 * kernel time a run on a 1,578-process Mac, back to back while a transcript
 * streamed (162 a minute, about 97% of a core), and the panel never rendered
 * because every read outlasted the 250 ms throttle. These pin the rules that
 * make one answer serve many callers without hiding a thread that opens.
 */

/** A probe that counts its runs and answers what it is told to. */
function countingProbe(answer: string | null = "p100\nn/locks/a.lock\n") {
  const probe = Object.assign(
    (_paths: string[]) => {
      probe.runs += 1;
      return probe.answer;
    },
    { runs: 0, answer: answer as string | null },
  );
  return probe;
}

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

const A = "/locks/a.lock";
const B = "/locks/b.lock";
const sameFiles = { identity: () => "1", alive: () => true };

describe("one lock probe answers many callers", () => {
  test("callers within the window share one run", async () => {
    const probe = countingProbe();
    const { now } = clock();
    const cached = cachedLockProbe(probe, { now, ...sameFiles });
    for (let i = 0; i < 25; i++) expect(await cached([A])).toBe("p100\nn/locks/a.lock\n");
    expect(probe.runs).toBe(1);
  });

  test("callers that arrive while a probe is out wait for it rather than starting their own", async () => {
    let release!: (answer: string) => void;
    let runs = 0;
    const cached = cachedLockProbe(() => {
      runs += 1;
      return new Promise<string>((resolve) => { release = resolve; });
    }, sameFiles);
    // The panel, the five-second turn poll and a parent's helper lookup, together.
    const asks = [cached([A]), cached([A]), cached([A])];
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(1);
    release("p7\nn/locks/a.lock\n");
    expect(await Promise.all(asks)).toEqual(Array(3).fill("p7\nn/locks/a.lock\n"));
    expect(runs).toBe(1);
  });

  test("the answer stands for the window, and not a moment longer", async () => {
    const probe = countingProbe();
    const { time, now } = clock();
    const cached = cachedLockProbe(probe, { now, ...sameFiles });
    await cached([A]);
    time.now += LOCK_PROBE_TTL_MS - 1;
    await cached([A]);
    expect(probe.runs).toBe(1);
    time.now += 1;
    await cached([A]);
    expect(probe.runs).toBe(2);
  });

  test("the window is the panel's own twenty-second backstop", () => {
    expect(LOCK_PROBE_TTL_MS).toBe(20_000);
  });

  test("the order the directory lists the files in is not a change", async () => {
    const probe = countingProbe();
    const cached = cachedLockProbe(probe, sameFiles);
    await cached([A, B]);
    await cached([B, A]);
    expect(probe.runs).toBe(1);
  });
});

describe("what makes the answer stale at once", () => {
  test("a lock file that appears — a thread opening — is probed on the next ask", async () => {
    const probe = countingProbe();
    const cached = cachedLockProbe(probe, sameFiles);
    await cached([A]);
    await cached([A, B]);
    expect(probe.runs).toBe(2);
  });

  test("a lock file that goes away — a clean exit — is probed on the next ask", async () => {
    const probe = countingProbe();
    const cached = cachedLockProbe(probe, sameFiles);
    await cached([A, B]);
    await cached([A]);
    expect(probe.runs).toBe(2);
  });

  test("a lock file replaced where it was is a different file", async () => {
    // Codex deletes a stale lock and creates its own under the same name: the
    // listing is identical, the file is not.
    const probe = countingProbe();
    const files = new Map([[A, "inode-1"]]);
    const cached = cachedLockProbe(probe, { identity: (path) => files.get(path) ?? null, alive: () => true });
    await cached([A]);
    await cached([A]);
    expect(probe.runs).toBe(1);
    files.set(A, "inode-2");
    await cached([A]);
    expect(probe.runs).toBe(2);
  });

  test("a holder that has exited is probed again: a crash leaves its files behind", async () => {
    const probe = countingProbe("p100\nn/locks/a.lock\np200\nn/locks/b.lock\n");
    const running = new Set([100, 200]);
    const asked: number[] = [];
    const cached = cachedLockProbe(probe, {
      identity: () => "1",
      alive: (pid) => { asked.push(pid); return running.has(pid); },
    });
    await cached([A, B]);
    await cached([A, B]);
    expect(probe.runs).toBe(1);
    // Both holders the answer named are the ones checked — not a guess.
    expect([...new Set(asked)].sort()).toEqual([100, 200]);
    running.delete(200);
    await cached([A, B]);
    expect(probe.runs).toBe(2);
  });

  test("an answer that names no holder has none to outlive", async () => {
    const probe = countingProbe("");
    let checks = 0;
    const cached = cachedLockProbe(probe, { identity: () => "1", alive: () => { checks += 1; return false; } });
    await cached([A]);
    await cached([A]);
    expect(probe.runs).toBe(1);
    expect(checks).toBe(0);
  });
});

describe("failures", () => {
  test("a probe that could not say is remembered too: re-running it every render is the cost being removed", async () => {
    const probe = countingProbe(null);
    const cached = cachedLockProbe(probe, sameFiles);
    expect(await cached([A])).toBeNull();
    expect(await cached([A])).toBeNull();
    expect(probe.runs).toBe(1);
  });

  test("a probe that throws does not wedge the next ask", async () => {
    let runs = 0;
    const cached = cachedLockProbe(() => {
      runs += 1;
      if (runs === 1) throw new Error("lsof exploded");
      return "p1\nn/locks/a.lock\n";
    }, sameFiles);
    await expect(cached([A])).rejects.toThrow("lsof exploded");
    expect(await cached([A])).toBe("p1\nn/locks/a.lock\n");
    expect(runs).toBe(2);
  });

  test("a probe that started earlier and finished later does not replace the newer answer", async () => {
    const releases = new Map<string, (answer: string) => void>();
    let runs = 0;
    const { time, now } = clock();
    const cached = cachedLockProbe((paths) => {
      runs += 1;
      return new Promise<string>((resolve) => { releases.set(paths.join(","), resolve); });
    }, { now, ...sameFiles });
    const older = cached([A]);
    time.now += 10;
    const newer = cached([A, B]);
    await Promise.resolve();
    await Promise.resolve();
    releases.get(`${A},${B}`)!("p2\nn/locks/b.lock\n");
    await newer;
    releases.get(A)!("p1\nn/locks/a.lock\n");
    await older;
    expect(runs).toBe(2);
    // The two-file answer is still the one remembered: asking again starts nothing.
    const again = cached([A, B]);
    await Promise.resolve();
    await Promise.resolve();
    expect(runs).toBe(2);
    expect(await again).toBe("p2\nn/locks/b.lock\n");
  });
});

describe("the real probe, as the daemon calls it", () => {
  /** Counts the `lsof` runs made while `run` is awaited. */
  async function countingLsof<T>(run: () => Promise<T>): Promise<{ result: T; lsof: number }> {
    const spawn = Bun.spawn;
    let lsof = 0;
    (Bun as any).spawn = (argv: any, ...rest: any[]) => {
      if (Array.isArray(argv) && argv[0] === "lsof") lsof += 1;
      return (spawn as any)(argv, ...rest);
    };
    try {
      return { result: await run(), lsof };
    } finally {
      (Bun as any).spawn = spawn;
    }
  }

  test("every caller in the daemon shares the one remembered probe, and a new lock is seen at once", async () => {
    // Resolved: `lsof` names the file by its real path, and the temp dir is behind /var -> /private/var.
    const home = realpathSync(mkdtempSync(join(tmpdir(), "conch-lock-cache-")));
    const dir = join(home, "thread-writer-locks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "open.lock"), "");
    // Held here, so the real `lsof` names this process — alive for as long as the test runs.
    const fd = openSync(join(dir, "open.lock"), "r");
    try {
      const first = await countingLsof(async () => {
        const reads = [];
        for (let i = 0; i < 5; i++) reads.push(await readCodexOpenThreadIds(home));
        return reads;
      });
      expect(first.lsof).toBe(1);
      for (const read of first.result) expect([...read]).toEqual([["open", process.pid]]);

      // A thread opens: its lock file appears, and the very next read probes for it.
      writeFileSync(join(dir, "opened.lock"), "");
      const second = await countingLsof(() => readCodexOpenThreadIds(home));
      expect(second.lsof).toBe(1);
      expect([...second.result.keys()]).toEqual(["open"]);
    } finally {
      closeSync(fd);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an injected probe is asked every time: a test's process table answers as it is now", async () => {
    const home = mkdtempSync(join(tmpdir(), "conch-lock-cache-"));
    const dir = join(home, "thread-writer-locks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "t.lock"), "");
    try {
      let runs = 0;
      const probe = (paths: string[]) => { runs += 1; return paths.join("\n"); };
      await readCodexOpenThreadIds(home, probe);
      await readCodexOpenThreadIds(home, probe);
      expect(runs).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the default liveness check sees a holder exit, and the default identity sees a file replaced", async () => {
    const home = mkdtempSync(join(tmpdir(), "conch-lock-cache-"));
    const path = join(home, "a.lock");
    writeFileSync(path, "");
    const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      let runs = 0;
      const cached = cachedLockProbe(() => { runs += 1; return `p${child.pid}\nn${path}\n`; });
      await cached([path]);
      await cached([path]);
      expect(runs).toBe(1);

      child.kill();
      await child.exited;
      await cached([path]);
      expect(runs).toBe(2);

      // Deleted and created again under the same name: a new inode, so a new answer.
      const settled = cachedLockProbe(() => { runs += 1; return ""; });
      await settled([path]);
      await settled([path]);
      expect(runs).toBe(3);
      rmSync(path);
      writeFileSync(path, "");
      await settled([path]);
      expect(runs).toBe(4);
    } finally {
      child.kill();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

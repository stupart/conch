import { expect, test } from "bun:test";
import { closeTerminalSession, startTerminalSession, type SessionLifecycleDependencies, type SessionLifecycleProcess } from "../src/session-lifecycle.ts";

const identity = { pid: 4242, birth: "1000.000001", birthTimeMs: 1_000_000.001, executable: "/fake/claude", ttyDevice: 7 };
function dependencies(spawn: () => SessionLifecycleProcess): SessionLifecycleDependencies {
  return {
    spawn, which: () => "/fake/claude", isDirectory: () => true,
    processIdentity: () => identity, expectedIdentity: identity, backend: "claude",
    ttyForPid: async () => "ttys007", pidIsAlive: async () => false,
    automationTimeoutMs: 5,
  };
}
const start = (deps: SessionLifecycleDependencies) => startTerminalSession({ backend: "claude", cwd: "/fixture" }, deps);
const close = (deps: SessionLifecycleDependencies) => closeTerminalSession(identity.pid, deps);
function completed(): SessionLifecycleProcess {
  return { exited: Promise.resolve(0), stdout: new Response("ok").body, stderr: null, cancel() {} };
}
function within<T>(work: Promise<T>, ms = 750): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test deadline")), ms); })])
    .finally(() => clearTimeout(timer));
}

for (const [name, run] of [["Close", close], ["Start", start]] as const) {
  test(`${name} timeout seals subsequent UI work until its helper exit is observed`, async () => {
    let observedExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { observedExit = resolve; });
    let cancelled = 0, laterSpawned = 0;
    const deps = dependencies(() => ({ exited, stdout: null, stderr: null, cancel() { cancelled++; } }));
    const later = dependencies(() => { laterSpawned++; return completed(); });
    const work = run(deps);
    try {
      await expect(within(work)).rejects.toThrow("automation timed out");
      expect(cancelled).toBe(1);
      await expect(start(later)).rejects.toThrow("Previous UI child has not exited");
      expect(laterSpawned).toBe(0);
    } finally {
      observedExit(0);
      await work.catch(() => {});
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    await start(later);
    expect(laterSpawned).toBe(1);
  });
}

for (const [name, run, stream, code] of [["Close", close, "stdout", 0], ["Start", start, "stderr", 1]] as const) {
  test(`${name} bounds a hanging ${stream} even after its helper exits`, async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const hanging = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
    const deps = dependencies(() => ({ ...completed(), exited: Promise.resolve(code), [stream]: hanging }));
    const work = run(deps);
    try {
      await expect(within(work, 150)).rejects.toThrow("automation timed out");
    } finally {
      output.close();
      await work.catch(() => {});
    }
    await start(dependencies(completed));
  });
}

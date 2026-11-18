import { describe, expect, test } from "bun:test";
import { runUICommand } from "../src/pasteboard.ts";

const stream = (text: string) => new Blob([text]).stream();

describe("bounded UI subprocess outcomes", () => {
  test("reads the actual exit code and stderr, including nonzero exits", async () => {
    let killed = false;
    const result = await runUICommand(["fake-osascript"], undefined, {
      spawn: () => ({ stdout: stream(""), stderr: stream("not authorized -1743"), exited: Promise.resolve(1), kill: () => { killed = true; } }),
    });
    expect(result).toEqual({ text: "", stderr: "not authorized -1743", exitCode: 1, timedOut: false });
    expect(killed).toBe(false);
  });

  test("stdout EOF alone is not successful completion", async () => {
    let exit!: (code: number) => void;
    let settled = false;
    const result = runUICommand(["fake-osascript"], undefined, {
      spawn: () => ({ stdout: stream("ok"), stderr: stream(""), exited: new Promise<number>((resolve) => { exit = resolve; }), kill: () => {} }),
    }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    exit(2);
    expect((await result).exitCode).toBe(2);
  });

  test("timeout kills and reaps only its own child before returning", async () => {
    let exit!: (code: number) => void;
    const kills: string[] = [];
    const result = await runUICommand(["fake-osascript"], undefined, {
      timeoutMs: 1,
      spawn: () => ({
        stdout: stream(""), stderr: stream(""),
        exited: new Promise<number>((resolve) => { exit = resolve; }),
        kill: (signal) => { kills.push(signal); exit(137); },
      }),
    });
    expect(result.timedOut).toBe(true);
    expect(kills).toEqual(["SIGKILL"]);
    const next = await runUICommand(["fake-osascript"], undefined, {
      spawn: () => ({ stdout: stream("ok"), stderr: stream(""), exited: Promise.resolve(0), kill: () => { throw new Error("Already exited"); } }),
    });
    expect(next).toEqual({ text: "ok", stderr: "", exitCode: 0, timedOut: false });
  });

  test("a broken output stream also reaps its still-running child", async () => {
    let exit!: (code: number) => void;
    const kills: string[] = [];
    await expect(runUICommand(["fake-osascript"], undefined, {
      spawn: () => ({
        stdout: new ReadableStream({ start(controller) { controller.error(new Error("fake read error")); } }),
        stderr: stream(""), exited: new Promise<number>((resolve) => { exit = resolve; }),
        kill: (signal) => { kills.push(signal); exit(137); },
      }),
    })).rejects.toThrow("fake read error");
    expect(kills).toEqual(["SIGKILL"]);
  });

  test("an unreaped child returns promptly and seals the UI scope until observed exit", async () => {
    let exit!: (code: number) => void;
    const scope = { unreaped: new Set<Promise<number>>() };
    const options = {
      scope, timeoutMs: 1, reapTimeoutMs: 1,
      spawn: () => ({ stdout: stream(""), stderr: stream(""), exited: new Promise<number>((resolve) => { exit = resolve; }), kill: () => {} }),
    };
    const pending = runUICommand(["fake-unkillable"], undefined, options);
    try {
      const result = await Promise.race([pending, Bun.sleep(50).then(() => null)]);
      expect(result?.timedOut).toBe(true);
      let spawned = false;
      const blocked = await runUICommand(["must-not-spawn"], undefined, {
        scope,
        spawn: () => { spawned = true; throw new Error("Overlapping UI child"); },
      });
      expect(spawned).toBe(false);
      expect(blocked.timedOut).toBe(true);
      expect(scope.unreaped.size).toBe(1);
    } finally {
      const observed = [...scope.unreaped];
      exit(137);
      await pending;
      await Promise.all(observed);
    }
    expect(scope.unreaped.size).toBe(0);
  });

  test("a kill racing natural exit does not throw or leave the scope blocked", async () => {
    let exit!: (code: number) => void;
    const scope = { unreaped: new Set<Promise<number>>() };
    const result = await runUICommand(["fake-exit-race"], undefined, {
      scope, timeoutMs: 1, reapTimeoutMs: 1,
      spawn: () => ({
        stdout: stream(""), stderr: stream(""), exited: new Promise<number>((resolve) => { exit = resolve; }),
        kill: () => { exit(0); throw new Error("No such process"); },
      }),
    });
    expect(result.timedOut).toBe(true);
    expect(scope.unreaped.size).toBe(0);
  });
});

import { expect, test, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWindowKey, parseWindowKey, windowKey, windowPidFromAncestry } from "../src/window-key.ts";
import { findHookWindow, findSession, findTranscript, registrySnapshot, sessionLabel } from "../src/sessions.ts";

const UUID = "4eb30ede-6401-40bc-b714-aa9b88e358c4";

describe("window keys", () => {
  test("a lone session keeps the id it has always had", () => {
    expect(windowKey(UUID, 21210, false)).toBe(UUID);
    expect(windowKey(UUID, undefined, true)).toBe(UUID); // nothing to name it by
    expect(isWindowKey(UUID)).toBe(false);
  });

  test("a shared id names the window, and parses back", () => {
    const key = windowKey(UUID, 21210, true);
    expect(key).toBe(`${UUID}#21210`);
    expect(parseWindowKey(key)).toEqual({ sessionId: UUID, pid: 21210 });
    expect(isWindowKey(key)).toBe(true);
  });

  test("a plain id survives parsing untouched, whatever it contains", () => {
    for (const id of [UUID, "codex#thread", "#", "", "abc#0", "abc#-1", "abc#x"]) {
      expect(parseWindowKey(id).sessionId).toBe(id);
      expect(parseWindowKey(id).pid).toBeUndefined();
    }
  });

  test("ancestry finds this process, and its parent, in the real process tree", async () => {
    expect(await windowPidFromAncestry(new Set([process.pid]))).toBe(process.pid);
    expect(await windowPidFromAncestry(new Set([process.ppid]))).toBe(process.ppid);
    // nothing to match: an empty answer, not a wrong one
    expect(await windowPidFromAncestry(new Set([1_000_000]))).toBeUndefined();
    expect(await windowPidFromAncestry(new Set())).toBeUndefined();
  });
});

describe("two windows on one id, end to end", () => {
  function registry(): string {
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-window-"));
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    const write = (pid: number, name: string, startedAt: number) =>
      writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
        pid, sessionId: UUID, name, startedAt,
        cwd: "/Users/t", kind: "interactive", entrypoint: "cli",
      }));
    write(39889, "arch site", 1_000);
    write(21210, "arch-prime", 9_000);
    return claudeDir;
  }
  const opts = (dir: string) => ({ configDir: join(dir, "conch-config") });

  test("each window is addressable, and the session stays live under either name", async () => {
    const dir = registry();
    const snap = await registrySnapshot(dir, opts(dir));
    expect(snap!.infos.map((s) => s.sessionId).sort()).toEqual(
      [`${UUID}#21210`, `${UUID}#39889`].sort(),
    );
    // every row still knows which session it belongs to
    expect(snap!.infos.every((s) => s.agentSessionId === UUID)).toBe(true);
    // liveness answers for the window keys AND the id itself, so a check that
    // asks "has this session closed?" the old way is never told yes wrongly
    expect(snap!.liveIds.has(UUID)).toBe(true);
    expect(snap!.liveIds.has(`${UUID}#21210`)).toBe(true);
    expect(snap!.liveIds.has(`${UUID}#39889`)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a window key resolves to that window, not the newest", async () => {
    const dir = registry();
    expect((await findSession(dir, `${UUID}#39889`))?.pid).toBe(39889);
    expect((await findSession(dir, `${UUID}#21210`))?.pid).toBe(21210);
    expect((await findSession(dir, UUID))?.pid).toBe(21210); // ambiguous: newest
    expect(await findSession(dir, `${UUID}#404`)).toBeNull(); // that window is gone
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hook resolves to one window and reports it by key", async () => {
    const dir = registry();
    const found = await findHookWindow(dir, UUID);
    // this test process is no descendant of either fake pid, so ancestry finds
    // nothing and the newest window is the fallback — never a null attribution
    expect(found?.sessionId).toBe(`${UUID}#21210`);
    expect(found?.agentSessionId).toBe(UUID);
    rmSync(dir, { recursive: true, force: true });
  });

  test("both windows read the one transcript the session actually has", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-window-t-"));
    const project = join(dir, "projects", "-Users-t");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${UUID}.jsonl`), "{}\n");
    const expected = join(project, `${UUID}.jsonl`);
    expect(findTranscript(dir, UUID)).toBe(expected);
    expect(findTranscript(dir, `${UUID}#39889`)).toBe(expected);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a rename made before the split still names the window it was meant for", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-window-l-"));
    const labelsPath = join(dir, "labels.json");
    writeFileSync(labelsPath, JSON.stringify({ [UUID]: "Abacus" }));
    const info = { sessionId: `${UUID}#39889`, agentSessionId: UUID, name: "arch site" };
    expect(sessionLabel(info, "/Users/t", { labelsPath })).toBe("Abacus");
    // and the window's own name wins over the session's when both exist
    writeFileSync(labelsPath, JSON.stringify({ [UUID]: "Abacus", [`${UUID}#39889`]: "site" }));
    expect(sessionLabel(info, "/Users/t", { labelsPath })).toBe("site");
    rmSync(dir, { recursive: true, force: true });
  });
});

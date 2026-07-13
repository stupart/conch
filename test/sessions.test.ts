import { expect, test, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isEngageable, registrySnapshot } from "../src/sessions.ts";

describe("isEngageable — only top-level interactive CLI sessions get engaged", () => {
  test("a real interactive CLI session passes", () => {
    expect(isEngageable({ kind: "interactive", entrypoint: "cli" })).toBe(true);
  });

  test("a headless sdk-cli routine (e.g. boatker cron) is dropped", () => {
    expect(isEngageable({ kind: "interactive", entrypoint: "sdk-cli" })).toBe(false);
  });

  test("a non-interactive kind is dropped", () => {
    expect(isEngageable({ kind: "headless", entrypoint: "cli" })).toBe(false);
  });

  test("missing fields are tolerated (older registries pass — conservative)", () => {
    expect(isEngageable({})).toBe(true);
    expect(isEngageable({ kind: "interactive" })).toBe(true);
    expect(isEngageable({ entrypoint: "cli" })).toBe(true);
  });

  test("a positively non-cli entrypoint is dropped even with no kind", () => {
    expect(isEngageable({ entrypoint: "sdk-cli" })).toBe(false);
  });
});

describe("registrySnapshot — torn-file salvage + completeness (FEATURE C safety)", () => {
  function makeRegistry(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "conch-reg-"));
    mkdirSync(join(root, "sessions"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "sessions", name), body);
    return root;
  }
  const engageable = (id: string) => JSON.stringify({ sessionId: id, name: id, kind: "interactive", entrypoint: "cli", status: "busy" });
  const headless = (id: string) => JSON.stringify({ sessionId: id, name: id, kind: "interactive", entrypoint: "sdk-cli", status: "busy" });

  test("engageable sessions land in infos; headless are excluded but stay in liveIds", () => {
    const root = makeRegistry({ "1.json": engageable("aaa"), "2.json": headless("bbb") });
    return registrySnapshot(root).then((snap) => {
      expect(snap).not.toBeNull();
      expect(snap!.infos.map((s) => s.sessionId)).toEqual(["aaa"]);
      expect(snap!.liveIds.has("aaa")).toBe(true);
      expect(snap!.liveIds.has("bbb")).toBe(true); // liveness ≠ engageability
      expect(snap!.complete).toBe(true);
      rmSync(root, { recursive: true, force: true });
    });
  });

  test("a torn mid-write file → complete=false, but its id is SALVAGED into liveIds (not treated as closed)", () => {
    const root = makeRegistry({ "1.json": engageable("aaa"), "2.json": '{"sessionId":"ccc","kind":"inter' /* truncated */ });
    return registrySnapshot(root).then((snap) => {
      expect(snap!.complete).toBe(false);
      expect(snap!.liveIds.has("ccc")).toBe(true); // salvaged — a held reply for ccc survives resume
      expect(snap!.infos.map((s) => s.sessionId)).toEqual(["aaa"]); // unparseable → not rendered
      rmSync(root, { recursive: true, force: true });
    });
  });

  test("unreadable registry dir → null (total uncertainty; callers keep everything)", () => {
    return registrySnapshot(join(tmpdir(), "conch-does-not-exist-xyz")).then((snap) => {
      expect(snap).toBeNull();
    });
  });
});

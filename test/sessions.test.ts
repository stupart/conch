import { expect, test, describe } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findSessionByName,
  isEngageable,
  normalizeSessionLabel,
  registrySnapshot,
  renameSessionLabel,
  sessionGoneFromSnapshot,
  sessionLabel,
  setLabelOverride,
} from "../src/sessions.ts";
import { activeSessionIdForRows, buildPanelRows } from "../src/panel.ts";
import { setVoiceOverride, voiceFor } from "../src/speak.ts";
import { loadConfig } from "../src/config.ts";

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

  test("a torn live reciting id never retargets to a complete same-label session", async () => {
    const root = makeRegistry({
      "1.json": JSON.stringify({
        sessionId: "other",
        name: "duplicate",
        kind: "interactive",
        entrypoint: "cli",
        status: "busy",
      }),
      "2.json": '{"sessionId":"reciting","name":"duplicate","kind":"inter',
    });
    const snap = await registrySnapshot(root);
    const live = { state: "speaking" as const, label: "duplicate", partial: "" };
    const rows = buildPanelRows({
      sessions: snap!.infos,
      sessionStates: new Map(),
      pausedSessionIds: new Set(),
      mutedSessionIds: new Set(),
      live,
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
    });

    expect(snap!.infos.map((session) => session.sessionId)).toEqual(["other"]);
    expect(snap!.liveIds).toEqual(new Set(["other", "reciting"]));
    expect(activeSessionIdForRows(rows, live, {
      preferredSessionId: "reciting",
      liveSessionIds: snap!.liveIds,
    })).toBe("reciting");
    expect(activeSessionIdForRows(rows, live, {
      preferredSessionId: "reciting",
      liveSessionIds: new Set(["other"]),
    })).toBe("other");
    rmSync(root, { recursive: true, force: true });
  });

  test("unreadable registry dir → null (total uncertainty; callers keep everything)", () => {
    return registrySnapshot(join(tmpdir(), "conch-does-not-exist-xyz")).then((snap) => {
      expect(snap).toBeNull();
    });
  });
});

describe("sessionGoneFromSnapshot — complete snapshots only", () => {
  test("complete snapshot, id absent → gone", () => {
    expect(sessionGoneFromSnapshot({
      infos: [],
      liveIds: new Set(["live"]),
      complete: true,
    }, "closed")).toBe(true);
  });

  test("complete snapshot, id present → live", () => {
    expect(sessionGoneFromSnapshot({
      infos: [],
      liveIds: new Set(["live"]),
      complete: true,
    }, "live")).toBe(false);
  });

  test("incomplete snapshot, id absent → uncertainty is live", () => {
    expect(sessionGoneFromSnapshot({
      infos: [],
      liveIds: new Set(),
      complete: false,
    }, "possibly-live")).toBe(false);
  });

  test("torn-file-salvaged id in incomplete snapshot → live", () => {
    expect(sessionGoneFromSnapshot({
      infos: [],
      liveIds: new Set(["salvaged"]),
      complete: false,
    }, "salvaged")).toBe(false);
  });

  test("null snapshot → uncertainty is live", () => {
    expect(sessionGoneFromSnapshot(null, "possibly-live")).toBe(false);
  });

  test("empty session id → uncertainty is live", () => {
    expect(sessionGoneFromSnapshot({
      infos: [],
      liveIds: new Set(),
      complete: true,
    }, "")).toBe(false);
  });
});

describe("conch session-label overrides", () => {
  function fixture(): {
    root: string;
    claudeDir: string;
    labelsPath: string;
    voicesPath: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "conch-labels-"));
    const claudeDir = join(root, "claude");
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    return {
      root,
      claudeDir,
      labelsPath: join(root, "config", "labels.json"),
      voicesPath: join(root, "config", "voices.json"),
    };
  }

  test("sessionLabel precedence is override > registry name > folder, and lookup matches override first", async () => {
    const f = fixture();
    try {
      const session = {
        sessionId: "session-a",
        name: "registry-name",
        cwd: "/work/folder-name",
        kind: "interactive",
        entrypoint: "cli",
      };
      writeFileSync(join(f.claudeDir, "sessions", "1.json"), JSON.stringify(session));
      writeFileSync(join(f.claudeDir, "sessions", "2.json"), JSON.stringify({
        ...session,
        sessionId: "session-b",
        name: "conch-name",
      }));

      expect(sessionLabel(session, session.cwd, { labelsPath: f.labelsPath })).toBe("registry-name");
      expect(sessionLabel({ sessionId: "folder-only", cwd: session.cwd }, session.cwd, {
        labelsPath: f.labelsPath,
      })).toBe("folder-name");

      setLabelOverride(session.sessionId, "  conch-name  ", { labelsPath: f.labelsPath });
      expect(sessionLabel(session, session.cwd, { labelsPath: f.labelsPath })).toBe("conch-name");
      expect((await findSessionByName(f.claudeDir, "CONCH-NAME", {
        labelsPath: f.labelsPath,
      }))?.sessionId).toBe(session.sessionId);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("persisted labels strip controls, cap at 40 code points, and reject empty input", () => {
    const f = fixture();
    try {
      const long = ` \u0000hello\n${"🦪".repeat(50)} `;
      const canonical = setLabelOverride("session-a", long, { labelsPath: f.labelsPath });
      expect(canonical.startsWith("hello")).toBe(true);
      expect(Array.from(canonical)).toHaveLength(40);
      expect(canonical).toBe(normalizeSessionLabel(long));
      expect(() => setLabelOverride("session-a", "\n\t\u0000", {
        labelsPath: f.labelsPath,
      })).toThrow("Session label cannot be empty");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  test("voice-pin migration on rename persists one canonical operation and preserves the old pin", () => {
    const f = fixture();
    const cfg = loadConfig({
      env: { CONCH_TTS_VOICES: "af_heart,bf_emma" },
      settingsPath: join(f.root, "settings.json"),
    });
    try {
      setVoiceOverride("Old Label", "am_adam", { voicesPath: f.voicesPath });
      const result = renameSessionLabel("session-a", "Old Label", "  New Label\n  ", {
        labelsPath: f.labelsPath,
        voicesPath: f.voicesPath,
      });

      expect(result).toEqual({ label: "New Label", voiceMigrated: true });
      expect(JSON.parse(readFileSync(f.labelsPath, "utf8"))).toEqual({ "session-a": "New Label" });
      expect(JSON.parse(readFileSync(f.voicesPath, "utf8"))).toEqual({ "new label": "am_adam" });
      expect(voiceFor(cfg, "New Label", { voicesPath: f.voicesPath })).toBe("am_adam");
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleCodexHookPayload,
  hasCodexDesktopAncestor,
  isCodexDesktopProcess,
  type CodexHookDependencies,
  type CodexHookPayload,
} from "../src/codex-hook.ts";
import { loadConfig } from "../src/config.ts";
import type { TurnEvent } from "../src/hook.ts";

const roots: string[] = [];

interface HarnessOptions {
  parentPid?: number;
  now?: number;
  desktopOrigin?: boolean;
  daemonAccepts?: boolean;
  mark?: number;
}

function harness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "conch-codex-hook-"));
  roots.push(root);
  const cfg = loadConfig({
    env: {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CONCH_CONFIG_DIR: join(root, "config"),
      CONCH_SEASHELL_ROOT: join(root, "seashell"),
      CONCH_SOCKET: join(root, "daemon.sock"),
      CONCH_WHISPER_CLI: join(root, "whisper-cli"),
      CONCH_WHISPER_SERVER: join(root, "whisper-server"),
      CONCH_WHISPER_MODEL: join(root, "whisper.bin"),
      CONCH_VAD_MODEL: join(root, "vad.bin"),
    },
    settingsPath: join(root, "settings.json"),
  });
  const writes: Array<Parameters<CodexHookDependencies["writeSession"]>[0]> = [];
  const sends: Array<{ socketPath: string; event: TurnEvent }> = [];
  const desktopChecks: number[] = [];
  const marks: string[] = [];
  const bells: string[] = [];
  const speeches: Array<{ text: string; label?: string }> = [];
  const labels: Array<{ session: Parameters<CodexHookDependencies["labelFor"]>[0]; cwd?: string }> = [];

  const dependencies: CodexHookDependencies = {
    parentPid: () => options.parentPid ?? 4242,
    now: () => options.now ?? 1_700_000_000_123,
    async isDesktopOrigin(pid) {
      desktopChecks.push(pid);
      return options.desktopOrigin ?? false;
    },
    writeSession(entry) {
      writes.push(entry);
    },
    async sendToDaemon(socketPath, event) {
      sends.push({ socketPath, event });
      return options.daemonAccepts ?? true;
    },
    async transcriptMark(path) {
      marks.push(path);
      return options.mark ?? 7;
    },
    labelFor(session, cwd) {
      labels.push({ session, cwd });
      return "codex-project";
    },
    async bell() {
      bells.push("bell");
    },
    async speak(_cfg, text, label) {
      speeches.push({ text, ...(label === undefined ? {} : { label }) });
    },
  };

  return {
    cfg,
    dependencies,
    calls: { writes, sends, desktopChecks, marks, bells, speeches, labels },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("handleCodexHookPayload", () => {
  test("Stop writes an idle registry entry and sends an exact review TurnEvent", async () => {
    const h = harness();
    const payload: CodexHookPayload = {
      hook_event_name: "Stop",
      session_id: "session-123",
      transcript_path: "/virtual/rollout-2026-07-29-session-123.jsonl",
      cwd: "/work/codex-project",
      turn_id: "turn-456",
      last_assistant_message: [
        "The implementation and tests are complete.",
        "conch:review Review the Codex backend | https://example.com/review/123",
      ].join("\n"),
      agent_type: null,
      stop_hook_active: false,
    };

    const event = await handleCodexHookPayload(payload, h.cfg, h.dependencies);
    const expected: TurnEvent = {
      type: "turn-end",
      sessionId: "session-123",
      label: "codex-project",
      cwd: "/work/codex-project",
      pid: 4242,
      announce: "codex-project has work ready for your review: Review the Codex backend",
      transcriptPath: "/virtual/rollout-2026-07-29-session-123.jsonl",
      mark: 7,
      eventAt: 1_700_000_000_123,
      review: {
        summary: "Review the Codex backend",
        link: "https://example.com/review/123",
      },
    };

    expect(event).toEqual(expected);
    expect(h.calls.writes).toEqual([{
      sessionId: "session-123",
      cwd: "/work/codex-project",
      pid: 4242,
      status: "idle",
      updatedAt: 1_700_000_000_123,
      transcriptPath: "/virtual/rollout-2026-07-29-session-123.jsonl",
    }]);
    expect(h.calls.sends).toEqual([{ socketPath: h.cfg.socketPath, event: expected }]);
    expect(h.calls.marks).toEqual(["/virtual/rollout-2026-07-29-session-123.jsonl"]);
    expect(h.calls.bells).toEqual([]);
    expect(h.calls.speeches).toEqual([]);
  });

  test("Stop strips markdown and announces the configured first sentences", async () => {
    const h = harness({ mark: 3 });
    const payload: CodexHookPayload = {
      hook_event_name: "Stop",
      session_id: "plain-stop",
      transcript_path: "/virtual/rollout-plain-stop.jsonl",
      cwd: "/work/codex-project",
      last_assistant_message:
        "**First complete sentence.** Second complete sentence! Third sentence is not announced.",
      agent_type: null,
    };

    const event = await handleCodexHookPayload(payload, h.cfg, h.dependencies);

    expect(event).toEqual({
      type: "turn-end",
      sessionId: "plain-stop",
      label: "codex-project",
      cwd: "/work/codex-project",
      pid: 4242,
      announce: "codex-project: First complete sentence. Second complete sentence!",
      transcriptPath: "/virtual/rollout-plain-stop.jsonl",
      mark: 3,
      eventAt: 1_700_000_000_123,
    });
  });

  test("UserPromptSubmit writes busy and sends the same visual working signal as Claude Code", async () => {
    const h = harness();
    const payload: CodexHookPayload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-busy",
      transcript_path: "/virtual/rollout-session-busy.jsonl",
      cwd: "/work/codex-project",
      agent_type: null,
    };

    const event = await handleCodexHookPayload(payload, h.cfg, h.dependencies);
    const expected: TurnEvent = {
      type: "working",
      sessionId: "session-busy",
      label: "codex-project",
      cwd: "/work/codex-project",
      pid: 4242,
      announce: "",
      eventAt: 1_700_000_000_123,
    };

    expect(event).toEqual(expected);
    expect(h.calls.writes).toEqual([{
      sessionId: "session-busy",
      cwd: "/work/codex-project",
      pid: 4242,
      status: "busy",
      updatedAt: 1_700_000_000_123,
      transcriptPath: "/virtual/rollout-session-busy.jsonl",
    }]);
    expect(h.calls.sends).toEqual([{ socketPath: h.cfg.socketPath, event: expected }]);
    expect(h.calls.marks).toEqual([]);
    expect(h.calls.bells).toEqual([]);
    expect(h.calls.speeches).toEqual([]);
  });

  test("SessionStart creates an idle registry entry without emitting an event", async () => {
    const h = harness();
    const payload: CodexHookPayload = {
      hook_event_name: "SessionStart",
      session_id: "session-start",
      transcript_path: "/virtual/rollout-session-start.jsonl",
      cwd: "/work/codex-project",
      agent_type: null,
    };

    expect(await handleCodexHookPayload(payload, h.cfg, h.dependencies)).toBeNull();
    expect(h.calls.writes).toEqual([{
      sessionId: "session-start",
      cwd: "/work/codex-project",
      pid: 4242,
      status: "idle",
      updatedAt: 1_700_000_000_123,
      transcriptPath: "/virtual/rollout-session-start.jsonl",
    }]);
    expect(h.calls.sends).toEqual([]);
    expect(h.calls.marks).toEqual([]);
    expect(h.calls.bells).toEqual([]);
    expect(h.calls.speeches).toEqual([]);
  });

  test("a non-null agent_type filters subagents before registry or daemon effects", async () => {
    const h = harness();
    const payload: CodexHookPayload = {
      hook_event_name: "Stop",
      session_id: "subagent",
      transcript_path: "/virtual/rollout-subagent.jsonl",
      cwd: "/work/codex-project",
      last_assistant_message: "Subagent finished.",
      agent_type: "explore",
    };

    expect(await handleCodexHookPayload(payload, h.cfg, h.dependencies)).toBeNull();
    expect(h.calls.writes).toEqual([]);
    expect(h.calls.sends).toEqual([]);
    expect(h.calls.marks).toEqual([]);
    expect(h.calls.labels).toEqual([]);
    expect(h.calls.bells).toEqual([]);
    expect(h.calls.speeches).toEqual([]);
  });

  test("a desktop-app ancestor filters the hook before registry or daemon effects", async () => {
    const h = harness({ desktopOrigin: true });
    const payload: CodexHookPayload = {
      hook_event_name: "Stop",
      session_id: "desktop-session",
      transcript_path: "/virtual/rollout-desktop.jsonl",
      cwd: "/work/codex-project",
      last_assistant_message: "Desktop turn finished.",
      agent_type: null,
    };

    expect(await handleCodexHookPayload(payload, h.cfg, h.dependencies)).toBeNull();
    expect(h.calls.desktopChecks).toEqual([4242]);
    expect(h.calls.writes).toEqual([]);
    expect(h.calls.sends).toEqual([]);
    expect(h.calls.marks).toEqual([]);
    expect(h.calls.labels).toEqual([]);
    expect(h.calls.bells).toEqual([]);
    expect(h.calls.speeches).toEqual([]);
  });
});

test("desktop ancestry matches the executable/subcommand without false-positive cwd arguments", async () => {
  expect(isCodexDesktopProcess(
    "/Applications/Codex.app/Contents/MacOS/Codex --flag",
  )).toBe(true);
  expect(isCodexDesktopProcess("/opt/homebrew/bin/codex app-server")).toBe(true);
  expect(isCodexDesktopProcess("/opt/codex/app-server --listen")).toBe(true);
  expect(isCodexDesktopProcess("/opt/homebrew/bin/codex -C /work/app-server")).toBe(false);

  const tree = new Map([
    [900, { ppid: 800, command: "/opt/homebrew/bin/codex" }],
    [800, { ppid: 700, command: "/opt/homebrew/bin/codex app-server" }],
  ]);
  expect(await hasCodexDesktopAncestor(900, (pid) => tree.get(pid) ?? null)).toBe(true);

  tree.set(800, { ppid: 1, command: "/bin/zsh" });
  expect(await hasCodexDesktopAncestor(900, (pid) => tree.get(pid) ?? null)).toBe(false);
});

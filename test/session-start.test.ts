import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchSocketTurnEvent, validateSocketTurnEvent, type SocketTurnEventCallbacks } from "../src/control-server.ts";
import { sessionStartEvent, type TurnEvent } from "../src/hook.ts";
import { CLAUDE_HOOK_EVENTS, runInstall } from "../src/install.ts";
import { removeConchHooks } from "../src/uninstall.ts";

/**
 * A session stopped and resumed (`claude --resume`, same id) is a new process
 * in a new Terminal tab. conch wired no SessionStart hook, so it learned of the
 * new process only from its first prompt: on 2026-09-26 a message sent from
 * conch in between went to the old terminal and landed on the clipboard
 * (`inject into "conch" via osascript-focused NOT confirmed`). What the daemon
 * does with the event is in voice-loop.test.ts ("a session that starts again").
 */
const SESSION = "5e5510a0-0000-4000-8000-00000000c0de";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; printed: string[] }> {
  const log = console.log;
  const printed: string[] = [];
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  try {
    return { result: await work(), printed };
  } finally {
    console.log = log;
  }
}

describe("conch install wires SessionStart", () => {
  const conchHooks = (settings: any, event: string): string[] =>
    (settings.hooks?.[event] ?? []).flatMap((entry: any) => (entry.hooks ?? []).map((hook: any) => hook.command))
      .filter((command: string) => / hook$/.test(command));

  test("a fresh install wires it with the others", async () => {
    const root = scratch("conch-session-start-install-");
    await quietly(() => runInstall({ claudeDir: root } as any));
    const settings = JSON.parse(readFileSync(join(root, "settings.json"), "utf8"));
    expect(CLAUDE_HOOK_EVENTS).toContain("SessionStart");
    for (const event of CLAUDE_HOOK_EVENTS) expect(conchHooks(settings, event)).toHaveLength(1);
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: conchHooks(settings, "Stop")[0], timeout: 15 }] }]);
  });

  test("an install from before it gains only SessionStart, keeps a hook of the person's own there, and a second run changes nothing", async () => {
    const root = scratch("conch-session-start-upgrade-");
    const settingsPath = join(root, "settings.json");
    // Written by an older conch under a different bun, as on 2026-09-23.
    const old = '"/opt/homebrew/Cellar/bun/1.4.0/bin/bun" "/Users/t/Projects/Conch/src/cli.ts" hook';
    const theirs = { hooks: [{ type: "command", command: "echo hello" }] };
    writeFileSync(settingsPath, JSON.stringify({
      model: "keep-me",
      hooks: {
        ...Object.fromEntries(["Stop", "Notification", "UserPromptSubmit", "PermissionRequest"].map((event) =>
          [event, [{ hooks: [{ type: "command", command: old, timeout: 15 }] }]])),
        SessionStart: [theirs],
      },
    }));

    const first = await quietly(() => runInstall({ claudeDir: root } as any));
    const upgraded = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(upgraded.model).toBe("keep-me");
    for (const event of ["Stop", "Notification", "UserPromptSubmit", "PermissionRequest"]) {
      expect(upgraded.hooks[event]).toEqual([{ hooks: [{ type: "command", command: old, timeout: 15 }] }]);
    }
    expect(upgraded.hooks.SessionStart[0]).toEqual(theirs);
    expect(conchHooks(upgraded, "SessionStart")).toHaveLength(1);
    expect(first.printed.some((line) => line.startsWith("SessionStart: wired"))).toBe(true);
    expect(readdirSync(root).filter((name) => name.includes("conch-backup"))).toHaveLength(1);

    const text = readFileSync(settingsPath, "utf8");
    const second = await quietly(() => runInstall({ claudeDir: root } as any));
    expect(readFileSync(settingsPath, "utf8")).toBe(text);
    expect(readdirSync(root).filter((name) => name.includes("conch-backup"))).toHaveLength(1);
    expect(second.printed).toContain("\nNothing to do.");

    // And `conch uninstall` takes it away again, leaving the person's own.
    const removed = removeConchHooks(JSON.parse(text), "claude");
    expect(removed.removedByEvent.SessionStart).toBe(1);
    expect(removed.settings.hooks).toEqual({ SessionStart: [theirs] });
  });
});

describe("the hook maps SessionStart to a session-start", () => {
  test("each source Claude Code names is carried, and one conch doesn't know is left out", () => {
    for (const source of ["startup", "resume", "clear", "compact"] as const) {
      expect(sessionStartEvent({ session_id: SESSION, source }, null, "alpha", 5).startSource).toBe(source);
    }
    const unknown = sessionStartEvent({ session_id: SESSION, source: "teleport" }, null, "alpha", 5);
    expect("startSource" in unknown).toBe(false);
    expect(validateSocketTurnEvent(unknown).ok).toBe(true);
  });

  test("the window's key and pid come from the registry, the rest from the payload; never a turn", () => {
    const event = sessionStartEvent(
      { session_id: SESSION, cwd: "/work", transcript_path: "/work/t.jsonl", source: "resume" },
      { sessionId: `${SESSION}#4242`, pid: 4242 },
      "alpha",
      7,
    );
    expect(event).toEqual({
      type: "session-start", sessionId: `${SESSION}#4242`, label: "alpha", cwd: "/work", pid: 4242,
      announce: "", transcriptPath: "/work/t.jsonl", eventAt: 7, startSource: "resume",
    });
    // No registry entry yet: the id from the payload, and no pid to guess.
    const unregistered = sessionStartEvent({ session_id: SESSION, cwd: "/work" }, null, "work", 7);
    expect(unregistered.sessionId).toBe(SESSION);
    expect(unregistered.pid).toBeUndefined();
  });
});

/** Runs the real `conch hook` against a scratch registry, with `say` and `afplay` that only write down that they ran. */
async function runHook(payload: Record<string, unknown>, options: { daemon: boolean }): Promise<{ received: any[]; stdout: string; sounds: string }> {
  const root = mkdtempSync("/tmp/conch-session-start-hook-");
  roots.push(root);
  mkdirSync(join(root, "claude", "sessions"), { recursive: true });
  writeFileSync(join(root, "claude", "sessions", "4242.json"), JSON.stringify({
    pid: 4242, sessionId: SESSION, kind: "interactive", entrypoint: "cli", cwd: "/work", name: "alpha", startedAt: 1,
  }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const sounds = join(root, "sounds.log");
  for (const tool of ["say", "afplay"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${sounds}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const socketPath = join(root, "d.sock");
  const received: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      received.push(JSON.parse(buffer.slice(0, newline)));
      socket.end();
    });
  });
  if (options.daemon) {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CONCH_") || key.startsWith("CLAUDE_")) continue;
    env[key] = value;
  }
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "hook"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...env,
      PATH: `${bin}:${env.PATH ?? ""}`,
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      CONCH_CONFIG_DIR: join(root, "config"),
      CONCH_SOCKET: socketPath,
      CONCH_TELEMETRY_FILE: join(root, "telemetry.jsonl"),
      CLAUDE_CODE_ENTRYPOINT: "cli",
    },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 8_000);
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timer);
  if (options.daemon) await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, stdout, sounds: existsSync(sounds) ? readFileSync(sounds, "utf8") : "" };
}

describe("the SessionStart hook, run", () => {
  test("reaches the daemon as a session-start with the new process's pid, and prints nothing into the session", async () => {
    const { received, stdout, sounds } = await runHook({
      hook_event_name: "SessionStart", session_id: SESSION, cwd: "/work", transcript_path: "/work/t.jsonl", source: "resume",
    }, { daemon: true });
    // Claude Code adds a SessionStart hook's stdout to the session's context.
    expect(stdout).toBe("");
    expect(sounds).toBe("");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "session-start", sessionId: SESSION, label: "alpha", cwd: "/work", pid: 4242, announce: "", startSource: "resume",
    });
    expect(validateSocketTurnEvent(received[0]).ok).toBe(true);
  }, 30_000);

  test("with no daemon it neither rings nor speaks, where a Notification does", async () => {
    const started = await runHook({ hook_event_name: "SessionStart", session_id: SESSION, cwd: "/work", source: "startup" }, { daemon: false });
    expect(started.sounds).toBe("");
    expect(started.stdout).toBe("");
    // The control: the same harness hears a hook that does fall back to speaking.
    const needs = await runHook({
      hook_event_name: "Notification", session_id: SESSION, cwd: "/work", notification_type: "permission_prompt", message: "approve?",
    }, { daemon: false });
    expect(needs.sounds).toContain("say");
  }, 30_000);
});

describe("the socket", () => {
  const start = (over: Record<string, unknown> = {}) =>
    ({ type: "session-start", sessionId: SESSION, label: "alpha", announce: "", pid: 4242, eventAt: 1, ...over });

  test("takes a session-start, with a source it knows or none", () => {
    expect(validateSocketTurnEvent(start()).ok).toBe(true);
    expect(validateSocketTurnEvent(start({ startSource: "compact" })).ok).toBe(true);
    expect(validateSocketTurnEvent(start({ startSource: "teleport" })).ok).toBe(false);
    expect(validateSocketTurnEvent({ ...start({ startSource: "resume" }), type: "working" }).ok).toBe(false);
  });

  test("a dismissed session still says where it lives now, and nothing else of its gets through", () => {
    const enqueued: TurnEvent[] = [];
    const callbacks: SocketTurnEventCallbacks = {
      busy: () => false,
      stopSpacebar: () => {},
      setSessionPaused: () => {},
      isDismissedSession: (sessionId) => sessionId === SESSION,
      enrichAudioCommand: (event) => event,
      enqueueInstant: () => {},
      enqueue: (event) => void enqueued.push(event),
    };
    dispatchSocketTurnEvent(start() as TurnEvent, callbacks);
    dispatchSocketTurnEvent({ type: "working", sessionId: SESSION, label: "alpha", announce: "", eventAt: 2 }, callbacks);
    dispatchSocketTurnEvent({ type: "turn-end", sessionId: SESSION, label: "alpha", announce: "alpha: done.", eventAt: 3 }, callbacks);
    expect(enqueued.map((event) => event.type)).toEqual(["session-start"]);
  });
});

describe("the daemon", () => {
  const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  test("hands a session start to the loop at once: not queued behind speech, not waiting on the voice engine", () => {
    expect(daemon).toContain('if (event.type === "inject" || event.type === "interrupt" || event.type === "session-start") {');
    expect(daemon).toContain('if (event.type !== "inject" && event.type !== "interrupt" && event.type !== "session-start") await ttsStartup;');
  });
});

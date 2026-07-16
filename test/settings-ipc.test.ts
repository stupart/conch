import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { SETTING_DESCRIPTORS, sendControlMessage, validateControlMessage } from "../src/settings.ts";

interface Fixture {
  root: string;
  configDir: string;
  socketPath: string;
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface FakeDaemon {
  requests: unknown[];
  close(): Promise<void>;
}

const roots: string[] = [];

type SnapshotEntry = { value: number | boolean; source: "env" | "file" | "default"; diagnostic?: string };

function configSnapshot(overrides: Partial<Record<string, SnapshotEntry>> = {}): Record<string, SnapshotEntry> {
  return Object.fromEntries(SETTING_DESCRIPTORS.map((descriptor) => [
    descriptor.key,
    overrides[descriptor.key] ?? { value: descriptor.default, source: "default" },
  ]));
}

function fixture(settings?: Record<string, unknown>): Fixture {
  const root = mkdtempSync("/tmp/conch-ipc-test-");
  roots.push(root);
  const configDir = join(root, "config");
  if (settings) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  }
  return { root, configDir, socketPath: join(root, "daemon.sock") };
}

function cleanEnv(f: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith("CONCH_") || key === "CLAUDE_CONFIG_DIR") continue;
    env[key] = value;
  }
  return {
    ...env,
    HOME: f.root,
    CLAUDE_CONFIG_DIR: join(f.root, "claude"),
    CONCH_CONFIG_DIR: f.configDir,
    CONCH_SOCKET: f.socketPath,
    NO_COLOR: "1",
    ...extra,
  };
}

async function runCli(f: Fixture, args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    cwd: join(import.meta.dir, ".."),
    env: cleanEnv(f, extraEnv),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), 5_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

async function fakeDaemon(socketPath: string, reply: string): Promise<FakeDaemon> {
  const requests: unknown[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let replied = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0 || replied) return;
      replied = true;
      requests.push(JSON.parse(buffer.slice(0, newline)));

      // Deliberately fragment the response and keep our writable half open.
      // The control client must resolve on a complete newline frame, not EOF.
      const middle = Math.max(1, Math.floor(reply.length / 2));
      socket.write(reply.slice(0, middle));
      setTimeout(() => socket.write(`${reply.slice(middle)}\n`), 5);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("settings control IPC", () => {
  test("the client parses a fragmented newline reply without waiting for daemon EOF", async () => {
    const f = fixture();
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-snapshot",
      snapshot: configSnapshot(),
    }));
    try {
      const result = await sendControlMessage(f.socketPath, { kind: "get-config" }, 1_000);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.diagnostic);
      expect(result.response.kind).toBe("config-snapshot");
      expect(daemon.requests).toEqual([{ kind: "get-config" }]);
    } finally {
      await daemon.close();
    }
  });

  test("validates wire JSON as unknown and keeps TurnEvents out of the control union", () => {
    expect(validateControlMessage({ kind: "get-config" })).toEqual({
      ok: true,
      value: { kind: "get-config" },
    });
    expect(validateControlMessage({ kind: "set-config", key: "say-rate", value: 0 })).toEqual({
      ok: true,
      value: { kind: "set-config", key: "say-rate", value: 0 },
    });
    expect(validateControlMessage({ type: "wake", sessionId: "", label: "", announce: "" }).ok).toBe(false);
    expect(validateControlMessage(JSON.parse('{"kind":"set-config","key":"__proto__","value":1}')).ok).toBe(false);
    expect(validateControlMessage({ kind: "unset-config", key: "constructor" }).ok).toBe(false);
    expect(validateControlMessage(null).ok).toBe(false);
  });

  test("an applied ack produces the saved + applied-live status", async () => {
    const f = fixture();
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-ack",
      key: "end-silence",
      action: "set",
      status: "applied",
      effective: 5.25,
      source: "file",
    }));
    try {
      const result = await runCli(f, ["set", "end-silence", "5.25"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("saved");
      expect(result.stdout).toContain("applied-live");
      expect(result.stdout).toContain("5.25");
    } finally {
      await daemon.close();
    }
  });

  test("a masked ack names the env source instead of claiming a live apply", async () => {
    const f = fixture();
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-ack",
      key: "end-silence",
      action: "set",
      status: "masked",
      effective: 7,
      source: "env",
      env: "CONCH_END_SILENCE_SECS",
    }));
    try {
      const result = await runCli(f, ["set", "end-silence", "4"], {
        CONCH_END_SILENCE_SECS: "7",
      });
      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual([{ kind: "set-config", key: "end-silence", value: 4 }]);
      expect(result.stdout).toContain("end-silence = 4 — saved");
      expect(result.stdout).toContain("masked-by-env");
      expect(result.stdout).toContain("CONCH_END_SILENCE_SECS");
      expect(result.stdout).toContain("effective 7");
      expect(result.stdout).not.toContain("applied-live");
    } finally {
      await daemon.close();
    }
  });

  test("a hook ack reports hook-next and the per-hook env caveat", async () => {
    const f = fixture();
    const diagnostic = "next hook — hook env (CONCH_SPEAK_SENTENCES) may override";
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-ack",
      key: "announce-sentences",
      action: "set",
      status: "hook-next",
      effective: 4,
      source: "file",
      diagnostic,
    }));
    try {
      const result = await runCli(f, ["set", "announce-sentences", "4"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("saved");
      expect(result.stdout).toContain("hook-next");
      expect(result.stdout).toContain("CONCH_SPEAK_SENTENCES");
    } finally {
      await daemon.close();
    }
  });

  test("get displays the daemon snapshot rather than a conflicting local file", async () => {
    const f = fixture({ "end-silence": 4.75 });
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-snapshot",
      snapshot: configSnapshot({
        "end-silence": { value: 6.25, source: "env" },
      }),
    }));
    try {
      const result = await runCli(f, ["get", "end-silence"]);
      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual([{ kind: "get-config" }]);
      expect(result.stdout).toContain("6.25");
      expect(result.stdout).toContain("env");
      expect(result.stdout).not.toContain("4.75");
    } finally {
      await daemon.close();
    }
  });

  test("get prints hook-only provenance diagnostics from the daemon snapshot", async () => {
    const f = fixture({ "announce-sentences": 3 });
    const diagnostic = "next hook — hook env (CONCH_SPEAK_SENTENCES) may override";
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-snapshot",
      snapshot: configSnapshot({
        "announce-sentences": { value: 3, source: "file", diagnostic },
      }),
    }));
    try {
      const result = await runCli(f, ["get", "announce-sentences"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("announce-sentences");
      expect(result.stdout).toContain("next hook");
      expect(result.stdout).toContain("CONCH_SPEAK_SENTENCES");
    } finally {
      await daemon.close();
    }
  });

  test("settings also uses the running daemon's complete snapshot", async () => {
    const f = fixture({ "read-full": false });
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-snapshot",
      snapshot: configSnapshot({
        "read-full": { value: true, source: "env" },
      }),
    }));
    try {
      const result = await runCli(f, ["settings"]);
      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual([{ kind: "get-config" }]);
      expect(result.stdout).toContain("read-full");
      expect(result.stdout).toContain("true");
      expect(result.stdout).toContain("CONCH_READ_FULL");
      expect(result.stdout).not.toContain("false");
    } finally {
      await daemon.close();
    }
  });

  test("set sends a native newline-framed control value and handles an unknown ack", async () => {
    const f = fixture();
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({ kind: "unexpected-ack" }));
    try {
      const result = await runCli(f, ["set", "end-silence", "5.25"]);
      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual([{ kind: "set-config", key: "end-silence", value: 5.25 }]);
      expect(result.stdout).toContain("saved");
      expect(result.stdout).toContain("ack-unknown");
    } finally {
      await daemon.close();
    }
  });

  test("a hook setting remains hook-next even when the daemon ack is unknown", async () => {
    const f = fixture();
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({ kind: "unexpected-ack" }));
    try {
      const result = await runCli(f, ["set", "announce-max-chars", "420"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("saved");
      expect(result.stdout).toContain("hook-next");
      expect(result.stdout).toContain("ack-unknown");
    } finally {
      await daemon.close();
    }
  });

  test("unset uses its own control kind and applies the resolved fallback live", async () => {
    const f = fixture({ "read-full": false });
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({
      kind: "config-ack",
      key: "read-full",
      action: "unset",
      status: "applied",
      effective: true,
      source: "default",
    }));
    try {
      const result = await runCli(f, ["unset", "read-full"]);
      expect(result.exitCode).toBe(0);
      expect(daemon.requests).toEqual([{ kind: "unset-config", key: "read-full" }]);
      expect(result.stdout).toContain("applied-live");
      expect(result.stdout).toContain("default");
    } finally {
      await daemon.close();
    }
  });

  test("get asks the daemon and does not use a stale local value after an invalid reply", async () => {
    const f = fixture({ "end-silence": 99 });
    const daemon = await fakeDaemon(f.socketPath, JSON.stringify({ kind: "unexpected-ack" }));
    try {
      const result = await runCli(f, ["get", "end-silence"]);
      expect(daemon.requests).toEqual([{ kind: "get-config" }]);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("99");
      expect(`${result.stdout}\n${result.stderr}`).toContain("ack-unknown");
    } finally {
      await daemon.close();
    }
  });
});

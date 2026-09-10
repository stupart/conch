import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRuntimeControlMessage } from "../src/control-server.ts";
import { startTerminalSession, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { validateControlMessage, validateControlResponse } from "../src/settings.ts";

const teleport = {
  kind: "session-start" as const,
  backend: "claude" as const,
  teleportSessionId: "session_01AbC-123",
  cwd: "/tmp/project",
};

describe("teleport request validation", () => {
  test("accepts and preserves a trimmed cloud id and folder", () => {
    expect(validateControlMessage({ ...teleport, teleportSessionId: ` ${teleport.teleportSessionId} ` }))
      .toEqual({ ok: true, value: teleport });
  });

  test("refuses resume and teleport together", () => {
    expect(validateControlMessage({ ...teleport, resumeSessionId: "local-123" }))
      .toEqual({ ok: false, err: "resumeSessionId and teleportSessionId are mutually exclusive" });
  });

  test("refuses Codex with a plain error", () => {
    expect(validateControlMessage({ ...teleport, backend: "codex" }))
      .toEqual({ ok: false, err: "Codex has no teleport" });
  });

  test("refuses a flag-shaped id", () => {
    expect(validateControlMessage({ ...teleport, teleportSessionId: "--help" }).ok).toBe(false);
  });

  test.each(["bad/id", "two words", "abc'123", "", "a\u0000b", "x".repeat(257), "__proto__", "constructor", 42])(
    "refuses malformed id %j", (teleportSessionId) => {
      expect(validateControlMessage({ ...teleport, teleportSessionId }).ok).toBe(false);
    },
  );

  test("requires an absolute working folder", () => {
    expect(validateControlMessage({ ...teleport, cwd: undefined }))
      .toEqual({ ok: false, err: "cwd is required for teleport" });
    for (const cwd of ["", "  ", "relative", "/tmp/a\u0000b"]) {
      expect(validateControlMessage({ ...teleport, cwd }).ok).toBe(false);
    }
  });
});

describe("teleport Terminal launch", () => {
  test("builds the exact teleport command, quoting an apostrophe in the folder", () => {
    expect(terminalSessionCommand(teleport))
      .toBe("cd -- '/tmp/project' && exec claude --teleport 'session_01AbC-123'");
    expect(terminalSessionCommand({ ...teleport, cwd: "/tmp/Tyler's project" }))
      .toBe("cd -- '/tmp/Tyler'\\''s project' && exec claude --teleport 'session_01AbC-123'");
  });

  test("direct launches also reject unsupported, conflicting or missing inputs", () => {
    expect(() => terminalSessionCommand({ ...teleport, backend: "codex" })).toThrow("Codex has no teleport");
    expect(() => terminalSessionCommand({ ...teleport, resumeSessionId: "local-123" })).toThrow("mutually exclusive");
    expect(() => terminalSessionCommand({ ...teleport, teleportSessionId: "--help" })).toThrow("teleport session id");
    expect(() => terminalSessionCommand({ ...teleport, cwd: undefined })).toThrow("cwd is required");
  });

  test("requires a real directory before opening Terminal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conch-teleport-"));
    const file = join(directory, "a-file");
    writeFileSync(file, "not a directory");
    const launches: string[][] = [];
    const dependencies = {
      which: () => "/usr/local/bin/claude",
      spawn: (argv: string[]) => {
        launches.push(argv);
        return { exited: Promise.resolve(0), cancel() {} };
      },
    };
    try {
      for (const cwd of [file, join(directory, "missing")]) {
        await expect(startTerminalSession({ ...teleport, cwd }, dependencies))
          .rejects.toThrow("session directory does not exist");
      }
      expect(launches).toEqual([]);
      await startTerminalSession({ ...teleport, cwd: directory }, dependencies);
      expect(launches).toHaveLength(1);
      expect(launches[0]?.[0]).toBe("osascript");
      expect(launches[0]?.at(-1)).toBe(terminalSessionCommand({ ...teleport, cwd: directory }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("teleport launch acknowledgement", () => {
  const operations = {
    listResumable: () => ({ sessions: [], complete: true }),
    close: () => {},
    report: () => {},
  };

  test("preserves the request and replies teleported only after the launch resolves", async () => {
    let release!: () => void;
    let received: unknown;
    const pending = dispatchRuntimeControlMessage(teleport, {
      ...operations,
      start: (message) => {
        received = message;
        return new Promise<void>((resolve) => { release = resolve; });
      },
    });
    let settled = false;
    void pending.then(() => { settled = true; });
    await Bun.sleep(0);
    expect(received).toEqual(teleport);
    expect(settled).toBe(false);
    release();
    const reply = { kind: "session-started", backend: "claude", resumed: false, teleported: true } as const;
    expect(await pending).toEqual({ handled: true, response: reply });
  });

  test("response validation preserves the teleport acknowledgement", () => {
    const reply = { kind: "session-started", backend: "claude", resumed: false, teleported: true } as const;
    expect(validateControlResponse(reply)).toEqual({ ok: true, value: reply });
  });

  test("resume and fresh launches do not carry teleported", async () => {
    for (const resumeSessionId of ["local-123", undefined]) {
      const result = await dispatchRuntimeControlMessage({
        kind: "session-start", backend: "claude", cwd: teleport.cwd, resumeSessionId,
      }, { ...operations, start: () => {} });
      const reply = { kind: "session-started", backend: "claude", resumed: Boolean(resumeSessionId) } as const;
      expect(result).toEqual({ handled: true, response: reply });
      expect(validateControlResponse(reply)).toEqual({ ok: true, value: reply });
    }
  });

  test("a launch failure returns an error, never a teleport acknowledgement", async () => {
    expect(await dispatchRuntimeControlMessage(teleport, {
      ...operations,
      start: () => { throw new Error("Terminal returned 1"); },
    })).toEqual({ handled: true, response: { kind: "session-error", error: "Terminal returned 1" } });
  });
});

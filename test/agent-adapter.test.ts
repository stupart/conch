import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adapterFor,
  agentAdapters,
  claudeAdapter,
  codexAdapter,
  registerAgentAdapter,
  transcriptFormatFor,
  type AgentAdapter,
  type SessionBackend,
} from "../src/agent-adapter.ts";
import { readAgentCapabilities } from "../src/agent-capabilities.ts";
import type { Config } from "../src/config.ts";
import { renameProviderSession, type ProviderRenameInjector } from "../src/provider-rename.ts";
import { readResumableSessionsResult, type ResumableSession } from "../src/resumable.ts";
import { teleportRequestError, terminalSessionCommand } from "../src/session-lifecycle.ts";
import { findTranscript, subagentSessions } from "../src/sessions.ts";
import { shouldReportMissingCodexPid } from "../src/daemon.ts";

const read = (path: string): string => readFileSync(join(import.meta.dir, "..", path), "utf8");

describe("the agent table", () => {
  test("looks a row up by backend, reads an absent backend as Claude, refuses an unknown one", () => {
    expect(adapterFor("claude")).toBe(claudeAdapter);
    expect(adapterFor("codex")).toBe(codexAdapter);
    // Legacy Claude registry projections carry no `backend` at all.
    expect(adapterFor(undefined)).toBe(claudeAdapter);
    expect(() => adapterFor("gemini" as SessionBackend)).toThrow('no agent adapter for backend "gemini"');
    expect(agentAdapters().map((adapter) => adapter.backend)).toEqual(["claude", "codex"]);
  });

  test("a transcript path picks its reader: a Codex rollout, everything else Claude's JSONL", () => {
    expect(transcriptFormatFor("/h/.codex/sessions/2026/09/11/rollout-2026-09-11T10-00-00-abc.jsonl")).toBe("codex");
    expect(transcriptFormatFor("/h/.claude/projects/-work/0f1e2d3c.jsonl")).toBe("claude");
    expect(transcriptFormatFor("/h/.claude/projects/-work/0f1e2d3c/subagents/agent-a1.jsonl")).toBe("claude");
  });

  test("where an agent has no implementation, its row returns what the branch returned", () => {
    expect(codexAdapter.renameCommand("Beta")).toBeNull(); // provider-rename.ts: `unsupported`
    expect(codexAdapter.teleportArgs).toBeNull(); // session-lifecycle.ts: "Codex has no teleport"
    expect(claudeAdapter.trustFolderArgs("/work")).toBe(""); // only Codex takes trust on its command line
    expect(codexAdapter.subagentSessions({ sessionId: "t1" }, "/r/rollout-x.jsonl")).toEqual([]);
    expect([claudeAdapter.rowsMayLackPid, codexAdapter.rowsMayLackPid]).toEqual([false, true]);
    expect([claudeAdapter.mcpEnabledDefault, codexAdapter.mcpEnabledDefault]).toEqual([null, true]);
  });
});

describe("a third backend is one row", () => {
  const backend = "fable" as SessionBackend;
  const fable: AgentAdapter = {
    backend,
    displayName: "Fable",
    executable: "fable",
    resumeArgs: (id) => ` --continue ${id}`,
    teleportArgs: null,
    bypassPermissionsFlag: "--trust-me",
    trustFolderArgs: (cwd) => ` --trust ${cwd}`,
    folderTrusted: () => null,
    renameCommand: (label) => `/title ${label}`,
    // A Claude Code fork writes Claude's JSONL under its own name.
    transcriptFormat: "claude",
    ownsTranscriptPath: (path) => path.endsWith(".fable.jsonl"),
    findTranscript: (sessionId) => sessionId === "f-1" ? "/fable/f-1.fable.jsonl" : undefined,
    subagentSessions: () => [],
    rowsMayLackPid: true,
    resumableCandidates: () => ({
      candidates: [{ backend, sessionId: "f-1", label: "Fable thread", cwd: "/work/f", updatedAt: 5 }],
      complete: true,
    }),
    resolveResumable: (candidate) => ({ session: candidate as ResumableSession, complete: true }),
    pluginManifestDir: ".fable-plugin",
    mcpEnabledDefault: false,
    readCapabilities: (options, collector) => {
      collector.diagnostic({ severity: "info", code: "fable-read", message: `read ${options.cwd}` });
      return {
        projectTrust: { projectPath: options.cwd, trusted: true, basis: "none", detail: "fable trusts everyone" },
      };
    },
  };

  test("registered, it drives the label, resume, transcript, picker and capability paths", async () => {
    const unregister = registerAgentAdapter(fable);
    try {
      expect(adapterFor(backend)).toBe(fable);
      expect(agentAdapters().map((adapter) => adapter.backend)).toEqual(["claude", "codex", backend]);

      // Resume command, permission bypass and per-launch trust, all spelled by the row.
      expect(terminalSessionCommand({
        backend, cwd: "/work/f", resumeSessionId: "s 1", bypassPermissions: true, trustFolder: true,
      })).toBe("cd -- '/work/f' && exec fable --trust-me --trust /work/f --continue 's 1'");
      expect(teleportRequestError({ backend, cwd: "/work/f", teleportSessionId: "c1" }))
        .toBe("Fable has no teleport");

      // Label: the row's own rename command is what gets typed.
      const typed: string[] = [];
      const inject: ProviderRenameInjector = async (_cfg, _pid, text) => {
        typed.push(text);
        return { via: "tmux" };
      };
      await expect(renameProviderSession({} as Config, { backend, pid: 9 }, "Sprint", inject))
        .resolves.toEqual({ kind: "delivered", via: "tmux" });
      expect(typed).toEqual(["/title Sprint"]);

      // Capabilities: the row's half runs and lands in the same read shape.
      const capabilities = readAgentCapabilities({ backend, cwd: "/work/f", configDir: "/nonexistent/conch" });
      expect(capabilities.context).toEqual({
        backend,
        cwd: "/work/f",
        projectTrust: { projectPath: "/work/f", trusted: true, basis: "none", detail: "fable trusts everyone" },
      });
      expect(capabilities.diagnostics).toEqual([{ severity: "info", code: "fable-read", message: "read /work/f" }]);
      expect(capabilities.entities).toEqual([]);

      // Transcripts and rows.
      expect(transcriptFormatFor("/fable/f-1.fable.jsonl")).toBe("claude");
      expect(findTranscript("/nonexistent/claude", "f-1", { configDir: "/nonexistent/conch" }))
        .toBe("/fable/f-1.fable.jsonl");
      expect(subagentSessions({ sessionId: "f-1", backend }, "/fable/f-1.fable.jsonl")).toEqual([]);
      expect(shouldReportMissingCodexPid({ sessionId: "f-1", backend }, new Set())).toBe(true);

      // The resume picker lists the row's history beside the others'.
      expect(readResumableSessionsResult({ configDir: "/nonexistent/conch" })).toEqual({
        sessions: [{ backend, sessionId: "f-1", label: "Fable thread", cwd: "/work/f", updatedAt: 5 }],
        complete: true,
      });
    } finally {
      unregister();
    }
    expect(() => adapterFor(backend)).toThrow();
  });

  test("one source that could not be read leaves the whole picker incomplete", () => {
    const unregister = registerAgentAdapter({
      ...fable,
      resumableCandidates: () => ({ candidates: [], complete: false }),
    });
    try {
      expect(readResumableSessionsResult({ configDir: "/nonexistent/conch" }))
        .toEqual({ sessions: [], complete: false });
    } finally {
      unregister();
    }
  });
});

describe("the branch inventory", () => {
  // Presence first: the sites that used to branch now ask the table.
  test("the generic modules ask the table", () => {
    const daemon = read("src/daemon.ts");
    expect(daemon).toContain('import { adapterFor, transcriptFormatFor } from "./agent-adapter.ts";');
    expect(daemon).toContain("adapterFor(session.backend).rowsMayLackPid && !session.pid");
    expect(daemon).toContain("readConversationTail(path, sessionId, transcriptFormatFor(path), { window: session })");
    expect(daemon).toContain("readSessionContextUsage(path, transcriptFormatFor(path))");
    expect(daemon).toContain('folderTrusted: adapterFor("claude").folderTrusted');
    expect(read("src/session-lifecycle.ts")).toContain("const adapter = adapterFor(request.backend);");
    expect(read("src/provider-rename.ts")).toContain("adapterFor(target.backend).renameCommand(label)");
    expect(read("src/sessions.ts")).toContain("adapterFor(parent.backend).subagentSessions(parent, transcriptPath)");
    expect(read("src/resumable.ts")).toContain("adapterFor(candidate.backend).resolveResumable(candidate)");
    expect(read("src/agent-capabilities.ts")).toContain("adapterFor(options.backend)\n    .readCapabilities(");
  });

  // Then the count: what remains is the two wire validators (agent-capabilities.ts)
  // and the registry projection that R owns (sessions.ts `toInfo`).
  test("no backend branch has crept back into a generic module", () => {
    const branch = /backend (===|!==) "(claude|codex)"|isCodexTranscriptPath/;
    const residue: Record<string, number> = {
      "src/daemon.ts": 0,
      "src/session-lifecycle.ts": 0,
      "src/provider-rename.ts": 0,
      "src/resumable.ts": 0,
      "src/sessions.ts": 1,
      "src/agent-capabilities.ts": 2,
    };
    for (const [path, expected] of Object.entries(residue)) {
      const sites = read(path).split("\n").filter((line) => branch.test(line)).length;
      expect([path, sites]).toEqual([path, expected]);
    }
  });
});

import { describe, expect, test } from "bun:test";
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

  test("a pid-less Codex row is reported only when it cannot say why it has none", () => {
    const reported = new Set<string>();
    // Closed (no lock holder) and app-server-hosted rows carry their reason.
    expect(shouldReportMissingCodexPid(
      { sessionId: "closed", backend: "codex", pid: 0, noTerminal: "closed: no Codex process has this thread open" },
      reported,
    )).toBe(false);
    expect(shouldReportMissingCodexPid(
      {
        sessionId: "desktop",
        backend: "codex",
        pid: 0,
        noTerminal: "hosted by codex app-server (pid 74676), which has no terminal to type into",
      },
      reported,
    )).toBe(false);
    // A held lock whose holder could not be named is the genuine miss.
    expect(shouldReportMissingCodexPid({ sessionId: "unknown", backend: "codex", pid: 0 }, reported)).toBe(true);
  });
});

describe("a third backend is one row", () => {
  const backend = "fable" as SessionBackend;
  const fable: AgentAdapter = {
    backend,
    displayName: "Fable",
    executable: "fable",
    backgroundFlags: "",
    terminalFlags: "",
    conversationServer: null,
    exitKeystrokes: 1,
    questionKeys: null,
    inputBoxText: null,
    exitBlocker: null,
    trustTypedAtLaunch: false,
    resumeArgs: (id) => ` --continue ${id}`,
    forkArgs: null,
    teleportArgs: null,
    ownInstallerRoots: () => [],
    bypassPermissionsFlag: "--trust-me",
    startOptions: [],
    trustFolderArgs: (cwd) => ` --trust ${cwd}`,
    hookTrustArgs: null,
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
      expect(await subagentSessions({ sessionId: "f-1", backend }, "/fable/f-1.fable.jsonl")).toEqual([]);
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

describe("Claude Code's input box, read off its terminal", () => {
  const { claudeInputBoxText, inputBoxHoldsWords } = require("../src/agent-adapter.ts") as typeof import("../src/agent-adapter.ts");
  // Shape read from a live Terminal tab on 2.1.280 (2026-09-23).
  const screen = (box: string[]) => [
    "❯ Can turn off the netlify for this page", "· Coalescing… (26s · thinking with xhigh effort)",
    "───────────────────────────────────────── About page wireframe for the new website ─",
    ...box,
    "────────────────────────────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · esc to interrupt",
  ].join("\n");

  test("the box is the ❯ line under a rule; a sent message higher up is not", () => {
    expect(claudeInputBoxText(screen(["❯ "]))).toBe("");
    expect(claudeInputBoxText(screen(["❯ Add the real company", "  logos to the ring"]))).toBe("Add the real company logos to the ring");
    expect(claudeInputBoxText("❯ just a message\nno box here")).toBeNull();
    expect(claudeInputBoxText("⏺ a reply\n❯ a sent message\n⏺ more")).toBeNull();
  });

  test("the words are still there by their start, or by the placeholder a long paste shows", () => {
    expect(inputBoxHoldsWords("Add the real company logos to the ring", "Add the real   company logos to the ring and more")).toBe(true);
    expect(inputBoxHoldsWords("[Pasted text #1 +12 lines]", "anything long")).toBe(true);
    // A long send is pasted, so its box shows the paste: Claude Code's one-line form, and Codex's (0.159.2).
    expect(inputBoxHoldsWords("[Pasted text #1]", "anything long")).toBe(true);
    expect(inputBoxHoldsWords("[Pasted Content 3580 chars]", "anything long")).toBe(true);
    expect(inputBoxHoldsWords("", "Add the real company logos")).toBe(false);
    expect(inputBoxHoldsWords("something Tyler is typing", "Add the real company logos")).toBe(false);
  });
});

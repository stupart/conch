import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { CONCH_VERSION } from "../src/version.ts";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import { AGENT_INSTRUCTIONS } from "../src/agent-instructions.ts";
import {
  AGENT_TUNABLE_SETTINGS,
  MAX_SPEAK_CHARS,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  dispatchJsonRpcBatch,
  runMcpServer,
  MCP_HISTORY_MAX_BYTES,
  MCP_TOOLS,
  createMcpToolHandlers,
  defaultMcpDependencies,
  dispatchJsonRpc,
  parseJsonRpcLine,
  serializeJsonRpcLine,
  type JsonRpcResponse,
  type McpDependencies,
  type McpToolHandlers,
  type McpToolName,
  type PublishedState as McpPublishedState,
} from "../src/mcp.ts";
import { audioTimeoutMs } from "../src/audio-watchdog.ts";
import {
  SETTING_DESCRIPTORS,
  SETTING_KEYS,
  configSnapshotEntry,
  getSettingDescriptor,
  parseSetting,
  type ConfigSnapshot,
  type ControlMessage,
  type ControlResult,
} from "../src/settings.ts";
import {
  downgradeTurnWithLiveBackgroundWork,
  TurnEventOrder,
} from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";
import type { ReviewMark, ReviewScene } from "../src/snippet.ts";
import type { RegistrySnapshot, SessionInfo } from "../src/sessions.ts";
import { AmbiguousSessionError, findSessionByName, registrySnapshot } from "../src/sessions.ts";
import { appServerNoTerminal } from "../src/codex-threads.ts";
import { HISTORY_PAYLOAD_MAX_BYTES, type HistoryRequest, type HistoryResponse } from "../src/history.ts";
import { artifactIdentity } from "../src/deliverables.ts";
import { reviewIdentity } from "../src/records-receipts.ts";
import { MAC_APP_DOWN, type PageCaptureMessage, type PageCaptureReply, type PageCaptureSend } from "../src/page-capture.ts";
import type { PublishReply } from "../src/review-verdict.ts";

const TOOL_NAMES = [
  "conch_sessions",
  "conch_wake",
  "conch_recite",
  "conch_speak",
  "conch_mode",
  "conch_rename",
  "conch_config",
  "conch_transcript_tail",
  "review_to_front",
  "conch_history",
  "conch_item",
  "conch_working_folders",
  "conch_on_screen",
  "conch_deliverables",
  "review_remove",
  "conch_capture",
] as const satisfies readonly McpToolName[];

const DEFERRED_TOOL_NAMES = [
  "conch_prioritize",
  "conch_dismiss",
  "conch_spawn",
  "conch_close",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rpcResult(response: JsonRpcResponse | null): unknown {
  if (!response) throw new Error("expected a JSON-RPC response");
  if (response.error) throw new Error(`unexpected JSON-RPC error: ${response.error.message}`);
  return response.result;
}

function toolText(response: JsonRpcResponse | null): string {
  const result = rpcResult(response);
  if (!isRecord(result) || !Array.isArray(result.content)) {
    throw new Error("expected an MCP tool result");
  }
  const first: unknown = result.content[0];
  if (!isRecord(first) || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected one text content block");
  }
  return first.text;
}

async function callTool(
  handlers: McpToolHandlers,
  name: McpToolName,
  argumentsValue: Record<string, unknown>,
  id: string | number = 1,
): Promise<JsonRpcResponse | null> {
  return dispatchJsonRpc({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: argumentsValue },
  }, handlers);
}

function assertValidSchema(value: unknown): void {
  if (!isRecord(value)) throw new Error("schema must be an object");
  const validTypes = new Set([
    "null",
    "boolean",
    "object",
    "array",
    "number",
    "string",
    "integer",
  ]);

  if (Object.hasOwn(value, "type")) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(typeof type).toBe("string");
      expect(validTypes.has(type as string)).toBe(true);
    }
  }

  if (Object.hasOwn(value, "properties")) {
    if (!isRecord(value.properties)) throw new Error("properties must be an object");
    for (const schema of Object.values(value.properties)) assertValidSchema(schema);
  }

  if (Object.hasOwn(value, "required")) {
    if (!Array.isArray(value.required)) throw new Error("required must be an array");
    const properties = isRecord(value.properties) ? value.properties : {};
    for (const key of value.required) {
      expect(typeof key).toBe("string");
      expect(Object.hasOwn(properties, key as string)).toBe(true);
    }
  }

  if (Object.hasOwn(value, "anyOf")) {
    if (!Array.isArray(value.anyOf)) throw new Error("anyOf must be an array");
    expect(value.anyOf.length).toBeGreaterThan(0);
    for (const schema of value.anyOf) assertValidSchema(schema);
  }

  if (Object.hasOwn(value, "enum")) {
    if (!Array.isArray(value.enum)) throw new Error("enum must be an array");
    expect(value.enum.length).toBeGreaterThan(0);
  }
}

interface FakeCalls {
  sessionsFiles: string[];
  registries: string[];
  sessionLookups: Array<{ claudeDir: string; query: string }>;
  transcripts: Array<{ claudeDir: string; sessionId: string }>;
  labels: Array<{ sessionId: string | null; cwd: string | undefined }>;
  renames: Array<{ sessionId: string; oldLabel: string; newLabel: string }>;
  providerRenames: Array<{ sessionId: string; label: string }>;
  workingFolders: Array<{ sessionId: string; folders: readonly string[] }>;
  daemon: Array<{ socketPath: string; event: TurnEvent }>;
  control: Array<{ socketPath: string; message: ControlMessage | HistoryRequest }>;
  marks: string[];
  assistantReads: string[];
  sentenceSplits: string[];
}

interface FakeOptions {
  sessionsFile?: string | null;
  registry?: RegistrySnapshot | null;
  session?: SessionInfo | null;
  transcriptPath?: string;
  assistantText?: string;
  daemonAccepts?: boolean;
  controlResult?: ControlResult;
  renameAckLabel?: string;
  /** This server's parent. Defaults to this test process's real parent, which no fake row carries: an unverified caller. */
  parentPid?: number;
}

function defaultConfigSnapshot(): ConfigSnapshot {
  const snapshot = Object.create(null) as ConfigSnapshot;
  for (const descriptor of SETTING_DESCRIPTORS) {
    snapshot[descriptor.key] = configSnapshotEntry(descriptor, {
      value: descriptor.default,
      source: "default",
    });
  }
  return snapshot;
}

function fakeHarness(options: FakeOptions = {}): {
  calls: FakeCalls;
  dependencies: McpDependencies;
  session: SessionInfo;
} {
  const session: SessionInfo = options.session === undefined
    ? {
      sessionId: "session-123",
      name: "Build",
      cwd: "/work/build",
      pid: 4321,
      status: "idle",
    }
    : options.session ?? {
      sessionId: "unused",
    };
  const registry = options.registry === undefined
    ? {
      infos: [session],
      liveIds: new Set([session.sessionId]),
      complete: true,
    }
    : options.registry;
  const calls: FakeCalls = {
    sessionsFiles: [],
    registries: [],
    sessionLookups: [],
    transcripts: [],
    labels: [],
    renames: [],
    providerRenames: [],
    workingFolders: [],
    daemon: [],
    control: [],
    marks: [],
    assistantReads: [],
    sentenceSplits: [],
  };

  const dependencies: McpDependencies = {
    async readSessionsFile(path) {
      calls.sessionsFiles.push(path);
      return options.sessionsFile ?? null;
    },
    async registrySnapshot(claudeDir) {
      calls.registries.push(claudeDir);
      return registry;
    },
    async findSessionByName(claudeDir, query) {
      calls.sessionLookups.push({ claudeDir, query });
      return options.session === null ? null : session;
    },
    findTranscript(claudeDir, sessionId) {
      calls.transcripts.push({ claudeDir, sessionId });
      return options.transcriptPath ?? "/virtual/session-123.jsonl";
    },
    sessionLabel(found, cwd) {
      calls.labels.push({ sessionId: found?.sessionId ?? null, cwd });
      return "Build label";
    },
    renameSessionLabel(sessionId, oldLabel, newLabel) {
      calls.renames.push({ sessionId, oldLabel, newLabel });
      return { label: newLabel, voiceMigrated: true };
    },
    async renameProviderSession(found, label) {
      calls.providerRenames.push({ sessionId: found.sessionId, label });
      return { kind: "delivered", via: "tmux" };
    },
    setWorkingFolders(sessionId, folders) {
      calls.workingFolders.push({ sessionId, folders });
    },
    async sendToDaemon(socketPath, event) {
      calls.daemon.push({ socketPath, event });
      return options.daemonAccepts ?? true;
    },
    async sendControlMessage(socketPath, message) {
      calls.control.push({ socketPath, message });
      if (options.controlResult) return options.controlResult;
      if (message.kind === "history-page" || message.kind === "history-item") {
        return { ok: true, response: { kind: "history-off", error: "history is off" } };
      }
      if (message.kind === "session-command") {
        return {
          ok: true,
          response: {
            kind: "session-ack",
            sessionId: message.sessionId,
            command: message.command,
            ...(message.command === "rename"
              ? { label: options.renameAckLabel ?? message.label }
              : {}),
            changed: message.command === "rename"
              && (options.renameAckLabel ?? message.label) !== "Build label",
          },
        };
      }
      if (message.kind === "get-config") {
        return {
          ok: true,
          response: {
            kind: "config-snapshot",
            snapshot: defaultConfigSnapshot(),
          },
        };
      }
      return {
        ok: true,
        response: {
          kind: "config-ack",
          key: message.key,
          action: message.kind === "set-config" ? "set" : "unset",
          status: "applied",
          effective: message.kind === "set-config" ? message.value : false,
          source: "file",
        },
      };
    },
    getSettingDescriptor,
    parseSetting,
    async transcriptMark(transcriptPath) {
      calls.marks.push(transcriptPath);
      return 7;
    },
    async lastAssistantText(transcriptPath) {
      calls.assistantReads.push(transcriptPath);
      return options.assistantText ?? "First. Second! Third? Fourth.";
    },
    splitSentences(text) {
      calls.sentenceSplits.push(text);
      return ["First.", "Second!", "Third?", "Fourth."];
    },
    now: () => 1_234_567,
    parentPid: () => options.parentPid ?? process.ppid,
  };

  return { calls, dependencies, session };
}

function recordingHandlers(
  calls: Array<{ name: McpToolName; argumentsValue: unknown }>,
): McpToolHandlers {
  const handler = (name: McpToolName) => async (argumentsValue: unknown) => {
    calls.push({ name, argumentsValue });
    return { routedTo: name, argumentsValue };
  };
  return {
    conch_sessions: handler("conch_sessions"),
    conch_wake: handler("conch_wake"),
    conch_recite: handler("conch_recite"),
    conch_speak: handler("conch_speak"),
    conch_mode: handler("conch_mode"),
    conch_rename: handler("conch_rename"),
    conch_config: handler("conch_config"),
    conch_transcript_tail: handler("conch_transcript_tail"),
    review_to_front: handler("review_to_front"),
    conch_history: handler("conch_history"),
    conch_item: handler("conch_item"),
    conch_working_folders: handler("conch_working_folders"),
    conch_on_screen: handler("conch_on_screen"),
    conch_deliverables: handler("conch_deliverables"),
    review_remove: handler("review_remove"),
    conch_capture: handler("conch_capture"),
  };
}

describe("MCP JSON-RPC framing", () => {
  test("a parsed and serialized request round-trips as one newline-free frame", () => {
    const request = {
      jsonrpc: "2.0",
      id: "request-1",
      method: "tools/call",
      params: {
        name: "conch_speak",
        arguments: { text: "First line.\nSecond line.", voice: "af_heart" },
      },
    };

    const parsed = parseJsonRpcLine(JSON.stringify(request));
    const serialized = serializeJsonRpcLine(parsed);

    expect(JSON.parse(serialized)).toEqual(request);
    expect(serialized.includes("\n")).toBe(false);
  });
});

describe("recorded history MCP tools", () => {
  const config = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };
  const page: HistoryResponse = {
    kind: "history-page", session: "recorded-session", items: [], previousCursor: "older", changeCursor: "watermark", epoch: "epoch-1",
    coverage: { sources: 1, statuses: { complete: 1 }, replayRequired: false, malformedLines: 0, indexedBytes: 20,
      observedBytes: 20, branch: "all", order: "timestamp-source" },
  };

  test("requires explicit IDs and proxies each page field without a live lookup or transcript read", async () => {
    const h = fakeHarness({ parentPid: 0, controlResult: { ok: true, response: page } });
    const handlers = createMcpToolHandlers(config, h.dependencies);
    const args = { session: "closed-record", branch: "branch-1", before: "opaque-cursor", limit: 23 };
    expect(JSON.parse(toolText(await callTool(handlers, "conch_history", args)))).toEqual(page);
    expect(h.calls.control).toEqual([{ socketPath: config.socketPath, message: { kind: "history-page", ...args } }]);
    expect(h.calls.registries).toEqual([]);
    expect(h.calls.sessionLookups).toEqual([]);
    expect(h.calls.transcripts).toEqual([]);
    expect(h.calls.assistantReads).toEqual([]);
    expect(h.calls.daemon).toEqual([]);
  });

  test("self uses only the verified caller and passes its exact window ID to daemon alias resolution", async () => {
    const session: SessionInfo = { sessionId: "native@4321", agentSessionId: "native", pid: 4321, status: "idle" };
    const h = fakeHarness({ parentPid: 4321, session });
    const handlers = createMcpToolHandlers(config, h.dependencies);
    await callTool(handlers, "conch_history", { session: "self" });
    expect(h.calls.control[0]?.message).toEqual({ kind: "history-page", session: "native@4321" });
    expect(h.calls.transcripts).toEqual([]);

    const unverified = fakeHarness({ parentPid: 0 });
    const refused = await callTool(createMcpToolHandlers(config, unverified.dependencies), "conch_item", { session: "self", item: "item-1" });
    expect(rpcResult(refused)).toMatchObject({ isError: true });
    expect(toolText(refused)).toContain("cannot verify");
    expect(unverified.calls.control).toEqual([]);
  });

  test("Codex self binds to its client-provided thread metadata", async () => {
    const session: SessionInfo = { sessionId: "codex-thread", backend: "codex", status: "idle" };
    const h = fakeHarness({ parentPid: 0, session });
    const handlers = createMcpToolHandlers(config, h.dependencies);
    await dispatchJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "conch_history", arguments: { session: "self" }, _meta: { "x-codex-turn-metadata": { thread_id: "codex-thread" } },
    } }, handlers);
    expect(h.calls.control[0]?.message).toEqual({ kind: "history-page", session: "codex-thread" });
  });

  test("item body chunks and continuation cursors are returned without truncation or re-encoding", async () => {
    const body: HistoryResponse = { kind: "history-item", item: "item-1", content: 'line\n🐚\u0000{"ok":true}', nextBodyCursor: "next-chunk", revision: 2, encoding: "json" };
    const h = fakeHarness({ parentPid: 0, controlResult: { ok: true, response: body } });
    const args = { session: "closed-record", item: "item-1", bodyCursor: "previous-chunk" };
    expect(JSON.parse(toolText(await callTool(createMcpToolHandlers(config, h.dependencies), "conch_item", args)))).toEqual(body);
    expect(h.calls.control[0]?.message).toEqual({ kind: "history-item", ...args });
  });

  test("off and stale-cursor outcomes stay explicit and cause no fallback or mutation", async () => {
    for (const response of [{ kind: "history-off", error: "history is off" },
      { kind: "history-error", code: "stale-cursor", error: "read a fresh page", epoch: "new-epoch" }] as const) {
      const h = fakeHarness({ parentPid: 0, controlResult: { ok: true, response } });
      expect(JSON.parse(toolText(await callTool(createMcpToolHandlers(config, h.dependencies), "conch_history", { session: "closed" })))).toEqual(response);
      expect(h.calls.control).toHaveLength(1);
      expect(h.calls.transcripts).toEqual([]);
      expect(h.calls.daemon).toEqual([]);
    }
  });

  test("invalid inputs are refused before reaching the daemon", async () => {
    const h = fakeHarness({ parentPid: 0 });
    const handlers = createMcpToolHandlers(config, h.dependencies);
    for (const [name, args] of [
      ["conch_history", {}], ["conch_history", { session: "s", limit: 101 }],
      ["conch_history", { session: "s", limit: 1.5 }], ["conch_history", { session: "s", after: "x" }],
      ["conch_history", { session: "🐚".repeat(2000) }], ["conch_item", { session: "s" }],
      ["conch_item", { session: "s", item: "i", branch: "b" }],
      ["conch_item", { session: "s", item: "i", bodyCursor: "x".repeat(17 * 1024) }],
    ] as const) expect(rpcResult(await callTool(handlers, name, args))).toMatchObject({ isError: true });
    expect(h.calls.control).toEqual([]);
  });

  test("the final MCP frame is bounded after JSON escaping, including errors and request IDs", async () => {
    const handlers = recordingHandlers([]);
    handlers.conch_item = async () => ({ kind: "history-item", content: '\\"🐚'.repeat(20_000) });
    for (const id of [1, "x".repeat(MCP_HISTORY_MAX_BYTES)] as const) {
      const response = await callTool(handlers, "conch_item", { session: "s", item: "i" }, id);
      expect(Buffer.byteLength(serializeJsonRpcLine(response) + "\n")).toBeLessThanOrEqual(MCP_HISTORY_MAX_BYTES);
    }
    handlers.conch_item = async () => { throw new Error("x".repeat(MCP_HISTORY_MAX_BYTES)); };
    const response = await callTool(handlers, "conch_item", { session: "s", item: "i" });
    expect(Buffer.byteLength(serializeJsonRpcLine(response) + "\n")).toBeLessThanOrEqual(MCP_HISTORY_MAX_BYTES);
    expect(JSON.parse(toolText(response))).toMatchObject({ kind: "history-error", code: "response-too-large" });
  });

  test("oversized or mismatched daemon responses are refused", async () => {
    for (const response of [
      { kind: "history-item", item: "i", content: "x".repeat(HISTORY_PAYLOAD_MAX_BYTES), nextBodyCursor: null, revision: 1, encoding: "text" },
      { kind: "history-item", item: "i", content: "wrong kind", nextBodyCursor: null, revision: 1, encoding: "text" },
    ] as const) {
      const h = fakeHarness({ parentPid: 0, controlResult: { ok: true, response } });
      const result = await callTool(createMcpToolHandlers(config, h.dependencies), "conch_history", { session: "s" });
      expect(JSON.parse(toolText(result))).toMatchObject({ kind: "history-error", code: "unavailable" });
    }
  });
});

describe("MCP tool discovery", () => {
  test("tools/list returns exactly the sixteen tools with valid closed schemas", async () => {
    const handlers = recordingHandlers([]);
    const response = await dispatchJsonRpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
    }, handlers);
    const result = rpcResult(response);
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error("expected tools/list result");
    }

    expect(response?.id).toBe(11);
    expect(result.tools.map((tool: unknown) => isRecord(tool) ? tool.name : null)).toEqual([...TOOL_NAMES]);
    expect(result.tools).toHaveLength(16);
    expect(new Set(result.tools.map((tool: unknown) => isRecord(tool) ? tool.name : null)).size).toBe(16);
    for (const deferred of DEFERRED_TOOL_NAMES) {
      expect(result.tools.some((tool: unknown) => isRecord(tool) && tool.name === deferred)).toBe(false);
    }

    const expectedProperties: Record<McpToolName, string[]> = {
      conch_sessions: [],
      conch_wake: ["session"],
      conch_recite: ["session"],
      conch_speak: ["text", "voice"],
      conch_mode: ["action", "session", "scope"],
      conch_rename: ["session", "label"],
      conch_config: ["key", "value", "unset"],
      conch_transcript_tail: ["session", "sentences"],
      review_to_front: ["summary", "link", "kind", "focus", "key", "session", "approval", "scene"],
      conch_history: ["session", "branch", "before", "limit"],
      conch_item: ["session", "item", "bodyCursor"],
      conch_working_folders: ["folders"],
      conch_on_screen: [],
      conch_deliverables: [],
      review_remove: ["id", "artifact"],
      conch_capture: ["url", "target", "viewport", "fullPage", "mark", "publish"],
    };
    const expectedRequired: Record<McpToolName, string[]> = {
      conch_sessions: [],
      conch_wake: [],
      conch_recite: [],
      conch_speak: ["text"],
      conch_mode: ["action"],
      conch_rename: ["session", "label"],
      conch_config: [],
      conch_transcript_tail: ["session"],
      // session is optional now: it defaults to the CALLING session.
      review_to_front: ["summary"],
      conch_history: ["session"],
      conch_item: ["session", "item"],
      conch_working_folders: ["folders"],
      conch_on_screen: [],
      conch_deliverables: [],
      // Exactly one of id or artifact, which the handler enforces.
      review_remove: [],
      conch_capture: ["url"],
    };

    for (const tool of result.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool.inputSchema)) {
        throw new Error("invalid tool definition");
      }
      const name = tool.name as McpToolName;
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {}))
        .toEqual(expectedProperties[name]);
      expect(Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [])
        .toEqual(expectedRequired[name]);
      assertValidSchema(tool.inputSchema);
    }

    expect(MCP_TOOLS[4].inputSchema.properties.action.enum)
      .toEqual(["pause", "resume"]);
    expect(MCP_TOOLS[7].inputSchema.properties.sentences)
      .toMatchObject({ type: "integer", minimum: 1, default: 3 });
  });
});

describe("conch_working_folders", () => {
  const config = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };

  test("a verified session's existing folders are recorded absolute, deduplicated, in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-working-"));
    try {
      const h = fakeHarness({ parentPid: 4321 });
      const response = await callTool(createMcpToolHandlers(config, h.dependencies), "conch_working_folders", {
        folders: [dir, "src", dir],
      });
      expect(rpcResult(response)).not.toMatchObject({ isError: true });
      expect(h.calls.workingFolders).toEqual([
        { sessionId: "session-123", folders: [dir, resolve(process.cwd(), "src")] },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file, a folder that does not exist, or an unverified caller records nothing", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers(config, h.dependencies);
    expect(toolText(await callTool(handlers, "conch_working_folders", { folders: ["package.json"] })))
      .toContain("not a folder");
    expect(toolText(await callTool(handlers, "conch_working_folders", { folders: ["/nowhere/at/all"] })))
      .toContain("not a folder");
    expect(toolText(await callTool(handlers, "conch_working_folders", { folders: [] })))
      .toContain("1 to 8");
    const unverified = fakeHarness({ parentPid: 0 });
    expect(toolText(await callTool(createMcpToolHandlers(config, unverified.dependencies), "conch_working_folders", { folders: ["src"] })))
      .toContain("cannot verify");
    expect(h.calls.workingFolders).toEqual([]);
    expect(unverified.calls.workingFolders).toEqual([]);
  });
});

/**
 * A folder is a deliverable: its tree in conch's panel and window, with `focus` naming the paths in it to point at.
 * The tool takes the folder by the link rule a file passes, resolves the focus on the disk, and sends only the folder
 * and those paths (relative to it); a refusal names why and sends nothing.
 */
describe("review_to_front with a folder", () => {
  const runtime = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };
  const withFolder = async (run: (root: string) => Promise<void>) => {
    const base = mkdtempSync(join(tmpdir(), "conch-mcp-folder-"));
    const root = join(base, "module");
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "test"), { recursive: true });
      await writeFile(join(root, "src", "setup.ts"), "export {};\n");
      await writeFile(join(root, "notes.md"), "# notes\n");
      await run(root);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };

  test("a folder link is filed as kind folder, with its focus relative to it", async () => {
    await withFolder(async (root) => {
      const h = fakeHarness({ parentPid: 4321 });
      const handlers = createMcpToolHandlers(runtime, h.dependencies);
      const result = JSON.parse(toolText(await callTool(handlers, "review_to_front", {
        summary: "the new module layout",
        link: root,
        focus: ["src/setup.ts", `${root}/test/`],
      })));
      expect(result).toMatchObject({
        outcome: "accepted",
        kind: "folder",
        version: 1,
        artifact: artifactIdentity(realpathSync(root)),
        link: root,
        focus: ["src/setup.ts", "test"],
      });
      // Only the folder and the paths named: never a listing.
      expect(h.calls.daemon.map((call) => call.event.review)).toEqual([
        { summary: "the new module layout", link: root, focus: ["src/setup.ts", "test"] },
      ]);
    });
  });

  test("the same folder again predicts its next version", async () => {
    await withFolder(async (root) => {
      const artifact = artifactIdentity(realpathSync(root));
      const published = JSON.stringify({ v: 1, rows: [{ id: "session-123", label: "Build", reviews: [
        { summary: "layout v1", link: root, at: 1_000, id: "f-1", artifact, version: 1, kind: "folder", focus: ["src"] },
      ] }] });
      const h = fakeHarness({ parentPid: 4321, sessionsFile: published });
      const handlers = createMcpToolHandlers(runtime, h.dependencies);
      const next = JSON.parse(toolText(await callTool(handlers, "review_to_front", { summary: "layout v2", link: `${root}/`, kind: "folder" })));
      expect(next).toMatchObject({ artifact, version: 2, kind: "folder" });
      // conch_deliverables says which paths each filing pointed at.
      const listed = JSON.parse(toolText(await callTool(handlers, "conch_deliverables", {})));
      expect(listed.deliverables[0]).toMatchObject({ id: "f-1", kind: "folder", focus: ["src"] });
    });
  });

  test("kind, link and focus that disagree, and a focus out of the folder, are refused and send nothing", async () => {
    await withFolder(async (root) => {
      const h = fakeHarness({ parentPid: 4321 });
      const handlers = createMcpToolHandlers(runtime, h.dependencies);
      const refusal = async (args: Record<string, unknown>) => {
        const response = await callTool(handlers, "review_to_front", { summary: "the layout", ...args });
        expect(rpcResult(response), JSON.stringify(args)).toMatchObject({ isError: true });
        return toolText(response);
      };
      expect(await refusal({ link: root, kind: "image" })).toContain('link is a folder, which is kind "folder"');
      expect(await refusal({ link: join(root, "notes.md"), kind: "folder" })).toContain('kind "folder" needs a link to an existing folder');
      expect(await refusal({ link: join(root, "notes.md"), focus: ["src"] })).toContain("focus is for a folder deliverable");
      expect(await refusal({ focus: ["src"] })).toContain("focus is for a folder deliverable");
      expect(await refusal({ link: root, focus: ["../module/src"] })).toContain("focus[0] ../module/src has a .. part");
      expect(await refusal({ link: root, focus: ["/etc/hosts"] })).toContain("focus[0] /etc/hosts is outside the folder");
      expect(await refusal({ link: root, focus: ["src/missing.ts"] })).toContain("focus[0] src/missing.ts is not in the folder");
      expect(await refusal({ link: root, focus: [] })).toContain("focus must be 1 to 12 paths");
      expect(await refusal({ link: homedir(), kind: "folder" })).toMatch(/home folder|outside this session's folder/);
      expect(h.calls.daemon).toEqual([]);
    });
  });

  test("the schema says what focus takes", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "review_to_front")!;
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.focus).toMatchObject({ type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } });
    expect(properties.focus.description).toContain("for a folder link only");
    expect(properties.kind.enum).toContain("folder");
    expect(properties.kind.description).toContain("folder a directory shown as its file tree");
  });
});

describe("schemas state what the handlers enforce", () => {
  const schema = (name: McpToolName) =>
    MCP_TOOLS.find((tool) => tool.name === name)!.inputSchema as Record<string, any>;

  test("speak text is capped in the schema, and no schema uses a conditional keyword", () => {
    expect(schema("conch_speak").properties.text.maxLength).toBe(MAX_SPEAK_CHARS);
    for (const tool of MCP_TOOLS) {
      for (const keyword of ["dependentSchemas", "dependentRequired", "if", "not"]) {
        expect(JSON.stringify(tool.inputSchema)).not.toContain(`"${keyword}"`);
      }
    }
    // The Anthropic API rejects these at the top of a tool's input_schema.
    for (const tool of MCP_TOOLS) {
      for (const keyword of ["anyOf", "oneOf", "allOf"]) {
        expect(Object.hasOwn(tool.inputSchema, keyword)).toBe(false);
      }
    }
  });

  test("review_to_front describes publishing, not opening or finishing, and what its answer means", () => {
    // 2026-10-05: when and why to publish first, then what to pass and what the result means; the mechanics it used to
    // carry are in the parameters and the skill (agent-instructions.test.ts pins where).
    expect(MCP_TOOLS.find((tool) => tool.name === "review_to_front")!.description).toBe(
      "Publish whenever you produce something the user would look at (a page, screenshot, file, document, plan, diff or PR, build, app state), as you go, not only at the end. It’s one call, it doesn’t interrupt them, and it’s how they follow your work from conch’s Mac app and their phone. Pass a one-line summary of what it is and what to check, and the best single artifact as link (a URL, or a path to a file or folder) with its kind; with nothing to link (an app window, the Simulator), say where to look in the summary. Publishing the same link or key again adds its next version, not a second entry. It opens nothing and doesn’t end your turn: the user’s click on the pill brings it forward. The result says where it landed (surfaces) and any warning or relabel to act on; tell the user from that, not from what you assume.",
    );
    // Claude Code cuts a tool description past 2048 characters (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, 2.1.280).
    for (const tool of MCP_TOOLS) expect(tool.description.length).toBeLessThan(2048);
  });
});

describe("MCP dispatch", () => {
  test("initialize advertises the newest protocol it speaks to a client it doesn't, the tool capability, and its instructions", async () => {
    const response = await dispatchJsonRpc({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: { protocolVersion: "future-client-version" },
    }, recordingHandlers([]));

    expect(rpcResult(response)).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "conch", version: CONCH_VERSION },
      instructions: AGENT_INSTRUCTIONS.serverInstructions,
    });
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
  });

  // Claude Code 2.1.280 asks for 2025-11-25 and lists 2025-06-18, 2025-03-26 and 2024-11-05 as fine; it used to be
  // told 2024-11-05 whatever it asked. The spec: answer the client's own revision when the server speaks it.
  test("initialize answers the client's own protocol revision when it speaks it, else its newest", async () => {
    const answered = async (protocolVersion: unknown) => (rpcResult(await dispatchJsonRpc({
      jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }, recordingHandlers([]))) as { protocolVersion: string }).protocolVersion;
    expect(MCP_PROTOCOL_VERSIONS).toEqual(["2025-06-18", "2025-03-26", "2024-11-05"]);
    for (const version of MCP_PROTOCOL_VERSIONS) expect(await answered(version)).toBe(version);
    expect(await answered("2025-11-25")).toBe("2025-06-18");
    expect(await answered("2024-10-07")).toBe("2025-06-18");
    expect(await answered(undefined)).toBe("2025-06-18");
    expect(await answered(20250618)).toBe("2025-06-18");
    expect(negotiateProtocolVersion("2025-03-26")).toBe("2025-03-26");
  });

  // 2025-03-26 is one of the revisions it agrees to, and that revision lets a client batch.
  test("a JSON-RPC batch is answered in order in one array, and a batch of notifications not at all", async () => {
    const calls: Array<{ name: McpToolName; argumentsValue: unknown }> = [];
    const handlers = recordingHandlers(calls);
    const answered = await dispatchJsonRpcBatch([
      { jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "conch_sessions", arguments: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ], handlers);
    expect(Array.isArray(answered)).toBe(true);
    expect((answered as JsonRpcResponse[]).map((response) => response.id)).toEqual(["a", "b"]);
    expect(calls.map((call) => call.name)).toEqual(["conch_sessions"]);
    expect(await dispatchJsonRpcBatch([{ jsonrpc: "2.0", method: "notifications/initialized" }], handlers)).toBeNull();
    expect(await dispatchJsonRpcBatch([], handlers)).toMatchObject({ id: null, error: { code: -32600 } });

    // Over stdio, as a client sends it: one line in, one line out.
    const lines: string[] = [];
    const input = new Blob([`${JSON.stringify([{ jsonrpc: "2.0", id: 7, method: "tools/list" }, { jsonrpc: "2.0", id: 8, method: "nope" }])}\n`]).stream();
    await runMcpServer({ handlers, input, writeLine: (line) => void lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).map((response: JsonRpcResponse) => response.id)).toEqual([7, 8]);
  });

  test("tools/call routes every name to only its handler and wraps its value as text", async () => {
    const calls: Array<{ name: McpToolName; argumentsValue: unknown }> = [];
    const handlers = recordingHandlers(calls);

    for (const [index, name] of TOOL_NAMES.entries()) {
      calls.length = 0;
      const argumentsValue = { marker: `call-${index}` };
      const response = await callTool(handlers, name, argumentsValue, index + 1);

      expect(response?.id).toBe(index + 1);
      expect(calls).toEqual([{ name, argumentsValue }]);
      expect(JSON.parse(toolText(response))).toEqual({
        routedTo: name,
        argumentsValue,
      });
    }
  });

  test("handler failures become isError results and invalid methods become JSON-RPC errors", async () => {
    const handlers = recordingHandlers([]);
    handlers.conch_wake = async () => {
      throw new Error("daemon exploded");
    };

    const failedCall = await callTool(handlers, "conch_wake", {});
    expect(rpcResult(failedCall)).toEqual({
      content: [{ type: "text", text: "daemon exploded" }],
      isError: true,
    });

    const badMethod = await dispatchJsonRpc({
      jsonrpc: "2.0",
      id: "bad-method",
      method: "not/a/method",
    }, handlers);
    expect(badMethod).toMatchObject({
      jsonrpc: "2.0",
      id: "bad-method",
      error: { code: -32601, message: "Method not found" },
    });
    expect(await dispatchJsonRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, handlers)).toBeNull();
  });
});

describe("real MCP tool handlers with injected dependencies", () => {
  /**
   * Publishing used to `open` the link from the agent's own MCP process, taking the front the moment an agent filed,
   * before Tyler asked for anything. It files and announces now; the Mac's Ready pill brings the scene forward on a click.
   */
  test("review_to_front files and announces a review and opens nothing", async () => {
    const bun = Bun as any;
    const originalSpawn = bun.spawn;
    const spawned: unknown[][] = [];
    bun.spawn = (args: unknown[]) => {
      spawned.push(args);
      return {};
    };
    try {
      const h = fakeHarness({ parentPid: 4321 });
      const handlers = createMcpToolHandlers({
        claudeDir: "/virtual/claude",
        socketPath: "/virtual/conch.sock",
      }, h.dependencies);
      const response = await callTool(handlers, "review_to_front", {
        summary: "Inspect the finished dashboard",
        link: "https://example.com/review",
        session: "Build",
      });
      expect(rpcResult(response)).not.toMatchObject({ isError: true });
      expect(h.calls.daemon).toHaveLength(1);
      expect(spawned).toEqual([]);
    } finally {
      bun.spawn = originalSpawn;
    }
    expect(Object.keys(defaultMcpDependencies)).not.toContain("openLink");
  });

  test("sessions returns the published file unchanged, plus the caller's binding", async () => {
    const published = {
      v: 1,
      ts: 99,
      mode: { muted: true, paused: false, holding: 0 },
      live: {
        state: "muted",
        label: "",
        partial: "live words",
        transcriptPrefix: "committed words",
        reading: { text: "reply in progress", spokenChars: 7 },
      },
      reply: { sessionId: "active", text: "reply in progress", spokenChars: 7 },
      preview: { sessionId: "parked", text: "parked reply", spokenChars: 0 },
      rows: [{
        id: "active",
        label: "Active",
        status: "working",
        at: 123,
        transcriptPath: "/virtual/active.jsonl",
        voice: "af_heart",
        prioritized: true,
        navSelected: true,
        needsResponse: false,
        paused: false,
        muted: false,
        live: "speaking",
        active: true,
      }],
      dismissed: [],
      futureField: { preserved: true },
    } satisfies McpPublishedState & { futureField: { preserved: boolean } };
    const h = fakeHarness({ sessionsFile: JSON.stringify(published) });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
      sessionsPath: "/virtual/conch-sessions.json",
    }, h.dependencies);

    const response = await callTool(handlers, "conch_sessions", {});

    expect(JSON.parse(toolText(response))).toEqual({
      ...published,
      caller: { status: "unverified", reason: expect.stringContaining("is not a live session conch knows") },
    });
    expect(h.calls.sessionsFiles).toEqual(["/virtual/conch-sessions.json"]);
    // Read once, for the binding; the rows are the daemon's.
    expect(h.calls.registries).toEqual(["/virtual/claude"]);
    expect(h.calls.daemon).toEqual([]);
  });

  test("sessions falls back to a deterministic PublishedState from the injected registry", async () => {
    const h = fakeHarness({ sessionsFile: "{ malformed" });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const response = await callTool(handlers, "conch_sessions", {});

    expect(JSON.parse(toolText(response))).toEqual({
      v: 1,
      ts: 1_234_567,
      mode: { muted: false, paused: false, holding: 0 },
      live: { state: "idle", label: "" },
      rows: [{
        id: "session-123",
        label: "Build label",
        cwd: "/work/build",
        status: "waiting",
        needsResponse: false,
        paused: false,
        muted: false,
        live: null,
        active: false,
      }],
      dismissed: [],
      dismissedRows: [],
      caller: { status: "unverified", reason: expect.any(String) },
    });
    expect(h.calls.registries).toEqual(["/virtual/claude", "/virtual/claude"]);
  });

  test("wake, recite, speak, and mode send exact TurnEvents through the fake daemon seam", async () => {
    const h = fakeHarness();
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    await callTool(handlers, "conch_wake", { session: "session-123" });
    await callTool(handlers, "conch_recite", { session: "Build" });
    await callTool(handlers, "conch_speak", { text: "Testing.", voice: "af_heart" });
    // The bare pause is the whole daemon, and needs `scope: "all"` now (C5).
    await callTool(handlers, "conch_mode", { action: "pause", scope: "all" });

    expect(h.calls.sessionLookups).toEqual([
      { claudeDir: "/virtual/claude", query: "session-123" },
      { claudeDir: "/virtual/claude", query: "Build" },
    ]);
    expect(h.calls.marks).toEqual(["/virtual/session-123.jsonl"]);
    expect(h.calls.daemon).toEqual([
      {
        socketPath: "/virtual/conch.sock",
        event: {
          type: "wake",
          sessionId: "session-123",
          label: "Build label",
          pid: 4321,
          cwd: "/work/build",
          transcriptPath: "/virtual/session-123.jsonl",
          announce: "",
          // An agent asked, not the person. Manual mode holds these rather
          // than opening the mic on them.
          origin: "agent",
        },
      },
      {
        socketPath: "/virtual/conch.sock",
        event: {
          type: "recite",
          sessionId: "session-123",
          label: "Build label",
          pid: 4321,
          cwd: "/work/build",
          transcriptPath: "/virtual/session-123.jsonl",
          mark: 7,
          announce: "",
        },
      },
      {
        socketPath: "/virtual/conch.sock",
        event: {
          type: "speak",
          sessionId: "",
          label: "",
          announce: "Testing.",
          voice: "af_heart",
          origin: "agent",
        },
      },
      {
        socketPath: "/virtual/conch.sock",
        event: {
          type: "pause",
          sessionId: "",
          label: "",
          announce: "",
          origin: "agent",
        },
      },
    ]);
  });

  test("mode rejects retired destructive aliases", async () => {
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, fakeHarness().dependencies);

    await expect(handlers.conch_mode({ action: "mute" })).rejects.toThrow(
      "action must be pause or resume",
    );
    await expect(handlers.conch_mode({ action: "unmute" })).rejects.toThrow(
      "action must be pause or resume",
    );
  });

  test("rename, config, and transcript tail route through their injected helpers", async () => {
    const h = fakeHarness();
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const renamed = await callTool(handlers, "conch_rename", {
      session: "Build",
      label: "Release",
    });
    const configured = await callTool(handlers, "conch_config", {
      key: "read-full",
      value: false,
    });
    const unset = await callTool(handlers, "conch_config", {
      key: "read-full",
      unset: true,
    });
    const oneSetting = await callTool(handlers, "conch_config", {
      key: "read-full",
    });
    const allSettings = await callTool(handlers, "conch_config", {});
    const tail = await callTool(handlers, "conch_transcript_tail", {
      session: "Build",
    });

    expect(JSON.parse(toolText(renamed))).toEqual({
      kind: "session-ack",
      sessionId: "session-123",
      command: "rename",
      label: "Release",
      changed: true,
    });
    expect(h.calls.renames).toEqual([]);
    expect(h.calls.control).toEqual([
      {
        socketPath: "/virtual/conch.sock",
        message: {
          kind: "session-command",
          sessionId: "session-123",
          command: "rename",
          label: "Release",
        },
      },
      {
        socketPath: "/virtual/conch.sock",
        message: { kind: "set-config", key: "read-full", value: false },
      },
      {
        socketPath: "/virtual/conch.sock",
        message: { kind: "unset-config", key: "read-full" },
      },
      {
        socketPath: "/virtual/conch.sock",
        message: { kind: "get-config" },
      },
      {
        socketPath: "/virtual/conch.sock",
        message: { kind: "get-config" },
      },
    ]);
    expect(JSON.parse(toolText(configured))).toMatchObject({
      kind: "config-ack",
      key: "read-full",
      action: "set",
      effective: false,
    });
    expect(JSON.parse(toolText(unset))).toMatchObject({
      kind: "config-ack",
      key: "read-full",
      action: "unset",
    });
    expect(JSON.parse(toolText(oneSetting))).toEqual({
      kind: "config-value",
      key: "read-full",
      settingKind: "boolean",
      value: true,
      source: "default",
      bounds: null,
      default: true,
      help: "read the full final response aloud",
    });
    expect(JSON.parse(toolText(allSettings))).toMatchObject({
      kind: "config-snapshot",
      snapshot: {
        "read-full": { value: true, source: "default" },
      },
    });
    expect(JSON.parse(toolText(tail))).toEqual({
      sessionId: "session-123",
      label: "Build label",
      text: "Second! Third? Fourth.",
    });
    expect(h.calls.assistantReads).toEqual(["/virtual/session-123.jsonl"]);
    expect(h.calls.sentenceSplits).toEqual(["First. Second! Third? Fourth."]);
    expect(h.calls.daemon).toEqual([]);
  });

  test("rename falls back to direct persistence only when the daemon is down", async () => {
    const h = fakeHarness({
      controlResult: { ok: false, reason: "daemon-down" },
    });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const renamed = await callTool(handlers, "conch_rename", {
      session: "Build",
      label: "Release",
    });

    expect(JSON.parse(toolText(renamed))).toEqual({
      kind: "session-ack",
      sessionId: "session-123",
      command: "rename",
      label: "Release",
      changed: true,
    });
    expect(h.calls.control).toEqual([{
      socketPath: "/virtual/conch.sock",
      message: {
        kind: "session-command",
        sessionId: "session-123",
        command: "rename",
        label: "Release",
      },
    }]);
    expect(h.calls.renames).toEqual([{
      sessionId: "session-123",
      oldLabel: "Build label",
      newLabel: "Release",
    }]);
    expect(h.calls.providerRenames).toEqual([{
      sessionId: "session-123",
      label: "Release",
    }]);
  });

  test("rename returns the daemon's canonical post-mutation label", async () => {
    const h = fakeHarness({ renameAckLabel: "Canonical Release" });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const renamed = await callTool(handlers, "conch_rename", {
      session: "Build",
      label: "  Canonical Release\n",
    });

    expect(JSON.parse(toolText(renamed))).toMatchObject({
      kind: "session-ack",
      sessionId: "session-123",
      command: "rename",
      label: "Canonical Release",
      changed: true,
    });
    expect(h.calls.renames).toEqual([]);
  });

  test("rename does not bypass an indeterminate daemon reply", async () => {
    const h = fakeHarness({
      controlResult: {
        ok: false,
        reason: "ack-unknown",
        diagnostic: "daemon closed without a reply",
      },
    });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const response = await callTool(handlers, "conch_rename", {
      session: "Build",
      label: "Release",
    });

    expect(rpcResult(response)).toEqual({
      content: [{
        type: "text",
        text: "ack-unknown: daemon closed without a reply",
      }],
      isError: true,
    });
    expect(h.calls.renames).toEqual([]);
  });

  test("review_to_front publishes the exact review, as a publication and not a turn end", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);
    const summary = "Inspect the finished dashboard";
    const link = "https://example.com/review";

    await callTool(handlers, "review_to_front", {
      summary,
      link,
      session: "Build",
    });

    expect(h.calls.daemon[0]?.event).toEqual({
      type: "review-published",
      sessionId: "session-123",
      label: "Build label",
      cwd: "/work/build",
      pid: 4321,
      announce: "Build label has work ready for your review: Inspect the finished dashboard",
      transcriptPath: "/virtual/session-123.jsonl",
      mark: 7,
      eventAt: 1_234_567,
      review: {
        summary,
        link,
      },
    });
  });

  /**
   * 2026-10-05, Tyler, after using #502: "I don't really get the point of the approve button... maybe we only show it if
   * the AI sets some sort of flag in the review that it's asking for me to approve some work?" `approval` is that flag:
   * sent only when given, its label trimmed and at most 40 characters, anything else refused before the daemon hears.
   */
  test("review_to_front asks for approval only when told to, with a trimmed label of at most 40 characters", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({ claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" }, h.dependencies);
    const publish = async (args: Record<string, unknown>) =>
      callTool(handlers, "review_to_front", { summary: "The PR is ready", link: "https://example.com/pr", session: "Build", ...args });

    // Without it: nothing about approval goes to the daemon or comes back.
    const plain = JSON.parse(toolText(await publish({})));
    expect(h.calls.daemon.at(-1)?.event.review).toEqual({ summary: "The PR is ready", link: "https://example.com/pr" });
    expect(plain.approval).toBeUndefined();

    // With a label: trimmed, control characters dropped, and said back.
    const labelled = JSON.parse(toolText(await publish({ approval: { label: "  Open the PR\u0007 " } })));
    expect(h.calls.daemon.at(-1)?.event.review).toEqual({
      summary: "The PR is ready", link: "https://example.com/pr", approval: { label: "Open the PR" },
    });
    expect(labelled.approval).toEqual({ label: "Open the PR" });

    // Asked with no label, and with one of exactly 40.
    await publish({ approval: {} });
    expect(h.calls.daemon.at(-1)?.event.review?.approval).toEqual({});
    await publish({ approval: { label: "d".repeat(40) } });
    expect(h.calls.daemon.at(-1)?.event.review?.approval).toEqual({ label: "d".repeat(40) });
    const sent = h.calls.daemon.length;

    // Refused, and the daemon hears nothing: over 40 once trimmed, empty, not a string, an unknown field, not an object.
    for (const approval of [{ label: "x".repeat(41) }, { label: "   " }, { label: "" }, { label: 7 }, { label: "ok", colour: "red" }, true, "Open the PR", ["x"]]) {
      const response = await publish({ approval });
      expect(rpcResult(response), JSON.stringify(approval)).toMatchObject({ isError: true });
      expect(toolText(response)).toMatch(/^refused: approval/);
    }
    expect(toolText(await publish({ approval: { label: "x".repeat(41) } })))
      .toBe('refused: approval.label must be 1 to 40 printable characters naming what approving does (e.g. "Open the PR"), or leave it out');
    expect(h.calls.daemon).toHaveLength(sent);
  });

  test("the schema says approval is for waiting on a yes, never by default, and what the agent is sent", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "review_to_front")!;
    const approval = (tool.inputSchema.properties as Record<string, any>).approval;
    expect(approval).toMatchObject({
      type: "object",
      properties: { label: { type: "string", minLength: 1, maxLength: 40 } },
      additionalProperties: false,
    });
    expect(approval.description).toContain("only when you are waiting on the user's yes to proceed: never by default");
    expect(approval.description).toContain('conch sends your session "Approved: <label>." as a message about 10 s later');
    // 2026-10-05: the rule lives here, on the parameter, and no longer in the tool's description, which says when to
    // publish; an approval is the exception, never the default.
    expect(tool.description).not.toContain("approval");
  });

  test("review_to_front publishes a relative file link as an absolute path", async () => {
    // The tool stats a relative link against its own cwd — the session's — so
    // validation passed, and then the raw string reached the Mac app, which
    // resolved it against ITS cwd and previewed the deliverable as missing.
    // Absolute on the wire, or the app cannot find the file the tool just
    // confirmed exists.
    const root = mkdtempSync(join(tmpdir(), "conch-review-link-"));
    const absolute = join(root, "handoff.md");
    writeFileSync(absolute, "# handoff\n");
    const relativeLink = relative(process.cwd(), absolute);
    expect(isAbsolute(relativeLink)).toBe(false);

    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    await callTool(handlers, "review_to_front", {
      summary: "the handoff",
      link: relativeLink,
      session: "Build",
    });

    const published = (h.calls.daemon[0]?.event as { review?: { link?: string } }).review?.link;
    expect(published).toBe(absolute);
    rmSync(root, { recursive: true, force: true });
  });

  test("review_to_front leaves a web link exactly as given", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);
    await callTool(handlers, "review_to_front", {
      summary: "a page",
      link: "https://example.com/review",
      session: "Build",
    });
    const published = (h.calls.daemon[0]?.event as { review?: { link?: string } }).review?.link;
    expect(published).toBe("https://example.com/review");
  });

  test("review_to_front accepts an existing non-executable file link", async () => {
    const root = await mkdtemp(join(tmpdir(), "conch-mcp-review-"));
    const link = join(root, "review.html");
    try {
      await writeFile(link, "<h1>Review</h1>", { mode: 0o600 });
      const h = fakeHarness({ parentPid: 4321 });
      const handlers = createMcpToolHandlers({
        claudeDir: "/virtual/claude",
        socketPath: "/virtual/conch.sock",
      }, h.dependencies);

      const response = await callTool(handlers, "review_to_front", {
        summary: "Inspect the finished dashboard",
        link,
        session: "Build",
      });

      expect(rpcResult(response)).not.toMatchObject({ isError: true });
      expect(h.calls.daemon).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("review_to_front rejects unsafe schemes and non-launchable file links", async () => {
    const root = await mkdtemp(join(tmpdir(), "conch-mcp-review-"));
    const regularFile = join(root, "review.html");
    const missingFile = join(root, "missing.html");
    const executableFile = join(root, "review.sh");
    try {
      // A directory is no longer on this list: it is a folder deliverable (test/folder-deliverable.test.ts).
      await writeFile(regularFile, "<h1>Review</h1>", { mode: 0o600 });
      await writeFile(executableFile, "#!/bin/sh\n", { mode: 0o700 });
      await chmod(executableFile, 0o700);

      const h = fakeHarness({ parentPid: 4321 });
      const handlers = createMcpToolHandlers({
        claudeDir: "/virtual/claude",
        socketPath: "/virtual/conch.sock",
      }, h.dependencies);
      const rejectedLinks = [
        "ftp://example.com/review",
        "javascript:alert(1)",
        `file://${regularFile}`,
        missingFile,
        executableFile,
      ];

      for (const link of rejectedLinks) {
        const response = await callTool(handlers, "review_to_front", {
          summary: "Inspect the finished dashboard",
          link,
        });
        expect(rpcResult(response)).toMatchObject({ isError: true });
        expect(toolText(response)).toBe(
          "refused: link must be an http(s) URL or an existing, non-executable regular file",
        );
      }

      expect(h.calls.sessionLookups).toEqual([]);
      expect(h.calls.daemon).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // review-roots.ts: the same folders the hook and the daemon check with. Where the session is now comes from its
  // transcript, since this process's cwd is only where it started.
  test("review_to_front checks a link against the session's folders: where it started, and where its transcript says it is", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "conch-mcp-roots-")));
    const saved = process.env.TMPDIR;
    const savedUserTemp = process.env.CONCH_USER_TEMP_DIR;
    mkdirSync(join(base, "temp"));
    // Temp folders are always allowed; point TMPDIR away so only the session's folders decide.
    process.env.TMPDIR = join(base, "temp");
    process.env.CONCH_USER_TEMP_DIR = join(base, "temp");
    try {
      const start = join(base, "Internal");
      const now = join(base, "Internal", "monorepo", ".worktrees", "task");
      const moved = join(base, "Clients", "arch");
      for (const dir of [join(start, "review-2026-09-30"), now, moved, join(base, "Outside")]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(now, "page.html"), "<h1>ok</h1>");
      writeFileSync(join(moved, "page.html"), "<h1>ok</h1>");
      writeFileSync(join(base, "Outside", "page.html"), "<h1>no</h1>");
      const transcript = join(base, "session.jsonl");
      const publish = async (where: string, link: string) => {
        writeFileSync(transcript, `${JSON.stringify({ type: "user", cwd: start })}\n${JSON.stringify({ type: "assistant", cwd: where })}\n`);
        const h = fakeHarness({
          parentPid: 4321,
          transcriptPath: transcript,
          session: { sessionId: "session-123", name: "Build", cwd: start, pid: 4321, status: "idle" },
        });
        const response = await callTool(createMcpToolHandlers({ claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" }, h.dependencies),
          "review_to_front", { summary: "the pack", link });
        return { response, sent: (h.calls.daemon[0]?.event as { review?: { link?: string } } | undefined)?.review?.link };
      };
      // In a nested worktree: the folder it started in is still its folder, and a relative link is the worktree's.
      expect((await publish(now, join(start, "review-2026-09-30"))).sent).toBe(join(start, "review-2026-09-30"));
      expect((await publish(now, "page.html")).sent).toBe(join(now, "page.html"));
      // Moved outside it altogether: the folder it is in now counts too.
      expect((await publish(moved, "page.html")).sent).toBe(join(moved, "page.html"));
      // Outside both: refused, naming the folders it checked.
      const refused = await publish(moved, join(base, "Outside", "page.html"));
      expect(rpcResult(refused.response)).toMatchObject({ isError: true });
      expect(toolText(refused.response)).toContain(`is outside this session's folders (${start}, ${moved}) and the temp folders`);
      expect(refused.sent).toBeUndefined();
    } finally {
      process.env.TMPDIR = saved;
      process.env.CONCH_USER_TEMP_DIR = savedUserTemp;
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("review_to_front reports a daemon that is not there as failed", async () => {
    const h = fakeHarness({ daemonAccepts: false , parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const response = await callTool(handlers, "review_to_front", {
      summary: "Inspect the finished dashboard",
      link: "https://example.com/review",
      session: "Build",
    });

    expect(rpcResult(response)).toEqual({
      content: [{ type: "text", text: "failed: conch daemon is not running, so nothing was published" }],
      isError: true,
    });
    expect(h.calls.daemon).toHaveLength(1);
  });

  test("a publication is not a turn end: a newer Stop never makes it stale, and it never displaces one", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    await callTool(handlers, "review_to_front", {
      summary: "Inspect the finished dashboard",
      link: "https://example.com/review",
      session: "Build",
    });
    const event = h.calls.daemon[0]?.event;
    if (!event) throw new Error("expected review_to_front to build a TurnEvent");
    const review = event.review;
    const order = new TurnEventOrder();
    // The session's own Stop, which happened after the publication, lands first.
    const stop: TurnEvent = {
      type: "turn-end",
      sessionId: event.sessionId,
      label: event.label,
      announce: "Build label: done",
      eventAt: (event.eventAt ?? 0) + 1,
    };

    expect(order.accept(stop)).toBe(true);
    expect(order.accept(event)).toBe(true);
    expect(order.isCurrent(event)).toBe(true);
    expect(order.isCurrent(stop)).toBe(true);
    expect(downgradeTurnWithLiveBackgroundWork(event, true)).toBe(event);
    expect(event.type).toBe("review-published");
    expect(event.review).toBe(review);
  });

  test("review_to_front from a daemon that says nothing is accepted, unconfirmed, and reports a summary it had to cut", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    // This harness's daemon takes a publication without a word (`sendToDaemon`), as one from before verdicts does:
    // taken, and said to be unconfirmed, never "filed".
    const unconfirmed = "this conch daemon does not say whether it filed a publication; the id and version below are"
      + " predicted, and conch_deliverables says what was filed";
    const long = await callTool(handlers, "review_to_front", { summary: "x".repeat(250), session: "Build" });
    expect(JSON.parse(toolText(long))).toEqual({
      outcome: "accepted",
      unconfirmed,
      sessionId: "session-123",
      label: "Build label",
      id: reviewIdentity("session-123", { summary: "x".repeat(200), at: 1_234_567 }),
      artifact: artifactIdentity("x".repeat(200)),
      version: 1,
      kind: "other",
      summary: "x".repeat(200),
      summaryTruncated: { from: 250, to: 200 },
    });
    expect(h.calls.daemon[0]?.event.review).toEqual({ summary: "x".repeat(200) });

    const short = await callTool(handlers, "review_to_front", {
      summary: "the dashboard",
      link: "https://example.com/review",
      session: "Build",
    });
    expect(JSON.parse(toolText(short))).toEqual({
      outcome: "accepted",
      unconfirmed,
      sessionId: "session-123",
      label: "Build label",
      id: reviewIdentity("session-123", { summary: "the dashboard", link: "https://example.com/review", at: 1_234_567 }),
      artifact: artifactIdentity("https://example.com/review"),
      version: 1,
      kind: "url",
      summary: "the dashboard",
      link: "https://example.com/review",
    });
  });

  test("a real daemon-send failure is contained as an MCP isError result", async () => {
    const h = fakeHarness({ daemonAccepts: false });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const response = await callTool(handlers, "conch_speak", { text: "Hello" });

    expect(rpcResult(response)).toEqual({
      content: [{ type: "text", text: "conch daemon is not running" }],
      isError: true,
    });
  });
  test("review_to_front refuses to file a review under another session's name", async () => {
    // The MCP server runs as a direct child of its Claude Code session, so the
    // parent pid identifies the caller. Nothing used to stop one session filing a
    // review attributed to a sibling — reviews are an approval gate, so a
    // misattributed one is worse than a missing one.
    const h = fakeHarness({
      registry: {
        infos: [
          { sessionId: "session-a", name: "Alpha", cwd: "/work/alpha", status: "busy", pid: process.ppid },
          { sessionId: "session-b", name: "Beta", cwd: "/work/beta", status: "busy", pid: process.ppid + 1 },
        ],
        liveIds: new Set(["session-a", "session-b"]),
        complete: true,
      },
    });
    h.dependencies.sessionLabel = (session) => session?.name ?? "unnamed";
    h.dependencies.findSessionByName = async (_dir, query) =>
      query === "Beta"
        ? { sessionId: "session-b", name: "Beta", cwd: "/work/beta", status: "busy", pid: process.ppid + 1 }
        : { sessionId: "session-a", name: "Alpha", cwd: "/work/alpha", status: "busy", pid: process.ppid };
    const handlers = createMcpToolHandlers(
      { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" },
      h.dependencies,
    );

    let thrown: unknown;
    try {
      await handlers.review_to_front({ summary: "not mine", session: "Beta" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ToolInputError");
    expect((thrown as Error).message).toContain("can only surface its own work");
    // Nothing was announced on the refused path.
    expect(h.calls.daemon).toEqual([]);
  });

  /**
   * The registry a backgrounded conversation leaves: window `pred` parked on
   * job `succ`. `caller` is whose MCP server this test process plays — its
   * parent pid is that process. The window pid must be live for the route to
   * count, so it is always this process or its parent.
   */
  async function backgroundRegistry(caller: "job" | "window") {
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-mcp-bg-"));
    await mkdir(join(claudeDir, "sessions"), { recursive: true });
    const register = (pid: number, entry: object) => writeFileSync(
      join(claudeDir, "sessions", `${pid}.json`),
      JSON.stringify({ pid, cwd: "/Users/t", entrypoint: "cli", status: "busy", ...entry }),
    );
    const jobPid = caller === "job" ? process.ppid : process.pid;
    const windowPid = caller === "job" ? process.pid : process.ppid;
    register(windowPid, { sessionId: "pred", kind: "interactive", name: "conch", parkedJobId: "succjob" });
    register(jobPid, { sessionId: "succ", kind: "bg", name: "conch", jobId: "succjob" });
    const options = {
      configDir: join(claudeDir, "conch-config"),
      codexHome: join(claudeDir, "codex"),
      labelsPath: join(claudeDir, "labels.json"),
      processParents: async () => null,
    };
    const h = fakeHarness();
    h.dependencies.registrySnapshot = (dir) => registrySnapshot(dir, options);
    h.dependencies.findSessionByName = (dir, query) => findSessionByName(dir, query, options);
    const handlers = createMcpToolHandlers({ claudeDir, socketPath: "/virtual/conch.sock" }, h.dependencies);
    return { claudeDir, h, handlers, windowPid };
  }

  test("review_to_front from a background job files under the job's row, routed to its window", async () => {
    // The job's MCP servers are children of the job's own process, and the
    // row's pid is the window attached to the job, so the parent-pid match
    // misses. Claude Code names each registry file after its process, so the
    // parent's own file still names the caller.
    const { claudeDir, h, handlers, windowPid } = await backgroundRegistry("job");
    try {
      await handlers.review_to_front({ summary: "the continued-sessions fix" });
      expect(h.calls.daemon.map((call) => call.event.sessionId)).toEqual(["succ"]);
      expect(h.calls.daemon[0]!.event.pid).toBe(windowPid);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("review_to_front from a caller conch cannot identify is refused, even naming a real session's stale id", async () => {
    // Neither registry pid is this server's parent. Such a caller used to be
    // able to name any session and file under it; a name is not proof of who
    // is asking, so nothing is filed.
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-mcp-stale-"));
    await mkdir(join(claudeDir, "sessions"), { recursive: true });
    const register = (pid: number, entry: object) => writeFileSync(
      join(claudeDir, "sessions", `${pid}.json`),
      JSON.stringify({ pid, cwd: "/Users/t", entrypoint: "cli", status: "busy", ...entry }),
    );
    register(process.pid, { sessionId: "pred", kind: "interactive", name: "conch", parkedJobId: "succjob" });
    register(72858, { sessionId: "succ", kind: "bg", name: "conch", jobId: "succjob" });
    const options = {
      configDir: join(claudeDir, "conch-config"),
      codexHome: join(claudeDir, "codex"),
      labelsPath: join(claudeDir, "labels.json"),
      processParents: async () => null,
    };
    const h = fakeHarness();
    h.dependencies.registrySnapshot = (dir) => registrySnapshot(dir, options);
    h.dependencies.findSessionByName = (dir, query) => findSessionByName(dir, query, options);
    const handlers = createMcpToolHandlers({ claudeDir, socketPath: "/virtual/conch.sock" }, h.dependencies);
    try {
      await expect(handlers.review_to_front({ summary: "stale id", session: "pred" }))
        .rejects.toThrow("refused: conch cannot verify which session is calling");
      expect(h.calls.daemon).toEqual([]);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  test("review_to_front from the attached window's own MCP server files under the job, not the window's stale id", async () => {
    // The window's MCP servers are children of the window, whose registry file
    // still names its old id. Its pid is the job row's route, so it is the job.
    const { claudeDir, h, handlers, windowPid } = await backgroundRegistry("window");
    try {
      await handlers.review_to_front({ summary: "unnamed" });
      await handlers.review_to_front({ summary: "named", session: "conch" });
      expect(h.calls.daemon.map((call) => call.event.sessionId)).toEqual(["succ", "succ"]);
      expect(h.calls.daemon.map((call) => call.event.pid)).toEqual([windowPid, windowPid]);
    } finally {
      rmSync(claudeDir, { recursive: true, force: true });
    }
  });
});

describe("C5: what conch refuses an agent, and what it still allows", () => {
  const runtime = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };

  async function refusal(run: () => Promise<unknown>): Promise<string> {
    let thrown: unknown;
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ToolInputError");
    return (thrown as Error).message;
  }

  test("config: every allowlisted key is real, and the key's description names them instead of 'curated'", () => {
    for (const key of AGENT_TUNABLE_SETTINGS) expect(SETTING_KEYS).toContain(key);
    // The tool description is the shared source's short one; the allowlist rides on `key`, in the same definition.
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "conch_config")!;
    const description = (tool.inputSchema.properties.key as { description: string }).description;
    for (const key of AGENT_TUNABLE_SETTINGS) expect(description).toContain(key);
    expect(description).not.toContain("curated");
    expect(tool.description).not.toContain("curated");
    // The security and topology keys the review named are out, by name.
    for (const key of ["bypass-permissions", "phone", "phone-relay-url", "meeting-autopause", "keystroke-fallback"]) {
      expect(AGENT_TUNABLE_SETTINGS as readonly string[]).not.toContain(key);
    }
  });

  test("config: setting or unsetting a key outside the allowlist is refused before the daemon hears of it", async () => {
    const h = fakeHarness();
    const handlers = createMcpToolHandlers(runtime, h.dependencies);

    const set = await refusal(() => handlers.conch_config({ key: "bypass-permissions", value: true }));
    expect(set).toContain('"bypass-permissions" is not a setting an agent may change');
    expect(set).toContain("conch set bypass-permissions <value>");
    for (const key of AGENT_TUNABLE_SETTINGS) expect(set).toContain(key);

    const unset = await refusal(() => handlers.conch_config({ key: "phone", unset: true }));
    expect(unset).toContain("conch unset phone");

    // A key the registry does not know at all gets the same refusal, not a lookup error.
    expect(await refusal(() => handlers.conch_config({ key: "bogus", value: 1 })))
      .toContain('"bogus" is not a setting an agent may change');
    expect(h.calls.control).toEqual([]);
  });

  test("config: an allowlisted key is set, and any key can still be read", async () => {
    const h = fakeHarness();
    const handlers = createMcpToolHandlers(runtime, h.dependencies);

    expect(JSON.parse(toolText(await callTool(handlers, "conch_config", { key: "end-silence", value: 2 }))))
      .toMatchObject({ kind: "config-ack", key: "end-silence", action: "set" });
    expect(JSON.parse(toolText(await callTool(handlers, "conch_config", { key: "bypass-permissions" }))))
      .toMatchObject({ kind: "config-value", key: "bypass-permissions" });
    expect(h.calls.control.map((call) => call.message.kind)).toEqual(["set-config", "get-config"]);
  });

  test(`speak: more than ${MAX_SPEAK_CHARS} characters is refused with the count, never cut`, async () => {
    const h = fakeHarness();
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    const tooLong = "x".repeat(MAX_SPEAK_CHARS + 1);
    const message = await refusal(() => handlers.conch_speak({ text: tooLong }));
    expect(message).toContain(`text is ${MAX_SPEAK_CHARS + 1} characters`);
    expect(message).toContain(`at most ${MAX_SPEAK_CHARS}`);
    expect(h.calls.daemon).toEqual([]);

    const exact = "y".repeat(MAX_SPEAK_CHARS);
    await callTool(handlers, "conch_speak", { text: exact });
    expect(h.calls.daemon.map((call) => call.event.announce)).toEqual([exact]);
  });

  test("speak: one pending speak per session — a second is refused until the first has had time to finish", async () => {
    const h = fakeHarness();
    let clock = 1_000_000;
    h.dependencies.now = () => clock;
    const handlers = createMcpToolHandlers(runtime, h.dependencies);

    await callTool(handlers, "conch_speak", { text: "Tests passed." });
    expect(await refusal(() => handlers.conch_speak({ text: "And again." })))
      .toContain("already speaking for this session");
    expect(h.calls.daemon).toHaveLength(1);

    clock += audioTimeoutMs("Tests passed.") - 1;
    expect(await refusal(() => handlers.conch_speak({ text: "Still too soon." })))
      .toContain("already speaking for this session");
    clock += 1;
    await callTool(handlers, "conch_speak", { text: "Now fine." });
    expect(h.calls.daemon.map((call) => call.event.announce)).toEqual(["Tests passed.", "Now fine."]);

    // A separate server is a separate session: nothing pending there.
    const sibling = createMcpToolHandlers(runtime, h.dependencies);
    await callTool(sibling, "conch_speak", { text: "Sibling speaks." });
    expect(h.calls.daemon).toHaveLength(3);
  });

  test("speak: a refused daemon send leaves nothing pending, so the retry is not refused", async () => {
    const h = fakeHarness({ daemonAccepts: false });
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    await expect(handlers.conch_speak({ text: "Hello" })).rejects.toThrow("conch daemon is not running");
    await expect(handlers.conch_speak({ text: "Hello" })).rejects.toThrow("conch daemon is not running");
    expect(h.calls.daemon).toHaveLength(2);
  });

  test("speak: held under a pause no agent made says so; what is sent is unchanged", async () => {
    const published = (mode: unknown) => JSON.stringify({ v: 1, ts: 1, mode });
    const speak = async (sessionsFile: string | null) => {
      const h = fakeHarness({ sessionsFile });
      const handlers = createMcpToolHandlers(runtime, h.dependencies);
      const result = JSON.parse(toolText(await callTool(handlers, "conch_speak", { text: "Tests passed." })));
      // The same event either way: the daemon decides, the tool only reports it.
      expect(h.calls.daemon.map((call) => call.event)).toEqual([
        { type: "speak", sessionId: "", label: "", announce: "Tests passed.", origin: "agent" },
      ]);
      expect(result.sent).toBe(true);
      return { result, handlers, h };
    };

    // Paused, and not by an agent: the daemon holds it (A17's test).
    const held = await speak(published({ muted: false, paused: true, holding: 0 }));
    expect(held.result.held).toContain("not spoken");
    expect(held.result.held).toContain("manual mode");
    expect(held.result.held).toContain("dropped, not queued");
    // Nothing is being spoken, so the next call is not refused as "already speaking".
    await callTool(held.handlers, "conch_speak", { text: "Again." });
    expect(held.h.calls.daemon).toHaveLength(2);

    for (const heard of [
      // An agent's own pause does not hold an agent's speech.
      published({ muted: false, paused: true, holding: 0, pausedByAgent: true }),
      published({ muted: false, paused: false, holding: 0 }),
      null,
    ]) expect((await speak(heard)).result).not.toHaveProperty("held");
  });

  function twoSessionHarness() {
    const alpha: SessionInfo = { sessionId: "session-a", name: "Alpha", cwd: "/work/alpha", status: "busy", pid: process.ppid };
    const beta: SessionInfo = { sessionId: "session-b", name: "Beta", cwd: "/work/beta", status: "busy", pid: process.ppid + 1 };
    const h = fakeHarness({
      registry: { infos: [alpha, beta], liveIds: new Set(["session-a", "session-b"]), complete: true },
    });
    h.dependencies.sessionLabel = (session) => session?.name ?? "unnamed";
    h.dependencies.findSessionByName = async (_dir, query) => query === "Beta" ? beta : alpha;
    return h;
  }

  test("mode: without session or scope it pauses only the calling session, through the scoped event", async () => {
    const h = twoSessionHarness();
    const handlers = createMcpToolHandlers(runtime, h.dependencies);

    await callTool(handlers, "conch_mode", { action: "pause" });
    await callTool(handlers, "conch_mode", { action: "resume", session: "Beta" });

    // The same message the Mac's per-row control sends: a pause that names a
    // session reaches setSessionPaused in the daemon, never the global flip.
    expect(h.calls.daemon.map((call) => call.event)).toEqual([
      { type: "pause", sessionId: "session-a", label: "Alpha", announce: "", origin: "agent" },
      { type: "resume", sessionId: "session-b", label: "Beta", announce: "", origin: "agent" },
    ]);
  });

  test("mode: the whole daemon needs scope \"all\", and nothing else is a scope", async () => {
    const h = twoSessionHarness();
    const handlers = createMcpToolHandlers(runtime, h.dependencies);

    await callTool(handlers, "conch_mode", { action: "pause", scope: "all" });
    expect(h.calls.daemon.map((call) => call.event)).toEqual([
      { type: "pause", sessionId: "", label: "", announce: "", origin: "agent" },
    ]);

    expect(await refusal(() => handlers.conch_mode({ action: "pause", scope: "all", session: "Beta" })))
      .toContain('session and scope: "all" cannot be used together');
    expect(await refusal(() => handlers.conch_mode({ action: "pause", scope: "everything" })))
      .toContain('scope must be "all"');
    expect(h.calls.daemon).toHaveLength(1);
  });

  test("mode: with no calling session and no session named, the refusal says how to ask", async () => {
    // fakeHarness's session has pid 4321, not this process's parent: a bare
    // `conch mcp` with no owner.
    const h = fakeHarness();
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    const message = await refusal(() => handlers.conch_mode({ action: "pause" }));
    expect(message).toContain("no calling session");
    expect(message).toContain('scope: "all"');
    expect(message).toContain("conch pause");
    expect(h.calls.daemon).toEqual([]);
  });

  test("wake and recite say where the audio went, from the published audioControl", async () => {
    const published = (control: unknown) => JSON.stringify({ v: 1, ts: 1, audioControl: control });
    const at = async (sessionsFile: string | null) => {
      const h = fakeHarness({ sessionsFile , parentPid: 4321 });
      const handlers = createMcpToolHandlers(runtime, h.dependencies);
      const wake = JSON.parse(toolText(await callTool(handlers, "conch_wake", {})));
      const recite = JSON.parse(toolText(await callTool(handlers, "conch_recite", { session: "Build" })));
      expect(wake.sent).toBe(true);
      expect(recite.sent).toBe(true);
      expect(recite.audio).toBe(wake.audio);
      expect(h.calls.daemon).toHaveLength(2);
      return wake.audio as string;
    };

    const local = await at(published({ holder: "local", revision: 3, expiresAt: null }));
    expect(local).toContain("this Mac");
    expect(local).toContain("phone");
    expect(local).not.toContain("refused");
    // An older daemon publishes no audioControl; no file at all is the same.
    expect(await at(published(undefined))).toBe(local);
    expect(await at(null)).toBe(local);

    const yielded = await at(published({ holder: "mac-b-device", revision: 4, expiresAt: null }));
    expect(yielded).toContain("refused");
    expect(yielded).toContain("yielded its audio to mac-b-device");
    expect(await at(published({ holder: "mac-b-device", revision: 4, expiresAt: 1_234_567 + 1 }))).toBe(yielded);
    // A lease that has already expired is local again, whatever the stale file says.
    expect(await at(published({ holder: "mac-b-device", revision: 4, expiresAt: 1_234_567 }))).toBe(local);
  });

  test("the contract doc names the allowlist, every refusal, the help session, and no 'curated'", () => {
    const doc = readFileSync(join(import.meta.dir, "..", "docs", "conch-control-skill.md"), "utf8");
    for (const key of AGENT_TUNABLE_SETTINGS) expect(doc).toContain(`\`${key}\``);
    expect(doc).not.toContain("curated");
    expect(doc).toContain("## What conch will refuse");
    for (const refusal of [
      "another session's",
      "non-executable",
      `${MAX_SPEAK_CHARS} characters`,
      "already speaking",
      'scope: "all"',
      "yielded",
      "not on the list",
    ]) {
      expect(doc).toContain(refusal);
    }
    expect(doc).toContain("conch help-session");
    expect(doc).toContain("absolute path");
  });
});

describe("caller binding: which session is calling, and what that allows", () => {
  const runtime = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };
  const alpha: SessionInfo = { sessionId: "session-a", name: "Alpha", cwd: "/work/alpha", status: "busy", pid: 4321 };
  const beta: SessionInfo = { sessionId: "session-b", name: "Beta", cwd: "/work/beta", status: "busy", pid: 5555 };

  /** `parentPid` plays this MCP server's parent process. */
  function harness(infos: SessionInfo[], parentPid: number) {
    const h = fakeHarness({
      parentPid,
      registry: { infos, liveIds: new Set(infos.map((session) => session.sessionId)), complete: true },
    });
    h.dependencies.sessionLabel = (session) => session?.name ?? session?.sessionId ?? "unnamed";
    h.dependencies.findSessionByName = async (_dir, query) =>
      infos.find((session) => session.name === query || session.sessionId === query) ?? null;
    return { h, handlers: createMcpToolHandlers(runtime, h.dependencies) };
  }

  async function caller(handlers: McpToolHandlers) {
    return JSON.parse(toolText(await callTool(handlers, "conch_sessions", {}))).caller;
  }

  async function refused(handlers: McpToolHandlers, name: McpToolName, args: Record<string, unknown>) {
    const response = await callTool(handlers, name, args);
    expect(rpcResult(response)).toMatchObject({ isError: true });
    return toolText(response);
  }

  test("the one row with the parent's pid is verified, and conch_sessions returns that beside the rows", async () => {
    const { handlers } = harness([alpha, beta], 4321);
    const state = JSON.parse(toolText(await callTool(handlers, "conch_sessions", {})));
    expect(state.caller).toEqual({ status: "verified", sessionId: "session-a", label: "Alpha" });
    expect(state.rows.map((row: { id: string }) => row.id)).toEqual(["session-a", "session-b"]);
  });

  test("a parent no row carries is unverified, with the reason", async () => {
    const { handlers } = harness([alpha, beta], 9999);
    expect(await caller(handlers)).toEqual({
      status: "unverified",
      reason: "its parent (pid 9999) is not a live session conch knows",
    });
  });

  test("a shared Codex app-server is unverified: no publishing, and no wake or recite of 'my' session", async () => {
    const hosted = (sessionId: string): SessionInfo => ({
      sessionId,
      backend: "codex",
      cwd: "/work/codex",
      pid: 0,
      noTerminal: appServerNoTerminal(74676),
    });
    const { h, handlers } = harness([hosted("thread-1"), hosted("thread-2")], 74676);

    const binding = await caller(handlers);
    expect(binding.status).toBe("unverified");
    expect(binding.reason).toContain("Codex app-server, which hosts many threads under one pid");
    expect(binding.reason).toContain("no thread identity in the request");

    const publish = await refused(handlers, "review_to_front", { summary: "mine", session: "thread-1" });
    expect(publish).toStartWith("refused: conch cannot verify which session is calling");
    expect(publish).toContain("Leave the result in your reply");
    expect(publish).toContain("`conch:review <one-line summary> | <link-or-path>`");
    expect(await refused(handlers, "review_to_front", { summary: "mine" })).toContain("cannot verify");
    expect(await refused(handlers, "conch_wake", {}))
      .toContain("conch_wake without `session` means your own session, and conch cannot verify");
    expect(await refused(handlers, "conch_recite", {})).toContain("conch_recite without `session`");
    expect(h.calls.daemon).toEqual([]);
  });

  /** A tools/call as a Codex client sends it: the calling thread rides in `_meta`, which the model cannot set. */
  async function codexCall(
    handlers: McpToolHandlers,
    name: McpToolName,
    args: Record<string, unknown>,
    turnMetadata: unknown,
  ) {
    return dispatchJsonRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, _meta: { callId: "call_1", "x-codex-turn-metadata": turnMetadata } },
    }, handlers);
  }
  const APP_SERVER = 74676;
  const desktopThread = (sessionId: string): SessionInfo => ({
    sessionId,
    backend: "codex",
    name: sessionId,
    cwd: "/work/codex",
    pid: 0,
    noTerminal: appServerNoTerminal(APP_SERVER),
  });

  test("an app-server thread that names itself in Codex's turn metadata is verified, and publishes and wakes as itself", async () => {
    const { h, handlers } = harness([desktopThread("thread-1"), desktopThread("thread-2")], APP_SERVER);
    const turn = { session_id: "thread-2", thread_id: "thread-2", turn_id: "turn-9" };

    const state = JSON.parse(toolText(await codexCall(handlers, "conch_sessions", {}, turn)));
    expect(state.caller).toEqual({ status: "verified", sessionId: "thread-2", label: "thread-2" });
    expect(rpcResult(await codexCall(handlers, "review_to_front", { summary: "the desktop fix" }, turn)))
      .not.toMatchObject({ isError: true });
    await codexCall(handlers, "conch_wake", {}, turn);
    expect(h.calls.daemon.map((call) => [call.event.type, call.event.sessionId]))
      .toEqual([["review-published", "thread-2"], ["wake", "thread-2"]]);
  });

  test("turn metadata sent as a JSON string is read the same way", async () => {
    const { handlers } = harness([desktopThread("thread-1"), desktopThread("thread-2")], APP_SERVER);
    const turn = JSON.stringify({ session_id: "thread-1", thread_id: "thread-1" });
    const state = JSON.parse(toolText(await codexCall(handlers, "conch_sessions", {}, turn)));
    expect(state.caller).toEqual({ status: "verified", sessionId: "thread-1", label: "thread-1" });
    // Unreadable metadata is absent, not an error.
    const garbled = JSON.parse(toolText(await codexCall(handlers, "conch_sessions", {}, "{not json")));
    expect(garbled.caller.reason).toContain("no thread identity in the request");
  });

  test("a thread id no live Codex row has stays unverified, even when a Claude row has that id", async () => {
    const claude: SessionInfo = { sessionId: "thread-9", name: "Claude", cwd: "/work/claude", pid: 4321 };
    const { h, handlers } = harness([desktopThread("thread-1"), claude], APP_SERVER);
    const turn = { thread_id: "thread-9" };
    const state = JSON.parse(toolText(await codexCall(handlers, "conch_sessions", {}, turn)));
    expect(state.caller).toEqual({
      status: "unverified",
      reason: "codex thread thread-9 not found among the live Codex sessions conch knows",
    });
    const publish = await codexCall(handlers, "review_to_front", { summary: "forged" }, turn);
    expect(rpcResult(publish)).toMatchObject({ isError: true });
    expect(toolText(publish)).toContain("cannot verify");
    expect(h.calls.daemon).toEqual([]);
  });

  test("a subagent thread binds only to its own thread, never its parent's", async () => {
    const { h, handlers } = harness([desktopThread("parent-thread")], APP_SERVER);
    const turn = { thread_id: "child-thread", parent_thread_id: "parent-thread", subagent_kind: "spawned" };
    const state = JSON.parse(toolText(await codexCall(handlers, "conch_sessions", {}, turn)));
    expect(state.caller.status).toBe("unverified");
    expect(state.caller.reason).toContain("codex thread child-thread not found");
    expect(rpcResult(await codexCall(handlers, "conch_wake", {}, turn))).toMatchObject({ isError: true });
    expect(h.calls.daemon).toEqual([]);
  });

  test("a pid two rows carry is unverified: it names neither", async () => {
    const { h, handlers } = harness([alpha, { ...beta, pid: 4321 }], 4321);
    expect((await caller(handlers)).reason).toBe(
      "its parent (pid 4321) runs 2 sessions (session-a, session-b), so the pid cannot say which one is calling",
    );
    expect(await refused(handlers, "review_to_front", { summary: "whose?" })).toContain("cannot verify");
    expect(h.calls.daemon).toEqual([]);
  });

  test("an unverified caller cannot publish under a session it names", async () => {
    const { h, handlers } = harness([alpha, beta], 9999);
    expect(await refused(handlers, "review_to_front", { summary: "trust me", session: "Alpha" }))
      .toContain("including one you name");
    expect(h.calls.daemon).toEqual([]);
  });

  test("a verified caller may name itself; another session, or a name that is not it, is refused", async () => {
    const { h, handlers } = harness([alpha, beta], 4321);
    await callTool(handlers, "review_to_front", { summary: "own", session: "Alpha" });
    expect(await refused(handlers, "review_to_front", { summary: "theirs", session: "Beta" }))
      .toBe('refused: a session can only surface its own work — you are "Alpha" (session-a), and "Beta" is "Beta". Omit `session` to surface your own deliverable.');
    expect(await refused(handlers, "review_to_front", { summary: "nobody", session: "Gamma" }))
      .toContain('"Gamma" does not name you alone');
    expect(h.calls.daemon.map((call) => call.event.sessionId)).toEqual(["session-a"]);
  });

  test("wake and recite without session go to the verified caller, never conch's last session", async () => {
    const { h, handlers } = harness([alpha, beta], 5555);
    await callTool(handlers, "conch_wake", {});
    await callTool(handlers, "conch_recite", {});
    expect(h.calls.daemon.map((call) => [call.event.type, call.event.sessionId, call.event.label]))
      .toEqual([["wake", "session-b", "Beta"], ["recite", "session-b", "Beta"]]);
  });

  test("wake and recite without session from an unverified caller are refused, and nothing is sent", async () => {
    const { h, handlers } = harness([alpha, beta], 9999);
    for (const tool of ["conch_wake", "conch_recite"] as const) {
      expect(await refused(handlers, tool, {})).toContain("Pass `session` with an id from conch_sessions");
    }
    // Naming one still works: that is the user's explicit request.
    await callTool(handlers, "conch_wake", { session: "Alpha" });
    expect(h.calls.daemon.map((call) => call.event.sessionId)).toEqual(["session-a"]);
  });

  test("an ambiguous name comes back refused with its candidates, and nothing is sent", async () => {
    const { h, handlers } = harness([alpha, beta], 4321);
    h.dependencies.findSessionByName = async (_dir, query) => {
      throw new AmbiguousSessionError(query, [
        { sessionId: "session-a", label: "Alpha" },
        { sessionId: "session-b", label: "Beta" },
      ]);
    };
    for (const tool of ["conch_wake", "conch_recite", "conch_transcript_tail"] as const) {
      expect(await refused(handlers, tool, { session: "a" })).toBe(
        '"a" matches 2 live sessions, so none was chosen; name one by id: session-a ("Alpha"), session-b ("Beta")',
      );
    }
    expect(await refused(handlers, "conch_mode", { action: "pause", session: "a" })).toContain("session-b (\"Beta\")");
    expect(h.calls.daemon).toEqual([]);
  });

  test("a publication's file must not be a key: refused with the reason, nothing sent", async () => {
    const root = await mkdtemp(join(tmpdir(), "conch-mcp-secret-"));
    try {
      await writeFile(join(root, "signing.p8"), "-----BEGIN PRIVATE KEY-----\n", { mode: 0o600 });
      const { h, handlers } = harness([alpha], 4321);
      expect(await refused(handlers, "review_to_front", { summary: "the key", link: join(root, "signing.p8") }))
        .toContain("a hidden file, in a hidden folder, or a key or certificate");
      expect(h.calls.daemon).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * Scene v1 (round 3): what the pill click should bring forward and what to
 * check there. Absent is auto, today's precedence. The handler refuses what the
 * schema cannot say with keywords every client accepts.
 */
describe("review_to_front's scene", () => {
  const link = "https://example.com/settings";
  const publish = async (args: Record<string, unknown>) => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({ claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" }, h.dependencies);
    const response = await callTool(handlers, "review_to_front", { summary: "the settings page", ...args });
    return { h, response };
  };

  test("a scene rides on the publication and comes back in the result", async () => {
    const scene = { v: 1, target: { kind: "conversation" }, inspect: "Check that Save stays reachable" } as const;
    const { h, response } = await publish({ link, scene });
    expect(h.calls.daemon[0]?.event.review).toEqual({ summary: "the settings page", link, scene });
    expect(JSON.parse(toolText(response))).toMatchObject({ outcome: "accepted", scene });
  });

  test("no scene publishes none, which the apps read as auto", async () => {
    const { h, response } = await publish({ link });
    expect(h.calls.daemon[0]?.event.review).toEqual({ summary: "the settings page", link });
    expect(JSON.parse(toolText(response))).not.toHaveProperty("scene");
  });

  test("an inspect of exactly the maximum is accepted, trimmed", async () => {
    const inspect = "x".repeat(200);
    const { h } = await publish({ scene: { v: 1, target: { kind: "auto" }, inspect: `  ${inspect}  ` } });
    expect(h.calls.daemon[0]?.event.review?.scene).toEqual({ v: 1, target: { kind: "auto" }, inspect });
  });

  test("each malformed scene is refused, says why, and publishes nothing", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ scene: { v: 1, target: { kind: "link" } } }, 'scene target.kind "link" needs a link to open'],
      [{ link, scene: { v: 1, target: { kind: "auto" }, inspect: "x".repeat(201) } }, "scene inspect is 201 characters; at most 200"],
      [{ link, scene: { v: 1, target: { kind: "auto" }, inspect: "   " } }, "scene inspect must be a non-empty string"],
      [{ link, scene: { v: 1, target: { kind: "link", ref: "tab-7" } } }, "scene target.ref is not accepted yet"],
      [{ link, scene: { v: 2, target: { kind: "auto" } } }, "scene v must be 1"],
      [{ link, scene: { v: 1, target: { kind: "simulator" } } }, "scene target.kind must be one of auto, link, conversation, terminal"],
      [{ link, scene: { v: 1, target: { kind: "auto" }, viewport: { width: 390 } } }, 'scene has unknown field "viewport"'],
      [{ link, scene: { v: 1 } }, "scene target must be an object with a kind"],
      [{ link, scene: "conversation" }, "scene must be an object"],
    ];
    for (const [args, reason] of cases) {
      const { h, response } = await publish(args);
      expect(rpcResult(response)).toMatchObject({ isError: true });
      expect(toolText(response)).toStartWith(`refused: ${reason}`);
      expect(h.calls.daemon).toEqual([]);
    }
  });

  test("the schema says what it can with keywords every client accepts, and reserves ref", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "review_to_front")!;
    const scene = (tool.inputSchema.properties as Record<string, any>).scene;
    expect(scene).toMatchObject({ type: "object", required: ["v", "target"], additionalProperties: false });
    expect(scene.properties.v).toEqual({ type: "integer", enum: [1] });
    expect(scene.properties.target).toMatchObject({ required: ["kind"], additionalProperties: false });
    expect(scene.properties.target.properties.kind.enum).toEqual(["auto", "link", "conversation", "terminal"]);
    expect(scene.properties.target.properties).not.toHaveProperty("ref");
    expect(scene.properties.inspect).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(scene.description).toContain("`target.ref` is reserved");
    expect(scene.description).toContain("not accepted");
  });

  // Agent ink: the rules themselves are agent-ink.test.ts; these prove the tool runs them.
  const cta: ReviewMark = { id: "cta", kind: "box", frame: { selector: ".hero .cta" }, label: "Moved up from the footer" };

  test("marks ride on the publication and come back in the result", async () => {
    const scene: ReviewScene = { v: 1, target: { kind: "link" }, marks: [cta] };
    const { h, response } = await publish({ link, scene });
    expect(h.calls.daemon[0]?.event.review).toEqual({ summary: "the settings page", link, scene });
    expect(JSON.parse(toolText(response))).toMatchObject({ outcome: "accepted", scene });
  });

  test("malformed marks are refused, say why, and publish nothing", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ scene: { v: 1, target: { kind: "auto" }, marks: [cta] } }, "scene marks[0] frame.selector names something in the linked page"],
      [{ link, scene: { v: 1, target: { kind: "auto" }, marks: [{ ...cta, color: "red" }] } }, 'scene marks[0] has unknown field "color"'],
      [{ link, scene: { v: 1, target: { kind: "auto" }, marks: [{ id: "a", kind: "pin", frame: { canvas: "c" }, at: [0, 2] }] } }, "scene marks[0] at must be [x, y]"],
    ];
    for (const [args, reason] of cases) {
      const { h, response } = await publish(args);
      expect(toolText(response)).toStartWith(`refused: ${reason}`);
      expect(h.calls.daemon).toEqual([]);
    }
  });

  test("a mark's image must pass the link's own check: a temp image is sent, a hidden one refused", async () => {
    const shown = mkdtempSync(join(tmpdir(), "conch-mcp-mark-"));
    const hidden = mkdtempSync(join(tmpdir(), ".conch-mcp-mark-"));
    try {
      writeFileSync(join(shown, "still.png"), "png");
      writeFileSync(join(hidden, "still.png"), "png");
      const on = (image: string): ReviewScene => ({ v: 1, target: { kind: "auto" }, marks: [{ id: "m", kind: "pin", frame: { image }, at: [0.5, 0.5] }] });
      const sent = await publish({ scene: on(join(shown, "still.png")) });
      expect(sent.h.calls.daemon[0]?.event.review?.scene).toEqual(on(join(shown, "still.png")));
      const refusedImage = await publish({ scene: on(join(hidden, "still.png")) });
      expect(toolText(refusedImage.response)).toStartWith("refused: scene marks[0] frame.image ");
      expect(toolText(refusedImage.response)).toContain("is a hidden file, in a hidden folder");
      expect(refusedImage.h.calls.daemon).toEqual([]);
    } finally {
      rmSync(shown, { recursive: true, force: true });
      rmSync(hidden, { recursive: true, force: true });
    }
  });

  test("a refused link publishes no marks", async () => {
    const { h, response } = await publish({ link: "/etc/hosts", scene: { v: 1, target: { kind: "link" }, marks: [cta] } });
    expect(toolText(response)).toStartWith("refused: ");
    expect(h.calls.daemon).toEqual([]);
  });

  test("the schema describes marks closed, with their caps", () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "review_to_front")!;
    const marks = (tool.inputSchema.properties as Record<string, any>).scene.properties.marks;
    expect(marks).toMatchObject({ type: "array", minItems: 1, maxItems: 12 });
    expect(marks.items).toMatchObject({ required: ["id", "kind", "frame"], additionalProperties: false });
    expect(marks.items.properties.kind.enum).toEqual(["arrow", "box", "ellipse", "highlight", "text", "pin", "stroke"]);
    expect(marks.items.properties.frame).toMatchObject({ additionalProperties: false });
    expect(Object.keys(marks.items.properties.frame.properties)).toEqual(["canvas", "image", "selector", "quote"]);
    expect(marks.items.properties.pts).toMatchObject({ minItems: 2, maxItems: 64 });
    expect(marks.items.properties.label).toMatchObject({ maxLength: 80 });
    expect(marks.description).toContain("conch colours marks itself");
  });
});

/**
 * An agent could not type a deliverable, could not get its id back, could not list its own
 * without a 271 KB conch_sessions dump, and nothing could remove one: Tyler had one taken off
 * by hand-editing reviews.json.
 */
describe("typed deliverables: filing, listing and removing your own", () => {
  const runtime = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };
  const page = artifactIdentity("https://x.test/page");
  const published = JSON.stringify({
    v: 1,
    rows: [
      // Another session's row first, so reading "the first row" would read theirs.
      {
        id: "session-other",
        label: "Other",
        reviews: [{ summary: "not yours", at: 4_000, id: "o-1", artifact: "other-art", version: 1, kind: "image" }],
      },
      {
        id: "session-123",
        label: "Build",
        reviews: [
          { summary: "page v1", link: "https://x.test/page", at: 1_000, id: "p-1", artifact: page, version: 1, kind: "url", viewedAt: 1_500 },
          { summary: "the sim", at: 2_000, id: "s-1", artifact: artifactIdentity("onboarding"), version: 1, kind: "simulator" },
          { summary: "page v2", link: "https://x.test/page", at: 3_000, id: "p-2", artifact: page, version: 2, kind: "url" },
        ],
      },
    ],
  });

  test("review_to_front takes a kind and a key, and returns the handles the daemon will file it under", async () => {
    const h = fakeHarness({ parentPid: 4321, sessionsFile: published });
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    const next = JSON.parse(toolText(await callTool(handlers, "review_to_front", { summary: "page v3", link: "https://x.test/page#hero" })));
    // The same page, so its next version, one past the highest held.
    expect(next).toMatchObject({ outcome: "accepted", artifact: page, version: 3, kind: "url" });
    expect(next.id).toBe(reviewIdentity("session-123", { summary: "page v3", link: "https://x.test/page#hero", at: 1_234_567 }));

    const sim = JSON.parse(toolText(await callTool(handlers, "review_to_front", {
      summary: "the onboarding flow, second screen", kind: "simulator", key: "onboarding",
    })));
    expect(sim).toMatchObject({ artifact: artifactIdentity("onboarding"), version: 2, kind: "simulator" });
    expect(sim).not.toHaveProperty("link");
    // Only what the agent said travels; the daemon infers the rest by the same rules.
    expect(h.calls.daemon.map((call) => call.event.review)).toEqual([
      { summary: "page v3", link: "https://x.test/page#hero" },
      { summary: "the onboarding flow, second screen", kind: "simulator", key: "onboarding" },
    ]);
  });

  test("review_to_front refuses a kind it does not know, a file kind with no link, and an overlong key", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    expect(toolText(await callTool(handlers, "review_to_front", { summary: "x", kind: "hologram" })))
      .toContain("kind must be one of page, image");
    expect(toolText(await callTool(handlers, "review_to_front", { summary: "x", kind: "image" })))
      .toContain('kind "image" needs a link');
    expect(toolText(await callTool(handlers, "review_to_front", { summary: "x", kind: "app", key: "k".repeat(201) })))
      .toContain("key must be 1 to 200");
    expect(h.calls.daemon).toEqual([]);
  });

  test("conch_deliverables lists only the caller's own, newest first, and says what is superseded", async () => {
    const h = fakeHarness({ parentPid: 4321, sessionsFile: published });
    const listed = JSON.parse(toolText(await callTool(createMcpToolHandlers(runtime, h.dependencies), "conch_deliverables", {})));
    expect(listed).toEqual({
      sessionId: "session-123",
      deliverables: [
        { id: "p-2", artifact: page, version: 2, kind: "url", summary: "page v2", link: "https://x.test/page", at: 3_000, superseded: false },
        { id: "s-1", artifact: artifactIdentity("onboarding"), version: 1, kind: "simulator", summary: "the sim", at: 2_000, superseded: false },
        { id: "p-1", artifact: page, version: 1, kind: "url", summary: "page v1", link: "https://x.test/page", at: 1_000, viewedAt: 1_500, superseded: true },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("not yours");
  });

  test("conch_deliverables and review_remove refuse a caller conch cannot verify", async () => {
    const h = fakeHarness({ parentPid: 0, sessionsFile: published });
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    expect(toolText(await callTool(handlers, "conch_deliverables", {}))).toContain("refused: conch cannot verify");
    expect(toolText(await callTool(handlers, "review_remove", { id: "p-1" }))).toContain("refused: conch cannot verify");
    expect(h.calls.control).toEqual([]);
  });

  test("review_remove removes from the caller's own session only, by id or by artifact", async () => {
    const h = fakeHarness({ parentPid: 4321, sessionsFile: published });
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    h.dependencies.sendControlMessage = async (socketPath, message) => {
      h.calls.control.push({ socketPath, message });
      if (message.kind !== "session-command") throw new Error("unexpected");
      return { ok: true, response: { kind: "session-ack", sessionId: message.sessionId, command: message.command, changed: true } };
    };
    expect(JSON.parse(toolText(await callTool(handlers, "review_remove", { id: "p-1" }))))
      .toEqual({ outcome: "removed", sessionId: "session-123", id: "p-1" });
    expect(JSON.parse(toolText(await callTool(handlers, "review_remove", { artifact: page }))))
      .toEqual({ outcome: "removed", sessionId: "session-123", artifact: page });
    // Another session's id goes to YOUR session, where it matches nothing: there is no way to name theirs.
    await callTool(handlers, "review_remove", { id: "o-1" });
    expect(toolText(await callTool(handlers, "review_remove", { id: "o-1", session: "Other" }))).toContain('unknown argument "session"');
    expect(h.calls.control.map((call) => call.message)).toEqual([
      { kind: "session-command", sessionId: "session-123", command: "review-remove", review: "p-1" },
      { kind: "session-command", sessionId: "session-123", command: "review-remove", artifact: page },
      { kind: "session-command", sessionId: "session-123", command: "review-remove", review: "o-1" },
    ]);
  });

  test("review_remove passes the daemon's refusal on in its words, and needs exactly one of id or artifact", async () => {
    const refusal = 'nothing removed: "Build" holds no deliverable with id o-1';
    const h = fakeHarness({ parentPid: 4321, controlResult: { ok: true, response: { kind: "session-error", error: refusal } } });
    const handlers = createMcpToolHandlers(runtime, h.dependencies);
    expect(toolText(await callTool(handlers, "review_remove", { id: "o-1" }))).toBe(refusal);
    expect(toolText(await callTool(handlers, "review_remove", {}))).toContain("exactly one of id");
    expect(toolText(await callTool(handlers, "review_remove", { id: "a", artifact: "b" }))).toContain("exactly one of id");
    const down = fakeHarness({ parentPid: 4321, controlResult: { ok: false, reason: "daemon-down" } });
    expect(toolText(await callTool(createMcpToolHandlers(runtime, down.dependencies), "review_remove", { id: "a" })))
      .toContain("daemon is not running, so nothing was removed");
  });
});

/**
 * conch_capture (page-capture.ts): an agent names a page and the part of it to show, and conch draws it in its Mac app.
 * The tool checks everything it can before anything reaches the daemon, sends the page as an absolute, checked address,
 * and turns the daemon's answer into what the agent needs: the picture, the target's box, the marks ready for
 * review_to_front, what was filed, or why there is nothing, in words.
 */
describe("conch_capture", () => {
  const runtime = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };
  const shot = {
    path: "/Users/t/Library/Application Support/conch/captures/r1.png",
    width: 896,
    height: 416,
    devicePixelRatio: 2,
    element: { x: 48, y: 48, w: 800, h: 320 },
    finalUrl: "https://acme.dev/pricing",
    title: "Pricing",
    loginWall: false,
  };
  function harness(options: { parentPid?: number; session?: SessionInfo; reply?: PageCaptureReply; send?: PageCaptureSend } = {}) {
    const h = fakeHarness({ parentPid: options.parentPid ?? 4321, ...(options.session ? { session: options.session } : {}) });
    const sent: Array<{ socketPath: string; message: PageCaptureMessage; timeoutMs?: number }> = [];
    const dependencies: McpDependencies = {
      ...h.dependencies,
      async capturePage(socketPath, message, timeoutMs) {
        sent.push({ socketPath, message, timeoutMs });
        return options.send ?? { ok: true, reply: options.reply ?? { kind: "page-capture-result", capture: shot } };
      },
    };
    return { handlers: createMcpToolHandlers(runtime, dependencies), sent, calls: h.calls };
  }

  test("refuses what it can tell is wrong before the daemon hears of it", async () => {
    const { handlers, sent } = harness();
    const refusals: Array<[Record<string, unknown>, string]> = [
      [{}, "url must be a non-empty string"],
      [{ url: "javascript:alert(1)" }, "not a javascript: link"],
      [{ url: "localhost:3000" }, "http://localhost:<port>"],
      [{ url: "/nowhere/at/all/page.html" }, "it does not exist"],
      [{ url: "package.json" }, "is not an .html page"],
      [{ url: "https://acme.dev", target: { selector: "#a", quote: "b" } }, "exactly one of {selector} or {quote}"],
      [{ url: "https://acme.dev", target: { selector: "" } }, "target.selector must be one line"],
      [{ url: "https://acme.dev", target: { quote: "x".repeat(121) } }, "target.quote must be one line of 1 to 120"],
      [{ url: "https://acme.dev", viewport: { width: 100, height: 900 } }, "width 320-3840"],
      [{ url: "https://acme.dev", viewport: { width: 1440.5, height: 900 } }, "whole CSS pixels"],
      [{ url: "https://acme.dev", fullPage: "yes" }, "fullPage must be true or false"],
      [{ url: "https://acme.dev", mark: "box" }, "pass target"],
      [{ url: "https://acme.dev", target: { selector: "#a" }, mark: "circle" }, "mark kind must be one of"],
      [{ url: "https://acme.dev", target: { selector: "#a" }, mark: { kind: "text" } }, "a text mark needs a label"],
      [{ url: "https://acme.dev", target: { selector: "#a" }, mark: { kind: "box", colour: "red" } }, 'mark must be "box"'],
      [{ url: "https://acme.dev", publish: { summary: "" } }, "summary must be a non-empty string"],
      [{ url: "https://acme.dev", publish: { summary: "x", link: "/tmp/x" } }, 'unknown argument "link"'],
      [{ url: "https://acme.dev", session: "Other" }, 'unknown argument "session"'],
    ];
    for (const [args, reason] of refusals) {
      const response = await callTool(handlers, "conch_capture", args);
      expect(rpcResult(response), JSON.stringify(args)).toMatchObject({ isError: true });
      expect(toolText(response), JSON.stringify(args)).toContain(reason);
    }
    expect(sent).toEqual([]);
  });

  test("a capture alone needs no verified caller; filing one as a deliverable does", async () => {
    const unverified = harness({ parentPid: 0 });
    expect(JSON.parse(toolText(await callTool(unverified.handlers, "conch_capture", { url: "https://acme.dev/pricing" }))))
      .toMatchObject({ outcome: "captured", path: shot.path });
    expect(unverified.sent[0]!.message).not.toHaveProperty("publish");
    const refused = await callTool(unverified.handlers, "conch_capture", { url: "https://acme.dev", publish: { summary: "the pricing table" } });
    expect(toolText(refused)).toContain("cannot verify which session is calling");
    expect(unverified.sent).toHaveLength(1);
  });

  test("sends the page, the target, the size and the mark as the daemon decodes them, defaults filled in", async () => {
    const { handlers, sent } = harness();
    await callTool(handlers, "conch_capture", { url: "https://acme.dev/pricing", target: { selector: ".plan-pro" }, mark: "box" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.socketPath).toBe(runtime.socketPath);
    // Past the daemon's own deadline, so its words arrive first.
    expect(sent[0]!.timeoutMs).toBe(50_000);
    expect(sent[0]!.message).toMatchObject({
      kind: "page-capture",
      url: "https://acme.dev/pricing",
      target: { selector: ".plan-pro" },
      viewport: { width: 1440, height: 900 },
      fullPage: false,
      mark: { kind: "box" },
    });
    expect(Array.isArray(sent[0]!.message.roots)).toBe(true);
  });

  test("a local page is sent as its absolute path, checked against the session's folders", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "conch-capture-page-")));
    try {
      await mkdir(join(dir, "site"));
      await writeFile(join(dir, "site", "index.html"), "<h1>hi</h1>");
      const session: SessionInfo = { sessionId: "session-123", cwd: dir, pid: 4321, status: "idle" };
      const { handlers, sent } = harness({ session });
      // Relative to the folder the session is in (here, with no transcript to say, where this server started).
      const local = await callTool(handlers, "conch_capture", { url: relative(process.cwd(), join(dir, "site", "index.html")), viewport: { width: 390, height: 844 }, fullPage: true });
      expect(rpcResult(local), toolText(local)).not.toMatchObject({ isError: true });
      const byUrl = await callTool(handlers, "conch_capture", { url: `file://${dir}/site/index.html` });
      expect(rpcResult(byUrl), toolText(byUrl)).not.toMatchObject({ isError: true });
      expect(sent.map((one) => one.message.url)).toEqual([join(dir, "site", "index.html"), join(dir, "site", "index.html")]);
      expect(sent[0]!.message).toMatchObject({ viewport: { width: 390, height: 844 }, fullPage: true });
      expect(sent[0]!.message.roots).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publish carries the verified session as review_to_front would, and the filing comes back", async () => {
    const filed = { id: "session-123:9:abc", artifact: "capture https://acme.dev/pricing .plan-pro", version: 2, kind: "image" as const, summary: "the Pro plan card" };
    const marks: ReviewMark[] = [{ id: "capture", kind: "box", frame: { image: shot.path }, rect: [0.0357, 0.0769, 0.9286, 0.8462] }];
    const { handlers, sent, calls } = harness({ reply: { kind: "page-capture-result", capture: shot, marks, filed } });
    const result = JSON.parse(toolText(await callTool(handlers, "conch_capture", {
      url: "https://acme.dev/pricing",
      target: { selector: ".plan-pro" },
      mark: "box",
      publish: { summary: "the Pro plan card", key: "pricing-pro" },
    })));
    expect(sent[0]!.message.publish).toEqual({
      sessionId: "session-123",
      label: "Build label",
      cwd: "/work/build",
      pid: 4321,
      transcriptPath: "/virtual/session-123.jsonl",
      transcriptMark: 7,
      summary: "the Pro plan card",
      key: "pricing-pro",
    });
    expect(calls.daemon).toEqual([]);
    expect(result).toEqual({
      outcome: "captured",
      path: shot.path,
      width: 896,
      height: 416,
      devicePixelRatio: 2,
      element: shot.element,
      finalUrl: shot.finalUrl,
      title: "Pricing",
      marks,
      filed,
    });
  });

  test("a sign-in screen, a clipped target and an unsettled page are said, with the fix", async () => {
    const { handlers } = harness({
      reply: {
        kind: "page-capture-result",
        capture: { ...shot, loginWall: true, clipped: true, unsettled: true },
        notFiled: "the page showed a sign-in screen, so it wasn't filed as your deliverable",
      },
    });
    const result = JSON.parse(toolText(await callTool(handlers, "conch_capture", { url: "https://acme.vercel.app", publish: { summary: "x" } })));
    expect(result).toMatchObject({ outcome: "captured", loginWall: true, clipped: true, unsettled: true });
    expect(result.note).toContain("open it in conch's window and sign in there once");
    expect(result.note).toContain("then capture again");
    expect(result.note).toContain("its own review pane, not your browser's");
    expect(result.note).toContain("wasn't filed");
    expect(result.note).toContain("fullPage");
    expect(result).not.toHaveProperty("filed");
  });

  test("no capture: the daemon's reason, what the page was, and a picture of it", async () => {
    const { handlers } = harness({
      reply: {
        kind: "page-capture-error",
        error: 'nothing on the page matches the selector ".plan-pro"',
        seen: { path: "/c/r1-seen.png", finalUrl: "https://vercel.com/login", title: "Log in to Vercel", loginWall: true, headings: ["Log in to Vercel"] },
      },
    });
    const response = await callTool(handlers, "conch_capture", { url: "https://acme.vercel.app", target: { selector: ".plan-pro" } });
    expect(rpcResult(response)).toMatchObject({ isError: true });
    const text = toolText(response);
    expect(text).toStartWith('failed: nothing on the page matches the selector ".plan-pro"');
    expect(text).toContain('What conch got: "Log in to Vercel" at https://vercel.com/login');
    expect(text).toContain('Its headings: "Log in to Vercel"');
    expect(text).toContain("showed a sign-in screen");
    expect(text).toContain("A picture of what it showed: /c/r1-seen.png");
  });

  test("the Mac app not running, and the daemon not running, are each said plainly", async () => {
    const app = harness({ reply: { kind: "page-capture-error", error: MAC_APP_DOWN } });
    expect(toolText(await callTool(app.handlers, "conch_capture", { url: "https://acme.dev" })))
      .toBe("failed: conch's Mac app isn't running, so it can't render pages; open it and try again.");
    const daemon = harness({ send: { ok: false, reason: "daemon-down" } });
    expect(toolText(await callTool(daemon.handlers, "conch_capture", { url: "https://acme.dev" })))
      .toBe("failed: conch daemon is not running, so nothing was captured");
  });

  test("conch_sessions doesn't hand an agent the Mac app's drawing list", async () => {
    const published = { v: 1, ts: 1, mode: { muted: false, paused: false, holding: 0 }, live: { state: "idle", label: "" }, rows: [], dismissed: [],
      captureRequests: [{ id: "r1", url: "https://acme.dev", viewport: { width: 1440, height: 900 }, fullPage: false, folder: "/c", deadline: 1 }] };
    const h = fakeHarness({ parentPid: 4321, sessionsFile: JSON.stringify(published) });
    const state = JSON.parse(toolText(await callTool(createMcpToolHandlers(runtime, h.dependencies), "conch_sessions", {})));
    expect(state).not.toHaveProperty("captureRequests");
    expect(state.rows).toEqual([]);
  });
});

/**
 * `review_to_front` used to send fire-and-forget and say "accepted" with a version it predicted, whatever the daemon
 * then did. It waits for the daemon's verdict now (review-verdict.ts), returns what was really filed and who can see it
 * (`surfaces`), and says a refusal in the daemon's own words.
 */
describe("review_to_front waits for the daemon's verdict", () => {
  const runtime = { claudeDir: "/virtual/claude", socketPath: "/virtual/conch.sock" };
  const surfaces = { mac: "running", phone: "paired-not-connected", audio: "mac" } as const;
  const withVerdict = (reply: (event: TurnEvent) => PublishReply, over: Partial<McpDependencies> = {}, options: FakeOptions = {}) => {
    const h = fakeHarness({ parentPid: 4321, ...options });
    const sent: TurnEvent[] = [];
    const dependencies: McpDependencies = {
      ...h.dependencies,
      async publishForVerdict(_socket, event) {
        sent.push(event);
        return reply(event);
      },
      ...over,
    };
    return { h, sent, handlers: createMcpToolHandlers(runtime, dependencies) };
  };

  test("filed: the daemon's id, version and link, the original it copied, and where the user can see it", async () => {
    const { handlers, sent } = withVerdict(() => ({
      kind: "verdict",
      verdict: {
        kind: "review-filed",
        filing: { id: "daemon-id", artifact: "art-1", version: 4, kind: "image", link: "/cfg/deliverables/art-1/v4-x/hero.png" },
        copiedFrom: "/tmp/hero.png",
        surfaces,
      },
    }));
    const result = JSON.parse(toolText(await callTool(handlers, "review_to_front", { summary: "the hero", link: "https://x.test/hero" })));
    expect(result).toEqual({
      outcome: "filed",
      sessionId: "session-123",
      label: "Build label",
      id: "daemon-id",
      artifact: "art-1",
      version: 4,
      kind: "image",
      link: "/cfg/deliverables/art-1/v4-x/hero.png",
      copiedFrom: "/tmp/hero.png",
      surfaces,
      summary: "the hero",
    });
    // What was sent is the publication itself; asking for the verdict is the client's (`publishForVerdict`).
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "review-published", sessionId: "session-123", review: { summary: "the hero", link: "https://x.test/hero" } });
  });

  test("a temp file the daemon could not copy says why, and the user is told it may go", async () => {
    const notCopied = "it was filed where it is, not copied into conch: it comes to more than 64 MB or 500 files, over what conch copies;"
      + " a temp folder can be cleaned (a reboot empties /tmp), and it goes with it";
    const { handlers } = withVerdict(() => ({
      kind: "verdict",
      verdict: { kind: "review-filed", filing: { id: "i", artifact: "a", version: 1, kind: "video", link: "/tmp/big.mov" }, notCopied, surfaces },
    }));
    expect(JSON.parse(toolText(await callTool(handlers, "review_to_front", { summary: "the demo", link: "https://x.test/demo" }))))
      .toMatchObject({ outcome: "filed", notCopied, link: "/tmp/big.mov" });
  });

  test("refused by the daemon: the call fails with its reason, where it used to say accepted", async () => {
    const { handlers } = withVerdict(() => ({
      kind: "verdict",
      verdict: { kind: "review-refused", reason: "the user dismissed this session from conch, so nothing it publishes is shown until they restore it" },
    }));
    const response = await callTool(handlers, "review_to_front", { summary: "the hero", link: "https://x.test/hero" });
    expect(rpcResult(response)).toMatchObject({ isError: true });
    expect(toolText(response)).toBe("refused: conch's daemon did not file it: the user dismissed this session from conch, so nothing it publishes is shown until they restore it");
  });

  test("no daemon is a failure; a daemon that took it without a word is accepted, unconfirmed, with predicted handles", async () => {
    const down = withVerdict(() => ({ kind: "down" }));
    const failed = await callTool(down.handlers, "review_to_front", { summary: "x" });
    expect(toolText(failed)).toBe("failed: conch daemon is not running, so nothing was published");
    const older = withVerdict(() => ({ kind: "unconfirmed", why: "this conch daemon is older and does not say whether it filed a publication" }));
    const result = JSON.parse(toolText(await callTool(older.handlers, "review_to_front", { summary: "the sim", kind: "simulator" })));
    expect(result).toMatchObject({
      outcome: "accepted",
      unconfirmed: "this conch daemon is older and does not say whether it filed a publication; the id and version below are predicted, and conch_deliverables says what was filed",
      version: 1,
      kind: "simulator",
    });
    expect(result.surfaces).toBeUndefined();
  });

  test("a label its work drifted from is offered for renaming once, never for the user's own, and again for a new label", async () => {
    let label = "Remove Jaidon from blueprintstudio.ai";
    let source: "user" | "agent" | "folder" = "agent";
    const held = (summaries: string[]) => JSON.stringify({ v: 1, rows: [{ id: "session-123", label, reviews: summaries.map((summary, n) => ({
      summary, id: `r-${n}`, at: n, artifact: `a-${n}`, version: 1, kind: "other",
    })) }] });
    let published = held(["Hero with the new headline"]);
    const filed = (): PublishReply => ({ kind: "verdict", verdict: { kind: "review-filed", filing: { id: "i", artifact: "a", version: 1, kind: "other" }, surfaces } });
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers(runtime, {
      ...h.dependencies,
      readSessionsFile: async () => published,
      sessionLabel: () => label,
      labelSource: () => source,
      publishForVerdict: async () => filed(),
    });
    const publish = async (summary: string) => JSON.parse(toolText(await callTool(handlers, "review_to_front", { summary })));
    expect((await publish("Team photo swapped on the about section")).relabel).toEqual({
      label,
      hint: `Your session is still labelled '${label}' but your recent work is about 'Team photo swapped on the about section'. If the focus has moved, call conch_rename with a short new label.`,
    });
    published = held(["Hero with the new headline", "Team photo swapped on the about section"]);
    expect((await publish("Headline copy final")).relabel).toBeUndefined();
    // The user's own label is never second-guessed.
    label = "my hero work";
    source = "user";
    published = held(["Invoices", "Billing export"]);
    expect((await publish("CSV columns")).relabel).toBeUndefined();
    // A new label the agent's side chose starts afresh.
    source = "agent";
    label = "Hero headline";
    expect((await publish("CSV columns")).relabel?.label).toBe("Hero headline");
  });

  test("marks in pixels are sent as fractions of the image they are measured on", async () => {
    const folder = mkdtempSync(join(tmpdir(), "conch-mcp-px-"));
    try {
      const shot = join(folder, "shot.png");
      const header = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
      header.write("IHDR", 12, "latin1");
      header.writeUInt32BE(2000, 16);
      header.writeUInt32BE(1000, 20);
      writeFileSync(shot, header);
      const { handlers, sent } = withVerdict(() => ({ kind: "verdict", verdict: { kind: "review-filed", filing: { id: "i", artifact: "a", version: 1, kind: "image", link: shot }, surfaces } }));
      const scene = { v: 1, target: { kind: "link" }, marks: [
        { id: "a", kind: "arrow", frame: { image: shot }, at: [0, 0], to: [1000, 500], units: "px" },
        { id: "b", kind: "box", frame: { image: shot }, rect: [100, 100, 200, 100], units: "px", size: [1000, 500] },
        { id: "c", kind: "pin", frame: { image: shot }, at: [0.5, 0.5] },
      ] };
      const response = await callTool(handlers, "review_to_front", { summary: "the shot", link: shot, scene });
      expect(rpcResult(response)).not.toMatchObject({ isError: true });
      expect(sent[0]?.review?.scene?.marks).toEqual([
        { id: "a", kind: "arrow", frame: { image: shot }, at: [0, 0], to: [0.5, 0.5] },
        { id: "b", kind: "box", frame: { image: shot }, rect: [0.1, 0.2, 0.2, 0.2] },
        { id: "c", kind: "pin", frame: { image: shot }, at: [0.5, 0.5] },
      ]);
      const outside = await callTool(handlers, "review_to_front", { summary: "the shot", link: shot, scene: {
        v: 1, target: { kind: "link" }, marks: [{ id: "x", kind: "pin", frame: { image: shot }, at: [2400, 10], units: "px" }],
      } });
      expect(toolText(outside)).toBe("refused: scene marks[0] at reaches outside the 2000×1000 image it is measured on");
      expect(sent).toHaveLength(1);
      // The schema says so, and no longer caps the numbers at 1.
      const marks = (MCP_TOOLS.find((tool) => tool.name === "review_to_front")!.inputSchema.properties as Record<string, any>).scene.properties.marks;
      expect(marks.items.properties.units).toMatchObject({ type: "string", enum: ["px"] });
      expect(marks.items.properties.size).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
      expect(marks.items.properties.rect.items).toEqual({ type: "number", minimum: 0 });
      expect(marks.description).toContain('or pixels with units "px"');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

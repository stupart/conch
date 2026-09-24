import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { CONCH_VERSION } from "../src/version.ts";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";
import {
  AGENT_TUNABLE_SETTINGS,
  MAX_SPEAK_CHARS,
  MCP_PROTOCOL_VERSION,
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
  test("tools/list returns exactly the fifteen tools with valid closed schemas", async () => {
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
    expect(result.tools).toHaveLength(15);
    expect(new Set(result.tools.map((tool: unknown) => isRecord(tool) ? tool.name : null)).size).toBe(15);
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
      review_to_front: ["summary", "link", "kind", "key", "session", "scene"],
      conch_history: ["session", "branch", "before", "limit"],
      conch_item: ["session", "item", "bodyCursor"],
      conch_working_folders: ["folders"],
      conch_on_screen: [],
      conch_deliverables: [],
      review_remove: ["id", "artifact"],
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

  test("review_to_front describes publishing, not opening or finishing", () => {
    expect(MCP_TOOLS.find((tool) => tool.name === "review_to_front")!.description).toBe(
      "Publish your session’s result for the user to inspect, with a concise summary, an optional artifact link and kind, and an optional scene: the conversation to bring forward, or marks drawn over the result at the one thing to check. Publishing the same artifact again (the same link, or the same key) adds its next version rather than a second entry: the user sees the newest, with earlier versions listed under it by summary and time. Returns the filing's id, its artifact, version and kind. The user's pill click stages it. Publishing does not open applications or finish the running turn.",
    );
  });
});

describe("MCP dispatch", () => {
  test("initialize advertises the supported protocol and tool capability", async () => {
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
    });
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
    const directory = join(root, "directory");
    const executableFile = join(root, "review.sh");
    try {
      await writeFile(regularFile, "<h1>Review</h1>", { mode: 0o600 });
      await mkdir(directory);
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
        directory,
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

  test("review_to_front says it was accepted, and reports a summary it had to cut", async () => {
    const h = fakeHarness({ parentPid: 4321 });
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    const long = await callTool(handlers, "review_to_front", { summary: "x".repeat(250), session: "Build" });
    expect(JSON.parse(toolText(long))).toEqual({
      outcome: "accepted",
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

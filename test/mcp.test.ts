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
import { join } from "node:path";
import {
  MCP_PROTOCOL_VERSION,
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
import {
  SETTING_DESCRIPTORS,
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
import type { RegistrySnapshot, SessionInfo } from "../src/sessions.ts";

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
  daemon: Array<{ socketPath: string; event: TurnEvent }>;
  control: Array<{ socketPath: string; message: ControlMessage }>;
  marks: string[];
  assistantReads: string[];
  sentenceSplits: string[];
  opened: string[];
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
    daemon: [],
    control: [],
    marks: [],
    assistantReads: [],
    sentenceSplits: [],
    opened: [],
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
    async sendToDaemon(socketPath, event) {
      calls.daemon.push({ socketPath, event });
      return options.daemonAccepts ?? true;
    },
    async sendControlMessage(socketPath, message) {
      calls.control.push({ socketPath, message });
      if (options.controlResult) return options.controlResult;
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
    openLink(link) {
      calls.opened.push(link);
    },
    now: () => 1_234_567,
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

describe("MCP tool discovery", () => {
  test("tools/list returns exactly the nine safe tools with valid closed schemas", async () => {
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
    expect(result.tools).toHaveLength(9);
    expect(new Set(result.tools.map((tool: unknown) => isRecord(tool) ? tool.name : null)).size).toBe(9);
    for (const deferred of DEFERRED_TOOL_NAMES) {
      expect(result.tools.some((tool: unknown) => isRecord(tool) && tool.name === deferred)).toBe(false);
    }

    const expectedProperties: Record<McpToolName, string[]> = {
      conch_sessions: [],
      conch_wake: ["session"],
      conch_recite: ["session"],
      conch_speak: ["text", "voice"],
      conch_mode: ["action"],
      conch_rename: ["session", "label"],
      conch_config: ["key", "value", "unset"],
      conch_transcript_tail: ["session", "sentences"],
      review_to_front: ["summary", "link", "session"],
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
  test("the production review launcher terminates open options before the link", () => {
    const bun = Bun as any;
    const originalSpawn = bun.spawn;
    const calls: unknown[][] = [];
    bun.spawn = (args: unknown[]) => {
      calls.push(args);
      return {};
    };
    try {
      defaultMcpDependencies.openLink("--looks-like-an-option");
      expect(calls).toEqual([["open", "--", "--looks-like-an-option"]]);
    } finally {
      bun.spawn = originalSpawn;
    }
  });

  test("sessions uses the published file unchanged and does not touch the registry", async () => {
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

    expect(JSON.parse(toolText(response))).toEqual(published);
    expect(h.calls.sessionsFiles).toEqual(["/virtual/conch-sessions.json"]);
    expect(h.calls.registries).toEqual([]);
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
    });
    expect(h.calls.registries).toEqual(["/virtual/claude"]);
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
    await callTool(handlers, "conch_mode", { action: "pause" });

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
        },
      },
      {
        socketPath: "/virtual/conch.sock",
        event: {
          type: "pause",
          sessionId: "",
          label: "",
          announce: "",
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
    expect(toolText(tail)).toBe("Second! Third? Fourth.");
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

  test("review_to_front sends the exact review turn before opening its link", async () => {
    const h = fakeHarness();
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
      type: "turn-end",
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
    expect(h.calls.opened).toEqual([link]);
  });

  test("review_to_front requires the worker session and lists live session labels", async () => {
    const h = fakeHarness({
      registry: {
        infos: [
          {
            sessionId: "session-a",
            name: "Alpha",
            cwd: "/work/alpha",
            status: "busy",
          },
          {
            sessionId: "session-b",
            name: "Beta",
            cwd: "/work/beta",
            status: "busy",
          },
        ],
        liveIds: new Set(["session-a", "session-b"]),
        complete: true,
      },
    });
    h.dependencies.sessionLabel = (session) => session?.name ?? "unnamed";
    const handlers = createMcpToolHandlers({
      claudeDir: "/virtual/claude",
      socketPath: "/virtual/conch.sock",
    }, h.dependencies);

    let thrown: unknown;
    try {
      await handlers.review_to_front({ summary: "Review this" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("ToolInputError");
    expect((thrown as Error).message).toBe(
      "session is required and must name the worker whose deliverable this is"
        + "; live sessions: Alpha, Beta",
    );
    // Two reads: one to identify the caller, one to list labels for the error.
    expect(h.calls.registries).toEqual(["/virtual/claude", "/virtual/claude"]);
    expect(h.calls.sessionLookups).toEqual([]);
    expect(h.calls.daemon).toEqual([]);
    expect(h.calls.opened).toEqual([]);
  });

  test("review_to_front accepts an existing non-executable file link", async () => {
    const root = await mkdtemp(join(tmpdir(), "conch-mcp-review-"));
    const link = join(root, "review.html");
    try {
      await writeFile(link, "<h1>Review</h1>", { mode: 0o600 });
      const h = fakeHarness();
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
      expect(h.calls.opened).toEqual([link]);
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

      const h = fakeHarness();
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
          session: "Build",
        });
        expect(rpcResult(response)).toMatchObject({ isError: true });
        expect(toolText(response)).toBe(
          "link must be an http(s) URL or an existing, non-executable regular file",
        );
      }

      expect(h.calls.sessionLookups).toEqual([]);
      expect(h.calls.daemon).toEqual([]);
      expect(h.calls.opened).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("review_to_front does not open its link when the daemon rejects the turn", async () => {
    const h = fakeHarness({ daemonAccepts: false });
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
      content: [{ type: "text", text: "conch daemon is not running" }],
      isError: true,
    });
    expect(h.calls.daemon).toHaveLength(1);
    expect(h.calls.opened).toEqual([]);
  });

  test("a review_to_front turn survives event ordering and live-work downgrade intact", async () => {
    const h = fakeHarness();
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

    expect(order.accept(event)).toBe(true);
    expect(downgradeTurnWithLiveBackgroundWork(event, true)).toBe(event);
    expect(event.type).toBe("turn-end");
    expect(event.review).toBe(review);
    expect(event.review).toEqual({
      summary: "Inspect the finished dashboard",
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
    // Nothing was announced or opened on the refused path.
    expect(h.calls.daemon).toEqual([]);
    expect(h.calls.opened).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONTEXT_BUDGET,
  EVALS_BASELINE_PATH,
  TOOL_SLACK_TOKENS,
  agentContextSource,
  approxTokens,
  baselineFrom,
  contextBreaches,
  countWithAnthropic,
  machineTooBusy,
  measureAgentContext,
  numericLeaves,
  parseEvalsArgs,
  readBaseline,
  skillListing,
  TranscriptScan,
  usageReport,
  type AgentContextSource,
  type EvalReport,
  type MachineNote,
  type TokenReport,
} from "../src/evals.ts";
import { liveRole, parseCpuTime, stats, wordErrorRate } from "../src/evals-harness.ts";
import { appendMcpCall } from "../src/mcp-usage.ts";

const scratch = () => mkdtempSync(join(tmpdir(), "conch-evals-"));

/**
 * The gate (2026-11-11, Tyler: "performance benchmarks evals on conch for token efficiency, computer efficiency,
 * etc."): what conch puts in front of every agent may not grow more than CONTEXT_BUDGET over the checked-in baseline.
 * Deterministic: the tools/list and initialize replies through the real dispatch, and the plugin's checked-in files,
 * counted by one documented rule. Compute and latency depend on the machine and are never gated here.
 */
describe("the agent-facing context stays within its budget", () => {
  test("every surface, the tool list and each tool within +10% of assets/evals-baseline.json", async () => {
    const baseline = readBaseline();
    expect(baseline?.tokens, `no baseline at ${EVALS_BASELINE_PATH}: bun src/cli.ts evals --only tokens --write-baseline`).toBeDefined();
    const now = measureAgentContext(await agentContextSource());
    const breaches = contextBreaches(baseline!.tokens!, now);
    const said = breaches.map((b) => `${b.what}: ${b.baseline} → ${b.now} tokens (limit ${b.limit})`).join("\n");
    // Grown on purpose? Regenerate with `bun src/cli.ts evals --only tokens --write-baseline` and say why in the PR.
    expect(said, `conch's agent context grew past its budget:\n${said}`).toBe("");
  });

  test("the baseline's tokens match the rule it names, so a hand edit can't loosen the gate", () => {
    const tokens = readBaseline()!.tokens!;
    expect(tokens.method.approx).toBe("ceil(characters / 4)");
    for (const tool of tokens.tools) expect(tool.tokens).toBe(Math.ceil(tool.chars / 4));
    for (const piece of Object.values(tokens.pieces)) expect(piece.tokens).toBe(Math.ceil(piece.chars / 4));
    // One person's usage never goes in a public baseline.
    expect(tokens).not.toHaveProperty("usage");
    expect(tokens).not.toHaveProperty("transcripts");
  });
});

const tool = (name: string, description: string, properties: Record<string, unknown> = {}) => ({
  name, description, inputSchema: { type: "object", properties, additionalProperties: false },
});

const SOURCE: AgentContextSource = {
  tools: [
    tool("big_tool", "Does a great deal of things.".repeat(10), { link: { type: "string", description: "Where it is.".repeat(20) }, kind: { type: "string" } }),
    tool("small_tool", "Small."),
  ],
  serverInstructions: "This session is watched by conch.",
  instructionsToCodex: "",
  skills: { "conch-control": "---\nname: conch-control\ndescription: Publish what the user should look at.\n---\n\n# body\n" + "x".repeat(400) },
  agentsMd: "# conch\n\nAlways on for Codex.\n",
};

describe("measuring the context", () => {
  test("one token per four characters, rounded up", () => {
    expect(approxTokens("")).toBe(0);
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
  });

  test("a skill is listed by its frontmatter, as an agent's skill list shows it", () => {
    expect(skillListing(SOURCE.skills["conch-control"]!)).toBe("- conch:conch-control: Publish what the user should look at.");
  });

  test("tools largest first, with their prose apart from their structure", () => {
    const report = measureAgentContext(SOURCE);
    expect(report.tools.map((t) => t.name)).toEqual(["big_tool", "small_tool"]);
    const big = report.tools[0]!;
    expect(big.parameters).toBe(2);
    expect(big.parameterProseChars).toBe("Where it is.".length * 20);
    expect(big.descriptionChars).toBe("Does a great deal of things.".length * 10);
    expect(big.chars).toBe(JSON.stringify(SOURCE.tools[0]).length);
  });

  test("each surface is what its agent carries: Claude Code lists deferred tools by name; Codex has AGENTS.md and every schema", () => {
    const report = measureAgentContext(SOURCE);
    expect(report.surfaces["claude-code"]!.parts).toEqual(["server-instructions", "skill-listing", "deferred-tool-names"]);
    expect(report.pieces["deferred-tool-names"]!.chars).toBe("mcp__plugin_conch_conch__big_tool\nmcp__plugin_conch_conch__small_tool".length);
    expect(report.surfaces.codex!.parts).toEqual(["agents-md", "skill-listing", "tools-list"]);
    expect(report.surfaces["claude-code (all tools loaded)"]!.tokens).toBeGreaterThan(report.surfaces["claude-code"]!.tokens);
    const sum = report.surfaces.codex!.parts.reduce((s, part) => s + report.pieces[part]!.tokens, 0);
    expect(report.surfaces.codex!.tokens).toBe(sum);
    // Server instructions reach Codex only if a server sends them to it.
    expect(measureAgentContext({ ...SOURCE, instructionsToCodex: "x" }).surfaces.codex!.parts).toContain("server-instructions");
  });

  test("this checkout serves every tool its instruction source describes, and instructions to Claude Code only", async () => {
    const source = await agentContextSource();
    const { AGENT_INSTRUCTIONS } = await import("../src/agent-instructions.ts");
    expect(source.tools.map((t) => t.name).sort()).toEqual(Object.keys(AGENT_INSTRUCTIONS.tools).sort());
    expect(source.serverInstructions).toBe(AGENT_INSTRUCTIONS.serverInstructions);
    expect(source.instructionsToCodex).toBe("");
    expect(Object.keys(source.skills)).toContain("conch-control");
    expect(source.agentsMd).toContain(AGENT_INSTRUCTIONS.alwaysOn.slice(0, 60));
  });
});

describe("the budget", () => {
  const report = (surface: number, tools: Record<string, number>): TokenReport => ({
    method: { approx: "ceil(characters / 4)" },
    tools: Object.entries(tools).map(([name, tokens]) => ({ name, tokens, chars: tokens * 4, descriptionChars: 0, schemaChars: 0, parameterProseChars: 0, parameters: 0 })),
    pieces: { "tools-list": { chars: surface * 4, tokens: surface } },
    surfaces: { codex: { chars: surface * 4, tokens: surface, parts: ["tools-list"] } },
  });

  test(`+${CONTEXT_BUDGET * 100}% passes, one token more fails`, () => {
    const before = report(1000, {});
    expect(contextBreaches(before, report(1100, {}))).toEqual([]);
    expect(contextBreaches(before, report(1101, {})).map((b) => b.what)).toEqual(["surface codex", "tools-list"]);
  });

  test(`a tool may also gain ${TOOL_SLACK_TOKENS} tokens; a new tool counts in the totals; a removed one is fine`, () => {
    const before = report(1000, { short: 50, long: 1000 });
    expect(contextBreaches(before, report(1000, { short: 50 + TOOL_SLACK_TOKENS, long: 1100 }))).toEqual([]);
    expect(contextBreaches(before, report(1000, { short: 51 + TOOL_SLACK_TOKENS })).map((b) => b.what)).toEqual(["tool short"]);
    expect(contextBreaches(before, report(1000, { long: 1101 })).map((b) => b.what)).toEqual(["tool long"]);
    expect(contextBreaches(before, report(1000, { short: 50, long: 1000, brand_new: 90 }))).toEqual([]);
    expect(contextBreaches(before, report(1200, { short: 50, long: 1000, brand_new: 290 })).length).toBeGreaterThan(0);
  });
});

describe("the baseline", () => {
  const machine = (load: number): MachineNote => ({ at: "2026-11-11T00:00:00.000Z", conch: "0.4.0", bun: "1.4.4", os: "macOS", cores: 10, loadStart: load });
  const tokens = measureAgentContext(SOURCE);

  test("never this Mac's call log or transcripts", () => {
    const run: EvalReport = { v: 1, machine: machine(1), tokens: { ...tokens, usage: null, transcripts: { source: "claude-code transcripts", days: 7, files: 1, results: [], toolSearch: { loads: 0, conchToolsLoaded: 0, byTool: {} } } } };
    const { baseline } = baselineFrom(run, null);
    expect(baseline.tokens).not.toHaveProperty("usage");
    expect(baseline.tokens).not.toHaveProperty("transcripts");
  });

  test("compute and latency only from a machine that wasn't busy, unless forced; the machine note moves with them", () => {
    expect(machineTooBusy(machine(5))).toBe(false);
    expect(machineTooBusy(machine(6))).toBe(true);
    const previous: EvalReport = { v: 1, machine: { ...machine(1), note: "idle enough" }, compute: { cpu: 1 }, latency: { ping: 1 } };
    const busy: EvalReport = { v: 1, machine: machine(40), tokens, compute: { cpu: 9 }, latency: { ping: 9 } };
    const kept = baselineFrom(busy, previous);
    expect(kept.kept).toEqual(["compute", "latency"]);
    expect(kept.baseline.compute).toEqual({ cpu: 1 });
    expect(kept.baseline.machine.note).toBe("idle enough");
    expect(kept.baseline.tokens).toBeDefined();
    expect(baselineFrom(busy, previous, true).baseline.compute).toEqual({ cpu: 9 });
    const quiet = baselineFrom({ ...busy, machine: machine(2) }, previous).baseline;
    expect(quiet.latency).toEqual({ ping: 9 });
    expect(quiet.machine.note).toBe("idle enough: load 2 on 10 cores");
    expect(baselineFrom({ v: 1, machine: machine(40), tokens }, null).baseline.machine.note).toBe("tokens only: compute and latency not recorded");
  });

  test("compute and latency compare leaf by leaf, arrays by their entries' names", () => {
    expect([...numericLeaves({ a: { b: 1, c: "x" }, list: [{ name: "t", ms: 2 }] })]).toEqual([["a.b", 1], ["list[t].ms", 2]]);
  });
});

describe("tool results from this Mac's records", () => {
  test("the call log aggregated by tool, with no session id in what comes out", () => {
    const path = join(scratch(), "mcp-usage.jsonl");
    const now = Date.parse("2026-11-11T12:00:00Z");
    for (let i = 0; i < 10; i++) appendMcpCall({ ts: now - 1_000 * i, tool: i < 7 ? "conch_capture" : "conch_sessions", session: `secret-session-${i % 3}`, ms: 10 * i, outcome: "ok", ...(i < 4 ? { bytes: 1000 * (i + 1) } : {}) }, path);
    const report = usageReport(path, now - 86_400_000, now)!;
    expect(report.calls).toBe(10);
    expect(report.sessions).toBe(3);
    expect(report.sized).toBe(4);
    expect(report.tools[0]).toMatchObject({ tool: "conch_capture", calls: 7, share: 0.7, replyBytes: { sized: 4, p50: 2000, p90: 4000 } });
    expect(JSON.stringify(report)).not.toContain("secret-session");
    expect(usageReport(join(scratch(), "none.jsonl"), 0, now)).toBeNull();
  });

  test("Claude Code transcripts: each conch result's size, by tool, and the ToolSearch selects that loaded conch tools", () => {
    const scan = new TranscriptScan(Date.parse("2026-11-04T00:00:00Z"));
    const use = (id: string, name: string, input: unknown = {}, timestamp = "2026-11-10T00:00:00Z") => JSON.stringify({ type: "assistant", timestamp, message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (id: string, content: unknown) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
    for (const line of [
      use("t1", "mcp__plugin_conch_conch__conch_sessions"),
      result("t1", "x".repeat(300)),
      use("t2", "mcp__plugin_conch_conch__conch_sessions"),
      result("t2", [{ type: "text", text: "é".repeat(50) }]),
      use("t3", "Bash"),
      result("t3", "y".repeat(9_000)),
      use("t4", "ToolSearch", { query: "select:mcp__plugin_conch_conch__review_to_front,mcp__plugin_conch_conch__conch_capture" }),
      use("t5", "ToolSearch", { query: "select:Read" }),
      // A fork's copy of the same call, and a call from before the window: neither counts.
      use("t1", "mcp__plugin_conch_conch__conch_sessions"),
      result("t1", "x".repeat(300)),
      use("t6", "mcp__plugin_conch_conch__conch_sessions", {}, "2026-10-01T00:00:00Z"),
      result("t6", "z".repeat(50)),
      "not json",
    ]) scan.line(line);
    expect(scan.sizes.get("conch_sessions")).toEqual([300, 100]);
    expect(scan.sizes.has("Bash")).toBe(false);
    expect(scan.loads).toEqual({ loads: 1, conchToolsLoaded: 2, byTool: { review_to_front: 1, conch_capture: 1 } });
  });
});

describe("counting with Anthropic's endpoint, when a key is present", () => {
  test("a piece is its message less a one-character one; a tool, the difference it makes beside a tiny tool", async () => {
    const report = measureAgentContext(SOURCE);
    const bodies: Array<Record<string, unknown>> = [];
    const fake = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }>; tools?: Array<{ name: string; description: string }> };
      bodies.push(body);
      expect((init.headers as Record<string, string>)["anthropic-version"]).toBe("2023-06-01");
      // A made-up tokenizer: 10 for the request, a token per 2 characters of the message, 100 for any tools, 1 per character of their descriptions.
      const tools = body.tools ?? [];
      const count = 10 + Math.ceil(body.messages[0]!.content.length / 2) + (tools.length ? 100 : 0) + tools.reduce((s, t) => s + t.description.length, 0);
      return new Response(JSON.stringify({ input_tokens: count }));
    };
    await countWithAnthropic(SOURCE, report, "test-key", fake, "claude-opus-5-5");
    expect(report.method.api).toBe("Anthropic count_tokens (claude-opus-5-5)");
    expect(report.pieces["server-instructions"]!.apiTokens).toBe(Math.ceil(SOURCE.serverInstructions.length / 2));
    const small = report.tools.find((t) => t.name === "small_tool") as { apiTokens?: number };
    expect(small.apiTokens).toBe("Small.".length);
    expect(report.surfaces.codex!.apiTokens).toBeGreaterThan(0);
    expect(bodies.every((body) => body.model === "claude-opus-5-5")).toBe(true);
  });
});

describe("the command's arguments", () => {
  test("sections, windows, and refusals", () => {
    const now = Date.parse("2026-11-11T00:00:00Z");
    const all = parseEvalsArgs([], now);
    expect("error" in all ? null : all.sections).toEqual(["tokens", "compute", "latency"]);
    const only = parseEvalsArgs(["--only", "tokens,latency", "--compare", "--json"], now);
    expect("error" in only ? null : [only.sections, only.compare, only.json]).toEqual([["tokens", "latency"], EVALS_BASELINE_PATH, true]);
    const file = parseEvalsArgs(["--compare", "/x/base.json", "--transcripts"], now);
    expect("error" in file ? null : [file.compare, file.transcriptsSince]).toEqual(["/x/base.json", now - 7 * 86_400_000]);
    expect(parseEvalsArgs(["--only", "speed"], now)).toEqual({ error: "--only takes tokens, compute, latency" });
    expect("error" in parseEvalsArgs(["--seconds", "0"], now)).toBe(true);
    expect("error" in parseEvalsArgs(["--sessions", "500"], now)).toBe(true);
    expect("error" in parseEvalsArgs(["--since", "soon"], now)).toBe(true);
    expect(parseEvalsArgs(["--verbose"], now)).toEqual({ error: "unknown argument \"--verbose\"" });
  });
});

describe("the harness's small parts", () => {
  test("ps's cputime and etime", () => {
    expect(parseCpuTime("0:01.50")).toBe(1.5);
    expect(parseCpuTime("567:22.01")).toBeCloseTo(34042.01);
    expect(parseCpuTime("02:03:04")).toBe(7384);
    expect(parseCpuTime("5-23:37:46")).toBe(5 * 86_400 + 23 * 3600 + 37 * 60 + 46);
  });

  test("conch's live processes by their command lines, never the harness's own", () => {
    expect(liveRole("/Users/x/.bun/bin/bun /Users/x/conch/src/cli.ts daemon")).toBe("daemon");
    expect(liveRole("/Applications/conch.app/Contents/Helpers/conch-daemon daemon")).toBe("daemon");
    expect(liveRole("/Applications/conch.app/Contents/MacOS/conch-mac")).toBe("app");
    expect(liveRole("/opt/homebrew/bin/bun run /Users/x/Projects/Conch/src/cli.ts mcp")).toBe("mcp");
    expect(liveRole("/bin/sh /Users/x/.config/conch/plugin-dist/plugins/conch/bin/conch-mcp")).toBe("mcp");
    expect(liveRole("bun --preload /r/src/evals-census.ts /r/src/cli.ts daemon")).toBeNull();
    expect(liveRole("bun test")).toBeNull();
  });

  test("stats by nearest rank; word error rate by words", () => {
    expect(stats([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p90: 5, mean: 3, max: 5 });
    expect(stats([])).toEqual({ n: 0, p50: 0, p90: 0, mean: 0, max: 0 });
    expect(wordErrorRate("open the conch daemon", "Open the conch daemon.")).toBe(0);
    expect(wordErrorRate("open the conch daemon", "open a conch")).toBe(0.5);
  });
});

describe("the census the test daemon runs under", () => {
  test("counts conch's own file calls by what they touched and where they came from, and the processes it starts", async () => {
    const root = scratch();
    const src = join(root, "src");
    mkdirSync(src);
    writeFileSync(join(root, "watched.json"), "{}");
    writeFileSync(join(src, "probe.ts"), [
      `import { closeSync, existsSync, openSync, readSync, statSync, writeFileSync } from "node:fs";`,
      `import { readFile } from "node:fs/promises";`,
      `function poll() { statSync(${JSON.stringify(join(root, "watched.json"))}); existsSync(${JSON.stringify(join(root, "nope"))}); }`,
      `for (let i = 0; i < 3; i++) poll();`,
      `const fd = openSync(${JSON.stringify(join(root, "watched.json"))}, "r"); readSync(fd, Buffer.alloc(2)); closeSync(fd);`,
      `writeFileSync(${JSON.stringify(join(root, "out.json"))}, "x".repeat(2048));`,
      `await readFile(${JSON.stringify(join(root, "watched.json"))});`,
      `Bun.spawnSync(["/bin/echo", "hi"], { stdout: "ignore" });`,
    ].join("\n"));
    const census = join(root, "census");
    const proc = Bun.spawn([process.execPath, "--preload", resolve(import.meta.dir, "../src/evals-census.ts"), join(src, "probe.ts")], {
      env: {
        ...process.env,
        CONCH_EVALS_CENSUS: census,
        CONCH_EVALS_SRC: src,
        CONCH_EVALS_CENSUS_PATHS: JSON.stringify([[join(root, "watched.json"), "watched"], [join(root, "out.json"), "out"], [root, "root"]]),
      },
      stdout: "ignore", stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const file = `${census}.main.json`;
    expect(existsSync(file)).toBe(true);
    const counted = JSON.parse(readFileSync(file, "utf8")) as { calls: Record<string, number>; sites: Record<string, number>; written: Record<string, number>; spawned: Record<string, number> };
    expect(counted.calls).toMatchObject({ "statSync watched": 3, "existsSync root": 3, "openSync watched": 1, "readSync watched": 1, "closeSync watched": 1, "writeFileSync out": 1, "readFile watched": 1 });
    expect(counted.sites["poll (probe.ts)"]).toBe(6);
    expect(counted.written).toEqual({ out: 2048 });
    expect(Object.keys(counted.spawned)).toEqual(["echo hi ← (top) (probe.ts)"]);
  });
});

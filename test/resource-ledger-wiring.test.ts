import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The resource ledger's wiring (resource-ledger.ts, resource-sampler.ts): the daemon looks on a timer, publishes, and
// stops only when a request asks it to.

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(-1);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};

const daemon = read("src/daemon.ts");

describe("the daemon", () => {
  test("looks every 30 s through one sampler fed its own ps until the shared look lands", () => {
    // The ledger is made early, beside the sessions it reads, before anything that publishes could reach for it.
    const ledger = between(daemon, "let resourceSessions:", "const resourceLedger = new ResourceLedger({");
    expect(ledger.length).toBeLessThan(1_000);
    expect(between(daemon, "const resourceLedger = new ResourceLedger({", "\n  });\n")).toContain("memory: loadResourceMemory()");
    expect(daemon.indexOf("const resourceLedger = new ResourceLedger({")).toBeLessThan(daemon.indexOf("function writeSessionsFile(): void {"));
    const block = between(daemon, "const resourceSampler = new ResourceSampler({", "const resources = {");
    expect(block).toContain("table: psProcessTable()");
    expect(block).toContain("intervalMs: RESOURCE_SAMPLE_MS");
    expect(block).toContain("ownPids: conchPids");
    // The timer only ever looks.
    const timer = between(block, "const resourceTimer = setInterval(() => {", "}, RESOURCE_SAMPLE_MS);");
    expect(timer).toContain("resourceSampler.sample()");
    expect(timer).not.toContain("stop");
  });

  test("the budget is read live from the settings, and the automatic step is the sampler's alone, behind its setting", () => {
    expect(between(daemon, "const resourceLedger = new ResourceLedger({", "\n  });\n"))
      .toContain("budget: () => ({ cpuPercent: cfg.agentBudgetCpu, memoryPercent: cfg.agentBudgetMemory, autoBackground: cfg.agentAutoBackground })");
    const sampler = read("src/resource-sampler.ts");
    // The one call that changes anything without a request: lowering priority, and only what the ledger names.
    expect(sampler.match(/controlResource\(entry, "lower"/g)).toHaveLength(1);
    expect(between(sampler, "private async autoBackground(now: number)", "\n  }\n")).toContain("this.options.ledger.autoBackgroundCandidates(now)");
    const candidates = between(read("src/resource-ledger.ts"), "autoBackgroundCandidates(now: number = this.sampledAt): ResourceEntry[] {", "\n  }\n");
    expect(candidates).toContain("if (!published.budget.autoBackground");
    expect(candidates).toContain("!entry.owner || !PROCESS_KINDS.has(entry.kind)");
    // Holds, resumes and priority changes otherwise come only from a request.
    const daemonControls = daemon.match(/controlResource\(|controlSession\(/g) ?? [];
    expect(daemonControls).toHaveLength(2);
    expect(between(daemon, "const resources = {", "  };\n")).toContain("control: (entry, action) => controlResource(entry, action, { table: psProcessTable() })");
  });

  test("stops nothing on its own: the one stop is the request handler's", () => {
    expect(daemon.match(/stopResource\(/g)).toHaveLength(1);
    const handler = between(daemon, "const resources = {", "  };\n");
    expect(handler).toContain("stop: (entry) => stopResource(entry, { table: psProcessTable() })");
    expect(read("src/resource-sampler.ts").match(/deps\.stop\(/g)).toHaveLength(1);
    const decide = between(read("src/resource-sampler.ts"), 'if (request.kind === "resource-decide") {', "// resource-add:");
    expect(decide).toContain('if (request.action === "stop") {');
  });

  test("the full list goes in the sessions file; each row's count in the state the phone shares", () => {
    const sessionsFile = between(daemon, "function writeSessionsFile(): void {", "\n  }\n");
    expect(sessionsFile).toContain("resources: resourceLedger.published()");
    const build = between(daemon, "lastPublishedPanelState = buildDaemonPublishedState(", "applyLiveActivity();");
    expect(build).toContain("lastPublishedPanelState = withStillRunning(lastPublishedPanelState, resourceLedger.rowCounts(), resourceLedger.rowLevels());");
    const publish = between(daemon, "function publishResources(): void {", "\n  }\n");
    expect(publish).toContain("withStillRunning(lastPublishedPanelState, resourceLedger.rowCounts(), resourceLedger.rowLevels())");
    expect(publish).toContain("publishedStateWriter.request()");
  });

  test("the sessions it reads are the registry's, each with its processes", () => {
    const reconcile = between(daemon, "function reconcileSessionSnapshot(", "pruneSessionCommandSets(");
    expect(reconcile).toContain("resourceSessions = {");
    expect(reconcile).toContain("complete: snap.complete");
    expect(reconcile).toContain("pids: [s.pid, s.agentPid]");
  });

  test("the Mac app is a person; a CLI is walked up to its session, or is a terminal no session started", () => {
    const caller = between(daemon, "caller: async (callerPid) => {", "stop: (entry)");
    expect(caller).toContain("if (callerPid === undefined) return { person: true };");
    expect(caller).toContain("sessionForCallerPid(callerPid");
    expect(caller).toContain("/^no live session conch knows started/");
  });
});

describe("the socket and the CLI", () => {
  test("the control server answers resource requests before resolving a session, and the phone can't send them", () => {
    const server = read("src/control-server.ts");
    const early = between(server, 'body.kind === "ping"', "const value = await sessions.resolve(body);");
    expect(early).toContain("const resourceRequest = decodeResourceRequest(body);");
    expect(early).toContain("reply = await options.resources.handle(resourceRequest);");
    expect(daemon).toContain("    resources,\n");
    expect(read("src/phone-bridge.ts")).toContain("  decodeResourceRequest,\n};");
  });

  test("conch resources is a command, and in conch help", () => {
    const cli = read("src/cli.ts");
    expect(cli).toContain('case "resources": {');
    expect(cli).toContain("await runResourcesCli(rest, cfg.socketPath)");
    expect(between(cli, "const HELP = `", "`;")).toContain("conch sessions | resources | resumable [query]");
  });
});

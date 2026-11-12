import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAgentCapabilities } from "../src/agent-capabilities.ts";
import { createSkillsLibrary, isSkillsLibraryReply, skillsLibraryRequestError, type DiscoverProvider } from "../src/skills-library.ts";
import { journalProgress, parseWorkflowMeta, readWorkflowRuns, readWorkflows, workflowFeature, workflowProjectFolders } from "../src/workflows.ts";

// Claude Code's workflows, for Settings › Workflows (2026-11-11). Tyler:
// "making the rest of the app like skills, workflows, etc much more pleasurable to use." The shapes are Claude Code
// 2.1.322's own: a workflow is a `.js` script whose first statement is `export const meta = {…}`, saved in
// `<config>/workflows`, a project's `.claude/workflows` or a plugin's `workflows`, and typed as `/name`.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conch-workflows-")));
  dirs.push(dir);
  return dir;
}
function write(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}
const script = (name: string, phases = "[{ title: 'Find', detail: 'one agent per area' }, { title: 'Verify' }]") =>
  `// ${name}: a saved workflow\nexport const meta = {\n  name: '${name}',\n  description: "What ${name} does",\n  whenToUse: \`When you want ${name}\`,\n  phases: ${phases},\n}\nphase('Find')\nconst found = await agent('look')\n`;

describe("a workflow's meta is read as Claude Code reads it: a pure literal, never run", () => {
  test("names, descriptions, phases, comments, quotes of every kind and trailing commas", () => {
    const parsed = parseWorkflowMeta(`/* header */\n// more\nexport const meta = {\n  "name": 'review-changes', // its slash name\n  description: "Find \\"bugs\\" and verify each",\n  phases: [\n    { title: 'Find', detail: \`one per dimension\` },\n    { title: "Verify", model: 'opus', },\n    { detail: 'no title: skipped' },\n  ],\n  version: 2, draft: false, owner: null,\n}\nawait agent('x')`);
    expect(parsed).toEqual({ meta: {
      name: "review-changes",
      description: 'Find "bugs" and verify each',
      phases: [{ title: "Find", detail: "one per dimension" }, { title: "Verify" }],
    } });
  });

  test("anything but a literal is refused, as Claude Code refuses it", () => {
    const refused = [
      "const x = 1\nexport const meta = { name: 'late' }",
      "export const meta = { name: NAME }",
      "export const meta = { name: 'a', description: make() }",
      "export const meta = { name: `a${b}` }",
      "export const meta = { ...base, name: 'a' }",
      "export const meta = { description: 'no name' }",
      "export const meta = ['a']",
      "export const meta = { name: 'never closes'",
    ];
    for (const text of refused) expect("error" in parseWorkflowMeta(text), text).toBe(true);
  });
});

/** Two Claude accounts, one with a plugin's workflow; a project with its own; and the near misses Claude Code skips. */
function machine() {
  const root = scratch();
  const claude = join(root, "claude");
  const work = join(root, "work");
  const project = join(root, "home", "Projects", "storefront");
  write(join(claude, "workflows", "find-flaky-tests.js"), script("find-flaky-tests"));
  write(join(claude, "workflows", "draft.ts"), script("draft"));
  write(join(claude, "workflows", "broken.js"), "phase('x')\nexport const meta = { name: 'broken' }");
  write(join(work, "workflows", "find-flaky-tests.js"), script("find-flaky-tests", "[]"));
  write(join(project, ".claude", "workflows", "release-check.js"), script("release-check"));
  write(join(work, "settings.json"), JSON.stringify({ enableWorkflows: false }));
  const kit = join(root, "plugins", "kit");
  write(join(kit, "workflows", "audit.js"), script("audit"));
  return {
    root, claude, work, project, kit,
    homes: {
      claudeAccounts: [{ id: "default", label: "Default", configDir: claude }, { id: "work", label: "Work", configDir: work }],
      projectFolders: [join(project, "src")],
      home: join(root, "home"),
      plugins: (account: { id: string }) => account.id === "work" ? [{ pluginId: "kit@market", installPath: kit, enabled: false }] : [],
    },
  };
}

describe("saved workflows, every account's, every project's and every plugin's", () => {
  test("one entry per workflow, with where each copy lives and how it is typed", () => {
    const { homes, claude, work, project, kit } = machine();
    const read = readWorkflows(homes, () => 1);
    expect(read.workflows.map((entry) => entry.id)).toEqual([
      "own:broken", "own:draft", "own:find-flaky-tests", "plugin:kit:audit", "own:release-check",
    ]);
    const flaky = read.workflows.find((entry) => entry.name === "find-flaky-tests")!;
    expect(flaky.description).toBe("What find-flaky-tests does");
    expect(flaky.whenToUse).toBe("When you want find-flaky-tests");
    expect(flaky.phases).toEqual([{ title: "Find", detail: "one agent per area" }, { title: "Verify" }]);
    expect(flaky.locations.map((location) => [location.accountId, location.path, location.invocation])).toEqual([
      ["default", join(claude, "workflows", "find-flaky-tests.js"), "/find-flaky-tests"],
      ["work", join(work, "workflows", "find-flaky-tests.js"), "/find-flaky-tests"],
    ]);
    expect(flaky.versions).toBe(2);
    // A project's, for every account in that folder; a plugin's, typed with its plugin, off with it.
    const release = read.workflows.find((entry) => entry.name === "release-check")!;
    expect(release.locations[0]).toMatchObject({ origin: "project", projectPath: project, invocation: "/release-check" });
    expect(release.locations[0]!.accountId).toBeUndefined();
    const audit = read.workflows.find((entry) => entry.name === "kit:audit")!;
    expect(audit).toMatchObject({ origin: "plugin", plugin: "kit" });
    expect(audit.locations[0]).toMatchObject({ path: join(kit, "workflows", "audit.js"), enabled: false, invocation: "/kit:audit" });
    // What Claude Code skips is listed with why, so it isn't simply missing.
    expect(read.workflows.find((entry) => entry.name === "draft")!.problem).toBe("Claude Code reads only .js workflows, so it skips this one.");
    expect(read.workflows.find((entry) => entry.name === "broken")!.problem).toContain("must be the first statement");
    // The feature, as each account's settings have it.
    expect(read.accounts.map((account) => [account.id, account.feature, account.workflows])).toEqual([["default", "default", 3], ["work", "off", 2]]);
  });

  test("a project's workflows load in its folder and every folder under it, up to home", () => {
    expect(workflowProjectFolders(["/Users/t/Projects/app/src", "/Users/t/Projects/app", "/elsewhere"], "/Users/t"))
      .toEqual(["/Users/t/Projects", "/Users/t/Projects/app", "/Users/t/Projects/app/src"]);
  });

  test("the feature is off when a setting says so", () => {
    const root = scratch();
    expect(workflowFeature(root)).toBe("default");
    write(join(root, "settings.json"), JSON.stringify({ enableWorkflows: true }));
    expect(workflowFeature(root)).toBe("on");
    write(join(root, "settings.json"), JSON.stringify({ enableWorkflows: true, disableWorkflows: true }));
    expect(workflowFeature(root)).toBe("off");
  });
});

describe("a run's progress, from the session's own folder", () => {
  function session(root: string) {
    const transcript = join(root, "projects", "app", "session-1.jsonl");
    write(transcript, "");
    const folder = transcript.slice(0, -6);
    // Running: a journal, the script it ran, no record yet.
    write(join(folder, "workflows", "scripts", "review-changes-wf_aaa-111.js"), script("review-changes"));
    write(join(folder, "subagents", "workflows", "wf_aaa-111", "journal.jsonl"), [
      { type: "launched" },
      { type: "started", key: "k1", agentId: "a1", label: "area 1", phase: "Find" },
      { type: "started", key: "k2", agentId: "a2", label: "area 2", phase: "Find" },
      { type: "result", key: "k1", agentId: "a1", result: { found: 2 } },
      { type: "started", key: "k3", agentId: "a3", label: "verify", phase: "Verify" },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    // Ended: its record.
    write(join(folder, "workflows", "wf_bbb-222.json"), JSON.stringify({
      runId: "wf_bbb-222", workflowName: "brand-site", status: "completed", startTime: 1_000, durationMs: 9_000, agentCount: 4,
      phases: [{ title: "Spec", detail: "write it" }], summary: "Built the page.", script: "export const meta = {}",
    }));
    // Ended long ago: not listed.
    const old = write(join(folder, "workflows", "wf_ccc-333.json"), JSON.stringify({ workflowName: "old", status: "completed" }));
    utimesSync(old, new Date(0), new Date(0));
    return transcript;
  }

  test("a running run says its phases, its agents and where it is; an ended one its record", () => {
    const root = scratch();
    const transcriptPath = session(root);
    const runs = readWorkflowRuns([{ id: "s1", label: "storefront", transcriptPath }, { id: "s2", label: "no transcript" }]);
    expect(runs.map((run) => [run.runId, run.status, run.name])).toEqual([
      ["wf_aaa-111", "running", "review-changes"],
      ["wf_bbb-222", "completed", "brand-site"],
    ]);
    const running = runs[0]!;
    expect(running).toMatchObject({ sessionId: "s1", sessionLabel: "storefront", currentPhase: "Verify", agents: { started: 3, done: 1 } });
    expect(running.phases).toEqual([
      { title: "Find", detail: "one agent per area", started: 2, done: 1 },
      { title: "Verify", started: 1, done: 0 },
    ]);
    expect(runs[1]).toMatchObject({ durationMs: 9_000, summary: "Built the page.", agents: { started: 4, done: 4 }, startedAt: 1_000 });
  });

  test("the journal's agents are counted by the phase they started under", () => {
    const progress = journalProgress('{"type":"started","agentId":"a","phase":"P"}\nnot json\n{"type":"result","agentId":"a"}\n{"type":"started","agentId":"b"}\n');
    expect([...progress.phases]).toEqual([["P", { started: 1, done: 1 }], ["", { started: 1, done: 0 }]]);
    // An agent under no phase is counted, but names no phase to be in.
    expect(progress.current).toBeUndefined();
  });
});

describe("the composer's / and ⌘K offer saved workflows, as Claude Code types them", () => {
  test("the person's and a project's workflows are commands; none while the feature is off", () => {
    const root = scratch();
    const home = join(root, "claude");
    const cwd = join(root, "app");
    write(join(home, "workflows", "find-flaky-tests.js"), script("find-flaky-tests"));
    write(join(home, "workflows", "draft.ts"), script("draft"));
    write(join(cwd, ".claude", "workflows", "release-check.js"), script("release-check"));
    const read = () => readAgentCapabilities({ backend: "claude", cwd, claudeHome: home, claudeStatePath: join(root, ".claude.json"),
      claudeManagedSettingsPath: null, claudeManagedMcpPath: null } as Parameters<typeof readAgentCapabilities>[0]);
    const commands = read().entities.filter((entity) => entity.kind === "command");
    expect(commands.map((entity) => entity.kind === "command" && [entity.command.invocation, entity.command.workflow, entity.description])).toEqual([
      ["/find-flaky-tests", true, "Workflow: What find-flaky-tests does"],
      ["/release-check", true, "Workflow: What release-check does"],
    ]);
    write(join(home, "settings.json"), JSON.stringify({ enableWorkflows: false }));
    expect(read().entities.filter((entity) => entity.kind === "command")).toEqual([]);
  });
});

describe("the workflows reply", () => {
  test("the request is checked before anything is read", () => {
    expect(skillsLibraryRequestError({ action: "workflows", entryId: "x" })).toBe("skills-library workflows takes no entryId");
    expect(skillsLibraryRequestError({ action: "workflows", offset: 0 })).toBeUndefined();
  });

  test("the workflows and the live sessions' runs, in one frame", async () => {
    const { homes } = machine();
    const root = scratch();
    const transcriptPath = join(root, "s.jsonl");
    write(transcriptPath, "");
    write(join(root, "s", "subagents", "workflows", "wf_ddd-444", "journal.jsonl"), '{"type":"started","agentId":"a","phase":"Find"}\n');
    const discover: DiscoverProvider = { list: async () => ({ indexes: [], entries: [], refreshing: false }), local: async () => { throw new Error("none"); } };
    const library = createSkillsLibrary({
      homes: () => ({ claudeAccounts: homes.claudeAccounts, codexAccounts: [], agentsHome: null, projectFolders: [] }),
      discover,
      plugins: homes.plugins,
      sessions: () => [{ id: "s", label: "app", transcriptPath }],
    });
    const reply = await library.handle({ kind: "skills-library", action: "workflows" });
    expect(isSkillsLibraryReply(reply)).toBe(true);
    if (reply.action !== "workflows") throw new Error(reply.action);
    expect(reply.total).toBe(4);
    expect(reply.runs.map((run) => [run.runId, run.status, run.agents])).toEqual([["wf_ddd-444", "running", { started: 1, done: 0 }]]);
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(64 * 1024);
  });
});

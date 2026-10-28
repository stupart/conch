import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collapseSkills,
  commandMetadata,
  createSkillsLibrary,
  invocationFor,
  isSkillsLibraryReply,
  markInstalled,
  pageOf,
  readInstalledSkills,
  skillKey,
  skillsLibraryRequestError,
  type DiscoverProvider,
  type DiscoverSkill,
  type SkillLocation,
  type SkillsLibraryHomes,
} from "../src/skills-library.ts";
import { applySkillCopy, planSkillCopy, prepareTrialFolder, sweepTrials, TRIAL_KEEP_MS, trialPrompt } from "../src/skill-install.ts";
import { validateControlResponse, validateRuntimeControlMessage } from "../src/settings.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conch-skills-")));
  dirs.push(dir);
  return dir;
}
function skill(folder: string, name: string, description = `What ${name} does.`, body = "Steps.\n"): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
  return join(folder, "SKILL.md");
}

/** Two Claude accounts, a Codex one, `~/.agents`, and a project: every place the library reads. */
function machine(): SkillsLibraryHomes & { root: string } {
  const root = scratch();
  const claude = join(root, "claude");
  const work = join(root, "work-claude");
  const codex = join(root, "codex");
  const agents = join(root, "agents");
  const project = join(root, "storefront");
  mkdirSync(join(project, ".git"), { recursive: true });
  skill(join(claude, "skills", "handoff"), "handoff", "Writes the hand-off note.");
  skill(join(work, "skills", "handoff"), "handoff", "Writes the hand-off note.");
  skill(join(codex, "skills", "handoff"), "handoff", "Writes the hand-off note.", "Different steps.\n");
  skill(join(codex, "skills", ".system", "skill-creator"), "skill-creator", "Codex's own.");
  skill(join(agents, "skills", "shared-codex"), "shared-codex");
  skill(join(project, ".claude", "skills", "deploy-check"), "deploy-check");
  // A subfolder's own skills, as Claude Code loads them for files under it; never a dependency's.
  skill(join(project, "brand", ".claude", "skills", "brand-voice"), "brand-voice");
  skill(join(project, "node_modules", "pkg", ".claude", "skills", "vendored"), "vendored");
  skill(join(project, ".agents", "skills", "deploy-check"), "deploy-check");
  mkdirSync(join(claude, "commands", "team"), { recursive: true });
  writeFileSync(join(claude, "commands", "standup.md"), "---\ndescription: \"Summarise yesterday\"\n---\nGo.\n");
  writeFileSync(join(claude, "commands", "team", "retro.md"), "# Retro\n\nRun the team's retro.\n");
  // claude.ai's skills, for the sign-in the profile holds, beside an older sign-in's.
  const bucket = "org-1_user-1";
  writeFileSync(join(claude, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-1", accountUuid: "user-1" } }));
  skill(join(claude, "skills", "synced", bucket, "skill-creator"), "skill-creator", "claude.ai's.");
  writeFileSync(join(claude, "skills", "synced", bucket, "manifest.json"), JSON.stringify({ skills: [{ name: "skill-creator", source: "anthropic-example" }] }));
  skill(join(claude, "skills", "synced", "org-0_user-0", "gone"), "gone");
  // A plugin, enabled in the work account only, with a skill and a command.
  for (const [dir, enabled] of [[claude, false], [work, true]] as const) {
    const install = join(dir, "plugins", "cache", "market", "kit", "1.0.0");
    skill(join(install, "skills", "kit-skill"), "kit-skill");
    mkdirSync(join(install, "commands"), { recursive: true });
    writeFileSync(join(install, "commands", "kit-command.md"), "---\ndescription: A kit command\n---\n");
    mkdirSync(join(install, ".claude-plugin"), { recursive: true });
    writeFileSync(join(install, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
    writeFileSync(join(dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "kit@market": [{ scope: "user", installPath: install, version: "1.0.0" }] } }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ enabledPlugins: { "kit@market": enabled } }));
  }
  return {
    root,
    claudeAccounts: [{ id: "default", label: "Default", configDir: claude }, { id: "work", label: "Work", configDir: work }],
    codexAccounts: [{ id: "default", label: "Default", configDir: codex }],
    agentsHome: agents,
    projectFolders: [join(project, "src"), project, join(root, "missing")],
  };
}

describe("the installed library", () => {
  test("every account's skills, one entry per skill, with where each copy lives", () => {
    const homes = machine();
    mkdirSync(join(homes.projectFolders[1]!, "src"), { recursive: true });
    const read = readInstalledSkills(homes);
    const names = read.skills.map((entry) => entry.id);
    expect(names).toEqual([
      "skill:own:brand-voice", "skill:own:deploy-check", "skill:own:handoff", "command:plugin:kit:kit-command", "skill:plugin:kit:kit-skill",
      "command:own:retro", "skill:own:shared-codex", "skill:claude.ai:skill-creator", "skill:system:skill-creator",
      "command:own:standup",
    ]);
    const handoff = read.skills.find((entry) => entry.id === "skill:own:handoff")!;
    expect(handoff.locations.map((location) => `${location.agent}/${location.accountLabel}`)).toEqual(["claude/Default", "claude/Work", "codex/Default"]);
    expect(handoff.versions).toBe(2);
    expect(handoff.locations.map((location) => location.invocation)).toEqual(["/handoff", "/handoff", "$handoff"]);
    const kit = read.skills.find((entry) => entry.id === "skill:plugin:kit:kit-skill")!;
    expect(kit.locations.map((location) => [location.accountLabel, location.enabled, location.invocation, location.pluginVersion]))
      .toEqual([["Default", false, "/kit:kit-skill", "1.0.0"], ["Work", true, "/kit:kit-skill", "1.0.0"]]);
    const synced = read.skills.find((entry) => entry.id === "skill:claude.ai:skill-creator")!;
    expect(synced.locations[0]).toMatchObject({ origin: "claude.ai", publisher: "anthropic-example", invocation: "/anthropic-skills:skill-creator" });
    expect(read.skills.some((entry) => entry.name === "gone")).toBe(false);
    const deploy = read.skills.find((entry) => entry.id === "skill:own:deploy-check")!;
    expect(deploy.locations.map((location) => [location.agent, location.accountId, location.projectPath]))
      .toEqual([["claude", undefined, homes.projectFolders[1]], ["codex", undefined, homes.projectFolders[1]]]);
    expect(read.skills.find((entry) => entry.id === "command:own:retro")!.description).toBe("Run the team's retro.");
    expect(read.skills.find((entry) => entry.id === "skill:own:brand-voice")!.locations[0]!.projectPath).toBe(join(homes.projectFolders[1]!, "brand"));
    expect(read.skills.some((entry) => entry.name === "vendored")).toBe(false);
    expect(read.accounts.map((account) => `${account.agent}:${account.label}:${account.skills}`))
      .toEqual(["claude:Default:6", "claude:Work:3", "codex:Default:2"]);
  });

  test("two skills that share a name but not an origin stay apart; one in many places is one", () => {
    const location = (extra: Partial<SkillLocation>): SkillLocation => ({
      agent: "claude", origin: "user", kind: "skill", path: `/x/${Math.random()}`, enabled: true, digest: "a", ...extra,
    });
    expect(skillKey(location({ origin: "plugin", pluginId: "kit@one" }), "a")).toBe(skillKey(location({ origin: "plugin", pluginId: "kit@two", agent: "codex" }), "a"));
    expect(skillKey(location({ origin: "user" }), "a")).toBe(skillKey(location({ origin: "project", agent: "codex" }), "a"));
    expect(skillKey(location({ origin: "system" }), "a")).not.toBe(skillKey(location({ origin: "claude.ai" }), "a"));
    const collapsed = collapseSkills([
      { name: "a", location: location({ path: "/same" }) },
      { name: "a", location: location({ path: "/same" }) },
      { name: "a", location: location({ agent: "codex", path: "/other", digest: "b" }) },
      { name: "../evil", location: location({}) },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.locations).toHaveLength(2);
    expect(collapsed[0]!.versions).toBe(2);
  });

  test("how a skill is called, in each agent's spelling", () => {
    expect(invocationFor("claude", "pdf")).toBe("/pdf");
    expect(invocationFor("claude", "figma-use", { plugin: "figma" })).toBe("/figma:figma-use");
    expect(invocationFor("claude", "docs", { synced: true })).toBe("/anthropic-skills:docs");
    expect(invocationFor("codex", "linear", { plugin: "linear" })).toBe("$linear");
    expect(invocationFor("claude", "quiet", { userInvocable: false })).toBeUndefined();
  });

  test("a command's description is its frontmatter's, else its first line of prose", () => {
    const root = scratch();
    writeFileSync(join(root, "a.md"), "---\nallowed-tools: Bash\ndescription: 'Quoted words'\n---\nBody\n");
    writeFileSync(join(root, "b.md"), "<!-- note -->\n# Title\n\nFirst prose line.\n");
    writeFileSync(join(root, "c.md"), "");
    expect(commandMetadata(join(root, "a.md"))).toEqual({ name: "a", description: "Quoted words" });
    expect(commandMetadata(join(root, "b.md"))).toEqual({ name: "b", description: "First prose line." });
    expect(commandMetadata(join(root, "c.md"))).toEqual({ name: "c" });
  });

  test("a page fits its budget, holds at least one item, and says where the next starts", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ index, padding: "x".repeat(100) }));
    const first = pageOf(items, 0, 400);
    expect(first.items.length).toBe(3);
    expect(first.next).toBe(3);
    expect(pageOf(items, 9, 400)).toEqual({ items: [items[9]] });
    expect(pageOf(items, 0, 10).items).toHaveLength(1);
    expect(pageOf(items, 50, 400)).toEqual({ items: [] });
  });
});

describe("the wire", () => {
  test("each action takes only its own options, and refuses what could reach outside", () => {
    const ok = (value: Record<string, unknown>) => skillsLibraryRequestError({ kind: "skills-library", ...value });
    expect(ok({ action: "installed" })).toBeUndefined();
    expect(ok({ action: "discover", query: "pdf", index: "skills-sh", offset: 40 })).toBeUndefined();
    expect(ok({ action: "add-preview", entryId: "a:b", agent: "claude", accountId: "work" })).toBeUndefined();
    expect(ok({ action: "trial", path: "/x/SKILL.md" })).toBeUndefined();
    expect(ok({ action: "installed", query: "x" })).toContain("takes no query");
    expect(ok({ action: "add", entryId: "a:b", agent: "claude", accountId: "work" })).toContain("planHash");
    expect(ok({ action: "add-preview", entryId: "a:b", agent: "claude", accountId: "../other" })).toBe("Choose an account");
    expect(ok({ action: "trial", path: "relative/SKILL.md" })).toContain("installed skill's file");
    expect(ok({ action: "trial", entryId: "a:b", path: "/x" })).toContain("either");
    expect(ok({ action: "trial", entryId: "a:b" })).toContain("agent");
    expect(ok({ action: "discover", index: "../x" })).toBe("index must name an index");
    expect(ok({ action: "discover", query: "a\u0007" })).toContain("printable");
    expect(ok({ action: "remove" })).toBe("Unknown skills library action");
    expect(validateRuntimeControlMessage({ kind: "skills-library", action: "discover", query: "pdf" })).toEqual({
      ok: true, value: { kind: "skills-library", action: "discover", query: "pdf" },
    });
    expect(validateRuntimeControlMessage({ kind: "skills-library", action: "installed", path: "/etc" }).ok).toBe(false);
    expect(validateRuntimeControlMessage({ kind: "benchmarks" }).ok).toBe(true);
    expect(validateRuntimeControlMessage({ kind: "benchmarks", url: "x" }).ok).toBe(false);
  });

  test("replies are checked before they are believed", () => {
    expect(validateControlResponse({ kind: "skills-library", action: "trial", cwd: "/tmp/x", prompt: "/pdf Show me", agent: "claude", name: "pdf" }).ok).toBe(true);
    expect(validateControlResponse({ kind: "skills-library", action: "installed", accounts: [], skills: [{ id: "x" }], total: 1, problems: [], readAt: 1 }).ok).toBe(false);
    expect(isSkillsLibraryReply({ kind: "skills-library", action: "remove" })).toBe(false);
  });
});

describe("adding a skill", () => {
  function source(): string {
    const dir = join(scratch(), "pdf-tools");
    skill(dir, "pdf-tools");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(dir, "scripts", "run.sh"), 0o755);
    writeFileSync(join(dir, ".DS_Store"), "x");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    return dir;
  }

  test("the plan names every file and where it lands, leaves links behind, and writes nothing", () => {
    const from = source();
    const skills = join(scratch(), "skills");
    const plan = planSkillCopy(from, "pdf-tools", skills);
    expect(plan.refusal).toBeUndefined();
    expect(plan.destination).toBe(join(skills, "pdf-tools"));
    expect(plan.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(plan.skipped).toEqual([{ path: "hosts", reason: "a link; links are never copied" }]);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(skills)).toBe(false);
  });

  test("an apply writes exactly the plan, keeps scripts runnable, and refuses a stale plan or a second copy", () => {
    const from = source();
    const skills = join(scratch(), "skills");
    const plan = planSkillCopy(from, "pdf-tools", skills);
    writeFileSync(join(from, "SKILL.md"), "---\nname: pdf-tools\ndescription: Changed.\n---\n");
    expect(() => applySkillCopy(from, "pdf-tools", skills, plan.planHash)).toThrow("changed since the preview");
    const fresh = planSkillCopy(from, "pdf-tools", skills);
    expect(applySkillCopy(from, "pdf-tools", skills, fresh.planHash)).toBe(join(skills, "pdf-tools"));
    expect(readFileSync(join(skills, "pdf-tools", "SKILL.md"), "utf8")).toContain("Changed.");
    expect(statSync(join(skills, "pdf-tools", "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(skills, "pdf-tools", "hosts"))).toBe(false);
    expect(existsSync(join(skills, "pdf-tools", ".git"))).toBe(false);
    expect(planSkillCopy(from, "pdf-tools", skills).refusal).toContain("already there");
    expect(() => applySkillCopy(from, "pdf-tools", skills, fresh.planHash)).toThrow("already there");
  });

  test("a name that could leave the folder, a folder without SKILL.md, and a SKILL.md without its words are refused", () => {
    const skills = join(scratch(), "skills");
    expect(planSkillCopy(source(), "../escape", skills).refusal).toContain("isn't a name");
    const empty = join(scratch(), "empty");
    mkdirSync(empty);
    writeFileSync(join(empty, "README.md"), "x");
    expect(planSkillCopy(empty, "empty", skills).refusal).toBe("it has no SKILL.md at its top");
    const wordless = join(scratch(), "wordless");
    mkdirSync(wordless);
    writeFileSync(join(wordless, "SKILL.md"), "no frontmatter");
    const plan = planSkillCopy(wordless, "wordless", skills);
    expect(() => applySkillCopy(wordless, "wordless", skills, plan.planHash)).toThrow("no name and description");
    expect(existsSync(join(skills, "wordless"))).toBe(false);
  });
});

describe("trying a skill", () => {
  test("a trial folder of its own, with a skill it hasn't got as a project skill for that agent", () => {
    const root = join(scratch(), "trials");
    const from = join(scratch(), "linear");
    skill(from, "linear");
    const now = new Date(2026, 9, 28, 18, 30, 5);
    const claude = prepareTrialFolder("linear", "claude", from, root, now);
    expect(claude.cwd).toBe(join(root, "linear-20261028-183005"));
    expect(existsSync(join(claude.cwd, ".claude", "skills", "linear", "SKILL.md"))).toBe(true);
    const codex = prepareTrialFolder("linear", "codex", from, root, now);
    expect(codex.cwd).toBe(join(root, "linear-20261028-183006"));
    expect(existsSync(join(codex.cwd, ".agents", "skills", "linear", "SKILL.md"))).toBe(true);
    const bare = prepareTrialFolder("handoff", "claude", undefined, root, now);
    expect(existsSync(bare.cwd)).toBe(true);
    expect(() => prepareTrialFolder("../x", "claude", undefined, root, now)).toThrow("isn't a name");
  });

  test("old trial folders go, and nothing else in the folder does", () => {
    const root = join(scratch(), "trials");
    const old = join(root, "pdf-20260101-000000");
    const mine = join(root, "notes");
    mkdirSync(old, { recursive: true });
    mkdirSync(mine);
    const long = (Date.now() - TRIAL_KEEP_MS - 60_000) / 1000;
    utimesSync(old, long, long);
    utimesSync(mine, long, long);
    expect(sweepTrials(root)).toEqual([old]);
    expect(existsSync(mine)).toBe(true);
  });

  test("the first message calls the skill, and is one line a start takes", () => {
    expect(trialPrompt("pdf", "/pdf")).toStartWith("/pdf Show me what this skill does");
    expect(trialPrompt("quiet")).toStartWith("Use the quiet skill. Show me");
    expect(trialPrompt("x", "$x")).not.toContain("\n");
  });
});

describe("the daemon's handler", () => {
  function provider(folder: string, entry: Partial<DiscoverSkill> = {}): DiscoverProvider {
    const listed: DiscoverSkill = { id: "test-index:kit", index: "test-index", name: "kit-skill", url: "https://example.com", ...entry };
    return {
      list: async () => ({ indexes: [], entries: [listed, { ...listed, id: "test-index:new", name: "brand-new" }], refreshing: false }),
      local: async (id) => {
        if (id !== listed.id) throw new Error("Discover no longer lists that skill; refresh it.");
        return { entry: listed, folder };
      },
    };
  }

  test("discover marks what Tyler has; add previews, writes into the chosen account, and the next listing has it", async () => {
    const homes = machine();
    const from = join(homes.root, "downloaded", "kit-skill");
    skill(from, "kit-skill");
    const library = createSkillsLibrary({ homes: () => homes, discover: provider(from) });
    const discovered = await library.handle({ kind: "skills-library", action: "discover" });
    expect(discovered.action === "discover" && discovered.entries.map((entry) => [entry.name, entry.installed ?? false]))
      .toEqual([["kit-skill", true], ["brand-new", false]]);
    const preview = await library.handle({ kind: "skills-library", action: "add-preview", entryId: "test-index:kit", agent: "codex", accountId: "default" });
    if (preview.action !== "add-preview") throw new Error("no preview");
    expect(preview.preview).toMatchObject({ destination: join(homes.codexAccounts[0]!.configDir, "skills", "kit-skill"), accountLabel: "Default" });
    expect(preview.preview).not.toHaveProperty("source");
    await expect(library.handle({ kind: "skills-library", action: "add-preview", entryId: "test-index:kit", agent: "codex", accountId: "gone" }))
      .rejects.toThrow("removed or is unavailable");
    const added = await library.handle({ kind: "skills-library", action: "add", entryId: "test-index:kit", agent: "codex", accountId: "default", planHash: preview.preview.planHash });
    expect(added).toMatchObject({ action: "add", added: preview.preview.destination });
    const after = await library.handle({ kind: "skills-library", action: "installed" });
    expect(after.action === "installed" && after.skills.find((entry) => entry.id === "skill:own:kit-skill")?.locations[0]?.agent).toBe("codex");
  });

  test("a skill that runs from its plugin's folder is not copied alone, nor tried alone", async () => {
    const homes = machine();
    const from = join(homes.root, "downloaded", "kit-skill");
    skill(from, "kit-skill", "Runs ${CLAUDE_PLUGIN_ROOT}/x");
    const library = createSkillsLibrary({ homes: () => homes, discover: provider(from, { needsPlugin: true, plugin: "kit" }) });
    const preview = await library.handle({ kind: "skills-library", action: "add-preview", entryId: "test-index:kit", agent: "claude", accountId: "work" });
    expect(preview.action === "add-preview" && preview.preview.refusal).toContain("install kit in Settings › Plugins & MCP");
    await expect(library.handle({ kind: "skills-library", action: "trial", entryId: "test-index:kit", agent: "claude" })).rejects.toThrow("Can't try kit-skill alone");
  });

  test("trying an installed skill: its project's folder for a project's, a fresh folder and its own call otherwise; never a path it doesn't list", async () => {
    const homes = machine();
    const library = createSkillsLibrary({ homes: () => homes, discover: provider(homes.root) });
    const listed = await library.handle({ kind: "skills-library", action: "installed" });
    if (listed.action !== "installed") throw new Error("no listing");
    const deploy = listed.skills.find((entry) => entry.id === "skill:own:deploy-check")!.locations[0]!;
    const inProject = await library.handle({ kind: "skills-library", action: "trial", path: deploy.path, agent: "claude", accountId: "work" });
    expect(inProject).toMatchObject({ cwd: deploy.projectPath, agent: "claude", accountId: "work", prompt: expect.stringMatching(/^\/deploy-check Show me/) });
    const kit = listed.skills.find((entry) => entry.id === "skill:plugin:kit:kit-skill")!.locations[1]!;
    const fresh = await library.handle({ kind: "skills-library", action: "trial", path: kit.path, agent: "claude", accountId: "work" });
    expect(fresh).toMatchObject({ accountId: "work", prompt: expect.stringMatching(/^\/kit:kit-skill Show me/) });
    expect(fresh.action === "trial" && fresh.cwd).toContain(join(".cache", "conch", "skill-trials", "kit-skill-"));
    await expect(library.handle({ kind: "skills-library", action: "trial", path: "/etc/hosts" })).rejects.toThrow("isn't where it was");
  });

  test("Discover passes every page's entries in order, each page within a frame", async () => {
    const homes = machine();
    const many: DiscoverSkill[] = Array.from({ length: 900 }, (_, index) => ({
      id: `big:${index}`, index: "big", name: `skill-${index}`, url: "https://example.com", description: "d".repeat(300),
    }));
    const library = createSkillsLibrary({
      homes: () => homes,
      discover: { list: async () => ({ indexes: [], entries: many, refreshing: false }), local: async () => { throw new Error("no"); } },
    });
    const seen: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await library.handle({ kind: "skills-library", action: "discover", offset });
      if (page.action !== "discover") throw new Error("no page");
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
      seen.push(...page.entries.map((entry) => entry.id));
      offset = page.next;
    }
    expect(seen).toEqual(many.map((entry) => entry.id));
  });
});

test("an entry Tyler has under another name's case is still his", () => {
  expect(markInstalled([{ id: "a", index: "i", name: "PDF", url: "https://x" }], [{ id: "x", name: "pdf", origin: "user", kind: "skill", locations: [], versions: 1 }])[0]!.installed).toBe(true);
});

test("a description written as a YAML block with a chomping indicator is read as its words, not as `|-`", async () => {
  const { readSkillMetadata } = await import("../src/agent-capabilities.ts");
  const root = scratch();
  writeFileSync(join(root, "a.md"), "---\nname: claude-api\ndescription: |-\n  Reference for the Claude API.\n  TRIGGER when asked.\n---\n");
  writeFileSync(join(root, "b.md"), "---\nname: folded\ndescription: >-\n  One line\n  folded.\n---\n");
  expect(readSkillMetadata(join(root, "a.md")).description).toBe("Reference for the Claude API.\nTRIGGER when asked.");
  expect(readSkillMetadata(join(root, "b.md")).description).toBe("One line folded.");
});

describe("the Mac app's ways in", () => {
  const mac = (name: string) => readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", name), "utf8");

  test("the header's sparkles and ⌘K's two rows open Settings at Skills and Benchmarks", () => {
    expect(mac("DashboardView.swift")).toContain('symbol: "sparkles",');
    expect(mac("DashboardView.swift")).toContain("action: { SettingsRouter.shared.open(.skills) }");
    const palette = mac("CommandPaletteView.swift");
    expect(palette).toContain("action: .settings(.skills)");
    expect(palette).toContain("action: .settings(.benchmarks)");
    expect(palette).toContain("case let .settings(section):\n            SettingsRouter.shared.open(section)");
    const page = mac("SettingsView.swift");
    expect(page).toContain("case .skills: ConchSkillsSettingsView()");
    expect(page).toContain("case .benchmarks: ConchBenchmarksSettingsView()");
  });

  test("Try starts its session through the app's one start, with the daemon's first message", () => {
    const view = mac("SkillsLibraryView.swift");
    expect(view).toContain("await stateStore.startSession(");
    expect(view).toContain("prompt: trial.prompt");
    expect(mac("ConchSocketClient.swift")).toContain("let prompt: String?");
  });
});

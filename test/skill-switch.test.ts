import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSkillOverride } from "../src/config-write.ts";
import {
  createSkillsLibrary,
  isSkillsLibraryReply,
  projectSkillOverrides,
  skillsLibraryRequestError,
  toggleRefusal,
  type DiscoverProvider,
  type SkillLocation,
} from "../src/skills-library.ts";

// A skill's switch in Settings › Skills (2026-11-11). Tyler: "making the rest of the app like skills, workflows, etc much
// more pleasurable to use." A Claude skill of the person's own is switched on or off for new sessions the way Claude Code
// itself does it, `skillOverrides["<name>"]: "off"` in a settings file (Claude Code 2.1.322's schema: "Per-skill listing
// overrides keyed by skill name … Absent = on"), previewed as a diff first and written with the preview's hash, as the
// plugin and server switches are (config-write.ts).

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conch-skill-switch-")));
  dirs.push(dir);
  return dir;
}
function write(path: string, text: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("a skill's switch: Claude Code's skillOverrides, previewed, then written", () => {
  test("off writes \"off\" by name; on removes it, and an empty object with it; the rest of the file is untouched", () => {
    const file = write(join(scratch(), "settings.json"), JSON.stringify({ model: "opus", skillOverrides: { other: "name-only" } }, null, 2) + "\n");
    const off = planSkillOverride(file, "handoff", false);
    expect(JSON.parse(off.after)).toEqual({ model: "opus", skillOverrides: { other: "name-only", handoff: "off" } });
    expect(off.diff).toContain('+    "handoff": "off"');
    writeFileSync(file, off.after);
    const on = planSkillOverride(file, "handoff", true);
    expect(JSON.parse(on.after)).toEqual({ model: "opus", skillOverrides: { other: "name-only" } });
    const empty = write(join(scratch(), "settings.json"), JSON.stringify({ skillOverrides: { handoff: "off" } }));
    expect(JSON.parse(planSkillOverride(empty, "handoff", true).after)).toEqual({});
    // Already on, and no file: nothing to write.
    const none = planSkillOverride(join(scratch(), "settings.json"), "handoff", true);
    expect(none.after).toBe(none.before);
    expect(() => planSkillOverride(write(join(scratch(), "settings.json"), '{"skillOverrides": []}'), "x", false)).toThrow("not an object");
  });

  function fixture() {
    const root = scratch();
    const claude = join(root, "claude");
    const project = join(root, "storefront");
    for (const [folder, name] of [[join(claude, "skills", "handoff"), "handoff"], [join(project, ".claude", "skills", "deploy-check"), "deploy-check"]] as const) {
      write(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: What ${name} does.\n---\n`);
    }
    mkdirSync(join(project, ".git"), { recursive: true });
    const homes = { claudeAccounts: [{ id: "default", label: "Default", configDir: claude }], codexAccounts: [], agentsHome: null, projectFolders: [project] };
    const discover: DiscoverProvider = { list: async () => ({ indexes: [], entries: [], refreshing: false }), local: async () => { throw new Error("none"); } };
    return { claude, project, library: createSkillsLibrary({ homes: () => homes, discover }) };
  }

  test("an account's own skill: preview, then the write it previewed, then the list reads it as off", async () => {
    const { claude, library } = fixture();
    const path = join(claude, "skills", "handoff", "SKILL.md");
    const preview = await library.handle({ kind: "skills-library", action: "toggle-preview", path, agent: "claude", accountId: "default", enabled: false });
    expect(isSkillsLibraryReply(preview)).toBe(true);
    if (preview.action !== "toggle-preview") throw new Error(preview.action);
    expect(preview).toMatchObject({ name: "handoff", file: join(claude, "settings.json"), applied: false });
    expect(preview.diff).toContain('"handoff": "off"');
    await expect(library.handle({ kind: "skills-library", action: "toggle", path, agent: "claude", accountId: "default", enabled: false, planHash: "0".repeat(64) }))
      .rejects.toThrow("changed since the preview");
    const applied = await library.handle({ kind: "skills-library", action: "toggle", path, agent: "claude", accountId: "default", enabled: false, planHash: preview.planHash });
    expect(applied).toMatchObject({ applied: true });
    expect(JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"))).toEqual({ skillOverrides: { handoff: "off" } });
    const listed = await library.handle({ kind: "skills-library", action: "installed" });
    if (listed.action !== "installed") throw new Error(listed.action);
    expect(listed.skills.find((skill) => skill.name === "handoff")!.locations[0]!.enabled).toBe(false);
  });

  test("a project's skill is switched in the project's local settings, and reads back", async () => {
    const { project, library } = fixture();
    const path = join(project, ".claude", "skills", "deploy-check", "SKILL.md");
    const preview = await library.handle({ kind: "skills-library", action: "toggle-preview", path, agent: "claude", enabled: false });
    if (preview.action !== "toggle-preview") throw new Error(preview.action);
    expect(preview.file).toBe(join(project, ".claude", "settings.local.json"));
    await library.handle({ kind: "skills-library", action: "toggle", path, agent: "claude", enabled: false, planHash: preview.planHash });
    expect(projectSkillOverrides(project).get("deploy-check")).toBe("off");
    const listed = await library.handle({ kind: "skills-library", action: "installed", refresh: true });
    if (listed.action !== "installed") throw new Error(listed.action);
    expect(listed.skills.find((skill) => skill.name === "deploy-check")!.locations.find((location) => location.agent === "claude")!.enabled).toBe(false);
  });

  test("what isn't the person's own Claude skill is refused, in words that say where it is switched", () => {
    const base: SkillLocation = { agent: "claude", origin: "user", kind: "skill", path: "/s/SKILL.md", enabled: true, digest: "" };
    expect(toggleRefusal(base)).toBeUndefined();
    expect(toggleRefusal({ ...base, origin: "project" })).toBeUndefined();
    expect(toggleRefusal({ ...base, origin: "plugin" })).toContain("Plugins & MCP");
    expect(toggleRefusal({ ...base, origin: "claude.ai" })).toContain("claude.ai");
    expect(toggleRefusal({ ...base, agent: "codex" })).toContain("config.toml");
    expect(toggleRefusal({ ...base, kind: "command" })).toContain("command");
    expect(toggleRefusal({ ...base, origin: "managed" })).toContain("manages this Mac");
  });

  test("the requests are checked before anything is read", () => {
    expect(skillsLibraryRequestError({ action: "toggle-preview", path: "/s", agent: "claude" })).toBe("Choose the skill, and whether it is on");
    expect(skillsLibraryRequestError({ action: "toggle", path: "/s", agent: "claude", enabled: false })).toBe("toggle carries the preview's planHash");
    expect(skillsLibraryRequestError({ action: "toggle-preview", path: "/s", agent: "claude", enabled: "no" })).toBe("enabled must be true or false");
  });
});

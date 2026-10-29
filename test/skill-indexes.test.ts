import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSkillIndexes,
  directoryEntries,
  githubRepo,
  isProprietaryLicense,
  matchScore,
  needsItsPlugin,
  repoPath,
  skillsInListing,
  skillsShEntry,
  type Fetcher,
  type SkillIndexDefinition,
} from "../src/skill-indexes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conch-indexes-")));
  dirs.push(dir);
  return dir;
}
function skill(folder: string, name: string, extra = ""): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: What ${name} does.\n---\n\n${extra}`);
}
/** A repository as codeload serves it: one top folder, `<repo>-<ref>/`. */
function tarball(build: (top: string) => void): Uint8Array {
  const root = scratch();
  const top = join(root, "skills-main");
  build(top);
  const out = join(root, "repo.tar.gz");
  const made = Bun.spawnSync(["/usr/bin/tar", "-czf", out, "-C", root, "skills-main"]);
  if (made.exitCode !== 0) throw new Error(made.stderr.toString());
  return new Uint8Array(readFileSync(out));
}

describe("reading an index's shape", () => {
  test("skills under the roots, not nested inside another skill, nor too deep", () => {
    const listing = [
      "r-main/", "r-main/skills/a/SKILL.md", "r-main/skills/a/inner/SKILL.md", "r-main/skills/b/SKILL.md",
      "r-main/other/c/SKILL.md", "r-main/skills/SKILL.md", "r-main/skills/1/2/3/4/5/6/7/SKILL.md",
    ];
    expect(skillsInListing(listing, ["skills/"])).toEqual({ top: "r-main", skills: ["skills/a", "skills/b"] });
    expect(skillsInListing(listing, [""]).skills).toEqual(["other/c", "skills"]);
  });

  test("only github.com repositories, and only paths that stay inside them", () => {
    expect(githubRepo("https://github.com/obra/superpowers")).toEqual({ owner: "obra", repo: "superpowers" });
    expect(githubRepo("https://github.com/qodo-ai/qodo-skills.git")).toEqual({ owner: "qodo-ai", repo: "qodo-skills" });
    for (const url of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a/b/tree/main", "https://user:pw@github.com/a/b", "nope"]) {
      expect(githubRepo(url)).toBeUndefined();
    }
    expect(repoPath("./plugins/kit/")).toBe("plugins/kit");
    expect(repoPath("")).toBe("");
    expect(repoPath("plugins/../../etc")).toBeUndefined();
    expect(repoPath("a\\b")).toBeUndefined();
  });

  test("a licence that reserves every right is proprietary; an open one that also says so is not", () => {
    expect(isProprietaryLicense("© 2025 Anthropic, PBC. All rights reserved.\nLICENSE: Use of these materials is governed by your agreement")).toBe(true);
    expect(isProprietaryLicense("Apache License\nVersion 2.0 ... All rights reserved.")).toBe(false);
    expect(isProprietaryLicense("MIT License\nPermission is hereby granted")).toBe(false);
  });

  test("a skill that reaches into its plugin's folder needs its plugin", () => {
    expect(needsItsPlugin("Run ${CLAUDE_PLUGIN_ROOT}/scripts/x.sh")).toBe(true);
    expect(needsItsPlugin("Run $PLUGIN_ROOT/x")).toBe(true);
    expect(needsItsPlugin("Run scripts/x.sh")).toBe(false);
  });

  test("a directory plugin is one entry per skill, with where its files are kept off the wire", () => {
    const plugin = {
      id: "plugin_1", name: "Frontend design", verified_tier: "anthropic", license: "Apache-2.0",
      source: { repository: { url: "https://github.com/anthropics/claude-plugins-official", path: "plugins/frontend-design", reviewed_commit: "f8c5e7a1dcb71b10cb74586224b5401f3de5db28" } },
      components: [
        { type: "skill", name: "frontend-design", key: "k1", description: "Guidance for distinctive visual design." },
        { type: "hook", name: "SessionStart", key: "k2" },
        { type: "skill", name: "../bad", key: "k3" },
      ],
    };
    const entries = directoryEntries("anthropic-directory", plugin);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "anthropic-directory:plugin_1:k1", name: "frontend-design", plugin: "Frontend design", trust: "anthropic", license: "Apache-2.0",
      repo: "anthropics/claude-plugins-official", path: "plugins/frontend-design",
      url: "https://github.com/anthropics/claude-plugins-official/tree/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/frontend-design",
    });
    expect(directoryEntries("d", { ...plugin, verified_tier: "unknown" })[0]!.trust).toBe("community");
    expect(directoryEntries("d", { ...plugin, source: { repository: { url: "https://gitlab.com/a/b", reviewed_commit: "abcdef1" } } })).toEqual([]);
    expect(directoryEntries("d", { ...plugin, source: { repository: { url: "https://github.com/a/b", reviewed_commit: "main" } } })).toEqual([]);
  });

  test("a skills.sh result names its GitHub repository and page", () => {
    expect(skillsShEntry({ id: "anthropics/skills/pdf", source: "anthropics/skills", name: "pdf", installs: 218802 })[0]).toEqual({
      id: "skills-sh:anthropics/skills/pdf", index: "skills-sh", name: "pdf", repo: "anthropics/skills",
      url: "https://skills.sh/anthropics/skills/pdf", installs: 218802,
    });
    expect(skillsShEntry({ id: "../../x" })).toEqual([]);
    expect(skillsShEntry({ id: "smithery.ai/pdf" })).toEqual([]);
  });

  test("a search ranks the name first, needs every word, and an empty one matches all", () => {
    const pdf = { name: "pdf", description: "Read PDF files" };
    const merge = { name: "merge-docs", description: "Merge PDF and Word files", plugin: "office" };
    expect(matchScore(pdf, "pdf")).toBeGreaterThan(matchScore(merge, "pdf"));
    expect(matchScore(merge, "pdf merge")).toBeGreaterThan(0);
    expect(matchScore(merge, "pdf excel")).toBe(0);
    expect(matchScore(merge, "office")).toBeGreaterThan(matchScore(merge, "word"));
    expect(matchScore(pdf, "  ")).toBe(1);
  });
});

describe("the indexes, read and opened", () => {
  const repoIndex: SkillIndexDefinition = {
    id: "test-skills", name: "Test skills", maintainer: "Tests", url: "https://github.com/test/skills", agents: ["claude"],
    kind: "repo", repo: { owner: "test", name: "skills", roots: ["skills/"] },
  };
  const searchIndex: SkillIndexDefinition = { id: "skills-sh", name: "skills.sh", maintainer: "Vercel", url: "https://skills.sh", agents: ["claude", "codex"], kind: "search" };

  function server(archive: Uint8Array, calls: string[]): Fetcher {
    return async (url, init) => {
      calls.push(url);
      if (url.startsWith("https://codeload.github.com/test/skills/")) {
        if (init?.headers?.["if-none-match"] === "\"v1\"") return new Response(null, { status: 304 });
        return new Response(archive, { headers: { etag: "\"v1\"" } });
      }
      if (url.startsWith("https://skills.sh/api/search?q=notes")) {
        return Response.json({ skills: [{ id: "someone/tools/notes", source: "someone/tools", name: "notes", installs: 12 }] });
      }
      if (url === "https://skills.sh/api/download/someone/tools/notes") {
        return Response.json({ files: [{ path: "SKILL.md", contents: "---\nname: notes\ndescription: Takes notes.\n---\n" }, { path: "ref/guide.md", contents: "Guide" }] });
      }
      if (url === "https://skills.sh/api/download/someone/tools/escape") {
        return Response.json({ files: [{ path: "../../escape.md", contents: "x" }, { path: "SKILL.md", contents: "---\nname: escape\ndescription: x\n---\n" }] });
      }
      return new Response("not found", { status: 404 });
    };
  }

  test("a repository index lists its skills, leaves proprietary ones out, re-reads only on a new ETag, and opens a skill's folder", async () => {
    const archive = tarball((top) => {
      skill(join(top, "skills", "notes"), "notes");
      mkdirSync(join(top, "skills", "notes", "scripts"), { recursive: true });
      writeFileSync(join(top, "skills", "notes", "scripts", "run.py"), "print('hi')\n");
      skill(join(top, "skills", "plugin-bound"), "plugin-bound", "Run ${CLAUDE_PLUGIN_ROOT}/x");
      skill(join(top, "skills", "closed"), "closed");
      writeFileSync(join(top, "skills", "closed", "LICENSE.txt"), "© 2025 Maker. All rights reserved. Governed by your agreement.");
      mkdirSync(join(top, "skills", "broken"), { recursive: true });
      writeFileSync(join(top, "skills", "broken", "SKILL.md"), "no frontmatter");
    });
    const root = scratch();
    const calls: string[] = [];
    let clock = 1_000;
    const indexes = createSkillIndexes({ root, fetch: server(archive, calls), indexes: [repoIndex, searchIndex], now: () => clock });
    await indexes.refreshNow();
    const listed = await indexes.list({});
    expect(listed.indexes[0]).toMatchObject({ id: "test-skills", count: 2, fetchedAt: 1_000 });
    expect(listed.entries.map((entry) => [entry.name, entry.needsPlugin ?? false])).toEqual([["notes", false], ["plugin-bound", true]]);
    expect(listed.entries[0]).toMatchObject({ id: "test-skills:skills/notes", repo: "test/skills", path: "skills/notes", description: "What notes does." });
    expect(readdirSync(join(root, "test-skills")).filter((name) => name.startsWith(".heads"))).toEqual([]);

    const opened = await indexes.local("test-skills:skills/notes");
    expect(readFileSync(join(opened.folder, "scripts", "run.py"), "utf8")).toBe("print('hi')\n");
    expect(opened.entry.local).toBe(opened.folder);
    expect(opened.folder.startsWith(join(root, "test-skills", "skills"))).toBe(true);

    clock += 1;
    await indexes.refreshNow();
    expect(calls.filter((url) => url.includes("codeload"))).toHaveLength(2);
    expect((await indexes.list({})).indexes[0]!.fetchedAt).toBe(1_001);
    expect(existsSync(opened.folder)).toBe(true);
    await expect(indexes.local("test-skills:skills/gone")).rejects.toThrow("no longer lists");
  });

  test("an index that can't be read says why, and keeps what it listed before", async () => {
    const root = scratch();
    let up = true;
    const archive = tarball((top) => skill(join(top, "skills", "notes"), "notes"));
    const fetcher: Fetcher = async (url, init) => up ? server(archive, [])(url, init) : new Response("down", { status: 503 });
    const indexes = createSkillIndexes({ root, fetch: fetcher, indexes: [repoIndex], now: () => 5 });
    await indexes.refreshNow();
    up = false;
    rmSync(join(root, "test-skills", "repo.tar.gz"));
    await indexes.refreshNow();
    const listed = await indexes.list({});
    expect(listed.indexes[0]).toMatchObject({ count: 1, error: "GitHub answered 503 for test/skills" });
  });

  test("skills.sh is asked only for a search, and its download is written file by file inside the skill's folder", async () => {
    const root = scratch();
    const calls: string[] = [];
    const indexes = createSkillIndexes({ root, fetch: server(new Uint8Array(), calls), indexes: [searchIndex] });
    expect((await indexes.list({})).entries).toEqual([]);
    expect((await indexes.list({ query: "n" })).entries).toEqual([]);
    expect(calls).toEqual([]);
    const found = await indexes.list({ query: "notes" });
    expect(found.entries.map((entry) => entry.id)).toEqual(["skills-sh:someone/tools/notes"]);
    expect(found.indexes[0]!.count).toBe(1);
    const opened = await indexes.local("skills-sh:someone/tools/notes");
    expect(readFileSync(join(opened.folder, "ref", "guide.md"), "utf8")).toBe("Guide");
    expect(opened.entry.description).toBe("Takes notes.");
    await expect(indexes.local("skills-sh:someone/tools/escape")).rejects.toThrow("can't place safely");
    expect(existsSync(join(root, "skills-sh", "escape.md"))).toBe(false);
  });
});

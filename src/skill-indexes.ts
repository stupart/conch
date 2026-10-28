import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSkillMetadata } from "./agent-capabilities.ts";
import { conchHome } from "./home.ts";
import { COPY_BYTES_MAX, COPY_FILES_MAX } from "./skill-install.ts";
import { shortDescription, type DiscoverProvider, type DiscoverSkill, type SkillAgent, type SkillIndexStatus } from "./skills-library.ts";

/**
 * The public skill indexes Discover reads (2026-10-28). Each was checked by hand on 28 Oct 2026 — that it is real,
 * maintained, and readable without a key — and read the cheapest way it allows:
 *
 * - **Claude's plugin directory** — Anthropic's, the one Claude Code's `/plugin` and claude.com/plugins browse:
 *   `api.anthropic.com/api/directory/plugins`, public and unauthenticated, about 3,600 plugins carrying 18,000 skills, each
 *   plugin marked reviewed by Anthropic, by a partner, or not at all (community). It names a skill and its plugin's
 *   repository at the commit Anthropic reviewed, not the skill's folder, so opening one downloads that commit and finds
 *   the SKILL.md whose name matches.
 * - **anthropics/skills**, Anthropic's own skills, and **openai/skills**' curated set (deprecated by OpenAI for
 *   openai/plugins, kept because Codex's own `skill-installer` still reads it): each repository is one tarball from
 *   codeload, re-read only when its ETag changes. Four of Anthropic's (docx, pdf, pptx, xlsx) are proprietary — their
 *   licence keeps them inside Anthropic's own services, where Tyler already has them through claude.ai — so a skill
 *   whose LICENSE reserves all rights is left out of the list and never kept. Codex's `.system` skills ship with Codex
 *   and are left out too.
 * - **openai/plugins**, OpenAI's current catalog for Codex: its plugins' skills, from one 26 MB tarball a day.
 * - **skills.sh**, Vercel's directory: search only. Its open endpoints (`/api/search`, `/api/download`, what `npx skills`
 *   calls) give no descriptions and no full list, and its documented API wants a Vercel token, so it is asked only when
 *   Tyler types a search, and a skill's files come from its download, which holds text files only.
 *
 * Rejected, and why, is in docs/skills-library.md.
 *
 * Everything lands under `~/.cache/conch/skill-indexes/<index>/`: the tarball and its ETag, `index.json` with what was
 * listed, and `skills/<id>/` for a skill opened, added or tried. Nothing downloaded is run. Archives are unpacked by
 * macOS's `tar`, which refuses absolute paths, `..` and writing through a link, into a fresh folder; links in a skill
 * are never copied (skill-install.ts).
 */

export interface SkillIndexDefinition {
  id: string;
  name: string;
  maintainer: string;
  url: string;
  agents: SkillAgent[];
  kind: "repo" | "directory" | "search";
  /** A repository read as one tarball: where its skills are, and whether they sit inside plugins. */
  repo?: { owner: string; name: string; roots: string[]; plugins?: boolean };
}

/** In the order "all" lists them: the curated repositories first, the 18,000-skill directory after, search last. */
export const SKILL_INDEXES: readonly SkillIndexDefinition[] = [
  {
    id: "anthropic-skills", name: "Anthropic skills", maintainer: "Anthropic", url: "https://github.com/anthropics/skills",
    agents: ["claude"], kind: "repo", repo: { owner: "anthropics", name: "skills", roots: ["skills/"] },
  },
  {
    id: "openai-skills", name: "OpenAI curated", maintainer: "OpenAI", url: "https://github.com/openai/skills",
    agents: ["codex"], kind: "repo", repo: { owner: "openai", name: "skills", roots: ["skills/.curated/"] },
  },
  {
    id: "openai-plugins", name: "Codex plugins", maintainer: "OpenAI", url: "https://github.com/openai/plugins",
    agents: ["codex"], kind: "repo", repo: { owner: "openai", name: "plugins", roots: ["plugins/"], plugins: true },
  },
  {
    id: "anthropic-directory", name: "Claude directory", maintainer: "Anthropic", url: "https://claude.com/plugins",
    agents: ["claude"], kind: "directory",
  },
  {
    id: "skills-sh", name: "skills.sh", maintainer: "Vercel", url: "https://skills.sh",
    agents: ["claude", "codex"], kind: "search",
  },
];

export const DIRECTORY_URL = "https://api.anthropic.com/api/directory/plugins";
export const SKILLS_SH = "https://skills.sh";
/** How long a listing stands before Discover reads its index again. */
export const INDEX_FRESH_MS = 24 * 60 * 60 * 1000;
const TARBALL_MAX_BYTES = 96 * 1024 * 1024;
const DIRECTORY_PAGES_MAX = 12;
const FETCH_TIMEOUT_MS = 90_000;
const SEARCH_FRESH_MS = 10 * 60 * 1000;
const SEARCH_LIMIT = 60;
/** How deep below an index's root a SKILL.md is looked for: a plugin's skills sit three folders down. */
const SKILL_DEPTH_MAX = 6;

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;
/** `tar` with these arguments, in `cwd`; resolves to its stdout, rejects with its stderr. */
export type TarRunner = (args: string[], cwd?: string) => Promise<string>;

export const runTar: TarRunner = async (args, cwd) => {
  const child = Bun.spawn(["/usr/bin/tar", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`tar ${args[0]} failed: ${err.trim().split("\n").slice(-2).join(" ") || `exit ${code}`}`);
  return out;
};

export function skillIndexesRoot(home: string = conchHome()): string {
  return join(home, ".cache", "conch", "skill-indexes");
}

interface StoredIndex {
  fetchedAt: number;
  etag?: string;
  entries: DiscoverSkill[];
}

interface DirectorySource {
  owner: string;
  repo: string;
  commit: string;
  path?: string;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2_000): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) ? value.trim() : undefined;
/** One part of a GitHub name: never `.` or `..`, which the pattern alone would let through. */
const GITHUB_PART = /^(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

/** `https://github.com/<owner>/<repo>(.git)` and nothing else: the only place an index's files are fetched from. */
export function githubRepo(url: unknown): { owner: string; repo: string } | undefined {
  const raw = text(url, 400);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password) return undefined;
    const [owner, repo, ...rest] = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    const name = repo?.replace(/\.git$/, "");
    if (rest.length || !owner || !name || !GITHUB_PART.test(owner) || !GITHUB_PART.test(name)) return undefined;
    return { owner, repo: name };
  } catch {
    return undefined;
  }
}

/** A path inside a repository, as an index gives it: relative, "/"-separated, no `.` or `..` part. */
export function repoPath(value: unknown): string | undefined {
  if (value === "") return "";
  const raw = text(value, 400)?.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (raw === undefined) return undefined;
  if (!raw) return "";
  const parts = raw.split("/");
  return parts.every((part) => part && part !== "." && part !== ".." && !/[\\]/.test(part)) ? parts.join("/") : undefined;
}

/** A licence that reserves every right: the skill is its maker's to share, not conch's to copy. */
export function isProprietaryLicense(license: string): boolean {
  return /all rights reserved/i.test(license)
    && !/apache license|mit license|permission is hereby granted|creative commons|mozilla public license|gnu (?:lesser )?general public/i.test(license);
}

/** Its SKILL.md reaches into its plugin's own folder, so the skill alone would not run (`DiscoverSkill.needsPlugin`). */
export function needsItsPlugin(skillText: string): boolean {
  return /\$\{?(?:CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT|PLUGIN_ROOT)\}?/.test(skillText);
}

/**
 * The SKILL.md files a tarball listing holds under `roots`, as paths without the archive's top folder: at most
 * `SKILL_DEPTH_MAX` folders down, and not inside another skill's folder (as the skills CLI reads a repository).
 */
export function skillsInListing(members: readonly string[], roots: readonly string[]): { top: string; skills: string[] } {
  const top = members.find((member) => member.includes("/"))?.split("/")[0] ?? "";
  const found = new Set<string>();
  for (const member of members) {
    if (!member.startsWith(`${top}/`) || !member.endsWith("/SKILL.md")) continue;
    const inner = member.slice(top.length + 1);
    const root = roots.find((candidate) => inner.startsWith(candidate));
    if (root === undefined) continue;
    const folder = inner.slice(0, -"/SKILL.md".length);
    // Below the root, never the root itself: `skills/SKILL.md` is no skill of `skills/`.
    if (folder.length <= root.length - 1 || (root && !folder.startsWith(root))) continue;
    const depth = folder.slice(root.length).split("/").length;
    if (!folder || depth < 1 || depth > SKILL_DEPTH_MAX || folder.split("/").some((part) => part === ".." || part === ".")) continue;
    found.add(folder);
  }
  const folders = [...found].sort();
  return { top, skills: folders.filter((folder) => !folders.some((other) => other !== folder && folder.startsWith(`${other}/`))) };
}

function entryId(index: string, where: string): string {
  return `${index}:${where}`;
}

/** A folder name for an entry's files: its id's hash, so no index can choose where they land. */
function slot(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

/** A response's body, written to `path` as it arrives, refused past `max` bytes. */
async function download(response: Response, path: string, max: number): Promise<void> {
  if (!response.body) throw new Error("the download was empty");
  const temporary = `${path}.${randomUUID()}.part`;
  mkdirSync(dirname(path), { recursive: true });
  const writer = Bun.file(temporary).writer();
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > max) throw new Error(`the download is over ${Math.round(max / 1024 / 1024)} MB`);
      writer.write(chunk);
    }
    await writer.end();
    renameSync(temporary, path);
  } catch (error) {
    try { await writer.end(); } catch {}
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readStored(path: string): StoredIndex | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(parsed) || typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.entries)) return undefined;
    return parsed as unknown as StoredIndex;
  } catch {
    return undefined;
  }
}

function writeStored(path: string, stored: StoredIndex): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(stored));
  renameSync(temporary, path);
}

/** How well an entry matches every word of `query`: its name first, then its plugin, then the rest; 0 is no match. */
export function matchScore(entry: Pick<DiscoverSkill, "name" | "description" | "plugin" | "repo">, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const name = entry.name.toLowerCase();
  const rest = [entry.plugin, entry.repo, entry.description].filter(Boolean).join(" ").toLowerCase();
  let score = 0;
  for (const word of words) {
    if (name === word) score += 100;
    else if (name.startsWith(word)) score += 60;
    else if (name.includes(word)) score += 40;
    else if (entry.plugin?.toLowerCase().includes(word)) score += 20;
    else if (rest.includes(word)) score += 10;
    else return 0;
  }
  return score;
}

const TRUST_RANK: Record<string, number> = { anthropic: 0, partner: 1, community: 2 };

export interface SkillIndexOptions {
  root?: string;
  fetch?: Fetcher;
  tar?: TarRunner;
  now?(): number;
  indexes?: readonly SkillIndexDefinition[];
  log?(line: string): void;
}

/**
 * Discover's indexes: read from the cache at once, read again in the background when a day old (or when asked), and a
 * skill's files fetched when it is opened, added or tried.
 */
export function createSkillIndexes(options: SkillIndexOptions = {}): DiscoverProvider & { refreshNow(): Promise<void> } {
  const root = options.root ?? skillIndexesRoot();
  const fetcher: Fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const tar = options.tar ?? runTar;
  const now = options.now ?? Date.now;
  const indexes = options.indexes ?? SKILL_INDEXES;
  const log = options.log ?? (() => {});
  const errors = new Map<string, string>();
  const stored = new Map<string, StoredIndex>();
  const searches = new Map<string, { at: number; entries: DiscoverSkill[] }>();
  let searchError: string | undefined;
  let refreshing: Promise<void> | undefined;
  /** Where each listed entry's files come from, kept beside the listing rather than on the wire. */
  const directorySources = new Map<string, DirectorySource>();

  const folder = (index: string) => join(root, index);
  const indexFile = (index: string) => join(folder(index), "index.json");

  const load = (index: SkillIndexDefinition): StoredIndex | undefined => {
    if (!stored.has(index.id)) {
      const read = readStored(indexFile(index.id));
      if (read) {
        stored.set(index.id, read);
        if (index.kind === "directory") rememberDirectory(read.entries);
      }
    }
    return stored.get(index.id);
  };

  const rememberDirectory = (entries: readonly DiscoverSkill[]) => {
    for (const entry of entries) {
      const source = (entry as DiscoverSkill & { source?: DirectorySource }).source;
      if (source) directorySources.set(entry.id, source);
    }
  };

  const get = async (url: string, headers: Record<string, string> = {}) => {
    const response = await fetcher(url, { headers: { "user-agent": "conch-skills-library", ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return response;
  };

  /** The repository's tarball, fetched again only when its ETag moved. True when it changed. */
  const fetchTarball = async (index: SkillIndexDefinition, previous?: string): Promise<{ path: string; etag?: string; changed: boolean }> => {
    const { owner, name } = index.repo!;
    const path = join(folder(index.id), "repo.tar.gz");
    const response = await get(`https://codeload.github.com/${owner}/${name}/tar.gz/HEAD`,
      previous && existsSync(path) ? { "if-none-match": previous } : {});
    if (response.status === 304) return { path, etag: previous, changed: false };
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${owner}/${name}`);
    await download(response, path, TARBALL_MAX_BYTES);
    const etag = response.headers.get("etag") ?? undefined;
    return { path, ...(etag ? { etag } : {}), changed: true };
  };

  /** Every SKILL.md (and the licence beside it) in a tarball under `roots`, unpacked into a scratch folder and read. */
  const readSkillHeads = async (tarball: string, roots: string[], scratch: string) => {
    const members = (await tar(["-tzf", tarball])).split("\n").filter(Boolean);
    const { top, skills } = skillsInListing(members, roots);
    const memberSet = new Set(members);
    const wanted: string[] = [];
    for (const skill of skills) {
      wanted.push(`${top}/${skill}/SKILL.md`);
      for (const license of ["LICENSE.txt", "LICENSE", "LICENSE.md"]) {
        if (memberSet.has(`${top}/${skill}/${license}`)) wanted.push(`${top}/${skill}/${license}`);
      }
    }
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    if (wanted.length) {
      const list = join(scratch, ".members");
      writeFileSync(list, `${wanted.join("\n")}\n`);
      await tar(["-xzf", tarball, "-C", scratch, "-T", list]);
    }
    return skills.map((skill) => {
      const base = join(scratch, top, ...skill.split("/"));
      const license = ["LICENSE.txt", "LICENSE", "LICENSE.md"].map((file) => join(base, file)).find((file) => existsSync(file));
      let skillText = "";
      try { skillText = readFileSync(join(base, "SKILL.md"), "utf8").slice(0, 256 * 1024); } catch {}
      let metadata: ReturnType<typeof readSkillMetadata> | undefined;
      try { metadata = readSkillMetadata(join(base, "SKILL.md")); } catch {}
      return {
        folder: skill,
        top,
        metadata,
        proprietary: license ? isProprietaryLicense(readFileSync(license, "utf8").slice(0, 8_192)) : false,
        needsPlugin: needsItsPlugin(skillText),
      };
    });
  };

  const refreshRepo = async (index: SkillIndexDefinition) => {
    const previous = load(index);
    const tarball = await fetchTarball(index, previous?.etag);
    if (!tarball.changed && previous) {
      const kept = { ...previous, fetchedAt: now() };
      stored.set(index.id, kept);
      writeStored(indexFile(index.id), kept);
      return;
    }
    const scratch = join(folder(index.id), `.heads-${randomUUID()}`);
    try {
      const heads = await readSkillHeads(tarball.path, index.repo!.roots, scratch);
      const { owner, name } = index.repo!;
      const entries: DiscoverSkill[] = [];
      for (const head of heads) {
        if (head.proprietary || !head.metadata?.valid) continue;
        const plugin = index.repo!.plugins ? head.folder.split("/")[1] : undefined;
        entries.push({
          id: entryId(index.id, head.folder),
          index: index.id,
          name: head.metadata.name,
          ...(shortDescription(head.metadata.description) ? { description: shortDescription(head.metadata.description) } : {}),
          repo: `${owner}/${name}`,
          path: head.folder,
          url: `https://github.com/${owner}/${name}/tree/HEAD/${head.folder}`,
          ...(plugin ? { plugin } : {}),
          ...(head.needsPlugin ? { needsPlugin: true } : {}),
        });
      }
      const next: StoredIndex = { fetchedAt: now(), ...(tarball.etag ? { etag: tarball.etag } : {}), entries };
      stored.set(index.id, next);
      writeStored(indexFile(index.id), next);
      // A skill opened from the old tarball may differ now: its files are fetched again when next opened.
      rmSync(join(folder(index.id), "skills"), { recursive: true, force: true });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const refreshDirectory = async (index: SkillIndexDefinition) => {
    const entries: DiscoverSkill[] = [];
    let page: string | undefined;
    for (let count = 0; count < DIRECTORY_PAGES_MAX; count += 1) {
      const url = `${DIRECTORY_URL}?visibility=public&limit=1000${page ? `&page=${encodeURIComponent(page)}` : ""}`;
      const response = await get(url, { accept: "application/json" });
      if (!response.ok) throw new Error(`Anthropic's directory answered ${response.status}`);
      const body: unknown = await response.json();
      if (!record(body) || !Array.isArray(body.data)) throw new Error("Anthropic's directory answered in a shape conch doesn't know");
      for (const plugin of body.data) entries.push(...directoryEntries(index.id, plugin));
      page = text(body.next_page, 4_096);
      if (!page) break;
    }
    entries.sort((a, b) => (TRUST_RANK[a.trust ?? "community"] ?? 3) - (TRUST_RANK[b.trust ?? "community"] ?? 3));
    const next: StoredIndex = { fetchedAt: now(), entries };
    stored.set(index.id, next);
    rememberDirectory(entries);
    writeStored(indexFile(index.id), next);
  };

  const refreshIndex = async (index: SkillIndexDefinition) => {
    try {
      if (index.kind === "repo") await refreshRepo(index);
      else if (index.kind === "directory") await refreshDirectory(index);
      errors.delete(index.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.set(index.id, message);
      log(`skills library: ${index.id} could not be read (${message})`);
    }
  };

  const stale = (index: SkillIndexDefinition) => index.kind !== "search" && (now() - (load(index)?.fetchedAt ?? 0) >= INDEX_FRESH_MS);

  const refresh = (all: boolean): Promise<void> => {
    if (refreshing) return refreshing;
    const due = indexes.filter((index) => index.kind !== "search" && (all || stale(index)));
    if (!due.length) return Promise.resolve();
    refreshing = Promise.all(due.map(refreshIndex)).then(() => undefined).finally(() => { refreshing = undefined; });
    return refreshing;
  };

  const search = async (query: string): Promise<DiscoverSkill[]> => {
    const key = query.trim().toLowerCase();
    const cached = searches.get(key);
    if (cached && now() - cached.at < SEARCH_FRESH_MS) return cached.entries;
    try {
      const response = await get(`${SKILLS_SH}/api/search?q=${encodeURIComponent(key)}&limit=${SEARCH_LIMIT}`, { accept: "application/json" });
      if (!response.ok) throw new Error(`skills.sh answered ${response.status}`);
      const body: unknown = await response.json();
      const entries = record(body) && Array.isArray(body.skills) ? body.skills.flatMap((item) => skillsShEntry(item)) : [];
      searches.set(key, { at: now(), entries });
      if (searches.size > 40) searches.delete(searches.keys().next().value!);
      searchError = undefined;
      return entries;
    } catch (error) {
      searchError = error instanceof Error ? error.message : String(error);
      return cached?.entries ?? [];
    }
  };

  const statuses = (searchCount: number): SkillIndexStatus[] => indexes.map((index) => {
    const read = index.kind === "search" ? undefined : load(index);
    const error = index.kind === "search" ? searchError : errors.get(index.id);
    return {
      id: index.id, name: index.name, maintainer: index.maintainer, url: index.url, agents: index.agents,
      count: index.kind === "search" ? searchCount : read?.entries.length ?? 0,
      ...(read ? { fetchedAt: read.fetchedAt } : {}),
      ...(error ? { error } : {}),
    };
  });

  const list: DiscoverProvider["list"] = async ({ query, index, refresh: asked }) => {
    void refresh(asked === true);
    const words = query?.trim() ?? "";
    let searched: DiscoverSkill[] = [];
    if (words.length >= 2 && (!index || index === "skills-sh")) searched = await search(words);
    const listed: DiscoverSkill[] = [];
    for (const definition of indexes) {
      if (index && definition.id !== index) continue;
      if (definition.kind === "search") listed.push(...searched);
      else listed.push(...(load(definition)?.entries ?? []));
    }
    const entries = words
      ? listed.map((entry, order) => ({ entry, order, score: matchScore(entry, words) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || (b.entry.installs ?? 0) - (a.entry.installs ?? 0) || a.order - b.order)
        .map((item) => item.entry)
      : listed;
    // The source a directory entry keeps for its own fetch never crosses the wire.
    return {
      indexes: statuses(searched.length),
      entries: entries.map(({ source: _source, ...entry }: DiscoverSkill & { source?: unknown }) => entry),
      refreshing: refreshing !== undefined,
    };
  };

  const findEntry = (id: string): DiscoverSkill | undefined => {
    const index = indexes.find((definition) => id.startsWith(`${definition.id}:`));
    if (!index) return undefined;
    if (index.kind === "search") {
      for (const cached of searches.values()) {
        const found = cached.entries.find((entry) => entry.id === id);
        if (found) return found;
      }
      return skillsShEntry({ id: id.slice(index.id.length + 1) })[0];
    }
    return load(index)?.entries.find((entry) => entry.id === id);
  };

  /** A skill's folder inside a tarball, unpacked to `<index>/skills/<slot>`, replacing an earlier copy. */
  const unpack = async (tarball: string, top: string, path: string, target: string) => {
    const scratch = `${target}.${randomUUID()}.part`;
    mkdirSync(scratch, { recursive: true });
    try {
      // No trailing "/": tar takes a name as the folder and everything under it, part by part, never a sibling.
      await tar(["-xzf", tarball, "-C", scratch, `${top}/${path}`]);
      const unpacked = join(scratch, top, ...path.split("/"));
      if (!existsSync(join(unpacked, "SKILL.md"))) throw new Error("its folder has no SKILL.md");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      renameSync(unpacked, target);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const topOf = async (tarball: string): Promise<string> => {
    const first = (await tar(["-tzf", tarball])).split("\n").find((member) => member.includes("/"));
    if (!first) throw new Error("the archive is empty");
    return first.split("/")[0]!;
  };

  const localRepo = async (index: SkillIndexDefinition, entry: DiscoverSkill): Promise<string> => {
    const target = join(folder(index.id), "skills", slot(entry.id));
    if (existsSync(join(target, "SKILL.md"))) return target;
    const tarball = join(folder(index.id), "repo.tar.gz");
    if (!existsSync(tarball)) await refreshIndex(index);
    if (!existsSync(tarball)) throw new Error(errors.get(index.id) ?? "the index's files could not be fetched");
    await unpack(tarball, await topOf(tarball), entry.path!, target);
    return target;
  };

  const localDirectory = async (index: SkillIndexDefinition, entry: DiscoverSkill): Promise<string> => {
    const target = join(folder(index.id), "skills", slot(entry.id));
    if (existsSync(join(target, "SKILL.md"))) return target;
    const source = directorySources.get(entry.id);
    if (!source) throw new Error("the directory no longer lists where this skill's files are; refresh Discover");
    const tarball = join(folder(index.id), "repos", `${source.owner}__${source.repo}__${source.commit.slice(0, 12)}.tar.gz`);
    if (!existsSync(tarball)) {
      const response = await get(`https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${source.commit}`);
      if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${source.owner}/${source.repo}`);
      await download(response, tarball, TARBALL_MAX_BYTES);
    }
    const scratch = join(folder(index.id), `.heads-${randomUUID()}`);
    try {
      const heads = await readSkillHeads(tarball, [source.path ? `${source.path}/` : ""], scratch);
      const named = heads.find((head) => head.metadata?.name === entry.name)
        ?? heads.find((head) => head.folder.split("/").pop() === entry.name);
      if (!named) throw new Error(`${source.owner}/${source.repo} has no skill named ${entry.name} at the reviewed commit`);
      if (named.proprietary) throw new Error("its licence reserves every right, so conch doesn't copy it");
      await unpack(tarball, named.top, named.folder, target);
      return target;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  /** skills.sh's download: a skill's text files, written one by one after each path is checked. */
  const localSkillsSh = async (index: SkillIndexDefinition, entry: DiscoverSkill): Promise<string> => {
    const target = join(folder(index.id), "skills", slot(entry.id));
    if (existsSync(join(target, "SKILL.md"))) return target;
    const where = entry.id.slice(index.id.length + 1);
    const response = await get(`${SKILLS_SH}/api/download/${where.split("/").map(encodeURIComponent).join("/")}`, { accept: "application/json" });
    if (!response.ok) throw new Error(`skills.sh answered ${response.status}`);
    const body: unknown = await response.json();
    if (!record(body) || !Array.isArray(body.files)) throw new Error("skills.sh answered in a shape conch doesn't know");
    if (body.files.length > COPY_FILES_MAX) throw new Error(`it has more than ${COPY_FILES_MAX} files`);
    const scratch = `${target}.${randomUUID()}.part`;
    let total = 0;
    try {
      for (const file of body.files) {
        const path = record(file) ? repoPath(file.path) : undefined;
        const contents = record(file) && typeof file.contents === "string" ? file.contents : undefined;
        if (!path || contents === undefined) throw new Error("skills.sh listed a file conch can't place safely");
        total += Buffer.byteLength(contents);
        if (total > COPY_BYTES_MAX) throw new Error(`it is over ${COPY_BYTES_MAX / 1024 / 1024} MB`);
        const destination = join(scratch, ...path.split("/"));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, contents, { flag: "wx" });
      }
      if (!existsSync(join(scratch, "SKILL.md"))) throw new Error("skills.sh's copy has no SKILL.md");
      const licenses = ["LICENSE.txt", "LICENSE", "LICENSE.md"].map((name) => join(scratch, name)).filter((path) => existsSync(path));
      if (licenses.some((path) => isProprietaryLicense(readFileSync(path, "utf8").slice(0, 8_192)))) {
        throw new Error("its licence reserves every right, so conch doesn't copy it");
      }
      rmSync(target, { recursive: true, force: true });
      mkdirSync(dirname(target), { recursive: true });
      renameSync(scratch, target);
      return target;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const local: DiscoverProvider["local"] = async (id) => {
    const entry = findEntry(id);
    const index = indexes.find((definition) => id.startsWith(`${definition.id}:`));
    if (!entry || !index) throw new Error("Discover no longer lists that skill; refresh it.");
    const path = index.kind === "repo" ? await localRepo(index, entry)
      : index.kind === "directory" ? await localDirectory(index, entry)
      : await localSkillsSh(index, entry);
    // What the skill's own SKILL.md says, now that it is here: the index's words may have been cut short.
    let described = entry;
    try {
      const metadata = readSkillMetadata(join(path, "SKILL.md"));
      const description = shortDescription(metadata.description);
      const needsPlugin = entry.needsPlugin || needsItsPlugin(readFileSync(join(path, "SKILL.md"), "utf8").slice(0, 256 * 1024));
      described = { ...entry, ...(description ? { description } : {}), ...(needsPlugin ? { needsPlugin: true } : {}) };
    } catch {}
    const { source: _source, ...wire } = described as DiscoverSkill & { source?: unknown };
    return { entry: { ...wire, local: path }, folder: path };
  };

  return { list, local, refreshNow: () => refresh(true) };
}

/** A plugin of Anthropic's directory, as one entry per skill it carries, each keeping where its files are. */
export function directoryEntries(index: string, plugin: unknown): DiscoverSkill[] {
  if (!record(plugin) || !Array.isArray(plugin.components)) return [];
  const id = text(plugin.id, 200);
  const name = text(plugin.name, 200);
  const sourceRecord = record(plugin.source) && record(plugin.source.repository) ? plugin.source.repository : undefined;
  const github = githubRepo(sourceRecord?.url);
  const commit = text(sourceRecord?.reviewed_commit, 64);
  const path = sourceRecord?.path === undefined ? "" : repoPath(sourceRecord.path);
  if (!id || !name || !github || !commit || !COMMIT.test(commit) || path === undefined) return [];
  const tier = text(plugin.verified_tier, 40);
  const trust = tier === "anthropic" || tier === "partner" ? tier : "community";
  const license = text(plugin.license, 80);
  const entries: Array<DiscoverSkill & { source: DirectorySource }> = [];
  for (const component of plugin.components) {
    if (!record(component) || component.type !== "skill") continue;
    const skill = text(component.name, 128);
    const key = text(component.key, 128);
    if (!skill || !key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(skill)) continue;
    const description = shortDescription(text(component.description, 4_000));
    entries.push({
      id: entryId(index, `${id}:${key}`),
      index,
      name: skill,
      ...(description ? { description } : {}),
      repo: `${github.owner}/${github.repo}`,
      ...(path ? { path } : {}),
      url: `https://github.com/${github.owner}/${github.repo}${path ? `/tree/${commit}/${path}` : ""}`,
      plugin: name,
      trust,
      ...(license ? { license } : {}),
      source: { owner: github.owner, repo: github.repo, commit, ...(path ? { path } : {}) },
    });
  }
  return entries;
}

/** One skills.sh search result: `owner/repo/skill` from GitHub, as its page and download name it. */
export function skillsShEntry(item: unknown): DiscoverSkill[] {
  if (!record(item)) return [];
  const id = text(item.id, 300);
  if (!id) return [];
  const parts = id.split("/");
  if (parts.length < 3 || !parts.every((part) => GITHUB_PART.test(part) && part !== "." && part !== "..")) return [];
  const name = text(item.name, 128) ?? parts[parts.length - 1]!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name)) return [];
  const source = text(item.source, 200);
  const installs = typeof item.installs === "number" && Number.isSafeInteger(item.installs) && item.installs >= 0 ? item.installs : undefined;
  return [{
    id: entryId("skills-sh", id),
    index: "skills-sh",
    name,
    ...(source && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source) ? { repo: source } : {}),
    url: `${SKILLS_SH}/${parts.map(encodeURIComponent).join("/")}`,
    ...(installs === undefined ? {} : { installs }),
  }];
}

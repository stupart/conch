import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, constants, type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { readSkillMetadata } from "./agent-capabilities.ts";
import { conchHome } from "./home.ts";
import type { SkillAgent } from "./skills-library.ts";

/**
 * Adding a skill, and trying one (2026-10-28): the skills library's Add and Try (skills-library.ts).
 *
 * **Add** copies a skill's folder into one account's own skills folder — `<CLAUDE_CONFIG_DIR>/skills/<name>` for a
 * Claude profile, `<CODEX_HOME>/skills/<name>` for a Codex one — which is where each agent looks for a person's own
 * skills. It is a write outside conch, so it is the write pass's shape (config-write.ts, B3): a plan first, naming every
 * file and where it lands, and only an apply that carries the plan's hash writes, so a folder that changed in between
 * is refused rather than copied. Nothing is ever replaced: a skill already at the destination is a refusal, in words.
 * The files go into a hidden folder beside the destination and are renamed into place in one step, then read back: a
 * SKILL.md without its name and description is taken away again. Links are never followed or copied (a skill from the
 * web could point anywhere on this Mac), and nothing copied is run. Like every switch conch writes, it reaches the next
 * session, never one already running.
 *
 * **Try** is a new session that uses the skill, in a folder made for it under `~/.cache/conch/skill-trials`, so whatever
 * the demonstration makes lands there and nowhere else. A skill Tyler doesn't have yet is copied into that folder as a
 * project skill (`.claude/skills/<name>` or `.agents/skills/<name>`), which the session loads without the skill being
 * added to any account. The session itself is started by the app through the daemon's ordinary `session-start`, with
 * the first message `trialPrompt` writes.
 */

export interface SkillFile {
  /** Relative to the skill's folder, with "/" between parts. */
  path: string;
  bytes: number;
}

export interface SkillCopyPlan {
  name: string;
  source: string;
  destination: string;
  files: SkillFile[];
  /** What is left behind, and why: links, and anything that isn't a plain file or folder. */
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
  /** sha256 over the destination and every file's path and bytes: what an apply must still match. */
  planHash: string;
  /** Why it can't be done; the plan is still shown, so the reason sits beside what it is about. */
  refusal?: string;
}

/** A skill's folder name: what both agents accept as a skill's name, and nothing that could leave the folder. */
export const SKILL_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const COPY_FILES_MAX = 400;
export const COPY_BYTES_MAX = 20 * 1024 * 1024;
const DEPTH_MAX = 12;
/** Never part of a skill, whatever its repository carried. */
const LEFT_OUT = new Set([".git", ".DS_Store"]);

export function validSkillFolderName(name: unknown): name is string {
  return typeof name === "string" && SKILL_FOLDER.test(name) && name !== "." && name !== "..";
}

/** Every plain file under `root`, without following a link; links and anything else are skipped, and say so. */
function walk(root: string): { files: Array<SkillFile & { absolute: string }>; skipped: SkillCopyPlan["skipped"]; overflow: boolean } {
  const files: Array<SkillFile & { absolute: string }> = [];
  const skipped: SkillCopyPlan["skipped"] = [];
  let overflow = false;
  const visit = (folder: string, depth: number) => {
    let entries: Dirent[];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (LEFT_OUT.has(entry.name)) continue;
      const absolute = join(folder, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) { skipped.push({ path, reason: "a link; links are never copied" }); continue; }
      if (entry.isDirectory()) {
        if (depth >= DEPTH_MAX) { skipped.push({ path, reason: `deeper than ${DEPTH_MAX} folders` }); continue; }
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) { skipped.push({ path, reason: "not a plain file" }); continue; }
      if (files.length >= COPY_FILES_MAX) { overflow = true; return; }
      let bytes = 0;
      try { bytes = lstatSync(absolute).size; } catch { skipped.push({ path, reason: "could not be read" }); continue; }
      files.push({ path, bytes, absolute });
    }
  };
  visit(root, 0);
  // SKILL.md first, as a person reads a skill; then by path, the same order on every Mac.
  files.sort((a, b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files, skipped, overflow };
}

function hashPlan(destination: string, files: ReadonlyArray<SkillFile & { absolute: string }>): string {
  const hash = createHash("sha256").update(destination).update("\0");
  for (const file of files) {
    hash.update(file.path).update("\0").update(String(file.bytes)).update("\0");
    try { hash.update(readFileSync(file.absolute)); } catch { hash.update("unreadable"); }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * What copying the skill at `source` into `skillsRoot` would write: every file and its size, the folder it lands in,
 * and why it can't, when it can't. Reads only.
 */
export function planSkillCopy(source: string, name: string, skillsRoot: string): SkillCopyPlan {
  const destination = join(skillsRoot, validSkillFolderName(name) ? name : "_");
  const base = { name, source, destination };
  if (!validSkillFolderName(name)) {
    return { ...base, files: [], skipped: [], totalBytes: 0, planHash: "", refusal: `"${name}" isn't a name a skill folder can have` };
  }
  let sourceIsFolder = false;
  try { sourceIsFolder = lstatSync(source).isDirectory(); } catch {}
  if (!sourceIsFolder) return { ...base, files: [], skipped: [], totalBytes: 0, planHash: "", refusal: `${source} isn't there any more; fetch the index again` };
  const { files, skipped, overflow } = walk(source);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const plan: SkillCopyPlan = {
    ...base,
    files: files.map(({ path, bytes }) => ({ path, bytes })),
    skipped,
    totalBytes,
    planHash: hashPlan(destination, files),
  };
  const refusal = overflow ? `it has more than ${COPY_FILES_MAX} files`
    : totalBytes > COPY_BYTES_MAX ? `it is ${(totalBytes / 1024 / 1024).toFixed(1)} MB, over ${COPY_BYTES_MAX / 1024 / 1024} MB`
    : !files.some((file) => file.path === "SKILL.md") ? "it has no SKILL.md at its top"
    : existsSync(destination) || isLink(destination) ? `${destination} is already there; remove it first, or pick another account`
    : undefined;
  return refusal ? { ...plan, refusal } : plan;
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Copy the plan's files into a new folder at `target`, which must not exist; executable files stay executable. */
function copyInto(plan: SkillCopyPlan, target: string): void {
  mkdirSync(target, { recursive: false, mode: 0o755 });
  for (const file of plan.files) {
    const from = join(plan.source, ...file.path.split("/"));
    const to = join(target, ...file.path.split("/"));
    // Checked again at the copy, not trusted from the plan: a file swapped for a link in between is not followed.
    if (!lstatSync(from).isFile()) throw new Error(`${file.path} changed since the plan`);
    mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, (statSync(from).mode & 0o111) ? 0o755 : 0o644);
  }
}

/**
 * Write a plan: planned again now, refused if that differs from the one shown (`expectHash`) or if it is refused
 * itself, copied beside the destination, renamed into place, and read back. Returns the folder it made.
 */
export function applySkillCopy(source: string, name: string, skillsRoot: string, expectHash: string): string {
  const plan = planSkillCopy(source, name, skillsRoot);
  if (plan.refusal) throw new Error(`Not added: ${plan.refusal}.`);
  if (plan.planHash !== expectHash) throw new Error("The skill's files changed since the preview; look at the new preview before adding it.");
  mkdirSync(skillsRoot, { recursive: true, mode: 0o755 });
  const staging = join(skillsRoot, `.conch-add-${randomUUID()}`);
  try {
    copyInto(plan, staging);
    if (existsSync(plan.destination) || isLink(plan.destination)) throw new Error(`${plan.destination} appeared while adding; nothing was replaced.`);
    renameSync(staging, plan.destination);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  const metadata = (() => { try { return readSkillMetadata(join(plan.destination, "SKILL.md")); } catch { return null; } })();
  if (!metadata?.valid) {
    rmSync(plan.destination, { recursive: true, force: true });
    throw new Error("Not added: its SKILL.md has no name and description, so neither agent would load it.");
  }
  return plan.destination;
}

// MARK: - Try

export function trialsRoot(home: string = conchHome()): string {
  return join(home, ".cache", "conch", "skill-trials");
}

/** How long a trial folder is kept after it was made: long enough to come back to what the session made. */
export const TRIAL_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const TRIAL_FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-\d{8}-\d{6}$/;

/** Trial folders made longer ago than `TRIAL_KEEP_MS`, removed; only folders this module named. */
export function sweepTrials(root: string = trialsRoot(), now = Date.now()): string[] {
  const removed: string[] = [];
  for (const entry of (() => { try { return readdirSync(root, { withFileTypes: true }); } catch { return []; } })()) {
    if (!entry.isDirectory() || !TRIAL_FOLDER.test(entry.name)) continue;
    const path = join(root, entry.name);
    try {
      if (now - statSync(path).mtimeMs > TRIAL_KEEP_MS) {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      }
    } catch {}
  }
  return removed;
}

function stamp(at: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

/** Where a trial's session loads a skill it hasn't been given: the folder's own skills, for its agent. */
export function trialSkillsFolder(agent: SkillAgent): string[] {
  return agent === "claude" ? [".claude", "skills"] : [".agents", "skills"];
}

/**
 * A new, empty folder for a trial of `name`, with the skill at `source` copied in as a project skill when there is one.
 * Returns the folder and, with a copy, what was copied.
 */
export function prepareTrialFolder(
  name: string,
  agent: SkillAgent,
  source?: string,
  root: string = trialsRoot(),
  now = new Date(),
): { cwd: string; copied?: SkillCopyPlan } {
  if (!validSkillFolderName(name)) throw new Error(`"${name}" isn't a name a skill folder can have`);
  sweepTrials(root, now.getTime());
  mkdirSync(root, { recursive: true, mode: 0o755 });
  let cwd = join(root, `${name}-${stamp(now)}`);
  for (let attempt = 1; existsSync(cwd); attempt += 1) cwd = join(root, `${name}-${stamp(new Date(now.getTime() + attempt * 1000))}`);
  mkdirSync(cwd, { mode: 0o755 });
  if (!source) return { cwd };
  const skills = join(cwd, ...trialSkillsFolder(agent));
  const plan = planSkillCopy(source, name, skills);
  if (plan.refusal) {
    rmSync(cwd, { recursive: true, force: true });
    throw new Error(`Can't try it: ${plan.refusal}.`);
  }
  applySkillCopy(source, name, skills, plan.planHash);
  return { cwd, copied: plan };
}

/**
 * The trial session's first message: the skill by its own call where it has one (`/name`, `/plugin:name`, `$name`),
 * then the ask. One line, as `session-start` takes it (`startPromptError`).
 */
export function trialPrompt(name: string, invocation?: string): string {
  const call = invocation ?? `Use the ${name} skill.`;
  return `${call} Show me what this skill does on a small example that suits it. Work only inside this folder, and finish by telling me what it did and anything it needed that was missing.`;
}

import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * Atlas pages in the Workdesk. Tyler, 2026-10-16: "are u showing me the atals pages in conch? if not please do".
 *
 * Atlas, the user's shared wiki, has no web view of a page, so a page an agent read or wrote is shown the way a document
 * is: its Markdown, saved under `~/Documents/conch-notes/atlas/<atlas path>` (the folder Tyler already keeps copies of
 * Atlas pages in), and filed as a `markdown` deliverable keyed `atlas:<path>`, so each later copy of the page is that
 * artifact's next version. `atlas_show` (mcp.ts) does both in one call; an agent may also write the copy and file it
 * with `review_to_front` itself.
 *
 * conch never talks to Atlas: the agent read the page with its own Atlas tools and hands conch the words, so no
 * credential of Atlas's ever passes through here.
 *
 * The publish rule (snippet.ts `checkLocalFile`) lets a Markdown file in this folder through, as it does conch's own
 * captures: a copy of a wiki page is work to show, wherever the session itself works, and only Markdown is let through,
 * so nothing else that comes to live in the folder is sent to the phone.
 */

export const ATLAS_COPIES_PARTS = ["Documents", "conch-notes", "atlas"] as const;
/** The artifact key a page's copies are filed under: `atlas:` and its path. */
export const ATLAS_KEY_PREFIX = "atlas:";
export const ATLAS_PATH_MAX = 300;
/** What one page's Markdown may be: far past any wiki page, well inside an MCP message. */
export const ATLAS_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;

/** The folder the copies live in; `CONCH_ATLAS_COPIES` moves it (tests). */
export function atlasCopiesFolder(home: string = conchHome()): string {
  return process.env.CONCH_ATLAS_COPIES || join(home, ...ATLAS_COPIES_PARTS);
}

/** Whether a file's name says it is Markdown: all the copies folder ever lets through. */
export function isMarkdownName(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * An Atlas page's path as conch keeps it: `projects/conch/direction-2026-10-16.md`, `work/<org>/notes`. Relative,
 * slash-separated, each part letters, digits, `.`, `_` or `-` and never starting with a dot, so a copy can't land outside
 * the folder or hide in it. Slashes either end are dropped. `file` is where its copy goes, `.md` added when the path
 * has no Markdown extension of its own.
 */
export function atlasPagePath(value: unknown): { ok: true; path: string; file: string } | { ok: false; reason: string } {
  const refused = (reason: string) => ({ ok: false as const, reason });
  if (typeof value !== "string") return refused("path must be the Atlas page's path, e.g. projects/conch/direction.md");
  const path = value.trim().replace(/^\/+|\/+$/g, "");
  if (!path || path.length > ATLAS_PATH_MAX) return refused(`path must be 1 to ${ATLAS_PATH_MAX} characters`);
  const parts = path.split("/");
  if (parts.length > 16 || !parts.every((part) => SEGMENT.test(part))) {
    return refused("path must be the page's Atlas path: parts of letters, digits, '.', '_' or '-' split by '/', none starting with '.' (no '..')");
  }
  return { ok: true, path, file: isMarkdownName(path) ? path : `${path}.md` };
}

/** The key and the summary a page's copy is filed with: the summary always names the Atlas path. */
export function atlasFiling(path: string, summary?: string): { key: string; summary: string } {
  const said = summary?.replace(/\s+/g, " ").trim();
  const named = !said ? `Atlas page ${path}` : said.includes(path) ? said : `${said} (Atlas: ${path})`;
  return { key: `${ATLAS_KEY_PREFIX}${path}`, summary: named };
}

/**
 * Write a page's copy, replacing the last one: made inside the folder whatever the disk holds (a folder in the way
 * that is a link elsewhere, a copy that is a symlink, are refused), atomically, readable as any document is. Returns the
 * file's absolute path.
 */
export async function writeAtlasCopy(file: string, markdown: string, folder: string = atlasCopiesFolder()): Promise<string> {
  if (Buffer.byteLength(markdown, "utf8") > ATLAS_MARKDOWN_MAX_BYTES) {
    throw new Error(`markdown is over ${ATLAS_MARKDOWN_MAX_BYTES / 1024 / 1024} MB`);
  }
  const target = join(folder, file);
  await mkdir(dirname(target), { recursive: true });
  const [root, parent] = await Promise.all([realpath(folder), realpath(dirname(target))]);
  if (parent !== root && !parent.startsWith(`${root}/`)) throw new Error(`${dirname(target)} leads outside ${folder}`);
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isFile()) throw new Error(`${target} is there and isn't a plain file; move it aside first`);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, markdown, { mode: 0o644 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
  return target;
}

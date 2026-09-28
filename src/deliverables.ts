import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";

/**
 * What kind of thing a deliverable is, and which artifact it is a version of.
 *
 * An agent could not say either. The Mac guessed the kind from the link's extension
 * (`DeliverableSource`) and grouped versions by the link byte for byte, so a deliverable with
 * no file behind it — an app window, the Simulator, a Figma frame — had no kind and no way to
 * be the same thing twice. Agents show much more than localhost pages, so the kinds are the
 * things they actually put in front of Tyler.
 *
 * A leaf module: the MCP server predicts with it and the daemon files with it, and both must
 * reach the same answer from the same review.
 */
export const DELIVERABLE_KINDS = [
  "page", // a local html file
  "image",
  "video",
  "audio",
  "pdf",
  "markdown",
  "text",
  "folder", // a directory, shown as its tree, with the paths in it to look at (`focus`)
  "url", // a live web page or dev server
  "app", // a Mac app window or state
  "simulator", // the iOS Simulator or a device build
  "terminal",
  "design", // Figma and the like
  "document", // Keynote, Word, Pages and the like
  "other",
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

/** Whether the agent said the kind, or conch read it off the link. */
export type DeliverableKindSource = "agent" | "inferred";

/**
 * Kinds that may have no link: the thing is on screen, not in a file, and the summary says
 * where to look. `other` is here too, because it is what a linkless filing with no kind (a
 * written explanation in the conversation) is inferred as, and refusing the explicit spelling
 * of the same filing would be arbitrary.
 */
export const LINKLESS_DELIVERABLE_KINDS: readonly DeliverableKind[] = ["app", "simulator", "terminal", "design", "other"];

/** An agent's `key` is a name, not a document; refused past this, never cut. */
export const ARTIFACT_KEY_MAX = 200;

// The Mac's renderer sets (ReviewView.swift `DeliverableSource`), plus what it has no pane for.
const KIND_BY_EXTENSION: Readonly<Record<string, DeliverableKind>> = {
  html: "page", htm: "page",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", heic: "image", tiff: "image",
  mp4: "video", mov: "video", m4v: "video", webm: "video",
  mp3: "audio", m4a: "audio", wav: "audio", aac: "audio", aiff: "audio", flac: "audio", ogg: "audio",
  pdf: "pdf",
  md: "markdown", markdown: "markdown",
  txt: "text", log: "text", json: "text", yaml: "text", yml: "text", toml: "text", csv: "text", diff: "text", patch: "text",
  fig: "design",
  pages: "document", numbers: "document", doc: "document", docx: "document", ppt: "document", pptx: "document",
  xls: "document", xlsx: "document", rtf: "document", odt: "document",
};

function asUrl(link: string): URL | undefined {
  try {
    return new URL(link);
  } catch {
    return undefined; // a filesystem path
  }
}

/**
 * Directories macOS treats as one thing (an app, a bundle, a document saved as a package): never a folder of work. A
 * tree of an app's insides is not what anyone published, and opening one "where it lives" launches it.
 */
const PACKAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "app", "appex", "bundle", "framework", "kext", "plugin", "prefpane", "qlgenerator", "saver", "xpc", "pkg", "mpkg",
  "systemextension", "mdimporter", "photoslibrary", "rtfd", "key", "xcodeproj", "xcworkspace", "playground", "sparsebundle",
]);

/** Whether a directory at this path is a package, by its extension: one above, or any a file kind is read from. */
export function isPackagePath(path: string): boolean {
  const extension = extname(path).slice(1).toLowerCase();
  return Boolean(extension) && (PACKAGE_EXTENSIONS.has(extension) || Object.hasOwn(KIND_BY_EXTENSION, extension));
}

/**
 * The kind a link says, when the agent did not: http(s) is a live page, figma.com a design, a file its extension, and
 * a directory a folder. A directory whose extension names a kind of its own (a `.pages` saved as a package) keeps that
 * kind, and the link check refuses it (`isPackagePath`), as it always refused it as a file.
 */
export function inferDeliverableKind(link: string | undefined): DeliverableKind {
  if (!link) return "other";
  const url = asUrl(link);
  if (url?.protocol === "http:" || url?.protocol === "https:") {
    return /(^|\.)figma\.com$/i.test(url.hostname) ? "design" : "url";
  }
  const byExtension = KIND_BY_EXTENSION[extname(url ? url.pathname : link).slice(1).toLowerCase()];
  if (byExtension) return byExtension;
  return !url && isAbsolute(link) && statSync(link, { throwIfNoEntry: false })?.isDirectory() ? "folder" : "other";
}

/**
 * A folder deliverable's `focus`: the paths inside it the agent points at, as a tree opens expanded to them and marks
 * them. Refused past these, never cut. The published state carries only these paths, never a listing: the apps read
 * the tree from the disk when they show it, so the state stays the size of what the agent said.
 */
export const FOCUS_MAX = 12;
export const FOCUS_PATH_MAX = 200;
export const FOCUS_MAX_BYTES = 1024;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The one shape check for a `focus` as it is published, sent over the socket and saved: 1 to `FOCUS_MAX` distinct
 * paths relative to the folder, POSIX, normalized ("src/setup.ts", "test"), each at most `FOCUS_PATH_MAX` characters and
 * `FOCUS_MAX_BYTES` in all. No `..` or `.` segment, no leading `/`, no empty segment, no control character. Pure: whether
 * each is really inside the folder is the disk's question (`resolveReviewFocus`, snippet.ts).
 */
export function checkFocusShape(value: unknown): { ok: true; focus: string[] } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false, reason: `focus${reason.startsWith("[") ? "" : " "}${reason}` }) as const;
  if (!Array.isArray(value) || value.length === 0 || value.length > FOCUS_MAX) {
    return refuse(`must be 1 to ${FOCUS_MAX} paths inside the folder`);
  }
  const focus: string[] = [];
  for (const [index, path] of value.entries()) {
    if (typeof path !== "string" || !path || CONTROL.test(path)) return refuse(`[${index}] must be a non-empty path`);
    if (path.length > FOCUS_PATH_MAX) return refuse(`[${index}] is ${path.length} characters; at most ${FOCUS_PATH_MAX}`);
    if (path.startsWith("/") || path.includes("\\")) return refuse(`[${index}] ${path} must be relative to the folder`);
    const parts = path.split("/");
    if (parts.some((part) => part === ".." || part === "." || part === "")) {
      return refuse(`[${index}] ${path} must name a path inside the folder, with no .. or empty part`);
    }
    if (focus.includes(path)) return refuse(`[${index}] ${path} is listed twice`);
    focus.push(path);
  }
  const bytes = Buffer.byteLength(JSON.stringify(focus));
  if (bytes > FOCUS_MAX_BYTES) return refuse(`is ${bytes} bytes; at most ${FOCUS_MAX_BYTES} in all`);
  return { ok: true, focus };
}

/**
 * Why a filing's kind, link and focus disagree about a folder, or null when they agree: a folder link is kind `folder`
 * (said or inferred), `folder` needs a folder link, and only a folder has a focus.
 */
export function folderRefusal(review: { kind?: DeliverableKind; isFolder: boolean; hasFocus: boolean }): string | null {
  if (review.isFolder && review.kind && review.kind !== "folder") {
    return `link is a folder, which is kind "folder"; pass that kind or leave kind out`;
  }
  if (!review.isFolder && review.kind === "folder") return `kind "folder" needs a link to an existing folder`;
  if (review.hasFocus && !review.isFolder) return "focus is for a folder deliverable: pass the folder as link";
  return null;
}

/** Why this kind cannot be filed without a link, or null when it can. */
export function deliverableKindRefusal(kind: DeliverableKind, hasLink: boolean): string | null {
  if (hasLink || LINKLESS_DELIVERABLE_KINDS.includes(kind)) return null;
  return `kind "${kind}" needs a link to the file or page; only ${LINKLESS_DELIVERABLE_KINDS.join(", ")} can be`
    + " filed without one, with the summary saying where to look";
}

/**
 * What makes two filings the same artifact when the agent names none: the file's real path
 * (so `/tmp` and `/private/tmp` are one file), or the URL without its fragment. With no link
 * there is only the summary.
 */
export function artifactKey(link: string | undefined, summary: string): string {
  if (!link) return summary;
  const url = asUrl(link);
  if (url) {
    url.hash = "";
    return url.href;
  }
  try {
    return realpathSync(link);
  } catch {
    return link; // gone since it was filed; the path as filed still names it
  }
}

/** A short, stable name for an artifact: the same key is the same artifact, in any session. */
export function artifactIdentity(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** The facts a filing carries about itself, from what the agent said and what the link says. */
export function deliverableFacts(review: {
  summary: string;
  link?: string;
  kind?: DeliverableKind;
  key?: string;
}): { kind: DeliverableKind; kindSource: DeliverableKindSource; artifact: string } {
  return {
    kind: review.kind ?? inferDeliverableKind(review.link),
    kindSource: review.kind ? "agent" : "inferred",
    artifact: artifactIdentity(review.key ?? artifactKey(review.link, review.summary)),
  };
}

export function isDeliverableKind(value: unknown): value is DeliverableKind {
  return DELIVERABLE_KINDS.some((kind) => kind === value);
}

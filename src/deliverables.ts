import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { extname } from "node:path";

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

/** The kind a link says, when the agent did not: http(s) is a live page, figma.com a design, a file its extension. */
export function inferDeliverableKind(link: string | undefined): DeliverableKind {
  if (!link) return "other";
  const url = asUrl(link);
  if (url?.protocol === "http:" || url?.protocol === "https:") {
    return /(^|\.)figma\.com$/i.test(url.hostname) ? "design" : "url";
  }
  return KIND_BY_EXTENSION[extname(url ? url.pathname : link).slice(1).toLowerCase()] ?? "other";
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

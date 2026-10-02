import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { open as openFile, realpath, stat } from "node:fs/promises";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";
import { captureFolderPath } from "./capture-folder.ts";
import { ControlFrameReader, encodeControlFrame } from "./control-framing.ts";
import { ARTIFACT_KEY_MAX, deliverableFacts } from "./deliverables.ts";
import type { TurnEvent } from "./hook.ts";
import { nextVersion, type SessionReview } from "./panel.ts";
import { reviewIdentity } from "./records-receipts.ts";
import {
  checkLocalFile,
  REVIEW_MARK_FRAME_MAX,
  REVIEW_MARK_LABEL_MAX,
  REVIEW_SUMMARY_MAX,
  sanitizeReviewSummary,
  type ReviewMark,
} from "./snippet.ts";

/**
 * `conch_capture`: conch draws a page itself and hands back a picture of the part that matters, boxed.
 *
 * Tyler's feedback (2026-10-02, item 2): an agent showing one section of a live page drove Chrome to it, waited on lazy
 * images, scrolled again after the layout shifted, screenshotted, copied the file somewhere publishable, and then
 * guessed the box's 0-1 numbers by eye. Every step of that was a place to go wrong, and the box usually was.
 *
 * The daemon can't draw a page, so it asks the Mac app, the way it asks for a window snapshot (review-preview.ts
 * `WindowPreviews`): it names the request on the published state, the app draws the page in a web view of its own
 * (PageCapturer.swift) and answers over the socket with the PNG it wrote. Three differences from a snapshot:
 *
 * - The request names an address the user may be signed in to, and is drawn with the cookies of conch's own review
 *   pane. So it is written to the sessions file alone, which only this Mac reads (`withCaptureRequests`), never onto the
 *   state the phone and a second Mac are sent; and a phone may not send either half (`MAC_APP_ONLY_KINDS`).
 * - The agent waits on it, so the request is held open on the socket until the app answers (`createPageCaptureService`), and
 *   an app that never picks it up is told apart from one that is slow: it acknowledges first (`ack`), within
 *   `CAPTURE_ACK_MS`, or the agent hears the Mac app isn't running.
 * - The picture is a deliverable, so it is kept where a deliverable can be published from and outlives temp's sweeps
 *   (capture-folder.ts), and pruned there once nothing holds it (`pruneCaptures`).
 */

/** What a page is drawn at when the agent names no size: a laptop's browser window. */
export const CAPTURE_VIEWPORT_DEFAULT = { width: 1440, height: 900 } as const;
export const CAPTURE_VIEWPORT_MIN = { width: 320, height: 320 } as const;
export const CAPTURE_VIEWPORT_MAX = { width: 3840, height: 2400 } as const;

/**
 * How long the Mac app has to say it has the request. It reads the sessions file every quarter second, but a Mac app
 * in the background may be napping (App Nap stretches its timers), so this is generous; past it, it isn't running.
 */
export const CAPTURE_ACK_MS = 10_000;
/** How long the daemon holds an agent waiting, all told: well under the minute a Codex tool call is given. */
export const CAPTURE_TIMEOUT_MS = 42_000;
/** The Mac app's own deadline for the drawing, from the request: inside the daemon's, so its error arrives first. */
export const CAPTURE_RENDER_MS = 36_000;
/** How long the MCP server waits on the daemon's answer: past the daemon's own deadline, so its words arrive first. */
export const CAPTURE_REPLY_MS = 50_000;
/** Pages drawn at once. Each is a web content process; an agent firing a dozen at once waits its turn instead. */
export const CAPTURES_IN_FLIGHT = 3;
/** An unreferenced capture is deleted after this long, and the oldest of them past this many. */
export const CAPTURE_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPTURES_KEPT = 200;
/** The largest file the daemon will take from the app as a capture. */
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** The marks a capture can draw round its target, as `ReviewMark` kinds; a stroke is a hand's line, not a box. */
export const CAPTURE_MARK_KINDS = ["box", "highlight", "ellipse", "arrow", "pin", "text"] as const;
export type CaptureMarkKind = (typeof CAPTURE_MARK_KINDS)[number];

/** Said, word for word, when nothing picked the request up (the task's own wording, so an agent can match on it). */
export const MAC_APP_DOWN = "conch's Mac app isn't running, so it can't render pages; open it and try again";

export type CaptureTarget = { selector: string } | { quote: string };
export interface CaptureViewport { width: number; height: number }
export interface CaptureMarkSpec { kind: CaptureMarkKind; label?: string }

/** Where a capture is filed, when the agent asked for that: its session as the MCP server verified it, and the words. */
export interface CapturePublishSpec {
  sessionId: string;
  label: string;
  cwd?: string;
  pid?: number;
  transcriptPath?: string;
  transcriptMark?: number;
  summary: string;
  key?: string;
}

/** The MCP server's request to the daemon. `roots` are the folders a local page was checked against. */
export interface PageCaptureMessage {
  kind: "page-capture";
  url: string;
  roots: string[];
  target?: CaptureTarget;
  viewport: CaptureViewport;
  fullPage: boolean;
  mark?: CaptureMarkSpec;
  publish?: CapturePublishSpec;
}

/** What the Mac app is asked to draw, on the sessions file alone (`withCaptureRequests`). */
export interface CaptureRequest {
  id: string;
  url: string;
  target?: CaptureTarget;
  viewport: CaptureViewport;
  fullPage: boolean;
  /** Where to write `<id>.png`: conch's capture folder, which the app checks it is (ConchDesign `PageCapture.folder`). */
  folder: string;
  /** Epoch-ms by which the app gives up and says so. */
  deadline: number;
}

/** A capture as the agent gets it. Every number is the PNG's own pixels; `element` is the target's box in them. */
export interface CaptureShot {
  path: string;
  width: number;
  height: number;
  devicePixelRatio: number;
  element?: { x: number; y: number; w: number; h: number };
  finalUrl: string;
  title: string;
  loginWall: boolean;
  /** The target is larger than the view, or ran off it: only what the view held of it is in the picture. */
  clipped?: true;
  /** The page was still moving (images loading, layout shifting) when conch's wait ran out; captured anyway. */
  unsettled?: true;
}

/** What conch saw when it couldn't capture what was asked: the page it got, and a picture of it when it took one. */
export interface CaptureSeen {
  path?: string;
  finalUrl?: string;
  title?: string;
  loginWall?: boolean;
  headings?: string[];
}

export type CaptureOutcome = { ok: true; shot: CaptureShot } | { ok: false; error: string; seen?: CaptureSeen };

export interface CaptureFiling { id: string; artifact: string; version: number; kind: "image"; summary: string }

/** The daemon's answer to `page-capture`. */
export type PageCaptureReply =
  | {
    kind: "page-capture-result";
    capture: CaptureShot;
    /** The marks round the target, as `review_to_front` takes them, when a mark was asked for. */
    marks?: ReviewMark[];
    /** The deliverable it was filed as, when it was. */
    filed?: CaptureFiling;
    /** Why a capture the agent asked to publish wasn't filed. */
    notFiled?: string;
  }
  | { kind: "page-capture-error"; error: string; seen?: CaptureSeen };

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One line of printable text, 1 to `max` characters (the rule a mark's anchor and label follow), or null. */
function oneLine(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null;
}

/** `target`: exactly one of a selector or a quote, each named the way a mark's frame names one. */
export function parseCaptureTarget(value: unknown): Parsed<CaptureTarget> {
  const keys = isRecord(value) ? Object.keys(value) : [];
  if (!isRecord(value) || keys.length !== 1 || (keys[0] !== "selector" && keys[0] !== "quote")) {
    return { ok: false, reason: "target must be exactly one of {selector} or {quote}" };
  }
  const how = keys[0] as "selector" | "quote";
  const what = oneLine(value[how], REVIEW_MARK_FRAME_MAX[how]);
  if (!what) return { ok: false, reason: `target.${how} must be one line of 1 to ${REVIEW_MARK_FRAME_MAX[how]} characters` };
  return { ok: true, value: how === "selector" ? { selector: what } : { quote: what } };
}

/** `viewport`: whole CSS pixels, within what a screen is. */
export function parseCaptureViewport(value: unknown): Parsed<CaptureViewport> {
  const fits = (n: unknown, min: number, max: number): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "width" && key !== "height")
    || !fits(value.width, CAPTURE_VIEWPORT_MIN.width, CAPTURE_VIEWPORT_MAX.width)
    || !fits(value.height, CAPTURE_VIEWPORT_MIN.height, CAPTURE_VIEWPORT_MAX.height)) {
    return {
      ok: false,
      reason: `viewport must be {width, height} in whole CSS pixels, width ${CAPTURE_VIEWPORT_MIN.width}-${CAPTURE_VIEWPORT_MAX.width}`
        + ` and height ${CAPTURE_VIEWPORT_MIN.height}-${CAPTURE_VIEWPORT_MAX.height}`,
    };
  }
  return { ok: true, value: { width: value.width, height: value.height } };
}

/** `mark`: "box" or "highlight", or `{kind, label?}`; text needs its label, it is the text. */
export function parseCaptureMark(value: unknown): Parsed<CaptureMarkSpec> {
  const spec = typeof value === "string" ? { kind: value } : value;
  if (!isRecord(spec) || Object.keys(spec).some((key) => key !== "kind" && key !== "label")) {
    return { ok: false, reason: 'mark must be "box", "highlight", or {kind, label?}' };
  }
  const kind = CAPTURE_MARK_KINDS.find((known) => known === spec.kind);
  if (!kind) return { ok: false, reason: `mark kind must be one of ${CAPTURE_MARK_KINDS.join(", ")}` };
  let label: string | undefined;
  if (Object.hasOwn(spec, "label")) {
    const checked = oneLine(spec.label, REVIEW_MARK_LABEL_MAX);
    if (!checked) return { ok: false, reason: `mark label must be one line of 1 to ${REVIEW_MARK_LABEL_MAX} characters` };
    label = checked;
  }
  if (kind === "text" && label === undefined) return { ok: false, reason: "a text mark needs a label: it is the text" };
  return { ok: true, value: { kind, ...(label !== undefined ? { label } : {}) } };
}

/**
 * The artifact a capture is a version of, when the agent names none: the page and the part of it. A capture's file is
 * new each time, so its link can't say "the same thing again" the way a page's own link does; this does, and capturing
 * the same section after a fix files its next version rather than a second deliverable.
 */
export function defaultCaptureKey(url: string, target?: CaptureTarget): string {
  const part = !target ? "" : "selector" in target ? ` ${target.selector}` : ` "${target.quote}"`;
  return sanitizeReviewSummary(`capture ${url}${part}`, ARTIFACT_KEY_MAX);
}

/** The socket's `page-capture`, re-checked field by field: the MCP server checked it, but the socket takes any local writer. */
export function decodePageCaptureMessage(value: unknown): { ok: true; value: PageCaptureMessage } | { ok: false; err: string } {
  const no = (err: string) => ({ ok: false, err }) as const;
  if (!isRecord(value) || value.kind !== "page-capture") return no("not a page capture");
  const url = typeof value.url === "string" ? value.url : "";
  let web = false;
  try {
    const parsed = new URL(url);
    web = (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {}
  if (!web && (!url.startsWith("/") || url.includes("\0") || url.length > 4096)) {
    return no("url must be an http(s) URL or the absolute path of a local page");
  }
  const roots = Array.isArray(value.roots) ? value.roots : [];
  if (roots.length > 32 || !roots.every((root): root is string => typeof root === "string" && root.startsWith("/"))) {
    return no("roots must be absolute folders");
  }
  const target = value.target === undefined ? undefined : parseCaptureTarget(value.target);
  if (target && !target.ok) return no(target.reason);
  const viewport = parseCaptureViewport(value.viewport ?? CAPTURE_VIEWPORT_DEFAULT);
  if (!viewport.ok) return no(viewport.reason);
  if (value.fullPage !== undefined && typeof value.fullPage !== "boolean") return no("fullPage must be true or false");
  const mark = value.mark === undefined ? undefined : parseCaptureMark(value.mark);
  if (mark && !mark.ok) return no(mark.reason);
  if (mark && !target) return no("a mark is drawn round the target; name one");
  let publish: CapturePublishSpec | undefined;
  if (value.publish !== undefined) {
    const spec = value.publish;
    if (!isRecord(spec) || typeof spec.sessionId !== "string" || !spec.sessionId || typeof spec.label !== "string") {
      return no("publish must name its session and label");
    }
    const summary = typeof spec.summary === "string" ? sanitizeReviewSummary(spec.summary) : "";
    if (!summary || summary !== spec.summary) return no(`publish summary must be one printable line of 1-${REVIEW_SUMMARY_MAX} characters`);
    if (spec.key !== undefined) {
      const key = typeof spec.key === "string" ? sanitizeReviewSummary(spec.key, Infinity) : "";
      if (!key || key.length > ARTIFACT_KEY_MAX || key !== spec.key) return no(`publish key must be one printable line of 1-${ARTIFACT_KEY_MAX} characters`);
    }
    for (const field of ["cwd", "transcriptPath"] as const) {
      if (spec[field] !== undefined && typeof spec[field] !== "string") return no(`publish ${field} must be a string`);
    }
    for (const field of ["pid", "transcriptMark"] as const) {
      if (spec[field] !== undefined && !Number.isFinite(spec[field])) return no(`publish ${field} must be a number`);
    }
    publish = {
      sessionId: spec.sessionId,
      label: spec.label,
      summary,
      ...(typeof spec.cwd === "string" ? { cwd: spec.cwd } : {}),
      ...(typeof spec.pid === "number" ? { pid: spec.pid } : {}),
      ...(typeof spec.transcriptPath === "string" ? { transcriptPath: spec.transcriptPath } : {}),
      ...(typeof spec.transcriptMark === "number" ? { transcriptMark: spec.transcriptMark } : {}),
      ...(typeof spec.key === "string" ? { key: spec.key } : {}),
    };
  }
  return {
    ok: true,
    value: {
      kind: "page-capture",
      url,
      roots,
      ...(target ? { target: target.value } : {}),
      viewport: viewport.value,
      fullPage: value.fullPage === true,
      ...(mark ? { mark: mark.value } : {}),
      ...(publish ? { publish } : {}),
    },
  };
}

/** The capture folder, made if it isn't there, its owner's alone. */
export function captureFolder(path: string = captureFolderPath()): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/**
 * Delete the captures nothing holds: older than `CAPTURE_KEPT_MS`, and past `CAPTURES_KEPT` the oldest of the rest. A
 * capture a held deliverable links or draws its marks on (`referenced`, as the folder names it) is kept however old,
 * since the user may still open it; one an agent took and never published goes after a week. Only PNGs directly in the
 * folder, which is all conch ever writes there.
 */
export function pruneCaptures(folder: string, now: number, referenced: ReadonlySet<string>): void {
  let files: Array<{ path: string; at: number }> = [];
  try {
    files = readdirSync(folder)
      .filter((name) => name.endsWith(".png"))
      .map((name) => {
        const path = join(folder, name);
        const found = statSync(path, { throwIfNoEntry: false });
        return found?.isFile() ? { path, at: found.mtimeMs } : null;
      })
      .filter((file): file is { path: string; at: number } => file !== null && !referenced.has(file.path));
  } catch {
    return;
  }
  const kept = files.filter((file) => now - file.at <= CAPTURE_KEPT_MS).sort((a, b) => b.at - a.at);
  const gone = [...files.filter((file) => now - file.at > CAPTURE_KEPT_MS), ...kept.slice(CAPTURES_KEPT)];
  for (const file of gone) rmSync(file.path, { force: true });
}

/** The sessions file's state, with the requests the Mac app is to draw. Never the phone's or another Mac's (see the top). */
export function withCaptureRequests<State extends object>(state: State, requests: readonly CaptureRequest[]): State & { captureRequests?: CaptureRequest[] } {
  return requests.length ? { ...state, captureRequests: [...requests] } : state;
}

/** A PNG's own width and height, from its header; null for anything that isn't one. */
async function pngSize(path: string): Promise<{ width: number; height: number } | null> {
  const file = await openFile(path, "r").catch(() => null);
  if (!file) return null;
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await file.read(head, 0, 24, 0);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytesRead < 24 || !head.subarray(0, 8).equals(signature) || head.toString("latin1", 12, 16) !== "IHDR") return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  } finally {
    await file.close();
  }
}

/**
 * The file the app says it wrote, trusted for nothing: `<request>.png` (or `<request>-seen.png`) directly in the capture
 * folder, 0600, a PNG by its own header, under the size cap, and passing the publish rule. Returned as the folder names
 * it, with the PNG's own size; null, with why, otherwise.
 */
async function ownCapture(path: unknown, folder: string, name: string): Promise<{ ok: true; path: string; width: number; height: number } | { ok: false; why: string }> {
  if (typeof path !== "string" || !path.startsWith("/")) return { ok: false, why: "no file named" };
  const [real, home] = await Promise.all([realpath(path).catch(() => null), realpath(folder).catch(() => null)]);
  if (!real || !home || dirname(real) !== home || basename(real) !== name) return { ok: false, why: `not ${name} in conch's capture folder` };
  const checked = await checkLocalFile(real, []);
  if (!checked.ok) return { ok: false, why: checked.reason };
  const found = await stat(real);
  if ((found.mode & 0o077) !== 0) return { ok: false, why: "a capture must be readable by its owner alone (0600)" };
  if (found.size > CAPTURE_MAX_BYTES) return { ok: false, why: "the capture is larger than conch takes" };
  const size = await pngSize(real);
  if (!size) return { ok: false, why: "the capture isn't a PNG" };
  return { ok: true, path: join(folder, name), ...size };
}

/** A short line from the app (a title, a heading, an address), cut to `max`; undefined when there is none. */
function said(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = sanitizeReviewSummary(value.replace(/\s+/g, " "), Infinity);
  return line ? (line.length > max ? `${line.slice(0, max - 1)}…` : line) : undefined;
}

/** The target's box from the app, in the PNG's pixels and inside it; undefined when it isn't a box at all. */
function elementBox(value: unknown, size: { width: number; height: number }): CaptureShot["element"] {
  if (!isRecord(value)) return undefined;
  const [x, y, w, h] = [value.x, value.y, value.w, value.h].map((n) => (typeof n === "number" && Number.isFinite(n) ? n : NaN));
  if ([x, y, w, h].some(Number.isNaN)) return undefined;
  const left = Math.max(0, Math.min(x!, size.width));
  const top = Math.max(0, Math.min(y!, size.height));
  const right = Math.max(left, Math.min(x! + w!, size.width));
  const bottom = Math.max(top, Math.min(y! + h!, size.height));
  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

interface PendingCapture {
  request: CaptureRequest;
  started: boolean;
  ackTimer: ReturnType<typeof setTimeout>;
  done(outcome: CaptureOutcome): void;
}

/**
 * The broker between an agent waiting and the Mac app drawing. Modelled on `WindowPreviews`: the daemon has no way to
 * call the app, so it names what it wants (`requests`, written to the sessions file) and the app answers over the
 * socket (`answer`): an `ack` at once, then the file it wrote, or why not.
 */
export interface PageCapturesOptions {
  /** Write the sessions file again: a request appeared or went. */
  publish(): void;
  /** The capture folder, made if it isn't there (`captureFolder`). */
  folder(): string;
  now(): number;
  ackMs?: number;
  timeoutMs?: number;
  renderMs?: number;
  limit?: number;
}

export class PageCaptures {
  readonly #pending = new Map<string, PendingCapture>();
  readonly #options: PageCapturesOptions;

  constructor(options: PageCapturesOptions) {
    this.#options = options;
  }

  /** What the sessions file names while an answer is due. */
  requests(): CaptureRequest[] {
    return [...this.#pending.values()].map((pending) => pending.request);
  }

  /**
   * Ask the Mac app to draw a page; its capture, or why there is none. `bounds` are this request's own, inside the
   * broker's: a publication's login-wall check (page-access.ts) has a verdict to answer within, an agent's capture
   * doesn't.
   */
  ask(
    spec: { url: string; target?: CaptureTarget; viewport: CaptureViewport; fullPage: boolean },
    bounds: { ackMs?: number; timeoutMs?: number; renderMs?: number } = {},
  ): Promise<CaptureOutcome> {
    const limit = this.#options.limit ?? CAPTURES_IN_FLIGHT;
    if (this.#pending.size >= limit) {
      return Promise.resolve({ ok: false, error: `conch is already drawing ${this.#pending.size} pages; wait for them, then try again` });
    }
    const now = this.#options.now();
    const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let folder: string;
    try {
      folder = this.#options.folder();
    } catch (error) {
      return Promise.resolve({ ok: false, error: `conch couldn't make its capture folder: ${error instanceof Error ? error.message : String(error)}` });
    }
    const request: CaptureRequest = {
      id,
      url: spec.url,
      ...(spec.target ? { target: spec.target } : {}),
      viewport: spec.viewport,
      fullPage: spec.fullPage,
      folder,
      deadline: now + (bounds.renderMs ?? this.#options.renderMs ?? CAPTURE_RENDER_MS),
    };
    const timeoutMs = bounds.timeoutMs ?? this.#options.timeoutMs ?? CAPTURE_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({
        ok: false,
        error: `the page didn't finish drawing in ${Math.round(timeoutMs / 1000)} s; try again, or capture less of it (a target rather than fullPage)`,
      }), timeoutMs);
      const ackTimer = setTimeout(() => {
        if (!this.#pending.get(id)?.started) finish({ ok: false, error: MAC_APP_DOWN });
      }, bounds.ackMs ?? this.#options.ackMs ?? CAPTURE_ACK_MS);
      const finish = (outcome: CaptureOutcome) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        clearTimeout(ackTimer);
        this.#options.publish();
        resolve(outcome);
      };
      this.#pending.set(id, { request, started: false, ackTimer, done: finish });
      this.#options.publish();
    });
  }

  /** The app's answer to one request: that it has it (`ack`), the file it wrote, or why it didn't. */
  async answer(message: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
    const waiting = typeof message.request === "string" ? this.#pending.get(message.request) : undefined;
    if (!waiting) return { ok: false, error: "no capture is waiting on that request" };
    const { request } = waiting;
    if (message.ack === true) {
      waiting.started = true;
      clearTimeout(waiting.ackTimer);
      return { ok: true };
    }
    if (typeof message.error === "string") {
      // What it saw instead, when it says: a picture of it only if that, too, is a file of conch's own.
      const seenFile = message.path === undefined ? undefined : await ownCapture(message.path, request.folder, `${request.id}-seen.png`);
      const seen: CaptureSeen = {
        ...(seenFile?.ok ? { path: seenFile.path } : {}),
        ...(said(message.finalUrl, 2048) ? { finalUrl: said(message.finalUrl, 2048) } : {}),
        ...(said(message.title, 200) ? { title: said(message.title, 200) } : {}),
        ...(message.loginWall === true ? { loginWall: true } : {}),
        ...(Array.isArray(message.headings)
          ? { headings: message.headings.slice(0, 8).map((heading) => said(heading, 80)).filter((heading): heading is string => Boolean(heading)) }
          : {}),
      };
      if (seen.headings?.length === 0) delete seen.headings;
      waiting.done({ ok: false, error: said(message.error, 400) ?? "the Mac app couldn't capture the page", ...(Object.keys(seen).length ? { seen } : {}) });
      return { ok: true };
    }
    const file = await ownCapture(message.path, request.folder, `${request.id}.png`);
    if (!file.ok) {
      waiting.done({ ok: false, error: "the Mac app's capture was refused" });
      return { ok: false, error: file.why };
    }
    const scale = typeof message.devicePixelRatio === "number" && Number.isFinite(message.devicePixelRatio)
      && message.devicePixelRatio > 0 && message.devicePixelRatio <= 8 ? message.devicePixelRatio : 1;
    const element = request.target ? elementBox(message.element, file) : undefined;
    waiting.done({
      ok: true,
      shot: {
        path: file.path,
        width: file.width,
        height: file.height,
        devicePixelRatio: Math.round(scale * 1000) / 1000,
        ...(element ? { element } : {}),
        finalUrl: said(message.finalUrl, 2048) ?? request.url,
        title: said(message.title, 200) ?? "",
        loginWall: message.loginWall === true,
        ...(message.clipped === true ? { clipped: true as const } : {}),
        ...(message.settled === false ? { unsettled: true as const } : {}),
      },
    });
    return { ok: true };
  }
}

/** Four decimals: a thousandth of a 4K-wide picture is under four pixels, and the marks' byte cap is shared. */
const unit = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;

/**
 * The mark round the target, as `review_to_front` takes it: on the capture itself (`frame.image`), its numbers 0-1 of
 * the picture from the top left. The arithmetic the agent used to do by eye, done from the box conch measured. A box or
 * an ellipse stands off the target by 8 CSS pixels, a highlight lies on it, an arrow comes in from the side with more
 * room, a pin sits on its top right corner, text goes under it. Null when the box is not inside the picture.
 */
export function captureMark(
  shot: Pick<CaptureShot, "path" | "width" | "height" | "devicePixelRatio" | "element">,
  spec: CaptureMarkSpec,
): ReviewMark | null {
  const box = shot.element;
  if (!box || shot.width <= 0 || shot.height <= 0 || box.w <= 0 || box.h <= 0) return null;
  const W = shot.width;
  const H = shot.height;
  const scale = shot.devicePixelRatio > 0 ? shot.devicePixelRatio : 1;
  const base = { id: "capture", kind: spec.kind, frame: { image: shot.path }, ...(spec.label ? { label: spec.label } : {}) };
  const rectMark = (pad: number): ReviewMark | null => {
    const left = Math.max(0, box.x - pad);
    const top = Math.max(0, box.y - pad);
    const right = Math.min(W, box.x + box.w + pad);
    const bottom = Math.min(H, box.y + box.h + pad);
    const rect: [number, number, number, number] = [unit(left / W), unit(top / H), unit((right - left) / W), unit((bottom - top) / H)];
    // Rounding must not carry it past the picture's edge or down to nothing.
    rect[2] = Math.min(rect[2], unit(1 - rect[0]));
    rect[3] = Math.min(rect[3], unit(1 - rect[1]));
    return rect[2] > 0 && rect[3] > 0 ? { ...base, rect } : null;
  };
  const point = (x: number, y: number): [number, number] => [unit(x / W), unit(y / H)];
  switch (spec.kind) {
    case "box":
    case "ellipse":
      return rectMark(8 * scale);
    case "highlight":
      return rectMark(0);
    case "pin":
      return { ...base, at: point(box.x + box.w, box.y) };
    case "text":
      return { ...base, at: point(box.x, Math.min(H, box.y + box.h + 8 * scale)) };
    case "arrow": {
      const roomLeft = box.x;
      const roomRight = W - (box.x + box.w);
      const right = roomRight >= roomLeft;
      const head = { x: right ? box.x + box.w + 4 * scale : box.x - 4 * scale, y: box.y + box.h / 2 };
      const reach = Math.min(120 * scale, right ? roomRight : roomLeft);
      let tail = { x: right ? head.x + reach : head.x - reach, y: Math.min(H, head.y + 60 * scale) };
      // No room beside it (a capture of the element alone): from inside its lower corner, at its middle.
      if (Math.hypot(tail.x - head.x, tail.y - head.y) < 0.03 * Math.hypot(W, H)) {
        tail = { x: box.x + box.w * (right ? 0.85 : 0.15), y: box.y + box.h * 0.9 };
        head.x = box.x + box.w / 2;
        head.y = box.y + box.h / 2;
      }
      return { ...base, at: point(tail.x, tail.y), to: point(head.x, head.y) };
    }
  }
}

/**
 * The publication a capture is filed as, shaped exactly as `review_to_front` sends its own (mcp.ts): a `review-published`
 * turn event for the caller's session, the capture as an image deliverable, the mark on it as agent ink. The control
 * server files it through the socket's own turn path (`createControlServer`), so it is checked and filed by the same code.
 */
export function capturePublication(
  shot: CaptureShot,
  publish: CapturePublishSpec,
  key: string,
  marks: readonly ReviewMark[],
  at: number,
): TurnEvent {
  return {
    type: "review-published",
    sessionId: publish.sessionId,
    label: publish.label,
    ...(publish.cwd ? { cwd: publish.cwd } : {}),
    ...(publish.pid !== undefined ? { pid: publish.pid } : {}),
    announce: `${publish.label} has work ready for your review: ${publish.summary}`,
    ...(publish.transcriptPath
      ? { transcriptPath: publish.transcriptPath, ...(publish.transcriptMark !== undefined ? { mark: publish.transcriptMark } : {}) }
      : {}),
    eventAt: at,
    review: {
      summary: publish.summary,
      link: shot.path,
      kind: "image",
      key,
      ...(marks.length ? { scene: { v: 1, target: { kind: "auto" }, marks: [...marks] } } : {}),
    },
  };
}

export interface PageCaptureService {
  /** An agent's `page-capture`; `file` files a publication through the socket's own turn path. */
  request(body: unknown, file: (event: TurnEvent) => Promise<{ ok: true } | { ok: false; error: string }>): Promise<PageCaptureReply>;
  /** The Mac app's `page-capture-answer`. */
  answer(body: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface PageCaptureServiceDependencies {
  captures: PageCaptures;
  /** What a session holds now, for the version its capture will be filed as (`nextVersion`). */
  held(sessionId: string): { reviews?: readonly SessionReview[]; versions?: Readonly<Record<string, number>> } | undefined;
  /** Delete the captures nothing holds (`pruneCaptures`); before each new one. */
  prune?(): void;
  now(): number;
}

/** The daemon's half of `conch_capture`: check the request, have the app draw it, mark it, and file it when asked. */
export function createPageCaptureService(deps: PageCaptureServiceDependencies): PageCaptureService {
  return {
    async request(body, file) {
      const fail = (error: string, seen?: CaptureSeen): PageCaptureReply => ({ kind: "page-capture-error", error, ...(seen ? { seen } : {}) });
      const decoded = decodePageCaptureMessage(body);
      if (!decoded.ok) return fail(decoded.err);
      const message = decoded.value;
      // A local page passes the publish rule again here, on the disk as it is now: the app is only handed one that does.
      if (message.url.startsWith("/")) {
        const checked = await checkLocalFile(message.url, message.roots);
        if (!checked.ok) return fail(checked.reason);
        if (!/\.html?$/i.test(checked.real)) return fail("a local page must be an .html file");
      }
      try {
        deps.prune?.();
      } catch {
        // Tidying is never a reason not to capture.
      }
      const outcome = await deps.captures.ask({
        url: message.url,
        ...(message.target ? { target: message.target } : {}),
        viewport: message.viewport,
        fullPage: message.fullPage,
      });
      if (!outcome.ok) return fail(outcome.error, outcome.seen);
      const shot = outcome.shot;
      const mark = message.mark ? captureMark(shot, message.mark) : null;
      const marks = mark ? [mark] : [];
      const captured: PageCaptureReply = { kind: "page-capture-result", capture: shot, ...(marks.length ? { marks } : {}) };
      if (!message.publish) return captured;
      // A sign-in screen is not the deliverable: the picture comes back, and nothing is filed under the agent's name.
      if (shot.loginWall) return { ...captured, notFiled: "the page showed a sign-in screen, so it wasn't filed as your deliverable" };
      const key = message.publish.key ?? defaultCaptureKey(message.url, message.target);
      const at = deps.now();
      const event = capturePublication(shot, message.publish, key, marks, at);
      const held = deps.held(message.publish.sessionId);
      const facts = deliverableFacts({ summary: message.publish.summary, link: shot.path, kind: "image", key });
      const id = reviewIdentity(message.publish.sessionId, { summary: message.publish.summary, link: shot.path, at });
      const version = nextVersion(held?.reviews ?? [], facts.artifact, held?.versions);
      const filed = await file(event);
      if (!filed.ok) return { ...captured, notFiled: `conch didn't file it: ${filed.error}` };
      return { ...captured, filed: { id, artifact: facts.artifact, version, kind: "image", summary: message.publish.summary } };
    },
    answer: (body) => deps.captures.answer(body),
  };
}

export type PageCaptureSend =
  | { ok: true; reply: PageCaptureReply }
  | { ok: false; reason: "daemon-down" | "no-reply"; diagnostic?: string };

/** The daemon's reply, read defensively: the shapes `createPageCaptureService` writes, or nothing. */
export function readPageCaptureReply(value: unknown): PageCaptureReply | null {
  if (!isRecord(value)) return null;
  if (value.kind === "page-capture-error") {
    return typeof value.error === "string"
      ? { kind: "page-capture-error", error: value.error, ...(isRecord(value.seen) ? { seen: value.seen as CaptureSeen } : {}) }
      : null;
  }
  if (value.kind !== "page-capture-result" || !isRecord(value.capture)) return null;
  const capture = value.capture;
  if (typeof capture.path !== "string" || !Number.isInteger(capture.width) || !Number.isInteger(capture.height)) return null;
  return value as unknown as PageCaptureReply;
}

/** The MCP server's side of the socket: one request, held open for the daemon's answer. */
export function requestPageCapture(socketPath: string, message: PageCaptureMessage, timeoutMs = CAPTURE_REPLY_MS): Promise<PageCaptureSend> {
  return new Promise((resolve) => {
    let frame: Buffer;
    try {
      frame = encodeControlFrame(JSON.stringify(message));
    } catch (error) {
      resolve({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      return;
    }
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    const reader = new ControlFrameReader();
    let connected = false;
    let settled = false;
    const finish = (result: PageCaptureSend) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: "timed out" }), timeoutMs);
    socket.on("connect", () => {
      connected = true;
      socket.write(frame);
    });
    socket.on("data", (data) => {
      if (settled) return;
      try {
        const line = reader.push(typeof data === "string" ? Buffer.from(data) : data);
        if (line === undefined) return;
        const reply = readPageCaptureReply(JSON.parse(line));
        finish(reply ? { ok: true, reply } : { ok: false, reason: "no-reply", diagnostic: "the daemon's answer wasn't a capture" });
      } catch (error) {
        finish({ ok: false, reason: "no-reply", diagnostic: error instanceof Error ? error.message : String(error) });
      }
    });
    socket.on("error", (error) => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down", diagnostic: error.message }));
    socket.on("close", () => finish({ ok: false, reason: connected ? "no-reply" : "daemon-down" }));
  });
}

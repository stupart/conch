import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { probeCommand } from "./probe.ts";
import { checkLocalFile } from "./snippet.ts";
import type { DeliverableKind } from "./deliverables.ts";

/**
 * A stand-in for a deliverable the phone has no way to draw: a snapshot of it, taken on the Mac
 * when the phone asks. Tyler (09-25): "it will also need other materials sent to it if there's
 * not an equivalent on the phone". An app window, the Simulator, a Keynote deck: the phone shows
 * "Snapshot from your Mac, 14:02 · Refresh" in their place.
 *
 * The daemon takes what it can without Screen Recording: the Simulator's screen through
 * `simctl`, and a document's first page through Quick Look's `qlmanage`. An app's window is the
 * Mac app's to take, since only it holds Screen Recording (`window` below).
 *
 * Only ever the deliverable's own: the one Simulator running (never a guess between two), the
 * document the review links, which passes the publish rule again first. Written 0600 under a
 * temp root, so `/file`'s rule serves it and nothing else can read it.
 */
export interface ReviewPreview {
  path: string;
  kind: "image";
  /** Epoch-ms the snapshot was taken. */
  capturedAt: number;
}

/** Kinds the phone has no renderer for, and so gets a snapshot of. */
export const STAND_IN_KINDS: readonly DeliverableKind[] = ["app", "simulator", "design", "document", "terminal"];

/** A snapshot of one deliverable at most this often, and this many a minute over all of them. */
export const PREVIEW_MIN_INTERVAL_MS = 10_000;
export const PREVIEWS_PER_MINUTE = 6;

export type Probe = (argv: string[], ok: readonly number[], timeoutMs: number) => Promise<string | null>;

/** Where every snapshot is written, as a path: a folder of conch's own in the temp root. */
export function previewFolderPath(root: string = tmpdir()): string {
  return join(root, "conch-previews");
}

/** Where every snapshot is written, made if it isn't there: `previewFolderPath`, 0700. */
export function previewFolder(root: string = tmpdir()): string {
  const folder = previewFolderPath(root);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  return folder;
}

/**
 * Delete a snapshot of conch's own: a file directly in `folder`, by the path it was stored under
 * (`folder` joined with its name, as every snapshot is stored). Anything else a record names is
 * never touched.
 */
export function discardPreview(path: string | undefined, folder: string): void {
  if (path && join(folder, basename(path)) === path) rmSync(path, { force: true });
}

/** Snapshots older than this go, held or not: the backstop for one nothing else deleted. Refresh takes another. */
export const PREVIEW_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** Delete the snapshot folder's files older than `PREVIEW_KEPT_MS`. */
export function prunePreviews(folder: string, now: number): void {
  for (const name of readdirSync(folder)) {
    const file = statSync(join(folder, name), { throwIfNoEntry: false });
    if (file?.isFile() && now - file.mtimeMs > PREVIEW_KEPT_MS) rmSync(join(folder, name), { force: true });
  }
}

/**
 * Refresh is a button on a phone, pressed again when nothing seems to happen: a capture per
 * deliverable at most every `PREVIEW_MIN_INTERVAL_MS`, and `PREVIEWS_PER_MINUTE` over all of them,
 * so a stuck button or a hostile client can't keep the Mac capturing.
 */
export class PreviewLimiter {
  readonly #last = new Map<string, number>();
  #recent: number[] = [];

  /** Null when a capture may start now (and counts it), else how long to wait, in seconds. */
  take(key: string, now: number): number | null {
    this.#recent = this.#recent.filter((at) => now - at < 60_000);
    const last = this.#last.get(key);
    if (last !== undefined && now - last < PREVIEW_MIN_INTERVAL_MS) return Math.ceil((PREVIEW_MIN_INTERVAL_MS - (now - last)) / 1000);
    if (this.#recent.length >= PREVIEWS_PER_MINUTE) return Math.ceil((60_000 - (now - this.#recent[0]!)) / 1000);
    this.#last.set(key, now);
    this.#recent.push(now);
    return null;
  }
}

export type PreviewOutcome = { ok: true; preview: ReviewPreview } | { ok: false; error: string };

/**
 * The Simulator's screen, when exactly one device is booted. Two booted is two apps, perhaps two
 * sessions', and conch can't tell which is this deliverable's, so it takes neither.
 */
export async function captureSimulator(out: string, probe: Probe = probeCommand): Promise<string | null> {
  const listed = await probe(["xcrun", "simctl", "list", "devices", "booted", "--json"], [0], 5_000);
  if (listed === null) return "the Simulator didn't answer";
  let booted: string[] = [];
  try {
    const devices = (JSON.parse(listed) as { devices?: Record<string, Array<{ udid?: unknown; state?: unknown }>> }).devices ?? {};
    booted = Object.values(devices).flat()
      .filter((device) => device.state === "Booted" && typeof device.udid === "string")
      .map((device) => device.udid as string);
  } catch {
    return "the Simulator's answer couldn't be read";
  }
  if (booted.length === 0) return "no Simulator is running";
  if (booted.length > 1) return "more than one Simulator is running, and conch can't tell which is this deliverable's";
  const taken = await probe(["xcrun", "simctl", "io", booted[0]!, "screenshot", "--type=png", out], [0], 15_000);
  return taken === null ? "the Simulator didn't take a screenshot" : null;
}

/** A document's first page through Quick Look, once the file passes the publish rule again. */
export async function captureDocument(link: string, roots: readonly string[], out: string, probe: Probe = probeCommand): Promise<string | null> {
  const checked = await checkLocalFile(link, roots);
  if (!checked.ok) return checked.reason;
  // qlmanage names its thumbnail after the file, in a folder it is given: a fresh one each time.
  const scratch = mkdtempSync(join(tmpdir(), "conch-ql-"));
  try {
    const made = await probe(["qlmanage", "-t", "-s", "1600", "-o", scratch, checked.real], [0], 20_000);
    const thumbnail = readdirSync(scratch).find((name) => name.startsWith(basename(checked.real)) && name.endsWith(".png"));
    if (made === null || !thumbnail) return "Quick Look couldn't draw this document";
    renameSync(join(scratch, thumbnail), out);
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Take a snapshot of one held deliverable the daemon can capture itself, into `folder`. An app
 * window, a design and a terminal are the Mac app's (they need Screen Recording): refused here.
 */
export async function capturePreview(
  review: { id: string; kind?: DeliverableKind; link?: string },
  roots: readonly string[],
  options: { folder: string; now: number; probe?: Probe },
): Promise<PreviewOutcome> {
  const out = join(options.folder, `${review.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)}-${options.now}.png`);
  let error: string | null;
  if (review.kind === "simulator") error = await captureSimulator(out, options.probe);
  else if (review.kind === "document" && review.link?.startsWith("/")) error = await captureDocument(review.link, roots, out, options.probe);
  // Nothing says which of their windows is this deliverable's: a design is one Figma file of any
  // open, a terminal is the conversation the phone already shows.
  else if (review.kind === "design") return { ok: false, error: "conch can't tell which Figma window is this design; ask the agent to export it as an image and publish that" };
  else if (review.kind === "terminal") return { ok: false, error: "the terminal is this session's own conversation, on the phone already" };
  else return { ok: false, error: "conch takes a snapshot of this kind of deliverable in its Mac app" };
  if (error) {
    rmSync(out, { force: true });
    return { ok: false, error };
  }
  try {
    chmodSync(out, 0o600);
  } catch {
    return { ok: false, error: "the snapshot wasn't written" };
  }
  return { ok: true, preview: { path: out, kind: "image", capturedAt: options.now } };
}

export interface PreviewRequesterDependencies {
  /** What a session holds now, and the folders it works in (its row's `cwd` and `workDirs`). */
  held(sessionId: string): { reviews: ReadonlyArray<{ id: string; kind?: DeliverableKind; link?: string; preview?: ReviewPreview }>; roots: string[] } | undefined;
  /** Put the snapshot on the review; false when the session no longer holds it. */
  attach(sessionId: string, reviewId: string, preview: ReviewPreview): boolean;
  limiter: PreviewLimiter;
  folder(): string;
  now(): number;
  probe?: Probe;
  /** An app window's snapshot, taken by the Mac app (`WindowPreviews.ask`). */
  window?(sessionId: string, reviewId: string): Promise<PreviewOutcome>;
}

/** What the phone is told: 200, or why not, in words it can show. */
export type PreviewAnswer = { status: 200 } | { status: 404 | 400 | 429 | 422; error: string };

/**
 * The phone's Refresh, and its first look at a deliverable it can't draw: take a snapshot of one
 * held deliverable and put it on the review, which republishes it. Only a deliverable the session
 * still holds, only a kind the phone has no renderer for, never faster than `PreviewLimiter`
 * allows. The snapshot it replaces is deleted.
 */
export function createPreviewRequester(deps: PreviewRequesterDependencies): (sessionId: string, reviewId: string) => Promise<PreviewAnswer> {
  return async (sessionId, reviewId) => {
    const holding = deps.held(sessionId);
    const review = holding?.reviews.find((one) => one.id === reviewId);
    if (!holding || !review) return { status: 404, error: "that deliverable isn't held any more" };
    if (!review.kind || !STAND_IN_KINDS.includes(review.kind)) return { status: 400, error: "the phone shows this kind of deliverable itself" };
    const wait = deps.limiter.take(`${sessionId}\u0000${reviewId}`, deps.now());
    if (wait !== null) return { status: 429, error: `a snapshot was just taken; another in ${wait} s` };
    const folder = deps.folder();
    prunePreviews(folder, deps.now());
    const taken = review.kind === "app"
      ? await (deps.window?.(sessionId, reviewId) ?? Promise.resolve<PreviewOutcome>({ ok: false, error: "conch's Mac app isn't connected" }))
      : await capturePreview(review, holding.roots, { folder, now: deps.now(), probe: deps.probe });
    if (!taken.ok) return { status: 422, error: taken.error };
    if (!deps.attach(sessionId, reviewId, taken.preview)) {
      rmSync(taken.preview.path, { force: true });
      return { status: 404, error: "that deliverable isn't held any more" };
    }
    // Only a snapshot of conch's own, in its own folder, is ever deleted.
    const old = review.preview?.path;
    if (old !== taken.preview.path) discardPreview(old, folder);
    return { status: 200 };
  };
}

/** A window snapshot the daemon wants, named on the published state for the Mac app (`previewRequests`). */
export interface PreviewRequest {
  id: string;
  sessionId: string;
  review: string;
  /** Where to write it: the daemon's snapshot folder, whose temp root may not be the app's own. */
  folder: string;
}

/** How long the Mac app has to answer: it finds the window and takes it, which is quick when it is open at all. */
export const WINDOW_PREVIEW_TIMEOUT_MS = 15_000;

/**
 * Snapshots of an app's window, which only the Mac app can take: it holds Screen Recording, and it
 * takes one only while that is already granted, never asking because a phone did. The daemon has
 * no way to call the app, so it names what it wants on the published state (`requests`) and the
 * app answers over the socket with the file it wrote (`answer`).
 *
 * The app's file is trusted for nothing: it must answer a request that is waiting, and be 0600,
 * in conch's own snapshot folder, passing the publish rule (`checkLocalFile`), or it is refused.
 */
export class WindowPreviews {
  readonly #pending = new Map<string, Omit<PreviewRequest, "folder"> & { done(outcome: PreviewOutcome): void }>();
  readonly #options: { publish(): void; folder(): string; now(): number; timeoutMs?: number };

  constructor(options: { publish(): void; folder(): string; now(): number; timeoutMs?: number }) {
    this.#options = options;
  }

  /** What the published state names while an answer is due. */
  requests(): PreviewRequest[] {
    const folder = this.#options.folder();
    return [...this.#pending.values()].map(({ id, sessionId, review }) => ({ id, sessionId, review, folder }));
  }

  /** Ask the Mac app for one deliverable's window; its outcome, or why none came. */
  ask(sessionId: string, review: string): Promise<PreviewOutcome> {
    const id = `${this.#options.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish({
        ok: false,
        error: "conch's Mac app didn't take the snapshot: it may not be open",
      }), this.#options.timeoutMs ?? WINDOW_PREVIEW_TIMEOUT_MS);
      const finish = (outcome: PreviewOutcome) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        this.#options.publish();
        resolve(outcome);
      };
      this.#pending.set(id, { id, sessionId, review, done: finish });
      this.#options.publish();
    });
  }

  /** The app's answer to one request: the file it wrote, or why it didn't. */
  async answer(message: { request?: unknown; path?: unknown; error?: unknown }): Promise<{ ok: true } | { ok: false; error: string }> {
    const waiting = typeof message.request === "string" ? this.#pending.get(message.request) : undefined;
    if (!waiting) return { ok: false, error: "no snapshot is waiting on that request" };
    if (typeof message.error === "string") {
      waiting.done({ ok: false, error: message.error.slice(0, 300) });
      return { ok: true };
    }
    const path = typeof message.path === "string" ? message.path : "";
    const refused = (why: string) => {
      waiting.done({ ok: false, error: "the Mac app's snapshot was refused" });
      return { ok: false as const, error: why };
    };
    const [real, folder] = await Promise.all([realpath(path).catch(() => null), realpath(this.#options.folder()).catch(() => null)]);
    if (!real || !folder || dirname(real) !== folder) return refused("not a file in conch's snapshot folder");
    const checked = await checkLocalFile(real, []);
    if (!checked.ok) return refused(checked.reason);
    if (((await stat(real)).mode & 0o077) !== 0) return refused("a snapshot must be readable by its owner alone (0600)");
    // Stored as the folder names it, as the daemon's own snapshots are: its real path (`/private/var/…` for `/var/…`)
    // never matched, so the next Refresh left this one behind (`discardPreview`).
    waiting.done({ ok: true, preview: { path: join(this.#options.folder(), basename(real)), kind: "image", capturedAt: this.#options.now() } });
    return { ok: true };
  }
}

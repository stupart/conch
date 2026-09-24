import { chmodSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/** Where every snapshot is written: a folder of conch's own in the temp root, 0700. */
export function previewFolder(root: string = tmpdir()): string {
  const folder = join(root, "conch-previews");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  return folder;
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
    const taken = await capturePreview(review, holding.roots, { folder, now: deps.now(), probe: deps.probe });
    if (!taken.ok) return { status: 422, error: taken.error };
    if (!deps.attach(sessionId, reviewId, taken.preview)) {
      rmSync(taken.preview.path, { force: true });
      return { status: 404, error: "that deliverable isn't held any more" };
    }
    // Only a snapshot of conch's own, in its own folder, is ever deleted.
    const old = review.preview?.path;
    if (old && old !== taken.preview.path && join(folder, basename(old)) === old) rmSync(old, { force: true });
    return { status: 200 };
  };
}

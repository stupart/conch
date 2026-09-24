import { appendFileSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { probeCommand } from "./probe.ts";
import type { ParseResult } from "./settings.ts";

/**
 * What is on Tyler's screen right now, and which agent session owns it.
 *
 * Tyler (09-25): "the portion of the deamon that says what is on screen is modular so we could
 * potentially add a light local (or cloud) vision model to it if we find clear use in that vs it
 * being programatic." So it is three replaceable parts, each a list you add to rather than code you
 * edit (docs/screen-context.md has the how-to):
 *
 * - OBSERVERS produce raw evidence, one `ScreenObservation` each. They live in the daemon or report
 *   over the socket from an app; `SCREEN_OBSERVERS` names every one conch accepts.
 * - RESOLVERS are pure functions over that evidence, tried in order; the first that answers wins.
 * - The SERVICE keeps the latest answer in memory, publishes it (`showing` in the published state,
 *   `conch_on_screen`) and hands it to the local log.
 *
 * "it might not only be local host things in browsers that agents are showing - could be Mac apps,
 * Figma, iphone sim, terminal, video in media player, image in preview, live urls, other apps." —
 * which is why a surface is a tagged union rather than a URL.
 */

export type ScreenSurface =
  | { kind: "file"; path: string }
  | { kind: "url"; url: string }
  | { kind: "terminal"; tty?: string }
  | { kind: "simulator"; udid?: string; bundleId?: string }
  /** Figma, Preview, a media player: an app, and the document it has open when it says. */
  | { kind: "app"; bundleId: string; document?: string }
  /** A design tool's canvas (Figma). */
  | { kind: "design" }
  | { kind: "conch"; sessionId: string; view: "panel" | "overlay" | "main" }
  | { kind: "unknown" };

export interface ScreenObservation {
  v: 1;
  /** Which observer saw it: an id in `SCREEN_OBSERVERS`. */
  source: string;
  /** Epoch-ms the observer saw it. */
  at: number;
  app?: { bundleId: string; pid?: number; name?: string };
  window?: { title?: string };
  surface: ScreenSurface;
  /** conch put this on screen itself, for this session and deliverable: exact, not inferred. */
  staged?: { sessionId: string; reviewId?: string; artifact?: string; link?: string };
}

/**
 * Every source of observations conch accepts. An observation naming any other source is refused
 * at the socket, so a new observer is one entry here plus its producer.
 *
 * `start` is for an observer that runs inside the daemon: it is handed the sink and returns its
 * stop. An observer that lives in an app has none; the app reports over the socket instead.
 */
export interface ScreenObserver {
  id: string;
  start?(emit: (observation: ScreenObservation) => void): () => void;
}

export const SCREEN_OBSERVERS: readonly ScreenObserver[] = [
  // The Mac app, when the Ready pill or the menu stages something (`ConchStatusItem.stage`), or
  // conch's own window shows a session. It knows only what conch itself put on screen.
  { id: "conch-staged" },
  // The Mac app, whenever another app comes to the front and every few seconds after: that app,
  // and with the Accessibility grant the file or page its front window shows (`FrontWindowObserver`).
  // What it sees on its own, so `showing` follows Tyler when he moves on from what conch staged.
  { id: "front-window" },
  // Not built yet, in the order they are likely to earn their place (docs/screen-context.md):
  // - "simulator": the booted Simulator's front app bundle id → DerivedData's WorkspacePath → session.
  // - "vision": a local or cloud model (OCR or a VLM) matching a screenshot to known deliverables.
];

const MAX_TEXT = 1_024;
const MAX_ID = 256;
/** A path or a URL. */
const MAX_LOCATION = 8_192;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const BUNDLE_ID = /^[A-Za-z0-9.-]{1,255}$/;
const TTY = /^(?:\/dev\/)?tty[A-Za-z0-9]{1,8}$/;
const UDID = /^[A-Za-z0-9-]{1,64}$/;
const CONCH_VIEWS = ["panel", "overlay", "main"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, name: string, max: number): ParseResult<string> {
  if (typeof value !== "string") return { ok: false, err: `${name} must be a string` };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, err: `${name} cannot be empty` };
  if (trimmed.length > max) return { ok: false, err: `${name} cannot exceed ${max} characters` };
  if (CONTROL_CHARS.test(trimmed)) return { ok: false, err: `${name} cannot contain control characters` };
  return { ok: true, value: trimmed };
}

function matching(value: unknown, name: string, pattern: RegExp): ParseResult<string> {
  return typeof value === "string" && pattern.test(value)
    ? { ok: true, value }
    : { ok: false, err: `${name} is malformed` };
}

function absolutePath(value: unknown, name: string): ParseResult<string> {
  const path = text(value, name, MAX_LOCATION);
  if (path.ok && !path.value.startsWith("/")) return { ok: false, err: `${name} must be absolute` };
  return path;
}

function webURL(value: unknown, name: string): ParseResult<string> {
  const url = text(value, name, MAX_LOCATION);
  if (!url.ok) return url;
  try {
    const parsed = new URL(url.value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) return url;
  } catch {}
  return { ok: false, err: `${name} must be an http(s) URL` };
}

/**
 * Optional fields: absent stays absent, present must be valid. Returns the fields to spread, or
 * the first error. Unknown fields are dropped, as the other socket validators do.
 */
function optional(
  from: Record<string, unknown>,
  checks: Record<string, (value: unknown) => ParseResult<unknown>>,
): ParseResult<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, check] of Object.entries(checks)) {
    if (from[key] === undefined) continue;
    const checked = check(from[key]);
    if (!checked.ok) return checked;
    out[key] = checked.value;
  }
  return { ok: true, value: out };
}

function validateSurface(value: unknown): ParseResult<ScreenSurface> {
  if (!record(value)) return { ok: false, err: "surface must be an object" };
  const done = (fields: ParseResult<Record<string, unknown>>): ParseResult<ScreenSurface> =>
    fields.ok ? { ok: true, value: { kind: value.kind, ...fields.value } as ScreenSurface } : fields;
  switch (value.kind) {
    case "file":
      return done(optional(value, { path: (v) => absolutePath(v, "surface.path") }));
    case "url":
      return done(optional(value, { url: (v) => webURL(v, "surface.url") }));
    case "terminal":
      return done(optional(value, { tty: (v) => matching(v, "surface.tty", TTY) }));
    case "simulator":
      return done(optional(value, {
        udid: (v) => matching(v, "surface.udid", UDID),
        bundleId: (v) => matching(v, "surface.bundleId", BUNDLE_ID),
      }));
    case "app":
      return done(optional(value, {
        bundleId: (v) => matching(v, "surface.bundleId", BUNDLE_ID),
        document: (v) => text(v, "surface.document", MAX_LOCATION),
      }));
    case "conch":
      return done(optional(value, {
        sessionId: (v) => text(v, "surface.sessionId", MAX_ID),
        view: (v) => CONCH_VIEWS.includes(v as never)
          ? { ok: true, value: v }
          : { ok: false, err: `surface.view must be ${CONCH_VIEWS.join(", ")}` },
      }));
    case "design":
    case "unknown":
      return { ok: true, value: { kind: value.kind } };
    default:
      return { ok: false, err: `unknown surface kind "${String(value.kind)}"` };
  }
}

/** The fields each surface kind cannot do without; `optional` let them through absent. */
const REQUIRED_SURFACE_FIELDS: Partial<Record<ScreenSurface["kind"], string[]>> = {
  file: ["path"],
  url: ["url"],
  app: ["bundleId"],
  conch: ["sessionId", "view"],
};

/**
 * Hostile input to typed evidence, at the socket (`screen-observation`). Strict about every field
 * it keeps — types, bounds, no control characters, a known surface kind from a known observer —
 * and, like the other socket validators, rebuilds the value so nothing it did not check survives.
 */
export function validateScreenObservation(value: unknown): ParseResult<ScreenObservation> {
  if (!record(value)) return { ok: false, err: "observation must be an object" };
  if (value.v !== 1) return { ok: false, err: "observation v must be 1" };
  if (!SCREEN_OBSERVERS.some((observer) => observer.id === value.source)) {
    return { ok: false, err: `unknown observer "${String(value.source)}"` };
  }
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at <= 0) {
    return { ok: false, err: "observation at must be a positive epoch-ms number" };
  }
  const surface = validateSurface(value.surface);
  if (!surface.ok) return surface;
  const missing = REQUIRED_SURFACE_FIELDS[surface.value.kind]?.find((key) => !(key in surface.value));
  if (missing) return { ok: false, err: `surface.${missing} is required for ${surface.value.kind}` };

  const observation: ScreenObservation = { v: 1, source: value.source as string, at: value.at, surface: surface.value };
  if (value.app !== undefined) {
    if (!record(value.app)) return { ok: false, err: "app must be an object" };
    const bundleId = matching(value.app.bundleId, "app.bundleId", BUNDLE_ID);
    if (!bundleId.ok) return bundleId;
    const rest = optional(value.app, {
      pid: (v) => Number.isSafeInteger(v) && (v as number) > 0 ? { ok: true, value: v } : { ok: false, err: "app.pid must be a positive integer" },
      name: (v) => text(v, "app.name", MAX_TEXT),
    });
    if (!rest.ok) return rest;
    observation.app = { bundleId: bundleId.value, ...rest.value };
  }
  if (value.window !== undefined) {
    if (!record(value.window)) return { ok: false, err: "window must be an object" };
    const rest = optional(value.window, { title: (v) => text(v, "window.title", MAX_TEXT) });
    if (!rest.ok) return rest;
    observation.window = rest.value;
  }
  if (value.staged !== undefined) {
    if (!record(value.staged)) return { ok: false, err: "staged must be an object" };
    const sessionId = text(value.staged.sessionId, "staged.sessionId", MAX_ID);
    if (!sessionId.ok) return sessionId;
    const rest = optional(value.staged, {
      reviewId: (v) => text(v, "staged.reviewId", MAX_ID),
      artifact: (v) => text(v, "staged.artifact", MAX_LOCATION),
      link: (v) => text(v, "staged.link", MAX_LOCATION),
    });
    if (!rest.ok) return rest;
    observation.staged = { sessionId: sessionId.value, ...rest.value };
  }
  return { ok: true, value: observation };
}

/** A live session, as far as the resolvers need one. */
export interface ScreenSession {
  sessionId: string;
  cwd?: string;
  workDirs?: string[];
  pid?: number;
  tty?: string;
}

/** A deliverable a session is still holding, by the strings it was published with. */
export interface HeldDeliverable {
  sessionId: string;
  reviewId?: string;
  link?: string;
  /** The published record's own artifact key, when the daemon files one. */
  artifact?: string;
}

/** A process listening on a localhost port: where it runs, and who started it. */
export interface PortListener {
  pid: number;
  /** Its working folder, when `lsof` could say. */
  cwd?: string;
  /** Its parent, that one's parent, and so on up to launchd (not included): nearest first. */
  parents: number[];
}

/**
 * Everything a resolver may consult. Resolvers are pure over this: whatever touches the world
 * is reached through it (`realpath`) or gathered into it first (`listeners`), so a test can hand
 * a resolver any world it likes.
 */
export interface ScreenResolveContext {
  sessions: readonly ScreenSession[];
  deliverables: readonly HeldDeliverable[];
  now: number;
  home: string;
  realpath(path: string): string;
  /** Who listens on the localhost port the observation's page is on, looked up before resolving. */
  listeners?: readonly PortListener[];
}

export interface ScreenResolution {
  sessionId?: string;
  reviewId?: string;
  artifact?: string;
  confidence: number;
  reason: string;
  /** Present instead of `sessionId` when the evidence fits more than one session equally. */
  candidates?: string[];
}

export interface ScreenResolver {
  id: string;
  resolve(observation: ScreenObservation, context: ScreenResolveContext): ScreenResolution | null;
}

/** What is showing, as the daemon holds and publishes it. Memory only. */
export interface Showing extends ScreenResolution {
  surface: ScreenSurface;
  source: string;
  at: number;
}

/** One session, else the tie: never a guess between equals. */
function oneOf(sessionIds: readonly string[], confidence: number, reason: string): ScreenResolution | null {
  const candidates = [...new Set(sessionIds)];
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { sessionId: candidates[0]!, confidence, reason };
  return { candidates, confidence: confidence / candidates.length, reason: `ambiguous: ${reason}` };
}

/** The file a surface shows, when it names one. */
function observedPath(surface: ScreenSurface): string | undefined {
  if (surface.kind === "file") return surface.path;
  if (surface.kind === "app" && surface.document?.startsWith("/")) return surface.document;
  return undefined;
}

/** A link compared the way a person would: a file by its real path, a page by origin and path. */
function linkKey(link: string, context: ScreenResolveContext): string | undefined {
  if (link.startsWith("/")) return `file:${context.realpath(link)}`;
  try {
    const url = new URL(link);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // A query or a fragment is where on the page, not which page.
    return `url:${url.origin}${url.pathname.replace(/(.)\/$/, "$1")}`;
  } catch {
    return undefined;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The sessions whose folder holds `path`, the most specific folder winning. The home folder is
 * skipped: a session started there (the help session, a new one) holds everything, so it would
 * claim every file on the Mac.
 */
function folderOwners(path: string, context: ScreenResolveContext): string[] {
  const real = context.realpath(path);
  const home = context.realpath(context.home);
  let best = -1;
  let owners: string[] = [];
  for (const session of context.sessions) {
    for (const folder of [session.cwd, ...(session.workDirs ?? [])]) {
      if (!folder) continue;
      // Trailing slashes off, or `/p/` would out-rank `/p` for the same folder.
      const root = context.realpath(folder).replace(/(.)\/+$/, "$1");
      if (root === home || root === "/" || !within(real, root)) continue;
      if (root.length > best) [best, owners] = [root.length, [session.sessionId]];
      else if (root.length === best) owners.push(session.sessionId);
    }
  }
  return owners;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The port of a page served from this Mac, when the surface is one. */
export function localhostPort(surface: ScreenSurface): number | undefined {
  if (surface.kind !== "url") return undefined;
  try {
    const url = new URL(surface.url);
    if (!LOOPBACK_HOSTS.has(url.hostname)) return undefined;
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

/** 1. conch put it there itself — the pill, the menu, its own window. Exact. */
const stagedResolver: ScreenResolver = {
  id: "staged",
  resolve(observation, context) {
    const surface = observation.surface;
    const named: ScreenObservation["staged"] = observation.staged
      ?? (surface.kind === "conch" ? { sessionId: surface.sessionId } : undefined);
    if (!named) return null;
    const { sessionId, reviewId } = named;
    const held = reviewId
      ? context.deliverables.find((each) => each.sessionId === sessionId && each.reviewId === reviewId)
      : undefined;
    // The published record's artifact when it has one, else what the pill opened.
    const artifact = held?.artifact ?? named.artifact ?? named.link ?? held?.link;
    return {
      sessionId,
      ...(reviewId ? { reviewId } : {}),
      ...(artifact ? { artifact } : {}),
      confidence: 1,
      reason: observation.staged ? "conch put it on screen" : "conch's own window shows it",
    };
  },
};

/** 2. The file or page is one a session published and still holds. */
const deliverableLinkResolver: ScreenResolver = {
  id: "deliverable-link",
  resolve(observation, context) {
    const surface = observation.surface;
    const path = observedPath(surface);
    const key = path ? linkKey(path, context) : surface.kind === "url" ? linkKey(surface.url, context) : undefined;
    if (!key) return null;
    const matches = context.deliverables.filter((held) => held.link && linkKey(held.link, context) === key);
    const found = oneOf(matches.map((held) => held.sessionId), 0.9, "a deliverable a session holds");
    if (!found?.sessionId) return found;
    // Held oldest first, so the last is the newest version of it.
    const held = matches[matches.length - 1]!;
    const artifact = held.artifact ?? held.link;
    return { ...found, ...(held.reviewId ? { reviewId: held.reviewId } : {}), ...(artifact ? { artifact } : {}) };
  },
};

/** 3. A terminal on a session's tty is that session. */
const terminalTtyResolver: ScreenResolver = {
  id: "terminal-tty",
  resolve(observation, context) {
    const surface = observation.surface;
    if (surface.kind !== "terminal" || !surface.tty) return null;
    const bare = (tty: string) => tty.replace(/^\/dev\//, "");
    const tty = bare(surface.tty);
    return oneOf(
      context.sessions.filter((session) => session.tty && bare(session.tty) === tty).map((session) => session.sessionId),
      0.8,
      `the session on ${tty}`,
    );
  },
};

/**
 * 4. A page served from this Mac, by who serves it. A session whose process is up the listener's
 * parent chain started that server, which is the stronger evidence: the nearest such session
 * wins, since one started inside another's tree is the more specific. Failing that, the
 * listener's working folder inside a session's folder, which only says where the server runs,
 * and two sessions in one repo share that.
 */
const localhostPortResolver: ScreenResolver = {
  id: "localhost-port",
  resolve(observation, context) {
    const port = localhostPort(observation.surface);
    if (port === undefined || !context.listeners?.length) return null;
    const sessionByPid = new Map(context.sessions.flatMap((session) => (session.pid ? [[session.pid, session.sessionId] as const] : [])));
    const starters = context.listeners.flatMap((listener) => {
      const owner = [listener.pid, ...listener.parents].find((pid) => sessionByPid.has(pid));
      return owner === undefined ? [] : [sessionByPid.get(owner)!];
    });
    if (starters.length) return oneOf(starters, 0.7, `the session that started the server on :${port}`);
    const runsIn = context.listeners.flatMap((listener) => (listener.cwd ? folderOwners(listener.cwd, context) : []));
    return oneOf(runsIn, 0.6, `the server on :${port} runs in the session's folder`);
  },
};

/** 5. A file inside a session's folder (`folderOwners`). */
const folderResolver: ScreenResolver = {
  id: "folder",
  resolve(observation, context) {
    const path = observedPath(observation.surface);
    return path ? oneOf(folderOwners(path, context), 0.5, "inside the session's folder") : null;
  },
};

/**
 * In order; the first to answer wins, so a stronger kind of evidence goes first. One slot waits:
 * "vision", last: a model's match of a screenshot to a held deliverable, carried on the
 * observation by its observer and trusted at the confidence the model gave.
 */
export const SCREEN_RESOLVERS: readonly ScreenResolver[] = [
  stagedResolver,
  deliverableLinkResolver,
  terminalTtyResolver,
  localhostPortResolver,
  folderResolver,
];

export function resolveScreen(
  observation: ScreenObservation,
  context: ScreenResolveContext,
  resolvers: readonly ScreenResolver[] = SCREEN_RESOLVERS,
): Showing {
  const base = { surface: observation.surface, source: observation.source, at: context.now };
  for (const resolver of resolvers) {
    const found = resolver.resolve(observation, context);
    if (found) return { ...found, reason: `${resolver.id}: ${found.reason}`, ...base };
  }
  return { confidence: 0, reason: "no resolver recognised it", ...base };
}

/** `showing` in the published state and `conch_on_screen`. */
export type PublishedShowing = Omit<Showing, "surface"> & { surface: ScreenSurface | { kind: ScreenSurface["kind"] } };

/**
 * The published copy. The published state reaches the paired phone, so a surface keeps its
 * path or URL only when it resolved to a session — something an agent put there. Anything
 * else on screen is none of the phone's business, and goes out as its kind alone.
 */
export function publishedShowing(showing: Showing): PublishedShowing {
  return showing.sessionId || showing.candidates ? showing : { ...showing, surface: { kind: showing.surface.kind } };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `probeCommand`'s shape: stdout, or null when the command failed or ran out of time. */
export type Probe = (argv: string[], ok: readonly number[], timeoutMs: number) => Promise<string | null>;

/**
 * Who listens on a localhost port: `lsof` for the listening pids, then, side by side, their
 * working folders and the process table for their parents. It is the one slow part of resolving,
 * so it happens before the resolvers run, not inside one.
 *
 * Cached per port for `ttlMs`: the front-window observer re-reports a page every few seconds, and
 * a server rarely changes hands faster than that. Each probe is on a `timeoutMs` leash; a slow or
 * failed one leaves its part unknown, and no listener at all names no one.
 */
export function portListenerLookup(options: { probe?: Probe; ttlMs?: number; timeoutMs?: number; now?: () => number } = {}): (port: number) => Promise<PortListener[]> {
  const { probe = probeCommand, ttlMs = 5_000, timeoutMs = 1_000, now = Date.now } = options;
  const cache = new Map<number, { at: number; listeners: Promise<PortListener[]> }>();
  const lookup = async (port: number): Promise<PortListener[]> => {
    // lsof exits 1 for "nothing matched", an answer rather than a failure.
    const listening = await probe(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], [0, 1], timeoutMs);
    const pids = [...new Set((listening ?? "").split("\n").flatMap((line) => (/^p\d+$/.test(line) ? [Number(line.slice(1))] : [])))];
    if (!pids.length) return [];
    const [folders, table] = await Promise.all([
      probe(["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], [0, 1], timeoutMs),
      probe(["ps", "-Ao", "pid=,ppid="], [0], timeoutMs),
    ]);
    const cwds = new Map<number, string>();
    let pid = 0;
    for (const line of (folders ?? "").split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n/")) cwds.set(pid, line.slice(1));
    }
    const parentOf = new Map<number, number>();
    for (const line of (table ?? "").split("\n")) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (child && parent) parentOf.set(child, parent);
    }
    return pids.map((listener) => {
      const parents: number[] = [];
      // Bounded, so a table read mid-fork can never walk in a circle.
      for (let up = parentOf.get(listener); up && up > 1 && parents.length < 64; up = parentOf.get(up)) parents.push(up);
      const cwd = cwds.get(listener);
      return { pid: listener, ...(cwd ? { cwd } : {}), parents };
    });
  };
  return (port) => {
    const cached = cache.get(port);
    if (cached && now() - cached.at < ttlMs) return cached.listeners;
    const listeners = lookup(port).catch(() => []);
    cache.set(port, { at: now(), listeners });
    return listeners;
  };
}

/** The published rows this module reads: the published state's, whatever else they carry. */
interface PublishedRowLike {
  id: string;
  cwd?: string;
  workDirs?: string[];
  review?: { id?: string; link?: string };
  reviews?: ReadonlyArray<{ id?: string; link?: string }>;
}

/** The daemon's context: its published rows (folders, held deliverables) and their pids. */
export function screenContextFromPublished(
  rows: readonly PublishedRowLike[],
  pidFor: (sessionId: string) => number | undefined,
  home: string,
  now = Date.now(),
  realpath: (path: string) => string = safeRealpath,
): ScreenResolveContext {
  return {
    // ponytail: no tty yet — nothing emits a terminal tty: the front-window observer sees Terminal
    // but not which tab, since only Terminal's AppleScript says. Fill this with one
    // `ps -o pid=,tty=` over these pids when an observer can.
    sessions: rows.map((row) => {
      const pid = pidFor(row.id);
      return { sessionId: row.id, ...(row.cwd ? { cwd: row.cwd } : {}), ...(row.workDirs ? { workDirs: row.workDirs } : {}), ...(pid ? { pid } : {}) };
    }),
    deliverables: rows.flatMap((row) => (row.reviews ?? (row.review ? [row.review] : [])).map((held) => {
      // Read defensively: the typed-deliverable record's `artifact` is optional and may not exist yet.
      const artifact = (held as { artifact?: unknown }).artifact;
      return {
        sessionId: row.id,
        ...(held.id ? { reviewId: held.id } : {}),
        ...(held.link ? { link: held.link } : {}),
        ...(typeof artifact === "string" && artifact ? { artifact } : {}),
      };
    })),
    now,
    home,
    realpath,
  };
}

/**
 * One line of the local screen log: what was showing, from `at` until `until`. For time tracking
 * ("seeing where my time is going per-project and activity type") and a later Atlas export, both
 * out of scope; conch only writes it. No surface location: `artifact` is the one path or URL kept,
 * because it says which deliverable, and none of it is ever sent anywhere.
 */
export interface ScreenLogEntry {
  sessionId?: string;
  artifact?: string;
  reviewId?: string;
  surfaceKind: ScreenSurface["kind"];
  /** The app's bundle id. */
  app?: string;
  projectCwd?: string;
  confidence: number;
}

export function screenLogEntry(showing: Showing, observation: ScreenObservation, context: ScreenResolveContext): ScreenLogEntry {
  const session = showing.sessionId ? context.sessions.find((each) => each.sessionId === showing.sessionId) : undefined;
  const projectCwd = session?.workDirs?.[0] ?? session?.cwd;
  return {
    ...(showing.sessionId ? { sessionId: showing.sessionId } : {}),
    ...(showing.artifact ? { artifact: showing.artifact } : {}),
    ...(showing.reviewId ? { reviewId: showing.reviewId } : {}),
    surfaceKind: showing.surface.kind,
    ...(observation.app ? { app: observation.app.bundleId } : {}),
    ...(projectCwd ? { projectCwd } : {}),
    confidence: showing.confidence,
  };
}

export interface ScreenLogOptions {
  /** `<config dir>/screen`. */
  dir: string;
  /** The `screen-log` setting, read live: off writes nothing and forgets what it was holding. */
  enabled(): boolean;
  /** How long a state must last to count; a passing glance does not. */
  dwellMs?: number;
  maxBytes?: number;
  maxAgeDays?: number;
  onError?(message: string): void;
}

const DAY_MS = 86_400_000;
const LOG_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/**
 * Append-only JSONL, one file per UTC day, 0600, pruned by age and then by total size.
 *
 * A state is written when it ENDS, with `at` and `until`, and only once it has lasted `dwellMs`;
 * a glance shorter than that is dropped and the state it interrupted carries on as one line.
 * Identical consecutive states are one state.
 *
 * ponytail: the open state lives in memory until the next change or `flush` (the daemon's
 * shutdown), so a SIGKILLed daemon loses it. Checkpoint it on a timer if the time tracking
 * ever needs that minute back.
 */
export class ScreenLog {
  #open?: { key: string; entry: ScreenLogEntry; since: number };
  #next?: { key: string; entry: ScreenLogEntry; since: number };

  constructor(private readonly options: ScreenLogOptions) {}

  record(entry: ScreenLogEntry, now: number): void {
    if (!this.#on()) return;
    this.#settle(now);
    const key = JSON.stringify(entry);
    // Back to what the glance interrupted: the glance is forgotten and the state goes on.
    if (key === this.#open?.key) {
      this.#next = undefined;
      return;
    }
    if (key === this.#next?.key) return;
    this.#next = { key, entry, since: now };
  }

  /** Write what is still open, as ending now. */
  flush(now: number): void {
    if (!this.#on()) return;
    this.#settle(now);
    if (this.#open) this.#write(this.#open, now);
    this.#open = undefined;
  }

  #on(): boolean {
    if (this.options.enabled()) return true;
    this.#open = this.#next = undefined;
    return false;
  }

  /** The newest state has outlasted a glance: the one before it ends where it began. */
  #settle(now: number): void {
    if (!this.#next || now - this.#next.since < (this.options.dwellMs ?? 2_000)) return;
    if (this.#open) this.#write(this.#open, this.#next.since);
    this.#open = this.#next;
    this.#next = undefined;
  }

  #write(state: { entry: ScreenLogEntry; since: number }, until: number): void {
    const { dir } = this.options;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${new Date(until).toISOString().slice(0, 10)}.jsonl`);
      appendFileSync(file, `${JSON.stringify({ v: 1, at: state.since, until, ...state.entry })}\n`, { mode: 0o600 });
      this.#prune(until, file);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    }
  }

  #prune(now: number, current: string): void {
    const { dir } = this.options;
    const oldest = now - (this.options.maxAgeDays ?? 30) * DAY_MS;
    let files = readdirSync(dir).filter((name) => LOG_FILE.test(name)).sort()
      .map((name) => ({ path: join(dir, name), day: Date.parse(name.slice(0, 10)) }));
    for (const file of files) if (file.day + DAY_MS <= oldest && file.path !== current) unlinkSync(file.path);
    files = files.filter((file) => file.day + DAY_MS > oldest || file.path === current);
    let total = files.reduce((sum, file) => sum + statSync(file.path).size, 0);
    // Oldest first, and never the file being written.
    for (const file of files) {
      if (total <= (this.options.maxBytes ?? 50 * 1024 * 1024) || file.path === current) break;
      total -= statSync(file.path).size;
      unlinkSync(file.path);
    }
  }
}

export interface ScreenContext {
  /**
   * Resolve one observation, keep it as what is showing, log it, publish it. A page on a localhost
   * port first waits for who listens there; anything observed meanwhile is newer, and wins.
   */
  observe(observation: ScreenObservation): Promise<Showing>;
  /** The latest, in its published form; undefined until something has been observed. */
  showing(): PublishedShowing | undefined;
  /** Stop the daemon's own observers and close the log's open state. */
  close(now?: number): void;
}

export function createScreenContext(options: {
  context(): ScreenResolveContext;
  /** Who listens on a localhost port (`portListenerLookup`); without it a port names no one. */
  listeners?(port: number): Promise<readonly PortListener[]>;
  onShowing?(showing: PublishedShowing): void;
  log?: ScreenLog;
  resolvers?: readonly ScreenResolver[];
  observers?: readonly ScreenObserver[];
}): ScreenContext {
  let latest: PublishedShowing | undefined;
  let observed = 0;
  const observe = async (observation: ScreenObservation): Promise<Showing> => {
    const turn = ++observed;
    // conch's own staging already says whose it is: no port to look up.
    const port = observation.staged ? undefined : localhostPort(observation.surface);
    // Only a page on a port waits; everything else resolves before this returns.
    const listeners = port !== undefined && options.listeners ? await options.listeners(port) : undefined;
    const context = listeners ? { ...options.context(), listeners } : options.context();
    const resolved = resolveScreen(observation, context, options.resolvers);
    // Something newer was observed while this waited on its port: that is what is showing.
    if (turn !== observed) return resolved;
    latest = publishedShowing(resolved);
    options.log?.record(screenLogEntry(resolved, observation, context), context.now);
    options.onShowing?.(latest);
    return resolved;
  };
  const stops = (options.observers ?? SCREEN_OBSERVERS).flatMap((observer) => observer.start ? [observer.start(observe)] : []);
  return {
    observe,
    showing: () => latest,
    close(now = Date.now()) {
      for (const stop of stops) stop();
      options.log?.flush(now);
    },
  };
}

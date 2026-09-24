import { connect } from "node:net";
import { ControlFrameError, ControlFrameReader, decodeControlText, encodeControlFrame, readControlBody } from "./control-framing.ts";
import { validateHistoryRequest } from "./history.ts";
import type { UploadChunk, UploadResult } from "./phone-uploads.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { conchHome } from "./home.ts";
import { checkLocalFile } from "./snippet.ts";

/**
 * The phone's transport into conch.
 *
 * The daemon's real protocol lives on a Unix socket a phone cannot reach, so
 * this bridge exposes the phone UI's scoped state, reply, file, websocket, and
 * control endpoints over the LAN. Control messages are forwarded onto the
 * local socket, so they pass through the daemon's own validation and pause
 * lifecycle rather than a second implementation.
 *
 * Security posture: OFF by default and intended only for a trusted LAN. The
 * bridge is plaintext HTTP/ws: there is no transport encryption, and the
 * websocket plus /file carry the bearer token in their query strings because
 * those iOS loaders cannot attach the Authorization header uniformly. Other
 * HTTP routes require the header. The token file is 0600 and never logged.
 */

export const PHONE_BRIDGE_DEFAULT_PORT = 8674;

/**
 * A short pairing code, exchanged once for the real token.
 *
 * The token is 32 hex characters because it guards session transcripts — and
 * 32 hex characters typed on a phone keyboard is a UX failure, not a security
 * feature. So the strong secret never gets typed: a 6-digit code, alive for two
 * minutes, single-use, five attempts, buys it. Entropy lives in the WINDOW, not
 * the string, which is how every device-pairing flow worth copying works.
 */
export interface PairingCode {
  code: string;
  expiresAt: number;
}

const PAIRING_CODE_TTL_MS = 120_000;
const PAIRING_CODE_ATTEMPTS = 5;
export const PAIRING_BODY_MAX_BYTES = 1024;

export function mintPairingCode(now = Date.now()): PairingCode {
  // Rejection-sampled so every code is equally likely; a modulo bias here would
  // shrink the space a guesser has to cover.
  let value: number;
  do {
    value = randomBytes(4).readUInt32BE(0);
  } while (value >= 4_294_000_000);
  return {
    code: String(value % 1_000_000).padStart(6, "0"),
    expiresAt: now + PAIRING_CODE_TTL_MS,
  };
}

export interface PhoneBridgeDependencies {
  /** Latest published state, exactly as written to the sessions file. */
  getState(): unknown;
  /** Forward one control line to the daemon's Unix socket; resolve its reply. */
  forwardControl(line: string): Promise<string>;
  /** Latest assistant reply for ANY session, raw markdown, read on demand. */
  replyFor(sessionId: string): Promise<string>;
  /** Connected phone count, so the daemon can reclaim audio when it hits zero. */
  onClientsChanged?(count: number): void;
  /** Take one piece of an image; resolves a path once the last piece lands. */
  acceptUpload(chunk: UploadChunk): Promise<UploadResult | { error: string }>;
  /** Where `acceptUpload` writes, so `/file` can show the phone its own pictures back. */
  uploadsDirectory?: string;
  log(message: string): void;
}

export interface PhoneBridgeHandle {
  port: number;
  /** Open a two-minute window in which this code exchanges for the token. */
  offerPairingCode(code: PairingCode): void;
  stop(): void;
  /** Push the freshly published state to every connected phone. */
  publish(): void;
  /** Live websocket count — an audio claim is only valid while this is > 0. */
  clientCount(): number;
}

/**
 * A frame with its timestamp flattened, for comparing one publish to the last.
 * `ts` moves on every publish by definition and would defeat the comparison on
 * its own; everything else differing means something a viewer can see has moved.
 */
function normalisedFrame(frame: string): string {
  return frame.replace(/"ts":\s*\d+/, '"ts":0');
}

/** One downstream state consumer, whether a Bun websocket or a relay stream. */
export interface PhoneStateSink {
  send(data: string): number;
}

/**
 * `/ws` is the route's one transport-specific operation. LAN upgrades the Bun
 * request and subscribes from `websocket.open`; a relay can subscribe its
 * logical stream immediately. The route still owns auth and pathname routing.
 */
export interface PhoneRequestContext {
  /** Relay pairings use their own bearer without rotating legacy LAN tokens. */
  expectedToken?: string;
  upgradeState?(
    request: Request,
    subscribe: (sink: PhoneStateSink) => void,
  ): boolean;
}

export type PhoneRequestResult = Response | Promise<Response> | undefined;

function historyRequest(pathname: string, value: unknown): ReturnType<typeof validateHistoryRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, err: "history request must be an object" };
  const body = value as Record<string, unknown>;
  const kind = pathname === "/history/page" ? "history-page" : "history-item";
  if (body.kind !== undefined && body.kind !== kind) return { ok: false, err: "history request kind does not match route" };
  return validateHistoryRequest({ ...body, kind });
}

/** Only reads that the shared router will dispatch may skip mutation retry reservations. */
export function isPhoneHistoryRead(path: string, bytes: Uint8Array): boolean {
  try {
    const pathname = new URL(path, "https://conch.invalid").pathname;
    if (pathname !== "/history/page" && pathname !== "/history/item" && pathname !== "/control") return false;
    const text = decodeControlText(bytes);
    encodeControlFrame(text);
    let value = JSON.parse(text);
    if (pathname !== "/control") return historyRequest(pathname, value).ok;
    if (value?.kind === "control-envelope") value = value.body;
    return validateHistoryRequest(value).ok;
  } catch { return false; }
}

/** Bun reports a connection-dropped frame with 0; backpressure (-1) is alive. */
export function sendPhoneFrame(
  socket: { send(data: string): number },
  frame: string,
): boolean {
  try {
    return socket.send(frame) !== 0;
  } catch {
    return false;
  }
}

export function phoneTokenPath(home: string = conchHome()): string {
  return join(home, ".config", "conch", "phone-token");
}

/** Read the pairing token, minting it on first use. */
export function ensurePhoneToken(path: string = phoneTokenPath()): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 24) return existing;
  }
  // 16 random bytes as hex: short enough to type once, far past guessable.
  const token = randomBytes(16).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`);
  chmodSync(path, 0o600);
  return token;
}

/** Constant-time comparison; length differences fail without early exit. */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so a length probe times the same as a mismatch.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function presentedToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  // URLSession's websocket and media loaders cannot attach headers uniformly.
  // Keep the query credential confined to the two routes that require it.
  const url = new URL(req.url);
  return url.pathname === "/ws" || url.pathname === "/file"
    ? url.searchParams.get("token")
    : null;
}


type PairingRedemption =
  | { kind: "token" }
  | { kind: "wrong" }
  | { kind: "closed" }
  | { kind: "exhausted" };

/**
 * Synchronous pairing state machine. Request bodies are read before entering
 * it, then each redemption runs without an await, so Bun's event loop cannot
 * interleave the attempt check with its increment/clear.
 */
export class PairingWindow {
  #offered: PairingCode | null = null;
  #attempts = 0;

  offer(code: PairingCode): void {
    this.#offered = code;
    this.#attempts = 0;
  }

  redeem(submitted: string, now = Date.now()): PairingRedemption {
    const offered = this.#offered;
    if (!offered || now > offered.expiresAt) {
      this.#offered = null;
      this.#attempts = 0;
      return { kind: "closed" };
    }
    if (this.#attempts >= PAIRING_CODE_ATTEMPTS) {
      this.#offered = null;
      this.#attempts = 0;
      return { kind: "exhausted" };
    }
    if (!tokenMatches(submitted, offered.code)) {
      this.#attempts += 1;
      return { kind: "wrong" };
    }
    this.#offered = null;
    this.#attempts = 0;
    return { kind: "token" };
  }
}

type LimitedPairingBody =
  | { ok: true; code: string }
  | { ok: false; tooLarge: boolean };

/** Buffer at most the pairing cap, including for chunked requests. */
export async function readPairingBody(
  req: Request,
  maxBytes = PAIRING_BODY_MAX_BYTES,
): Promise<LimitedPairingBody> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, tooLarge: true };
  }

  const reader = req.body?.getReader();
  if (!reader) return { ok: true, code: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { code?: unknown };
    return { ok: true, code: String(parsed.code ?? "") };
  } catch {
    return { ok: true, code: "" };
  }
}

/**
 * The phone-facing application protocol, independent of how requests arrive.
 *
 * Both the LAN server and the internet relay drive this exact Request handler,
 * so authentication, current-session scoping, body limits, and error semantics
 * cannot drift between transports. State subscribers are aggregated here for
 * the same reason: the daemon's audio lease cares whether ANY phone is alive.
 */
export class PhoneBridgeApplication {
  readonly #dependencies: PhoneBridgeDependencies;
  readonly #token: string;
  readonly #pairing = new PairingWindow();
  readonly #stateSinks = new Map<PhoneStateSink, "phone" | "observer">();

  constructor(dependencies: PhoneBridgeDependencies, options: { token: string }) {
    this.#dependencies = dependencies;
    this.#token = options.token;
  }

  offerPairingCode(code: PairingCode): void {
    this.#pairing.offer(code);
  }

  /** Register a successfully authenticated state stream and send its snapshot. */
  subscribeState(sink: PhoneStateSink, role: "phone" | "observer" = "phone"): void {
    const previousCount = this.clientCount();
    this.#stateSinks.set(sink, role);
    if (this.clientCount() !== previousCount) {
      this.#dependencies.onClientsChanged?.(this.clientCount());
    }
    const state = this.#dependencies.getState();
    if (!state) return;
    const frame = JSON.stringify(state);
    // Only the first subscriber has now seen this snapshot. A joining observer
    // must not consume a pending update meant for the existing subscribers.
    if (this.#stateSinks.size === 1) this.#lastPublishedFrame = normalisedFrame(frame);
    if (!sendPhoneFrame(sink, frame)) {
      this.unsubscribeState(sink);
    }
  }

  unsubscribeState(sink: PhoneStateSink): void {
    const previousCount = this.clientCount();
    if (!this.#stateSinks.delete(sink)) return;
    if (this.clientCount() !== previousCount) {
      this.#dependencies.onClientsChanged?.(this.clientCount());
    }
  }

  /** Audio presence counts phones only; observers still receive every frame. */
  clientCount(): number {
    return [...this.#stateSinks.values()].filter((role) => role === "phone").length;
  }

  #lastPublishedFrame = "";

  publish(): void {
    if (this.#stateSinks.size === 0) return;
    const state = this.#dependencies.getState();
    if (!state) return;
    const frame = JSON.stringify(state);
    // Don't send a frame that says exactly what the last one said.
    //
    // The phone decodes every frame as a COMPLETE state on the main actor and
    // republishes it, which invalidates the whole view tree and rebuilds every
    // markdown body in the visible conversation. A Codex audit measured the
    // live snapshot at ~112KB across six conversations, publishable at up to
    // 10Hz — so a redundant frame is not free, it is a full re-render of a
    // busy screen for no new information.
    //
    // Only the timestamp is normalised before comparing: it changes on every
    // publish by definition and would defeat the check on its own, while
    // everything else differing means something a viewer can actually see has
    // moved.
    const comparable = normalisedFrame(frame);
    if (comparable === this.#lastPublishedFrame) return;
    this.#lastPublishedFrame = comparable;
    const previousCount = this.clientCount();
    for (const sink of this.#stateSinks.keys()) {
      // A sink that cannot be written to is gone; keeping it in the set makes
      // the audio lease look alive forever.
      if (!sendPhoneFrame(sink, frame)) {
        this.#stateSinks.delete(sink);
      }
    }
    if (this.clientCount() !== previousCount) {
      this.#dependencies.onClientsChanged?.(this.clientCount());
    }
  }

  handle(req: Request, context: PhoneRequestContext = {}): PhoneRequestResult {
    const url = new URL(req.url);

    // The one unauthenticated route. Its exposure is bounded — not made safe
    // for hostile networks — by a two-minute, single-use, five-guess window.
    if (url.pathname === "/pair" && req.method === "POST") {
      return (async () => {
        const body = await readPairingBody(req);
        if (!body.ok) {
          return Response.json(
            { error: "Pairing request is too large." },
            { status: 413 },
          );
        }
        const result = this.#pairing.redeem(body.code);
        if (result.kind === "closed") {
          return Response.json(
            { error: "No pairing window open — run `conch pair` on the Mac." },
            { status: 403 },
          );
        }
        if (result.kind === "exhausted") {
          return Response.json(
            { error: "Too many attempts — run `conch pair` again." },
            { status: 429 },
          );
        }
        if (result.kind === "wrong") {
          return Response.json({ error: "That code didn't match." }, { status: 401 });
        }
        this.#dependencies.log("phone paired");
        return Response.json({ token: this.#token });
      })();
    }

    if (!tokenMatches(presentedToken(req), context.expectedToken ?? this.#token)) {
      return new Response("unauthorized", { status: 401 });
    }

    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role") ?? "phone";
      if (role !== "phone" && role !== "observer") {
        return new Response("unknown subscriber role", { status: 400 });
      }
      const upgraded = context.upgradeState?.(
        req,
        (sink) => this.subscribeState(sink, role),
      ) ?? false;
      return upgraded
        ? undefined
        : new Response("upgrade required", { status: 426 });
    }

    if (url.pathname === "/state") {
      // Older bridges ignore the role query. A Mac must poll those bridges,
      // never open a socket that could accidentally sustain phone presence.
      return Response.json(this.#dependencies.getState() ?? { v: 0 }, {
        headers: { "X-Conch-Observer": "1" },
      });
    }

    // Published state carries ONE reply — whichever session last finished a
    // turn — so every other session looked empty on the phone, and a daemon
    // restart made them all look empty. The Mac app never had this problem
    // because it reads the transcript itself; the phone can't, so it asks.
    if (url.pathname === "/reply") {
      const sessionId = url.searchParams.get("session") ?? "";
      if (!sessionId) return new Response("session required", { status: 400 });
      const known = (this.#dependencies.getState() as { rows?: Array<{ id?: string }> } | null)
        ?.rows?.some((row) => row.id === sessionId);
      if (!known) return new Response("unknown session", { status: 404 });
      return (async () => Response.json({
        markdown: await this.#dependencies.replyFor(sessionId),
      }))();
    }

    if (url.pathname === "/file") {
      // Serve a LOCAL deliverable or inline material to the phone — only a path
      // the current published state names, or a web asset beside a published
      // page, and only what passes the publish rule on the disk as it is now
      // (`servableFile`). Never arbitrary file access.
      const requested = url.searchParams.get("path") ?? "";
      return (async () => {
        const served = await servableFile(requested, this.#dependencies.getState() as ServableState | null,
          this.#dependencies.uploadsDirectory);
        return served.ok ? new Response(Bun.file(served.real)) : new Response(served.reason, { status: served.status });
      })();
    }

    // Images arrive in pieces: a relay frame caps at 192 KiB and base64 adds a
    // third. The phone has already sized them to what the model actually uses.
    if (url.pathname === "/image" && req.method === "POST") {
      // `handle` is synchronous and returns a promise where it needs one, so
      // the awaiting lives in here rather than changing every caller.
      return (async () => {
        let payload: any;
        try {
          payload = await req.json();
        } catch {
          return Response.json({ error: "bad request" }, { status: 400 });
        }
        const result = await this.#dependencies.acceptUpload({
          uploadId: String(payload?.uploadId ?? ""),
          index: Number(payload?.index),
          total: Number(payload?.total),
          extension: String(payload?.extension ?? ""),
          data: String(payload?.data ?? ""),
        });
        if ("error" in result) return Response.json(result, { status: 400 });
        return Response.json(result);
      })();
    }

    const historyRoute = url.pathname === "/history/page" || url.pathname === "/history/item";
    if ((url.pathname === "/control" || historyRoute) && req.method === "POST") {
      return (async () => {
        let body: string;
        try { body = await readControlBody(req); }
        catch (error) {
          if (historyRoute) return Response.json({ kind: "history-error",
            code: error instanceof ControlFrameError && error.code === "frame-too-large" ? "frame-too-large" : "invalid-request",
            error: "invalid history request body" },
          { status: error instanceof ControlFrameError && error.code === "frame-too-large" ? 413 : 400 });
          return Response.json({ error: error instanceof Error ? error.message : "bad control body" },
            { status: error instanceof ControlFrameError && error.code === "frame-too-large" ? 413 : 400 });
        }
        if (historyRoute) {
          const validated = historyRequest(url.pathname, JSON.parse(body));
          if (!validated.ok) return Response.json({ kind: "history-error", code: "invalid-request", error: validated.err }, { status: 400 });
          body = JSON.stringify(validated.value);
          try { encodeControlFrame(body); }
          catch { return Response.json({ kind: "history-error", code: "frame-too-large", error: "history request exceeds 64 KiB" }, { status: 413 }); }
        }
        const historyRead = historyRoute || isPhoneHistoryRead(url.pathname, Buffer.from(body));
        try {
          const reply = await this.#dependencies.forwardControl(body);
          if (historyRead) encodeControlFrame(reply);
          // Say that the PHONE did this. Controls from every surface arrive on
          // one socket, so when conch "unpaused itself" there was no way to
          // tell a tap on the phone from a click on the Mac from a stray key
          // in the terminal — the question could only be answered by guessing.
          // Injects are logged in full elsewhere and would only be noise here.
          try {
            const parsed = JSON.parse(body);
            const kind = String(parsed?.type ?? parsed?.kind ?? "");
            if (
              !historyRead && kind && kind !== "inject" && kind !== "phone-speaking"
              && kind !== "phone-device"
            ) {
              this.#dependencies.log(
                `phone → ${kind}${parsed?.label ? ` "${parsed.label}"` : ""}`,
              );
            }
          } catch {}
          return new Response(reply, {
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          if (historyRead) {
            return Response.json({ kind: "history-error", code: error instanceof ControlFrameError && error.code === "frame-too-large" ? "response-too-large" : "unavailable",
              error: "history response unavailable" }, { status: 502 });
          }
          // Name the control and the target. "phone control failed" alone could
          // not distinguish a lost message from a routine status poll giving
          // up, so a scary line appeared next to sends that had worked while
          // the one that actually failed looked identical.
          let what = "control";
          try {
            const parsed = JSON.parse(body);
            const kind = parsed?.type ?? parsed?.kind ?? "control";
            what = parsed?.label ? `${kind} -> "${parsed.label}"` : String(kind);
          } catch {}
          this.#dependencies.log(`phone ${what} failed: ${String(error)}`);
          return new Response("daemon unreachable", { status: 502 });
        }
      })();
    }

    return new Response("not found", { status: 404 });
  }
}

/** The parts of the published state `/file` decides by. */
interface ServableState {
  rows?: Array<{
    id?: string;
    cwd?: string;
    workDirs?: string[];
    review?: { link?: string };
    reviews?: Array<{ link?: string }>;
  }>;
  conversations?: Record<string, { items?: Array<{ material?: { path?: string } }> }>;
}

/**
 * What a published page or document loads from its own folder: styles, scripts, data, pictures,
 * fonts, media. Tyler: "a huge improvement would be having all content viewable and interative on
 * phone app". A page that arrived without these rendered unstyled and imageless, or not at all.
 */
const WEB_ASSET = /\.(css|js|mjs|json|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|wasm)$/i;
/** A deliverable whose folder is read with it: a page, or a document with pictures beside it. */
const READS_ITS_FOLDER = /\.(html?|md|markdown)$/i;

/**
 * A folder too broad to open up because a deliverable happens to sit in it: the temp roots, which
 * every process writes into, and the home folder or anything above it. There only the deliverable
 * itself is served.
 */
async function neverWidened(folder: string): Promise<boolean> {
  const [temps, homes] = await Promise.all([
    Promise.all(["/tmp", tmpdir()].map((root) => realpath(root).catch(() => root))),
    Promise.all([homedir(), conchHome()].map((root) => realpath(root).catch(() => root))),
  ]);
  return folder === "/" || temps.includes(folder) || homes.some((home) => home === folder || home.startsWith(`${folder}/`));
}

/**
 * A picture the phone itself sent. conch named and wrote it (`phone-uploads.ts`) in its own cache,
 * a hidden folder the publish rule refuses, so under that rule alone every picture Tyler sends from
 * the phone would vanish from his own side of the conversation.
 */
async function ownUpload(requested: string, uploads: string): Promise<string | null> {
  const [real, folder] = await Promise.all([realpath(requested).catch(() => null), realpath(uploads).catch(() => null)]);
  if (!real || !folder || dirname(real) !== folder) return null;
  const file = await stat(real).catch(() => null);
  return file?.isFile() && (file.mode & 0o111) === 0 ? real : null;
}

/**
 * Whether `/file` may serve `requested`, decided against the state and the disk as they are NOW, so
 * a delayed relay frame or a file swapped for a symlink since publishing gains nothing. It may when
 * it is:
 * - a deliverable a session still holds: the newest, or any before it (`rows[].reviews`). Only the
 *   newest used to be served, so tapping an earlier one on the phone answered 403;
 * - a file on its own line in a conversation (`material.path`), which used to be served with no
 *   rule at all: any absolute image, PDF or text path an agent wrote became readable;
 * - a web asset under the folder of a held page or markdown document, which is what lets a page
 *   bring its styles and pictures (`WEB_ASSET`, never at a `neverWidened` folder).
 * Every one of them then passes `checkLocalFile`, the rule a session publishes under, against
 * that session's own folders, and is served at the real path that rule checked.
 */
async function servableFile(
  requested: string,
  state: ServableState | null,
  uploads?: string,
): Promise<{ ok: true; real: string } | { ok: false; status: 403 | 404; reason: string }> {
  const refused = { ok: false, status: 403, reason: "not a file conch is publishing" } as const;
  if (!requested.startsWith("/") || requested.includes("\0")) return refused;
  const rows = state?.rows ?? [];
  const rootsOf = (row: (typeof rows)[number] | undefined): string[] =>
    [row?.cwd, ...(row?.workDirs ?? [])].filter((root): root is string => typeof root === "string" && root.startsWith("/"));
  const heldLinks = (row: (typeof rows)[number]): string[] =>
    [...(row.reviews ?? []), ...(row.review ? [row.review] : [])]
      .map((held) => held.link)
      .filter((link): link is string => typeof link === "string" && link.startsWith("/"));
  const check = async (roots: string[]) => {
    const checked = await checkLocalFile(requested, roots);
    if (checked.ok) return checked;
    // Named by the state but not on the disk: gone, which the phone says differently from refused.
    return await realpath(requested).catch(() => null)
      ? { ok: false, status: 403, reason: checked.reason } as const
      : { ok: false, status: 404, reason: "gone" } as const;
  };

  for (const row of rows) {
    if (heldLinks(row).includes(requested)) return check(rootsOf(row));
  }
  for (const [sessionId, conversation] of Object.entries(state?.conversations ?? {})) {
    if (!conversation.items?.some((item) => item.material?.path === requested)) continue;
    const upload = uploads ? await ownUpload(requested, uploads) : null;
    if (upload) return { ok: true, real: upload };
    return check(rootsOf(rows.find((row) => row.id === sessionId)));
  }
  if (!WEB_ASSET.test(requested)) return refused;
  for (const row of rows) {
    const folders: string[] = [];
    for (const link of heldLinks(row).filter((link) => READS_ITS_FOLDER.test(link))) {
      // The folder the page is in as a browser sees it, symlinks resolved.
      const folder = await realpath(dirname(link)).catch(() => null);
      if (folder && !await neverWidened(folder)) folders.push(folder);
    }
    if (!folders.length) continue;
    const checked = await checkLocalFile(requested, rootsOf(row));
    if (checked.ok && folders.some((folder) => checked.real.startsWith(`${folder}/`))) return checked;
  }
  return refused;
}

export function createPhoneBridgeApplication(
  dependencies: PhoneBridgeDependencies,
  options: { token: string },
): PhoneBridgeApplication {
  return new PhoneBridgeApplication(dependencies, options);
}

/**
 * LAN transport adapter. A later relay adapter can share the same application
 * and add logical state sinks without copying one pathname or authorization
 * rule from `PhoneBridgeApplication.handle`.
 */
export function createPhoneBridgeServer(
  application: PhoneBridgeApplication,
  dependencies: Pick<PhoneBridgeDependencies, "log">,
  options: { port?: number; hostname?: string },
): PhoneBridgeHandle {
  const port = options.port ?? PHONE_BRIDGE_DEFAULT_PORT;
  const lanSockets = new Set<PhoneStateSink>();

  const server = Bun.serve<{ subscribe: (sink: PhoneStateSink) => void }>({
    port,
    hostname: options.hostname ?? "0.0.0.0",
    fetch(req, srv) {
      return application.handle(req, {
        upgradeState: (request, subscribe) => srv.upgrade(request, { data: { subscribe } }),
      });
    },
    websocket: {
      open(ws) {
        lanSockets.add(ws);
        ws.data.subscribe(ws);
      },
      close(ws) {
        lanSockets.delete(ws);
        application.unsubscribeState(ws);
      },
      message() {
        // Phones send controls over POST /control so every message shares one
        // authenticated, size-capped path. The socket is downstream-only.
      },
    },
  });

  dependencies.log(`phone bridge listening on ${server.hostname}:${server.port}`);

  return {
    port: server.port ?? port,
    offerPairingCode(code) {
      application.offerPairingCode(code);
    },
    stop() {
      server.stop(true);
      for (const socket of lanSockets) application.unsubscribeState(socket);
      lanSockets.clear();
    },
    clientCount() {
      return application.clientCount();
    },
    publish() {
      application.publish();
    },
  };
}

export function createPhoneBridge(
  dependencies: PhoneBridgeDependencies,
  options: { port?: number; token: string; hostname?: string } ,
): PhoneBridgeHandle {
  const application = createPhoneBridgeApplication(dependencies, { token: options.token });
  return createPhoneBridgeServer(application, dependencies, options);
}

/** Dial the daemon's own Unix socket and relay one line — reply or timeout. */
export function forwardToDaemonSocket(
  socketPath: string,
  line: string,
  timeoutMs = 4000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let request: Buffer;
    try { request = encodeControlFrame(line); } catch (error) { reject(error); return; }
    const socket = connect({ path: socketPath });
    const frame = new ControlFrameReader();
    let settled = false;
    const finish = (error?: unknown, reply?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(reply!);
    };
    const timer = setTimeout(() => finish(new Error("daemon reply timed out")), timeoutMs);
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      if (settled) return;
      try {
        const reply = frame.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        if (reply !== undefined) {
          try { JSON.parse(reply); } catch { throw new ControlFrameError("invalid-json", "daemon reply is not valid JSON"); }
          finish(undefined, reply);
        }
      } catch (error) { finish(error); }
    });
    socket.once("end", () => { if (!settled) { try { frame.end(); } catch (error) { finish(error); } } });
    socket.once("close", () => { if (!settled) finish(new Error("daemon closed without a complete reply")); });
    socket.once("error", (error) => finish(error));
  });
}

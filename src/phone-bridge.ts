import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

export function phoneTokenPath(home: string = homedir()): string {
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

const CONTROL_MAX_BYTES = 64 * 1024; // mirrors the Unix socket's frame cap

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
  readonly #stateSinks = new Set<PhoneStateSink>();

  constructor(dependencies: PhoneBridgeDependencies, options: { token: string }) {
    this.#dependencies = dependencies;
    this.#token = options.token;
  }

  offerPairingCode(code: PairingCode): void {
    this.#pairing.offer(code);
  }

  /** Register a successfully authenticated state stream and send its snapshot. */
  subscribeState(sink: PhoneStateSink): void {
    const previousCount = this.#stateSinks.size;
    this.#stateSinks.add(sink);
    if (this.#stateSinks.size !== previousCount) {
      this.#dependencies.onClientsChanged?.(this.#stateSinks.size);
    }
    const state = this.#dependencies.getState();
    if (state && !sendPhoneFrame(sink, JSON.stringify(state))) {
      this.unsubscribeState(sink);
    }
  }

  unsubscribeState(sink: PhoneStateSink): void {
    if (!this.#stateSinks.delete(sink)) return;
    this.#dependencies.onClientsChanged?.(this.#stateSinks.size);
  }

  clientCount(): number {
    return this.#stateSinks.size;
  }

  publish(): void {
    if (this.#stateSinks.size === 0) return;
    const state = this.#dependencies.getState();
    if (!state) return;
    const frame = JSON.stringify(state);
    let changed = false;
    for (const sink of this.#stateSinks) {
      // A sink that cannot be written to is gone; keeping it in the set makes
      // the audio lease look alive forever.
      if (!sendPhoneFrame(sink, frame)) {
        this.#stateSinks.delete(sink);
        changed = true;
      }
    }
    if (changed) this.#dependencies.onClientsChanged?.(this.#stateSinks.size);
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
      const upgraded = context.upgradeState?.(
        req,
        (sink) => this.subscribeState(sink),
      ) ?? false;
      return upgraded
        ? undefined
        : new Response("upgrade required", { status: 426 });
    }

    if (url.pathname === "/state") {
      return Response.json(this.#dependencies.getState() ?? { v: 0 });
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
      // Serve a LOCAL deliverable to the phone — but only a file that is,
      // right now, a review link in the published state. That constraint is
      // the whole security story: the token holder can see what the
      // dashboard is currently showing, never read arbitrary files.
      const requested = url.searchParams.get("path") ?? "";
      const state = this.#dependencies.getState() as
        | { rows?: Array<{ review?: { link?: string } }> }
        | null;
      const links = (state?.rows ?? [])
        .map((row) => row.review?.link)
        .filter((link): link is string => Boolean(link));
      if (!requested || !links.includes(requested)) {
        return new Response("not a current deliverable", { status: 403 });
      }
      const file = Bun.file(requested);
      return (async () => (await file.exists())
        ? new Response(file)
        : new Response("gone", { status: 404 }))();
    }

    if (url.pathname === "/control" && req.method === "POST") {
      return (async () => {
        const body = await req.text();
        if (body.length > CONTROL_MAX_BYTES) {
          return new Response("too large", { status: 413 });
        }
        try {
          const reply = await this.#dependencies.forwardControl(body);
          return new Response(reply, {
            headers: { "content-type": "application/json" },
          });
        } catch (error) {
          this.#dependencies.log(`phone control failed: ${String(error)}`);
          return new Response("daemon unreachable", { status: 502 });
        }
      })();
    }

    return new Response("not found", { status: 404 });
  }
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

  const server = Bun.serve({
    port,
    hostname: options.hostname ?? "0.0.0.0",
    fetch(req, srv) {
      return application.handle(req, {
        upgradeState: (request) => srv.upgrade(request),
      });
    },
    websocket: {
      open(ws) {
        lanSockets.add(ws);
        application.subscribeState(ws);
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
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("daemon reply timed out"))),
      timeoutMs,
    );
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write(line.endsWith("\n") ? line : `${line}\n`);
        },
        data(sock, chunk) {
          buffer += chunk.toString();
          if (buffer.includes("\n")) {
            finish(() => resolve(buffer.split("\n", 1)[0] ?? ""));
            sock.end();
          }
        },
        close() {
          finish(() => resolve(buffer.trim()));
        },
        error(_sock, error) {
          finish(() => reject(error));
        },
      },
    }).catch((error) => finish(() => reject(error)));
  });
}

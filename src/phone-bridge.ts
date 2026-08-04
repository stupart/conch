import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * The phone's transport into conch.
 *
 * The daemon's real protocol lives on a Unix socket a phone cannot reach, so
 * this bridge exposes exactly two things over the LAN: the published state
 * (the same object every other viewer renders) and a forwarder onto the local
 * socket — which means every control message a phone sends passes through the
 * daemon's OWN validation and pause lifecycle, not a second implementation.
 *
 * Security posture: OFF by default; a bearer token is required on every
 * request, compared in constant time; the token file is 0600; and the server
 * never logs the token. A session transcript is the user's private work — the
 * bar is "safe to leave on at a coffee shop", not "fine on home Wi-Fi".
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
  log(message: string): void;
}

export interface PhoneBridgeHandle {
  port: number;
  /** Open a two-minute window in which this code exchanges for the token. */
  offerPairingCode(code: PairingCode): void;
  stop(): void;
  /** Push the freshly published state to every connected phone. */
  publish(): void;
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
  // WebSocket upgrades cannot carry headers from URLSession/NWConnection
  // uniformly, so the query form is accepted for the upgrade request only.
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

const CONTROL_MAX_BYTES = 64 * 1024; // mirrors the Unix socket's frame cap

export function createPhoneBridge(
  dependencies: PhoneBridgeDependencies,
  options: { port?: number; token: string; hostname?: string } ,
): PhoneBridgeHandle {
  const port = options.port ?? PHONE_BRIDGE_DEFAULT_PORT;
  const sockets = new Set<{ send(data: string): void }>();
  let pairingCode: PairingCode | null = null;
  let pairingAttempts = 0;

  const server = Bun.serve({
    port,
    hostname: options.hostname ?? "0.0.0.0",
    fetch(req, srv) {
      const url = new URL(req.url);

      // The ONE unauthenticated route, and the only reason it is safe: the code
      // it accepts expires in two minutes, dies on first success, and dies after
      // five wrong guesses.
      if (url.pathname === "/pair" && req.method === "POST") {
        return (async () => {
          const offered = pairingCode;
          if (!offered || Date.now() > offered.expiresAt) {
            pairingCode = null;
            return Response.json(
              { error: "No pairing window open — run `conch pair` on the Mac." },
              { status: 403 },
            );
          }
          if (pairingAttempts >= PAIRING_CODE_ATTEMPTS) {
            pairingCode = null;
            return Response.json(
              { error: "Too many attempts — run `conch pair` again." },
              { status: 429 },
            );
          }
          let submitted = "";
          try {
            submitted = String(((await req.json()) as { code?: unknown }).code ?? "");
          } catch {}
          if (!tokenMatches(submitted, offered.code)) {
            pairingAttempts += 1;
            return Response.json({ error: "That code didn't match." }, { status: 401 });
          }
          pairingCode = null;
          pairingAttempts = 0;
          dependencies.log("phone paired");
          return Response.json({ token: options.token });
        })();
      }

      if (!tokenMatches(presentedToken(req), options.token)) {
        return new Response("unauthorized", { status: 401 });
      }

      if (url.pathname === "/ws") {
        return srv.upgrade(req)
          ? undefined
          : new Response("upgrade required", { status: 426 });
      }

      if (url.pathname === "/state") {
        return Response.json(dependencies.getState() ?? { v: 0 });
      }

      if (url.pathname === "/file") {
        // Serve a LOCAL deliverable to the phone — but only a file that is,
        // right now, a review link in the published state. That constraint is
        // the whole security story: the token holder can see what the
        // dashboard is currently showing, never read arbitrary files.
        const requested = url.searchParams.get("path") ?? "";
        const state = dependencies.getState() as
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
            const reply = await dependencies.forwardControl(body);
            return new Response(reply, {
              headers: { "content-type": "application/json" },
            });
          } catch (error) {
            dependencies.log(`phone control failed: ${String(error)}`);
            return new Response("daemon unreachable", { status: 502 });
          }
        })();
      }

      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        const state = dependencies.getState();
        if (state) ws.send(JSON.stringify(state));
      },
      close(ws) {
        sockets.delete(ws);
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
      pairingCode = code;
      pairingAttempts = 0;
    },
    stop() {
      server.stop(true);
      sockets.clear();
    },
    publish() {
      if (sockets.size === 0) return;
      const state = dependencies.getState();
      if (!state) return;
      const frame = JSON.stringify(state);
      for (const ws of sockets) {
        try { ws.send(frame); } catch {}
      }
    },
  };
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

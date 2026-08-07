import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PhoneBridgeApplication, PhoneStateSink } from "./phone-bridge.ts";
import {
  RELAY_CHUNK_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_MAX_REQUEST_BYTES,
  RelaySessionCipher,
  decodeBase64URL,
  deriveRelayHandshakeKeys,
  deriveRelaySessionKeys,
  encodeRelayFrame,
  encodeBase64URL,
  isRelayDataFrame,
  mintRelayRoomId,
  mintRelaySecret,
  openRelayHello,
  relayChallenge,
  relayRequestFingerprint,
  sealRelayHello,
  type OpenedRelayFrame,
  type RelayDataFrame,
  type RelayFrameKind,
} from "./relay-protocol.ts";

export interface RelayPairing {
  version: 1;
  endpoint: string;
  roomId: string;
  secret: string;
  createdAt: number;
}

export interface PhoneRelayHandle {
  stop(): void;
  reconnectNow(): void;
  isAuthenticated(): boolean;
}

export interface PhoneRelayDependencies {
  log(message: string): void;
}

export function relayPairingPath(home: string = homedir()): string {
  return join(home, ".config", "conch", "relay-pairing.json");
}

function normalizedRelayEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "wss:") {
    throw new Error("relay endpoint must use https or wss");
  }
  url.protocol = "wss:";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function validateRelayPairing(value: unknown): RelayPairing {
  if (!value || typeof value !== "object") throw new Error("invalid relay pairing");
  const pairing = value as Partial<RelayPairing>;
  if (pairing.version !== 1 || typeof pairing.endpoint !== "string"
    || typeof pairing.roomId !== "string" || typeof pairing.secret !== "string"
    || typeof pairing.createdAt !== "number") {
    throw new Error("invalid relay pairing");
  }
  const endpoint = normalizedRelayEndpoint(pairing.endpoint);
  decodeBase64URL(pairing.roomId, 24);
  decodeBase64URL(pairing.secret, 32);
  return { ...pairing, endpoint } as RelayPairing;
}

export function readRelayPairing(path: string = relayPairingPath()): RelayPairing | null {
  if (!existsSync(path)) return null;
  return validateRelayPairing(JSON.parse(readFileSync(path, "utf8")));
}

/** Mint once, then retain the room and secret when the Worker URL changes. */
export function ensureRelayPairing(
  endpoint: string,
  path: string = relayPairingPath(),
): RelayPairing {
  const normalized = normalizedRelayEndpoint(endpoint);
  const existing = readRelayPairing(path);
  const pairing: RelayPairing = existing
    ? { ...existing, endpoint: normalized }
    : {
      version: 1,
      endpoint: normalized,
      roomId: mintRelayRoomId(),
      secret: mintRelaySecret(),
      createdAt: Date.now(),
    };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(pairing, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return pairing;
}

export function relayPairingCode(pairing: RelayPairing): string {
  const payload = encodeBase64URL(new TextEncoder().encode(JSON.stringify({
    version: pairing.version,
    endpoint: pairing.endpoint,
    roomId: pairing.roomId,
    secret: pairing.secret,
  })));
  return `conch-relay-v1:${payload}`;
}

interface RelayRequestPayload {
  path: string;
  headers: Array<[string, string]>;
  body: string;
}

interface CachedRelayResponse {
  fingerprint: string;
  frames: Array<{ kind: RelayFrameKind; body: Uint8Array }>;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const RESPONSE_CACHE_LIMIT = 4096;
const CACHED_RESPONSE_MAX_BYTES = 64 * 1024;
const RELAY_HEADER_MAX_BYTES = 16 * 1024;
const RELAY_HEADER_MAX_COUNT = 64;
const RELAY_PATH_MAX_BYTES = 8 * 1024;
const RELAY_LIVENESS_MS = 30_000;
const RELAY_REORDER_WINDOW = 64;
const RELAY_MAX_STATE_BYTES = 2 * 1024 * 1024;

class RelayResponseCacheFullError extends Error {}

function parseRequestPayload(opened: OpenedRelayFrame): RelayRequestPayload {
  if (opened.header.kind !== "request") throw new Error("expected relay request");
  if (opened.body.byteLength > RELAY_MAX_REQUEST_BYTES) throw new Error("relay request too large");
  const value = JSON.parse(new TextDecoder().decode(opened.body)) as Partial<RelayRequestPayload>;
  if (typeof value.path !== "string" || !value.path.startsWith("/")
    || value.path.startsWith("//") || value.path.includes("#")
    || new TextEncoder().encode(value.path).byteLength > RELAY_PATH_MAX_BYTES) {
    throw new Error("invalid relay path");
  }
  if (!Array.isArray(value.headers) || value.headers.length > RELAY_HEADER_MAX_COUNT
    || typeof value.body !== "string") throw new Error("invalid relay request");
  let headerBytes = 0;
  const headers: Array<[string, string]> = [];
  for (const pair of value.headers) {
    if (!Array.isArray(pair) || pair.length !== 2
      || typeof pair[0] !== "string" || typeof pair[1] !== "string"
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(pair[0])) {
      throw new Error("invalid relay header");
    }
    const name = pair[0].toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name === "host" || /[\r\n]/.test(pair[1])) {
      throw new Error("forbidden relay header");
    }
    headerBytes += new TextEncoder().encode(`${name}:${pair[1]}`).byteLength;
    if (headerBytes > RELAY_HEADER_MAX_BYTES) throw new Error("relay headers too large");
    headers.push([name, pair[1]]);
  }
  const body = decodeBase64URL(value.body);
  if (body.byteLength > RELAY_MAX_REQUEST_BYTES) throw new Error("relay request body too large");
  return { path: value.path, headers, body: value.body };
}

function responseHeaders(response: Response): Array<[string, string]> {
  return [...response.headers]
    .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
    .filter(([name]) => !HOP_BY_HOP_HEADERS.has(name));
}

function relayWebSocketURL(pairing: RelayPairing): string {
  const url = new URL(pairing.endpoint);
  url.protocol = "wss:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/room/${encodeURIComponent(pairing.roomId)}`;
  url.searchParams.set("role", "mac");
  return url.toString();
}

interface SendJob {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ChunkAckWaiter {
  id: string;
  method: string;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

class PrioritySender {
  #high: SendJob[] = [];
  #bulk: SendJob[] = [];
  #pumping = false;
  #closed: Error | null = null;

  enqueue(priority: "high" | "bulk", run: () => Promise<void>): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      (priority === "high" ? this.#high : this.#bulk).push({ run, resolve, reject });
      void this.#pump();
    });
  }

  close(error: Error): void {
    this.#closed = error;
    for (const job of [...this.#high, ...this.#bulk]) job.reject(error);
    this.#high = [];
    this.#bulk = [];
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (!this.#closed) {
        // Exactly one bulk chunk can run before newly arrived interactive work.
        const job = this.#high.shift() ?? this.#bulk.shift();
        if (!job) break;
        try {
          await job.run();
          job.resolve();
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      this.#pumping = false;
    }
  }
}

export class RelayResponseCache {
  readonly #completed = new Map<string, CachedRelayResponse>();
  readonly #inflight = new Map<string, { fingerprint: string; result: Promise<CachedRelayResponse> }>();

  get(id: string, fingerprint: string): CachedRelayResponse | null {
    const cached = this.#completed.get(id);
    if (!cached) return null;
    if (cached.fingerprint !== fingerprint) throw new Error("relay request ID collision");
    return cached;
  }

  async execute(
    id: string,
    fingerprint: string,
    operation: () => Promise<CachedRelayResponse>,
  ): Promise<CachedRelayResponse> {
    const completed = this.get(id, fingerprint);
    if (completed) return completed;
    const inflight = this.#inflight.get(id);
    if (inflight) {
      if (inflight.fingerprint !== fingerprint) throw new Error("relay request ID collision");
      return inflight.result;
    }
    // Never evict an accepted mutation while this daemon lives: a relay can
    // delay a response arbitrarily, so TTL/LRU eviction would let the same ID
    // execute again later. At the hard bound, fail new mutations before their
    // handler runs; the phone keeps its draft and session state is unchanged.
    if (this.#completed.size >= RESPONSE_CACHE_LIMIT) {
      throw new RelayResponseCacheFullError("relay mutation dedupe cache is full");
    }
    const result = operation();
    this.#inflight.set(id, { fingerprint, result });
    try {
      const response = await result;
      this.#completed.set(id, response);
      return response;
    } finally {
      this.#inflight.delete(id);
    }
  }

}

/** One authenticated E2E session, independent of its WebSocket lifecycle. */
export class MacRelayPeer {
  readonly #challenge = relayChallenge();
  readonly #sender = new PrioritySender();
  #cipher: RelaySessionCipher | null = null;
  #generation = 0;
  #lastAuthenticatedAt = 0;
  #stateSink: PhoneStateSink | null = null;
  #currentPhoneChallenge: string | null = null;
  #retiredPhoneChallenges = new Set<string>();
  #sessionProven = false;
  #closed = false;
  #receiveChain: Promise<void> = Promise.resolve();
  #nextPhoneSequence = 0;
  #pendingPhoneFrames = new Map<number, OpenedRelayFrame>();
  #mutationChain: Promise<void> = Promise.resolve();
  #pendingState: string | null = null;
  #stateInFlight: string | null = null;
  #stateSending = false;
  #stateDrainToken = 0;
  #chunkAcks = new Map<number, ChunkAckWaiter>();
  #bulkAvailable = true;
  #bulkWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  #activeReaders = new Map<string, { method: string; generation: number; cancel: () => void }>();
  #cancelledResponses = new Set<string>();

  constructor(
    private readonly application: PhoneBridgeApplication,
    private readonly pairing: RelayPairing,
    private readonly cache: RelayResponseCache,
    private readonly sendWire: (wire: string) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly onAuthenticated?: () => void,
    private readonly onProtocolFailure?: () => void,
    private readonly handshakeCipher: Promise<RelaySessionCipher> = deriveRelayHandshakeKeys(
      pairing.secret,
      pairing.roomId,
    ).then((keys) => RelaySessionCipher.mac(keys)),
  ) {}

  async hello(): Promise<string> {
    return JSON.stringify(await sealRelayHello(
      "mac",
      this.pairing.roomId,
      this.pairing.secret,
      this.#challenge,
      undefined,
      await this.handshakeCipher,
    ));
  }

  isAuthenticated(): boolean {
    return this.#cipher !== null && Date.now() - this.#lastAuthenticatedAt <= RELAY_LIVENESS_MS;
  }

  expireIfStale(now = Date.now()): boolean {
    if (!this.#cipher || now - this.#lastAuthenticatedAt <= RELAY_LIVENESS_MS) return false;
    this.#clearSubscription();
    this.#cipher = null;
    this.log("phone relay heartbeat expired");
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#cipher = null;
    this.#pendingPhoneFrames.clear();
    this.#rejectChunkAcks(new Error("relay socket closed"));
    this.#resetBulkWaiters(new Error("relay socket closed"));
    for (const reader of this.#activeReaders.values()) reader.cancel();
    this.#activeReaders.clear();
    this.#cancelledResponses.clear();
    this.#clearSubscription();
    this.#sender.close(new Error("relay socket closed"));
  }

  receive(wire: string): Promise<void> {
    let dispatches: Array<Promise<void>> = [];
    // Only handshake/decrypt/order commitment is serialized. Response streams
    // deliberately run outside this chain so a large /file cannot block a later
    // control request from reaching the shared application handler.
    const accepted = this.#receiveChain.then(async () => {
      dispatches = await this.#acceptWire(wire);
    });
    this.#receiveChain = accepted.catch(() => {});
    return accepted.then(async () => {
      await Promise.all(dispatches);
    });
  }

  async #acceptWire(wire: string): Promise<Array<Promise<void>>> {
    if (this.#closed) throw new Error("relay socket closed");
    if (new TextEncoder().encode(wire).byteLength > RELAY_MAX_FRAME_BYTES) {
      throw new Error("relay frame too large");
    }
    const frame = JSON.parse(wire) as unknown;
    if (!isRelayDataFrame(frame)) throw new Error("invalid encrypted relay frame");
    let phoneChallenge: Uint8Array | null = null;
    try {
      phoneChallenge = await openRelayHello(
        frame,
        "phone",
        this.pairing.roomId,
        this.pairing.secret,
      );
    } catch (error) {
      // Application frames use fresh session keys, so they cannot open under
      // the long-lived handshake keys — that failure is ordinary and silent.
      // A frame that opens as NEITHER is the interesting case: a phone with
      // the wrong secret or a stale pairing, which otherwise just retries
      // forever while the person watches "Looking for your Mac".
      if (!this.#cipher) {
        this.log(`phone hello rejected: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (phoneChallenge) {
      const challengeId = encodeBase64URL(phoneChallenge);
      if (challengeId === this.#currentPhoneChallenge) {
        // Never recreate a cipher for the same challenges: that would reuse the
        // session keys while forgetting which random nonces were already used.
        // Before proof, answer the phone's bounded retry with our hello while
        // preserving both nonce and replay state. After proof it is just replay.
        if (!this.#sessionProven) {
          this.#lastAuthenticatedAt = Date.now();
          await this.sendWire(await this.hello());
        }
        return [];
      }
      if (this.#retiredPhoneChallenges.has(challengeId)) {
        throw new Error("replayed retired phone hello");
      }
      if (this.#currentPhoneChallenge && challengeId !== this.#currentPhoneChallenge) {
        this.#retiredPhoneChallenges.add(this.#currentPhoneChallenge);
        while (this.#retiredPhoneChallenges.size > 64) {
          const oldest = this.#retiredPhoneChallenges.values().next().value as string | undefined;
          if (!oldest) break;
          this.#retiredPhoneChallenges.delete(oldest);
        }
      }
      const keys = await deriveRelaySessionKeys(
        this.pairing.secret,
        this.pairing.roomId,
        this.#challenge,
        phoneChallenge,
      );
      if (this.#closed) throw new Error("relay socket closed");
      this.#generation += 1;
      this.#rejectChunkAcks(new Error("relay session replaced"));
      this.#resetBulkWaiters(new Error("relay session replaced"));
      for (const reader of this.#activeReaders.values()) reader.cancel();
      this.#activeReaders.clear();
      this.#cancelledResponses.clear();
      this.#clearSubscription();
      this.#currentPhoneChallenge = challengeId;
      this.#sessionProven = false;
      this.#cipher = RelaySessionCipher.mac(keys);
      this.#nextPhoneSequence = 0;
      this.#pendingPhoneFrames.clear();
      this.#lastAuthenticatedAt = Date.now();
      // Say that a phone got in. Without this, a failed pairing and a phone
      // that never dialled look identical from the Mac: the log shows the
      // relay connected and then nothing, forever. Tyler spent an evening
      // stuck on "Looking for your Mac" with no way to tell which it was.
      this.log("phone paired — session established");
      this.onAuthenticated?.();
      // The DO intentionally retains no handshake. Replying to a valid phone
      // hello closes rendezvous without burning one handshake-key frame every
      // second while no phone exists. If this reply is dropped, the phone's
      // bounded retry sends another authenticated hello and gets another reply.
      await this.sendWire(await this.hello());
      return [];
    }
    const cipher = this.#cipher;
    const generation = this.#generation;
    if (!cipher) throw new Error("relay is not authenticated");
    const opened = await cipher.open(frame);
    if (this.#closed || generation !== this.#generation || cipher !== this.#cipher) {
      throw new Error("stale relay session");
    }
    this.#sessionProven = true;
    this.#lastAuthenticatedAt = Date.now();

    const sequence = opened.header.sequence;
    if (sequence < this.#nextPhoneSequence) throw new Error("replayed relay frame");
    if (sequence >= this.#nextPhoneSequence + RELAY_REORDER_WINDOW) {
      // Do not execute a far-future mutation after a hostile relay withheld its
      // predecessors. The socket will be rekeyed by the liveness/request timer.
      this.#pendingPhoneFrames.clear();
      this.onProtocolFailure?.();
      throw new Error("relay frame order gap is too large");
    }
    this.#pendingPhoneFrames.set(sequence, opened);

    const dispatches: Array<Promise<void>> = [];
    while (true) {
      const next = this.#pendingPhoneFrames.get(this.#nextPhoneSequence);
      if (!next) break;
      this.#pendingPhoneFrames.delete(this.#nextPhoneSequence);
      this.#nextPhoneSequence += 1;
      if (next.header.kind === "ping") {
        // A heartbeat also proves the logical /ws stream is alive. Publishing
        // here gives the phone an authenticated state snapshot at least every
        // ten seconds even when the daemon state itself is unchanged.
        this.application.publish();
        dispatches.push(this.#send(
          "pong",
          next.header.id,
          next.header.method,
          new Uint8Array(),
          "high",
        ));
      } else if (next.header.kind === "chunk-ack") {
        this.#acceptChunkAck(next);
      } else if (next.header.kind === "cancel") {
        this.#cancelResponse(next);
      } else if (next.header.kind === "request") {
        // Calling an async function starts the handler synchronously up to its
        // first await. Starting frames in sequence therefore installs /ws before
        // a following audio claim, while response streaming remains concurrent.
        dispatches.push(this.#dispatch(next));
      } else {
        this.#pendingPhoneFrames.clear();
        this.onProtocolFailure?.();
        throw new Error("unexpected phone relay frame");
      }
    }
    return dispatches;
  }

  async #dispatch(opened: OpenedRelayFrame): Promise<void> {
    const acceptedGeneration = this.#generation;
    const payload = parseRequestPayload(opened);
    const body = decodeBase64URL(payload.body);
    const fingerprint = relayRequestFingerprint(
      opened.header.method,
      payload.path,
      payload.headers,
      body,
    );
    const request = new Request(`https://conch.invalid${payload.path}`, {
      method: opened.header.method,
      headers: payload.headers,
      body: opened.header.method === "GET" || opened.header.method === "HEAD" ? undefined : body,
    });

    const invoke = () => this.application.handle(request, {
      expectedToken: this.pairing.secret,
      upgradeState: (_request, subscribe) => {
        this.#clearSubscription();
        const generation = this.#generation;
        const logicalStateSink: PhoneStateSink = {
          send: (state) => {
            if (generation !== this.#generation || !this.#cipher) return 0;
            this.#queueState(opened.header.id, opened.header.method, state, generation);
            return 1;
          },
        };
        this.#stateSink = logicalStateSink;
        subscribe(logicalStateSink);
        return true;
      },
    });

    if (opened.header.method === "POST") {
      // Authenticated phone frames are admitted in sequence, and mutations also
      // finish in that sequence. This prevents a hostile relay from swapping two
      // controls merely by changing their delivery timing.
      const execution = this.#mutationChain.then(() => this.cache.execute(
        opened.header.id,
        fingerprint,
        async () => {
          const result = invoke();
          if (result === undefined) throw new Error("mutation returned no response");
          const response = await result;
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > CACHED_RESPONSE_MAX_BYTES) {
            // The handler has already run. Never throw this ID back into the
            // executable pool: a reconnect would run the mutation twice. Cache
            // a small ambiguous result so the phone retains its draft and the
            // user decides whether an explicit new request is appropriate.
            const ambiguous = new Response(JSON.stringify({
              error: "The Mac processed the request but its reply was too large to confirm safely.",
            }), {
              status: 502,
              headers: { "content-type": "application/json" },
            });
            const safeBytes = new Uint8Array(await ambiguous.arrayBuffer());
            return {
              fingerprint,
              frames: this.#logicalResponseFrames(ambiguous, safeBytes),
            };
          }
          const frames = this.#logicalResponseFrames(response, bytes);
          return { fingerprint, frames };
        },
      ));
      this.#mutationChain = execution.then(() => {}, () => {});
      let cached: CachedRelayResponse;
      try {
        cached = await execution;
      } catch (error) {
        if (!(error instanceof RelayResponseCacheFullError)) throw error;
        if (acceptedGeneration !== this.#generation) return;
        const unavailable = new Response(JSON.stringify({
          error: "The Mac relay retry cache is full; restart conch before sending again.",
        }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
        const bytes = new Uint8Array(await unavailable.arrayBuffer());
        for (const frame of this.#logicalResponseFrames(unavailable, bytes)) {
          await this.#send(
            frame.kind,
            opened.header.id,
            opened.header.method,
            frame.body,
            "high",
            acceptedGeneration,
          );
        }
        return;
      }
      if (acceptedGeneration !== this.#generation) return;
      for (const frame of cached.frames) {
        await this.#send(
          frame.kind,
          opened.header.id,
          opened.header.method,
          frame.body,
          "high",
          acceptedGeneration,
        );
      }
      return;
    }

    const result = invoke();
    if (result === undefined) return;
    const response = await result;
    if (acceptedGeneration !== this.#generation) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    await this.#streamResponse(
      opened.header.id,
      opened.header.method,
      response,
      acceptedGeneration,
    );
  }

  #queueState(id: string, method: string, state: string, generation: number): void {
    if (generation !== this.#generation) return;
    if (state === this.#pendingState
      || (this.#pendingState === null && state === this.#stateInFlight)) return;
    this.#pendingState = state;
    if (this.#stateSending) return;
    const token = this.#stateDrainToken;
    this.#stateSending = true;
    void this.#drainStates(id, method, generation, token).catch(() => {
      if (token === this.#stateDrainToken) this.#clearSubscription();
    });
  }

  async #drainStates(id: string, method: string, generation: number, token: number): Promise<void> {
    try {
      while (generation === this.#generation
        && token === this.#stateDrainToken
        && this.#pendingState !== null) {
        const state = this.#pendingState;
        this.#pendingState = null;
        this.#stateInFlight = state;
        const bytes = new TextEncoder().encode(state);
        if (bytes.byteLength > RELAY_MAX_STATE_BYTES) {
          throw new Error("relay state snapshot too large");
        }
        await this.#send(
          "response-head",
          id,
          method,
          new TextEncoder().encode(JSON.stringify({
            status: 200,
            headers: [["content-type", "application/json"]],
          })),
          "high",
          generation,
        );
        const hash = createHash("sha256");
        for (let offset = 0; offset < bytes.byteLength; offset += RELAY_CHUNK_BYTES) {
          const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + RELAY_CHUNK_BYTES));
          hash.update(chunk);
          await this.#sendAcknowledgedChunk(id, method, chunk, "high", generation);
        }
        await this.#send(
          "response-end",
          id,
          method,
          new TextEncoder().encode(JSON.stringify({
            bytes: bytes.byteLength,
            sha256: hash.digest("base64url"),
          })),
          "high",
          generation,
        );
        if (this.#pendingState === state) this.#pendingState = null;
        this.#stateInFlight = null;
      }
    } finally {
      if (token === this.#stateDrainToken) {
        this.#stateInFlight = null;
        this.#stateSending = false;
      }
    }
  }

  #logicalResponseFrames(
    response: Response,
    bytes: Uint8Array,
  ): Array<{ kind: RelayFrameKind; body: Uint8Array }> {
    const frames: Array<{ kind: RelayFrameKind; body: Uint8Array }> = [{
      kind: "response-head",
      body: new TextEncoder().encode(JSON.stringify({
        status: response.status,
        headers: responseHeaders(response),
      })),
    }];
    const hash = createHash("sha256");
    for (let offset = 0; offset < bytes.byteLength; offset += RELAY_CHUNK_BYTES) {
      const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + RELAY_CHUNK_BYTES));
      hash.update(chunk);
      frames.push({ kind: "response-chunk", body: chunk });
    }
    frames.push({
      kind: "response-end",
      body: new TextEncoder().encode(JSON.stringify({
        bytes: bytes.byteLength,
        sha256: hash.digest("base64url"),
      })),
    });
    return frames;
  }

  async #streamResponse(
    id: string,
    method: string,
    response: Response,
    generation: number,
  ): Promise<void> {
    if (this.#cancelledResponses.delete(id)) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    await this.#send(
      "response-head",
      id,
      method,
      new TextEncoder().encode(JSON.stringify({
        status: response.status,
        headers: responseHeaders(response),
      })),
      "high",
      generation,
    );
    const hash = createHash("sha256");
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      this.#activeReaders.set(id, {
        method,
        generation,
        cancel: () => { void reader.cancel().catch(() => {}); },
      });
    }
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (this.#cancelledResponses.has(id)) throw new Error("relay response cancelled");
          if (done) break;
          for (let offset = 0; offset < value.byteLength; offset += RELAY_CHUNK_BYTES) {
            const chunk = value.slice(offset, Math.min(value.byteLength, offset + RELAY_CHUNK_BYTES));
            total += chunk.byteLength;
            hash.update(chunk);
            await this.#sendAcknowledgedChunk(id, method, chunk, "bulk", generation);
          }
        }
      }
      await this.#send(
        "response-end",
        id,
        method,
        new TextEncoder().encode(JSON.stringify({
          bytes: total,
          sha256: hash.digest("base64url"),
        })),
        "high",
        generation,
      );
    } catch (error) {
      await reader?.cancel(error).catch(() => {});
      throw error;
    } finally {
      const active = this.#activeReaders.get(id);
      if (active?.generation === generation) this.#activeReaders.delete(id);
      this.#cancelledResponses.delete(id);
    }
  }

  #send(
    kind: RelayFrameKind,
    id: string,
    method: string,
    body: Uint8Array,
    priority: "high" | "bulk",
    expectedGeneration = this.#generation,
  ): Promise<void> {
    const cipher = this.#cipher;
    if (!cipher || expectedGeneration !== this.#generation) {
      return Promise.reject(new Error("relay is not authenticated"));
    }
    return this.#sender.enqueue(priority, async () => {
      if (expectedGeneration !== this.#generation || cipher !== this.#cipher) {
        throw new Error("stale relay session");
      }
      const frame: RelayDataFrame = await cipher.seal({ id, method, kind }, body);
      await this.sendWire(encodeRelayFrame(frame));
    });
  }

  async #sendAcknowledgedChunk(
    id: string,
    method: string,
    body: Uint8Array,
    priority: "high" | "bulk",
    generation: number,
  ): Promise<void> {
    await this.#acquireBulk(generation);
    let sequence: number | null = null;
    try {
      const cipher = this.#cipher;
      if (!cipher || generation !== this.#generation) throw new Error("stale relay session");
      let acknowledgement: Promise<void> | null = null;
      await this.#sender.enqueue(priority, async () => {
        if (generation !== this.#generation || cipher !== this.#cipher) {
          throw new Error("stale relay session");
        }
        const sealed = await cipher.sealWithSequence(
          { id, method, kind: "response-chunk" },
          body,
        );
        sequence = sealed.sequence;
        acknowledgement = this.#registerChunkAck(sequence, id, method, generation);
        try {
          await this.sendWire(encodeRelayFrame(sealed.frame));
        } catch (error) {
          this.#rejectChunkAck(sequence, error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      });
      if (!acknowledgement) throw new Error("relay chunk acknowledgement was not registered");
      await acknowledgement;
    } finally {
      if (sequence !== null) this.#rejectChunkAck(sequence, new Error("relay chunk closed"));
      this.#releaseBulk(generation);
    }
  }

  #registerChunkAck(
    sequence: number,
    id: string,
    method: string,
    generation: number,
  ): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#chunkAcks.delete(sequence);
        reject(new Error("relay chunk acknowledgement timed out"));
      }, RELAY_LIVENESS_MS);
      this.#chunkAcks.set(sequence, { id, method, generation, timer, resolve, reject });
    });
    // The socket send may still be suspended when a session reset rejects the
    // waiter. Attach a handler immediately; the caller still awaits and observes
    // the original promise as soon as the send completes.
    void result.catch(() => {});
    return result;
  }

  #acceptChunkAck(opened: OpenedRelayFrame): void {
    if (opened.body.byteLength !== 8) throw new Error("invalid relay chunk acknowledgement");
    const value = new DataView(
      opened.body.buffer,
      opened.body.byteOffset,
      opened.body.byteLength,
    ).getBigUint64(0, false);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid relay chunk sequence");
    const sequence = Number(value);
    const waiter = this.#chunkAcks.get(sequence);
    if (!waiter) return;
    if (waiter.generation !== this.#generation
      || waiter.id !== opened.header.id
      || waiter.method !== opened.header.method) {
      throw new Error("relay chunk acknowledgement mismatch");
    }
    clearTimeout(waiter.timer);
    this.#chunkAcks.delete(sequence);
    waiter.resolve();
  }

  #rejectChunkAck(sequence: number, error: Error): void {
    const waiter = this.#chunkAcks.get(sequence);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#chunkAcks.delete(sequence);
    waiter.reject(error);
  }

  #rejectChunkAcks(error: Error): void {
    for (const [sequence] of this.#chunkAcks) this.#rejectChunkAck(sequence, error);
  }

  #acquireBulk(generation: number): Promise<void> {
    if (generation !== this.#generation) return Promise.reject(new Error("stale relay session"));
    if (this.#bulkAvailable) {
      this.#bulkAvailable = false;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#bulkWaiters.push({ generation, resolve, reject });
    });
  }

  #releaseBulk(generation: number): void {
    if (generation !== this.#generation) return;
    while (this.#bulkWaiters.length > 0) {
      const next = this.#bulkWaiters.shift()!;
      if (next.generation === this.#generation) {
        next.resolve();
        return;
      }
      next.reject(new Error("stale relay session"));
    }
    this.#bulkAvailable = true;
  }

  #resetBulkWaiters(error: Error): void {
    for (const waiter of this.#bulkWaiters.splice(0)) waiter.reject(error);
    this.#bulkAvailable = true;
  }

  #cancelResponse(opened: OpenedRelayFrame): void {
    if (opened.body.byteLength !== 0) throw new Error("invalid relay cancellation");
    if (opened.header.method !== "GET" && opened.header.method !== "HEAD") return;
    const active = this.#activeReaders.get(opened.header.id);
    if (active) {
      if (active.method !== opened.header.method || active.generation !== this.#generation) {
        throw new Error("relay cancellation mismatch");
      }
      this.#cancelledResponses.add(opened.header.id);
      for (const [sequence, waiter] of this.#chunkAcks) {
        if (waiter.id === opened.header.id && waiter.method === opened.header.method) {
          this.#rejectChunkAck(sequence, new Error("relay response cancelled"));
        }
      }
      active.cancel();
      this.#activeReaders.delete(opened.header.id);
      return;
    }
    this.#cancelledResponses.add(opened.header.id);
    while (this.#cancelledResponses.size > 128) {
      const oldest = this.#cancelledResponses.values().next().value as string | undefined;
      if (!oldest) break;
      this.#cancelledResponses.delete(oldest);
    }
  }

  #clearSubscription(): void {
    this.#stateDrainToken += 1;
    this.#pendingState = null;
    this.#stateInFlight = null;
    this.#stateSending = false;
    if (!this.#stateSink) return;
    this.application.unsubscribeState(this.#stateSink);
    this.#stateSink = null;
  }
}

function messageText(data: unknown): Promise<string> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(new TextDecoder().decode(data));
  if (data instanceof Blob) return data.text();
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    ));
  }
  return Promise.reject(new Error("unsupported relay websocket message"));
}

export function createPhoneRelay(
  application: PhoneBridgeApplication,
  pairing: RelayPairing,
  dependencies: PhoneRelayDependencies,
): PhoneRelayHandle {
  const cache = new RelayResponseCache();
  const handshakeCipher = deriveRelayHandshakeKeys(pairing.secret, pairing.roomId)
    .then((keys) => RelaySessionCipher.mac(keys));
  let socket: WebSocket | null = null;
  let peer: MacRelayPeer | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let delayMs = 500;
  let generation = 0;

  const clearTimers = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (livenessTimer) clearInterval(livenessTimer);
    reconnectTimer = null;
    livenessTimer = null;
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const jittered = Math.round(delayMs * (0.8 + Math.random() * 0.4));
    delayMs = Math.min(30_000, delayMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, jittered);
  };

  const disconnect = (expectedSocket: WebSocket, code = 1006) => {
    if (socket !== expectedSocket) return;
    socket = null;
    peer?.close();
    peer = null;
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = null;
    // 4001 means a newer Mac daemon took this room. Reconnecting the old one
    // would create an eviction loop, so only an explicit reconnect revives it.
    if (code !== 4001) scheduleReconnect();
  };

  const connect = () => {
    if (stopped || socket) return;
    const connectionGeneration = ++generation;
    const ws = new WebSocket(relayWebSocketURL(pairing));
    socket = ws;
    const sendWire = async (wire: string) => {
      if (socket !== ws || ws.readyState !== WebSocket.OPEN) throw new Error("relay socket closed");
      while (ws.bufferedAmount > 512 * 1024) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) throw new Error("relay socket closed");
      }
      ws.send(wire);
    };
    peer = new MacRelayPeer(
      application,
      pairing,
      cache,
      sendWire,
      dependencies.log,
      () => {
        delayMs = 500;
      },
      () => {
        try { ws.close(4002, "relay protocol reset"); } catch {}
        disconnect(ws, 4002);
      },
      handshakeCipher,
    );
    const sendHello = () => {
      const currentPeer = peer;
      if (!currentPeer || socket !== ws || ws.readyState !== WebSocket.OPEN) return;
      void currentPeer.hello().then(sendWire).catch(() => {});
    };
    ws.addEventListener("open", () => {
      if (socket !== ws || connectionGeneration !== generation) return;
      dependencies.log("phone relay connected");
      sendHello();
      let lastTick = Date.now();
      livenessTimer = setInterval(() => {
        const now = Date.now();
        const drift = now - lastTick;
        lastTick = now;
        // A 5s timer that took a minute means the PROCESS WAS SUSPENDED — the
        // Mac slept. TCP dies across sleep with no FIN, so this socket is
        // almost certainly dead while readyState still says OPEN and the close
        // event never fires. The daemon then sits "connected" to nothing, which
        // is exactly what happened overnight: the log's last line said
        // connected, and there was no socket to Cloudflare at all. Everything
        // below only ever expired the PHONE's session, never questioned ours.
        //
        // Reconnecting on a false positive costs one handshake; trusting a
        // dead socket costs the phone until someone restarts the daemon.
        if (drift > 60_000) {
          dependencies.log(`phone relay: process was suspended for ${Math.round(drift / 1000)}s — reconnecting`);
          try { ws.close(4002, "relay socket did not survive sleep"); } catch {}
          disconnect(ws, 4002);
          return;
        }
        if (peer?.expireIfStale()) {
          try { ws.close(4002, "relay session stale"); } catch {}
          disconnect(ws, 4002);
        }
      }, 5_000);
    });
    ws.addEventListener("message", (event) => {
      const currentPeer = peer;
      if (!currentPeer || socket !== ws) return;
      void messageText(event.data)
        .then((wire) => currentPeer.receive(wire))
        .catch((error) => dependencies.log(`phone relay rejected a frame: ${String(error)}`));
    });
    ws.addEventListener("close", (event) => {
      dependencies.log(`phone relay disconnected (${event.code})`);
      disconnect(ws, event.code);
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch {}
      disconnect(ws);
    });
  };

  connect();
  return {
    stop() {
      stopped = true;
      clearTimers();
      peer?.close();
      peer = null;
      const current = socket;
      socket = null;
      current?.close(1000, "daemon stopping");
    },
    reconnectNow() {
      if (stopped) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      delayMs = 500;
      const current = socket;
      if (current) {
        socket = null;
        peer?.close();
        peer = null;
        current.close(1000, "reconnecting");
      }
      connect();
    },
    isAuthenticated() {
      return peer?.isAuthenticated() ?? false;
    },
  };
}

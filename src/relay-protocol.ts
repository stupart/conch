import { createHash, randomBytes } from "node:crypto";

export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_CHALLENGE_BYTES = 32;
export const RELAY_NONCE_BYTES = 12;
export const RELAY_CHUNK_BYTES = 64 * 1024;
export const RELAY_MAX_REQUEST_BYTES = 128 * 1024;
export const RELAY_MAX_FRAME_BYTES = 192 * 1024;
export const RELAY_REPLAY_WINDOW = 64;
export const RELAY_MAX_FRAMES_PER_KEY = 262_144;

export type RelayRole = "mac" | "phone";
export type RelayDirection = "phone-to-mac" | "mac-to-phone";
export type RelayFrameKind =
  | "hello"
  | "request"
  | "response-head"
  | "response-chunk"
  | "response-end"
  | "chunk-ack"
  | "cancel"
  | "ping"
  | "pong";

export interface RelayDataFrame {
  version: 1;
  headerNonce: string;
  headerCiphertext: string;
  bodyNonce: string;
  bodyCiphertext: string;
}

export interface RelayFrameHeader {
  version: 1;
  id: string;
  method: string;
  sequence: number;
  direction: RelayDirection;
  kind: RelayFrameKind;
}

export interface OpenedRelayFrame {
  header: RelayFrameHeader;
  body: Uint8Array;
}

interface HelloPayload {
  version: 1;
  role: RelayRole;
  challenge: string;
}

interface DirectionalKeys {
  header: CryptoKey;
  body: CryptoKey;
}

export interface RelaySessionKeys {
  phoneToMac: DirectionalKeys;
  macToPhone: DirectionalKeys;
}

export function encodeRelayFrame(frame: RelayDataFrame): string {
  return sortedJSON(frame as unknown as Record<string, unknown>);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FRAME_KINDS = new Set<RelayFrameKind>([
  "hello",
  "request",
  "response-head",
  "response-chunk",
  "response-end",
  "chunk-ack",
  "cancel",
  "ping",
  "pong",
]);

// TypeScript 5.7 distinguishes ArrayBuffer from SharedArrayBuffer in WebCrypto
// even though every value constructed in this module is an owned ArrayBuffer.
function source(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function encodeBase64URL(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function decodeBase64URL(value: string, expectedBytes?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("invalid base64url");
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  if (encodeBase64URL(bytes) !== value) throw new Error("non-canonical base64url");
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes`);
  }
  return bytes;
}

export function mintRelayRoomId(): string {
  return encodeBase64URL(randomBytes(24));
}

export function mintRelaySecret(): string {
  return encodeBase64URL(randomBytes(32));
}

export function relayChallenge(): Uint8Array {
  return new Uint8Array(randomBytes(RELAY_CHALLENGE_BYTES));
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function lengthPrefixedBytes(bytes: Uint8Array): Uint8Array {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.byteLength, false);
  return concatBytes(length, bytes);
}

function lengthPrefixed(value: string): Uint8Array {
  return lengthPrefixedBytes(encoder.encode(value));
}

function lengthPrefixedParts(parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts.map(lengthPrefixedBytes));
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function sortedJSON(value: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function headerAAD(direction: RelayDirection): Uint8Array {
  return concatBytes(
    lengthPrefixed("conch-relay/header-aad/v1"),
    lengthPrefixed(direction),
  );
}

export function bodyAAD(header: RelayFrameHeader): Uint8Array {
  return concatBytes(
    lengthPrefixed("conch-relay/body-aad/v1"),
    lengthPrefixed(header.direction),
    lengthPrefixed(header.id),
    lengthPrefixed(header.method),
    lengthPrefixed(header.kind),
    uint64(header.sequence),
  );
}

async function hkdfKey(
  secret: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", source(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: source(salt), info: source(encoder.encode(info)) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function pairingSecretBytes(secret: string): Uint8Array {
  return decodeBase64URL(secret, 32);
}

export async function sealRelayHello(
  role: RelayRole,
  roomId: string,
  secret: string,
  challenge: Uint8Array,
  nonces?: { header: Uint8Array; body: Uint8Array },
  persistentCipher?: RelaySessionCipher,
): Promise<RelayDataFrame> {
  if (challenge.byteLength !== RELAY_CHALLENGE_BYTES) throw new Error("invalid challenge");
  const payload: HelloPayload = {
    version: RELAY_PROTOCOL_VERSION,
    role,
    challenge: encodeBase64URL(challenge),
  };
  const cipher = persistentCipher ?? (role === "phone"
    ? RelaySessionCipher.phone(await deriveRelayHandshakeKeys(secret, roomId))
    : RelaySessionCipher.mac(await deriveRelayHandshakeKeys(secret, roomId)));
  return cipher.seal(
    { id: `hello-${role}`, method: "HELLO", kind: "hello" },
    encoder.encode(sortedJSON(payload as unknown as Record<string, unknown>)),
    nonces,
  );
}

export async function openRelayHello(
  frame: RelayDataFrame,
  expectedRole: RelayRole,
  roomId: string,
  secret: string,
): Promise<Uint8Array> {
  const cipher = expectedRole === "phone"
    ? RelaySessionCipher.mac(await deriveRelayHandshakeKeys(secret, roomId))
    : RelaySessionCipher.phone(await deriveRelayHandshakeKeys(secret, roomId));
  const opened = await cipher.open(frame);
  const payload = JSON.parse(decoder.decode(opened.body)) as Partial<HelloPayload>;
  if (opened.header.kind !== "hello" || opened.header.method !== "HELLO"
    || payload.version !== RELAY_PROTOCOL_VERSION
    || payload.role !== expectedRole || typeof payload.challenge !== "string") {
    throw new Error("invalid relay hello payload");
  }
  return decodeBase64URL(payload.challenge, RELAY_CHALLENGE_BYTES);
}

export async function deriveRelaySessionKeys(
  secret: string,
  roomId: string,
  macChallenge: Uint8Array,
  phoneChallenge: Uint8Array,
): Promise<RelaySessionKeys> {
  if (macChallenge.byteLength !== RELAY_CHALLENGE_BYTES
    || phoneChallenge.byteLength !== RELAY_CHALLENGE_BYTES) {
    throw new Error("invalid relay challenge");
  }
  const salt = await scheduleSalt([
    encoder.encode("conch-relay/session-salt/v1"),
    decodeBase64URL(roomId),
    phoneChallenge,
    macChallenge,
  ]);
  return directionalKeys(pairingSecretBytes(secret), salt, "session");
}

export async function deriveRelayHandshakeKeys(
  secret: string,
  roomId: string,
): Promise<RelaySessionKeys> {
  const salt = await scheduleSalt([
    encoder.encode("conch-relay/handshake-salt/v1"),
    decodeBase64URL(roomId),
  ]);
  return directionalKeys(pairingSecretBytes(secret), salt, "handshake");
}

async function scheduleSalt(parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    source(lengthPrefixedParts(parts)),
  ));
}

async function directionalKeys(
  root: Uint8Array,
  salt: Uint8Array,
  phase: "handshake" | "session",
): Promise<RelaySessionKeys> {
  return {
    phoneToMac: {
      header: await hkdfKey(root, salt, `conch-relay/${phase}/phone-to-mac/header/v1`),
      body: await hkdfKey(root, salt, `conch-relay/${phase}/phone-to-mac/body/v1`),
    },
    macToPhone: {
      header: await hkdfKey(root, salt, `conch-relay/${phase}/mac-to-phone/header/v1`),
      body: await hkdfKey(root, salt, `conch-relay/${phase}/mac-to-phone/body/v1`),
    },
  };
}

function parseHeader(bytes: ArrayBuffer): RelayFrameHeader {
  const value = JSON.parse(decoder.decode(bytes)) as Partial<RelayFrameHeader>;
  if (
    value.version !== RELAY_PROTOCOL_VERSION
    || typeof value.id !== "string" || value.id.length < 8 || value.id.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(value.id)
    || typeof value.method !== "string" || !/^[A-Z]{3,16}$/.test(value.method)
    || !Number.isSafeInteger(value.sequence) || (value.sequence ?? -1) < 0
    || (value.direction !== "phone-to-mac" && value.direction !== "mac-to-phone")
    || typeof value.kind !== "string" || !FRAME_KINDS.has(value.kind as RelayFrameKind)
  ) throw new Error("invalid relay header");
  return value as RelayFrameHeader;
}

class ReplayWindow {
  #highest = -1;
  #seen = new Set<number>();

  contains(sequence: number): boolean {
    return sequence <= this.#highest - RELAY_REPLAY_WINDOW || this.#seen.has(sequence);
  }

  accept(sequence: number): void {
    if (this.contains(sequence)) throw new Error("replayed relay frame");
    if (sequence > this.#highest) this.#highest = sequence;
    this.#seen.add(sequence);
    const floor = this.#highest - RELAY_REPLAY_WINDOW;
    for (const seen of this.#seen) if (seen <= floor) this.#seen.delete(seen);
  }
}

/**
 * One endpoint's connection-scoped cipher. Header and body use independent
 * directional keys and nonces. The relay sees only fixed envelope fields,
 * ciphertext sizes, and timing; request IDs and HTTP methods stay encrypted.
 */
export class RelaySessionCipher {
  #sendSequence: number;
  #sendNonces = new Set<string>();
  #replay = new ReplayWindow();

  constructor(
    private readonly sendDirection: RelayDirection,
    private readonly sendKeys: DirectionalKeys,
    private readonly receiveDirection: RelayDirection,
    private readonly receiveKeys: DirectionalKeys,
    initialSendSequence = 0,
  ) {
    this.#sendSequence = initialSendSequence;
  }

  static phone(keys: RelaySessionKeys, initialSendSequence = 0): RelaySessionCipher {
    return new RelaySessionCipher(
      "phone-to-mac",
      keys.phoneToMac,
      "mac-to-phone",
      keys.macToPhone,
      initialSendSequence,
    );
  }

  static mac(keys: RelaySessionKeys, initialSendSequence = 0): RelaySessionCipher {
    return new RelaySessionCipher(
      "mac-to-phone",
      keys.macToPhone,
      "phone-to-mac",
      keys.phoneToMac,
      initialSendSequence,
    );
  }

  #nonce(): Uint8Array {
    while (true) {
      const nonce = new Uint8Array(randomBytes(RELAY_NONCE_BYTES));
      const encoded = encodeBase64URL(nonce);
      if (!this.#sendNonces.has(encoded)) {
        this.#sendNonces.add(encoded);
        return nonce;
      }
    }
  }

  async seal(
    input: Omit<RelayFrameHeader, "version" | "direction" | "sequence">,
    body: Uint8Array,
    testNonces?: { header: Uint8Array; body: Uint8Array },
  ): Promise<RelayDataFrame> {
    return (await this.sealWithSequence(input, body, testNonces)).frame;
  }

  async sealWithSequence(
    input: Omit<RelayFrameHeader, "version" | "direction" | "sequence">,
    body: Uint8Array,
    testNonces?: { header: Uint8Array; body: Uint8Array },
  ): Promise<{ frame: RelayDataFrame; sequence: number }> {
    if (body.byteLength > RELAY_MAX_REQUEST_BYTES) throw new Error("relay frame body is too large");
    if (this.#sendSequence >= RELAY_MAX_FRAMES_PER_KEY) throw new Error("relay session key expired");
    const header: RelayFrameHeader = {
      version: RELAY_PROTOCOL_VERSION,
      ...input,
      direction: this.sendDirection,
      sequence: this.#sendSequence++,
    };
    const headerNonce = testNonces?.header ?? this.#nonce();
    const bodyNonce = testNonces?.body ?? this.#nonce();
    if (headerNonce.byteLength !== RELAY_NONCE_BYTES || bodyNonce.byteLength !== RELAY_NONCE_BYTES) {
      throw new Error("invalid nonce");
    }
    const headerCiphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: source(headerNonce),
        additionalData: source(headerAAD(header.direction)),
        tagLength: 128,
      },
      this.sendKeys.header,
      source(encoder.encode(sortedJSON(header as unknown as Record<string, unknown>))),
    );
    const bodyCiphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: source(bodyNonce),
        additionalData: source(bodyAAD(header)),
        tagLength: 128,
      },
      this.sendKeys.body,
      source(body),
    );
    return {
      sequence: header.sequence,
      frame: {
        version: RELAY_PROTOCOL_VERSION,
        headerNonce: encodeBase64URL(headerNonce),
        headerCiphertext: encodeBase64URL(new Uint8Array(headerCiphertext)),
        bodyNonce: encodeBase64URL(bodyNonce),
        bodyCiphertext: encodeBase64URL(new Uint8Array(bodyCiphertext)),
      },
    };
  }

  async open(frame: RelayDataFrame): Promise<OpenedRelayFrame> {
    if (frame.version !== RELAY_PROTOCOL_VERSION) {
      throw new Error("unexpected relay frame");
    }
    const header = parseHeader(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: source(decodeBase64URL(frame.headerNonce, RELAY_NONCE_BYTES)),
        additionalData: source(headerAAD(this.receiveDirection)),
        tagLength: 128,
      },
      this.receiveKeys.header,
      source(decodeBase64URL(frame.headerCiphertext)),
    ));
    if (header.direction !== this.receiveDirection) throw new Error("wrong relay direction");
    if (this.#replay.contains(header.sequence)) throw new Error("replayed relay frame");
    const body = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: source(decodeBase64URL(frame.bodyNonce, RELAY_NONCE_BYTES)),
        additionalData: source(bodyAAD(header)),
        tagLength: 128,
      },
      this.receiveKeys.body,
      source(decodeBase64URL(frame.bodyCiphertext)),
    ));
    // Commit the sequence only after both tags authenticate. A forged high
    // sequence therefore cannot advance the replay window and suppress data.
    this.#replay.accept(header.sequence);
    return { header, body };
  }
}

export function relayRequestFingerprint(
  method: string,
  path: string,
  headers: ReadonlyArray<readonly [string, string]>,
  body: Uint8Array,
): string {
  const hash = createHash("sha256");
  for (const value of [method, path]) {
    const bytes = Buffer.from(value);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length).update(bytes);
  }
  for (const [name, value] of headers) hash.update(name.toLowerCase()).update("\0").update(value).update("\0");
  hash.update(body);
  return hash.digest("base64url");
}

export function isRelayDataFrame(value: unknown): value is RelayDataFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RelayDataFrame>;
  return frame.version === 1
    && typeof frame.headerNonce === "string" && typeof frame.headerCiphertext === "string"
    && typeof frame.bodyNonce === "string" && typeof frame.bodyCiphertext === "string";
}

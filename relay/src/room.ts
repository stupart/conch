export const RELAY_MAX_MESSAGE_BYTES = 192 * 1024;
export const RELAY_REPLACED_CLOSE_CODE = 4001;

export type RelayRole = "mac" | "phone";

export interface OpaqueRelaySocket {
  readyState: number;
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
}

export interface RelayRoomState {
  getWebSockets(tag?: string): OpaqueRelaySocket[];
  acceptWebSocket(socket: OpaqueRelaySocket, tags?: string[]): void;
}

export function isRelayRole(value: string | null): value is RelayRole {
  return value === "mac" || value === "phone";
}

export function validRoomId(value: string): boolean {
  // 128 to 512 public bits. The shipped CLI mints 192 bits.
  return /^[A-Za-z0-9_-]{22,86}$/.test(value);
}

export function messageBytes(message: string | ArrayBuffer): number {
  return typeof message === "string"
    ? new TextEncoder().encode(message).byteLength
    : message.byteLength;
}

/** Evict-before-accept makes one role deterministic even under reconnect races. */
export function installRoleSocket(
  state: RelayRoomState,
  socket: OpaqueRelaySocket,
  role: RelayRole,
): void {
  for (const previous of state.getWebSockets(role)) {
    if (previous !== socket) previous.close(RELAY_REPLACED_CLOSE_CODE, "replaced");
  }
  socket.serializeAttachment?.({ role });
  state.acceptWebSocket(socket, [role]);
}

export function socketRole(socket: OpaqueRelaySocket): RelayRole | null {
  const attachment = socket.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") return null;
  const role = (attachment as { role?: unknown }).role;
  return role === "mac" || role === "phone" ? role : null;
}

/**
 * Forward one opaque frame to the other role. No parsing, buffering, logging,
 * persistence, or acknowledgement is allowed here: the endpoints own all
 * authentication, encryption, replay defense, ordering, and retries.
 */
export function forwardOpaqueMessage(
  state: RelayRoomState,
  sender: OpaqueRelaySocket,
  message: string | ArrayBuffer,
): void {
  if (messageBytes(message) > RELAY_MAX_MESSAGE_BYTES) {
    sender.close(1009, "message too large");
    return;
  }
  const role = socketRole(sender);
  if (!role) {
    sender.close(1008, "missing role");
    return;
  }
  const peerRole: RelayRole = role === "mac" ? "phone" : "mac";
  for (const peer of state.getWebSockets(peerRole)) {
    // Cloudflare WebSockets use the browser OPEN value (1). A closed peer is
    // simply absent from delivery; endpoint retry makes loss non-corrupting.
    if (peer.readyState === 1) peer.send(message);
  }
}

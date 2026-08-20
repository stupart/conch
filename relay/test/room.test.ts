import { describe, expect, test } from "bun:test";
import {
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_REPLACED_CLOSE_CODE,
  forwardOpaqueMessage,
  installRoleSocket,
  validRoomId,
  type OpaqueRelaySocket,
  type RelayRoomState,
  type RelayRole,
} from "../src/room.ts";

class FakeSocket implements OpaqueRelaySocket {
  readyState = 1;
  sent: Array<string | ArrayBuffer> = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  attachment: unknown;

  send(message: string | ArrayBuffer): void { this.sent.push(message); }
  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.readyState = 3;
  }
  serializeAttachment(value: unknown): void { this.attachment = value; }
  deserializeAttachment(): unknown { return this.attachment; }
}

class FakeState implements RelayRoomState {
  sockets: Array<{ socket: FakeSocket; tags: string[] }> = [];

  getWebSockets(tag?: string): FakeSocket[] {
    return this.sockets
      .filter((entry) => !tag || entry.tags.includes(tag))
      .map((entry) => entry.socket);
  }

  acceptWebSocket(socket: OpaqueRelaySocket, tags: string[] = []): void {
    this.sockets.push({ socket: socket as FakeSocket, tags });
  }

  install(role: RelayRole): FakeSocket {
    const socket = new FakeSocket();
    installRoleSocket(this, socket, role);
    return socket;
  }
}

describe("untrusted Durable Object room core", () => {
  test("accepts only high-entropy URL-safe public room IDs", () => {
    expect(validRoomId("abcdefghijklmnopqrstuv")).toBeTrue();
    expect(validRoomId("A_-012345678901234567890123456789")).toBeTrue();
    expect(validRoomId("short")).toBeFalse();
    expect(validRoomId("a".repeat(87))).toBeFalse();
    expect(validRoomId("abcdefghijklmnopqrstu/")).toBeFalse();
  });

  test("a second same-role socket evicts the old one and does not touch its peer", () => {
    const state = new FakeState();
    const oldMac = state.install("mac");
    const phone = state.install("phone");
    const newMac = state.install("mac");
    expect(oldMac.closes).toEqual([[RELAY_REPLACED_CLOSE_CODE, "replaced"]]);
    expect(phone.closes).toEqual([]);
    expect(newMac.closes).toEqual([]);
  });

  test("forwards bytes unchanged only to the opposite role without parsing", () => {
    const state = new FakeState();
    const mac = state.install("mac");
    const phone = state.install("phone");
    const opaque = "not JSON; still endpoint ciphertext";
    forwardOpaqueMessage(state, phone, opaque);
    expect(mac.sent).toEqual([opaque]);
    expect(phone.sent).toEqual([]);
    const binary = Uint8Array.from([0, 255, 2, 3]).buffer;
    forwardOpaqueMessage(state, mac, binary);
    expect(phone.sent).toEqual([binary]);
  });

  test("drops when no peer and closes oversized or untagged senders", () => {
    const state = new FakeState();
    const mac = state.install("mac");
    forwardOpaqueMessage(state, mac, "ciphertext");
    expect(mac.closes).toEqual([]);
    forwardOpaqueMessage(state, mac, "x".repeat(RELAY_MAX_MESSAGE_BYTES + 1));
    expect(mac.closes).toEqual([[1009, "message too large"]]);

    const untagged = new FakeSocket();
    forwardOpaqueMessage(state, untagged, "ciphertext");
    expect(untagged.closes).toEqual([[1008, "missing role"]]);
  });
});

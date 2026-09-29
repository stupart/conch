import { createConnection, type Socket } from "node:net";
import { lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Desktop's local follower protocol, not the privileged app-tools MCP pipe.
 * Register as Conch; ask the existing owner to handle input. Never take a writer
 * lock, spawn/resume a second app-server, change settings, or send keystrokes.
 * See docs/hosted-session-delivery.md for the versioned compatibility contract.
 */
const MAX_FRAME = 8 * 1024 * 1024;
type Reply = { type: string; requestId: string; resultType?: string; method?: string; handledByClientId?: string; result?: any; error?: string };
export type HostedDelivery =
  | { delivered: true; turnId: string; mode: "steered" | "started" }
  | { delivered: false; reason: string; uncertain?: boolean };
class BridgeError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code); }
}

export function privateCodexSocket(path: string): boolean {
  try {
    const uid = process.getuid?.();
    const dir = lstatSync(dirname(path)), file = lstatSync(path);
    return uid !== undefined && dir.isDirectory() && dir.uid === uid && (dir.mode & 0o022) === 0
      && file.isSocket() && file.uid === uid && (file.mode & 0o077) === 0;
  } catch { return false; }
}

class FollowerClient {
  private socket?: Socket;
  private buffer = Buffer.alloc(0);
  private clientId = "initializing-client";
  private pending = new Map<string, { resolve: (reply: Reply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private path: string, private timeoutMs: number) {}
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket = createConnection(this.path);
      const timer = setTimeout(() => { socket.destroy(); reject(new BridgeError("hosted-app-unavailable")); }, this.timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.on("error", () => { clearTimeout(timer); reject(new BridgeError("hosted-app-unavailable")); this.close(); });
      socket.on("close", () => { clearTimeout(timer); this.close(); });
      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > MAX_FRAME) { this.close(); return; }
          if (this.buffer.length < length + 4) return;
          const payload = this.buffer.subarray(4, length + 4);
          this.buffer = this.buffer.subarray(length + 4);
          let reply: Reply;
          try { reply = JSON.parse(payload.toString()); } catch { this.close(); return; }
          if (reply.type !== "response") continue; // No subscriptions, discovery handlers or broadcasts.
          const pending = this.pending.get(reply.requestId);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(reply.requestId); pending.resolve(reply);
        }
      });
    });
    const reply = await this.request("initialize", { clientType: "conch" }, 0);
    if (reply.resultType !== "success" || typeof reply.result?.clientId !== "string") throw new BridgeError("hosted-protocol-incompatible");
    this.clientId = reply.result.clientId;
  }
  request(method: string, params: unknown, version: number, targetClientId?: string): Promise<Reply> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new BridgeError("hosted-app-unavailable"));
    const requestId = randomUUID();
    const payload = Buffer.from(JSON.stringify({ type: "request", requestId, sourceClientId: this.clientId, method, params, version, targetClientId, timeoutMs: this.timeoutMs }));
    if (payload.length > MAX_FRAME) return Promise.reject(new BridgeError("hosted-message-too-large"));
    const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new BridgeError("hosted-delivery-unconfirmed", true)); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket!.write(frame);
    });
  }
  close(): void {
    this.socket?.destroy();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new BridgeError("hosted-delivery-unconfirmed", true)); }
    this.pending.clear();
  }
}

export async function sendCodexAppMessage(options: {
  codexHome: string; threadId: string; text: string; cwd?: string; messageId?: string;
  beforeSend?: () => boolean | Promise<boolean>; timeoutMs?: number;
}): Promise<HostedDelivery> {
  if (Buffer.byteLength(options.text) > MAX_FRAME - 4096) return { delivered: false, reason: "hosted-message-too-large" };
  const socketPath = join(options.codexHome, "ipc", "ipc.sock");
  if (!privateCodexSocket(socketPath)) return { delivered: false, reason: "hosted-app-unavailable" };
  const client = new FollowerClient(socketPath, options.timeoutMs ?? 40_000);
  let dispatched = false;
  try {
    await client.connect();
    const owner = await client.request("thread-owner-discovery", { hostId: "local", conversationId: options.threadId }, 1);
    if (owner.resultType !== "success" || !owner.handledByClientId) return { delivered: false, reason: "hosted-session-not-open" };
    if (options.beforeSend && !await options.beforeSend()) return { delivered: false, reason: "delivery-interrupted" };
    const input = [{ type: "text", text: options.text, text_elements: [] }];
    const messageId = options.messageId ?? randomUUID();
    // Ask the owner, not our polled status, whether a turn is active. Only the
    // explicit inactive rejection permits a start. A timeout never permits retry.
    dispatched = true;
    const steer = await client.request("thread-follower-steer-turn", {
      conversationId: options.threadId, input, clientUserMessageId: messageId,
      restoreMessage: { text: options.text, cwd: options.cwd, context: { workspaceRoots: options.cwd ? [options.cwd] : [] } },
    }, 1, owner.handledByClientId);
    if (steer.resultType === "success" && steer.handledByClientId === owner.handledByClientId && steer.method === "thread-follower-steer-turn") {
      const turnId = steer.result?.result?.turnId;
      return typeof turnId === "string" && turnId.length > 0
        ? { delivered: true, turnId, mode: "steered" }
        : { delivered: false, reason: "hosted-delivery-unconfirmed", uncertain: true };
    }
    const inactive = steer.error === `Cannot steer conversation ${options.threadId} because its active turn already ended`;
    if (!inactive) return failure(steer);
    dispatched = false;
    if (options.beforeSend && !await options.beforeSend()) return { delivered: false, reason: "delivery-interrupted" };
    dispatched = true;
    const start = await client.request("thread-follower-start-turn", {
      conversationId: options.threadId,
      turnStart: { request: { threadId: options.threadId, input, clientUserMessageId: messageId }, context: { inheritThreadSettings: true } },
    }, 2, owner.handledByClientId);
    if (start.resultType !== "success" || start.handledByClientId !== owner.handledByClientId || start.method !== "thread-follower-start-turn") return failure(start);
    const turnId = start.result?.result?.turn?.id;
    return typeof turnId === "string" && turnId.length > 0
      ? { delivered: true, turnId, mode: "started" }
      : { delivered: false, reason: "hosted-delivery-unconfirmed", uncertain: true };
  } catch (error) {
    return { delivered: false, reason: dispatched ? "hosted-delivery-unconfirmed" : error instanceof BridgeError ? error.code : "hosted-app-unavailable", ...(dispatched ? { uncertain: true } : {}) };
  } finally { client.close(); }
}
function failure(reply: Reply): HostedDelivery {
  if (["no-client-found", "client-disconnected"].includes(reply.error ?? "")) return { delivered: false, reason: "hosted-session-not-open" };
  if (["request-version-mismatch", "no-handler-for-request"].includes(reply.error ?? "")) return { delivered: false, reason: "hosted-protocol-incompatible" };
  // An owner may have submitted before losing its provider acknowledgement.
  return { delivered: false, reason: "hosted-delivery-unconfirmed", uncertain: true };
}

import { DurableObject } from "cloudflare:workers";
import {
  forwardOpaqueMessage,
  installRoleSocket,
  isRelayRole,
  validRoomId,
  type OpaqueRelaySocket,
  type RelayRoomState,
} from "./room.ts";

interface Env {
  RELAY_ROOM: DurableObjectNamespace<RelayRoom>;
}

function roomRoute(request: Request): { roomId: string; role: "mac" | "phone" } | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/(?:^|\/)v1\/room\/([^/]+)$/);
  const roomId = match?.[1] ?? "";
  const role = url.searchParams.get("role");
  if (!validRoomId(roomId) || !isRelayRole(role)) return null;
  return { roomId, role };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const route = roomRoute(request);
    if (!route) return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 426 });
    }
    // The public room ID chooses placement, never trust. Authentication is
    // exclusively the endpoint-held E2E secret Cloudflare never receives.
    const id = env.RELAY_ROOM.idFromName(route.roomId);
    return env.RELAY_ROOM.get(id).fetch(request);
  },
};

export class RelayRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const route = roomRoute(request);
    if (!route) return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("websocket required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    installRoleSocket(
      this.ctx as unknown as RelayRoomState,
      server as unknown as OpaqueRelaySocket,
      route.role,
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    forwardOpaqueMessage(
      this.ctx as unknown as RelayRoomState,
      socket as unknown as OpaqueRelaySocket,
      message,
    );
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try { socket.close(code, reason); } catch {}
  }

  webSocketError(socket: WebSocket): void {
    try { socket.close(1011, "relay socket error"); } catch {}
  }
}

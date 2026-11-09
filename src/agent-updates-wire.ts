import type { SessionBackend } from "./agent-adapter.ts";

/** The app's view of agent updates (agent-updates.ts), and the request for it. Kept apart so `settings.ts` needn't load the updater. */

export type AgentInstallChannel = "homebrew-cask" | "updates-itself" | "not-managed" | "missing";

export interface AgentUpdatesRow {
  backend: SessionBackend;
  displayName: string;
  channel: AgentInstallChannel;
  source: string;
  installed: string | null;
  newest: string | null;
  cask?: string;
  checkedAt?: number;
  updatedAt?: number;
  updatedFrom?: string;
  updatedTo?: string;
  failure?: { at: number; phase: "check" | "update"; message: string; output?: string };
  /** Whether conch can upgrade it: a cask it can name. */
  canUpdate: boolean;
  updating: boolean;
  /** Live sessions on an older version than the one installed: they stay there until they end. Only ever said, never acted on. */
  olderSessions: { count: number; versions: string[] };
}

export interface AgentUpdatesReply {
  kind: "agent-updates";
  auto: boolean;
  agents: AgentUpdatesRow[];
}

export type AgentUpdatesRequest = {
  kind: "agent-updates";
  action: "status" | "update-now";
  backend?: SessionBackend;
};

/** Refuses a malformed request before it reaches the daemon. */
export function agentUpdatesRequestError(value: Record<string, unknown>): string | undefined {
  if (value.action !== "status" && value.action !== "update-now") return "agent-updates: unknown action";
  if (value.backend !== undefined && typeof value.backend !== "string") return "agent-updates: backend must be a string";
  if (value.action === "update-now" && typeof value.backend !== "string") return "agent-updates: update-now needs a backend";
  return undefined;
}

export function isAgentUpdatesReply(value: unknown): value is AgentUpdatesReply {
  const reply = value as AgentUpdatesReply;
  return Boolean(reply) && reply.kind === "agent-updates" && typeof reply.auto === "boolean" && Array.isArray(reply.agents)
    && reply.agents.every((agent) => typeof agent?.backend === "string");
}

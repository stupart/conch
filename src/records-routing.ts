import { transcriptFormatFor } from "./agent-adapter.ts";
import { isWindowKey } from "./window-key.ts";
import type { SessionInfo } from "./sessions.ts";
import { recordKey, type RecordProvider, type RecordSession } from "./records-types.ts";

export interface RecordSessionHint {
  sessionId: string;
  provider?: RecordProvider;
  nativeId?: string;
  transcriptPath?: string;
  cwd?: string;
}

/** Window IDs route input; the provider's session ID owns the durable history. */
export function recordSessionFor(
  ownerDeviceId: string,
  session: SessionInfo | undefined,
  hint: RecordSessionHint,
): RecordSession | undefined {
  const path = hint.transcriptPath ?? session?.transcriptPath;
  const provider = hint.provider ?? session?.backend ?? (path ? transcriptFormatFor(path) : session ? "claude" : undefined);
  const child = provider === "claude" ? path?.match(/\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/) : undefined;
  const nativeId = hint.nativeId ?? (child ? `${child[1]}/agent-${child[2]}` : session?.agentSessionId ?? session?.sessionId ?? hint.sessionId);
  if (!nativeId || isWindowKey(nativeId) || !provider) return undefined;
  return {
    id: recordKey(ownerDeviceId, provider, nativeId), ownerDeviceId, provider, nativeId,
    ...(session?.name ? { title: session.name } : {}),
    ...((hint.cwd ?? session?.cwd) ? { cwd: hint.cwd ?? session?.cwd } : {}),
    ...((child?.[1] ?? session?.parentSessionId) ? { parentNativeId: child?.[1] ?? session?.parentSessionId } : {}),
  };
}

/** Only known local window/sidechain aliases need the live inventory; indexed IDs pass through. */
export function historySessionAlias(ownerDeviceId: string, requested: string, session?: SessionInfo): string {
  if (requested.startsWith("[") || !session || session.sessionId !== requested) return requested;
  const record = recordSessionFor(ownerDeviceId, session, { sessionId: requested });
  return record && record.nativeId !== requested ? record.id : requested;
}

/**
 * A history read's session as the record knows it, resolved against the rows on screen —
 * sessions, and the agents listed under them (C4).
 *
 * An agent row is `agent-<id>` on the wire and `<parent>/agent-<id>` in the record, and only
 * its live entry (its transcript path) says which parent. Resolving against the sessions alone
 * left every agent row's read `session-not-found`: an agent past the published budget had no
 * live window and no history either, however much it had done.
 */
export function historySessionFor(
  ownerDeviceId: string,
  requested: string,
  live: { sessions: ReadonlyMap<string, SessionInfo>; agents: ReadonlyMap<string, SessionInfo> },
): string {
  return historySessionAlias(ownerDeviceId, requested, live.sessions.get(requested) ?? live.agents.get(requested));
}

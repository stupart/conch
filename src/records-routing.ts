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

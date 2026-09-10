import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONCH_CONFIG_DIR } from "./config.ts";
import type { DashboardMode, PanelConchState, PublishedState, SessionStatus } from "./panel.ts";

export const APP_ERRORS_PATH = join(CONCH_CONFIG_DIR, "errors.jsonl");
const MAX_APP_ERRORS_BYTES = 8 * 1024 * 1024;

export type ConchErrorSource = "ios" | "mac" | "daemon";

export interface ConchErrorInput {
  source: ConchErrorSource;
  operation: string;
  message: string;
  sessionId?: string;
  state?: Record<string, unknown>;
}

/**
 * What a record keeps of the daemon's state: enough to see what conch was
 * doing, not what everyone said. The record used to embed the whole
 * published document — conversations, replies, previews — so three errors
 * came to 462 KB and one was 400 KB on its own, which is a file nobody can
 * read and a rotation cap reached by a bad afternoon rather than a bad year.
 */
export interface DaemonStateDigest {
  v: 1;
  ts: number;
  mode: DashboardMode;
  live: { state: PanelConchState; label: string; partial?: string; level?: number };
  rows: Array<{
    id: string;
    label: string;
    backend?: "claude" | "codex";
    status: SessionStatus | null;
    active: boolean;
    paused: boolean;
    live: PanelConchState | null;
  }>;
  dismissed: string[];
}

export interface ConchErrorRecord extends ConchErrorInput {
  v: 1;
  at: string;
  daemonState: DaemonStateDigest | null;
}

export function digestDaemonState(state: PublishedState | null): DaemonStateDigest | null {
  if (!state) return null;
  return {
    v: 1,
    ts: state.ts,
    mode: state.mode,
    live: {
      state: state.live.state,
      label: state.live.label,
      ...(state.live.partial ? { partial: state.live.partial.slice(0, 200) } : {}),
      ...(state.live.level !== undefined ? { level: state.live.level } : {}),
    },
    rows: state.rows.map((row) => ({
      id: row.id,
      label: row.label,
      ...(row.backend ? { backend: row.backend } : {}),
      status: row.status,
      active: row.active,
      paused: row.paused,
      live: row.live,
    })),
    dismissed: state.dismissed,
  };
}

export function clipboardFallbackError(input: {
  sessionId: string;
  label: string;
  cwd?: string;
  reason?: string;
}): ConchErrorInput {
  const reason = input.reason || "unknown";
  return {
    source: "daemon",
    operation: "inject",
    message: `message landed on clipboard (${reason})`,
    sessionId: input.sessionId,
    state: {
      label: input.label,
      cwd: input.cwd ?? "",
      route: "clipboard",
      reason,
    },
  };
}

/** JSONL is deliberately append-only so a later watcher can tail it without owning daemon state. */
export function appendConchError(
  input: ConchErrorInput,
  daemonState: PublishedState | null,
  path = APP_ERRORS_PATH,
  now = new Date(),
): ConchErrorRecord {
  const record: ConchErrorRecord = {
    v: 1,
    at: now.toISOString(),
    source: input.source,
    operation: input.operation,
    message: input.message,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.state ? { state: input.state } : {}),
    daemonState: digestDaemonState(daemonState),
  };
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && statSync(path).size >= MAX_APP_ERRORS_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {}
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  try { chmodSync(path, 0o600); } catch {}
  return record;
}

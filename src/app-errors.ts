import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONCH_CONFIG_DIR } from "./config.ts";
import type { PublishedState } from "./panel.ts";

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

export interface ConchErrorRecord extends ConchErrorInput {
  v: 1;
  at: string;
  daemonState: PublishedState | null;
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
    daemonState,
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

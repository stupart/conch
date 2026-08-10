/**
 * What do Claude Code and Codex actually put in a transcript?
 *
 * Written after fixing three separate "conch renders this wrong" bugs one at a
 * time — tool results filed as user messages, Codex replies arriving as
 * `message` rather than `agent_message`, task notifications rendering as things
 * Tyler had said. Every one was found by a person noticing something wrong on
 * screen, which is the most expensive way there is to learn a schema.
 *
 * This reads the transcripts on this machine and prints the full type inventory
 * with counts, flagging the ones the conversation reducer ignores. Run it when
 * either tool ships a new format, or when something renders oddly:
 *
 *     bun tools/transcript-index.ts [fileCount]
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

/** Kept in step with `reduceClaudeLine`. */
const CLAUDE_HANDLED = new Set([
  "user:text",
  "user:tool_result",
  "assistant:text",
  "assistant:thinking",
  "assistant:tool_use",
  "user:image",
  "user:document",
]);

/** Kept in step with `reduceCodexLine`. */
const CODEX_HANDLED = new Set([
  "event_msg:user_message",
  "event_msg:agent_message",
  "response_item:agent_message",
  "response_item:message",
  "response_item:reasoning",
  "response_item:function_call",
  "response_item:function_call_output",
  "response_item:custom_tool_call",
  "response_item:custom_tool_call_output",
]);

function tally(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function scanClaude(limitFiles: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const root = join(homedir(), ".claude", "projects");
  const files: string[] = [];
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return counts;
  }
  for (const project of projects) {
    try {
      for (const name of readdirSync(join(root, project))) {
        if (name.endsWith(".jsonl")) files.push(join(root, project, name));
      }
    } catch {}
  }
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files.slice(0, limitFiles)) {
    let text: string;
    try {
      // Tail only — these run to hundreds of megabytes — but generously, and
      // with an EXPLICIT offset. Two traps here, both measured: a single Claude
      // entry can be megabytes (one large tool result), so a small tail can
      // contain no complete line at all; and `slice(-24_000_000)` returns ZERO
      // bytes on a 122 MB file, while the same read expressed as a positive
      // offset returns the tail correctly.
      const handle = Bun.file(file);
      text = await handle.slice(Math.max(0, handle.size - 24_000_000)).text();
    } catch {
      continue;
    }
    // Drop the first line, which a tail read almost always cuts in half.
    for (const line of text.split("\n").slice(1)) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const type = String(entry?.type ?? "?");
      const content = entry?.message?.content;
      if ((type === "user" || type === "assistant") && Array.isArray(content)) {
        for (const part of content) tally(counts, `${type}:${part?.type ?? "?"}`);
      } else if ((type === "user" || type === "assistant") && typeof content === "string") {
        tally(counts, `${type}:text`);
      } else {
        tally(counts, `${type}:—`);
      }
    }
  }
  return counts;
}

async function scanCodex(limitFiles: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const home = join(homedir(), ".codex");
  let paths: string[] = [];
  try {
    const db = new Database(`file:${join(home, "state_5.sqlite")}?immutable=1`, { readonly: true });
    db.query("SELECT 1").get(); // Bun opens lazily; force it so a failure lands here.
    paths = (db
      .query("SELECT rollout_path FROM threads WHERE archived = 0 ORDER BY updated_at_ms DESC LIMIT ?")
      .all(limitFiles) as any[])
      .map((row) => String(row.rollout_path))
      .filter(Boolean);
    db.close();
  } catch {
    return counts;
  }
  for (const path of paths) {
    let text: string;
    try {
      const handle = Bun.file(path);
      text = await handle.slice(Math.max(0, handle.size - 24_000_000)).text();
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      tally(counts, `${entry?.type ?? "?"}:${entry?.payload?.type ?? "—"}`);
    }
  }
  return counts;
}

function report(label: string, counts: Map<string, number>, handled: Set<string>): void {
  console.log(`\n${label}`);
  if (counts.size === 0) {
    console.log("  (nothing readable)");
    return;
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1]);
  let ignored = 0;
  for (const [key, n] of rows) {
    const known = handled.has(key);
    if (!known) ignored += n;
    console.log(`  ${known ? "  " : "!!"} ${key.padEnd(44)} ${String(n).padStart(8)}`);
  }
  console.log(`  ${rows.length} types · ${ignored} entries in types the reducer ignores`);
}

const files = Number(Bun.argv[2] ?? 12);
report("CLAUDE  entry:contentPart", await scanClaude(files), CLAUDE_HANDLED);
report("CODEX   type:payloadType", await scanCodex(files), CODEX_HANDLED);
console.log("\n!! marks a type the conversation reducer drops on the floor.");

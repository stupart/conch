/**
 * What one hook pays to learn its prompt mark, with and without a cursor.
 *
 * Fixtures only: it generates a transcript in a temporary directory and never
 * reads a real session or a running daemon's database.
 *
 *   bun scripts/bench-hook-mark.ts --mb 64 --turns 400
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptCursorPublisher } from "../src/prompt-cursor.ts";
import { RecordStore } from "../src/records-store.ts";
import { setPromptCursorSink, transcriptMark } from "../src/snippet.ts";

const argument = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const megabytes = argument("mb", 64);
const turns = argument("turns", 400);

const root = mkdtempSync(join(tmpdir(), "conch-hook-bench-"));
const transcriptPath = join(root, "session.jsonl");
const configDir = join(root, "config");

const padding = Math.max(1, Math.floor((megabytes * 1024 * 1024) / turns) - 220);
writeFileSync(transcriptPath, "");
for (let turn = 0; turn < turns; turn++) {
  appendFileSync(transcriptPath, JSON.stringify({
    type: "user", uuid: `u${turn}`, parentUuid: null, message: { role: "user", content: `ask ${turn}` },
  }) + "\n");
  appendFileSync(transcriptPath, JSON.stringify({
    type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${turn} ${"x".repeat(padding)}` }] },
  }) + "\n");
}
const size = statSync(transcriptPath).size;

// The daemon's half: it counts (as it already does today) and commits a cursor.
const store = new RecordStore({ configDir });
const publisher = promptCursorPublisher((cursor) => store.putPromptCursor(cursor));
setPromptCursorSink(publisher);
const truth = await transcriptMark(transcriptPath);
setPromptCursorSink(undefined);
store.close();

// Then a few more turns land, which is what a hook has to scan on top of it.
const appendedFrom = statSync(transcriptPath).size;
for (let turn = turns; turn < turns + 2; turn++) {
  appendFileSync(transcriptPath, JSON.stringify({
    type: "user", uuid: `u${turn}`, parentUuid: null, message: { role: "user", content: `ask ${turn}` },
  }) + "\n");
  appendFileSync(transcriptPath, JSON.stringify({
    type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${turn} ${"x".repeat(padding)}` }] },
  }) + "\n");
}

const child = join(root, "cold-hook.ts");
writeFileSync(child, `
import { open as openFile } from "node:fs/promises";
import { boundedMark, readPromptCursor } from ${JSON.stringify(join(import.meta.dir, "../src/prompt-cursor.ts"))};
import { createTranscriptReader, type TranscriptSource } from ${JSON.stringify(join(import.meta.dir, "../src/snippet.ts"))};

const [path, configDir, mode] = process.argv.slice(2);
let bytesRead = 0;
const counting: TranscriptSource = {
  async open(transcriptPath: string) {
    const handle = await openFile(transcriptPath, "r");
    const info = await handle.stat({ bigint: true });
    return {
      version: { size: Number(info.size), mtimeNs: String(info.mtimeNs), dev: String(info.dev), ino: String(info.ino) },
      async read(offset: number, length: number) {
        const bytes = new Uint8Array(length);
        let total = 0;
        while (total < length) {
          const { bytesRead: n } = await handle.read(bytes, total, length - total, offset + total);
          if (!n) break;
          total += n;
        }
        bytesRead += total;
        return bytes.subarray(0, total);
      },
      close: () => handle.close(),
    };
  },
};

const recordsEnabled = mode === "on";
const resume = recordsEnabled ? readPromptCursor(path, { configDir }) : null;
const started = performance.now();
const mark = await createTranscriptReader(counting).countUserPrompts(path, resume ?? undefined);
const readMs = performance.now() - started;

const endToEndStart = performance.now();
const hookMark = await boundedMark({ recordsEnabled }, path, { configDir });
const endToEndMs = performance.now() - endToEndStart;

console.log(JSON.stringify({ mark, hookMark, bytesRead, readMs, endToEndMs, resumedFrom: resume?.from ?? 0 }));
`);

const run = (mode: "on" | "off") => {
  const result = Bun.spawnSync(["bun", "run", child, transcriptPath, configDir, mode], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`cold hook (${mode}) failed: ${result.stderr.toString()}`);
  return JSON.parse(result.stdout.toString().trim());
};

const off = run("off");
const on = run("on");

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const count = (bytes: number) => `${bytes.toLocaleString("en-US")} bytes (${mb(bytes)})`;
const lines = statSync(transcriptPath).size && truth * 2 + 4;
console.log(`fixture: ${count(size)}, ${truth} prompts, about ${lines} lines, cursor at ${count(appendedFrom)}, then 2 more turns`);
console.log(`records OFF  mark=${off.mark} read=${count(off.bytesRead)} count=${off.readMs.toFixed(0)}ms hook=${off.endToEndMs.toFixed(0)}ms`);
console.log(`records ON   mark=${on.mark} read=${count(on.bytesRead)} count=${on.readMs.toFixed(0)}ms hook=${on.endToEndMs.toFixed(0)}ms (resumed at ${count(on.resumedFrom)})`);
if (off.mark !== on.mark || off.hookMark !== on.hookMark || off.mark !== off.hookMark) {
  throw new Error(`marks disagree: ${JSON.stringify({ off, on })}`);
}
console.log(`identical marks: ${on.mark}`);
rmSync(root, { recursive: true, force: true });

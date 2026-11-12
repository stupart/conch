import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachCanvasCounts,
  attachSidechainPaths,
  buildConversation,
  conversationTailParses,
  emptyConversation,
  keepConversationTails,
  readConversationTail,
  reduceClaudeLine,
  reduceCodexLine,
  selectWindowBranch,
  withHeldQuestion,
  type Conversation,
  type ConversationFormat,
  type WindowIdentity,
} from "../src/conversation.ts";
import { conchHome } from "../src/home.ts";
import { isWindowKey } from "../src/window-key.ts";

// The daemon keeps the published transcripts' tails parsed between renders (`keepConversationTails`): an unchanged one
// is not read again, and one that grew is parsed from where it ended. These pin that a kept read is exactly the read
// it replaced, whatever happened to the file in between.

const dir = mkdtempSync(join(tmpdir(), "conch-tail-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => keepConversationTails([]));

/** `readConversationTail(path, id, format, { window, tailBytes })` as it read before tails were kept, line for line. */
async function freshRead(
  path: string,
  sessionId: string,
  format: ConversationFormat,
  tailBytes: number,
  window?: WindowIdentity,
): Promise<Conversation> {
  const file = Bun.file(path);
  const size = file.size;
  if (!size) return emptyConversation(sessionId);
  const start = Math.max(0, size - tailBytes);
  let lines: readonly string[] = (await file.slice(start).text()).split("\n");
  if (start > 0) lines = lines.slice(1);
  let shared = false;
  if (format === "claude" && window && isWindowKey(sessionId)) ({ lines, shared } = selectWindowBranch(lines, window));
  const conversation = emptyConversation(sessionId);
  const reduce = format === "codex" ? reduceCodexLine : reduceClaudeLine;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      reduce(conversation, JSON.parse(trimmed));
    } catch {}
  }
  if (shared) conversation.shared = true;
  if (format === "claude") attachSidechainPaths(conversation, path);
  await attachCanvasCounts(conversation);
  return conversation;
}

async function expectSameRead(
  path: string,
  sessionId: string,
  format: ConversationFormat,
  tailBytes: number,
  window?: WindowIdentity,
): Promise<Conversation> {
  const kept = await readConversationTail(path, sessionId, format, { window, tailBytes });
  expect(kept).toStrictEqual(await freshRead(path, sessionId, format, tailBytes, window));
  return kept;
}

/** Lines parsed by `run`. */
async function parsed(run: () => Promise<unknown>): Promise<number> {
  const before = conversationTailParses.lines;
  await run();
  return conversationTailParses.lines - before;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const at = (n: number) => new Date(Date.UTC(2026, 10, 2, 9, 0, n)).toISOString();

/** Claude records of every shape the reducer folds, and the ones it must survive: blank, torn, CRLF, non-ASCII. */
function claudeRecord(n: number, random: () => number): string {
  const words = (count: number) => Array.from({ length: count }, (_, i) => `w${(n * 31 + i) % 97}`).join(" ");
  switch (Math.floor(random() * 12)) {
    case 0:
      return JSON.stringify({ type: "user", uuid: `u${n}`, timestamp: at(n), message: { content: `ask ${n}: ${words(1 + Math.floor(random() * 40))}` } });
    case 1:
      return JSON.stringify({
        type: "assistant", uuid: `a${n}`, timestamp: at(n),
        message: { content: [{ type: "thinking", thinking: `thinking ${n}` }, { type: "text", text: `answer ${n} — héllo 日本語 🎉` }] },
      });
    case 2:
      return JSON.stringify({
        type: "assistant", uuid: `a${n}`, timestamp: at(n),
        message: { content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: { command: `ls ${n}` } }] },
      });
    case 3:
      return JSON.stringify({
        type: "user", uuid: `r${n}`, timestamp: at(n),
        message: { content: [{ type: "tool_result", tool_use_id: `t${n - 1 - Math.floor(random() * 4)}`, content: "ok ".repeat(Math.floor(random() * 3000)) }] },
      });
    case 4:
      return [
        JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: at(n), message: { content: [{ type: "tool_use", id: `g${n}`, name: "Agent", input: { description: `agent ${n}` } }] } }),
        JSON.stringify({
          type: "user", uuid: `r${n}`, timestamp: at(n), toolUseResult: { agentId: `x${n}`, isAsync: true },
          message: { content: [{ type: "tool_result", tool_use_id: `g${n}`, content: "launched" }] },
        }),
      ].join("\n");
    case 5:
      return JSON.stringify({
        type: "queue-operation", timestamp: at(n),
        content: `<task-notification><task-id>x${n - 1 - Math.floor(random() * 6)}</task-id><status>completed</status></task-notification>`,
      });
    case 6:
      return JSON.stringify({
        type: "attachment", uuid: `q${n}`, timestamp: at(n),
        attachment: { type: "queued_command", origin: { kind: "human" }, prompt: `queued ${n}`, source_uuid: `s${n}` },
      });
    case 7:
      return JSON.stringify({
        type: "user", uuid: `i${n}`, timestamp: at(n),
        message: { content: [{ type: "image", source: { media_type: "image/png", data: "iVBORw0KGgo".repeat(1 + Math.floor(random() * 50)) } }, { type: "text", text: `[Image #${n}] look` }] },
      });
    case 8:
      return "";
    case 9:
      return `{"type":"user","uuid":"torn${n}","message":{"content":"never fin`;
    case 10:
      return `${JSON.stringify({ type: "user", uuid: `c${n}`, timestamp: at(n), message: { content: `crlf ${n}` } })}\r`;
    default:
      return JSON.stringify({ type: "progress", uuid: `p${n}`, timestamp: at(n), data: words(Math.floor(random() * 200)) });
  }
}

function codexRecord(n: number, random: () => number): string {
  const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(n), type, payload });
  switch (Math.floor(random() * 7)) {
    case 0:
      return line("event_msg", { type: "user_message", message: `ask ${n}` });
    case 1:
      return line("event_msg", { type: "agent_message", message: `answer ${n} ✓` });
    case 2:
      return line("response_item", { type: "function_call", call_id: `c${n}`, name: "shell", arguments: JSON.stringify({ command: ["ls", `${n}`] }) });
    case 3:
      return line("response_item", { type: "function_call_output", call_id: `c${n - 1}`, output: "x".repeat(Math.floor(random() * 5000)) });
    case 4:
      return line("event_msg", { type: "task_started", turn_id: `turn${n}` });
    case 5:
      return line("response_item", { type: "reasoning", summary: [{ text: `reasoned ${n}` }] });
    default:
      return line("event_msg", { type: "token_count", info: null });
  }
}

describe("a kept tail reads exactly as a fresh one", () => {
  for (const format of ["claude", "codex"] as const) {
    test(`${format}: through appends cut anywhere (mid-line, mid-character), at several depths in any order`, async () => {
      const random = seeded(format === "claude" ? 7 : 11);
      const record = format === "claude" ? claudeRecord : codexRecord;
      const path = join(dir, format === "claude" ? "appends.jsonl" : "rollout-2026-11-02T09-00-00-appends.jsonl");
      // Everything that will ever be written, appended to the file a random number of bytes at a time.
      const whole = Buffer.from(Array.from({ length: 1200 }, (_, n) => record(n, random)).join("\n") + "\n");
      let written = 0;
      writeFileSync(path, whole.subarray(0, (written = 2048)));
      keepConversationTails([path]);
      // The deepest is far short of the file, so lines are let go from the front as it grows.
      const depths = [300, 4096, 65_536];
      for (let step = 0; written < whole.length; step++) {
        const next = Math.min(whole.length, written + 1 + Math.floor(random() ** 3 * 40_000));
        appendFileSync(path, whole.subarray(written, next));
        written = next;
        const order = [...depths].sort(() => random() - 0.5);
        for (const depth of order) await expectSameRead(path, "s", format, depth);
      }
    });
  }

  test("a read that starts exactly where a line does drops that line, as the cut fragment it is taken for", async () => {
    const random = seeded(21);
    const path = join(dir, "boundary.jsonl");
    const text = Array.from({ length: 80 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n";
    writeFileSync(path, text);
    keepConversationTails([path]);
    const size = Buffer.byteLength(text);
    const starts: number[] = [];
    for (let at = Buffer.from(text).indexOf(0x0a); at !== -1 && at + 1 < size; at = Buffer.from(text).indexOf(0x0a, at + 1)) starts.push(at + 1);
    for (const start of starts.slice(-30)) await expectSameRead(path, "s", "claude", size - start);
  });

  test("a last line with no newline after it yet is read when it is whole, and again once it ends", async () => {
    const path = join(dir, "unended.jsonl");
    const record = (n: number) => JSON.stringify({ type: "user", uuid: `u${n}`, message: { content: `said ${n}` } });
    writeFileSync(path, record(1));
    keepConversationTails([path]);
    expect((await expectSameRead(path, "s", "claude", 4096)).order).toEqual(["u1"]);
    appendFileSync(path, `\n${record(2)}`);
    expect((await expectSameRead(path, "s", "claude", 4096)).order).toEqual(["u1", "u2"]);
    appendFileSync(path, `\n${record(3).slice(0, 10)}`);
    expect((await expectSameRead(path, "s", "claude", 4096)).order).toEqual(["u1", "u2"]);
    appendFileSync(path, `${record(3).slice(10)}\n`);
    expect((await expectSameRead(path, "s", "claude", 4096)).order).toEqual(["u1", "u2", "u3"]);
  });

  test("an unchanged transcript is not parsed again, and a grown one only for what was appended", async () => {
    const random = seeded(3);
    const path = join(dir, "counted.jsonl");
    writeFileSync(path, Array.from({ length: 200 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n");
    keepConversationTails([path]);
    expect(await parsed(() => expectSameRead(path, "s", "claude", 1 << 20))).toBeGreaterThan(100);
    // The same file, read again: nothing parsed. A different session id over the same file is a new build of the
    // lines already parsed, still nothing.
    expect(await parsed(() => readConversationTail(path, "s", "claude", { tailBytes: 1 << 20 }))).toBe(0);
    expect(await parsed(() => expectSameRead(path, "other", "claude", 1 << 20))).toBe(0);
    // Three whole lines appended: those three, and the empty line after the last newline.
    appendFileSync(path, [200, 201, 202].map((n) => `${JSON.stringify({ type: "user", uuid: `n${n}`, message: { content: `new ${n}` } })}\n`).join(""));
    expect(await parsed(() => expectSameRead(path, "s", "claude", 1 << 20))).toBe(4);
  });

  test("an unchanged kept transcript, read as it was built, is not opened: one stat", async () => {
    const random = seeded(4);
    const path = join(dir, "unopened.jsonl");
    writeFileSync(path, Array.from({ length: 40 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n");
    keepConversationTails([path]);
    const first = await readConversationTail(path, "s", "claude", { tailBytes: 1 << 20 });
    const opens = spyOn(fs, "openSync");
    try {
      expect(await readConversationTail(path, "s", "claude", { tailBytes: 1 << 20 })).toEqual(first);
      expect(opens).not.toHaveBeenCalled();
      // Grown: opened, and read from where it ended.
      appendFileSync(path, `${JSON.stringify({ type: "user", uuid: "late", message: { content: "late" } })}\n`);
      expect((await expectSameRead(path, "s", "claude", 1 << 20)).order.at(-1)).toBe("late");
      expect(opens).toHaveBeenCalled();
    } finally {
      opens.mockRestore();
    }
  });

  test("a read that reaches further back parses only the lines in front of what it holds", async () => {
    const random = seeded(5);
    const path = join(dir, "deeper.jsonl");
    writeFileSync(path, Array.from({ length: 300 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n");
    keepConversationTails([path]);
    await expectSameRead(path, "s", "claude", 8192);
    const deeper = await parsed(() => expectSameRead(path, "s", "claude", 32_768));
    const fresh = await parsed(async () => {
      keepConversationTails([]);
      await readConversationTail(path, "s", "claude", { tailBytes: 32_768 });
    });
    expect(deeper).toBeLessThan(fresh);
    keepConversationTails([path]);
    await expectSameRead(path, "s", "claude", 32_768);
    expect(await parsed(() => expectSameRead(path, "s", "claude", 8192))).toBe(0);
  });

  test("a file cut short, replaced by another (a new inode), or rewritten in place reads afresh", async () => {
    const random = seeded(9);
    const path = join(dir, "replaced.jsonl");
    const content = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => claudeRecord(from + n, random)).join("\n") + "\n";
    writeFileSync(path, content(0, 120));
    keepConversationTails([path]);
    await expectSameRead(path, "s", "claude", 16_384);

    // Shrunk.
    truncateSync(path, Math.floor(statSync(path).size / 2));
    await expectSameRead(path, "s", "claude", 16_384);

    // Replaced: a new file renamed over it, longer, so it would pass for an append on size alone.
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, content(500, 200));
    const ino = statSync(path).ino;
    renameSync(replacement, path);
    expect(statSync(path).ino).not.toBe(ino);
    await expectSameRead(path, "s", "claude", 16_384);

    // Rewritten in place to the same length, and in place to a longer one that does not start with what was read:
    // a short line put in front, so the window still spans what was parsed before at the old offsets.
    const same = Buffer.from(content(900, 200));
    writeFileSync(path, same);
    await expectSameRead(path, "s", "claude", 16_384);
    writeFileSync(path, Buffer.concat([Buffer.from(`${JSON.stringify({ type: "user", uuid: "front", message: { content: "x" } })}\n`), same]));
    await expectSameRead(path, "s", "claude", 16_384);
    writeFileSync(path, Buffer.concat([Buffer.from(content(1300, 50)), same]));
    await expectSameRead(path, "s", "claude", 16_384);

    // Rewritten in place, longer, with the last line read changed: what was parsed from it is stale.
    writeFileSync(path, same);
    await expectSameRead(path, "s", "claude", 16_384);
    const lastLine = same.lastIndexOf(0x0a, same.length - 2) + 1;
    writeFileSync(path, Buffer.concat([
      same.subarray(0, lastLine),
      Buffer.from(`${JSON.stringify({ type: "user", uuid: "changed", message: { content: "a different last line" } })}\n`),
      Buffer.from(content(1400, 3)),
      Buffer.from("x".repeat(same.length - lastLine)),
    ]));
    expect(statSync(path).size).toBeGreaterThan(same.length);
    await expectSameRead(path, "s", "claude", 16_384);

    // Emptied, then written again.
    writeFileSync(path, "");
    await expectSameRead(path, "s", "claude", 16_384);
    writeFileSync(path, content(2000, 10));
    await expectSameRead(path, "s", "claude", 16_384);
  });

  test("what a caller adds to its copy is never seen by the next read", async () => {
    const path = join(dir, "isolated.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "user", uuid: "u1", message: { content: "pick one" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n") + "\n");
    keepConversationTails([path]);
    const first = await expectSameRead(path, "s", "claude", 4096);
    withHeldQuestion(first, { id: "held", questions: [{ header: "", question: "Which?", options: [{ label: "A" }], multiSelect: false }] });
    expect(first.order).toContain("tool:held");
    const second = await expectSameRead(path, "s", "claude", 4096);
    expect(second.order).not.toContain("tool:held");
    expect(second.items).not.toHaveProperty("tool:held");
  });

  test("only the transcripts named are kept, and a transcript no longer named is let go", async () => {
    const random = seeded(13);
    const kept = join(dir, "named.jsonl");
    const other = join(dir, "unnamed.jsonl");
    for (const path of [kept, other]) writeFileSync(path, Array.from({ length: 50 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n");
    keepConversationTails([kept]);
    await expectSameRead(kept, "s", "claude", 1 << 20);
    await expectSameRead(other, "s", "claude", 1 << 20);
    expect(await parsed(() => expectSameRead(kept, "s", "claude", 1 << 20))).toBe(0);
    expect(await parsed(() => readConversationTail(other, "s", "claude", { tailBytes: 1 << 20 }))).toBeGreaterThan(0);
    keepConversationTails([other]);
    expect(await parsed(() => expectSameRead(kept, "s", "claude", 1 << 20))).toBeGreaterThan(0);
  });

  test("past the byte budget the widest tail lets its lines go, and still reads the same", async () => {
    const random = seeded(17);
    const wide = join(dir, "wide.jsonl");
    const narrow = join(dir, "narrow.jsonl");
    writeFileSync(wide, Array.from({ length: 400 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n");
    writeFileSync(narrow, Array.from({ length: 20 }, (_, n) => claudeRecord(n, random)).join("\n") + "\n");
    keepConversationTails([wide, narrow], statSync(narrow).size + 1024);
    await expectSameRead(narrow, "s", "claude", 1 << 20);
    await expectSameRead(wide, "s", "claude", 1 << 20);
    // Unchanged, both are answered from their builds.
    expect(await parsed(() => expectSameRead(wide, "s", "claude", 1 << 20))).toBe(0);
    expect(await parsed(() => expectSameRead(narrow, "s", "claude", 1 << 20))).toBe(0);
    // Grown, the narrow one parses what was appended; the wide one, its lines let go, reads afresh.
    for (const path of [wide, narrow]) appendFileSync(path, `${JSON.stringify({ type: "user", uuid: "late", message: { content: "late" } })}\n`);
    expect(await parsed(() => expectSameRead(narrow, "s", "claude", 1 << 20))).toBe(2);
    expect(await parsed(() => expectSameRead(wide, "s", "claude", 1 << 20))).toBeGreaterThan(300);
    // And a read at a new depth of an unchanged, let-go tail.
    await expectSameRead(wide, "s", "claude", 4096);
  });

  test("a file that begins with a byte-order mark reads as Blob.text() decoded it", async () => {
    const path = join(dir, "bom.jsonl");
    writeFileSync(path, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(`${JSON.stringify({ type: "user", uuid: "u1", message: { content: "first" } })}\n`),
    ]));
    keepConversationTails([path]);
    await expectSameRead(path, "s", "claude", 4096);
    appendFileSync(path, `${JSON.stringify({ type: "user", uuid: "u2", message: { content: "second" } })}\n`);
    await expectSameRead(path, "s", "claude", 4096);
  });
});

describe("canvas counts are put on every read, never kept with the build", () => {
  const canvasRoot = join(conchHome(), ".cache", "conch", "canvas");
  const ID = "6C4E1A3F-0D52-4B8E-9A21-3E7C8B2D0F55";
  const folder = join(canvasRoot, ID);
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const canvasMessage = (id: string) => [
    join(canvasRoot, id, "flat.png"),
    "[canvas] Tyler marked up Invite page (http://localhost:3000/invite).",
    '1. box (62%,18%): "make this bigger"',
    `Clean screen + marks: ${join(canvasRoot, id, "raw.png")}, ${join(canvasRoot, id, "canvas.json")}`,
    `To mark your answer on this canvas, frame your marks {canvas: "${id}"}.`,
  ].join("\n");

  test("counts that appear after a read show on the next read of the unchanged transcript", async () => {
    const path = join(dir, "canvas.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "user", uuid: "u1", message: { content: canvasMessage(ID) } })}\n`);
    keepConversationTails([path]);
    const before = await expectSameRead(path, "s", "claude", 4096);
    expect(before.items.u1?.receipt?.detail).not.toContain("mark");

    // The canvas's marks land, and its remembered "no canvas.json" is pushed out by 256 other canvases.
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "canvas.json"), JSON.stringify({
      v: 1, id: ID, marks: [{ kind: "box", author: "you" }, { kind: "note", author: "you", text: "bigger" }],
    }));
    const others = Array.from({ length: 256 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    await attachCanvasCounts(buildConversation("flood", others.map((id, n) =>
      JSON.stringify({ type: "user", uuid: `f${n}`, message: { content: canvasMessage(id) } })), "claude"));

    expect(await parsed(async () => {
      const after = await expectSameRead(path, "s", "claude", 4096);
      expect(after.items.u1?.receipt?.detail).toStartWith("1 mark · 1 note");
    })).toBe(0);
    // The count went on the read's own row: the next read still matches a fresh one.
    await expectSameRead(path, "s", "claude", 4096);
  });
});

describe("one window's branch of a shared transcript", () => {
  const SESSION = "4eb30ede-6c1e-4f5a-9d2b-1f0c2a3b4c5d";
  const KEY_A = `${SESSION}#39889`;
  const BRIDGE_A = "01AVNxcSSv8WYQiPjYsXYH2L";
  const BRIDGE_B = "01SfEX6bfwCGXtThk1JRNmsE";
  const clock = (time: string) => `2026-09-11T${time}:00.000Z`;
  const preamble = (leafUuid: string, bridge: string) => [
    { type: "last-prompt", leafUuid, sessionId: SESSION },
    { type: "bridge-session", sessionId: SESSION, bridgeSessionId: `cse_${bridge}` },
  ];
  const user = (uuid: string, parentUuid: string | null, text: string, time: string) =>
    ({ parentUuid, type: "user", message: { role: "user", content: text }, uuid, timestamp: clock(time), sessionId: SESSION });
  const assistant = (uuid: string, parentUuid: string, text: string, time: string) =>
    ({ parentUuid, type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, uuid, timestamp: clock(time), sessionId: SESSION });
  const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

  test("is read from the kept lines exactly as from the file, for each window, as both windows write", async () => {
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, lines(
      ...preamble("u1", BRIDGE_A), user("u1", null, "shared question", "10:00"),
      ...preamble("u1", BRIDGE_A), assistant("a1", "u1", "shared answer", "10:01"),
      ...preamble("a1", BRIDGE_B), user("u2", "a1", "B asks", "10:05"),
      ...preamble("u2", BRIDGE_B), assistant("a2", "u2", "B answer", "10:06"),
      ...preamble("a1", BRIDGE_A), user("u3", "a1", "A asks", "10:07"),
      ...preamble("u3", BRIDGE_A), assistant("a3", "u3", "A answer", "10:08"),
    ));
    keepConversationTails([path]);
    const windowA = { bridgeSessionId: `session_${BRIDGE_A}`, startedAt: Date.parse(clock("09:00")) };
    const windowB = { bridgeSessionId: `session_${BRIDGE_B}`, startedAt: Date.parse(clock("10:04")) };
    const unsure = { startedAt: Date.parse(clock("09:00")) };
    const read = async () => ({
      a: await expectSameRead(path, KEY_A, "claude", 1 << 20, windowA),
      b: await expectSameRead(path, KEY_A, "claude", 1 << 20, windowB),
      unsure: await expectSameRead(path, KEY_A, "claude", 1 << 20, unsure),
      // The plain id is the whole file, whatever window rides along.
      plain: await expectSameRead(path, SESSION, "claude", 1 << 20, windowA),
    });
    const first = await read();
    expect(first.a.order).toContain("a3");
    expect(first.a.order).not.toContain("a2");
    expect(first.b.order).toContain("a2");
    expect(first.unsure.shared).toBe(true);
    expect(first.plain.order).toContain("a2");
    // B writes again; every window's read follows.
    appendFileSync(path, lines(...preamble("a2", BRIDGE_B), user("u4", "a2", "B asks again", "10:20"), assistant("a4", "u4", "B latest", "10:21")));
    const second = await read();
    expect(second.b.order).toContain("a4");
    expect(second.a.order).not.toContain("a4");
    // A line of B's ending in a no-break space: trimmed, the reducer reads it, but as written it is not JSON, so the
    // branch selector has always let it through to A as a line with no uuid. Kept lines keep that quirk.
    appendFileSync(path, `${JSON.stringify(assistant("a5", "a4", "B with a trailing nbsp", "10:22"))}\u00a0\n`);
    const third = await read();
    expect(third.a.order).toContain("a5");
  });

  test("a byte-order mark at the top of the file is dropped before the branch is chosen, as Blob.text() drops it", async () => {
    const path = join(dir, `${SESSION}-bom.jsonl`);
    // B's lone record first, behind a byte-order mark: on no chain of A's, so A's branch leaves it out.
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines(
      user("u0", null, "B's own root", "09:30"),
      ...preamble("u1", BRIDGE_A), user("u1", null, "A asks", "10:00"),
      ...preamble("u1", BRIDGE_A), assistant("a1", "u1", "A answer", "10:01"),
    ))]));
    keepConversationTails([path]);
    const windowA = { bridgeSessionId: `session_${BRIDGE_A}` };
    const read = await expectSameRead(path, KEY_A, "claude", 1 << 20, windowA);
    expect(read.order).not.toContain("u0");
    expect(read.order).toContain("a1");
  });
});

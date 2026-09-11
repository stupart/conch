import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConversation,
  conversationWindow,
  lastAssistantReply,
  publishedConversation,
  readConversationTail,
  selectWindowBranch,
  SHARED_WINDOW_NOTE,
  withSharedNote,
  type Conversation,
} from "../src/conversation.ts";
import { defaultMcpDependencies } from "../src/mcp.ts";
import { countCoveredSentences } from "../src/snippet.ts";
import { registrySnapshot } from "../src/sessions.ts";

/**
 * A8: two windows, one transcript.
 *
 * Every record shape below is lifted from a Claude Code 2.1.266 transcript
 * read on 2026-09-11 (`37426f84…`, pid 43544): before each model call the
 * window writes a preamble — `last-prompt {leafUuid}`, `mode`,
 * `permission-mode`, `atis-latch`, `bridge-session {bridgeSessionId:
 * "cse_<s>"}` — and its registry entry carries `bridgeSessionId:
 * "session_<s>"`. Messages chain by `parentUuid`. No transcript on that Mac
 * had two live windows at the time, so the two-window shape is constructed
 * from those parts exactly as `claude --resume` produces it: a shared prefix,
 * then two branches forking from one leaf.
 */
const SESSION = "4eb30ede-6c1e-4f5a-9d2b-1f0c2a3b4c5d";
const KEY_A = `${SESSION}#39889`;
const KEY_B = `${SESSION}#21210`;
const BRIDGE_A = "01AVNxcSSv8WYQiPjYsXYH2L";
const BRIDGE_B = "01SfEX6bfwCGXtThk1JRNmsE";
const at = (clock: string) => `2026-09-11T${clock}:00.000Z`;
const ms = (clock: string) => Date.parse(at(clock));

const preamble = (leafUuid: string, bridge?: string) => [
  { type: "last-prompt", leafUuid, sessionId: SESSION },
  { type: "mode", mode: "normal", sessionId: SESSION },
  { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: SESSION },
  { type: "atis-latch", atis: "", sessionId: SESSION },
  ...(bridge
    ? [{
      type: "bridge-session",
      sessionId: SESSION,
      bridgeSessionId: `cse_${bridge}`,
      lastSequenceNum: 0,
      ownerAccountUuid: "5f84ce23-59c1-48fc-876b-49acdc232e46",
      ownerOrganizationUuid: "99958ebf-d07f-4576-ad7c-508422eb882a",
    }]
    : []),
];
const user = (uuid: string, parentUuid: string | null, text: string, clock: string, cwd: string) => ({
  parentUuid, isSidechain: false, userType: "external", cwd, sessionId: SESSION, version: "2.1.266",
  type: "user", message: { role: "user", content: text }, uuid, timestamp: at(clock), promptId: `p-${uuid}`,
});
const assistant = (uuid: string, parentUuid: string, text: string, clock: string, cwd: string) => ({
  parentUuid, isSidechain: false, cwd, sessionId: SESSION, version: "2.1.266",
  type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, uuid, timestamp: at(clock),
});
const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));

/**
 * Window A (`~/arch-website`) starts the session; B resumes it and forks at
 * A's reply; A carries on from the same leaf; B writes last. The `cwd` on
 * each record is deliberately the OTHER window's directory — a session's cwd
 * moves as it `cd`s (one real window wrote three), so it must never decide.
 */
function twoWindows(bridges: boolean): string[] {
  const a = bridges ? BRIDGE_A : undefined;
  const b = bridges ? BRIDGE_B : undefined;
  return lines(
    ...preamble("u1", a), user("u1", null, "shared question", "10:00", "/Users/t/arch-website"),
    ...preamble("u1", a), assistant("a1", "u1", "shared answer", "10:01", "/Users/t/arch-website"),
    ...preamble("a1", b), user("u2", "a1", "B asks", "10:05", "/Users/t/arch-website"),
    ...preamble("u2", b), assistant("a2", "u2", "B answer", "10:06", "/Users/t/arch-website"),
    ...preamble("a1", a), user("u3", "a1", "A asks", "10:07", "/Users/t/arch-swap"),
    ...preamble("u3", a), assistant("a3", "u3", "A answer", "10:08", "/Users/t/arch-swap"),
    ...preamble("a2", b), user("u4", "a2", "B asks again", "10:20", "/Users/t/arch-website"),
    ...preamble("u4", b), assistant("a4", "u4", "B latest", "10:21", "/Users/t/arch-website"),
  );
}

const texts = (conversation: Conversation) => conversationWindow(conversation, 20).map((item) => item.text);
const pick = (transcript: string[], window: Parameters<typeof selectWindowBranch>[1]) => {
  const { lines: chosen, shared } = selectWindowBranch(transcript, window);
  return { texts: texts(buildConversation(KEY_A, chosen, "claude")), shared };
};

describe("which branch of a shared transcript is this window's", () => {
  test("the bridge id picks each window's own branch, and recency would have picked wrong", () => {
    const transcript = twoWindows(true);
    // B wrote last. A's branch is still A's — with recency the pane showed
    // `arch site` displaying arch-swap's work, which is the bug.
    expect(pick(transcript, { bridgeSessionId: `session_${BRIDGE_A}`, startedAt: ms("09:00") }))
      .toEqual({ texts: ["shared question", "shared answer", "A asks", "A answer"], shared: false });
    expect(pick(transcript, { bridgeSessionId: `session_${BRIDGE_B}`, startedAt: ms("09:00") }))
      .toEqual({ texts: ["shared question", "shared answer", "B asks", "B answer", "B asks again", "B latest"], shared: false });
  });

  test("a window idle since the other resumed keeps its own history, not the other's work", () => {
    // The reported shape exactly: `arch site` had gone quiet, arch-swap
    // resumed from its leaf and worked on. There is only one leaf in the file
    // — B's — so "the chain with its own leaf" alone would hand A that work.
    const transcript = lines(
      ...preamble("u1", BRIDGE_A), user("u1", null, "shared question", "10:00", "/Users/t/arch-website"),
      ...preamble("u1", BRIDGE_A), assistant("a1", "u1", "shared answer", "10:01", "/Users/t/arch-website"),
      ...preamble("a1", BRIDGE_B), user("u2", "a1", "B asks", "10:05", "/Users/t/arch-swap"),
      ...preamble("u2", BRIDGE_B), assistant("a2", "u2", "B answer", "10:06", "/Users/t/arch-swap"),
      ...preamble("a2", BRIDGE_B), user("u4", "a2", "B asks again", "10:20", "/Users/t/arch-swap"),
      ...preamble("u4", BRIDGE_B), assistant("a4", "u4", "B latest", "10:21", "/Users/t/arch-swap"),
    );
    expect(pick(transcript, { bridgeSessionId: `session_${BRIDGE_A}` }))
      .toEqual({ texts: ["shared question", "shared answer"], shared: false });
    expect(pick(transcript, { bridgeSessionId: `session_${BRIDGE_B}` }))
      .toEqual({ texts: ["shared question", "shared answer", "B asks", "B answer", "B asks again", "B latest"], shared: false });
  });

  test("without bridge records, only a lone leaf newer than the window's start decides", () => {
    const transcript = twoWindows(false);
    // B started after A's branch went quiet: exactly one leaf is newer than
    // B's start, so that is B's. A predates both leaves — nothing exact says
    // which is A's, so A gets the whole file, marked shared, not a guess.
    expect(pick(transcript, { startedAt: ms("10:10") }))
      .toEqual({ texts: ["shared question", "shared answer", "B asks", "B answer", "B asks again", "B latest"], shared: false });
    expect(pick(transcript, { startedAt: ms("09:00") })).toEqual({
      texts: ["shared question", "shared answer", "B asks", "B answer", "A asks", "A answer", "B asks again", "B latest"],
      shared: true,
    });
    // A registry bridge id the transcript never wrote (a window whose calls
    // all predate the tail) falls through to the same rule, never to recency.
    expect(pick(transcript, { bridgeSessionId: "session_ZZZ", startedAt: ms("09:00" ) }).shared).toBe(true);
    expect(pick(transcript, { bridgeSessionId: "session_ZZZ", startedAt: ms("10:10") }).texts).toContain("B latest");
    // No signal at all: shared, and honest about it.
    expect(pick(transcript, {}).shared).toBe(true);
  });

  test("the selector never reads cwd, and the loader only selects for a window key", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "conversation.ts"), "utf8");
    const selector = source.slice(
      source.indexOf("export function selectWindowBranch("),
      source.indexOf("export function lastAssistantReply("),
    );
    expect(selector.length).toBeGreaterThan(0);
    expect(selector).not.toMatch(/cwd/);
    // The branch is chosen only when the key names a window; a lone session
    // reads exactly as it always has, even with a dead branch from a rewind.
    const loader = source.slice(source.indexOf("export async function readConversationTail("));
    expect(loader).toContain("options.window && isWindowKey(sessionId)");
    expect(loader.indexOf("isWindowKey(sessionId)")).toBeLessThan(loader.indexOf("selectWindowBranch(lines, options.window)"));

    const dir = mkdtempSync(join(tmpdir(), "conch-a8-"));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, twoWindows(true).join("\n") + "\n");
    const plain = await readConversationTail(path, SESSION, "claude", {
      window: { bridgeSessionId: `session_${BRIDGE_A}` },
    });
    expect(plain.shared).toBeUndefined();
    expect(texts(plain)).toHaveLength(8);
    const windowA = await readConversationTail(path, KEY_A, "claude", {
      window: { bridgeSessionId: `session_${BRIDGE_A}`, startedAt: ms("09:00") },
    });
    expect(texts(windowA)).toEqual(["shared question", "shared answer", "A asks", "A answer"]);
    expect(windowA.shared).toBeUndefined();
    const unsure = await readConversationTail(path, KEY_A, "claude", { window: { startedAt: ms("09:00") } });
    expect(unsure.shared).toBe(true);
    // The note rides the wire, and only when it is true.
    expect(publishedConversation(unsure).shared).toBe(true);
    expect(publishedConversation(windowA)).not.toHaveProperty("shared");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the registry's per-window field", () => {
  test("bridgeSessionId reaches the row; null (a parked window) and absent (older versions) do not", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "conch-a8-registry-"));
    mkdirSync(join(claudeDir, "sessions"), { recursive: true });
    const write = (pid: number, bridge: unknown) =>
      writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({
        pid, sessionId: SESSION, name: `w${pid}`, startedAt: pid,
        cwd: "/Users/t", kind: "interactive", entrypoint: "cli", version: "2.1.266",
        ...(bridge === undefined ? {} : { bridgeSessionId: bridge }),
      }));
    write(39889, `session_${BRIDGE_A}`);
    write(21210, null);
    write(11111, undefined);
    const snap = await registrySnapshot(claudeDir, { configDir: join(claudeDir, "conch-config") });
    const byKey = Object.fromEntries(snap!.infos.map((info) => [info.sessionId, info.bridgeSessionId]));
    expect(byKey).toEqual({
      [`${SESSION}#39889`]: `session_${BRIDGE_A}`,
      [`${SESSION}#21210`]: undefined,
      [`${SESSION}#11111`]: undefined,
    });
    rmSync(claudeDir, { recursive: true, force: true });
  });
});

describe("conch_transcript_tail reads through the same loader", () => {
  test("a window's tail is its own branch's last reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-a8-mcp-"));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, twoWindows(true).join("\n") + "\n");
    const tail = (sessionId: string, bridge: string) =>
      defaultMcpDependencies.lastAssistantText(path, { sessionId, bridgeSessionId: `session_${bridge}` });
    expect(await tail(KEY_A, BRIDGE_A)).toBe("A answer");
    expect(await tail(KEY_B, BRIDGE_B)).toBe("B latest");
    expect(await tail(SESSION, BRIDGE_A)).toBe("B latest");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the last reply is the trailing run of assistant text, thinking skipped, ending at a tool or a turn", () => {
    const conversation = buildConversation("s", lines(
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "interim" }, { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } },
      { type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "first half" }] } },
      // Thinking BETWEEN two texts: it is skipped, not taken as the boundary.
      { type: "assistant", uuid: "a3", message: { content: [{ type: "thinking", text: "hm" }, { type: "text", text: "second half" }] } },
    ), "claude");
    expect(lastAssistantReply(conversation)).toBe("first half\nsecond half");
    const ended = buildConversation("s", lines(
      { type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "done" }] } },
      { type: "user", uuid: "u2", message: { content: [{ type: "text", text: "thanks" }] } },
    ), "claude");
    expect(lastAssistantReply(ended)).toBe("");
  });

  test("the MCP server and the daemon hand the row's registry entry to the loader", () => {
    const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
    const mcp = read("src/mcp.ts");
    expect(mcp).not.toContain("  lastAssistantText,\n");
    const reader = mcp.slice(mcp.indexOf("async lastAssistantText(transcriptPath, session)"));
    expect(reader).toContain("readConversationTail(");
    expect(reader).toContain("{ window: session }");
    expect(reader).toContain("return lastAssistantReply(conversation);");
    expect(reader.indexOf("readConversationTail(")).toBeLessThan(reader.indexOf("return lastAssistantReply(conversation);"));
    expect(mcp).toContain("dependencies.lastAssistantText(transcriptPath, session)");

    const daemon = read("src/daemon.ts");
    expect(daemon).toContain("readConversationTail(path, sessionId, transcriptFormatFor(path), { window: session })");
    expect(daemon).toContain("readConversationTail(path, session.sessionId, transcriptFormatFor(path), { window: session })");
    expect(daemon).toContain("{ window: panelSessions.get(event.sessionId) },");
    // Four call sites, every one handing over the window: no reader of the
    // conversation is left that could show the other window's branch.
    expect(daemon.match(/readConversationTail\(/g)).toHaveLength(4);
    // The reply in the TUI's preview and footer, the phone's reply, and what
    // recite and read-full say: one helper, which sends a window key to the
    // loader. The flat-file reader is left to that helper's lone-session
    // branch and to Codex, which never has two windows on one id.
    expect(daemon).toContain("async function lastReplyFor(path: string, sessionId: string)");
    const helper = daemon.slice(daemon.indexOf("async function lastReplyFor(path: string, sessionId: string)"));
    expect(helper).toContain("if (!isWindowKey(sessionId)) return { text: await lastAssistantText(path), shared: false };");
    expect(helper).toContain("window: panelSessions.get(sessionId),");
    const branchReply = "return { text: lastAssistantReply(conversation), shared: conversation.shared === true };";
    expect(helper).toContain(branchReply);
    expect(helper.indexOf("if (!isWindowKey(sessionId))")).toBeLessThan(helper.indexOf(branchReply));
    expect(daemon).toContain("? lastReplyFor(contentEvent.transcriptPath, contentEvent.sessionId)");
    expect(daemon).toContain("previewPath && previewId ? lastReplyFor(previewPath, previewId)");
    expect(daemon).toContain("path && !isWindowKey(sessionId) ? await currentTurnText(path)");
    expect(daemon).toContain("const finalMessage = path ? (await lastReplyFor(path, sessionId)).text");
    expect(daemon).toContain("lastReplyFor(target.transcriptPath, target.sessionId),");
    expect(daemon).toContain("await lastReplyFor(event.transcriptPath!, event.sessionId)");
    expect(daemon.match(/lastAssistantText\(/g)).toHaveLength(2);

    const sessions = read("src/sessions.ts");
    expect(sessions).toContain("? { bridgeSessionId: entry.bridgeSessionId }");
  });
});

describe("the TUI preview and the voice say so too", () => {
  test("the note is said once, just before what is left to read", () => {
    expect(SHARED_WINDOW_NOTE).toBe("Shared with another window.");
    const sentences = ["One.", "Two.", "Three."];
    // Recite: nothing announced, so the note comes first.
    expect(withSharedNote(sentences, countCoveredSentences("", sentences)))
      .toEqual([SHARED_WINDOW_NOTE, "One.", "Two.", "Three."]);
    // Read-full after an announcement that covered the first sentence: that
    // sentence is still matched, not read again, and the note leads the rest.
    expect(withSharedNote(sentences, countCoveredSentences("One.", sentences)))
      .toEqual(["One.", SHARED_WINDOW_NOTE, "Two.", "Three."]);
    // Nothing left to read, nothing to say it before.
    expect(withSharedNote(sentences, 3)).toEqual(sentences);
  });

  test("recite and read-full add it from the same read; the TUI preview gets the flag", () => {
    const daemon = readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8");
    const loader = daemon.slice(daemon.indexOf("const ensureSentences = async (): Promise<string[]> => {"));
    const read = "const reply = await lastReplyFor(event.transcriptPath!, event.sessionId);";
    const note = "if (reply.shared) sentences = withSharedNote(sentences, cursor);";
    expect(loader).toContain(read);
    expect(loader).toContain(note);
    // After the cursor is counted against the reply's own sentences, before progress is published.
    expect(loader.indexOf(read)).toBeLessThan(loader.indexOf("sentences = splitSentences(stripMarkdown(reply.text));"));
    expect(loader.indexOf("countCoveredSentences(event.announce, sentences);")).toBeLessThan(loader.indexOf(note));
    expect(loader.indexOf(note)).toBeLessThan(loader.indexOf('const text = sentences.join(" ");'));
    // Recite goes through the same loader: conversationLoop reads with ensureSentences.
    expect(daemon).toContain("const previewRaw = previewReply?.text ?? \"\";");
    expect(daemon).toContain("previewReply?.shared,");
  });
});

describe("the apps say when a window's conversation is shared", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

  test("the Mac decodes the flag, shows the note, and never reads a shared transcript itself", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    expect(models).toContain("case sessionId, items, truncated, shared");
    expect(models).toContain('shared = (try? c.decodeIfPresent(Bool.self, forKey: .shared)) ?? false');
    const stack = read("mac-app/conch-mac/ConversationStackView.swift");
    expect(stack).toContain("if conversation.shared {");
    expect(stack).toContain('Text("Shared with another window');
    expect(stack.indexOf("if conversation.truncated {")).toBeLessThan(stack.indexOf("if conversation.shared {"));
    expect(stack.indexOf("if conversation.shared {")).toBeLessThan(stack.indexOf("ForEach(conversation.items)"));
    // The Mac's own file reader shows whichever window wrote last; a row keyed
    // per window must wait for the daemon's stack instead.
    const dashboard = read("mac-app/conch-mac/DashboardView.swift");
    const watch = dashboard.slice(
      dashboard.indexOf("private var watchesTranscriptForRow"),
      dashboard.indexOf("private var isFocusedSessionLive"),
    );
    expect(watch).toContain('focusedRow?.id.contains("#") != true');
  });

  test("the phone decodes the flag and shows the note", () => {
    const models = read("mobile/conch-ios/conch-ios/Models.swift");
    expect(models).toContain("case sessionId, items, truncated, shared");
    expect(models).toContain('shared = (try? c.decodeIfPresent(Bool.self, forKey: .shared)) ?? false');
    const stack = read("mobile/conch-ios/conch-ios/ConversationStack.swift");
    expect(stack).toContain("if conversation.shared {");
    expect(stack).toContain('Text("Shared with another window');
    expect(stack.indexOf("if conversation.shared {")).toBeLessThan(stack.indexOf("ForEach(conversation.items)"));
  });
});

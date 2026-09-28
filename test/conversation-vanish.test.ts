import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionsToPublish } from "../src/daemon.ts";
import { historySessionFor } from "../src/records-routing.ts";
import { RecordStore } from "../src/records-store.ts";
import { recordKey, type RecordSession } from "../src/records-types.ts";
import type { SessionInfo } from "../src/sessions.ts";

/**
 * Tyler, 2026-09-28: "conversations have been disappearing from the Mac app sometimes and it says
 * there's nothing even when there's an entire convo in the terminal."
 *
 * The Mac drew a session's conversation only when the daemon had published a live window for it,
 * and the daemon published eight — the first eight in registry order, Claude's pid files and then
 * every Codex thread. A seventh Claude window took a Codex session's window away; the Mac fell back
 * to its single-reply pane, which says "Nothing from … yet. Send a message below to start." when
 * the newest turn has no reply. These pin the daemon's half; the app's half is at the bottom.
 */

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

type Row = Pick<SessionInfo, "sessionId" | "status" | "statusUpdatedAt">;
const row = (sessionId: string, statusUpdatedAt: number, status = "idle"): Row => ({ sessionId, status, statusUpdatedAt });

test("the published conversations go to the sessions in use, not the first in registry order", () => {
  // Registry order: six Claude windows, then Codex — the order `registrySnapshot` builds.
  const registry = [
    row("claude-1", 1_000), row("claude-2", 2_000), row("claude-3", 3_000), row("claude-4", 4_000),
    row("claude-5", 5_000), row("claude-6", 6_000), row("claude-7", 7_000),
    row("codex-talking", 90_000), row("codex-old", 500),
  ];
  const published = sessionsToPublish(registry, 8).map((session) => session.sessionId);
  expect(published).toHaveLength(8);
  // The Codex session being talked to right now keeps its window; the one idle longest gives it up.
  expect(published).toContain("codex-talking");
  expect(published).not.toContain("codex-old");
  expect(published[0]).toBe("codex-talking");
});

test("a working session is published before an idle one, and conch's own latch counts as activity", () => {
  const sessions = [row("idle-recent", 9_000), row("working-long", 1_000, "busy"), row("latched", 100)];
  expect(sessionsToPublish(sessions, 2).map((s) => s.sessionId)).toEqual(["working-long", "idle-recent"]);
  // A turn conch saw end a moment ago is newer than whatever the registry last said.
  const latched = (id: string) => (id === "latched" ? 50_000 : undefined);
  expect(sessionsToPublish(sessions, 2, latched).map((s) => s.sessionId)).toEqual(["working-long", "latched"]);
});

test("equally quiet sessions keep the registry's order, so a still dashboard does not reshuffle", () => {
  const sessions = [row("a", 0), row("b", 0), row("c", 0)];
  expect(sessionsToPublish(sessions, 3).map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  expect(sessionsToPublish(sessions, 0)).toEqual([]);
});

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("an agent row's history read reaches the agent's own record, not session-not-found", () => {
  // Discovery records a Claude agent's sidechain as `<parent>/agent-<id>`; the row on screen is `agent-<id>`.
  const owner = "fixture-device";
  const parent = "11111111-2222-4333-8444-555555555555";
  const agentId = "agent-ab7c3a5f5b22cbff3";
  const nativeId = `${parent}/${agentId}`;
  const recorded: RecordSession = { id: recordKey(owner, "claude", nativeId), nativeId, ownerDeviceId: owner, provider: "claude",
    parentNativeId: parent };
  const dir = mkdtempSync(join(tmpdir(), "conch-agent-history-"));
  cleanup.push(dir);
  const store = new RecordStore({ configDir: dir });
  try {
    const bytes = Buffer.from([
      { type: "user", uuid: "u1", parentUuid: null, isSidechain: true, timestamp: "2026-09-28T06:00:00Z", message: { role: "user", content: "Lay out the amount field" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", isSidechain: true, timestamp: "2026-09-28T06:00:05Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Laid out." }] } },
    ].map((entry) => JSON.stringify(entry) + "\n").join(""));
    store.ingest({ session: recorded, source: { id: `${recorded.id}:source`, path: `/fixture/${parent}/subagents/${agentId}.jsonl`,
      device: "1", inode: "1", modifiedMs: 1, size: bytes.length, from: 0, bytes, prefix: bytes.subarray(0, 256),
      checkpoint: new Uint8Array(), expected: null } });

    const agent: SessionInfo = { sessionId: agentId, parentSessionId: parent, backend: "claude",
      transcriptPath: `/Users/fixture/.claude/projects/-work/${parent}/subagents/${agentId}.jsonl` } as SessionInfo;
    const live = { sessions: new Map<string, SessionInfo>(), agents: new Map([[agentId, agent]]) };
    const session = historySessionFor(owner, agentId, live);
    expect(session).toBe(recorded.id);
    const page = store.historyPage({ session }, owner);
    expect(page.kind).toBe("history-page");
    if (page.kind === "history-page") expect(page.items.map((item) => item.preview)).toEqual(["Lay out the amount field", "Laid out."]);

    // Resolved against the sessions alone — what the daemon did — the same read found nothing.
    const unresolved = historySessionFor(owner, agentId, { sessions: new Map(), agents: new Map() });
    expect(store.historyPage({ session: unresolved }, owner)).toMatchObject({ kind: "history-error", code: "session-not-found" });
  } finally {
    store.close();
  }
});

test("the daemon resolves history reads against the agents it lists, refreshed with every panel", () => {
  const daemon = read("src/daemon.ts");
  expect(daemon.match(/historySessionFor\(ownerDeviceId, message\.session, \{ sessions: panelSessions, agents: panelAgents \}\)/g))
    .toHaveLength(2);
  expect(daemon).toContain("panelAgents = new Map(nested.map((agent) => [agent.sessionId, agent]));");
  expect(daemon).not.toContain("historySessionAlias(ownerDeviceId, message.session");
});

/**
 * The app's half. conch-mac has no XCTest target: the rules are ConchDesign's (`ConversationSource`,
 * `HistoryPaging.retryDelay`, `ConversationPlaceholder`, XCTested in ConversationVanishTests), and
 * what is pinned here is that the Mac is wired to them.
 */
test("the Mac draws a session's conversation from its record when the daemon published no live window", () => {
  const dashboard = read("mac-app/conch-mac/DashboardView.swift");
  const body = dashboard.slice(dashboard.indexOf("private func conversationBody(for row: SessionRow?)"),
    dashboard.indexOf("/// The live window the daemon published for THIS session"));
  expect(body).toContain("SessionConversationGate(history: store.history, sessionId: row.id, published: publishedConversation(for: row)) { conversation in");
  // The old gate: no published items, no conversation — however much the record held.
  expect(body).not.toContain("!conversation.items.isEmpty,");
  const gate = dashboard.slice(dashboard.indexOf("private struct SessionConversationGate"));
  expect(gate).toContain("@ObservedObject var history: HistoryStore");
  expect(gate).toContain("ConversationSource.of(publishedItems: published?.items.count ?? 0, session: sessionId, reader: history.paging) == .neither");
  expect(gate).toContain("stack(published ?? Conversation(sessionId: sessionId))");
  const published = dashboard.slice(dashboard.indexOf("private func publishedConversation(for row: SessionRow) -> Conversation?"));
  expect(published).toContain("conversation.sessionId == row.id else { return nil }");
  // Drawn from the record alone, it opens at the record's newest row, as a live one opens at its tail.
  const stack = read("mac-app/conch-mac/ConversationStackView.swift");
  const follow = stack.slice(stack.indexOf(".onChange(of: conversation.items.isEmpty ? history.paging.rows.last?.id : nil) { _, _ in"));
  expect(follow.slice(0, 200)).toContain("guard pinnedToBottom else { return }\n                requestBottomScroll(using: proxy)");
});

test("both readers keep asking while they hold nothing, and the Mac's empty sentence is for empty sessions", () => {
  for (const store of ["mac-app/conch-mac/HistoryStore.swift", "mobile/conch-ios/conch-ios/HistoryStore.swift"]) {
    expect(read(store), store).toContain("guard let delay = paging.retryDelay else {");
  }
  const content = read("mac-app/conch-mac/TranscriptContent.swift");
  expect(content).toContain("case .awaitingReply:\n                    SessionStaticContent.fallback(for: row, transcript: .awaitingReply)");
  // Each reader — Claude's and Codex's — tells an unanswered prompt from an empty transcript on its own.
  const claude = content.slice(content.indexOf("private static func lastClaudeReply"), content.indexOf("private static func isToolResultEntry"));
  const codex = content.slice(content.indexOf("private static func lastCodexReply"), content.indexOf("private static func scanLinesBackward"));
  for (const [name, reader] of [["Claude", claude], ["Codex", codex]] as const) {
    expect(reader, name).toContain("-> TranscriptLastReply {");
    expect(reader, name).toContain("let reachedPrompt = try scanLinesBackward(at: path, fileSize: fileSize) { line in");
    expect(reader, name).toContain("return reachedPrompt || saidAnything ? .awaitingReply : .empty");
    expect(reader, name).toContain("saidAnything = true");
  }
  // A transcript it cannot read is said to be unreadable, not empty.
  expect(content).toContain("guard !rawPath.isEmpty else {\n            content = SessionStaticContent.fallback(for: row, transcript: .unreadable)");
  expect(content).toContain("if content == SessionStaticContent.fallback(for: row) {\n                    content = SessionStaticContent.fallback(for: row, transcript: .unreadable)");
  expect(content).not.toContain('"Nothing from');
});

/**
 * The conversation panel had the same gate the main window lost in #457: it drew the live window the daemon published and
 * nothing else, so a session without one was a blank panel. It goes by the same rule now (`ConversationSource`, through
 * `PanelConversation`, XCTested in PanelHistoryTests), with the overlay's own reader and its caps.
 */
test("the conversation panel draws a session's conversation from its record when the daemon published no live window", () => {
  const panels = read("mac-app/conch-mac/FloatingPanels.swift");
  const host = panels.slice(panels.indexOf("private struct ConversationFogHost: View {"), panels.indexOf("private struct PanelContent: View {"));
  // The words come from one place, and the old gate — the live window's turns or nothing — is gone.
  expect(host).toContain("let words = row.map(words(for:))\n        let turns = words?.turns ?? []");
  expect(host).not.toContain("let turns = row.map { Self.turns(store.state, $0, whole: history.fullBodies) } ?? []");
  expect(host).toContain("placeholder: words?.placeholder,");
  const words = host.slice(host.indexOf("private func words(for row: SessionRow) -> Words {"), host.indexOf("static func watchable("));
  expect(words).toContain("let source = ConversationSource.of(publishedItems: published?.items.count ?? 0, session: row.id, reader: history.paging)");
  expect(words).toContain("let conversation = PanelConversation.of(source: source, turns: turns.count, session: row.id, reader: history.paging)");
  expect(words).toContain("reader: history.paging,\n            live: Self.turns(store.state, row, whole: history.fullBodies),");
  expect(words).toContain("liveItems: (published?.items ?? []).map(\\.id),\n            liveStartsAt: published?.items.first?.at,");
  expect(words).toContain("ConversationPlaceholder.text(name: name, transcript: transcript)");
  // Records off or empty: the main window's single-reply document's content, from the same reader of the transcript.
  expect(words).toContain("let content = lastReply.content(for: row)");
  expect(host).toContain("@StateObject private var lastReply = TranscriptContentModel()");
  expect(host).toContain("await lastReply.monitor(row: words?.conversation == .lastReply ? row.flatMap(Self.watchable) : nil)");
  expect(host).not.toContain('"Nothing from');
  // The live window is this session's or none, as the main window checks it.
  expect(host).toContain("static func published(_ state: PublishedState?, _ row: SessionRow) -> Conversation? {\n        guard let conversation = state?.conversations?[row.id] ?? state?.conversation,\n              conversation.sessionId == row.id else { return nil }");
  // Docked too, the reader is pointed at the panel's session and asked for its newest page.
  expect(host).toContain(".onChange(of: row?.id, initial: true) { _, _ in follow(row) }");
  const follow = host.slice(host.indexOf("private func follow(_ row: SessionRow?) {"), host.indexOf("private func select(_ row: SessionRow) {"));
  expect(follow).toContain("select(row)\n        if history.paging.epoch == nil { history.loadOlder() }");
  // Older pages read in as the panel scrolls back; bodies read whole about where the reader is.
  expect(host).toContain(".onChange(of: history.paging.rows.count) { _, _ in panels.readHistory(force: true) }");
  expect(panels).toContain("let words = text.step(dt: dt, now: now, reduceMotion: motion.reduceMotion)\n        readHistory()");
  const readHistory = panels.slice(panels.indexOf("func readHistory(force: Bool = false) {"), panels.indexOf("func scrolled(_ event: NSEvent) {"));
  expect(readHistory).toContain("guard form != .collapsed, let history = store?.overlayHistory, !history.paging.session.isEmpty else { return }");
  expect(readHistory).toContain("if PanelHistory.wantsOlder(turns: text.turnIDs.count, scroll: text.scroll, box: text.box) {\n            history.loadOlder(anchor: history.paging.rows.first?.id)");
  expect(readHistory).toContain("history.showing(nearby.ids, around: nearby.center)");
  expect(read("mac-app/conch-mac/HistoryStore.swift")).toContain("func showing(_ ids: [String], around center: String?) {\n        show(ids, around: center)");
  // Bounded as the main window's reader is: the overlay's is a HistoryStore, with its item and body ceilings.
  expect(panels).toContain("ConversationFogHost(store: store, panels: self, queue: queue, history: store.overlayHistory)");
  expect(read("mac-app/conch-mac/HistoryStore.swift")).toContain("@Published private(set) var paging = HistoryPaging(itemCap: HistoryStore.itemCap)");

  // The fog: the placeholder where the words would be, the reply line kept; and a page landing above keeps the reader's place.
  const fog = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
  expect(fog).toContain("if let placeholder, turns.isEmpty, text.sent == nil {\n                    placeholderLine(placeholder, width: width, height: height, top: top)");
  expect(fog).toContain("text.measured(content: $0.height, ends: $0.ends)");
  expect(fog).toContain("let ends = FogTranscriptEnds(oldest: lines.first?.id, newest: lines.last?.id)");

  // The phone already follows the rule (`SessionView.liveWindow`); pinned so the two cannot drift apart.
  const phone = read("mobile/conch-ios/conch-ios/SessionView.swift");
  const liveWindow = phone.slice(phone.indexOf("private var liveWindow: Conversation? {"), phone.indexOf("private var branchTip: String? {"));
  expect(liveWindow).toContain("if let published, !published.items.isEmpty { return published }");
  expect(liveWindow).toContain("guard history.paging.hasAnythingToShow else { return nil }");
  expect(liveWindow).toContain("return published ?? Conversation(sessionId: sessionId)");
});

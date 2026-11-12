import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildConversation,
  pendingQuestion,
  publishedConversation,
  startsTurn,
  withPeerSessions,
  type Conversation,
  type ConversationItem,
} from "../src/conversation.ts";
import {
  conchPeerFraming,
  conchMessageCommand,
  crossSessionDeliveryNotice,
  parseMessageArgs,
  peerDirectory,
  peerEnvelope,
  peerRecordText,
  receivedPeerMessage,
  recordedPeerMessage,
  sendMessageDelivery,
} from "../src/peer-messages.ts";
import { normalizeClaudeRecord } from "../src/records-claude.ts";
import { normalizeCodexRecord } from "../src/records-codex.ts";
import type { RecordNormalizerContext } from "../src/records-types.ts";
import { activityFacts } from "../src/live-activity.ts";

// Tyler, 2026-11-12: "is there a way for agents to effectively message each other now in conch and how does it show
// in my convo when they do?" The fixtures are Claude Code's and Codex's real record shapes (2.1.280–2.1.309), with
// made-up names, ids and words.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/peer-messages/${name}`, import.meta.url), "utf8")
  .split("\n").filter(Boolean);
const items = (conversation: Conversation): ConversationItem[] => conversation.order.map((id) => conversation.items[id]!);
const receiver = () => buildConversation("receiver", fixture("claude-receiver.jsonl"), "claude");
const sender = () => buildConversation("sender", fixture("claude-sender.jsonl"), "claude");
const codex = () => buildConversation("codex", fixture("codex-receiver.jsonl"), "codex");

describe("a message from another session is shown as one, never as Tyler's", () => {
  test("every shape Claude Code writes, and conch's own, is a peer row with the words alone", () => {
    const peers = items(receiver()).filter((item) => item.peer);
    expect(peers.map((item) => [item.kind, item.material?.title, item.text])).toEqual([
      ["material", "From harbor", "Is port 5173 free on your side?"],
      ["material", "From harbor", "Also: I moved the fixtures to test/fixtures."],
      ["material", "From general-purpose", "Done: the flaky test was a timing race."],
      ["material", "From lantern", "Can you review the diff in feat/lamp?\nTwo files changed."],
    ]);
    for (const item of peers) {
      expect(item.text).not.toContain("cross-session-message");
      expect(item.text).not.toContain("agent-message");
      expect(item.text).not.toContain("not typed by your user");
      expect(item.text).not.toContain("conch message --reply");
      expect(item.peer?.direction).toBe("received");
    }
  });

  test("who sent it: Claude Code's verified pid and message id, a subagent's id, conch's session id", () => {
    const [idle, queued, agent, conch] = items(receiver()).filter((item) => item.peer).map((item) => item.peer!);
    expect(idle).toEqual({ direction: "received", name: "harbor", via: "claude", pid: 4242, msgId: "9b2f6e0c-1d3a-4c5e-8f70-a1b2c3d4e5f6" });
    expect(queued).toMatchObject({ name: "harbor", pid: 4242, queued: true });
    expect(agent).toEqual({ direction: "received", name: "general-purpose", via: "claude", agentId: "a0123456789abcdef" });
    expect(conch).toEqual({
      direction: "received", name: "lantern", via: "conch",
      session: "22222222-3333-4444-8555-666666666666", msgId: "5e0f3a2b9c71",
    });
  });

  test("a peer row keeps the record's own id, as the record store keys it", () => {
    const ids = items(receiver()).filter((item) => item.peer).map((item) => item.id);
    expect(ids).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000007",
    ]);
  });

  test("a person who types the tag is still the person speaking", () => {
    const last = items(receiver()).at(-1)!;
    expect(last.kind).toBe("user");
    expect(last.peer).toBeUndefined();
    expect(receivedPeerMessage("<cross-session-message from-name=\"x\">\nhi\n</cross-session-message>")).toBeNull();
  });

  test("Codex receives conch's framing as a user message, and shows it as a peer row once", () => {
    const rows = items(codex());
    const peers = rows.filter((item) => item.peer?.direction === "received");
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ kind: "material", text: "Which branch has the parser change?" });
    expect(rows.some((item) => item.kind === "user")).toBe(false);
  });

  test("a received message starts a turn, as Tyler's words do, unless it was queued into one", () => {
    const [idle, queued] = items(receiver()).filter((item) => item.peer);
    expect(startsTurn(idle)).toBe(true);
    expect(startsTurn(queued)).toBe(false);
    expect(startsTurn({ id: "u", rev: 1, kind: "user", text: "hi" })).toBe(true);
  });

  test("a question still running is no longer pending once another session's message started a turn", () => {
    const lines = [
      JSON.stringify({ type: "assistant", uuid: "q", message: { content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion", input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] } }] } }),
    ];
    expect(pendingQuestion(buildConversation("s", lines, "claude"))).not.toBeNull();
    const peer = fixture("claude-receiver.jsonl")[2]!;
    expect(pendingQuestion(buildConversation("s", [...lines, peer], "claude"))).toBeNull();
  });

  test("the activity of a turn a peer message started begins after it", () => {
    const conversation = buildConversation("receiver", fixture("claude-receiver.jsonl").slice(0, 3), "claude");
    expect(activityFacts(conversation).steps).toEqual([]);
  });

  test("published, a peer row is carried among what was said", () => {
    const conversation = receiver();
    const published = publishedConversation(conversation, { windowSize: 1 });
    expect(published.items.filter((item) => item.peer).length).toBeGreaterThan(0);
  });
});

describe("a message this session sent reads as sent, with how far it got", () => {
  test("SendMessage's results: in its inbox, held later, not sent, queued for a subagent", () => {
    const sent = items(sender()).filter((item) => item.peer).map((item) => [item.text, item.peer!.name, item.peer!.delivery, item.peer!.deliveryNote]);
    expect(sent).toEqual([
      ["Is port 5173 free on your side?", "harbor", "unread", undefined],
      ["Please pause the migration.", "uds:/tmp/cc-socks/5151.sock", "held", undefined],
      ["Are you there?", "tidepool", "failed", "no agent named 'tidepool' is reachable."],
      ["Also check the Codex side.", "a0123456789abcdef", "queued", undefined],
      ["Your review is in: two nits.", "lantern", "sent", undefined],
      ["One more thing:\nthe flag is on.", "lantern", "failed", "\"lantern\" has a question or dialog open, and keys typed now would answer it. Send it again once that is settled."],
    ]);
  });

  test("the delivery notice is said on the row it is about, not as a row of its own", () => {
    const rows = items(sender());
    expect(rows.some((item) => item.text.includes("Cross-session delivery notice"))).toBe(false);
  });

  test("a SendMessage that asks to be told when a session is idle says nothing to it, so it stays a tool row", () => {
    const idle = items(sender()).find((item) => item.id === "tool:toolu_send_idle")!;
    expect(idle.peer).toBeUndefined();
    expect(idle.kind).toBe("tool");
  });

  test("a Codex reply with `conch message --reply` is named for the session it answers", () => {
    const reply = items(codex()).find((item) => item.peer?.direction === "sent")!;
    expect(reply.text).toBe("feat/parser, two commits.");
    expect(reply.peer).toMatchObject({
      name: "harbor", via: "conch", replyTo: "0a1b2c3d4e5f", session: "33333333-4444-4555-8666-777777777777",
      delivery: "sent", msgId: "6f5e4d3c2b1a",
    });
  });

  test("result wording, read defensively", () => {
    expect(sendMessageDelivery(undefined, JSON.stringify({ success: true, message: "“S” → x (another Claude session on this machine; queued there — …)", msg_id: "m" }), false))
      .toEqual({ msgId: "m", delivery: "queued" });
    expect(sendMessageDelivery({ success: true, message: "Resuming agent a0123456789abcdef" }, "", false)).toEqual({ delivery: "sent" });
    expect(sendMessageDelivery(null, "not json at all", true)).toEqual({ delivery: "failed", deliveryNote: "not json at all" });
    expect(sendMessageDelivery("weird", "", false)).toEqual({ delivery: "sent" });
    expect(crossSessionDeliveryNotice("[Cross-session delivery notice] Your message to another session was not approved before expiry (recipient: x; msg_id: abc-1). Not delivered.")).toMatchObject({ msgId: "abc-1", delivery: "expired" });
    expect(crossSessionDeliveryNotice("[Cross-session delivery notice] no id here")).toBeNull();
  });
});

describe("conch's framing", () => {
  test("reads back as the message it carries, from the session that sent it", () => {
    const framed = conchPeerFraming({ fromSession: "s-1", fromName: "say \"hi\" <now>", msgId: "abc123def456", replyTo: "000111222333", text: "  Two lines\nof words  " });
    expect(framed).toStartWith("<cross-session-message from=\"conch:s-1\" from-name=\"say &quot;hi&quot; &lt;now&gt;\" via=\"conch\" msg-id=\"abc123def456\" reply-to=\"000111222333\">\nTwo lines\nof words\n</cross-session-message>");
    expect(framed).toContain("conch message --reply abc123def456");
    expect(receivedPeerMessage(framed)).toEqual({
      body: "Two lines\nof words",
      peer: { direction: "received", name: "say \"hi\" <now>", via: "conch", session: "s-1", msgId: "abc123def456", replyTo: "000111222333" },
    });
  });

  test("a message that quotes the closing tag keeps its words", () => {
    const framed = conchPeerFraming({ fromSession: "s", fromName: "n", msgId: "m", text: "see </cross-session-message> here" });
    expect(receivedPeerMessage(framed)?.body).toBe("see </cross-session-message> here");
  });

  test("the record store's tag is the same tag, and reads back the same", () => {
    for (const line of fixture("claude-receiver.jsonl").slice(2, 7)) {
      const live = buildConversation("r", [line], "claude");
      const item = items(live)[0]!;
      if (!item.peer) continue;
      const stored = peerRecordText(item.peer, item.text);
      const again = recordedPeerMessage(stored);
      expect(again?.body).toBe(item.text);
      expect(again?.peer.name).toBe(item.peer.name);
      expect(again?.peer.pid).toBe(item.peer.pid);
      expect(again?.peer.agentId).toBe(item.peer.agentId);
      expect(again?.peer.session).toBe(item.peer.session);
      expect(again?.peer.msgId).toBe(item.peer.msgId);
      expect(peerEnvelope(stored)?.attributes.via).toBe(item.peer.via);
    }
  });

  test("conch message's arguments, as the CLI and a sender's row both read them", () => {
    expect(parseMessageArgs(["harbor", "hello", "there"])).toEqual({ stdin: false, help: false, target: "harbor", text: "hello there" });
    expect(parseMessageArgs(["--reply", "abc", "thanks"])).toEqual({ stdin: false, help: false, replyTo: "abc", text: "thanks" });
    expect(parseMessageArgs(["harbor", "--reply=abc", "thanks"])).toMatchObject({ target: "harbor", replyTo: "abc", text: "thanks" });
    expect(parseMessageArgs(["harbor", "-", "--wait", "30"])).toMatchObject({ target: "harbor", stdin: true, wait: 30 });
    expect(parseMessageArgs(["harbor", "--wait", "hi"])).toMatchObject({ wait: 120, text: "hi" });
    expect(parseMessageArgs(["harbor", "--wait=9000", "hi"]).error).toContain("--wait");
    expect(parseMessageArgs(["harbor", "--loud", "hi"]).error).toBe("unknown option --loud");
    expect(conchMessageCommand("grep \"conch message\" README.md")).toBeNull();
    expect(conchMessageCommand("conch messages harbor hi")).toBeNull();
    expect(conchMessageCommand("echo hi | conch message harbor")).toMatchObject({ body: "", peer: { name: "harbor" } });
  });
});

describe("the other end, named as conch knows it when it publishes", () => {
  const directory = peerDirectory([
    { sessionId: "row-harbor", pid: 4242, name: "harbor" },
    { sessionId: "22222222-3333-4444-8555-666666666666", pid: 7, name: "lamp" },
    { sessionId: "agent-a0123456789abcdef", parentSessionId: "row-harbor" },
    { sessionId: "twin-1", pid: 9, name: "twin" },
    { sessionId: "twin-2", pid: 9, name: "twin" },
  ], new Map([["row-harbor", "Harbor (renamed)"], ["22222222-3333-4444-8555-666666666666", "Lantern"], ["agent-a0123456789abcdef", "Flaky test hunt"]]), "agent-");

  test("by pid, by conch's id, by subagent id; its title says the label", () => {
    const conversation = withPeerSessions(receiver(), directory);
    const peers = items(conversation).filter((item) => item.peer);
    expect(peers.map((item) => [item.peer!.session, item.peer!.label, item.material?.title])).toEqual([
      ["row-harbor", "Harbor (renamed)", "From Harbor (renamed)"],
      ["row-harbor", "Harbor (renamed)", "From Harbor (renamed)"],
      ["agent-a0123456789abcdef", "Flaky test hunt", "From Flaky test hunt"],
      ["22222222-3333-4444-8555-666666666666", "Lantern", "From Lantern"],
    ]);
  });

  test("a row it names moves its revision, so a viewer holding the old one takes the new; the cached build is untouched", () => {
    const base = receiver();
    const before = items(base).find((item) => item.peer)!;
    const after = withPeerSessions({ ...base, items: { ...base.items } }, directory).items[before.id]!;
    expect(after.rev).toBe(before.rev + 1);
    expect(base.items[before.id]).toBe(before);
    expect(before.peer?.label).toBeUndefined();
  });

  test("a sent message by the name it gave, only when one row answers to it; a pid two rows share names neither", () => {
    const conversation = withPeerSessions(sender(), directory);
    const harbor = items(conversation).find((item) => item.id === "tool:toolu_send_inbox")!;
    expect(harbor.peer).toMatchObject({ session: "row-harbor", label: "Harbor (renamed)" });
    expect(directory.byPid.has(9)).toBe(false);
    expect(directory.byName?.has("twin")).toBe(false);
  });

  test("a sender no longer live is shown by the name it gave, with nothing to open", () => {
    const conversation = withPeerSessions(receiver(), peerDirectory([], new Map(), "agent-"));
    const first = items(conversation).find((item) => item.peer)!;
    expect(first.peer).toMatchObject({ name: "harbor" });
    expect(first.peer?.label).toBeUndefined();
  });
});

describe("the record store keeps peer messages, never as Tyler's words", () => {
  const context = (sessionId: string): RecordNormalizerContext => ({
    sessionId, sourceId: "src", generation: 1, state: {}, offset: 0,
    turnForItem: () => undefined, itemForNativeId: () => undefined,
  });

  test("Claude: the meta turn, the queued one, a subagent's and conch's are inter_agent rows in conch's tag", () => {
    const ctx = context("receiver");
    const out = fixture("claude-receiver.jsonl").map((line, index) => normalizeClaudeRecord(JSON.parse(line), { ...ctx, offset: index * 100 }));
    const stored = out.flatMap((records) => records.items);
    const peers = stored.filter((item) => item.kind === "inter_agent");
    expect(peers.map((item) => [item.role, recordedPeerMessage(item.text ?? "")?.body])).toEqual([
      ["system", "Is port 5173 free on your side?"],
      ["system", "Also: I moved the fixtures to test/fixtures."],
      ["system", "Done: the flaky test was a timing race."],
      ["system", "Can you review the diff in feat/lamp?\nTwo files changed."],
    ]);
    expect(peers.map((item) => item.nativeId)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000007",
    ]);
    // The queued one joins the turn under way rather than starting its own.
    const turnsStarted = out.map((records) => records.turns.filter((turn) => turn.startedAt !== undefined).length);
    expect(turnsStarted).toEqual([1, 0, 1, 0, 0, 1, 1, 1]);
    const tylers = stored.filter((item) => item.kind === "message" && item.role === "user").map((item) => item.text);
    expect(tylers).toEqual(["Check the build, please.", "<cross-session-message from-name=\"nobody\">\nquoting a tag\n</cross-session-message>"]);
  });

  test("Codex: conch's framing is inter_agent on every carrier", () => {
    const ctx = context("codex");
    const stored = fixture("codex-receiver.jsonl").flatMap((line, index) => normalizeCodexRecord(JSON.parse(line), { ...ctx, offset: index * 100 }).items);
    expect(stored.filter((item) => item.role === "user")).toEqual([]);
    const peer = stored.filter((item) => item.kind === "inter_agent");
    expect(peer.length).toBeGreaterThan(0);
    expect(recordedPeerMessage(peer.find((item) => item.text)!.text!)?.peer).toMatchObject({ name: "harbor", via: "conch" });
  });
});

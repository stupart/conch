import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildConversation,
  type ConversationItem,
  conversationWindow,
  emptyConversation,
  publishedConversation,
  readConversationTail,
  splitSentReceipts,
  upsertConversationItem,
} from "../src/conversation.ts";
import { conchHome } from "../src/home.ts";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";

// What Tyler sends through conch itself — a canvas, a Show, a video from the phone — reaches the session as one
// message written for the agent. His own conversation drew it as written: a 320 pt picture of the screen he was
// looking at, under the agent's instructions. Tyler: "Don't need the image of the work I'm currently looking at to also
// be in the convo if I'm currently looking at it." These pin the receipt that replaces it, and the fallback.

const data = join(conchHome(), ".cache", "conch");
const ID = "5B3F0D2E-9C41-4E7A-8F10-2D6B7A1C9E44";
const folder = join(data, "canvas", ID);
const uploads = join(data, "uploads");
const lines = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry));
const said = (uuid: string, content: string) => ({ type: "user", uuid, message: { content } });
const rows = (text: string) =>
  conversationWindow(buildConversation("s", lines(said("u1", text)), "claude"), 20);

/** `CanvasPrompt.text`, as CanvasTests pins it. */
const canvasMessage = (id = ID) => [
  join(folder, "flat.png"),
  "[canvas] Tyler marked up Invite page (http://localhost:3000/invite).",
  '1. box (62%,18%): "make this bigger"',
  '2. arrow (10%,80%)→(30%,60%): "move here"',
  '4. note (90%,4%): "and this"',
  `Clean screen + marks: ${join(folder, "raw.png")}, ${join(folder, "canvas.json")}`,
  `To mark your answer on this canvas, frame your marks {canvas: "${id}"}.`,
].join("\n");

/** `CanvasStoryboard.prompt`, as CanvasShowTests pins it. */
const showMessage = (frame = (n: number) => join(folder, `frame-0${n}.png`)) => [
  "[canvas] Tyler showed Safari (0:23).",
  `Storyboard: ${join(folder, "storyboard.md")}`,
  `[00:00] ${frame(1)} — "okay so this page" · the start`,
  `[00:04] ${frame(2)} — "this one, bigger" · box (55%,15%), note (60%,12%): "make this bigger"`,
  `[00:15] ${frame(3)} — "and this footer" · the screen changed`,
  `[00:23] ${frame(4)} — "that's it" · the end`,
  `The recording, for people (agents can't watch video): ${join(folder, "show.mp4")}`,
  `To mark your answer on this canvas, frame your marks {canvas: "${ID}"}.`,
].join("\n");

/** `VideoStoryboard.prompt`, as VideoStoryboardTests pins it. */
const videoMessage = [
  "[video] Tyler sent a video from his phone (0:09).",
  `Contact sheet: ${join(uploads, "sheet123.jpg")} — 3 frames, left to right and down, each stamped with its time:`,
  "[00:00] frame 01 — the start",
  '[00:02] frame 02 — "this button should be blue" · the screen changed',
  "[00:08] frame 03 — the end",
  "What he said:",
  "[00:01] this button should be blue",
  `The video itself, for people (agents can't watch video): ${join(uploads, "video123.mp4")}`,
].join("\n");

/** Nothing written for the agent reaches Tyler's rows. */
const AGENT_LINES = /Clean screen|To mark your answer|frame your marks|Storyboard:|Contact sheet:|for people|\/\.cache\/conch\//;

describe("what Tyler sent through conch is a receipt, not the message", () => {
  test("a canvas: what it was, his notes, and its picture to open, with no image and no agent-facing lines", () => {
    const [row, ...rest] = rows(canvasMessage());
    expect(rest).toEqual([]);
    expect(row!.kind).toBe("user");
    expect(row!.id).toBe("u1");
    expect(row!.material).toBeUndefined();
    expect(row!.receipt).toEqual({
      kind: "canvas",
      title: "Marked up Invite page",
      detail: "3 notes\n“make this bigger”\n“move here”",
      thumb: join(folder, "flat.png"),
      open: join(folder, "flat.png"),
    });
    expect(row!.text).toBe("Marked up Invite page\n3 notes\n“make this bigger”\n“move here”");
    expect(row!.text).not.toMatch(AGENT_LINES);
  });

  test("a canvas without the Screen Recording grant is the same receipt", () => {
    const text = canvasMessage().replace(
      /^Clean screen .*$/m,
      `conch can't see the screen without the Screen Recording permission, so the picture is his marks alone. Marks: ${join(folder, "canvas.json")}`,
    );
    expect(rows(text).map((row) => row.receipt?.title)).toEqual(["Marked up Invite page"]);
  });

  test("a Show: how long, what he said over it, its first frame, and the recording to open", () => {
    const [row, ...rest] = rows(showMessage());
    expect(rest).toEqual([]);
    expect(row!.receipt).toEqual({
      kind: "show",
      title: "Showed Safari · 0:23",
      detail: "“okay so this page this one, bigger and this footer that's it”",
      thumb: join(folder, "frame-01.png"),
      open: join(folder, "show.mp4"),
    });
    expect(row!.text).not.toMatch(AGENT_LINES);
    // Silent, it is his notes instead.
    const silent = showMessage().replace(/"[^"]*" · /g, "");
    expect(rows(silent)[0]!.receipt?.detail).toBe("“make this bigger”");
  });

  test("a phone video beside a picture he pasted and his own words: three rows, each as itself", () => {
    const picture = join(uploads, "pic12345.jpg");
    const items = rows(`${picture}\n${videoMessage}\ncan you fix this`);
    expect(items.map((item) => [item.id, item.kind, item.text.split("\n")[0], item.material?.path ?? null])).toEqual([
      ["u1", "user", "can you fix this", null],
      ["u1:receipt:0", "user", "Sent a video · 0:09", null],
      ["u1:material:0", "material", "pic12345.jpg", picture],
    ]);
    expect(items[1]!.receipt).toEqual({
      kind: "video",
      title: "Sent a video · 0:09",
      detail: "“this button should be blue”",
      thumb: join(uploads, "sheet123.jpg"),
      open: join(uploads, "video123.mp4"),
    });
    expect(items.map((item) => item.text).join("\n")).not.toMatch(/Contact sheet|frame 0|What he said|for people/);
  });

  test("a screenshot he pasted is not a receipt, even from the phone's own folder", () => {
    expect(rows("/Users/tyler/Desktop/shot.png\nlook at this").map((item) => [item.kind, item.material?.kind, item.receipt])).toEqual([
      ["user", undefined, undefined],
      ["material", "image", undefined],
    ]);
    const phone = join(uploads, "abcdef12.jpg");
    expect(rows(phone).map((item) => [item.kind, item.material?.path])).toEqual([["material", phone]]);
  });

  test("anything not exactly conch's format falls back to the message as it always was", () => {
    const today = (text: string) => {
      const items = rows(text);
      expect(items.some((item) => item.receipt)).toBe(false);
      return items;
    };
    // An answer line naming another canvas.
    const other = today(canvasMessage("00000000-0000-4000-8000-000000000000"));
    expect(other.map((item) => item.kind)).toEqual(["user", "material"]);
    expect(other[0]!.text).toContain("[canvas] Tyler marked up Invite page");
    expect(other[1]!.material?.path).toBe(join(folder, "flat.png"));
    // A picture outside conch's own folder.
    today(canvasMessage().replace(join(folder, "flat.png"), "/tmp/x/flat.png"));
    // The whole message moved elsewhere, every path agreeing: still only conch's own canvas folder makes a receipt.
    today(canvasMessage().replaceAll(folder, join("/tmp/elsewhere", ID)));
    // A frame from somewhere else; a Show cut short.
    today(showMessage((n) => (n === 3 ? "/tmp/frame-03.png" : join(folder, `frame-0${n}.png`))));
    today(showMessage().split("\n").slice(0, -1).join("\n"));
    // A video whose frames don't add up, or whose video isn't one the phone sent.
    today(videoMessage.replace("3 frames", "4 frames"));
    today(videoMessage.replace(join(uploads, "video123.mp4"), "/tmp/video123.mp4"));
    // Words that merely quote the tag.
    expect(splitSentReceipts("[canvas] Tyler marked up Safari.").receipts).toEqual([]);
  });

  test("a canvas sent while the session was busy is queued, and still a receipt", () => {
    const conversation = buildConversation("s", lines({
      type: "attachment",
      uuid: "a1",
      attachment: { type: "queued_command", prompt: canvasMessage(), origin: { kind: "human" }, source_uuid: "q1" },
    }), "claude");
    expect(conversationWindow(conversation, 5).map((item) => [item.id, item.receipt?.title])).toEqual([
      ["queued:q1", "Marked up Invite page"],
    ]);
  });

  test("in a Codex session too, one row from both of Codex's copies of it", () => {
    const conversation = buildConversation("s", lines(
      { type: "event_msg", payload: { type: "task_started", turn_id: "t1" } },
      { type: "event_msg", payload: { type: "user_message", message: showMessage() } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "UserMessage", content: [{ type: "text", text: showMessage() }] } } },
    ), "codex");
    const items = conversationWindow(conversation, 5);
    expect(items.map((item) => [item.kind, item.receipt?.title])).toEqual([["user", "Showed Safari · 0:23"]]);
  });

  test("the note Claude Code writes about a receipt's picture is its own business, not a row", () => {
    const conversation = buildConversation("s", lines(
      said("u1", canvasMessage()),
      said("u2", "[Image: original 2880x1640, displayed at 1568x893.]"),
    ), "claude");
    expect(conversationWindow(conversation, 5).map((item) => item.id)).toEqual(["u1"]);
  });

  test("a receipt that changes is a new revision, so the apps draw its row again", () => {
    const conversation = emptyConversation("s");
    const receipt = { kind: "canvas" as const, title: "Marked up Safari" };
    upsertConversationItem(conversation, { id: "u1", kind: "user", text: "Marked up Safari", receipt });
    upsertConversationItem(conversation, { id: "u1", kind: "user", text: "Marked up Safari", receipt: { ...receipt, thumb: "/x/flat.png" } });
    expect(conversation.items.u1!.rev).toBe(2);
  });

  test("it reaches the wire whole", () => {
    const conversation = buildConversation("s", lines(said("u1", canvasMessage())), "claude");
    expect(publishedConversation(conversation).items[0]!.receipt?.thumb).toBe(join(folder, "flat.png"));
  });
});

describe("a canvas's marks are counted from the canvas.json beside its picture", () => {
  const root = mkdtempSync(join(tmpdir(), "conch-receipts-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  test("his marks and his notes with words in them; an agent's marks and an empty pin are not his", async () => {
    mkdirSync(folder, { recursive: true });
    const mark = (kind: string, author = "you", text?: string) => ({ kind, author, points: [], id: `${kind}${text ?? ""}`, text });
    writeFileSync(join(folder, "canvas.json"), JSON.stringify({
      v: 1,
      id: ID,
      marks: [mark("box"), mark("arrow"), mark("note", "you", "make this bigger"), mark("note", "you", "  "), mark("box", "agent")],
    }));
    const transcript = join(root, "t.jsonl");
    writeFileSync(transcript, `${lines(said("u1", canvasMessage()))[0]}\n`);
    const [row] = conversationWindow(await readConversationTail(transcript, "s", "claude"), 5);
    expect(row!.receipt?.detail).toBe("2 marks · 1 note\n“make this bigger”\n“move here”");
    expect(row!.text.split("\n")[1]).toBe("2 marks · 1 note");
  });
});

describe("the phone is served a receipt's picture from conch's own folders, and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "conch-receipt-file-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "picture");
    chmodSync(path, 0o600);
    return path;
  };
  const phoneUploads = join(root, ".cache/conch/uploads");
  const flat = put(join(root, ".cache/conch/canvas", ID, "flat.png"));
  const sheet = put(join(phoneUploads, "sheet123.jpg"));
  const stray = put(join(root, ".cache/conch/canvas/not-a-canvas/flat.png"));
  const outside = put(join(root, "elsewhere/flat.png"));
  const unnamed = put(join(root, ".cache/conch/canvas", ID, "raw.png"));
  const application = createPhoneBridgeApplication({
    getState: () => ({
      rows: [{ id: "s" }],
      conversations: { s: { items: [flat, sheet, stray, outside].map((thumb) => ({ kind: "user", receipt: { thumb } })) } },
    }),
    uploadsDirectory: phoneUploads,
    log: () => {},
  } as any, { token: "t".repeat(32) });
  const status = async (path: string) => (await application.handle(new Request(
    `https://relay.invalid/file?path=${encodeURIComponent(path)}`,
    { headers: { authorization: `Bearer ${"t".repeat(32)}` } },
  )) as Response).status;

  test("a canvas's picture and a video's contact sheet are served", async () => {
    expect(await status(flat)).toBe(200);
    expect(await status(sheet)).toBe(200);
  });

  test("a receipt naming anything else is refused, and so is a canvas file no receipt names", async () => {
    expect(await status(stray)).toBe(403);
    expect(await status(outside)).toBe(403);
    expect(await status(unnamed)).toBe(403);
  });
});

// The formats above are the Swift builders'. Read here so a change to one is a change to the receipt's parser too:
// otherwise the receipt quietly stops matching and Tyler is back to the picture of his own screen.
describe("the parser reads the formats the apps write", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

  test("the canvas's, the Show's and the phone video's message lines", () => {
    const canvas = read("design/ConchDesign/Sources/ConchDesign/Canvas.swift");
    expect(canvas).toContain('var lines = [picture, "[canvas] Tyler marked up \\(label)."]');
    expect(canvas).toContain('lines.append("Clean screen + marks: \\(clean), \\(marks)")');
    expect(canvas).toContain('lines.append("conch can\'t see the screen without the Screen Recording permission, so the picture is his marks alone. Marks: \\(marks)")');
    expect(canvas).toContain('"To mark your answer on this canvas, frame your marks {canvas: \\"\\(document.id)\\"}."');
    expect(canvas).toContain('return "\\(number). \\(place(document.target(of: note) ?? note)): \\"\\(words)\\""');
    const show = read("design/ConchDesign/Sources/ConchDesign/CanvasShow.swift");
    expect(show).toContain('var lines = ["[canvas] Tyler showed \\(label) (\\(clock(length))).", "Storyboard: \\(storyboard)"]');
    expect(show).toContain('"\\(stamp(frame.moment.at)) \\(frame.path) — \\(happened(frame.moment, first: index == 0, words: words[index]))"');
    expect(show).toContain('lines.append("The recording, for people (agents can\'t watch video): \\(video)")');
    expect(show).toContain('(words.isEmpty ? "" : "\\"\\(words)\\" · ") + caption(moment, first: first)');
    const video = read("design/ConchDesign/Sources/ConchDesign/VideoStoryboard.swift");
    expect(video).toContain('"[video] Tyler sent a video from his phone (\\(CanvasStoryboard.clock(length))).",');
    expect(video).toContain('"Contact sheet: \\(sheet) — \\(frames.count) frame\\(frames.count == 1 ? "" : "s"), left to right and down, each stamped with its time:",');
    expect(video).toContain('if !spoken.isEmpty { lines += ["What he said:"] + spoken }');
    expect(video).toContain('lines.append("The video itself, for people (agents can\'t watch video): \\(video)")');
    // Where conch keeps them.
    expect(read("mac-app/conch-mac/CanvasSend.swift")).toContain('appendingPathComponent(".cache/conch/canvas", isDirectory: true)');
    expect(read("src/daemon.ts")).toContain('new PhoneUploads(join(CONCH_DATA, "uploads"))');
  });
});

// The rows the apps draw for a receipt, pinned in their source: compact, never the material's 320 pt picture.
describe("both apps draw a receipt as one quiet row", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
  const mac = read("mac-app/conch-mac/ConversationStackView.swift");
  const phone = read("mobile/conch-ios/conch-ios/ConversationStack.swift");
  const row = read("design/ConchDesign/Sources/ConchDesign/SentReceipt.swift");
  const between = (source: string, from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

  test("the shared row is a 44 × 30 thumbnail, the title and the detail, and nothing big", () => {
    expect(row).toContain("nonisolated public static let thumbnailSize = CGSize(width: 44, height: 30)");
    expect(row).toContain(".frame(width: Self.thumbnailSize.width, height: Self.thumbnailSize.height)");
    expect(row).toContain(".lineLimit(1)");
    expect(row).toContain(".lineLimit(3)");
    expect(row.slice(row.indexOf("public struct SentReceiptRow"))).not.toMatch(/maxHeight|\b320\b/);
  });

  test("the Mac's user row is the receipt's when there is one, opened in Quick Look", () => {
    const user = between(mac, "        case .user:\n", "        case .assistant:");
    expect(user).toContain("if let receipt = item.receipt {");
    expect(user).toContain("SentReceiptBubble(receipt: receipt)");
    expect(user).not.toContain("MaterialRow");
    const bubble = between(mac, "private struct SentReceiptBubble: View {", "private struct MaterialRow: View {");
    expect(bubble).toContain("SentReceiptRow(receipt: receipt, thumbnail:");
    expect(bubble).toContain(".quickLookPreview($preview)");
    expect(bubble).toContain("kCGImageSourceThumbnailMaxPixelSize");
    expect(bubble).not.toContain("maxHeight: 320");
  });

  test("the phone's user row is the receipt's when there is one, opened in the sheet any Mac file opens in", () => {
    const user = between(phone, '        case "user":\n', '        case "thinking":');
    expect(user).toContain("if let receipt = item.receipt {");
    expect(user).toContain("openFile = FileLink(id: $0)");
    expect(user).not.toContain("MaterialRow");
    const bubble = between(phone, "private struct SentReceiptBubble: View {", "private struct MaterialRow: View {");
    expect(bubble).toContain("SentReceiptRow(");
    expect(bubble).toContain("fill: ConchColor.surfaceRaised,");
    expect(bubble).not.toContain("maxHeight: 320");
  });

  test("the overlay says its title alone, and a pending bubble gives way to the receipt that names its file", () => {
    expect(read("mac-app/conch-mac/FloatingPanels.swift"))
      .toContain("text: $0.receipt?.title ?? whole[HistorySnapshot.nativeId(forSnapshotItem: $0.id)] ?? $0.text");
    for (const path of ["mac-app/conch-mac/StateStore.swift", "mobile/conch-ios/conch-ios/TalkController.swift"]) {
      expect(read(path)).toContain("|| $0.receipt?.stands(for: message.text) == true");
    }
    for (const path of ["mac-app/conch-mac/Models.swift", "mobile/conch-ios/conch-ios/Models.swift"]) {
      expect(read(path)).toContain("receipt = try? c.decodeIfPresent(ConchSentReceipt.self, forKey: .receipt)");
    }
  });
});

// A published item as the apps decode it: the receipt rides on the item, never replacing its kind or its text.
test("an item with a receipt is still Tyler's, with words for anything that reads only text", () => {
  const item: ConversationItem = rows(canvasMessage())[0]!;
  expect([item.kind, item.text.startsWith(item.receipt!.title)]).toEqual(["user", true]);
});

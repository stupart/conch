import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { conversationImagesDir, emptyConversation, reduceClaudeLine } from "../src/conversation.ts";

// 2026-10-09, Tyler: "this message sent twice and images aren't rendering properly as images in the chat". A screenshot
// dropped on the composer reached Claude Code as "[Image #10]" plus ~528,000 characters of base64, over the inline cap,
// and as a queued command because the session was mid-turn: no picture, the stand-in in the words, and a bubble that
// never matched.
const BIG = Buffer.alloc(400 * 1024, 7).toString("base64"); // ~546,000 base64 characters: past MAX_INLINE_IMAGE_BASE64
const SMALL = Buffer.from("tiny png").toString("base64");
const items = (conversation: ReturnType<typeof emptyConversation>) => conversation.order.map((key) => conversation.items[key]!);

describe("pictures you send show as pictures", () => {
  test("a queued message's screenshot is kept as a file the chat draws, and its stand-in leaves the words", () => {
    const conversation = emptyConversation("s");
    reduceClaudeLine(conversation, {
      type: "attachment",
      uuid: "u1",
      timestamp: "2026-10-09T01:59:00.000Z",
      attachment: {
        type: "queued_command",
        origin: { kind: "human" },
        source_uuid: "q1",
        prompt: [
          { type: "text", text: "[Image #10]oh geeze i found another error" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: BIG } },
        ],
      },
    });
    const [said, picture] = items(conversation);
    expect(said).toMatchObject({ kind: "user", text: "oh geeze i found another error" });
    expect(picture?.kind).toBe("material");
    expect(picture?.material?.kind).toBe("image");
    expect(picture?.material?.dataUrl).toBeUndefined();
    const path = picture?.material?.path ?? "";
    expect(path.startsWith(conversationImagesDir())).toBe(true);
    expect(path.endsWith(".png")).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).equals(Buffer.from(BIG, "base64"))).toBe(true);
  });

  test("the same picture read again writes nothing new and names the same file", () => {
    const read = () => {
      const conversation = emptyConversation("s");
      reduceClaudeLine(conversation, {
        type: "user", uuid: "u2", timestamp: "2026-10-09T02:00:00.000Z",
        message: { role: "user", content: [
          { type: "text", text: "[Image #3] look at this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: BIG } },
        ] },
      });
      return items(conversation);
    };
    const first = read();
    const second = read();
    expect(first[0]).toMatchObject({ kind: "user", text: "look at this" });
    expect(second[1]?.material?.path).toBe(first[1]?.material?.path);
  });

  test("a small picture still goes inline, and words with no picture keep any bracketed text", () => {
    const conversation = emptyConversation("s");
    reduceClaudeLine(conversation, {
      type: "user", uuid: "u3", timestamp: "2026-10-09T02:01:00.000Z",
      message: { role: "user", content: [
        { type: "text", text: "[Image #1] small one" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: SMALL } },
      ] },
    });
    reduceClaudeLine(conversation, {
      type: "user", uuid: "u4", timestamp: "2026-10-09T02:02:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "what does [Image #2] mean?" }] },
    });
    const [small, inline, words] = items(conversation);
    expect(small).toMatchObject({ kind: "user", text: "small one" });
    expect(inline?.material?.dataUrl).toBe(`data:image/png;base64,${SMALL}`);
    expect(inline?.material?.path).toBeUndefined();
    expect(words).toMatchObject({ kind: "user", text: "what does [Image #2] mean?" });
  });
});

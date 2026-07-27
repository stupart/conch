import { describe, expect, test } from "bun:test";
import {
  OSC_52_MAX_PAYLOAD_BYTES,
  SGR_MOUSE_MAX_CARRY,
  SgrMouseParser,
  buildClipboardEscape,
  buildOsc52,
  wrapTmuxDcs,
} from "../src/theater-mouse.ts";

describe("SgrMouseParser", () => {
  test("classifies wheel, button, drag, and release reports", () => {
    const parser = new SgrMouseParser();
    const result = parser.feed(
      "\x1b[<64;10;4M"
      + "\x1b[<65;11;5M"
      + "\x1b[<0;12;6M"
      + "\x1b[<33;13;7M"
      + "\x1b[<1;14;8m",
    );

    expect(result).toEqual({
      events: [
        { kind: "wheel", delta: -1, column: 10, row: 4 },
        { kind: "wheel", delta: 1, column: 11, row: 5 },
        { kind: "down", button: 0, column: 12, row: 6 },
        { kind: "drag", button: 1, column: 13, row: 7 },
        { kind: "up", button: 1, column: 14, row: 8 },
      ],
      rest: "",
    });
  });

  test("masks modifiers and drops passive 1003 motion", () => {
    const parser = new SgrMouseParser();
    const result = parser.feed(
      "\x1b[<68;1;2M" // Shift + wheel up
      + "\x1b[<81;3;4M" // Ctrl + wheel down
      + "\x1b[<44;5;6M" // Meta + left drag
      + "\x1b[<51;7;8M" // Ctrl + buttonless motion
      + "\x1b[<20;9;10m", // Shift + Ctrl + left release
    );

    expect(result.events).toEqual([
      { kind: "wheel", delta: -1, column: 1, row: 2 },
      { kind: "wheel", delta: 1, column: 3, row: 4 },
      { kind: "drag", button: 0, column: 5, row: 6 },
      { kind: "up", button: 0, column: 9, row: 10 },
    ]);
    expect(result.rest).toBe("");
  });

  test("leaves coalesced keyboard input in byte order", () => {
    const parser = new SgrMouseParser();
    const result = parser.feed(
      `a\x1b[<65;10;4M\x1b[Ab\x1b[<0;3;2M\x03`,
    );

    expect(result.events).toEqual([
      { kind: "wheel", delta: 1, column: 10, row: 4 },
      { kind: "down", button: 0, column: 3, row: 2 },
    ]);
    expect(result.rest).toBe("a\x1b[Ab\x03");
  });

  test("keeps every daemon control exact after a valid mouse report", () => {
    for (const key of [
      "p",
      "m",
      ",",
      "\x1b[A",
      "\x1bOA",
      "\x1b[B",
      "\x1bOB",
      "\x1b",
      "\x03",
    ]) {
      const parser = new SgrMouseParser();
      expect(parser.feed(`\x1b[<65;10;4M${key}`)).toEqual({
        events: [{ kind: "wheel", delta: 1, column: 10, row: 4 }],
        rest: key,
      });
    }
  });

  test("never consumes bare Escape, arrows, or Ctrl-C", () => {
    const parser = new SgrMouseParser();

    expect(parser.feed("\x1b")).toEqual({ events: [], rest: "\x1b" });
    expect(parser.feed("\x1b[A")).toEqual({ events: [], rest: "\x1b[A" });
    expect(parser.feed("\x03")).toEqual({ events: [], rest: "\x03" });
  });

  test("decodes a report split after its SGR introducer exactly once", () => {
    const parser = new SgrMouseParser();

    expect(parser.feed("before\x1b[<65;10")).toEqual({
      events: [],
      rest: "before",
    });
    expect(parser.feed(";4Mafter")).toEqual({
      events: [{ kind: "wheel", delta: 1, column: 10, row: 4 }],
      rest: "after",
    });
  });

  test("decodes a report split immediately after ESC[", () => {
    const parser = new SgrMouseParser();

    expect(parser.feed("before\x1b[")).toEqual({
      events: [],
      rest: "before",
    });
    expect(parser.feed("<65;10;4Mafter")).toEqual({
      events: [{ kind: "wheel", delta: 1, column: 10, row: 4 }],
      rest: "after",
    });
  });

  test("replays ESC[ as residue when the continuation is an arrow", () => {
    const parser = new SgrMouseParser();

    expect(parser.feed("\x1b[")).toEqual({ events: [], rest: "" });
    expect(parser.feed("A")).toEqual({ events: [], rest: "\x1b[A" });
  });

  test("replays an invalid carried prefix without losing its continuation", () => {
    const parser = new SgrMouseParser();

    expect(parser.feed("\x1b[<65;10;")).toEqual({ events: [], rest: "" });
    expect(parser.feed("\x03\x1b[A")).toEqual({
      events: [],
      rest: "\x1b[<65;10;\x03\x1b[A",
    });
  });

  test("preserves malformed reports and still finds a later valid report", () => {
    const parser = new SgrMouseParser();
    const malformed = "\x1b[<65;x;4M";
    const result = parser.feed(`${malformed}!\x1b[<64;2;3M?`);

    expect(result.events).toEqual([
      { kind: "wheel", delta: -1, column: 2, row: 3 },
    ]);
    expect(result.rest).toBe(`${malformed}!?`);
  });

  test("bounds an unfinished mouse-looking carry and recovers as residue", () => {
    const parser = new SgrMouseParser();
    const garbage = `\x1b[<${"1".repeat(SGR_MOUSE_MAX_CARRY)}`;

    expect(garbage.length).toBeGreaterThan(SGR_MOUSE_MAX_CARRY);
    expect(parser.feed(garbage)).toEqual({ events: [], rest: garbage });
    expect(parser.feed(";2;3M\x03")).toEqual({
      events: [],
      rest: ";2;3M\x03",
    });
  });

  test("drops complete but unsupported mouse button reports only", () => {
    const parser = new SgrMouseParser();
    expect(parser.feed(`x\x1b[<66;2;3My`)).toEqual({
      events: [],
      rest: "xy",
    });
  });
});

describe("OSC 52 clipboard builders", () => {
  test("base64-encodes UTF-8 text", () => {
    const text = "conch 🐚 café";
    const base64 = Buffer.from(text, "utf8").toString("base64");

    expect(buildOsc52(text)).toBe(`\x1b]52;c;${base64}\x07`);
    expect(buildClipboardEscape(text)).toBe(`\x1b]52;c;${base64}\x07`);
  });

  test("tmux passthrough doubles every inner ESC and ends with ST", () => {
    const osc52 = "\x1b]52;c;YQ==\x07";
    expect(wrapTmuxDcs(osc52)).toBe(
      "\x1bPtmux;\x1b\x1b]52;c;YQ==\x07\x1b\\",
    );
    expect(buildClipboardEscape("a", true)).toBe(
      "\x1bPtmux;\x1b\x1b]52;c;YQ==\x07\x1b\\",
    );
  });

  test("skips OSC output when the encoded payload exceeds the cap", () => {
    expect(buildOsc52("abc", 4)).not.toBeNull();
    expect(buildOsc52("abcd", 4)).toBeNull();
    expect(buildClipboardEscape("abcd", true, 4)).toBeNull();
    expect(OSC_52_MAX_PAYLOAD_BYTES).toBe(100 * 1024);
  });
});

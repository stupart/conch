import { expect, test } from "bun:test";
import { ControlFrameReader, CONTROL_FRAME_MAX_BYTES } from "../src/control-framing.ts";

test("an oversized first chunk is rejected before its newline can dispatch it", () => {
  const reader = new ControlFrameReader();
  expect(() => reader.push(Buffer.from("x".repeat(CONTROL_FRAME_MAX_BYTES) + "\n"))).toThrow("frame exceeds");
});

test("the delimiter needs one byte even when the body arrives in separate chunks", () => {
  const reader = new ControlFrameReader();
  expect(reader.push(Buffer.alloc(CONTROL_FRAME_MAX_BYTES - 1, 32))).toBeUndefined();
  expect(() => reader.push(Buffer.from("x"))).toThrow("frame exceeds");
});

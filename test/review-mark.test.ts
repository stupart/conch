import { expect, test } from "bun:test";
import { speakable } from "../src/snippet.ts";

/**
 * Speech must not read the review mark aloud. The terminal and both apps mark a review with a check (`✓`, U+2713),
 * and the failure mode is audible: conch reading "check needs review" into your ear.
 */
test("the review mark is stripped before anything is spoken", () => {
  expect(speakable("✓ needs review")).toBe("needs review");
  expect(speakable("✓ Hero v3 render")).toBe("Hero v3 render");
});

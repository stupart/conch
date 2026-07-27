import { describe, expect, test } from "bun:test";
import { TheaterSelection } from "../src/theater-selection.ts";

const doc = [
  { text: "alpha" },
  { text: "bravo" },
  { text: "charlie" },
] as const;

function select(
  anchor: { line: number; column: number },
  focus: { line: number; column: number },
  fingerprint = "reply:a:17",
): TheaterSelection {
  const selection = new TheaterSelection();
  selection.begin(anchor, fingerprint);
  selection.update(focus);
  selection.end();
  return selection;
}

describe("TheaterSelection", () => {
  test("tracks begin, changed updates, end, and idempotent clear", () => {
    const selection = new TheaterSelection();
    expect(selection.active).toBeFalse();
    expect(selection.dragging).toBeFalse();
    expect(selection.clear()).toBeFalse();

    selection.begin({ line: 0, column: 1 }, "reply:a:17");
    expect(selection.active).toBeTrue();
    expect(selection.dragging).toBeTrue();
    expect(selection.fingerprint).toBe("reply:a:17");
    expect(selection.update({ line: 0, column: 1 })).toBeFalse();
    expect(selection.update({ line: 0, column: 4 })).toBeTrue();
    expect(selection.update({ line: 0, column: 4 })).toBeFalse();

    selection.end();
    expect(selection.active).toBeTrue();
    expect(selection.dragging).toBeFalse();
    expect(selection.update({ line: 0, column: 5 })).toBeFalse();
    expect(selection.extract(doc)).toBe("lph");
    expect(selection.clear()).toBeTrue();
    expect(selection.clear()).toBeFalse();
    expect(selection.fingerprint).toBe("");
  });

  test("treats an empty click as clear and never as copyable text", () => {
    const selection = new TheaterSelection();
    selection.begin({ line: 1, column: 2 }, "reply:a:17");
    expect(selection.extract(doc)).toBe("");

    selection.end();
    expect(selection.active).toBeFalse();
    expect(selection.dragging).toBeFalse();
    expect(selection.extract(doc)).toBe("");
    expect(selection.clear()).toBeFalse();
  });

  test("normalizes forward and backward multiline selections equivalently", () => {
    const forward = select(
      { line: 0, column: 2 },
      { line: 2, column: 3 },
    );
    const backward = select(
      { line: 2, column: 3 },
      { line: 0, column: 2 },
    );

    for (const selection of [forward, backward]) {
      expect(selection.extract(doc)).toBe("pha\nbravo\ncha");
      expect(selection.spanFor(0, doc[0].text.length)).toEqual({ start: 2, end: 5 });
      expect(selection.spanFor(1, doc[1].text.length)).toEqual({ start: 0, end: 5 });
      expect(selection.spanFor(2, doc[2].text.length)).toEqual({ start: 0, end: 3 });
      expect(selection.spanFor(3, 100)).toBeNull();
    }
  });

  test("preserves selected line breaks even when an endpoint span is empty", () => {
    const selection = select(
      { line: 0, column: doc[0].text.length },
      { line: 1, column: 0 },
    );

    expect(selection.extract(doc)).toBe("\n");
    expect(selection.spanFor(0, doc[0].text.length)).toBeNull();
    expect(selection.spanFor(1, doc[1].text.length)).toBeNull();
    expect(selection.active).toBeTrue();
  });

  test("clamps unsafe points and spans to available document text", () => {
    const selection = select(
      { line: -4.8, column: -2 },
      { line: 99, column: 999 },
    );

    expect(selection.extract(doc)).toBe("alpha\nbravo\ncharlie");
    expect(selection.spanFor(0, -10)).toBeNull();
    expect(selection.spanFor(1, doc[1].text.length)).toEqual({ start: 0, end: 5 });
    expect(selection.spanFor(2, doc[2].text.length)).toEqual({ start: 0, end: 7 });
    expect(selection.spanFor(-1, 5)).toBeNull();
    expect(selection.spanFor(Number.NaN, 5)).toBeNull();
  });

  test("fingerprint guard prevents copying different text under stale coordinates", () => {
    const selection = select(
      { line: 0, column: 1 },
      { line: 0, column: 4 },
      "preview:a:5",
    );
    const changedDoc = [{ text: "WRONG" }] as const;

    expect(selection.matchesFingerprint("preview:a:5")).toBeTrue();
    expect(selection.extract(doc, "preview:a:5")).toBe("lph");
    expect(selection.extract(changedDoc, "preview:a:9")).toBe("");
    expect(selection.active).toBeTrue();

    expect(selection.clearIfFingerprintChanged("preview:a:5")).toBeFalse();
    expect(selection.clearIfFingerprintChanged("preview:a:9")).toBeTrue();
    expect(selection.active).toBeFalse();
    expect(selection.extract(changedDoc)).toBe("");
    expect(selection.clearIfFingerprintChanged("preview:a:9")).toBeFalse();
  });
});

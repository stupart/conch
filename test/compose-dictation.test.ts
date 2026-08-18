import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWakeTarget } from "../src/daemon.ts";
import type { TurnEvent } from "../src/hook.ts";

const wake = (over: Partial<TurnEvent> = {}): TurnEvent => ({
  type: "wake",
  sessionId: "",
  label: "",
  announce: "",
  ...over,
});

test("a composer wake keeps its intent when it resolves to the last session", () => {
  // A bare wake resolves to whichever session last spoke, and that remembered
  // event knows nothing about the button just pressed. Losing the intent here
  // means asking for the composer and being answered into the session — the
  // exact confusion this feature removes.
  const last = wake({ type: "turn-end", sessionId: "s1", label: "conch" });
  const resolved = resolveWakeTarget(wake({ compose: true }), last);

  expect(resolved?.sessionId).toBe("s1");
  expect(resolved?.compose).toBe(true);
});

test("an ordinary wake stays ordinary", () => {
  // The voice loop must not change: an announced turn opens the mic to REPLY,
  // and that reply belongs in the session.
  const resolved = resolveWakeTarget(
    wake({ sessionId: "s1", label: "conch" }),
    null,
  );
  expect(resolved?.compose).toBeUndefined();
});

test("a composer dictation is published, never delivered", () => {
  const source = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  const prompt = source.slice(source.indexOf('case "prompt":'));
  const branch = prompt.indexOf("if (event.compose)");
  const publish = prompt.indexOf("publishDictation(text, event.sessionId)");
  const deliver = prompt.indexOf("await deliver(event, text");

  // The compose branch has to RETURN before deliver(), or the words land in
  // both places: the composer and the session.
  expect(branch).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(branch);
  expect(publish).toBeLessThan(deliver);
  expect(prompt.slice(branch, deliver)).toContain('return "handled"');
});

test("dictation goes to the session that asked, not the one now focused", () => {
  // An audit caught this one, and caught the ORIGINAL version of this test
  // baking the bug in: it asserted append-to-`row.id` without asserting that
  // the row was the intended target. Transcription takes seconds; someone who
  // starts dictating to one session and clicks another while it runs was
  // addressing the first, and putting the words in the second is worse than
  // losing them.
  const status = readFileSync(join(import.meta.dir, "../src/status.ts"), "utf8");
  expect(status).toContain("export function publishDictation(text: string, sessionId: string)");
  expect(status).toContain("sessionId }");

  const dashboard = readFileSync(
    join(import.meta.dir, "../mac-app/conch-mac/DashboardView.swift"),
    "utf8",
  );
  // Keyed on the id, not the text: state republishes several times a second.
  expect(dashboard).toContain(".onChange(of: state?.live.dictated?.id)");
  expect(dashboard).toContain("current != appliedDictationID");
  // The target comes from the dictation, never from current focus.
  expect(dashboard).toContain("composerDrafts.appendDictation(dictated.text, to: dictated.sessionId)");
  expect(dashboard).not.toContain("appendDictation(spoken, to: row.id)");
  // The composer's own mic must ask for the composer.
  expect(dashboard).toContain(".dictate(sessionId: row.id, label: row.label)");

  const composer = readFileSync(
    join(import.meta.dir, "../mac-app/conch-mac/ComposerView.swift"),
    "utf8",
  );
  // Appended to what was typed, not substituted for it.
  expect(composer).toContain("existing.isEmpty ? spoken : existing + \" \" + spoken");
});

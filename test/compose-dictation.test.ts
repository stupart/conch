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

// "A composer dictation is published, never delivered" is executed in
// voice-loop.test.ts ("heard mid-read goes back to the composer").

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
  expect(dashboard).toContain("composerDrafts.apply(state?.live.dictated)");
  expect(dashboard).not.toContain("appendDictation(spoken, to: row.id)");
  // The composer's own mic must ask for the composer.
  expect(dashboard).toContain(".dictate(sessionId: row.id, label: row.label)");

  const composer = readFileSync(
    join(import.meta.dir, "../mac-app/conch-mac/ComposerView.swift"),
    "utf8",
  );
  // Applied once by id in the shared draft store, which the dashboard and the fog both call.
  expect(composer).toContain("guard let dictated, dictated.id != appliedDictationID else { return }");
  // The applied id must OUTLIVE the process. `live.dictated` is sticky on the daemon's side and deliberately never
  // cleared, so the id is the only thing stopping a dictation being applied twice. Holding it in memory meant every
  // relaunch reset it to 0 and a dictation the user had already received — and deleted — was appended again. Tyler,
  // after a dozen rebuilds: "this text keeps showing in the 'arch prime' session input box. i keep delting it and it
  // keeps coming back."
  expect(composer).toContain('private static let appliedDictationKey = "conch.mac.appliedDictationID.v1"');
  expect(composer).toContain("appliedDictationID = defaults.integer(forKey: Self.appliedDictationKey)");
  expect(composer).toContain("defaults.set(dictated.id, forKey: Self.appliedDictationKey)");
  // Not re-initialised to a literal, which is what made it forget.
  expect(composer).not.toContain("private var appliedDictationID = 0");
  // The target comes from the dictation, never from current focus.
  expect(composer).toContain("appendDictation(dictated.text, to: dictated.sessionId)");
  // Appended to what was typed, not substituted for it.
  expect(composer).toContain("existing.isEmpty ? spoken : existing + \" \" + spoken");
});

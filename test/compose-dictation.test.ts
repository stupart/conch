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
  const composer = readFileSync(
    join(import.meta.dir, "../mac-app/conch-mac/ComposerView.swift"),
    "utf8",
  );
  // The composer's own mic must ask for the composer: in its one construction (`SessionComposer`), which the window
  // and the panel's reply line both build.
  expect(composer).toContain(".dictate(sessionId: row.id, label: row.label)");
  // Applied once by id in the shared draft store, which the dashboard and the fog both call.
  expect(composer).toContain("guard let dictated, dictated.id != appliedDictationID else { return }");
  // The applied id must OUTLIVE the process. `live.dictated` is sticky on the daemon's side and deliberately never
  // cleared, so the id is the only thing stopping a dictation being applied twice. Holding it in memory meant every
  // relaunch reset it to 0 and a dictation the user had already received — and deleted — was appended again. Tyler,
  // after a dozen rebuilds: "this text keeps showing in the 'morrow prime' session input box. i keep delting it and it
  // keeps coming back."
  expect(composer).toContain('private static let appliedDictationKey = "conch.mac.appliedDictationID.v1"');
  expect(composer).toContain("appliedDictationID = defaults.integer(forKey: Self.appliedDictationKey)");
  expect(composer).toContain("defaults.set(dictated.id, forKey: Self.appliedDictationKey)");
  // Not re-initialised to a literal, which is what made it forget.
  expect(composer).not.toContain("private var appliedDictationID = 0");
  // The target comes from the dictation, never from current focus.
  expect(composer).toContain("appendDictation(dictated.text, to: dictated.sessionId)");
  // Appended to what was typed, not substituted for it, by the live preview's own join
  // (ConchDesign/ComposerDictation.swift, ComposerDictationTests), so what lands is what was shown.
  expect(composer).toContain("entry.text = ComposerDictation.appending(text, to: entry.text)");
});

/**
 * The whole dictation in the input bar, after the draft, as it is spoken.
 *
 * 2026-10-05, Tyler: "make the transcript accumulate in the input bar with whatever text is already there instead of
 * just showing like the last few words". The composer showed `live.partial`, which is only the segment being heard:
 * everything said before it was in `transcriptPrefix`, which no composer read, and the draft vanished behind it.
 * The logic is ConchDesign's (`ComposerDictation`, with XCTests); this pins the wiring to it.
 */
test("the composer shows the draft and every word said so far, for its own session only", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, "..", file), "utf8");
  const model = read("mac-app/conch-mac/Workspace.swift");
  const accessor = model.slice(model.indexOf("static func dictation(of row: SessionRow?, in state: PublishedState?)"));
  // Only the row the voice is on, by identity; and all of it, not only the segment being heard.
  expect(accessor).toContain("WorkspaceFocus.isAddressed(row.id, in: Workspace(state)) else { return nil }");
  expect(accessor).toContain("prefix: live.transcriptPrefix,");
  expect(accessor).toContain("partial: live.partial,");
  expect(accessor).toContain("landed: live.dictated.map { ComposerDictation.Live.Landed(id: $0.id, session: $0.sessionId) }");
  expect(model).not.toContain("return state.live.partial");

  const composer = read("mac-app/conch-mac/ComposerView.swift");
  expect(composer).toContain(
    "dictation: composerDrafts.dictationPreview(for: row.id, live: WorkspaceModel.dictation(of: row, in: state)),",
  );
  // Only the composer's own mic makes a dictation into the draft: noted as it asks, so the words show joining the
  // draft. A voice turn (the loop's reply, Space, the menu bar) goes to the session, and its words show alone.
  const talk = composer.slice(composer.indexOf("onTalk: {"));
  expect(talk.indexOf("composerDrafts.requestDictation(for: row.id)")).toBeGreaterThan(-1);
  expect(talk.indexOf("composerDrafts.requestDictation(for: row.id)")).toBeLessThan(
    talk.indexOf("store.send(.dictate(sessionId: row.id, label: row.label))"),
  );
  expect(composer).toContain("ComposerDictation.preview(draft: drafts[sessionID]?.text ?? \"\", transcript: $0, joining: follower.composing)");
  // Followed in the shared store, so the input moving between the window and the panel mid-dictation does not start it
  // over, and never published from inside a view's update.
  expect(composer).toContain("private var followers: [String: ComposerDictation.Follower] = [:]");
  expect(composer).not.toContain("@Published private var followers");
  const preview = composer.slice(composer.indexOf("func dictationPreview(for sessionID: String, live: ComposerDictation.Live?)"));
  expect(preview.slice(0, preview.indexOf("\n    }\n"))).toContain("applied: appliedDictationID, requested: requested");
  // The preview never writes the draft: only `apply` does, once, by id.
  expect(preview.slice(0, preview.indexOf("\n    }\n"))).not.toContain("update(");
  // The editor stays, read-only, under the dictation, and nothing sends half a message while words are still coming.
  expect(composer).toContain(".readOnly(dictation != nil) { typedWhileDictating = true }");
  expect(composer).toContain(".opacity(dictation == nil ? 1 : 0)");
  expect(composer).toContain(".frame(height: dictation == nil ? nil : 0, alignment: .top)");
  expect(composer).toContain("!composed.isEmpty && !isSending && messageUnavailableReason == nil && dictation == nil");
  expect(composer).not.toContain("Text(dictation)");
  expect(composer).not.toContain(".foregroundStyle(ConchPalette.brandCyan)\n                    .padding(.top, Self.fieldInsetTop)");

  // Read-only without `isEditable = false`, which the window's single-key shortcuts read as "no text field has the
  // keyboard" (DashboardInputMonitor): Space and the letters typed into the field would have worked the window.
  const editor = read("mac-app/conch-mac/ComposerEditor.swift");
  const coordinator = editor.slice(editor.indexOf("final class Coordinator: NSObject, NSTextViewDelegate {"));
  expect(coordinator.slice(0, coordinator.indexOf("final class ComposerTextView"))).not.toContain("isEditable = ");
  expect(editor).toContain("func undoManager(for view: NSTextView) -> UndoManager? { readOnly ? nothingToUndo : undo }");
  expect(editor).toContain("if refusesTyping, ComposerDictation.types(");
  // The field catches up with the draft only once the dictation is over, so the landing is one edit with its own undo.
  expect(editor).toContain("} else if !isReadOnly {");
});

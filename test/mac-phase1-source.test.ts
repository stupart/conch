import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const macRoot = join(import.meta.dir, "..", "mac-app", "conch-mac");
const mac = (name: string) => readFileSync(join(macRoot, name), "utf8");

describe("the Mac conversation stays readable while it grows", () => {
  const conversation = mac("ConversationStackView.swift");
  const models = mac("Models.swift");
  const store = mac("StateStore.swift");

  test("the bounded conversation is eagerly laid out", () => {
    // A streaming row changes the document height several times a second. A
    // lazy stack can leave the viewport at an offset whose rows have not been
    // materialised yet, exposing only the black scroll background.
    expect(conversation).not.toContain("LazyVStack");
    expect(conversation).toMatch(/VStack\(alignment: \.leading, spacing: 14\)/);
  });

  test("only a real user scroll changes whether growth is followed", () => {
    // Measuring after content growth races with the follow decision: the new
    // height makes a previously-bottomed reader look scrolled up. AppKit's live
    // scroll notifications describe the person's action instead.
    expect(conversation).toContain("ConversationScrollObserver");
    expect(conversation).toContain("NSScrollView.didLiveScrollNotification");
    expect(conversation).toContain("NSScrollView.didEndLiveScrollNotification");
    expect(conversation).toMatch(/onUserScroll\(document\.height <= visible\.height \|\| distance <= 8\)/);
    expect(conversation).toMatch(/pinnedToBottom = isAtBottom/);
  });

  test("conversation revisions defer one nonanimated bottom request", () => {
    // The daemon heartbeat is not conversation growth, and an animated scroll
    // that restarts on every streamed token never reaches a stable viewport.
    expect(conversation).toContain("private var revisionVector");
    expect(conversation).toContain(".onChange(of: revisionVector)");
    expect(conversation).toContain("await Task.yield()");
    expect(conversation).toContain("transaction.disablesAnimations = true");
    expect(conversation).not.toContain("withAnimation");
  });

  test("timestamp heartbeats update liveness without republishing the dashboard", () => {
    // `sourceState` remains the authoritative fresh snapshot for liveness and
    // command reconciliation; only the presentation comparison omits `ts`.
    const comparison = models.slice(models.indexOf("func hasSamePresentation"));
    const body = comparison.slice(0, comparison.indexOf("\n    }"));
    expect(body).not.toMatch(/\bts\b/);
    expect(store).toMatch(/sourceState = snapshot[\s\S]*rebuildPresentedState\(\)/);
    expect(store).toContain("state?.hasSamePresentation(as: next) != true");
  });
});

describe("the Mac composer belongs to one session", () => {
  const composer = mac("ComposerView.swift");
  const dashboard = mac("DashboardView.swift");

  test("text and attachments are persisted together under the session id", () => {
    // Files are part of the message. Persisting only the text still lets a
    // screenshot silently follow the user into another agent's composer.
    expect(composer).toMatch(/final class ComposerDraftStore: ObservableObject/);
    expect(composer).toMatch(/private var drafts: \[String: Entry\]/);
    expect(composer).toMatch(/var text = ""[\s\S]*var attachments: \[URL\] = \[\]/);
    expect(composer).toContain("conch.mac.composerDrafts.v1");
    expect(composer).toMatch(/JSONDecoder\(\)\.decode\(\[String: Entry\]\.self/);
    expect(composer).toMatch(/JSONEncoder\(\)\.encode\(drafts\)/);
  });

  test("the view receives bindings for the focused row rather than owning a global draft", () => {
    expect(composer).toMatch(/@Binding var draft: String/);
    expect(composer).toMatch(/@Binding var attachments: \[URL\]/);
    expect(composer).not.toMatch(/@State private var (draft|attachments)/);
    expect(dashboard).toMatch(/@StateObject private var composerDrafts = ComposerDraftStore\(\)/);
    expect(dashboard).toContain("draft: composerDrafts.textBinding(for: row.id)");
    expect(dashboard).toContain("attachments: composerDrafts.attachmentsBinding(for: row.id)");
  });

  test("an attachment claims the session just as typing does", () => {
    // Without this, live-session following can move the pane after a file was
    // attached and leave that file poised to send through another row's closure.
    const chooser = composer.slice(composer.indexOf("private func chooseFiles()"));
    expect(chooser).toMatch(/attachments\.append[\s\S]*onDraftStarted\(\)/);
    const drop = composer.slice(composer.indexOf("private func load("));
    expect(drop).toMatch(/attachments\.append\(url\)[\s\S]*onDraftStarted\(\)/);
  });

  test("image attachments render a thumbnail instead of only a filename", () => {
    expect(composer).toContain("private struct AttachmentPreview: View");
    expect(composer).toContain("NSImage(contentsOf: url)");
    expect(composer).toContain("Image(nsImage: image)");
    expect(composer).toContain(".scaledToFill()");
    expect(composer).toContain(".help(url.lastPathComponent)");
  });

  test("a draft is cleared only after its socket delivery succeeds", () => {
    // Switching sessions and a failed send are the two moments a locally owned
    // draft is most vulnerable. The socket result must arrive before the store
    // removes only the submitted prefix and attachments.
    const send = composer.slice(composer.indexOf("private func send()"));
    expect(composer).toContain("let onSend: (String) -> Task<Bool, Never>");
    expect(send).toMatch(/let delivered = await delivery\.value[\s\S]*guard delivered else \{ return \}/);
    expect(send.indexOf("guard delivered else { return }")).toBeLessThan(send.indexOf('draft = ""'));
    expect(send).toContain("draft.hasPrefix(submittedDraft)");
    expect(send).toContain("submittedAttachments.contains($0)");
  });
});

describe("the Mac exposes only auto and manual mode", () => {
  test("no authored Mac surface retains the destructive mute vocabulary", () => {
    const authored = readdirSync(macRoot)
      .filter((name) => name.endsWith(".swift"))
      .map(mac)
      .join("\n");
    expect(authored).not.toMatch(/\b(?:mute|muted|unmute)\b/i);
    expect(readFileSync(join(macRoot, "..", "README.md"), "utf8"))
      .not.toMatch(/\b(?:mute|muted|unmute)\b/i);
  });

  test("the remaining mode control names both states", () => {
    const dashboard = mac("DashboardView.swift");
    expect(dashboard).toMatch(/Text\(isManual \? "Manual" : "Auto"\)/);
    expect(dashboard).toContain("action: actions.onPauseOrResume");
    expect(mac("ConchSocketClient.swift")).not.toMatch(/case (?:mute|unmute)/);
    expect(mac("DashboardInputMonitor.swift")).not.toMatch(/case "m"/);
  });
});

describe("Mac conversation links keep the native clickable path", () => {
  test("SwiftUI receives the markdown link attribute without an interaction override", () => {
    const conversation = mac("ConversationStackView.swift");
    expect(conversation).toContain("Text(AttributedString.conchMarkdown(item.text))");
    expect(conversation).toContain("interpretedSyntax: .inlineOnlyPreservingWhitespace");
    expect(conversation).not.toContain(".allowsHitTesting(false)");
    expect(conversation).not.toContain("openURL");
  });

  test("the fallback AppKit renderer preserves rich selectable attributed text", () => {
    const dashboard = mac("DashboardView.swift");
    expect(dashboard).toContain("NSAttributedString(AttributedString(parsed[run.range]))");
    expect(dashboard).toContain("textView.isSelectable = true");
    expect(dashboard).toContain("textView.isRichText = true");
  });
});

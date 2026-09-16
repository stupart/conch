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
    // The spacing is not this test's business — it named a number only to point at the
    // container, so changing §3's reading rhythm broke a test about laziness. The value
    // has its own guard below.
    expect(conversation).toMatch(/VStack\(alignment: \.leading, spacing: \d+\)/);
  });

  test("the transcript keeps §3's reading rhythm: 22 between messages, an 18 bubble on fill", () => {
    // workspace-v1 §3: "22 pt between messages" and "your turns in a `fill` bubble, radius 18".
    expect(conversation).toMatch(/VStack\(alignment: \.leading, spacing: 22\)/);
    // 18 is exactly ConchRadius.large, so it comes from Tokens rather than being retyped —
    // a literal here is how the design system and the app drift apart.
    expect(conversation).toContain(
      ".background(ConchPalette.fill, in: RoundedRectangle(cornerRadius: ConchRadius.large))",
    );
    expect(conversation).not.toContain("cornerRadius: 12))");
    expect(mac("Palette.swift")).toContain("static let fill = ConchColor.fill.dynamic");
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

  test("the composer floats at the measure rather than spanning the frame (§3)", () => {
    // Found by LOOKING at it (conch shot, 2026-09-17): the transcript is set to a 700 pt
    // column while the composer was twice that and flush to the bottom edge, so the reply and
    // the thing being replied to did not share a column.
    expect(composer).toContain(
      "in: RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)",
    );
    // §3 names "floating elevation", so it takes the token. ReviewView hand-rolls a shadow
    // that matches nothing in the scale; a literal that happens to look right is how the
    // design system and the app come apart.
    expect(composer).toContain(".conchElevation(.floating)");
    expect(composer).toContain(".padding(.bottom, 14)");
    // THE SAME constant the transcript uses, not a second 700 typed here.
    expect(composer).toContain(".frame(maxWidth: ConversationTextView.maxMeasure)");
    expect(mac("ConversationStackView.swift")).toContain("ConversationTextView.maxMeasure");
    // The hairline went with the bar it separated; a floating card needs no rule above it.
    expect(composer).not.toContain("Rectangle().fill(ConchPalette.divider).frame(height: 1)");
    // conchElevation and ConchRadius both come from the design system, and CI builds no app.
    expect(composer).toContain("import ConchDesign");
  });

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
    expect(composer).toContain("static let shared = ComposerDraftStore()");
    expect(dashboard).toMatch(/@ObservedObject private var composerDrafts = ComposerDraftStore\.shared/);
    expect(dashboard).toContain("draft: composerDrafts.textBinding(for: row.id)");
    expect(dashboard).toContain("attachments: composerDrafts.attachmentsBinding(for: row.id)");
  });

  test("an attachment claims the session just as typing does", () => {
    // Without this, live-session following can move the pane after a file was
    // attached and leave that file poised to send through another row's closure.
    // Every way in — picker, drop, paste — goes through one rule, so the claim
    // is pinned once, where it lives, with presence asserted first.
    const attachAt = composer.indexOf("private func attach(_ urls: [URL])");
    expect(attachAt).toBeGreaterThan(-1);
    const attach = composer.slice(attachAt, composer.indexOf("\n    }", attachAt));
    expect(attach).toMatch(/attachments\.append\(contentsOf: fresh\)[\s\S]*onDraftStarted\(\)/);
    const chooserAt = composer.indexOf("private func chooseFiles()");
    expect(chooserAt).toBeGreaterThan(-1);
    expect(composer.slice(chooserAt, chooserAt + 600)).toContain("attach(panel.urls)");
    const loadAt = composer.indexOf("private func load(");
    expect(loadAt).toBeGreaterThan(-1);
    expect(composer.slice(loadAt, loadAt + 400)).toContain("attach([url])");
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
    // The one override that IS allowed, and required (A13): SwiftUI's default
    // action handed a schemeless link straight to LaunchServices, which
    // answered -50 in a Finder alert. The stack's own OpenURLAction is what
    // resolves a path against the session's folder and reports a failure;
    // test/open-link.test.ts pins its shape.
    expect(conversation).toContain(".environment(\\.openURL, OpenURLAction { url in");
  });

  test("both transcript renderers agree on one reading measure", () => {
    // The stack had no measure at all — 18pt of padding and the whole window — while the
    // fallback capped at 580, so the same conversation was two different widths depending on
    // which renderer drew it.
    expect(mac("TranscriptFallback.swift")).toContain("static let maxMeasure: CGFloat = 700");
    const stack = mac("ConversationStackView.swift");
    expect(stack).toContain(".frame(maxWidth: ConversationTextView.maxMeasure, alignment: .leading)");
    expect(stack).not.toMatch(/padding\(\.vertical, 14\)\s*\.frame\(maxWidth: \.infinity, alignment: \.leading\)/);
  });

  test("the transcript reads at the spec's body size, not the caption size around it", () => {
    // workspace-v1 §3: "readingBody 15/23". Both rows that are actually READ — your turn and
    // the agent's — were set at 13, the same size as the tool rows and captions around them.
    // Counted rather than forbidden: 13 is still right for the chrome in this file.
    const stack = mac("ConversationStackView.swift");
    expect(stack.match(/\.font\(ConchType\.readingBody\)/g)?.length).toBe(2);
    expect(stack.match(/\.lineSpacing\(ConchType\.readingLineSpacing\)/g)?.length).toBe(2);
  });

  test("the fallback AppKit renderer preserves rich selectable attributed text", () => {
    const dashboard = mac("TranscriptFallback.swift");
    expect(dashboard).toContain("NSAttributedString(AttributedString(parsed[run.range]))");
    expect(dashboard).toContain("textView.isSelectable = true");
    expect(dashboard).toContain("textView.isRichText = true");
  });
});

describe("§3's anatomy, where the app had drifted from it", () => {
  const dashboard = mac("DashboardView.swift");
  const stack = mac("ConversationStackView.swift");

  test("consecutive tool steps fold, and the rows that demand action never do", () => {
    // §3: consecutive steps fold into one quiet line that opens to the steps on a hairline
    // guide. The rule itself is tested by swift test; this pins the WIRING.
    expect(stack).toContain("ToolFolding.runs(");
    expect(stack).toContain("Text(run.summary)");
    // A question is the one row on screen a person must act on — the session is blocked on
    // it. A plan is the answer to "what is it doing". Neither may be hidden behind a summary.
    expect(stack).toContain("if let asked = item.question, !asked.options.isEmpty { return false }");
    expect(stack).toContain("if let plan = item.plan, !plan.isEmpty { return false }");
    // Both loops fold, so recorded history reads the same as the live window.
    expect(stack).toContain("foldedRow(for: item, in: recordedRows, folds: recordedFolds)");
    expect(stack).toContain("foldedRow(for: item, in: conversation.items, folds: liveFolds)");
    // The run reuses the per-session expand state rather than inventing a second one.
    expect(stack).toContain("toggleExpanded(run.id)");
    expect(stack).not.toMatch(/@State private var expandedRuns/);
    // One guide down the opened steps, not a hairline per step.
    expect(stack).toContain("Rectangle().fill(ConchPalette.divider).frame(width: 1)");
  });

  test("the sidebar is the anatomy §3 describes", () => {
    // Nothing pinned ANY sidebar geometry before this, which is how it drifted unnoticed —
    // the same shape as the header sitting at a toolbar's 36 through a spec saying 52.
    const row = dashboard.slice(
      dashboard.indexOf("private struct DashboardRow: View {"),
      dashboard.indexOf("private func pulseForReview()"),
    );
    expect(row.length).toBeGreaterThan(1_000);
    expect(row.match(/RoundedRectangle\(cornerRadius: 7, style: \.continuous\)/g) ?? []).toHaveLength(3);
    expect(row).not.toContain("cornerRadius: 8");
    // 13 pt, semibold when the row wants a person, by the SAME predicate the status mark uses.
    expect(row).toContain("weight: row.status == .waiting || row.status == .needs ? .semibold : .medium");
    expect(dashboard).toContain("let wantsUser = row.status == .waiting || row.status == .needs");

    const folder = dashboard.slice(
      dashboard.indexOf("private struct FolderHeader: View {"),
      dashboard.indexOf("private struct DashboardRow: View {"),
    );
    expect(folder.length).toBeGreaterThan(400);
    expect(folder).toContain("ConchTypography.font(size: 12, weight: .medium)");
    expect(folder).toContain("ConchPalette.textFaint");
    expect(folder).not.toContain("ConchPalette.textDim");
  });

  test("the header is 52 tall, not a toolbar's 36", () => {
    // Nothing pinned this before, which is how it sat at 36 through a spec that says 52.
    const header = dashboard.slice(
      dashboard.indexOf("private func sessionBar(for row: SessionRow) -> some View {"),
      dashboard.indexOf("private func deliverableTabs("),
    );
    expect(header.length).toBeGreaterThan(500);
    expect(header).toContain(".frame(height: 52)");
    expect(header).not.toContain(".frame(height: 36)");
  });
});

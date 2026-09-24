import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const macRoot = join(import.meta.dir, "..", "mac-app", "conch-mac");
const mac = (name: string) => readFileSync(join(macRoot, name), "utf8");
const components = readFileSync(join(import.meta.dir, "..", "design", "ConchDesign", "Sources", "ConchDesign", "Components.swift"), "utf8");
const markdown = readFileSync(join(import.meta.dir, "..", "design", "ConchDesign", "Sources", "ConchDesign", "Markdown.swift"), "utf8");

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

  test("a row is redrawn only when what it shows has changed", () => {
    // The stack's body runs on every snapshot from ANY session — four a second while
    // anything is working — and used to rebuild every row each time: every markdown
    // re-parsed (44 parses a second at 30 rows, 236 once history was paged in) and the
    // whole stack re-diffed, with a frame hitch that grew with the row count — 8 ms at 30
    // rows, 58–67 ms at ~300 — landing four times a second under the scroll (Instruments,
    // 2026-09-20). EquatableView leaves a row's subtree alone while its key is unchanged.
    expect(conversation).toContain("private struct MemoRow<Key: Equatable, Content: View>: View, Equatable");
    // And the recorded rows are computed once per body. Read as a property inside the
    // loop, `recordedRows` was rebuilt for every row it was handed to — n × n items per
    // snapshot, 67% of the main thread at rest with 520 rows paged in — so the local
    // shadows it before the loop and everything below reads the local.
    const stackBody = conversation.slice(
      conversation.indexOf("VStack(alignment: .leading, spacing: 22) {"),
      conversation.indexOf("ForEach(recordedRows) { item in"),
    );
    expect(stackBody).toContain("let recordedRows = self.recordedRows");
    expect(stackBody.indexOf("let recordedRows = self.recordedRows")).toBeLessThan(stackBody.indexOf("folds(in: recordedRows)"));
    expect(conversation).toContain("MemoRow(key: rowKey(for: item)) { row(for: item) }.equatable()");
    // The deliverable card too: it reads its file, or decodes its image, in its body.
    expect(conversation).toContain("MemoRow(key: artifact) { ArtifactPreview(artifact: artifact, onOpen: onOpenArtifact) }.equatable()");
    // Every row goes through it: that is the only call of `row(for:)` in the file.
    expect(conversation).toContain("private func row(for item: ConversationItem) -> some View {");
    expect(conversation.match(/\brow\(for: /g) ?? []).toHaveLength(1);
    // The key is everything the row reads besides its callbacks; a value the row reads that
    // is missing here is a row that goes stale, so each one is pinned.
    const key = conversation.slice(
      conversation.indexOf("private func rowKey(for item: ConversationItem) -> RowKey {"),
      conversation.indexOf("private func isExpanded("),
    );
    expect(key.length).toBeGreaterThan(200);
    for (const read of [
      "item: item",
      "expanded: expanded",
      "fullText: history.fullText(forSnapshotItem: item.id)",
      "bodyStatus: expanded && wasCut(item) ? bodyStatus(for: item) : nil",
      'selections: multiSelections.filter { $0.key == item.id || $0.key.hasPrefix(item.id + "#") }',
      'typed: questionTexts.filter { $0.key.hasPrefix(item.id + "#") }',
      "hovered: item.question == nil ? nil : hoveredOption",
      "noTerminal: noTerminal",
      "canOpenInTerminal: onOpenInTerminal != nil",
    ]) expect(key).toContain(read);
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
    // The anchor IS the bottom margin. As a 1 pt line inside the stack's 14 pt bottom
    // padding, "scroll it to the bottom" left the clip 14 pt short of the document's end
    // on every revision (2576 for a bottom of 2590, measured 2026-09-20), nudged a clip
    // AppKit had clamped to the real end 14 pt UP, and — 14 being past the 8 pt the follow
    // test allows — let the next trackpad touch read as "scrolled away" and stop the follow.
    expect(conversation).toMatch(/Color\.clear\s+\.frame\(height: 14\)\s+\.id\(Self\.bottomAnchor\)/);
    expect(conversation).toContain(".padding(.top, 14)");
    expect(conversation).not.toContain(".padding(.vertical, 14)");
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

  test("the presented state carries every field the daemon published", () => {
    // The rebuild goes through a memberwise init whose newer fields default to nil, so a field it
    // doesn't name compiles and is silently dropped on every poll. That hid the conversation stack
    // for an hour once, and later `features`: Remove never showed and no item was ever marked viewed.
    const struct = models.slice(models.indexOf("struct PublishedState"), models.indexOf("init(\n", models.indexOf("struct PublishedState")));
    const fields = [...struct.matchAll(/^    let (\w+):/gm)].map((match) => match[1]);
    const rebuild = store.slice(store.indexOf("let next = PublishedState("), store.indexOf("if state?.hasSamePresentation(as: next)"));
    expect(fields).toContain("features");
    for (const field of fields) {
      if (field === "newerDaemon") continue; // derived from `v` by the init
      if (field === "rows" || field === "dismissedRows") expect(rebuild).toContain(`${field}: ${field},`);
      else expect(rebuild).toContain(`${field}: sourceState.${field}`);
    }
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
    // A named constant out of the transcript's own file, not a second number typed here —
    // but deliberately NOT the reading measure. The card floats OVER the text now, and at
    // 700 it covered the column exactly, so the page looked like it stopped at the card's
    // top edge. test/composer-underscroll.test.ts pins the size of the gap.
    expect(composer).toContain(".frame(maxWidth: ConversationTextView.composerMeasure)");
    expect(mac("ConversationStackView.swift")).toContain("ConversationTextView.maxMeasure");
    // The hairline went with the bar it separated; a floating card needs no rule above it.
    expect(composer).not.toContain("Rectangle().fill(ConchPalette.divider).frame(height: 1)");
    // conchElevation and ConchRadius both come from the design system, and CI builds no app.
    expect(composer).toContain("import ConchDesign");
  });

  test("the composer is the lab's composer, value for value", () => {
    // Every number here is read off workspace-lab.html, which is what Tyler compares against.
    // Nothing pinned any of them before, which is exactly how the composer drifted from it.

    // .cbox{border-radius:18px;padding:6px;background:var(--surface);box-shadow:<hairline>,<drop>}
    expect(composer).toContain(".padding(6)");
    expect(composer).toContain("ConchPalette.surface,");
    expect(composer).toContain("in: RoundedRectangle(cornerRadius: ConchRadius.large, style: .continuous)");
    expect(composer).toContain(".strokeBorder(ConchPalette.divider, lineWidth: 0.5)");
    expect(composer).toContain(".conchElevation(.floating)");
    // …and NO inner box. §3: the stage has one card and no others.
    expect(composer).not.toContain("RoundedRectangle(cornerRadius: 8).fill(ConchPalette.bg)");

    // #ta{font:var(--read)/22px; padding:8px 10px 4px; max-height:8 lines}
    expect(composer).toContain(".font(ConchType.readingBody)");
    expect(composer).toContain("static let lineHeight: CGFloat = 22");
    expect(composer).toContain("Self.lineHeight * 8");
    expect(composer).toContain("static let fieldInsetTop: CGFloat = 8");
    expect(composer).toContain("static let fieldInsetBottom: CGFloat = 4");
    expect(composer).toContain("static let fieldInsetX: CGFloat = 10");

    // .cbar{gap:4px;height:34px;padding-left:2px}
    expect(composer).toContain("HStack(alignment: .center, spacing: 4) {");
    expect(composer).toContain(".frame(height: 34)");
    expect(composer).toContain(".padding(.leading, 2)");

    // .mic and .send are both 30, where the plain .ib buttons stay 28.
    expect(composer.match(/\.frame\(width: 30, height: 30\)/g) ?? []).toHaveLength(2);
    expect(composer).toContain(".frame(width: 28, height: 28)");
    // .mic{background:var(--fill)} at rest. The VOICE colours are deliberately untouched —
    // Palette.swift says that language moves as its own change, to be seen and reacted to.
    expect(composer).toContain("default: return ConchPalette.fill");
    expect(composer).toContain('case "listening", "recording": return ConchPalette.brandCyan');

    // .send{background:var(--accent);color:var(--onAccent)} — near-black ink, not brand cyan,
    // which is reserved for "your microphone is open".
    expect(composer).toContain("canSend ? ConchPalette.ink : ConchPalette.fill");
    expect(composer).toContain("canSend ? ConchPalette.onInk : ConchPalette.textFaint");

    // .cap{font:500 12px} and .dest{gap:5px;font-size:12px;color:var(--text3);margin-left:8px}
    expect(composer).toContain("ConchTypography.font(size: 12, weight: .medium)");
    expect(composer).toContain("AgentBadge(backend: backend)");
    // The chip itself: mark, then label, at .dest's gap/size/colour/indent.
    const at = composer.indexOf("HStack(spacing: 5) {");
    expect(at).toBeGreaterThan(-1);
    const dest = composer.slice(at, composer.indexOf(".layoutPriority(-1)", at));
    expect(dest.length).toBeGreaterThan(120);
    expect(dest).toContain("AgentBadge(backend: backend)");
    expect(dest).toContain("Text(sessionLabel)");
    expect(dest).toContain("ConchTypography.font(size: 12)");
    expect(dest).toContain(".foregroundStyle(ConchPalette.textFaint)");
    expect(dest).toContain(".padding(.leading, 8)");

    // The tokens the send button needs, exposed without repurposing the legacy orange accent.
    // The lab's bar order: + · mic · cap · dest · <sp> · recite · send. Recite sat BEFORE the
    // spacer, which parks the speaker against the destination instead of beside send. Nothing
    // pinned the order, which is how it drifted.
    const iDest = composer.indexOf("AgentBadge(backend: backend)");
    const iSpacer = composer.indexOf("Spacer(minLength: 8)");
    const iRecite = composer.indexOf("Button(action: onRecite)");
    const iSend = composer.indexOf("Button(action: send)");
    for (const at of [iDest, iSpacer, iRecite, iSend]) expect(at).toBeGreaterThan(-1);
    expect(iDest).toBeLessThan(iSpacer);
    expect(iSpacer).toBeLessThan(iRecite);
    expect(iRecite).toBeLessThan(iSend);

    // `.cbar` sits directly under `#ta` inside `.cbox`: no stack gap between them.
    expect(composer).toContain("VStack(alignment: .leading, spacing: 0) {");
    expect(composer).not.toContain("VStack(alignment: .leading, spacing: 8) {");

    const palette = mac("Palette.swift");
    expect(palette).toContain("static let ink = ConchColor.accent.dynamic");
    expect(palette).toContain("static let onInk = ConchColor.onAccent.dynamic");
    expect(palette).toContain("static let surface = ConchColor.surface.dynamic");
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
    // Sliced to the function's own end, not a fixed character count — the idiom three lines
    // above. `load` grew a doc comment and a file-URL branch when drop learned to take image
    // BYTES, and `attach([url])` fell outside a 400-character window while still being called
    // twice: the rule held and the guard failed anyway. A count is a guess about how long a
    // function will stay; an end marker is not.
    const chooserAt = composer.indexOf("private func chooseFiles()");
    expect(chooserAt).toBeGreaterThan(-1);
    expect(composer.slice(chooserAt, composer.indexOf("\n    }", chooserAt))).toContain("attach(panel.urls)");
    const loadAt = composer.indexOf("private func load(");
    expect(loadAt).toBeGreaterThan(-1);
    const load = composer.slice(loadAt, composer.indexOf("\n    }", loadAt));
    expect(load).toContain("attach([url])");
    // Both ways in, through the one rule: the file on disk and the bytes that become one.
    expect(load.match(/attach\(\[url\]\)/g) ?? []).toHaveLength(2);
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
    // The one inline parse, in ConchDesign/Markdown.swift: the fog's rows take it whole, the block renderer takes
    // it per block. Either way the link attribute reaches SwiftUI.
    expect(markdown).toContain("interpretedSyntax: .inlineOnlyPreservingWhitespace");
    expect(components).toContain("MarkdownDocument.inline(promoteHeadings(flattenTables(MarkdownDocument.stripFrontmatter(text))))");
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
    //
    // THREE now, not two. The third is `PendingMessage`: a message sent from this Mac that the
    // transcript has not shown yet. It is your turn, drawn as the exact row it is about to
    // become, which is what lets the transcript's own copy replace it without anything on
    // screen moving. A reading row, therefore counted — the number still says "only what is
    // read gets 15/23", it has not been loosened to let chrome in.
    //
    // TWO of the three set the font by name. The agent's reply is a document now — `MarkdownView`
    // at `ConchType.readingBodySize`, the same 15 — because a `Text` cannot lay out a table; it
    // keeps the +4 leading, so all three still read at 15/23.
    const stack = mac("ConversationStackView.swift");
    expect(stack.match(/\.font\(ConchType\.readingBody\)/g)?.length).toBe(2);
    expect(stack).toContain("MarkdownView(text: text(of: item))");
    expect(stack.match(/\.lineSpacing\(ConchType\.readingLineSpacing\)/g)?.length).toBe(3);
  });

  test("the fallback AppKit renderer preserves rich selectable attributed text", () => {
    const dashboard = mac("TranscriptFallback.swift");
    // The shared typesetter: one attributed string, so the spoken half can be dimmed by range.
    expect(dashboard).toContain("return MarkdownTypesetter.attributedString(text, base: base)");
    expect(markdown).toContain("NSAttributedString(MarkdownDocument.inline(text))");
    // Its tables are NSTextTables, which TextKit 2 cannot lay out; both NSTextViews that take the
    // string switch to TextKit 1 before anything else touches them.
    for (const [name, source] of [["the fallback", dashboard], ["the deliverable pane", mac("ReviewView.swift")]] as const) {
      const made = source.slice(source.indexOf("let textView = NSTextView()"));
      expect(made.slice(0, made.indexOf("textView.delegate = context.coordinator")), name).toContain("_ = textView.layoutManager");
    }
    expect(dashboard).toContain("textView.isSelectable = true");
    expect(dashboard).toContain("textView.isRichText = true");
  });
});

describe("§3's anatomy, where the app had drifted from it", () => {
  const dashboard = mac("DashboardView.swift");
  const stack = mac("ConversationStackView.swift");

  test("an answered question collapses to what it decided (§3)", () => {
    expect(stack).toContain("private func answeredQuestionRow(_ decided: String) -> some View {");
    expect(stack).toContain("QuestionOutcome.summary(");
    expect(stack).toContain("QuestionOutcome.chosen(");
    // Only a FINISHED call collapses. A running question is still the thing the session is
    // blocked on, and must keep every option pressable.
    expect(stack).toContain('if item.tool?.status != "running",');
    // The fallback survives: when the answer names no option, the block renders as before.
    expect(stack).toContain('answerable: item.tool?.status == "running"');

    const collapsed = stack.slice(
      stack.indexOf("private func answeredQuestionRow"),
      stack.indexOf("    private func questionRow("),
    );
    expect(collapsed.length).toBeGreaterThan(300);
    // Not a button: there is nothing left to do to it, and leaving it tappable is how an
    // earlier choice gets sent to answer a later prompt.
    expect(collapsed).not.toContain("Button");
  });

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

  test("the workspace moves on §4's springs, not on hand-rolled easings", () => {
    // §4 names exactly what moves and with which spring. ConchMotion already held the right
    // values (morph 0.12/0.46, pop 0.34/0.36) — the workspace just never used them, animating
    // with .easeOut(duration: 0.18) instead. The overlay has used them properly for months
    // (control-bar-source.test.ts), so this is the same convention, finally applied here.
    expect(dashboard).toContain("withAnimation(ConchMotion.morph.animation(reduceMotion: reduceMotion))");
    // The stage's pages are a big view changing shape: morph. They did not move at all before.
    expect(dashboard).toContain(
      ".animation(ConchMotion.morph.animation(reduceMotion: reduceMotion), value: stage(for: focusedRow))",
    );
    // Reduce Motion DROPS THE BOUNCE and keeps the timing (§4). Passing nil killed the
    // animation outright, which is a different promise.
    expect(dashboard).not.toContain("withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18))");

    // Switching sessions: the transcript fades in over 0.12 s, and never slides — moving a
    // reading surface is the thing Tyler called distracting on the feed lab.
    expect(stack).toContain("@State private var switchFade: Double = 1");
    // Declarative, never an imperative animation block: this file forbids those in the
    // transcript, because one that restarts on every streamed token never settles the
    // viewport. The fade rides .animation(_:value:) instead, so it cannot touch the scroll
    // path — and the guard above (no imperative block anywhere here) still stands.
    expect(stack).toContain(".animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: switchFade)");
    expect(stack).toContain("Task { @MainActor in switchFade = 1 }");
    expect(stack).toContain(".opacity(switchFade)");
    expect(stack).not.toContain(".transition(.slide)");
  });

  test("the header's hairline waits for the transcript to scroll (§3)", () => {
    // "A hairline appears under the header only once the transcript scrolls or a pane opens."
    // Nothing pinned it, and it was drawn unconditionally.
    expect(dashboard).toContain("@State private var transcriptScrolled = false");
    expect(dashboard).toContain("onScrolled: { transcriptScrolled = $0 },");
    expect(dashboard).toContain("if transcriptScrolled {");

    // Asked of the TOP, not the bottom: a long transcript resting at its top is not at the
    // bottom and has still scrolled nothing under the header.
    expect(stack).toContain("onScrolled(document.height > visible.height && fromTop > 2)");
    expect(stack).toContain("var onScrolled: (Bool) -> Void = { _ in }");
    // Reusing the measurement already taken for onReachTop, not a second copy of it.
    // Matched by the EXPRESSION, not the variable name: a mutation that duplicated the
    // calculation under a new name walked straight past the name-based version of this.
    expect(
      stack.match(/documentView\.isFlipped\s*\n\s*\? visible\.minY - document\.minY/g) ?? [],
    ).toHaveLength(1);
    // And the bottom question is untouched — it is what keeps a streaming row followed.
    expect(stack).toMatch(/onUserScroll\(document\.height <= visible\.height \|\| distance <= 8\)/);

    // The deliverable pages keep their rule unconditionally: there a pane IS open, which is
    // §3's other reason to draw it.
    // Both markers moved when the work half grew a second content: the arm opens on
    // `hasWorkPane` (a deliverable OR the session's files) and the tab strip counts both. The
    // rule being pinned here is unchanged — this arm draws its hairline unconditionally.
    const deliverableArm = dashboard.slice(
      dashboard.indexOf("if let reviewRow = focusedRow, hasWorkPane, stage(for: reviewRow) != .conversation {"),
      dashboard.indexOf("if hasWorkTabs(for: reviewRow) {"),
    );
    expect(deliverableArm.length).toBeGreaterThan(100);
    expect(deliverableArm).toContain("Rectangle()");
    expect(deliverableArm).not.toContain("if transcriptScrolled {");
  });

  test("the stage is a panel on the window ground, not one flat surface (§3)", () => {
    // The lab's `#stage{top:8;right:8;bottom:8;left:var(--sideW);background:var(--surface);
    // border-radius:12px;box-shadow:var(--shPanel);overflow:hidden}` — §3's prose in values.
    const pane = dashboard.slice(
      dashboard.indexOf("ConversationPane(\n                        state: state,"),
      dashboard.indexOf("if store.isLogDrawerOpen {"),
    );
    expect(pane.length).toBeGreaterThan(200);
    expect(pane).toContain(".background(ConchPalette.surface)");
    expect(pane).toContain("RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous)");
    expect(pane).toContain(".strokeBorder(ConchPalette.divider, lineWidth: 0.5)");
    expect(pane).toContain(".padding(8)");
    // `--shPanel` is a whisper, and now its own level: radius 1.5 / y 1 at 4% in light, and
    // on dark the ring alone. `.floating` (14 / 10) is the COMPOSER's shadow — the composer
    // floats, the stage merely sits.
    expect(pane).toContain(".conchElevation(.panel)");
    expect(pane).not.toContain(".conchElevation(.floating)");

    // The sidebar's 1 pt rule is gone: `#stage` has no left border, and the panel's own edge
    // is the separation now.
    expect(dashboard).not.toContain(
      "Rectangle()\n                        .fill(ConchPalette.divider)\n                        .frame(width: 1)",
    );
    // …while the window GROUND stays, because the panel has to sit on something.
    expect(dashboard).toContain(".background(ConchPalette.bg)");
    expect(mac("Palette.swift")).toContain("static let surface = ConchColor.surface.dynamic");

    // Nothing INSIDE the panel repaints the window ground — that is what made the first
    // attempt have the right shape and the wrong fill: the transcript, the pane body, the
    // 52 pt header and every deliverable surface were painting `bg` over the panel's `surface`.
    // Three ground fills remain, all OUTSIDE it: the window itself, the title strip, the ledger.
    expect((dashboard.match(/\.background\(ConchPalette\.bg\)/g) ?? []).length).toBe(3);
    // Three surfaces, not two: the panel's own fill, the pane body, and the 52 pt header.
    expect((dashboard.match(/\.background\(ConchPalette\.surface\)/g) ?? []).length).toBe(3);
    // The invariant behind those counts, stated structurally so it survives a refactor that
    // moves a fill around: nothing inside the pane paints the window ground.
    const insidePane = dashboard.slice(dashboard.indexOf("private struct ConversationPane: View {"));
    expect(insidePane.length).toBeGreaterThan(1_000);
    expect(insidePane).not.toContain(".background(ConchPalette.bg)");
    expect(stack).toContain(".background(ConchPalette.surface)");
    // ReviewView renders only inside the stage (#284 deleted the full-window overlay), so it
    // carries no ground at all — including the cover that hides WKWebView's white flash, which
    // would otherwise be a visible rectangle against the panel.
    expect(mac("ReviewView.swift")).not.toContain("ConchPalette.bg");
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

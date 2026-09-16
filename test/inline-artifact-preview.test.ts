import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stack = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ConversationStackView.swift"),
  "utf8",
);
const card = stack.slice(stack.indexOf("private struct ArtifactPreview"));

/**
 * A deliverable is previewed where it happened, not summarised.
 *
 * An icon and a filename told you a deliverable EXISTED. Tyler, side by side
 * with Codex: "preview the actual artifact in conch instead of this random
 * card UI". The card renders the head of a text deliverable through the same
 * markdown path the replies use, and a local image at conversation width.
 */
test("the card renders the artifact, through the conversation's own markdown path", () => {
  expect(card).toContain("Text(AttributedString.conchMarkdown(head))");
  expect(card).toContain("case .image:");
  expect(card).toContain("case .document:");
  // The Deliverable pane's renderers are NSScrollViews; nesting one inside the
  // conversation's scroller captures the wheel. They must not be reused here.
  expect(card).not.toContain("DeliverableDocumentView");
  expect(card).not.toContain("DeliverableImageView");
});

/**
 * The picture IS the card. Tyler: "just like an image or preview of the work
 * with little or no text … aspect ratio can change to fit deliverable better",
 * and remove "the weird star thing … and other unnecessary details that
 * diverge from your mockups".
 *
 * The lab's `.dc` is a hairline row holding a thumbnail and one line of words:
 * `box-shadow:inset 0 0 0 1px var(--hair2)`, no fill, no tint. The app had
 * grown an uppercase coloured eyebrow, a path, an expand arrow and a review-
 * coloured ring around all of it.
 */
test("the card is a picture and one line, on a plain hairline", () => {
  // The deliverable's own proportions, not a letterboxed slot.
  expect(card).toContain("image.size.width / max(image.size.height, 1)");
  expect(card).not.toContain("maxHeight: 260");
  // A hairline, not a ring in the review colour.
  expect(card).toContain(".strokeBorder(ConchPalette.hairlineStrong, lineWidth: 1)");
  expect(card).not.toContain("ConchPalette.statusReview.opacity(0.35)");
  // The chrome that went.
  expect(card).not.toContain('Text("Deliverable")');
  expect(card).not.toContain("textCase(.uppercase)");
  expect(card).not.toContain("shortLink(link)");
  expect(card).not.toContain("arrow.up.left.and.arrow.down.right");
  // The summary is the one line that stays.
  expect(card).toContain("Text(artifact.summary)");
});

/**
 * The lab draws the review mark as `ic('check')` on `--ready` (line 895), and
 * §5's state language says "`ready` green circle with ✓". `star` appears in the
 * lab exactly once, as the icon for the `none` type — "No link".
 */
test("a deliverable is marked with a check in both apps, never a star", () => {
  const stackAll = readFileSync(
    join(import.meta.dir, "..", "mac-app", "conch-mac", "ConversationStackView.swift"),
    "utf8",
  );
  for (const [name, source] of [
    ["the conversation", stackAll],
    ["the ledger", readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "DashboardView.swift"), "utf8")],
    ["the deliverable pane", readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "ReviewView.swift"), "utf8")],
    // The legend explains the ledger's glyphs; if it keeps a star it describes
    // a mark the app no longer draws.
    ["the legend", readFileSync(join(import.meta.dir, "..", "mac-app", "conch-mac", "ContentView.swift"), "utf8")],
    // The phone shows the same fleet. Two apps naming one state with two
    // different glyphs is how the state language comes apart.
    ["the phone's ledger", readFileSync(join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", "Models.swift"), "utf8")],
    ["the phone's review card", readFileSync(join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", "SessionView.swift"), "utf8")],
  ] as const) {
    expect(source, name).not.toContain('"star.fill"');
    expect(source, name).not.toContain('systemImage: "star.fill"');
  }
  expect(stackAll).toContain('Label(item.text, systemImage: "checkmark.circle.fill")');
  expect(
    readFileSync(join(import.meta.dir, "..", "mobile", "conch-ios", "conch-ios", "Models.swift"), "utf8"),
  ).toContain('case .review: "checkmark.circle.fill"');
});

test("a text deliverable is read bounded, never whole", () => {
  // Fourteen lines of a 5MB log must not cost 5MB.
  const head = card.slice(card.indexOf("private var documentHead"));
  const body = head.slice(0, head.indexOf("\n    }"));
  expect(body).toContain("readData(ofLength: 6 * 1024)");
  expect(body).not.toContain("String(contentsOfFile");
  expect(body).not.toContain("contentsOf: URL");
});

test("only an absolute local path is previewed inline", () => {
  // A relative link resolves against the app's cwd, not the session's — the
  // daemon publishes absolute now, and the card must not guess at the rest.
  const kind = card.slice(card.indexOf("private var inlinePreviewKind"));
  const body = kind.slice(0, kind.indexOf("\n    }"));
  expect(body).toContain('link.hasPrefix("/")');
});

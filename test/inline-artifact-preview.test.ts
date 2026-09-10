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

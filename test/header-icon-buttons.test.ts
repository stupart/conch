import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dashboard = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "DashboardView.swift"),
  "utf8",
);

const headerButton = (() => {
  const from = dashboard.indexOf("private struct HeaderButton: View {");
  expect(from).toBeGreaterThan(-1);
  return dashboard.slice(from, dashboard.indexOf("\n}\n", from));
})();

/**
 * One icon button, drawn the way the lab draws all 25 of them:
 *
 *   `.ib{width:28px;height:28px;border-radius:7px;color:var(--text2)}`
 *   `.ib:hover{background:var(--hover);color:var(--text)}`
 *   `.ib.on{background:var(--sel);color:var(--text)}`
 *
 * The app drew 26 square at radius 6.
 */
test("a header icon button is 28 square at radius 7", () => {
  expect(headerButton).toContain(".frame(width: 28, height: 28)");
  expect(headerButton).toContain("RoundedRectangle(cornerRadius: 7, style: .continuous)");
  expect(headerButton).not.toContain(".frame(width: 26, height: 26)");
  expect(headerButton).not.toContain("RoundedRectangle(cornerRadius: 6)");
});

/**
 * Hover and selected are different states and the lab gives them different fills: `--hover`
 * for the pointer, `--sel` for a control that is ON. They were painted with the SAME fill, so
 * "logs are open" looked exactly like "your pointer is here".
 */
test("hover and selected are told apart", () => {
  expect(headerButton).toContain(
    ".fill(isSelected ? ConchPalette.selection : (isHovered ? ConchPalette.hover : .clear))",
  );
  // `.ib:hover` brightens the glyph too, not just the ground.
  expect(headerButton).toContain(
    ".foregroundStyle(isSelected || isHovered ? ConchPalette.textPrimary : ConchPalette.textDim)",
  );
  expect(headerButton).not.toContain("isSelected || isHovered ? ConchPalette.hover : .clear");
});

/**
 * The session-actions menu is an `.ib` too. It was 28x26 — two points shorter than every
 * sibling — and the only icon button in the header that never answered the pointer.
 *
 * A `Menu` label gets no hover for free, hence the explicit state.
 */
test("the session actions menu is the same button as the rest", () => {
  const menu = dashboard.slice(dashboard.indexOf('Image(systemName: "ellipsis")'));
  const body = menu.slice(0, menu.indexOf('.help("Session actions")'));
  expect(body).toContain(".frame(width: 28, height: 28)");
  expect(body).toContain("RoundedRectangle(cornerRadius: 7, style: .continuous)");
  expect(body).toContain("isHoveringActions ? ConchPalette.hover : .clear");
  expect(body).toContain(
    ".foregroundStyle(isHoveringActions ? ConchPalette.textPrimary : ConchPalette.textDim)",
  );
  expect(dashboard).toContain("@State private var isHoveringActions = false");
  expect(dashboard).toContain(".onHover { isHoveringActions = $0 }");
  expect(dashboard).not.toContain(".frame(width: 28, height: 26)");
});

/**
 * Recorded so the next reader does not "tidy" it: the radius is a literal 7, not
 * `ConchRadius.small`. That token is 6, and redefining a shared token to satisfy one button
 * would move every other surface that leans on it.
 */
test("the radius is the lab's 7, not the shared 6", () => {
  const tokens = readFileSync(
    join(import.meta.dir, "..", "design", "ConchDesign", "Sources", "ConchDesign", "Tokens.swift"),
    "utf8",
  );
  expect(tokens).toContain("public static let small: CGFloat = 6");
  // The CODE form: the comment above the button says `ConchRadius.small` in order to explain
  // why it is not used, and a bare sweep matches that prose rather than any behaviour.
  expect(headerButton).not.toContain("cornerRadius: ConchRadius.small");
});

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const stack = readFileSync(
  join(import.meta.dir, "..", "mac-app", "conch-mac", "ConversationStackView.swift"),
  "utf8",
);

/**
 * A nested agent's prose renders as prose; a log stays a log.
 *
 * The decision is the daemon's classification (`toolKind`), never a guess at
 * whether the text looks like markdown — that guess is how a log file with a
 * stray asterisk gets mangled. The app only asks "is this a subagent?".
 */
test("subagent output takes the markdown path, other tool output stays raw", () => {
  const site = stack.slice(stack.indexOf("if expanded, !result.isEmpty {"));
  const body = site.slice(0, site.indexOf("\n        }"));
  expect(body).toContain("if item.tool?.kind == .subagent {");
  expect(body).toContain("Text(AttributedString.conchMarkdown(result))");
  // The raw path must survive for everything else.
  expect(body).toContain("Text(result)");
  expect(body).toContain('design: .monospaced');
  // No content sniffing.
  expect(body).not.toMatch(/result\.contains\("\*\*"\)|looksLikeMarkdown/);
});

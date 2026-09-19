import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A file change has to be LOCATABLE, not just named.
 *
 * `fileChange` published only the basename — `file: path.split("/").pop()` — with a comment
 * saying the full path was already the row's title. It is not: the title is the tool's own
 * prose and neither app parses it. So a row reading `shot.mjs` named one of every `shot.mjs`
 * in the checkout, and nothing downstream could open the file, reveal it, or mark it in a
 * tree. Matching by basename would point confidently at the wrong file, which is worse than
 * saying nothing.
 *
 * The path now rides alongside the basename. Three sides have to agree or the field is
 * useless, and only one of them is executed by the daemon's own tests — hence this file:
 * the wire carries it, and BOTH apps decode it. Neither app has a test target, so these read
 * the Swift the way the other source tests do.
 */
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
// Line comments stripped, so prose describing the field can never satisfy a guard.
const swift = (path: string) => source(path).replace(/^\s*\/\/.*$/gm, "");
const daemon = source("src/conversation.ts");
const mac = swift("mac-app/conch-mac/Models.swift");
const ios = swift("mobile/conch-ios/conch-ios/Models.swift");
const stack = swift("mac-app/conch-mac/ConversationStackView.swift");

describe("a file change says where the file is", () => {
  test("the wire carries the path beside the basename", () => {
    expect(daemon).toContain("  path: string;");
    // Both, not one instead of the other: a scanning reader wants the name, and anything
    // that acts on the file wants the path.
    expect(daemon).toContain('    file: path.split("/").pop() || path,\n    path,');
  });

  /**
   * One wire shape, decoded the same way twice. The two apps drifting here is how the phone
   * and the Mac end up disagreeing about what the daemon said.
   */
  test("both apps decode it, leniently, from one key list", () => {
    const keys = "case file, path, removed, added, truncated";
    expect(mac).toContain(keys);
    expect(ios).toContain(keys);

    // Absent from an older daemon, which must keep working rather than failing to decode the
    // whole conversation over one missing field.
    const lenient = 'path = (try? c.decodeIfPresent(String.self, forKey: .path)) ?? ""';
    expect(mac).toContain(lenient);
    expect(ios).toContain(lenient);
  });

  /**
   * The transcript still shows the NAME. Tyler on the bar above the deliverables: "i don't get
   * what its for an it adds clutter / jank" — an absolute path on every change row is exactly
   * that clutter. The path is a hover away instead, so the row stays scannable and the
   * information is still there.
   */
  test("the row shows the name and keeps the path a hover away", () => {
    expect(stack).toContain("Text(change.file)");
    expect(stack).toContain(".help(change.path.isEmpty ? change.file : change.path)");
  });
});

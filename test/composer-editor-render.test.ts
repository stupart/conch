import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The composer's editor, typed into in a real window: mac-app/conch-mac/ComposerEditor.swift and Palette.swift compiled
 * against ConchDesign (built here as its own module) with a small harness (test/fixtures/composer-editor-main.swift)
 * that hosts the editor in SwiftUI the way ComposerView does, in Dark mode, and types into it with key events.
 *
 * Tyler, 2026-10-04: "something is weird about the input bar in the conch app and the spellcheck like deletes / changes
 * what im typing sometimes and all the text goes invisible". The field was SwiftUI's TextEditor, configured from behind
 * by an introspector; measured offscreen that day, SwiftUI turned autocorrect on in every update (whatever System
 * Settings said), wiped any open composition (an accent, a dead key, Japanese input) on any update at all, and the
 * introspector sometimes never reached the editor. ComposerEditor.swift has the numbers. These are the replacement's
 * promises, kept by the real thing rather than by reading its source.
 *
 * Needs a login session with a window server (`launchctl managername` says Aqua). Nothing is shown and nothing comes to
 * the front: the window is borderless, transparent and parked off every screen, and the harness can never be active.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
const drawable = Bun.which("swiftc") !== null
  && Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === "Aqua";

type Json = Record<string, any>;
const lines = new Map<string, Json>();
let root = "";
let harnessError = "";

async function swiftc(args: string[]): Promise<void> {
  const compile = Bun.spawn(["swiftc", "-swift-version", "5", ...args], { stdout: "pipe", stderr: "pipe", cwd: root });
  const [code, stderr] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
  if (code !== 0) throw new Error(`swiftc failed:\n${stderr}`);
}

beforeAll(async () => {
  if (!drawable) return;
  root = mkdtempSync(join(tmpdir(), "conch-composer-editor-"));
  const design = repo("design/ConchDesign/Sources/ConchDesign");
  const sources = [...new Bun.Glob("*.swift").scanSync(design)].map((name) => join(design, name));
  // ConchDesign as the module the app imports, so the app's files compile exactly as they are.
  await swiftc(["-parse-as-library", "-emit-library", "-static", "-emit-module", "-module-name", "ConchDesign",
    "-emit-module-path", join(root, "ConchDesign.swiftmodule"), "-o", join(root, "libConchDesign.a"), ...sources]);
  copyFileSync(repo("test/fixtures/composer-editor-main.swift"), join(root, "main.swift"));
  const binary = join(root, "harness");
  await swiftc(["-I", root, "-L", root, "-lConchDesign", repo("mac-app/conch-mac/Palette.swift"),
    repo("mac-app/conch-mac/ComposerEditor.swift"), join(root, "main.swift"), "-o", binary]);
  const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: `${root}/` } });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (code !== 0) harnessError = `the harness exited ${code}:\n${err}`;
  if (process.env.CONCH_EDITOR_DEBUG) console.log(out, err);
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as Json;
    lines.set(parsed.name, parsed);
  }
}, 300_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const line = (name: string): Json => {
  const found = lines.get(name);
  expect(found, `no "${name}" line; ${harnessError}`).toBeDefined();
  return found!;
};

describe.skipIf(!drawable)("the composer's editor, typed into in a real window", () => {
  test("the harness ran every case", () => {
    expect(harnessError).toBe("");
    expect([...lines.keys()]).toEqual([
      "built", "spelling", "typed", "baseline", "marked", "return", "grow", "width", "outside", "session", "focus", "drag",
      "appearance", "done",
    ]);
  });

  /**
   * TextKit 1 from creation, never switched. The SwiftUI editor was laid out on TextKit 2 and 92 ms later switched to
   * TextKit 1 by the introspector, under SwiftUI's own adaptor.
   */
  test("it is TextKit 1 from creation and never switches", () => {
    const built = line("built");
    expect(built.class).toBe("ComposerTextView");
    expect(built.textKit2).toBe(false);
    expect(built.switches).toBe(0);
    const done = line("done");
    expect(done.textKit2).toBe(false);
    expect(done.switches).toBe(0);
  });

  /**
   * Nothing is corrected as you type, with System Settings' correction on (macOS's default, and Tyler's), through focus,
   * typing, republishing and an outside change; continuous checking stays on for the underlines; quotes and dashes stay
   * straight. And nothing writes the flags after the editor is made: SwiftUI wrote correction ON at every update.
   */
  test("spelling is underlined, never corrected, and set once", () => {
    for (const name of ["built", "spelling", "done"]) {
      const { spelling } = line(name);
      expect(spelling.continuous, name).toBe(true);
      expect(spelling.correction, name).toBe(false);
      expect(spelling.quotes, name).toBe(false);
      expect(spelling.dashes, name).toBe(false);
      // Text replacements are the person's own shortcuts: they follow System Settings.
      expect(spelling.replacement, name).toBe(spelling.systemReplacement);
    }
    const spelling = line("spelling");
    expect(spelling.firstResponder).toBe(true);
    expect(spelling.writes).toEqual([]);
    expect(line("done").writes).toEqual([]);
    // Typed with key events, the misspelling and the straight quotes and dashes stand. (AppKit only corrects in the key
    // window of the active app, which a harness must never be, so the flag above is the real proof.)
    expect(spelling.text).toBe('teh and "quoted" -- text');
    expect(spelling.draft).toBe(spelling.text);
  });

  test("typed words are laid out and drawn, light on the dark card", () => {
    const typed = line("typed");
    expect(typed.text).toBe("hello world");
    expect(typed.draft).toBe("hello world");
    expect(typed.ink.ground).toBeLessThan(60);
    expect(typed.ink.brightest).toBeGreaterThan(200);
    expect(typed.ink.inked).toBeGreaterThan(200);
    expect(typed.geometry.field).toBe(22);
    // A draft already there when the field is built is drawn too, on the same rows as words typed later: the caret's
    // baseline shift applies to it from the start (the introspector's late install left such a draft 2 pt low).
    const built = line("built");
    expect(built.text).toBe("a draft restored at launch");
    expect(built.ink.brightest).toBeGreaterThan(200);
    expect(built.ink.top).toBe(typed.ink.top);
    expect(built.ink.bottom).toBe(typed.ink.bottom);
  });

  /**
   * The words land exactly where the placeholder draws them (`ComposerCaretBaseline` and `ComposerView.caretRaise`), and
   * the caret spans them instead of riding above.
   */
  test("typed words sit on the placeholder's line and the caret spans them", () => {
    const { placeholder, typed, caretTop, caretBottom } = line("baseline");
    expect(placeholder.inked).toBeGreaterThan(200);
    expect(typed.top).toBe(placeholder.top);
    expect(typed.bottom).toBe(placeholder.bottom);
    const scale = typed.scale;
    // The caret, in the same pixels: over the whole of the ink, and by no more than a few pixels either side.
    expect(caretTop * scale).toBeLessThanOrEqual(typed.top);
    expect(caretBottom * scale).toBeGreaterThanOrEqual(typed.bottom);
    expect(typed.top - caretTop * scale).toBeLessThanOrEqual(4);
    expect(caretBottom * scale - typed.bottom).toBeLessThanOrEqual(6);
  });

  /**
   * The SwiftUI editor put the binding's text back over an open composition on any update at all: "afterか" became
   * "after". Here the composition is the draft's too (the placeholder goes), five republishes leave it be, a dictation
   * landing meanwhile waits in the draft, and when the composition is committed both are there.
   */
  test("a composition survives updates, and an outside change waits for it", () => {
    const marked = line("marked");
    expect(marked.draftWhileMarked).toBe("abcか");
    expect(marked.afterUpdates.updates).toBeGreaterThanOrEqual(5);
    expect(marked.afterUpdates).toMatchObject({ text: "abcか", marked: true });
    expect(marked.afterOutside).toEqual({ text: "abcか", marked: true, draft: "abcか dictated" });
    expect(marked.committed).toBe("abc漢 dictated");
    expect(marked.draft).toBe("abc漢 dictated");
    expect(marked.marked).toBe(false);
  });

  test("Return sends; Shift- and Option-Return break the line; Return in a composition only commits it", () => {
    const keys = line("return");
    // Sent, and the words stay for the send to take back once it is delivered.
    expect(keys.afterReturn).toEqual({ text: "one", sends: 1 });
    expect(keys.afterNewlines).toEqual({ text: "one\ntwo\nthree", draft: "one\ntwo\nthree", sends: 1 });
    expect(keys.afterComposingReturn).toEqual({ text: "one\ntwo\nthreeé", draft: "one\ntwo\nthreeé", marked: false, sends: 1 });
  });

  /**
   * One line to eight, a line at a time, and never scrolled while the words fit; past eight it scrolls inside itself and
   * the end of the draft is there to read; emptied, it is one line again, from the top.
   */
  test("a long draft grows the field to eight lines, and its end is in view", () => {
    const grow = line("grow");
    expect(grow.heights).toEqual([22, 44, 66, 88, 110, 132, 154, 176, 176, 176, 176, 176]);
    expect(grow.clips.slice(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Math.min(...grow.clips.slice(8))).toBeGreaterThan(0);
    const end = grow.atEnd;
    expect(end.field).toBe(176);
    expect(end.clipY + end.clipHeight).toBeCloseTo(end.used, 0);
    expect(end.caretLineTop).toBeGreaterThanOrEqual(end.clipY);
    expect(end.caretLineBottom).toBeLessThanOrEqual(end.clipY + end.clipHeight);
    // What is in view at the end has words in it.
    expect(grow.visibleInk.brightest).toBeGreaterThan(200);
    expect(grow.visibleInk.inked).toBeGreaterThan(1000);
    expect(grow.emptied).toMatchObject({ field: 22, clipY: 0 });
    expect(grow.again).toMatchObject({ field: 22, clipY: 0 });
    expect(grow.againInk.brightest).toBeGreaterThan(200);
  });

  /**
   * Measured from the editor's own layout at the width it is laid out at. The SwiftUI composer measured beside the editor
   * and the two disagreed: six wrapped lines measured 128 pt held text 108 tall.
   */
  test("the field is as tall as its text lays out, at every width", () => {
    const { wide, narrow, back } = line("width");
    for (const g of [wide, narrow, back]) {
      // n lines are n line boxes: TextKit's used height plus the last line's leading.
      expect(g.field).toBe(Math.min(176, Math.max(22, Math.ceil(g.used + 4))));
      expect(g.used).toBeLessThanOrEqual(g.field);
      expect(g.clipY).toBe(0);
    }
    expect(narrow.width).toBe(280);
    expect(narrow.field).toBeGreaterThan(wide.field);
    expect(back).toEqual(wide);
  });

  test("outside changes land where they belong, in the field's own ink", () => {
    const outside = line("outside");
    // A dictation lands at the end: the caret that was at the end goes after it.
    expect(outside.dictated).toEqual({ text: "hello world", caret: 11 });
    // A change elsewhere leaves the caret on the word it was on.
    expect(outside.middle).toEqual({ text: "hello world, more", caret: 2 });
    // A delivered send takes back exactly what it sent; the caret stays with the words typed since.
    expect(outside.sent).toEqual({ text: ", more", caret: 6 });
    // Emptied from outside, the next word is still the reading face in the palette's ink, not 12 pt black.
    expect(outside.typingInk).toBeGreaterThan(200);
    expect(outside.afterEmptyInk.brightest).toBeGreaterThan(200);
  });

  test("another session's draft replaces the field outright", () => {
    const session = line("session");
    expect(session.text).toBe("beta's own draft");
    expect(session.marked).toBe(false);
    expect(session.canUndo).toBe(false);
    expect(session.caret).toBe(16);
    // Nothing of beta's field went into alpha's draft, and alpha's composition stayed alpha's.
    expect(session.beta).toBe("beta's own draft");
    expect(session.alpha).toBe("alpha wordsか");
  });

  test("focus is a binding both ways", () => {
    expect(line("focus")).toEqual({ name: "focus", reportedLost: true, regained: true, focused: true });
  });

  /**
   * A dropped file or image must reach the composer's `.onDrop`, not the editor: NSTextView inserts a dropped file's
   * PATH as text. Text drops still land in the editor.
   */
  test("files and images are refused by the editor; text is not", () => {
    const { registered, acceptable } = line("drag");
    for (const refused of ["public.file-url", "NSFilenamesPboardType", "public.png", "public.tiff", "Apple PNG pasteboard type",
      "NeXT TIFF v4.0 pasteboard type", "com.apple.NSFilePromiseItemMetaData", "com.apple.pasteboard.promised-file-content-type"]) {
      expect(registered, refused).not.toContain(refused);
      expect(acceptable, refused).not.toContain(refused);
    }
    expect(registered).toContain("NSStringPboardType");
  });

  /** Auto appearance switches at sunset: the words follow, dark on the light card, light on the dark one. */
  test("the words follow the appearance both ways", () => {
    const { dark, light, darkAgain } = line("appearance");
    expect(dark.ground).toBeLessThan(60);
    expect(dark.brightest).toBeGreaterThan(200);
    expect(light.ground).toBeGreaterThan(200);
    expect(light.darkest).toBeLessThan(80);
    expect(light.inked).toBeGreaterThan(200);
    expect(darkAgain).toEqual(dark);
  });
});

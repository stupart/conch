import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReviewScene, markImagesRefusal, REVIEW_MARKS_MAX_BYTES, type ReviewScene } from "../src/snippet.ts";

/**
 * Agent ink: an agent attaches marks to what it publishes (`scene.marks`), and conch carries them
 * to the apps. These are the rules every boundary applies through `checkReviewScene`; the MCP,
 * socket and daemon tests prove each boundary runs them.
 */
const root = join(import.meta.dir, "..");
const scene = (marks: unknown): unknown => ({ v: 1, target: { kind: "auto" }, marks });
const check = (marks: unknown, hasLink = true) => checkReviewScene(scene(marks), hasLink);

describe("scene.marks", () => {
  test("each kind with the geometry it takes, on each frame, is published as sent", () => {
    const marks = [
      { id: "cta", kind: "box", frame: { selector: ".hero .cta" }, label: "Moved up from the footer" },
      { id: "copy", kind: "highlight", frame: { quote: "Start free trial" } },
      { id: "why", kind: "text", frame: { selector: "h1" }, label: "One clause now" },
      { id: "a-1", kind: "arrow", frame: { canvas: "canvas-7" }, at: [0.8, 0.9], to: [0.5, 0.4] },
      { id: "b_2", kind: "ellipse", frame: { image: "/tmp/still.png" }, rect: [0, 0, 1, 1] },
      { id: "pin", kind: "pin", frame: { canvas: "canvas-7" }, at: [0, 1] },
      { id: "note", kind: "text", frame: { canvas: "canvas-7" }, at: [0.5, 0.5], label: "here" },
      { id: "s", kind: "stroke", frame: { canvas: "canvas-7" }, pts: [[0.1, 0.1], [0.2, 0.25], [0.3, 0.2]] },
    ];
    expect(check(marks)).toEqual({ ok: true, scene: { v: 1, target: { kind: "auto" }, marks } as ReviewScene });
  });

  test("a scene without marks is unchanged", () => {
    expect(checkReviewScene({ v: 1, target: { kind: "auto" }, inspect: "x" }, false))
      .toEqual({ ok: true, scene: { v: 1, target: { kind: "auto" }, inspect: "x" } });
  });

  test("each malformed mark is refused, naming the mark and what to fix", () => {
    const box = { id: "m", kind: "box", frame: { canvas: "c" }, rect: [0.1, 0.1, 0.2, 0.2] };
    const cases: Array<[unknown, string, boolean?]> = [
      [[], "scene marks must be a list of 1 to 12 marks"],
      [box, "scene marks must be a list of 1 to 12 marks"],
      [Array.from({ length: 13 }, (_, i) => ({ ...box, id: `m${i}` })), "scene marks must be a list of 1 to 12 marks"],
      [["box"], "scene marks[0] must be an object"],
      [[{ ...box, color: "#f00" }], 'scene marks[0] has unknown field "color"'],
      [[{ ...box, id: "" }], "scene marks[0] id must be 1 to 32 letters, digits, - or _"],
      [[{ ...box, id: "has space" }], "scene marks[0] id must be"],
      [[{ ...box, id: "x".repeat(33) }], "scene marks[0] id must be"],
      [[box, { ...box }], 'scene marks[1] id "m" is taken'],
      [[{ ...box, kind: "lasso" }], "scene marks[0] kind must be one of arrow, box, ellipse, highlight, text, pin, stroke"],
      [[{ ...box, frame: {} }], "scene marks[0] frame must be exactly one of {canvas}, {image}, {selector} or {quote}"],
      [[{ ...box, frame: { canvas: "c", image: "/tmp/a.png" } }], "scene marks[0] frame must be exactly one of"],
      [[{ ...box, frame: { window: "w" } }], "scene marks[0] frame must be exactly one of"],
      [[{ ...box, frame: "c" }], "scene marks[0] frame must be exactly one of"],
      [[{ ...box, frame: { canvas: "" } }], "scene marks[0] frame.canvas must be one line of 1 to 200 characters"],
      [[{ ...box, frame: { canvas: "a\nb" } }], "scene marks[0] frame.canvas must be one line"],
      [[{ id: "m", kind: "box", frame: { selector: "x".repeat(121) } }], "scene marks[0] frame.selector must be one line of 1 to 120 characters"],
      [[{ id: "m", kind: "box", frame: { quote: "x".repeat(121) } }], "scene marks[0] frame.quote must be one line of 1 to 120 characters"],
      [[{ ...box, frame: { image: "still.png" } }], "scene marks[0] frame.image must be the absolute path of an image file"],
      [[{ ...box, frame: { image: "/tmp/notes.md" } }], "scene marks[0] frame.image must be the absolute path of an image file"],
      [[{ id: "m", kind: "box", frame: { selector: ".cta" } }], "scene marks[0] frame.selector names something in the linked page; pass link", false],
      [[{ id: "m", kind: "box", frame: { quote: "Save" } }], "scene marks[0] frame.quote names something in the linked page", false],
      [[{ id: "m", kind: "stroke", frame: { selector: ".cta" } }], "scene marks[0] a stroke is its pts, so it is drawn on a canvas or an image, not a selector"],
      [[{ id: "m", kind: "box", frame: { selector: ".cta" }, rect: [0, 0, 1, 1] }], "scene marks[0] takes no rect: conch places it on what the selector names"],
      [[{ id: "m", kind: "pin", frame: { quote: "Save" }, at: [0, 0] }], "scene marks[0] takes no at"],
      [[{ ...box, at: [0, 0] }], "scene marks[0] (box) takes rect, not at"],
      [[{ id: "m", kind: "box", frame: { canvas: "c" } }], "scene marks[0] (box) needs rect"],
      [[{ id: "m", kind: "arrow", frame: { canvas: "c" }, at: [0, 0] }], "scene marks[0] (arrow) needs at and to"],
      [[{ id: "m", kind: "pin", frame: { canvas: "c" } }], "scene marks[0] (pin) needs at"],
      [[{ id: "m", kind: "stroke", frame: { canvas: "c" } }], "scene marks[0] (stroke) needs pts"],
      [[{ id: "m", kind: "arrow", frame: { canvas: "c" }, at: [0, 1.01], to: [0, 0] }], "scene marks[0] at must be [x, y], each from 0 to 1 of the canvas"],
      [[{ id: "m", kind: "arrow", frame: { canvas: "c" }, at: [0, 0], to: [-0.1, 0] }], "scene marks[0] to must be [x, y]"],
      [[{ id: "m", kind: "pin", frame: { canvas: "c" }, at: [0, Number.NaN] }], "scene marks[0] at must be [x, y]"],
      [[{ id: "m", kind: "pin", frame: { canvas: "c" }, at: [0, Infinity] }], "scene marks[0] at must be [x, y]"],
      [[{ id: "m", kind: "pin", frame: { canvas: "c" }, at: ["0", 0] }], "scene marks[0] at must be [x, y]"],
      [[{ id: "m", kind: "pin", frame: { canvas: "c" }, at: [0, 0, 0] }], "scene marks[0] at must be [x, y]"],
      [[{ ...box, rect: [0, 0, 0, 0.5] }], "scene marks[0] rect must be [x, y, width, height], each from 0 to 1 of the canvas, with a width and height above 0"],
      [[{ ...box, rect: [0, 0, 1] }], "scene marks[0] rect must be"],
      [[{ ...box, rect: [0, 0, 1, 2] }], "scene marks[0] rect must be"],
      [[{ id: "m", kind: "stroke", frame: { canvas: "c" }, pts: [[0, 0]] }], "scene marks[0] pts must be 2 to 64 points [x, y], each from 0 to 1 of the canvas"],
      [[{ id: "m", kind: "stroke", frame: { canvas: "c" }, pts: Array.from({ length: 65 }, () => [0, 0]) }], "scene marks[0] pts must be 2 to 64"],
      [[{ id: "m", kind: "stroke", frame: { canvas: "c" }, pts: [[0, 0], [2, 0]] }], "scene marks[0] pts must be 2 to 64"],
      [[{ ...box, label: "" }], "scene marks[0] label must be one line of 1 to 80 characters"],
      [[{ ...box, label: "x".repeat(81) }], "scene marks[0] label must be one line of 1 to 80 characters"],
      [[{ ...box, label: "two\nlines" }], "scene marks[0] label must be one line"],
      [[{ id: "m", kind: "text", frame: { canvas: "c" }, at: [0, 0] }], "scene marks[0] (text) needs a label: it is the text"],
      [[{ id: "m", kind: "text", frame: { selector: "h1" } }], "scene marks[0] (text) needs a label"],
    ];
    for (const [marks, reason, hasLink] of cases) {
      const checked = check(marks, hasLink ?? true);
      expect(checked.ok, reason).toBeFalse();
      if (!checked.ok) expect(checked.reason, JSON.stringify(marks).slice(0, 120)).toStartWith(reason);
    }
  });

  test("the maxima are accepted: 12 marks, 64 points, 80-character labels, 120-character selectors", () => {
    expect(check([{ id: "s", kind: "stroke", frame: { canvas: "c" }, pts: Array.from({ length: 64 }, () => [0.5, 0.5]) }]).ok).toBeTrue();
    expect(check(Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, kind: "pin", frame: { canvas: "c" }, at: [0, 0] }))).ok).toBeTrue();
    expect(check([{ id: "x".repeat(32), kind: "box", frame: { selector: "s".repeat(120) }, label: "l".repeat(80) }]).ok).toBeTrue();
  });

  test("the marks as a whole are bounded, not only field by field", () => {
    const stroke = (id: string) => ({
      id, kind: "stroke", frame: { canvas: "c" },
      pts: Array.from({ length: 64 }, (_, i) => [0.123456789 + i / 1000, 0.987654321 - i / 1000]),
    });
    const checked = check([stroke("a"), stroke("b")]);
    expect(checked.ok).toBeFalse();
    if (!checked.ok) expect(checked.reason).toMatch(new RegExp(`^scene marks are \\d+ bytes; at most ${REVIEW_MARKS_MAX_BYTES}`));
    expect(check([stroke("a")]).ok).toBeTrue();
  });
});

describe("a mark's image passes the rule a linked file does", () => {
  const withFolder = async (run: (folder: string) => Promise<void>) => {
    const folder = mkdtempSync(join(tmpdir(), "conch-mark-image-"));
    try { await run(folder); } finally { rmSync(folder, { recursive: true, force: true }); }
  };
  const on = (image: string) => ({ v: 1, target: { kind: "auto" }, marks: [{ id: "m", kind: "pin", frame: { image }, at: [0, 0] }] }) as ReviewScene;

  test("an image under the folder or the temp folder passes; missing, elsewhere or hidden does not", async () => {
    await withFolder(async (folder) => {
      writeFileSync(join(folder, "still.png"), "png");
      expect(await markImagesRefusal(on(join(folder, "still.png")), folder)).toBeNull();
      expect(await markImagesRefusal(undefined, folder)).toBeNull();
      expect(await markImagesRefusal(on(join(folder, "gone.png")), folder))
        .toBe("scene marks[0] frame.image must be an existing, non-executable file");
      // The temp folder is always allowed, so "elsewhere" is a real image in the repo.
      expect(await markImagesRefusal(on(join(root, "assets/conch-icon-1024.png")), folder))
        .toContain("is outside this session's folder");
    });
    const hidden = mkdtempSync(join(tmpdir(), ".conch-hidden-"));
    try {
      writeFileSync(join(hidden, "a.png"), "png");
      expect(await markImagesRefusal(on(join(hidden, "a.png")), hidden)).toContain("is a hidden file, in a hidden folder");
    } finally { rmSync(hidden, { recursive: true, force: true }); }
  });
});

/**
 * The apps decode marks with the same type, and a mark a build can't read (a kind or frame from a
 * newer daemon) is skipped, never the review. Compiled and run for real: the type is sliced out of
 * each app's Models.swift, which must hold the same one.
 */
describe("the apps decode marks", () => {
  const models = {
    mac: readFileSync(join(root, "mac-app/conch-mac/Models.swift"), "utf8"),
    ios: readFileSync(join(root, "mobile/conch-ios/conch-ios/Models.swift"), "utf8"),
  };
  const agentMark = (source: string) => {
    const start = source.indexOf("struct AgentMark: Decodable");
    expect(start).toBeGreaterThan(0);
    return source.slice(start, source.indexOf("\n}\n", start) + 3);
  };

  test("the Mac and the phone hold the same AgentMark, and read scene.marks through its List", () => {
    expect(agentMark(models.ios)).toBe(agentMark(models.mac));
    expect(models.mac).toContain("let marks: AgentMark.List?");
    expect(models.mac).toContain("marks = scene?.marks?.all ?? []");
    expect(models.ios).toContain("var marks: AgentMark.List?");
    expect(models.ios).toContain("marks = scene?.marks?.all ?? []");
  });

  test("known marks decode; an unknown kind or frame, or a bad point, skips that mark alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-agent-mark-swift-"));
    try {
      const marks = JSON.stringify({
        marks: [
          { id: "cta", kind: "box", frame: { selector: ".cta" }, label: "Moved up" },
          { id: "new", kind: "lasso", frame: { canvas: "c" }, at: [0, 0] },
          { id: "a", kind: "arrow", frame: { canvas: "c" }, at: [0.25, 0.5], to: [0.75, 1] },
          { id: "far", kind: "pin", frame: { window: "w" }, at: [0, 0] },
          { id: "bad", kind: "pin", frame: { canvas: "c" }, at: [0] },
          { id: "e", kind: "ellipse", frame: { image: "/tmp/still.png" }, rect: [0.1, 0.2, 0.3, 0.4] },
          { id: "s", kind: "stroke", frame: { canvas: "c" }, pts: [[0, 0], [1, 1]] },
          { id: "q", kind: "highlight", frame: { quote: "Save" } },
        ],
      });
      writeFileSync(join(dir, "AgentMark.swift"), `import CoreGraphics\nimport Foundation\n${agentMark(models.mac)}`);
      writeFileSync(join(dir, "main.swift"), `import Foundation
struct Scene: Decodable { let marks: AgentMark.List? }
let marks = try JSONDecoder().decode(Scene.self, from: Data(${JSON.stringify(marks)}.utf8)).marks!.all
precondition(marks.map(\\.id) == ["cta", "a", "e", "s", "q"], "\\(marks.map(\\.id))")
precondition(marks[0].kind == .box && marks[0].frame == .selector(".cta") && marks[0].label == "Moved up" && marks[0].at == nil)
precondition(marks[1].at == CGPoint(x: 0.25, y: 0.5) && marks[1].to == CGPoint(x: 0.75, y: 1) && marks[1].frame == .canvas("c"))
precondition(marks[2].rect == CGRect(x: 0.1, y: 0.2, width: 0.3, height: 0.4) && marks[2].frame == .image("/tmp/still.png"))
precondition(marks[3].pts == [CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 1)] && marks[0].pts.isEmpty)
precondition(marks[4].frame == .quote("Save") && marks[4].kind == .highlight)
// Marks that are not a list at all are none, and the scene around them still decodes.
let notAList = try JSONDecoder().decode(Scene.self, from: Data(#"{"marks":"box"}"#.utf8))
precondition(notAList.marks!.all.isEmpty)
let none = try JSONDecoder().decode(Scene.self, from: Data("{}".utf8))
precondition(none.marks == nil)
print("agent mark assertions passed")
`);
      const compiler = Bun.spawn(["swiftc", join(dir, "AgentMark.swift"), join(dir, "main.swift"), "-o", join(dir, "marks")], { stdout: "pipe", stderr: "pipe" });
      const diagnostics = await new Response(compiler.stderr).text();
      expect(await compiler.exited, diagnostics).toBe(0);
      const run = Bun.spawn([join(dir, "marks")], { stdout: "pipe", stderr: "pipe" });
      expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
      expect(await new Response(run.stdout).text()).toContain("agent mark assertions passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * conch_capture's drawing, end to end, without conch.app: the Mac app's own capturer (mac-app/conch-mac/PageCapturer.swift)
 * compiled with ConchDesign's sources and a small harness (test/fixtures/page-capture-main.swift), drawing pages this
 * test serves in a real offscreen web view. The fixture page is the one Tyler's agents fought (2026-10-02, item 2): the
 * target far down it, a lazy image above it with no height reserved that arrives slowly and pushes it down, and a banner
 * the page's script puts in above it a moment after that, when it also gives the target its colour. The capture must
 * wait all of that out and box the target where it ends up: the colour at the middle of the box is the target's (grey
 * had it been taken early), and the colour just outside it is not.
 *
 * Needs a Mac that can run a web view (a login session; nothing is shown: the window is off every screen and the
 * harness never comes to the front). Skipped where swiftc isn't there, or outside a login session.
 */

const repo = (path: string) => join(import.meta.dir, "..", path);
// A web view needs a login session with a window server (`launchctl managername` says Aqua); an ssh session has none.
const drawable = Bun.which("swiftc") !== null
  && Bun.spawnSync(["launchctl", "managername"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim() === "Aqua";
const TARGET = [220, 30, 60];
const GREEN = [20, 170, 60];
const BLUE = [30, 90, 200];

/** A solid PNG, written by hand: the test's images have to arrive as real images, slowly. */
function png(width: number, height: number, [r, g, b]: number[]): Buffer {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r!, g!, b!]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Capture fixture</title><style>
  body { margin: 0; font: 16px/1.4 -apple-system, sans-serif; background: rgb(255, 255, 255); }
  .tall { height: 2600px; background: rgb(244, 244, 244); }
  h1 { margin: 0; height: 60px; font-size: 32px; line-height: 60px; }
  #vis { width: 120px; height: 120px; background: rgb(0, 0, 0); }
  .shot { display: block; width: 600px; }
  #target { width: 400px; height: 160px; margin: 40px auto; background: rgb(128, 128, 128); color: white; }
  .card { padding: 20px; margin: 20px 0; background: rgb(${BLUE.join(", ")}); color: white; }
  .after { height: 3000px; }
</style></head><body>
<div class="tall"><h1>Pricing</h1><div id="vis"></div></div>
<img class="shot" loading="lazy" src="/slow/green.png" alt="" onload="landed()">
<div id="late"></div>
<div id="target">Target</div>
<p class="card">Pick the Pro plan for the team.</p>
<img loading="lazy" src="/slow/blue.png" style="width: 300px; height: 100px" alt="">
<div class="after"></div>
<div id="folded" style="display: none">folded away</div>
<script>
  // Green only once an animation frame has run: a page drawn hidden never gets one.
  requestAnimationFrame(() => { document.getElementById("vis").style.background = "rgb(${GREEN.join(", ")})"; });
  // A moment after the image lands, the page's own script puts a banner in above the target, a second layout shift,
  // and only then gives the target its colour: a capture taken before the page was done is grey.
  function landed() {
    setTimeout(() => {
      const banner = document.createElement("div");
      banner.style.height = "180px";
      banner.style.background = "rgb(250, 200, 0)";
      document.getElementById("late").appendChild(banner);
      document.getElementById("target").style.background = "rgb(${TARGET.join(", ")})";
    }, 200);
  }
</script></body></html>`;

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in – Fixture</title></head><body>
<h1>Sign in</h1><form><input type="email" placeholder="Email"><input type="password"><button>Log in</button></form>
</body></html>`;

interface Line {
  name: string;
  ok: boolean;
  png?: string;
  width?: number;
  height?: number;
  scale?: number;
  element?: [number, number, number, number];
  center?: number[];
  outside?: number[];
  below?: number[];
  points?: Array<number[] | null>;
  finalUrl?: string;
  title?: string;
  loginWall?: boolean;
  clipped?: boolean;
  settled?: boolean;
  error?: string;
  headings?: string[];
  seen?: string;
  seconds: number;
  windows: number;
}

let root = "";
let server: ReturnType<typeof Bun.serve> | undefined;
const requested: Array<{ path: string; at: number }> = [];
const lines = new Map<string, Line>();
let harnessError = "";

/** Within a few levels of each other on every channel: PNG and colour-space rounding, never a different colour. */
function near(actual: number[] | null | undefined, expected: number[], slack = 8): boolean {
  return Array.isArray(actual) && actual.length === 3 && actual.every((value, index) => Math.abs(value - expected[index]!) <= slack);
}

/** A PNG's own width and height, from its header. */
function pngSize(path: string): { width: number; height: number } {
  const head = readFileSync(path).subarray(0, 24);
  expect(head.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

beforeAll(async () => {
  if (!drawable) return;
  root = mkdtempSync(join(tmpdir(), "conch-page-capture-"));
  const green = png(600, 300, GREEN);
  const blue = png(300, 100, BLUE);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push({ path, at: Date.now() });
      if (path === "/page.html") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (path === "/login.html") return new Response(LOGIN, { headers: { "content-type": "text/html" } });
      // Slow, as an image from a real server is: the wait has to be for it, not a race it happens to win.
      if (path === "/slow/green.png") { await Bun.sleep(600); return new Response(green, { headers: { "content-type": "image/png" } }); }
      if (path === "/slow/blue.png") { await Bun.sleep(300); return new Response(blue, { headers: { "content-type": "image/png" } }); }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const cases = [
    { name: "target", url: `${base}/page.html`, selector: "#target", width: 1440, height: 900 },
    { name: "quote", url: `${base}/page.html`, quote: "Pick the Pro plan", width: 1024, height: 700 },
    { name: "top", url: `${base}/page.html`, width: 1024, height: 700, points: [[60, 120]] },
    // In an 800-wide view: the green image's middle is (300, 2750); the target starts at 2600 + 300 + 180 + 40.
    { name: "full", url: `${base}/page.html`, selector: "#target", width: 800, height: 600, fullPage: true, points: [[300, 2750], [400, 3200]] },
    { name: "missing", url: `${base}/page.html`, selector: "#no-such-thing", width: 1024, height: 700 },
    { name: "hidden", url: `${base}/page.html`, selector: "#folded", width: 1024, height: 700 },
    { name: "nearly", url: `${base}/page.html`, quote: "pick the  PRO plan", width: 1024, height: 700 },
    { name: "login", url: `${base}/login.html`, width: 800, height: 600 },
  ];
  writeFileSync(join(root, "cases.json"), JSON.stringify(cases));
  mkdirSync(join(root, "out"));
  copyFileSync(repo("test/fixtures/page-capture-main.swift"), join(root, "main.swift"));
  const design = repo("design/ConchDesign/Sources/ConchDesign");
  const sources = [...new Bun.Glob("*.swift").scanSync(design)].map((name) => join(design, name));
  const binary = join(root, "capture");
  const compile = Bun.spawn(["swiftc", "-swift-version", "5", repo("mac-app/conch-mac/PageCapturer.swift"), ...sources, join(root, "main.swift"), "-o", binary], { stdout: "pipe", stderr: "pipe" });
  if (await compile.exited !== 0) throw new Error(`swiftc failed:\n${await new Response(compile.stderr).text()}`);
  // Spawned, not spawnSync: this process serves the pages it draws.
  const run = Bun.spawn([binary, join(root, "cases.json"), join(root, "out")], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: `${root}/` } });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  if (code !== 0) harnessError = `the harness exited ${code}:\n${err}`;
  if (process.env.CONCH_CAPTURE_DEBUG) console.log(out, err);
  for (const line of out.trim().split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as Line;
    lines.set(parsed.name, parsed);
  }
}, 240_000);

afterAll(() => {
  server?.stop(true);
  // CONCH_CAPTURE_KEEP=<folder> keeps the pictures to look at (the run's temp root goes when the run ends).
  if (root && process.env.CONCH_CAPTURE_KEEP) cpSync(join(root, "out"), process.env.CONCH_CAPTURE_KEEP, { recursive: true });
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!drawable)("conch_capture draws a real page and boxes the target where it ends up", () => {
  test("the harness ran every case", () => {
    expect(harnessError).toBe("");
    expect([...lines.keys()]).toEqual(["target", "quote", "top", "full", "missing", "hidden", "nearly", "login"]);
    // Every window it opened went with its capture.
    for (const line of lines.values()) expect(line.windows, line.name).toBe(0);
  });

  test("a selector far down a shifting page: settled, centred, captured with its margin, its box on it", () => {
    const line = lines.get("target")!;
    expect(line.ok, line.error).toBe(true);
    expect(existsSync(line.png!)).toBe(true);
    expect(pngSize(line.png!)).toEqual({ width: line.width!, height: line.height! });
    const scale = line.scale!;
    expect(scale).toBeGreaterThanOrEqual(1);
    // The target (400 by 160) and its 24 px margin, all in view: nothing cut off. (A pixel either way: with scroll bars
    // always shown, the page is narrower and the target sits on a half pixel.)
    expect(Math.abs(line.width! - 448 * scale)).toBeLessThanOrEqual(scale);
    expect(Math.abs(line.height! - 208 * scale)).toBeLessThanOrEqual(scale);
    expect(line.clipped).toBe(false);
    expect(line.settled).toBe(true);
    const [x, y, w, h] = line.element!;
    for (const [got, want] of [[x, 24], [y, 24], [w, 400], [h, 160]] as const) expect(Math.abs(got - want * scale)).toBeLessThanOrEqual(scale);
    expect(x + w).toBeLessThanOrEqual(line.width!);
    expect(y + h).toBeLessThanOrEqual(line.height!);
    expect(near(line.center, TARGET), JSON.stringify(line.center)).toBe(true);
    expect(near(line.outside, TARGET), JSON.stringify(line.outside)).toBe(false);
    // The slow lazy images were asked for before the capture came back: the wait was for them.
    expect(requested.some((one) => one.path === "/slow/green.png")).toBe(true);
    expect(line.title).toBe("Capture fixture");
    expect(line.loginWall).toBe(false);
  });

  test("a quote: the box is on its words, the card they sit in just under it", () => {
    const line = lines.get("quote")!;
    expect(line.ok, line.error).toBe(true);
    expect(pngSize(line.png!)).toEqual({ width: line.width!, height: line.height! });
    const [x, y, w, h] = line.element!;
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + w).toBeLessThanOrEqual(line.width!);
    expect(y + h).toBeLessThanOrEqual(line.height!);
    // One line of 16 px text.
    expect(h / line.scale!).toBeGreaterThan(12);
    expect(h / line.scale!).toBeLessThan(30);
    expect(near(line.below, BLUE), JSON.stringify(line.below)).toBe(true);
  });

  test("no target: the top of the page at the viewport's size, drawn as a visible page", () => {
    const line = lines.get("top")!;
    expect(line.ok, line.error).toBe(true);
    expect(line.width).toBe(Math.round(1024 * line.scale!));
    expect(line.height).toBe(Math.round(700 * line.scale!));
    expect(line.element).toBeUndefined();
    // Green only after an animation frame ran: the page saw itself visible, as the occlusion switch makes it.
    expect(near(line.points?.[0], GREEN), JSON.stringify(line.points)).toBe(true);
  });

  test("fullPage: the whole page, its lazy images loaded all the way down, the target boxed where it is on it", () => {
    const line = lines.get("full")!;
    expect(line.ok, line.error).toBe(true);
    expect(pngSize(line.png!)).toEqual({ width: line.width!, height: line.height! });
    expect(line.width).toBe(Math.round(800 * line.scale!));
    expect(line.height! / line.scale!).toBeGreaterThan(6000);
    expect(near(line.points?.[0], GREEN), `the green image: ${JSON.stringify(line.points)}`).toBe(true);
    expect(near(line.points?.[1], TARGET), `the target: ${JSON.stringify(line.points)}`).toBe(true);
    const [x, y, w, h] = line.element!.map((value) => value / line.scale!);
    expect([y, w, h]).toEqual([3120, 400, 160]);
    // Centred in 800, or in 785 with scroll bars always shown.
    expect(x).toBeGreaterThanOrEqual(192);
    expect(x).toBeLessThanOrEqual(200);
    expect(near(line.center, TARGET)).toBe(true);
  });

  test("a target that isn't there: said, with the page's title and headings, and a picture of what was seen", () => {
    const line = lines.get("missing")!;
    expect(line.ok).toBe(false);
    expect(line.error).toContain('nothing on the page matches the selector "#no-such-thing"');
    expect(line.title).toBe("Capture fixture");
    expect(line.headings).toContain("Pricing");
    expect(existsSync(line.seen!)).toBe(true);
    // Waited for it to appear, but not for long.
    expect(line.seconds).toBeLessThan(15);
  });

  test("what was nearly there is said: an element that isn't drawn, words in another case", () => {
    expect(lines.get("hidden")).toMatchObject({ ok: false, error: 'the selector "#folded" matches an element, none of them drawn (hidden, or with no size)' });
    expect(lines.get("nearly")).toMatchObject({ ok: false, error: 'the words "pick the  PRO plan" aren\'t on the page as written; it has "Pick the Pro plan"' });
  });

  test("a sign-in screen is captured, and said to be one", () => {
    const line = lines.get("login")!;
    expect(line.ok, line.error).toBe(true);
    expect(line.loginWall).toBe(true);
    expect(line.title).toBe("Sign in – Fixture");
  });
});

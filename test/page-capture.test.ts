import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFolderPath } from "../src/capture-folder.ts";
import { createControlServer, validateSocketTurnEvent, type ControlApplication } from "../src/control-server.ts";
import type { TurnEvent } from "../src/hook.ts";
import {
  CAPTURE_KEPT_MS,
  CAPTURES_KEPT,
  captureFolder,
  captureMark,
  createPageCaptureService,
  decodePageCaptureMessage,
  defaultCaptureKey,
  MAC_APP_DOWN,
  PageCaptures,
  pruneCaptures,
  requestPageCapture,
  withCaptureRequests,
  type CaptureShot,
  type PageCaptureMessage,
} from "../src/page-capture.ts";
import { isMacAppOnlyRequest } from "../src/phone-bridge.ts";
import { artifactIdentity } from "../src/deliverables.ts";
import { reviewIdentity } from "../src/records-receipts.ts";
import { checkLocalFile, checkReviewLink, checkReviewScene, markImagesRefusal } from "../src/snippet.ts";
import type { SessionReview } from "../src/panel.ts";

/**
 * conch_capture's daemon half (src/page-capture.ts): the broker between an agent waiting and the Mac app drawing, the
 * marks it draws round the target, the filing it makes, and where its requests are allowed to go. The Mac app's half is
 * tested by drawing real pages (test/page-capture-render.test.ts) and in ConchDesign (PageCaptureTests).
 */

const scratch = mkdtempSync(join(tmpdir(), "conch-capture-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** A real PNG header (the daemon reads the size from it), then filler. */
function pngBytes(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function broker(options: { ackMs?: number; timeoutMs?: number; limit?: number } = {}) {
  const folder = captureFolder(join(mkdtempSync(join(scratch, "t-")), "captures"));
  let published = 0;
  const captures = new PageCaptures({ publish: () => { published += 1; }, folder: () => folder, now: () => 1_000, ...options });
  const write = (name: string, { mode = 0o600, where = folder, bytes = pngBytes(896, 416) } = {}) => {
    const path = join(where, name);
    writeFileSync(path, bytes);
    chmodSync(path, mode);
    return path;
  };
  return { captures, folder, write, published: () => published };
}

const spec = { url: "https://acme.dev/pricing", target: { selector: ".plan-pro" }, viewport: { width: 1440, height: 900 }, fullPage: false };

describe("the broker: the Mac app acknowledges, draws, and is trusted for nothing", () => {
  test("a request is named while it waits, with the folder and a deadline, and gone once answered", async () => {
    const { captures, folder, write, published } = broker();
    const asked = captures.ask(spec);
    const [request] = captures.requests();
    expect(request).toMatchObject({ url: spec.url, target: spec.target, viewport: spec.viewport, fullPage: false, folder, deadline: 1_000 + 36_000 });
    expect(request!.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(published()).toBe(1);
    expect(await captures.answer({ request: request!.id, ack: true })).toEqual({ ok: true });
    const path = write(`${request!.id}.png`);
    expect(await captures.answer({
      request: request!.id, path, devicePixelRatio: 2, element: { x: 48, y: 48, w: 800, h: 320 },
      finalUrl: "https://acme.dev/pricing", title: "Pricing\n", loginWall: false, clipped: false, settled: true,
    })).toEqual({ ok: true });
    expect(await asked).toEqual({
      ok: true,
      shot: { path, width: 896, height: 416, devicePixelRatio: 2, element: { x: 48, y: 48, w: 800, h: 320 }, finalUrl: "https://acme.dev/pricing", title: "Pricing", loginWall: false },
    });
    expect(captures.requests()).toEqual([]);
    expect(published()).toBe(2);
  });

  test("the size is the PNG's own, and a box is kept inside it", async () => {
    const { captures, write } = broker();
    const asked = captures.ask(spec);
    const id = captures.requests()[0]!.id;
    await captures.answer({ request: id, ack: true });
    await captures.answer({ request: id, path: write(`${id}.png`, { bytes: pngBytes(100, 50) }), width: 9999, element: { x: 90, y: -5, w: 40, h: 20 }, settled: false, clipped: true });
    expect(await asked).toMatchObject({ ok: true, shot: { width: 100, height: 50, element: { x: 90, y: 0, w: 10, h: 15 }, unsettled: true, clipped: true } });
  });

  test("nothing picks it up: the Mac app isn't running; picked up and never answered: it timed out", async () => {
    const quiet = broker({ ackMs: 30, timeoutMs: 1_000 });
    expect(await quiet.captures.ask(spec)).toEqual({ ok: false, error: MAC_APP_DOWN });
    expect(quiet.captures.requests()).toEqual([]);
    const slow = broker({ ackMs: 30, timeoutMs: 120 });
    const asked = slow.captures.ask(spec);
    await slow.captures.answer({ request: slow.captures.requests()[0]!.id, ack: true });
    expect(await asked).toMatchObject({ ok: false, error: expect.stringMatching(/didn't finish drawing in 0 s/) });
  });

  test("outside the folder, another request's name, readable by others, a link out, not a PNG, or nobody asked: refused", async () => {
    const { captures, write, folder } = broker();
    const elsewhere = mkdtempSync(join(scratch, "elsewhere-"));
    const cases: Array<(id: string) => string> = [
      (id) => write(`${id}.png`, { where: elsewhere }),
      () => write("someone-else.png"),
      (id) => write(`${id}.png`, { mode: 0o644 }),
      (id) => write(`${id}.png`, { mode: 0o700 }),
      (id) => {
        const link = join(folder, `${id}.png`);
        symlinkSync(join(root, "package.json"), link);
        return link;
      },
      (id) => write(`${id}.png`, { bytes: Buffer.from("not a png at all, just words in a file") }),
    ];
    for (const make of cases) {
      const asked = captures.ask(spec);
      const id = captures.requests()[0]!.id;
      expect((await captures.answer({ request: id, path: make(id) })).ok).toBe(false);
      expect(await asked).toEqual({ ok: false, error: "the Mac app's capture was refused" });
    }
    expect(await captures.answer({ request: "nobody-asked", ack: true })).toMatchObject({ ok: false });
  });

  test("the app's own reason comes through with what it saw, and a picture of it only if that is conch's own too", async () => {
    const { captures, write } = broker();
    const asked = captures.ask(spec);
    const id = captures.requests()[0]!.id;
    const seen = write(`${id}-seen.png`);
    await captures.answer({
      request: id, error: 'nothing on the page matches the selector ".plan-pro"', path: seen,
      finalUrl: "https://vercel.com/login", title: "Log in to Vercel", loginWall: true, headings: ["Log in to Vercel", 4, "  "],
    });
    expect(await asked).toEqual({
      ok: false,
      error: 'nothing on the page matches the selector ".plan-pro"',
      seen: { path: seen, finalUrl: "https://vercel.com/login", title: "Log in to Vercel", loginWall: true, headings: ["Log in to Vercel"] },
    });
    const other = captures.ask(spec);
    const second = captures.requests()[0]!.id;
    await captures.answer({ request: second, error: "the page didn't load", path: "/etc/hosts" });
    expect(await other).toEqual({ ok: false, error: "the page didn't load" });
  });

  test("three at a time; a fourth is told to wait", async () => {
    const { captures } = broker({ ackMs: 5_000, timeoutMs: 5_000 });
    const waiting = [captures.ask(spec), captures.ask(spec), captures.ask(spec)];
    expect(await captures.ask(spec)).toMatchObject({ ok: false, error: expect.stringMatching(/already drawing 3 pages/) });
    for (const request of captures.requests()) await captures.answer({ request: request.id, error: "stopped" });
    expect((await Promise.all(waiting)).every((outcome) => !outcome.ok)).toBe(true);
  });
});

describe("where a request may go", () => {
  test("only onto this Mac's sessions file: the phone's state never carries it", () => {
    const state = { v: 1, rows: [] };
    expect(withCaptureRequests(state, [])).toBe(state);
    const request = { id: "r1", url: "https://acme.dev", viewport: { width: 1440, height: 900 }, fullPage: false, folder: "/c", deadline: 1 };
    expect(withCaptureRequests(state, [request])).toEqual({ v: 1, rows: [], captureRequests: [request] });
    expect(state).toEqual({ v: 1, rows: [] });
    const daemon = read("src/daemon.ts");
    // The sessions file, which only this Mac's app reads, gets them; the phone (and a second Mac through it) reads
    // `lastPublishedPanelState`, which never does.
    expect(daemon).toContain("publishSessionsFile(withCaptureRequests(lastPublishedPanelState, pageCaptures.requests()))");
    expect(daemon).toContain("publish: () => writeSessionsFile(),");
    expect(daemon).toContain("getState: () => lastPublishedPanelState,");
    expect(daemon).not.toMatch(/lastPublishedPanelState\s*=\s*[^;]*captureRequests/);
    expect(daemon.match(/withCaptureRequests\(/g)).toHaveLength(1);
    expect(daemon.match(/publishSessionsFile\(/g)).toHaveLength(1);
    // The Mac app reads them from its own snapshot; a remote Mac's store never handles them.
    expect(read("mac-app/conch-mac/StateStore.swift")).toContain("pageCaptures.handle(snapshot.captureRequests)");
    expect(read("mac-app/conch-mac/RemoteMacStore.swift")).not.toContain("captureRequests");
  });

  test("a phone may send neither half", () => {
    for (const body of [
      { kind: "page-capture", url: "https://acme.dev", roots: [] },
      { kind: "page-capture-answer", request: "r1", ack: true },
      { kind: "control-envelope", body: { kind: "page-capture", url: "https://acme.dev" } },
    ]) expect(isMacAppOnlyRequest(body), JSON.stringify(body)).toBe(true);
  });

  test("a capture in conch's own folder passes the publish rule; a hidden one beside it, or a key, still doesn't", async () => {
    const folder = captureFolder();
    expect(folder).toBe(captureFolderPath());
    expect(folder).toContain(join("Library", "Application Support", "conch", "captures"));
    const file = join(folder, "rule-check.png");
    writeFileSync(file, pngBytes(1, 1));
    chmodSync(file, 0o600);
    expect(await checkLocalFile(file, [])).toMatchObject({ ok: true });
    // So the daemon files it (`vettedReviewLink`, `vettedMarkImages`) as it would a picture in /tmp.
    expect(await checkReviewLink(file, "/", [])).toEqual({ ok: true, link: file });
    expect(await markImagesRefusal({ v: 1, target: { kind: "auto" }, marks: [{ id: "c", kind: "box", frame: { image: file }, rect: [0, 0, 1, 1] }] }, [])).toBeNull();
    const hidden = join(folder, ".rule-check.png");
    writeFileSync(hidden, pngBytes(1, 1));
    expect(await checkLocalFile(hidden, [])).toMatchObject({ ok: false });
    const key = join(folder, "rule-check.pem");
    writeFileSync(key, "-----BEGIN");
    expect(await checkLocalFile(key, [])).toMatchObject({ ok: false });
    for (const name of ["rule-check.png", ".rule-check.png", "rule-check.pem"]) rmSync(join(folder, name), { force: true });
  });
});

describe("the mark round the target, in the image's own 0-1", () => {
  const shot: CaptureShot = {
    path: "/c/r1.png", width: 896, height: 416, devicePixelRatio: 2, element: { x: 48, y: 48, w: 800, h: 320 },
    finalUrl: "https://acme.dev", title: "", loginWall: false,
  };
  const valid = (mark: unknown) => checkReviewScene({ v: 1, target: { kind: "auto" }, marks: [mark] }, true);

  test("a box stands off the target by 8 CSS pixels; a highlight lies on it", () => {
    const box = captureMark(shot, { kind: "box", label: "Moved up" });
    expect(box).toEqual({ id: "capture", kind: "box", frame: { image: "/c/r1.png" }, label: "Moved up", rect: [0.0357, 0.0769, 0.9286, 0.8462] });
    expect(captureMark(shot, { kind: "highlight" })).toEqual({
      id: "capture", kind: "highlight", frame: { image: "/c/r1.png" }, rect: [0.0536, 0.1154, 0.8929, 0.7692],
    });
    // Rounding never carries it past the edge.
    const edge = captureMark({ ...shot, element: { x: 0, y: 0, w: 896, h: 416 } }, { kind: "box" })!;
    expect(edge.rect).toEqual([0, 0, 1, 1]);
    for (const mark of [box, edge]) expect(valid(mark)).toMatchObject({ ok: true });
  });

  test("an arrow from the side with room, a pin on the top right corner, text under it: each one review_to_front takes", () => {
    const wide: CaptureShot = { ...shot, width: 2880, height: 1800, element: { x: 200, y: 600, w: 400, h: 200 } };
    const arrow = captureMark(wide, { kind: "arrow" })!;
    expect(arrow.to![0]).toBeGreaterThan((200 + 400) / 2880);
    expect(arrow.at![0]).toBeGreaterThan(arrow.to![0]);
    expect(captureMark(wide, { kind: "pin" })).toMatchObject({ at: [Math.round((600 / 2880) * 10_000) / 10_000, Math.round((600 / 1800) * 10_000) / 10_000] });
    expect(captureMark(wide, { kind: "text", label: "Here" })).toMatchObject({ at: [0.0694, 0.4533], label: "Here" });
    // A capture of the element alone has no room beside it: the arrow points in from inside its corner.
    const tight = captureMark(shot, { kind: "arrow" })!;
    expect(tight.at).not.toEqual(tight.to);
    for (const mark of [arrow, tight, captureMark(wide, { kind: "pin" }), captureMark(wide, { kind: "ellipse" }), captureMark(wide, { kind: "text", label: "Here" })]) {
      expect(valid(mark), JSON.stringify(mark)).toMatchObject({ ok: true });
    }
  });

  test("no box, no mark", () => {
    expect(captureMark({ ...shot, element: undefined }, { kind: "box" })).toBeNull();
    expect(captureMark({ ...shot, element: { x: 0, y: 0, w: 0, h: 10 } }, { kind: "box" })).toBeNull();
  });
});

describe("the socket's page-capture, checked again where it lands", () => {
  const message = { kind: "page-capture", url: "https://acme.dev", roots: [], viewport: { width: 1440, height: 900 }, fullPage: false };

  test("what the MCP server sends decodes; anything else is refused in words", () => {
    expect(decodePageCaptureMessage(message)).toMatchObject({ ok: true });
    expect(decodePageCaptureMessage({ kind: "page-capture", url: "https://acme.dev" })).toMatchObject({ ok: true, value: { viewport: { width: 1440, height: 900 }, fullPage: false, roots: [] } });
    for (const [bad, reason] of [
      [{ ...message, url: "javascript:alert(1)" }, "url must be"],
      [{ ...message, url: "relative/page.html" }, "url must be"],
      [{ ...message, roots: ["relative"] }, "roots must be absolute"],
      [{ ...message, target: { selector: "a", quote: "b" } }, "exactly one of"],
      [{ ...message, viewport: { width: 99999, height: 900 } }, "viewport must be"],
      [{ ...message, fullPage: 1 }, "fullPage must be"],
      [{ ...message, mark: "box" }, "drawn round the target"],
      [{ ...message, target: { quote: "x" }, mark: { kind: "stroke" } }, "mark kind must be"],
      [{ ...message, publish: { summary: "x" } }, "name its session"],
      [{ ...message, publish: { sessionId: "s", label: "a", summary: "two\nlines" } }, "summary must be one printable line"],
      [{ ...message, publish: { sessionId: "s", label: "a", summary: "x", key: "" } }, "key must be"],
    ] as const) {
      expect(decodePageCaptureMessage(bad), JSON.stringify(bad)).toMatchObject({ ok: false, err: expect.stringContaining(reason) });
    }
  });

  test("the default artifact is the page and the part of it", () => {
    expect(defaultCaptureKey("https://acme.dev/pricing", { selector: ".plan-pro" })).toBe("capture https://acme.dev/pricing .plan-pro");
    expect(defaultCaptureKey("https://acme.dev/pricing", { quote: "Pick Pro" })).toBe('capture https://acme.dev/pricing "Pick Pro"');
    expect(defaultCaptureKey(`https://acme.dev/${"x".repeat(400)}`)).toHaveLength(200);
  });
});

/** A control server with the real service behind it, the way the daemon wires it, and a pretend Mac app. */
async function served(options: { held?: SessionReview[]; versions?: Record<string, number>; verdict?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cs-"));
  const socketPath = join(dir, "s.sock");
  const folder = captureFolder(join(dir, "captures"));
  const turns: TurnEvent[] = [];
  const resolved: unknown[] = [];
  let pruned = 0;
  const captures = new PageCaptures({ publish: () => {}, folder: () => folder, now: Date.now, ackMs: 2_000, timeoutMs: 4_000 });
  const service = createPageCaptureService({
    captures,
    held: () => ({ reviews: options.held ?? [], versions: options.versions }),
    prune: () => { pruned += 1; },
    now: () => 1_700_000_000_000,
  });
  const server = createControlServer({
    socketPath,
    ownerDeviceId: "mac",
    log: () => {},
    sessions: { resolve: (value) => { resolved.push(value); return value; }, current: () => ({ published: false }) },
    application: { turn: (event: TurnEvent) => { turns.push(event); return options.verdict; } } as unknown as ControlApplication,
    pageCapture: service,
  });
  expect(await server.start()).toBe(true);
  const exchange = (value: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect({ path: socketPath });
    let data = "";
    socket.on("data", (chunk) => { data += chunk.toString(); });
    socket.on("end", () => resolve(JSON.parse(data)));
    socket.on("error", reject);
    socket.write(`${JSON.stringify(value)}\n`);
  });
  /** The Mac app: once a request shows up, acknowledge it, write `answer`'s file and answer. */
  const app = async (answer: (id: string) => Record<string, unknown>) => {
    while (!captures.requests().length) await Bun.sleep(5);
    const id = captures.requests()[0]!.id;
    expect(await exchange({ kind: "page-capture-answer", request: id, ack: true })).toEqual({ kind: "capture-ack" });
    return exchange({ kind: "page-capture-answer", request: id, ...answer(id) });
  };
  const png = (id: string) => {
    const path = join(folder, `${id}.png`);
    writeFileSync(path, pngBytes(896, 416));
    chmodSync(path, 0o600);
    return path;
  };
  return {
    socketPath, folder, turns, resolved, exchange, app, png, pruned: () => pruned,
    close: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("over the socket: the agent's request held open until the app has drawn it", () => {
  const publish = { sessionId: "session-123", label: "Build", cwd: "/work/build", pid: 4321, transcriptPath: "/t/session-123.jsonl", transcriptMark: 7, summary: "the Pro plan card" };
  const message = (extra: Partial<PageCaptureMessage> = {}): PageCaptureMessage => ({
    kind: "page-capture", url: "https://acme.dev/pricing", roots: [], target: { selector: ".plan-pro" }, viewport: { width: 1440, height: 900 }, fullPage: false, ...extra,
  });

  test("a capture with a mark comes back with the mark on the image, filed nowhere", async () => {
    const h = await served();
    try {
      const [reply] = await Promise.all([
        requestPageCapture(h.socketPath, message({ mark: { kind: "box" } }), 5_000),
        h.app((id) => ({ path: h.png(id), devicePixelRatio: 2, element: { x: 48, y: 48, w: 800, h: 320 }, finalUrl: "https://acme.dev/pricing", title: "Pricing", loginWall: false })),
      ]);
      expect(reply).toMatchObject({ ok: true, reply: { kind: "page-capture-result", capture: { width: 896, height: 416, element: { x: 48, y: 48, w: 800, h: 320 } } } });
      if (!reply.ok || reply.reply.kind !== "page-capture-result") throw new Error("no capture");
      expect(reply.reply.marks).toEqual([{ id: "capture", kind: "box", frame: { image: reply.reply.capture.path }, rect: [0.0357, 0.0769, 0.9286, 0.8462] }]);
      expect(reply.reply.filed).toBeUndefined();
      expect(h.turns).toEqual([]);
      // Old captures are tidied before each new one; nothing about the capture is resolved as a session.
      expect(h.pruned()).toBe(1);
      expect(h.resolved).toEqual([]);
    } finally {
      await h.close();
    }
  });

  test("publish files it through the socket's own turn path, as review_to_front's would be, and says what it filed", async () => {
    const page = "/c/r0.png";
    const artifact = artifactIdentity("pricing-pro");
    const held: SessionReview[] = [{ summary: "the card before", link: page, at: 1, id: "old", artifact, version: 1, kind: "image" }];
    const h = await served({ held, versions: { [artifact]: 3 } });
    try {
      const [reply] = await Promise.all([
        requestPageCapture(h.socketPath, message({ mark: { kind: "box", label: "Moved up" }, publish: { ...publish, key: "pricing-pro" } }), 5_000),
        h.app((id) => ({ path: h.png(id), devicePixelRatio: 2, element: { x: 48, y: 48, w: 800, h: 320 }, finalUrl: "https://acme.dev/pricing", title: "Pricing" })),
      ]);
      if (!reply.ok || reply.reply.kind !== "page-capture-result") throw new Error(JSON.stringify(reply));
      const path = reply.reply.capture.path;
      expect(h.turns).toHaveLength(1);
      const event = h.turns[0]!;
      // Exactly the event review_to_front sends, and one the socket's own validator takes.
      expect(event).toEqual({
        type: "review-published",
        sessionId: "session-123",
        label: "Build",
        cwd: "/work/build",
        pid: 4321,
        announce: "Build has work ready for your review: the Pro plan card",
        transcriptPath: "/t/session-123.jsonl",
        mark: 7,
        eventAt: 1_700_000_000_000,
        review: {
          summary: "the Pro plan card",
          link: path,
          kind: "image",
          key: "pricing-pro",
          scene: { v: 1, target: { kind: "auto" }, marks: [{ id: "capture", kind: "box", frame: { image: path }, label: "Moved up", rect: [0.0357, 0.0769, 0.9286, 0.8462] }] },
        },
      });
      expect(validateSocketTurnEvent(event)).toEqual({ ok: true, value: event });
      // Resolved as a socket event is (`addressWindow`), before it is filed.
      expect(h.resolved).toEqual([event]);
      expect(reply.reply.filed).toEqual({
        id: reviewIdentity("session-123", { summary: "the Pro plan card", link: path, at: 1_700_000_000_000 }),
        artifact,
        // One past the highest this session has filed of it, as `fileReview` numbers it.
        version: 4,
        kind: "image",
        summary: "the Pro plan card",
      });
    } finally {
      await h.close();
    }
  });

  // The daemon's verdict reaches a capture's publication as it reaches review_to_front's (review-verdict.ts).
  test("a publication the daemon refuses comes back not filed, with the daemon's reason", async () => {
    const h = await served({ verdict: Promise.resolve({ kind: "review-refused", reason: "the user dismissed this session from conch" }) });
    try {
      const [reply] = await Promise.all([
        requestPageCapture(h.socketPath, message({ publish }), 5_000),
        h.app((id) => ({ path: h.png(id), devicePixelRatio: 2, element: { x: 48, y: 48, w: 800, h: 320 }, finalUrl: "https://acme.dev/pricing", title: "Pricing" })),
      ]);
      expect(reply).toMatchObject({ ok: true, reply: { kind: "page-capture-result", notFiled: "conch didn't file it: the user dismissed this session from conch" } });
      expect(h.turns).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  test("a sign-in screen comes back, and isn't filed", async () => {
    const h = await served();
    try {
      const [reply] = await Promise.all([
        requestPageCapture(h.socketPath, message({ target: undefined, publish }), 5_000),
        h.app((id) => ({ path: h.png(id), devicePixelRatio: 2, finalUrl: "https://vercel.com/login", title: "Log in to Vercel", loginWall: true })),
      ]);
      expect(reply).toMatchObject({ ok: true, reply: { kind: "page-capture-result", capture: { loginWall: true }, notFiled: expect.stringContaining("sign-in screen") } });
      expect(h.turns).toEqual([]);
    } finally {
      await h.close();
    }
  });

  test("the app's refusal, and no app at all, come back as errors in words", async () => {
    const h = await served();
    try {
      const [refused] = await Promise.all([
        requestPageCapture(h.socketPath, message(), 5_000),
        h.app(() => ({ error: "the page didn't load: A server with the specified hostname could not be found." })),
      ]);
      expect(refused).toEqual({ ok: true, reply: { kind: "page-capture-error", error: "the page didn't load: A server with the specified hostname could not be found." } });
      expect(await requestPageCapture(h.socketPath, message(), 5_000)).toEqual({ ok: true, reply: { kind: "page-capture-error", error: MAC_APP_DOWN } });
    } finally {
      await h.close();
    }
  });

  test("a local page outside the folders it names is refused before the app is asked", async () => {
    const h = await served();
    try {
      expect(await requestPageCapture(h.socketPath, message({ url: join(root, "README.md"), roots: [root] }), 5_000))
        .toEqual({ ok: true, reply: { kind: "page-capture-error", error: "a local page must be an .html file" } });
      expect(await requestPageCapture(h.socketPath, message({ url: "/etc/hosts.html", roots: [] }), 5_000))
        .toMatchObject({ ok: true, reply: { kind: "page-capture-error" } });
    } finally {
      await h.close();
    }
  });

  test("no daemon: said as such", async () => {
    expect(await requestPageCapture(join(scratch, "nobody.sock"), message(), 1_000)).toMatchObject({ ok: false, reason: "daemon-down" });
  });
});

describe("pruning", () => {
  test("an unreferenced capture goes after a week, a held one never, and past the cap the oldest go first", () => {
    const folder = captureFolder(join(mkdtempSync(join(scratch, "p-")), "captures"));
    const now = Date.now();
    const make = (name: string, ageMs: number) => {
      const path = join(folder, name);
      writeFileSync(path, pngBytes(1, 1));
      const at = (now - ageMs) / 1000;
      utimesSync(path, at, at);
      return path;
    };
    const held = make("held.png", CAPTURE_KEPT_MS * 3);
    make("old.png", CAPTURE_KEPT_MS + 1_000);
    make("fresh.png", 1_000);
    writeFileSync(join(folder, "notes.txt"), "not ours to judge");
    for (let index = 0; index < CAPTURES_KEPT + 2; index += 1) make(`n${index}.png`, 10_000 + index * 1_000);
    pruneCaptures(folder, now, new Set([held]));
    const left = new Set(readdirSync(folder));
    expect(left.has("held.png")).toBe(true);
    expect(left.has("old.png")).toBe(false);
    expect(left.has("fresh.png")).toBe(true);
    expect(left.has("notes.txt")).toBe(true);
    // fresh.png and the newest of the rest make the cap; the two oldest of them are gone.
    expect([...left].filter((name) => /^n\d+\.png$/.test(name))).toHaveLength(CAPTURES_KEPT - 1);
    expect(left.has(`n${CAPTURES_KEPT + 1}.png`)).toBe(false);
    expect(left.has("n0.png")).toBe(true);
    // A folder that isn't there is nothing to do.
    expect(() => pruneCaptures(join(folder, "missing"), now, new Set())).not.toThrow();
    mkdirSync(join(folder, "sub.png"));
    expect(() => pruneCaptures(folder, now, new Set())).not.toThrow();
  });
});

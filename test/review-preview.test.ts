import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachReviewPreview, type SessionReview } from "../src/panel.ts";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";
import {
  captureDocument,
  captureSimulator,
  createPreviewRequester,
  PREVIEW_MIN_INTERVAL_MS,
  previewFolder,
  PreviewLimiter,
  PREVIEWS_PER_MINUTE,
  type Probe,
  type ReviewPreview,
} from "../src/review-preview.ts";
import { SessionLedger } from "../src/session-ledger.ts";

/**
 * Tyler (09-25): "it will also need other materials sent to it if there's not an equivalent on the phone". A deliverable
 * the phone can't draw gets a snapshot of it from the Mac. Every rule that keeps that to the deliverable's own device or
 * document, at a pace the Mac can bear, and readable only through `/file`'s rule, is pinned here.
 */
const scratch = mkdtempSync(join(tmpdir(), "conch-preview-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A probe that answers from a table and records every command, writing the file a screenshot or a thumbnail makes. */
function fakeProbe(booted: string[]): { probe: Probe; ran: string[][] } {
  const ran: string[][] = [];
  const probe: Probe = async (argv) => {
    ran.push(argv);
    if (argv[1] === "simctl" && argv[2] === "list") {
      return JSON.stringify({ devices: { "iOS 27": booted.map((udid) => ({ udid, state: "Booted" })).concat([{ udid: "SHUT", state: "Shutdown" }]) } });
    }
    if (argv[1] === "simctl" && argv[2] === "io") {
      writeFileSync(argv.at(-1)!, "png");
      return "";
    }
    if (argv[0] === "qlmanage") {
      const folder = argv[argv.indexOf("-o") + 1]!;
      writeFileSync(join(folder, `${argv.at(-1)!.split("/").pop()}.png`), "thumb");
      return "";
    }
    return null;
  };
  return { probe, ran };
}

describe("only the deliverable's own, never a guess", () => {
  test("the Simulator: the one booted device, and none when two or none are", async () => {
    const out = join(scratch, "sim.png");
    const one = fakeProbe(["AAAA-1111"]);
    expect(await captureSimulator(out, one.probe)).toBeNull();
    expect(one.ran.at(-1)).toEqual(["xcrun", "simctl", "io", "AAAA-1111", "screenshot", "--type=png", out]);
    for (const booted of [[], ["AAAA-1111", "BBBB-2222"]]) {
      const many = fakeProbe(booted);
      expect(await captureSimulator(join(scratch, "no.png"), many.probe)).toMatch(booted.length ? /more than one Simulator/ : /no Simulator/);
      expect(many.ran.some((argv) => argv[2] === "io")).toBe(false);
    }
  });

  test("a document: only the file the review links, only once it passes the publish rule again", async () => {
    const root = mkdtempSync(join(scratch, "doc-"));
    const deck = join(root, "deck.key");
    // A Keynote deck is one zip; a `.key` that isn't is a private key, and stays refused.
    writeFileSync(deck, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("keynote")]));
    chmodSync(deck, 0o600);
    const out = join(scratch, "deck.png");
    const good = fakeProbe([]);
    expect(await captureDocument(deck, [root], out, good.probe)).toBeNull();
    expect(good.ran.at(-1)?.at(-1)).toBe(require("node:fs").realpathSync(deck));
    expect(existsSync(out)).toBe(true);
    // Hidden, a key, executable, or a symlink out of reach: refused, and Quick Look never runs.
    mkdirSync(join(root, ".private"));
    const hidden = join(root, ".private/deck.key");
    writeFileSync(hidden, "x");
    const repo = join(import.meta.dir, "..", "package.json");
    const linked = join(root, "linked.key");
    symlinkSync(repo, linked);
    const pem = join(root, "server.key");
    writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nMIIE\n");
    const der = join(root, "client.key");
    writeFileSync(der, Buffer.from([0x30, 0x82, 0x04, 0xa4]));
    for (const refused of [hidden, linked, join(root, "missing.key"), pem, der]) {
      const probe = fakeProbe([]);
      expect(await captureDocument(refused, [root], join(scratch, "no.png"), probe.probe)).not.toBeNull();
      expect(probe.ran).toEqual([]);
    }
  });
});

describe("the phone's request", () => {
  const folder = previewFolder(scratch);
  const held: SessionReview[] = [
    { summary: "the build", at: 1, id: "sim-1", kind: "simulator" },
    { summary: "a page", at: 2, id: "page-1", kind: "page", link: "/tmp/x.html" },
    { summary: "the app", at: 3, id: "app-1", kind: "app" },
  ];
  function requester(options: { now?: () => number; booted?: string[] } = {}) {
    let state = held.map((one) => ({ ...one }));
    const fake = fakeProbe(options.booted ?? ["AAAA-1111"]);
    const ask = createPreviewRequester({
      held: (sessionId) => (sessionId === "s" ? { reviews: state, roots: [] } : undefined),
      attach: (sessionId, reviewId, preview) => {
        const next = attachReviewPreview(state, reviewId, preview);
        if (sessionId !== "s" || !next) return false;
        state = next;
        return true;
      },
      limiter: new PreviewLimiter(),
      folder: () => folder,
      now: options.now ?? Date.now,
      probe: fake.probe,
    });
    return { ask, state: () => state, ran: fake.ran };
  }

  test("a snapshot goes on the held review, 0600 in conch's own 0700 folder under the temp root", async () => {
    const { ask, state } = requester();
    expect(await ask("s", "sim-1")).toEqual({ status: 200 });
    const preview = state().find((one) => one.id === "sim-1")?.preview as ReviewPreview;
    expect(preview.kind).toBe("image");
    expect(preview.path.startsWith(`${folder}/`)).toBe(true);
    expect(statSync(preview.path).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  test("never for a deliverable not held, nor one the phone draws itself, nor a window the daemon can't see", async () => {
    const { ask, ran } = requester();
    expect(await ask("s", "gone")).toMatchObject({ status: 404 });
    expect(await ask("nobody", "sim-1")).toMatchObject({ status: 404 });
    expect(await ask("s", "page-1")).toMatchObject({ status: 400 });
    // An app window is the Mac app's to take, with its own Screen Recording grant: never the daemon's.
    expect(await ask("s", "app-1")).toMatchObject({ status: 422 });
    expect(ran).toEqual([]);
  });

  test("Refresh is limited: once per deliverable every ten seconds, and six a minute over all of them", async () => {
    let now = 1_000_000;
    const { ask, ran } = requester({ now: () => now });
    expect(await ask("s", "sim-1")).toEqual({ status: 200 });
    const again = await ask("s", "sim-1");
    expect(again).toMatchObject({ status: 429, error: expect.stringMatching(/another in 10 s/) });
    now += PREVIEW_MIN_INTERVAL_MS;
    expect(await ask("s", "sim-1")).toEqual({ status: 200 });
    expect(ran.filter((argv) => argv[2] === "io")).toHaveLength(2);

    const limiter = new PreviewLimiter();
    for (let index = 0; index < PREVIEWS_PER_MINUTE; index += 1) expect(limiter.take(`r${index}`, 5_000 + index)).toBeNull();
    expect(limiter.take("one-more", 6_000)).toBeGreaterThan(0);
    expect(limiter.take("one-more", 65_001)).toBeNull();
  });

  test("the snapshot it replaces is deleted, and only ever one in conch's own folder", async () => {
    let now = 2_000_000;
    const { ask, state } = requester({ now: () => now });
    await ask("s", "sim-1");
    const first = state().find((one) => one.id === "sim-1")!.preview!.path;
    now += PREVIEW_MIN_INTERVAL_MS;
    await ask("s", "sim-1");
    expect(existsSync(first)).toBe(false);
    expect(existsSync(state().find((one) => one.id === "sim-1")!.preview!.path)).toBe(true);

    // A snapshot path from anywhere else (a record restored from disk, say) is never deleted.
    const elsewhere = join(scratch, "not-a-snapshot.png");
    writeFileSync(elsewhere, "keep me");
    held[0]!.preview = { path: elsewhere, kind: "image", capturedAt: 1 };
    const fresh = requester({ now: () => now + PREVIEW_MIN_INTERVAL_MS * 2 });
    held[0]!.preview = undefined;
    expect(await fresh.ask("s", "sim-1")).toEqual({ status: 200 });
    expect(existsSync(elsewhere)).toBe(true);
  });
});

describe("served only through /file's rule, and published with the review", () => {
  const TOKEN = "p".repeat(32);
  test("a held snapshot is served; one not held, or swapped for a link out of reach, is refused", async () => {
    const folder = previewFolder(mkdtempSync(join(scratch, "serve-")));
    const shot = join(folder, "sim-1.png");
    const stray = join(folder, "other.png");
    writeFileSync(shot, "png");
    writeFileSync(stray, "png");
    chmodSync(shot, 0o600);
    chmodSync(stray, 0o600);
    const application = createPhoneBridgeApplication({
      getState: () => ({ rows: [{ id: "s", reviews: [{ id: "sim-1", kind: "simulator", preview: { path: shot, kind: "image", capturedAt: 1 } }] }] }),
      forwardControl: async () => "{}",
      replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      log: () => {},
    }, { token: TOKEN });
    const status = async (path: string) => ((await application.handle(new Request(
      `https://relay.invalid/file?path=${encodeURIComponent(path)}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    ))) as Response).status;
    expect(await status(shot)).toBe(200);
    expect(await status(stray)).toBe(403);
    unlinkSync(shot);
    symlinkSync(join(import.meta.dir, "..", "package.json"), shot);
    expect(await status(shot)).toBe(403);
  });

  test("/preview needs the token, asks the requester, and says why in words", async () => {
    const asked: string[] = [];
    const application = createPhoneBridgeApplication({
      getState: () => ({ rows: [] }),
      forwardControl: async () => "{}",
      replyFor: async () => "",
      acceptUpload: async () => ({ received: 1, total: 1 }),
      requestPreview: async (session, review) => {
        asked.push(`${session}/${review}`);
        return { status: 429, error: "a snapshot was just taken; another in 7 s" };
      },
      log: () => {},
    }, { token: TOKEN });
    const post = (authorized: boolean) => application.handle(new Request("https://relay.invalid/preview", {
      method: "POST",
      headers: authorized ? { authorization: `Bearer ${TOKEN}` } : {},
      body: JSON.stringify({ session: "s", review: "sim-1" }),
    })) as Promise<Response>;
    expect((await post(false)).status).toBe(401);
    const answer = await post(true);
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: "a snapshot was just taken; another in 7 s" });
    expect(asked).toEqual(["s/sim-1"]);
  });

  test("a snapshot survives a restart with its review, and only on the review it was taken of", () => {
    const path = join(scratch, "reviews.json");
    const reviews: SessionReview[] = [
      { summary: "the build", at: 1, id: "sim-1", kind: "simulator", artifact: "a", version: 1 },
      { summary: "the deck", at: 2, id: "doc-1", kind: "document", link: "/tmp/deck.key", artifact: "b", version: 1 },
    ];
    const preview = { path: "/tmp/conch-previews/sim-1-1.png", kind: "image" as const, capturedAt: 9 };
    const next = attachReviewPreview(reviews, "sim-1", preview)!;
    expect(next.map((one) => one.preview)).toEqual([preview, undefined]);
    expect(attachReviewPreview(reviews, "nope", preview)).toBeUndefined();
    const ledger = new SessionLedger(path);
    ledger.sessionStates.set("s", { label: "s", status: "waiting", at: 2, review: next[1]!, reviews: next });
    ledger.saveReviews();
    const after = new SessionLedger(path);
    after.restoreReviews();
    expect(after.sessionStates.get("s")?.reviews?.map((one) => one.preview)).toEqual([preview, undefined]);
  });
});

test("the daemon hands the bridge the requester, which files the snapshot on the held review and republishes", () => {
  const daemon = require("node:fs").readFileSync(join(import.meta.dir, "..", "src/daemon.ts"), "utf8") as string;
  const wiring = daemon.slice(daemon.indexOf("requestPreview: createPreviewRequester({"), daemon.indexOf("limiter: new PreviewLimiter(),"));
  expect(wiring).toContain("const next = attachReviewPreview(state?.reviews ?? (state?.review ? [state.review] : undefined), reviewId, preview);");
  expect(wiring).toContain("ledger.saveReviews();");
  expect(wiring).toContain("void renderSessionPanel();");
  expect(wiring).toContain("roots: [row?.cwd, ...(row?.workDirs ?? [])].filter((root): root is string => Boolean(root)),");
});

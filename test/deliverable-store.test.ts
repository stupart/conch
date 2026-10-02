import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  deliverableStoreDir,
  discardStoredCopy,
  STORE_MAX_FILES,
  storeEntry,
  storeTempDeliverable,
  sweepStore,
} from "../src/deliverable-store.ts";
import { createPhoneBridgeApplication } from "../src/phone-bridge.ts";
import { SessionLedger } from "../src/session-ledger.ts";
import { carriedReviews, fileReview, type SessionReview } from "../src/panel.ts";
import { checkLocalFile } from "../src/snippet.ts";

/**
 * A deliverable used to be filed by its path alone. /tmp goes at every boot and the per-user temp folder is cleaned of
 * files nobody opened for days, so a screenshot published from either was "Couldn't find hero.png" on the Mac and a 404
 * on the phone the morning after, still listed as ready for review (2026-10-03). Now it is copied into conch's own store
 * when it is filed, and the copy lives exactly as long as a held deliverable names it.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/**
 * A temp folder of its own (under the suite's temp root), and a home of its own, so the store is where a real one is,
 * `~/Library/Application Support/conch/deliverables`, and the publish rule finds it there (`conchHome` is read at call
 * time).
 */
function world() {
  const temp = mkdtempSync(join(tmpdir(), "conch-store-"));
  const savedHome = process.env.CONCH_HOME;
  process.env.CONCH_HOME = join(temp, "home");
  const store = deliverableStoreDir();
  const session = join(temp, "project");
  mkdirSync(session, { recursive: true });
  cleanups.push(() => {
    process.env.CONCH_HOME = savedHome;
    rmSync(temp, { recursive: true, force: true });
  });
  const put = (path: string, body: string | Buffer = "x") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  return { temp, store, session, put };
}

const mode = (path: string) => statSync(path).mode & 0o777;

describe("what is copied when a deliverable is filed", () => {
  test("a file in a temp folder, outside the session's folders: into <store>/<artifact>/v<version>-…, 0600 in 0700 folders", async () => {
    const { temp, store, session, put } = world();
    const shot = put(join(temp, "shots", "hero.png"), "png");
    chmodSync(shot, 0o644);
    const stored = await storeTempDeliverable({ link: shot, folder: false, markImages: [], roots: [session], artifact: "a1b2c3", version: 2, store });
    const copy = stored.copies.get(shot)!;
    expect(stored.notCopied).toBeUndefined();
    expect(copy).toStartWith(join(store, "a1b2c3", "v2-"));
    expect(basename(copy)).toBe("hero.png");
    expect(dirname(copy)).toBe(stored.dir!);
    expect(readFileSync(copy, "utf8")).toBe("png");
    expect([mode(copy), mode(stored.dir!), mode(join(store, "a1b2c3")), mode(store)]).toEqual([0o600, 0o700, 0o700, 0o700]);
    // Each filing its own: the same file filed again is another copy, so one removed never takes the other.
    const again = await storeTempDeliverable({ link: shot, folder: false, markImages: [], roots: [session], artifact: "a1b2c3", version: 3, store });
    expect(again.dir).not.toBe(stored.dir);
  });

  test("never what is under the session's own folders, even when that folder is in a temp folder: that is live work", async () => {
    const { store, session, put } = world();
    const live = put(join(session, "build", "out.png"));
    expect(await storeTempDeliverable({ link: live, folder: false, markImages: [live], roots: [session], artifact: "a", version: 1, store }))
      .toEqual({ copies: new Map() });
    // A URL, or nothing to link, has nothing to copy.
    expect((await storeTempDeliverable({ link: "https://x.test/p", folder: false, markImages: [], roots: [], artifact: "a", version: 1, store })).copies.size).toBe(0);
    expect((await storeTempDeliverable({ folder: false, markImages: [], roots: [], artifact: "a", version: 1, store })).copies.size).toBe(0);
    expect(existsSync(store)).toBe(false);
  });

  test("a page brings the folder it is in, as the phone reads it, with no hidden file, key or symlink out", async () => {
    const { temp, store, session, put } = world();
    const site = join(temp, "renders", "site");
    const page = put(join(site, "pages", "index.html"), "<h1>hi</h1>");
    put(join(site, "pages", "style.css"));
    put(join(site, "pages", "img", "a.png"));
    put(join(site, "pages", ".env"), "SECRET=1");
    put(join(site, "pages", "deploy.pem"), "-----BEGIN");
    symlinkSync(join(temp), join(site, "pages", "everything"));
    const stored = await storeTempDeliverable({ link: page, folder: false, markImages: [], roots: [session], artifact: "p", version: 1, store });
    const copy = stored.copies.get(page)!;
    expect(copy).toBe(join(stored.dir!, "pages", "index.html"));
    const listed = readdirSync(join(stored.dir!, "pages"), { recursive: true }).map(String).sort();
    expect(listed).toEqual(["img", "img/a.png", "index.html", "style.css"]);
  });

  test("a page directly in a temp folder brings nothing beside it: that folder is everyone's", async () => {
    const { store, session } = world();
    const page = join(process.env.CONCH_USER_TEMP_DIR!, `conch-store-loose-${process.pid}.html`);
    const neighbour = join(process.env.CONCH_USER_TEMP_DIR!, `conch-store-neighbour-${process.pid}.css`);
    writeFileSync(page, "<h1>loose</h1>");
    writeFileSync(neighbour, "body{}");
    cleanups.push(() => { rmSync(page, { force: true }); rmSync(neighbour, { force: true }); });
    const stored = await storeTempDeliverable({ link: page, folder: false, markImages: [], roots: [session], artifact: "l", version: 1, store });
    expect(readdirSync(stored.dir!)).toEqual([basename(page)]);
  });

  test("a folder deliverable is the folder, and its marks' images ride along: the link's own, one inside it, one elsewhere", async () => {
    const { temp, store, session, put } = world();
    const pack = join(temp, "deliverable-shots");
    const inside = put(join(pack, "a.png"));
    const elsewhere = put(join(temp, "stills", "a.png"));
    const another = put(join(temp, "more", "a.png"));
    const stored = await storeTempDeliverable({
      link: pack, folder: true, markImages: [inside, elsewhere, elsewhere, another], roots: [session], artifact: "f", version: 1, store,
    });
    expect(stored.copies.get(pack)).toBe(join(stored.dir!, "deliverable-shots"));
    expect(stored.copies.get(inside)).toBe(join(stored.dir!, "deliverable-shots", "a.png"));
    expect(stored.copies.get(elsewhere)).toBe(join(stored.dir!, "a.png"));
    // Two files of one name in one version folder: the second is told apart, not overwritten.
    expect(stored.copies.get(another)).toBe(join(stored.dir!, "2-a.png"));
    // The link's own image, marked: one copy, two names for it.
    const shot = put(join(temp, "one", "shot.png"));
    const marked = await storeTempDeliverable({ link: shot, folder: false, markImages: [shot], roots: [session], artifact: "m", version: 1, store });
    expect(marked.copies.get(shot)).toBe(join(marked.dir!, "shot.png"));
    expect(readdirSync(marked.dir!)).toEqual(["shot.png"]);
  });

  test("over the cap nothing is copied, and the reason says it was filed where it is and what that risks", async () => {
    const { temp, store, session, put } = world();
    const pack = join(temp, "huge");
    for (let n = 0; n <= STORE_MAX_FILES; n += 1) put(join(pack, `${n}.txt`));
    const stored = await storeTempDeliverable({ link: pack, folder: true, markImages: [], roots: [session], artifact: "h", version: 1, store });
    expect(stored.copies.size).toBe(0);
    expect(stored.dir).toBeUndefined();
    expect(stored.notCopied).toBe(`it was filed where it is, not copied into conch: ${pack.replace(/^\/var\//, "/private/var/")} holds more than 500 files or 64 MB, over what conch copies;`
      + " a temp folder can be cleaned (a reboot empties /tmp), and it goes with it");
    expect(existsSync(join(store, "h"))).toBe(false);
  });
});

describe("reading a copy back", () => {
  test("the publish rule lets conch's own store through, so the phone and a snapshot read a copy as any filed file", async () => {
    const { temp, store, session, put } = world();
    expect(store).toBe(join(temp, "home", "Library", "Application Support", "conch", "deliverables"));
    const shot = put(join(temp, "x", "hero.png"));
    const copy = (await storeTempDeliverable({ link: shot, folder: false, markImages: [], roots: [session], artifact: "a", version: 1, store })).copies.get(shot)!;
    rmSync(shot);
    // Its own folders and the temp folders left out of it: the store alone lets it through.
    const saved = process.env.CONCH_USER_TEMP_DIR;
    process.env.CONCH_USER_TEMP_DIR = join(temp, "not-temp");
    try {
      expect(await checkLocalFile(copy, [session])).toEqual({ ok: true, real: expect.stringContaining("/Library/Application Support/conch/deliverables/a/v1-") });
    } finally {
      process.env.CONCH_USER_TEMP_DIR = saved;
    }
  });

  test("and nothing else there by grace of it: never hidden, never executable, never a symlink out", async () => {
    const { store, session, put } = world();
    const version = join(store, "a", "v1-x");
    put(join(version, ".hidden.png"));
    put(join(version, "run.sh"));
    chmodSync(join(version, "run.sh"), 0o755);
    // A file outside every allowed folder: this checkout's own package.json.
    symlinkSync(join(import.meta.dir, "..", "package.json"), join(version, "out.json"));
    for (const refused of [".hidden.png", "run.sh", "out.json", "missing.png"]) {
      expect((await checkLocalFile(join(version, refused), [session])).ok, refused).toBe(false);
    }
  });

  test("only the store's two folders, never the rest of conch's folder: whatever comes to live beside them stays put", async () => {
    const { temp, store, session, put } = world();
    const root = dirname(store);
    const saved = process.env.CONCH_USER_TEMP_DIR;
    process.env.CONCH_USER_TEMP_DIR = join(temp, "not-temp");
    try {
      expect((await checkLocalFile(put(join(root, "captures", "page.png")), [session])).ok).toBe(true);
      expect((await checkLocalFile(put(join(root, "deliverables", "a", "v1-x", "hero.png")), [session])).ok).toBe(true);
      for (const beside of [join(root, "settings.png"), join(root, "pairing", "phone.png")]) {
        expect((await checkLocalFile(put(beside), [session])).ok, beside).toBe(false);
      }
    } finally {
      process.env.CONCH_USER_TEMP_DIR = saved;
    }
  });

  test("the phone's /file serves a held copy after its original is gone, and nothing else in the store", async () => {
    const { temp, store, session, put } = world();
    const shot = put(join(temp, "x", "hero.png"));
    const copy = (await storeTempDeliverable({ link: shot, folder: false, markImages: [], roots: [session], artifact: "a", version: 1, store })).copies.get(shot)!;
    const stray = put(join(dirname(copy), "stray.png"));
    rmSync(join(temp, "x"), { recursive: true });
    const token = "t".repeat(32);
    const phone = createPhoneBridgeApplication({
      getState: () => ({ v: 1, rows: [{ id: "s", cwd: session, review: { link: copy } }] }),
      forwardControl: async () => "", replyFor: async () => "", acceptUpload: async () => ({ received: 1, total: 1 }), log: () => {},
    } as never, { token });
    const status = async (path: string) => ((await phone.handle(new Request(`https://relay.invalid/file?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${token}` },
    }))) as Response).status;
    expect(await status(copy)).toBe(200);
    expect(await status(stray)).toBe(403);
    // Gone from the store too (removed, say), it is "gone", as any filed file is.
    rmSync(copy);
    expect(await status(copy)).toBe(404);
  });
});

describe("a copy lives exactly as long as a held deliverable names it", () => {
  const filing = (sessionId: string, link: string, at: number, extra: Partial<SessionReview> = {}) =>
    ({ ...fileReview(sessionId, { summary: `filed ${at}`, link }, at, undefined), ...extra });

  test("removed, pushed out by the six-deliverable cap, or its session forgotten, the next save deletes it", async () => {
    const { temp, store, session, put } = world();
    const ledger = new SessionLedger(undefined, undefined, join(temp, "previews"), store);
    const copies: string[] = [];
    for (let n = 0; n < 8; n += 1) {
      const shot = put(join(temp, `s${n}`, "hero.png"));
      copies.push((await storeTempDeliverable({ link: shot, folder: false, markImages: [], roots: [session], artifact: `art${n}`, version: 1, store })).copies.get(shot)!);
    }
    const held = copies.slice(0, 6).map((link, n) => filing("s1", link, 1_000 + n));
    ledger.sessionStates.set("s1", { label: "a", status: "waiting", at: 0, review: held.at(-1)!, reviews: held });
    ledger.sessionStates.set("s2", { label: "b", status: "waiting", at: 0, review: filing("s2", copies[6]!, 2_000) });
    ledger.saveReviews();
    expect(copies.slice(0, 7).every(existsSync)).toBe(true);

    // review_remove of one filing: its copy goes, and only its copy.
    expect(ledger.removeDeliverables("s1", { review: held[2]!.id })).toBe(true);
    expect(existsSync(dirname(copies[2]!))).toBe(false);
    expect(existsSync(join(store, "art2"))).toBe(false);
    expect([0, 1, 3, 4, 5, 6].every((n) => existsSync(copies[n]!))).toBe(true);

    // The cap: a seventh filing pushes the oldest out of what the session holds, and its copy with it.
    const state = ledger.sessionStates.get("s1")!;
    const seventh = filing("s1", copies[7]!, 3_000);
    const held5 = state.reviews!.length;
    expect(held5).toBe(5);
    // Six held, then one more: `carriedReviews` drops the oldest, as the daemon's filing does.
    const sixth = filing("s1", copies[2]!, 2_500);
    const capped = carriedReviews(carriedReviews(state.reviews, sixth), seventh)!;
    expect(capped.map((one) => one.link)).not.toContain(copies[0]);
    ledger.sessionStates.set("s1", { ...state, review: seventh, reviews: capped });
    ledger.saveReviews();
    expect(existsSync(copies[0]!)).toBe(false);
    expect(existsSync(copies[7]!)).toBe(true);

    // Its session gone: every copy it held goes; another session's stays.
    ledger.forget("s1");
    expect([1, 3, 4, 5, 7].some((n) => existsSync(copies[n]!))).toBe(false);
    expect(existsSync(copies[6]!)).toBe(true);
  });

  test("at daemon start, a copy nothing restored names is swept, and what is held, with its marks' images, stays", async () => {
    const { temp, store, put } = world();
    const reviewsPath = join(temp, "reviews.json");
    const link = put(join(store, "aaaa", "v1-held", "hero.png"));
    const ink = put(join(store, "bbbb", "v1-ink", "still.png"));
    const orphan = put(join(store, "cccc", "v2-orphan", "lost.png"));
    const before = new SessionLedger(reviewsPath, undefined, join(temp, "previews"), store);
    const review = filing("s1", link, 1_000, {
      scene: { v: 1, target: { kind: "auto" }, marks: [{ id: "m", kind: "pin", frame: { image: ink }, at: [0.5, 0.5] }] },
    });
    before.sessionStates.set("s1", { label: "a", status: "waiting", at: 0, review, reviews: [review] });
    before.saveReviews();

    const after = new SessionLedger(reviewsPath, undefined, join(temp, "previews"), store);
    after.restoreReviews();
    expect(after.sweepStoredCopies()).toEqual([dirname(orphan)]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(store, "cccc"))).toBe(false);
    expect(existsSync(link) && existsSync(ink)).toBe(true);
  });

  test("only ever inside the store: a path anywhere else is never deleted, whatever a record says", () => {
    const { temp, store, put } = world();
    const precious = put(join(temp, "work", "v1-x", "keep.png"));
    expect(storeEntry(precious, store)).toBeNull();
    expect(storeEntry(join(store, "a", "v1-x", "f.png"), store)).toBe(join(store, "a", "v1-x"));
    expect(storeEntry(join(store, "a", "f.png"), store)).toBeNull();
    expect(storeEntry(join(store, "..", "x", "y", "z"), store)).toBeNull();
    discardStoredCopy(dirname(precious), store);
    discardStoredCopy(store, store);
    expect(existsSync(precious)).toBe(true);
    expect(sweepStore(new Set(), join(temp, "no-store"))).toEqual([]);
  });

  test("the store is deliverables in conch's own store, never a hidden folder the publish rule refuses", () => {
    expect(deliverableStoreDir("/Users/someone")).toBe("/Users/someone/Library/Application Support/conch/deliverables");
    expect(deliverableStoreDir().split("/").some((part) => part.startsWith("."))).toBe(false);
  });
});

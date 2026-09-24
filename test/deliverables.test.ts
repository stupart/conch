import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactIdentity,
  artifactKey,
  deliverableFacts,
  deliverableKindRefusal,
  inferDeliverableKind,
  type DeliverableKind,
} from "../src/deliverables.ts";
import {
  buildPanelModel,
  buildPublishedState,
  carriedReviews,
  fileReview,
  MAX_SESSION_REVIEWS,
  removeReviews,
  type SessionReview,
} from "../src/panel.ts";
import { reviewIdentity } from "../src/records-receipts.ts";
import { SessionLedger } from "../src/session-ledger.ts";

describe("what kind of thing a deliverable is", () => {
  test("a link says its kind when the agent does not", () => {
    const table: Array<[string | undefined, DeliverableKind]> = [
      ["/tmp/hero.png", "image"],
      ["/tmp/HERO.JPEG", "image"],
      ["/tmp/icon.svg", "image"],
      ["/work/site/index.html", "page"],
      ["/work/site/old.htm", "page"],
      ["/tmp/demo.mov", "video"],
      ["/tmp/demo.mp4", "video"],
      ["/tmp/voice.m4a", "audio"],
      ["/tmp/voice.wav", "audio"],
      ["/work/spec.pdf", "pdf"],
      ["/work/docs/plan.md", "markdown"],
      ["/tmp/build.log", "text"],
      ["/work/data.json", "text"],
      ["/work/change.diff", "text"],
      ["/work/pitch.pages", "document"],
      ["/work/pitch.docx", "document"],
      ["/work/deck.pptx", "document"],
      ["/work/screens.fig", "design"],
      ["/tmp/archive.zip", "other"],
      ["/tmp/no-extension", "other"],
      ["http://localhost:3000/pricing", "url"],
      ["https://example.com/report.pdf", "url"],
      ["https://www.figma.com/design/abc/Onboarding?node-id=1-2", "design"],
      ["https://figma.com/file/abc", "design"],
      ["https://notfigma.com/file/abc", "url"],
      [undefined, "other"],
    ];
    for (const [link, kind] of table) expect(inferDeliverableKind(link), String(link)).toBe(kind);
  });

  test("the agent's kind wins and says so; otherwise it is inferred and says that", () => {
    expect(deliverableFacts({ summary: "the onboarding flow", kind: "simulator" }))
      .toMatchObject({ kind: "simulator", kindSource: "agent" });
    expect(deliverableFacts({ summary: "hero", link: "/tmp/hero.png" }))
      .toMatchObject({ kind: "image", kindSource: "inferred" });
    expect(deliverableFacts({ summary: "an explanation" })).toMatchObject({ kind: "other", kindSource: "inferred" });
  });

  test("only things on screen may go without a link", () => {
    for (const kind of ["app", "simulator", "terminal", "design", "other"] as const) {
      expect(deliverableKindRefusal(kind, false), kind).toBeNull();
    }
    for (const kind of ["page", "image", "video", "audio", "pdf", "markdown", "text", "url", "document"] as const) {
      expect(deliverableKindRefusal(kind, false), kind).toContain(`kind "${kind}" needs a link`);
      expect(deliverableKindRefusal(kind, true), kind).toBeNull();
    }
  });
});

describe("which artifact a filing is a version of", () => {
  test("a file is its real path, a URL is itself without its fragment, and no link is the summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-artifact-"));
    try {
      const file = join(dir, "hero.png");
      writeFileSync(file, "png");
      // tmpdir() is behind a symlink on macOS: the same file by either path is one artifact.
      expect(artifactKey(file, "s")).toBe(realpathSync(file));
      expect(artifactKey("http://localhost:3000/pricing#faq", "s")).toBe("http://localhost:3000/pricing");
      expect(artifactKey("http://localhost:3000/pricing?tab=2", "s")).toBe("http://localhost:3000/pricing?tab=2");
      expect(artifactKey(undefined, "the onboarding flow")).toBe("the onboarding flow");
      // A file that has gone since it was filed still names what it was.
      expect(artifactKey("/nowhere/gone.png", "s")).toBe("/nowhere/gone.png");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an agent's key names the artifact whatever the link, and the identity is short", () => {
    const one = deliverableFacts({ summary: "v1", link: "https://a.test/x", key: "pricing page" });
    const two = deliverableFacts({ summary: "v2", link: "https://b.test/y", key: "pricing page" });
    expect(one.artifact).toBe(two.artifact);
    expect(one.artifact).toBe(artifactIdentity("pricing page"));
    expect(one.artifact).toMatch(/^[0-9a-f]{16}$/);
    expect(deliverableFacts({ summary: "v1", link: "https://a.test/x#top" }).artifact)
      .toBe(deliverableFacts({ summary: "v2", link: "https://a.test/x#bottom" }).artifact);
  });
});

describe("filing, versions and the cap", () => {
  const file = (held: SessionReview[] | undefined, review: Parameters<typeof fileReview>[1], at: number) => {
    const filed = fileReview("s1", review, at, held);
    return { filed, held: carriedReviews(held, filed)! };
  };

  test("every filing keeps its own id; republishing an artifact adds its next version", () => {
    let held: SessionReview[] | undefined;
    const ids: string[] = [];
    for (const [at, summary] of [[1_000, "v1"], [2_000, "v2"], [3_000, "v3"]] as const) {
      const { filed, held: next } = file(held, { summary, link: "https://x.test/page#top" }, at);
      held = next;
      ids.push(filed.id);
      expect(filed.id).toBe(reviewIdentity("s1", { summary, link: "https://x.test/page#top", at }));
    }
    expect(new Set(ids).size).toBe(3);
    expect(held!.map((one) => one.version)).toEqual([1, 2, 3]);
    expect(new Set(held!.map((one) => one.artifact)).size).toBe(1);
    expect(held![2]).toMatchObject({ kind: "url", kindSource: "inferred" });

    // Another artifact starts its own count.
    const other = file(held, { summary: "sim", kind: "simulator", key: "onboarding" }, 4_000);
    expect(other.filed).toMatchObject({ version: 1, kind: "simulator", kindSource: "agent", artifact: artifactIdentity("onboarding") });
    // What the filing is is recorded; the agent's key is not carried, only the artifact it names.
    expect(other.filed).not.toHaveProperty("key");
  });

  test("the same filing arriving again keeps its version", () => {
    const first = file(undefined, { summary: "v1", link: "https://x.test/a" }, 1_000);
    const again = fileReview("s1", { summary: "v1", link: "https://x.test/a" }, 1_000, first.held);
    expect(again.version).toBe(1);
    expect(carriedReviews(first.held, again)).toHaveLength(1);
  });

  test("a version is one past the highest held, so a removed or dropped one never repeats a number", () => {
    const artifact = artifactIdentity("k");
    const held: SessionReview[] = [
      { summary: "v2", at: 2, id: "b", artifact, version: 2 },
      { summary: "v4", at: 4, id: "d", artifact, version: 4 },
    ];
    expect(fileReview("s1", { summary: "v5", key: "k" }, 5, held).version).toBe(5);
  });

  test("the cap drops superseded versions before it drops another artifact", () => {
    // Four artifacts, one republished three times: seven filings, one over the cap. The oldest
    // filing of all (b1) is the only version of its artifact.
    const filings: Array<[string, string]> = [
      ["b1", "https://x.test/b"], ["a1", "https://x.test/a"], ["a2", "https://x.test/a"],
      ["c1", "https://x.test/c"], ["a3", "https://x.test/a"], ["d1", "https://x.test/d"],
      ["a4", "https://x.test/a"],
    ];
    let held: SessionReview[] | undefined;
    filings.forEach(([summary, link], index) => {
      held = file(held, { summary, link }, (index + 1) * 1_000).held;
    });
    expect(held).toHaveLength(MAX_SESSION_REVIEWS);
    // The oldest SUPERSEDED filing (a1) went, not b1, the oldest filing of all.
    expect(held!.map((one) => one.summary)).toEqual(["b1", "a2", "c1", "a3", "d1", "a4"]);

    // With nothing superseded, the oldest goes, as it always did.
    let distinct: SessionReview[] | undefined;
    for (let i = 0; i < MAX_SESSION_REVIEWS + 1; i++) {
      distinct = file(distinct, { summary: `r${i}`, link: `https://x.test/${i}` }, i + 1).held;
    }
    expect(distinct!.map((one) => one.summary)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6"]);
  });
});

describe("removing a deliverable", () => {
  const held: SessionReview[] = [
    { summary: "a1", at: 1, id: "a-1", artifact: "a", version: 1 },
    { summary: "b1", at: 2, id: "b-1", artifact: "b", version: 1 },
    { summary: "a2", at: 3, id: "a-2", artifact: "a", version: 2 },
  ];

  test("by id removes that one filing", () => {
    expect(removeReviews(held, { review: "a-2" })?.map((one) => one.id)).toEqual(["a-1", "b-1"]);
  });

  test("by artifact removes every filing of it", () => {
    expect(removeReviews(held, { artifact: "a" })?.map((one) => one.id)).toEqual(["b-1"]);
    expect(removeReviews(held, { artifact: "b" })?.map((one) => one.id)).toEqual(["a-1", "a-2"]);
  });

  test("the last one leaves nothing, and something the session does not hold changes nothing", () => {
    expect(removeReviews([held[1]!], { review: "b-1" })).toEqual([]);
    expect(removeReviews(held, { review: "somebody-else" })).toBeUndefined();
    expect(removeReviews(held, { artifact: "z" })).toBeUndefined();
    expect(removeReviews(undefined, { review: "a-1" })).toBeUndefined();
  });

  test("the session's newest remaining one becomes its deliverable, and the removal is written out", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-deliverables-remove-"));
    try {
      const path = join(dir, "reviews.json");
      const ledger = new SessionLedger(path);
      ledger.sessionStates.set("s1", { label: "s1", status: "waiting", at: 3, review: held[2]!, reviews: held });
      const restored = () => {
        const after = new SessionLedger(path);
        after.restoreReviews();
        return after.sessionStates.get("s1");
      };

      expect(ledger.removeDeliverables("s1", { review: "a-2" })).toBe(true);
      expect(ledger.sessionStates.get("s1")).toMatchObject({ status: "waiting", review: { id: "b-1" } });
      expect(restored()?.reviews?.map((one) => one.id)).toEqual(["a-1", "b-1"]);

      // Nothing matched: nothing changes, on disk or off.
      expect(ledger.removeDeliverables("s1", { review: "a-2" })).toBe(false);
      expect(ledger.removeDeliverables("nobody", { artifact: "a" })).toBe(false);

      expect(ledger.removeDeliverables("s1", { artifact: "a" })).toBe(true);
      expect(ledger.removeDeliverables("s1", { artifact: "b" })).toBe(true);
      // None left: the row keeps its status and loses the deliverable, and a restart does not bring it back.
      expect(ledger.sessionStates.get("s1")).toEqual({ label: "s1", status: "waiting", at: 3 });
      expect(restored()).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a filing from before artifacts existed is removed by its link, as the apps group it", () => {
    const legacy: SessionReview[] = [{ summary: "old", link: "https://x.test/old", at: 1, id: "old-1" }];
    expect(removeReviews(legacy, { artifact: "https://x.test/old" })).toEqual([]);
  });
});

describe("a deliverable's type, artifact and version reach every surface", () => {
  const held = (): SessionReview[] => {
    const one = fileReview("s1", { summary: "v1", link: "https://x.test/p" }, 1_000, undefined);
    const two = fileReview("s1", { summary: "v2", link: "https://x.test/p" }, 2_000, [one]);
    return [one, two];
  };

  test("they survive a daemon restart, and kindSource with them", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-deliverables-ledger-"));
    try {
      const path = join(dir, "reviews.json");
      // Nothing here could be derived again: an agent's kind and key, and a version past a removal.
      const reviews: SessionReview[] = [
        { summary: "the sim", at: 1_000, id: "s-1", kind: "simulator", kindSource: "agent", artifact: artifactIdentity("onboarding"), version: 1 },
        { summary: "page", link: "https://x.test/p", at: 2_000, id: "p-3", kind: "url", kindSource: "inferred", artifact: artifactIdentity("https://x.test/p"), version: 3 },
      ];
      const ledger = new SessionLedger(path);
      ledger.sessionStates.set("s1", { label: "s1", status: "waiting", at: 2_000, review: reviews[1]!, reviews });
      ledger.saveReviews();
      const after = new SessionLedger(path);
      after.restoreReviews();
      expect(after.sessionStates.get("s1")?.reviews).toEqual(reviews);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file from before them restores with them derived, versions in filing order", () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-deliverables-legacy-"));
    try {
      const path = join(dir, "reviews.json");
      writeFileSync(path, JSON.stringify({
        s1: {
          label: "s1",
          review: { summary: "v2", link: "https://x.test/p", at: 2_000, id: "p-2" },
          reviews: [
            { summary: "v1", link: "https://x.test/p", at: 1_000, id: "p-1" },
            { summary: "note", at: 1_500, id: "n-1" },
            { summary: "v2", link: "https://x.test/p", at: 2_000, id: "p-2" },
          ],
        },
      }));
      const ledger = new SessionLedger(path);
      ledger.restoreReviews();
      const restored = ledger.sessionStates.get("s1")?.reviews ?? [];
      const page = artifactIdentity("https://x.test/p");
      expect(restored.map(({ id, artifact, version, kind, kindSource }) => ({ id, artifact, version, kind, kindSource }))).toEqual([
        { id: "p-1", artifact: page, version: 1, kind: "url", kindSource: "inferred" },
        { id: "n-1", artifact: artifactIdentity("note"), version: 1, kind: "other", kindSource: "inferred" },
        { id: "p-2", artifact: page, version: 2, kind: "url", kindSource: "inferred" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("they are published on the row, for the newest and for every held one", () => {
    const reviews = held();
    const model = buildPanelModel({
      sessions: [{ sessionId: "s1", name: "s1", status: "idle", statusUpdatedAt: 10 }],
      sessionStates: new Map([["s1", { label: "s1", status: "waiting" as const, at: 2_000, review: reviews[1]!, reviews }]]),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      now: 2_000,
    });
    const published = buildPublishedState("device", model, new Map(), new Set(), 2_000);
    const row = published.rows[0]!;
    const artifact = artifactIdentity("https://x.test/p");
    expect(row.review).toMatchObject({ id: reviews[1]!.id, artifact, version: 2, kind: "url" });
    expect(row.reviews?.map(({ artifact: a, version, kind }) => ({ a, version, kind }))).toEqual([
      { a: artifact, version: 1, kind: "url" },
      { a: artifact, version: 2, kind: "url" },
    ]);
    // Only what a reader needs goes on the wire; how the kind was decided stays in the ledger.
    expect(row.review).not.toHaveProperty("kindSource");
    // An app can tell a daemon that types its deliverables from one that does not.
    expect(published.features).toEqual({ deliverables: 3, viewedState: 1 });
  });
});

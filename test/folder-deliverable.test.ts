import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { validateSocketTurnEvent } from "../src/control-server.ts";
import {
  artifactIdentity,
  checkFocusShape,
  deliverableFacts,
  FOCUS_MAX,
  FOCUS_MAX_BYTES,
  FOCUS_PATH_MAX,
  folderRefusal,
  inferDeliverableKind,
  isPackagePath,
} from "../src/deliverables.ts";
import { buildPanelModel, buildPublishedState, carriedReviews, fileReview, type SessionReview } from "../src/panel.ts";
import { SessionLedger } from "../src/session-ledger.ts";
import { checkLocalFolder, checkReviewLink, resolveReviewFocus } from "../src/snippet.ts";

/**
 * A deliverable that is a folder: its tree, in conch's panel and window, with the paths the agent points at
 * (`focus`). Tyler: "allow review deliverables to use the file tree tool to show files / folder structure in the
 * panel". The folder and its focus are all that is published; the apps list the folder themselves, on the Mac.
 */
function withTree(run: (root: string, outside: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    // Under the temp root, which the link rule allows, and behind macOS's /var -> /private/var symlink.
    const base = mkdtempSync(join(tmpdir(), "conch-folder-deliverable-"));
    const root = join(base, "module");
    const outside = join(base, "elsewhere");
    try {
      mkdirSync(join(root, "src", "parts"), { recursive: true });
      mkdirSync(join(root, "test"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(root, "src", "setup.ts"), "export {};\n");
      writeFileSync(join(root, "src", "parts", "a.ts"), "export {};\n");
      writeFileSync(join(root, "test", "setup.test.ts"), "test\n");
      writeFileSync(join(root, "README.md"), "# module\n");
      writeFileSync(join(outside, "secret.txt"), "not in the folder\n");
      await run(root, outside);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };
}

describe("a folder is a deliverable of its own kind", () => {
  test("a directory link is inferred as folder; a package keeps its extension's kind", withTree((root) => {
    expect(inferDeliverableKind(root)).toBe("folder");
    expect(inferDeliverableKind(join(root, "src"))).toBe("folder");
    expect(inferDeliverableKind(join(root, "README.md"))).toBe("markdown");
    // A path that isn't there has no folder to be: as before, other.
    expect(inferDeliverableKind(join(root, "gone"))).toBe("other");
    // A relative path is never stat'd against whatever this process's cwd happens to be.
    expect(inferDeliverableKind("src")).toBe("other");
    // A document saved as a package is a directory on the disk, and still a document.
    mkdirSync(join(root, "pitch.pages"));
    expect(inferDeliverableKind(join(root, "pitch.pages"))).toBe("document");
    expect(deliverableFacts({ summary: "the module", link: root })).toMatchObject({ kind: "folder", kindSource: "inferred" });
    expect(deliverableFacts({ summary: "the module", link: root, kind: "folder" })).toMatchObject({ kind: "folder", kindSource: "agent" });
  }));

  test("packages are refused as folders: an app launches when opened where it lives", () => {
    for (const path of ["/x/Foo.app", "/x/Deck.key", "/x/pitch.pages", "/x/My.xcodeproj", "/x/Thing.bundle", "/x/notes.rtfd"]) {
      expect(isPackagePath(path), path).toBe(true);
    }
    for (const path of ["/x/src", "/x/v1.2", "/x/my.project", "/x/.worktrees/task"]) {
      expect(isPackagePath(path), path).toBe(false);
    }
  });

  test("kind, link and focus must agree about a folder", () => {
    expect(folderRefusal({ isFolder: true, hasFocus: true })).toBeNull();
    expect(folderRefusal({ kind: "folder", isFolder: true, hasFocus: false })).toBeNull();
    expect(folderRefusal({ kind: "image", isFolder: false, hasFocus: false })).toBeNull();
    expect(folderRefusal({ kind: "image", isFolder: true, hasFocus: false })).toContain('which is kind "folder"');
    expect(folderRefusal({ kind: "folder", isFolder: false, hasFocus: false })).toContain('kind "folder" needs a link to an existing folder');
    expect(folderRefusal({ isFolder: false, hasFocus: true })).toContain("focus is for a folder deliverable");
  });
});

describe("the folder passes the rule a linked file does", () => {
  test("a folder under the session's folder or the temp folder is published, absolute", withTree(async (root) => {
    expect(await checkReviewLink(root, "/no/such/cwd")).toEqual({ ok: true, link: root, folder: true });
    // Relative to the session's folder, like a file.
    expect(await checkReviewLink("src", root)).toEqual({ ok: true, link: join(root, "src"), folder: true });
    // The session's own folder may be published whole.
    expect(await checkLocalFolder(root, [root])).toEqual({ ok: true, real: realpathSync(root) });
    // A file is still a file.
    expect(await checkReviewLink(join(root, "README.md"), root)).toEqual({ ok: true, link: join(root, "README.md") });
  }));

  test("missing, outside, hidden, a package or the home folder is refused", withTree(async (root) => {
    const refusal = async (path: string, roots: string[]) => {
      const checked = await checkLocalFolder(path, roots);
      expect(checked.ok, path).toBe(false);
      return checked.ok ? "" : checked.reason;
    };
    expect(await refusal(join(root, "gone"), [root])).toContain("is not a folder that exists");
    // A file is not a folder.
    expect(await refusal(join(root, "README.md"), [root])).toContain("is not a folder that exists");
    // Outside the session's folders and the temp folder: this repo, from a session in the temp folder.
    expect(await refusal(join(import.meta.dir, "..", "src"), [root])).toContain("outside this session's folder");
    mkdirSync(join(root, ".secrets"));
    expect(await refusal(join(root, ".secrets"), [root])).toContain("hidden folder");
    mkdirSync(join(root, "Tool.app"));
    expect(await refusal(join(root, "Tool.app"), [root])).toContain("is a package");
    // The home folder, even when the session started in it: the Files tab hides that tree too.
    expect(await refusal(homedir(), [homedir()])).toContain("is the home folder");
    // A repo's worktrees live in a hidden folder, and are work.
    mkdirSync(join(root, ".worktrees", "task"), { recursive: true });
    expect((await checkLocalFolder(join(root, ".worktrees", "task"), [root])).ok).toBe(true);
  }));

  test("a symlink is judged by where it leads, not what it is called", withTree(async (root, outside) => {
    // Named inside the session's folder, leading out of it and out of the temp root: refused.
    const session = realpathSync(root);
    symlinkSync(join(import.meta.dir, "..", "src"), join(root, "looks-local"));
    const checked = await checkLocalFolder(join(root, "looks-local"), [session]);
    expect(checked).toMatchObject({ ok: false, reason: expect.stringContaining("outside this session's folder") });
    expect(outside).toBeTruthy();
  }));
});

describe("focus: paths inside the folder, checked on the disk", () => {
  test("relative or absolute inside, normalized to relative POSIX paths", withTree(async (root) => {
    const real = realpathSync(root);
    expect(await resolveReviewFocus(root, ["src/setup.ts", "test/", "./README.md"]))
      .toEqual({ ok: true, focus: ["src/setup.ts", "test", "README.md"] });
    // Absolute, by the path it was published at or its real one.
    expect(await resolveReviewFocus(root, [join(root, "src", "parts"), join(real, "src", "parts", "a.ts")]))
      .toEqual({ ok: true, focus: ["src/parts", "src/parts/a.ts"] });
    // The same place twice is one.
    expect(await resolveReviewFocus(root, ["src/setup.ts", join(root, "src/setup.ts")]))
      .toEqual({ ok: true, focus: ["src/setup.ts"] });
  }));

  test("a .. part, a symlink out, a missing path or the folder itself is refused", withTree(async (root, outside) => {
    const refused = async (focus: unknown) => {
      const checked = await resolveReviewFocus(root, focus);
      expect(checked.ok, JSON.stringify(focus)).toBe(false);
      return checked.ok ? "" : checked.reason;
    };
    // Even one that walks out and back in.
    expect(await refused(["src/../README.md"])).toContain("focus[0] src/../README.md has a .. part");
    expect(await refused(["../elsewhere/secret.txt"])).toContain("has a .. part");
    expect(await refused([join(outside, "secret.txt")])).toContain("outside the folder");
    symlinkSync(join(outside, "secret.txt"), join(root, "src", "link.txt"));
    expect(await refused(["README.md", "src/link.txt"])).toContain("focus[1] src/link.txt is outside the folder");
    symlinkSync(outside, join(root, "out"));
    expect(await refused(["out/secret.txt"])).toContain("outside the folder");
    expect(await refused(["src/nope.ts"])).toContain("focus[0] src/nope.ts is not in the folder");
    expect(await refused(["."])).toContain("the folder itself");
    expect(await refused([root])).toContain("the folder itself");
    expect(await refused([])).toContain(`must be 1 to ${FOCUS_MAX} paths`);
    expect(await refused("src")).toContain(`must be 1 to ${FOCUS_MAX} paths`);
    expect(await refused([""])).toContain("focus[0] must be a non-empty path");
    expect(await refused([42])).toContain("focus[0] must be a non-empty path");
  }));

  test("focus needs the folder to be there", async () => {
    expect(await resolveReviewFocus("/no/such/folder", ["a.ts"]))
      .toMatchObject({ ok: false, reason: expect.stringContaining("needs the folder /no/such/folder to exist") });
  });

  test("the size caps: count, each path, and bytes in all", withTree(async (root) => {
    for (let index = 0; index < FOCUS_MAX + 1; index++) writeFileSync(join(root, `f${index}.ts`), "");
    const many = Array.from({ length: FOCUS_MAX + 1 }, (_, index) => `f${index}.ts`);
    expect(await resolveReviewFocus(root, many.slice(0, FOCUS_MAX))).toMatchObject({ ok: true });
    expect(await resolveReviewFocus(root, many)).toMatchObject({ ok: false, reason: expect.stringContaining(`1 to ${FOCUS_MAX}`) });

    const deep = join(root, "d".repeat(100), "e".repeat(100));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "long.ts"), "");
    expect(await resolveReviewFocus(root, [join("d".repeat(100), "e".repeat(100), "long.ts")]))
      .toMatchObject({ ok: false, reason: expect.stringContaining(`at most ${FOCUS_PATH_MAX}`) });

    // Twelve paths of ninety characters each: under the per-path cap, over the total.
    const names = Array.from({ length: FOCUS_MAX }, (_, index) => `${String(index).padStart(2, "0")}${"n".repeat(88)}`);
    for (const name of names) writeFileSync(join(root, name), "");
    expect(await resolveReviewFocus(root, names))
      .toMatchObject({ ok: false, reason: expect.stringContaining(`at most ${FOCUS_MAX_BYTES} in all`) });
  }));

  test("the shape a published, sent or saved focus must have", () => {
    expect(checkFocusShape(["src/setup.ts", "test"])).toEqual({ ok: true, focus: ["src/setup.ts", "test"] });
    for (const bad of [[], "src", ["/etc/hosts"], ["a/../b"], ["./a"], ["a//b"], ["a/"], ["a\\b"], ["a\u0000"], ["a", "a"], [7]]) {
      expect(checkFocusShape(bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(checkFocusShape(["x".repeat(FOCUS_PATH_MAX)]).ok).toBe(true);
    expect(checkFocusShape(["x".repeat(FOCUS_PATH_MAX + 1)]).ok).toBe(false);
  });
});

describe("filed, versioned and published small", () => {
  test("the same folder again is its next version; the focus rides each filing", withTree((root) => {
    const first = fileReview("s1", { summary: "the new layout", link: root, focus: ["src"] }, 1_000, undefined);
    const held = carriedReviews(undefined, first);
    const second = fileReview("s1", { summary: "the layout, with tests", link: `${root}/`, focus: ["src", "test"] }, 2_000, held);
    expect(first).toMatchObject({ kind: "folder", kindSource: "inferred", version: 1, focus: ["src"] });
    // Its real path is the artifact, so the trailing slash, or /var for /private/var, is the same folder.
    expect(second.artifact).toBe(first.artifact);
    expect(first.artifact).toBe(artifactIdentity(realpathSync(root)));
    expect(second).toMatchObject({ version: 2, focus: ["src", "test"] });
    // A key names it too, as for any deliverable.
    const keyed = fileReview("s1", { summary: "elsewhere", link: join(root, "src"), key: "layout" }, 3_000, carriedReviews(held, second));
    expect(keyed.artifact).toBe(artifactIdentity("layout"));
    expect(keyed).not.toHaveProperty("focus");
  }));

  test("the published review carries the folder and its focus, never a listing", withTree((root) => {
    const filed: SessionReview = fileReview("s1", { summary: "the new layout", link: root, focus: ["src/setup.ts", "test"] }, 2_000, undefined);
    const model = buildPanelModel({
      sessions: [{ sessionId: "s1", name: "s1", status: "idle", statusUpdatedAt: 10 }],
      sessionStates: new Map([["s1", { label: "s1", status: "waiting" as const, at: 2_000, review: filed, reviews: [filed] }]]),
      pausedSessionIds: new Set(),
      live: { state: "idle", label: "", partial: "" },
      mode: { muted: false, paused: false, holding: 0 },
      activeSessionId: null,
      navSelectedId: null,
      now: 2_000,
    });
    const row = buildPublishedState("device", model, new Map(), new Set(), 2_000).rows[0]!;
    for (const review of [row.review, row.reviews?.[0]]) {
      expect(review).toEqual({
        summary: "the new layout",
        link: root,
        at: 2_000,
        id: filed.id,
        artifact: filed.artifact,
        version: 1,
        kind: "folder",
        focus: ["src/setup.ts", "test"],
      });
    }
    // Nothing the folder holds but what the agent named is on the wire.
    const wire = JSON.stringify(row);
    expect(wire).not.toContain("parts");
    expect(wire).not.toContain("README");
  }));

  test("a restart restores the focus, and drops one it can't read", withTree((root) => {
    const dir = mkdtempSync(join(tmpdir(), "conch-folder-ledger-"));
    try {
      const path = join(dir, "reviews.json");
      const filed = fileReview("s1", { summary: "the layout", link: root, focus: ["src", "test"] }, 2_000, undefined);
      const ledger = new SessionLedger(path);
      ledger.sessionStates.set("s1", { label: "s1", status: "waiting", at: 2_000, review: filed, reviews: [filed] });
      ledger.saveReviews();
      const after = new SessionLedger(path);
      after.restoreReviews();
      expect(after.sessionStates.get("s1")?.review).toMatchObject({ kind: "folder", focus: ["src", "test"], version: 1 });

      // A hand-edited file with an escaping focus: the deliverable stays, the focus goes.
      const saved = JSON.parse(readFileSync(path, "utf8"));
      saved.s1.review.focus = ["../../etc"];
      saved.s1.reviews[0].focus = ["../../etc"];
      writeFileSync(path, JSON.stringify(saved));
      const edited = new SessionLedger(path);
      edited.restoreReviews();
      expect(edited.sessionStates.get("s1")?.review).toMatchObject({ kind: "folder", link: root });
      expect(edited.sessionStates.get("s1")?.review).not.toHaveProperty("focus");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));
});

describe("the socket takes a focus only in the shape conch publishes", () => {
  const event = (review: Record<string, unknown>, type = "review-published") => ({
    type, sessionId: "s1", label: "alpha", announce: "alpha has work ready", review,
  });

  test("a well-formed focus on a publication with a link passes", () => {
    expect(validateSocketTurnEvent(event({ summary: "layout", link: "/tmp/x", focus: ["src", "test/a.ts"] })).ok).toBe(true);
  });

  test("an escaping, absolute, oversized or linkless focus is refused, and never on a turn end", () => {
    const err = (review: Record<string, unknown>, type?: string) => {
      const checked = validateSocketTurnEvent(event(review, type));
      expect(checked.ok, JSON.stringify(review)).toBe(false);
      return checked.ok ? "" : checked.err;
    };
    expect(err({ summary: "x", link: "/tmp/x", focus: ["../etc"] })).toContain("review focus[0] ../etc must name a path inside the folder");
    expect(err({ summary: "x", link: "/tmp/x", focus: ["/etc/hosts"] })).toContain("must be relative to the folder");
    expect(err({ summary: "x", link: "/tmp/x", focus: Array.from({ length: FOCUS_MAX + 1 }, (_, i) => `f${i}`) })).toContain("1 to 12");
    expect(err({ summary: "x", focus: ["src"] })).toContain("review focus needs a folder link");
    expect(err({ summary: "x", link: "/tmp/x", focus: ["src"] }, "turn-end")).toContain("only for review-published");
  });
});

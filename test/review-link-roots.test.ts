import { describeTempFolders } from "../src/temp-folders.ts";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAgentNote, saveAgentNote, takeAgentNote, userPromptContext } from "../src/agent-notes.ts";
import { AGENT_INSTRUCTIONS, renderAgentsMd, renderSkillMd } from "../src/agent-instructions.ts";
import { validateSocketTurnEvent } from "../src/control-server.ts";
import { hookSessionFolders, stopReview } from "../src/hook.ts";
import { repositoryRoots, reviewLinkScope, rootsHolding, transcriptFolder } from "../src/review-roots.ts";
import { checkReviewLink } from "../src/snippet.ts";

/**
 * A session's deliverable link may sit under any of its folders, not only the one it is in now
 * (review-roots.ts). On 2026-09-30 a session started in ~/Projects/Blueprint/Internal published
 * `conch:review … | …/Internal/review-2026-09-30` twice, then cd'd into
 * monorepo/.worktrees/<task>, and its next three had the link dropped without a word:
 * `parsed.link: null` at 06:46, 06:49 and 07:25 in /tmp/conch-hook.log.
 */

/**
 * A disk outside every temp folder. The temp folders are always allowed (`checkLocalFile`), so a
 * tree under this run's temp root proves nothing about a session's folders: TMPDIR points
 * elsewhere while it runs (`os.tmpdir()` reads it on every call), and the tree is built beside it.
 */
async function onDisk(run: (disk: string) => Promise<void> | void): Promise<void> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "conch-link-roots-")));
  const saved = { tmpdir: process.env.TMPDIR, userTemp: process.env.CONCH_USER_TEMP_DIR };
  mkdirSync(join(base, "temp"));
  process.env.TMPDIR = join(base, "temp");
  process.env.CONCH_USER_TEMP_DIR = join(base, "temp");
  try {
    const disk = join(base, "disk");
    mkdirSync(disk);
    expect(disk.startsWith(`${realpathSync("/tmp")}/`)).toBe(false);
    expect(disk.startsWith(`${realpathSync(tmpdir())}/`)).toBe(false);
    await run(disk);
  } finally {
    process.env.TMPDIR = saved.tmpdir;
    process.env.CONCH_USER_TEMP_DIR = saved.userTemp;
    rmSync(base, { recursive: true, force: true });
  }
}

/** The 2026-09-30 session's layout: a start folder holding a repository, and a worktree inside that. */
function incident(disk: string) {
  const put = (path: string, body = "x") => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  };
  const start = join(disk, "Internal");
  const monorepo = join(start, "monorepo");
  const worktree = join(monorepo, ".worktrees", "tools-auth-handoff");
  const pack = join(start, "review-2026-09-30");
  mkdirSync(join(monorepo, ".git", "worktrees", "tools-auth-handoff"), { recursive: true });
  put(join(worktree, ".git"), `gitdir: ${join(monorepo, ".git", "worktrees", "tools-auth-handoff")}\n`);
  put(join(worktree, "src", "app.ts"));
  put(join(pack, "emails.md"));
  put(join(monorepo, "docs", "plan.md"));
  const elsewhere = join(disk, "Elsewhere");
  put(join(elsewhere, "notes.md"));
  const outside = join(disk, "Outside");
  put(join(outside, "secret.md"));
  return { put, start, monorepo, worktree, pack, elsewhere, outside };
}

const line = (link: string) => `Done.\nconch:review The review pack | ${link}`;

describe("a link is checked against every folder the session is and has been in", () => {
  test("a link under the folder it started in is published while it works in a nested worktree", () => onDisk(async (disk) => {
    const { start, worktree, pack } = incident(disk);
    // The rule it used to be: only where the session is now. This is the drop the trace showed.
    const before = await checkReviewLink(pack, worktree);
    expect(before).toMatchObject({ ok: false, why: `it is outside this session's folder (${worktree}) and the temp folders` });

    const session = { sessionId: "e32bb468", cwd: start };
    const checked = await stopReview(line(pack), hookSessionFolders(worktree, session, "e32bb468", {}));
    expect(checked.review).toEqual({ summary: "The review pack", link: pack });
    expect(checked.refused).toBeUndefined();
    // Nested folders say nothing the start folder doesn't: the one root the trace records.
    expect(checked.scope).toEqual({ cwd: worktree, roots: [start] });

    // A line with no link has nothing to check.
    expect(await stopReview("Done.\nconch:review Nothing to open", { now: worktree })).toEqual({ review: { summary: "Nothing to open" } });
    expect(await stopReview("Done.", { now: worktree })).toEqual({ review: null });

    // A relative link still resolves against where the session is now.
    expect((await stopReview(line("src/app.ts"), hookSessionFolders(worktree, session, "e32bb468", {}))).review)
      .toEqual({ summary: "The review pack", link: join(worktree, "src", "app.ts") });
  }));

  test("the git repository around the current folder counts: a worktree's own checkout, and the one holding it", () => onDisk(async (disk) => {
    const { monorepo, worktree, elsewhere } = incident(disk);
    expect(repositoryRoots(join(worktree, "src"), join(disk, "home"))).toEqual([worktree, monorepo]);
    // Started somewhere else entirely: the repository it is working in is still its folder.
    const checked = await stopReview(line(join(monorepo, "docs", "plan.md")), { now: worktree, started: elsewhere });
    expect(checked.review?.link).toBe(join(monorepo, "docs", "plan.md"));
    expect(checked.scope?.roots).toEqual([elsewhere, monorepo]);
  }));

  test("a home folder kept in git is never a root, nor is / or the home folder for being where a session is", () => onDisk(async (disk) => {
    const home = join(disk, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(home, "project"), { recursive: true });
    expect(repositoryRoots(join(home, "project"), home)).toEqual([]);
    const { start, outside } = incident(disk);
    expect((await reviewLinkScope({ now: "/", started: start }, "/", home)).roots).toEqual([start]);
    expect((await reviewLinkScope({ now: home, started: start }, "/", home)).roots).toEqual([start]);
    expect((await reviewLinkScope({ now: disk, started: start }, "/", join(disk, "home"))).roots).toEqual([start]);
    // So a session that cd'd to / publishes nothing from there.
    const scope = await reviewLinkScope({ now: "/", started: start }, "/", home);
    expect((await checkReviewLink(join(outside, "secret.md"), scope.cwd, scope.roots)).ok).toBe(false);
  }));

  test("folders it declared with conch_working_folders count", () => onDisk(async (disk) => {
    const { start, worktree, elsewhere } = incident(disk);
    const session = { sessionId: "s@1", agentSessionId: "s", cwd: start };
    // By the window's id, then the id two windows share, then the hook's own.
    const declarations: Array<Record<string, string[]>> = [{ "s@1": [elsewhere] }, { s: [elsewhere] }, { hook: [elsewhere] }];
    for (const declared of declarations) {
      const folders = hookSessionFolders(worktree, session, "hook", declared);
      expect(folders.workDirs).toEqual([elsewhere]);
      expect((await stopReview(line(join(elsewhere, "notes.md")), folders)).review?.link).toBe(join(elsewhere, "notes.md"));
    }
  }));

  test("a link outside all of them is refused, and the refusal names the link, the folders, and what to do", () => onDisk(async (disk) => {
    const { worktree, elsewhere, monorepo, outside } = incident(disk);
    const link = join(outside, "secret.md");
    const checked = await stopReview(line(link), { now: worktree, started: elsewhere });
    const folders = `this session's folders (${elsewhere}, ${monorepo})`;
    // The summary is still filed; the link is not, and the review says why, for the Mac and the phone.
    expect(checked.review).toEqual({
      summary: "The review pack",
      linkRefused: `The link ${link} wasn't published: it is outside ${folders} and the temp folders.`,
    });
    // The trace and the agent's next prompt get the agent-facing reason, which names the temp folders: the same two in
    // every process, whatever its $TMPDIR (temp-folders.ts).
    const reason = `link ${link} is outside ${folders} and ${describeTempFolders()}, so it is not sent to the phone;`
      + " publish a copy under one of those folders or /tmp";
    expect(reason).toContain("the temp folders (/tmp, /");
    expect(checked.refused).toEqual({ link, reason, agentNote: `Your last conch:review link was not published: ${reason}.` });
    // A link that is not a file at all says which one it was, and the rule.
    const missing = await stopReview(line(join(elsewhere, "gone.md")), { now: worktree, started: elsewhere });
    expect(missing.review?.linkRefused).toBe(`The link ${join(elsewhere, "gone.md")} wasn't published: it does not exist.`);
    expect(missing.refused?.agentNote).toBe(
      `Your last conch:review link was not published: ${join(elsewhere, "gone.md")}: it does not exist;`
        + " link must be an http(s) URL or an existing, non-executable regular file.",
    );
  }));

  test("symlink escapes and sensitive paths are still refused under the wider folders", () => onDisk(async (disk) => {
    const { put, start, worktree, monorepo, outside } = incident(disk);
    const scope = await reviewLinkScope({ now: worktree, started: start });
    const check = (link: string) => checkReviewLink(link, scope.cwd, scope.roots);
    // Named inside the start folder, leading out of every root: judged by where it leads.
    symlinkSync(join(outside, "secret.md"), join(start, "looks-local.md"));
    symlinkSync(outside, join(start, "looks-local"));
    for (const link of [join(start, "looks-local.md"), join(start, "looks-local")]) {
      expect(await check(link)).toMatchObject({ ok: false, why: expect.stringContaining("is outside this session's folder") });
    }
    // Hidden, in a hidden folder, a key, or a symlink to one: refused inside the roots too.
    const hidden = [
      put(join(start, ".env")),
      put(join(start, ".ssh", "id_ed25519")),
      put(join(monorepo, ".git", "config")),
      put(join(worktree, "certs", "server.pem")),
    ];
    symlinkSync(join(start, ".ssh", "id_ed25519"), join(worktree, "notes.txt"));
    for (const link of [...hidden, join(worktree, "notes.txt")]) {
      expect(await check(link)).toMatchObject({ ok: false, why: "it is a hidden file, in a hidden folder, or a key or certificate" });
    }
    // An executable, and a hidden folder.
    const script = put(join(start, "run.sh"));
    chmodSync(script, 0o700);
    expect(await check(script)).toMatchObject({ ok: false, why: "it is an executable file" });
    mkdirSync(join(start, ".cache"));
    expect(await check(join(start, ".cache"))).toMatchObject({ ok: false, why: "it is a hidden folder, or in one" });
    // What is left is ordinary work: the review pack, a worktree's file.
    expect((await check(join(start, "review-2026-09-30"))).ok).toBe(true);
    expect((await check(join(worktree, "src", "app.ts"))).ok).toBe(true);
  }));
});

describe("the folders themselves", () => {
  test("where a session is now is the last folder its transcript records, Claude's or Codex's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "conch-transcript-folder-"));
    try {
      const claude = join(dir, "claude.jsonl");
      writeFileSync(claude, [
        JSON.stringify({ type: "user", cwd: "/work/start" }),
        JSON.stringify({ type: "assistant", cwd: "/work/start/monorepo/.worktrees/task", message: { content: "ran cd" } }),
        // A tool result quoting someone else's record is text, not this session's folder.
        JSON.stringify({ type: "user", toolUseResult: 'x {"cwd":"/elsewhere"} y' }),
        '{"type":"assistant","cwd":"/cut-off',
      ].join("\n"));
      expect(await transcriptFolder(claude)).toBe("/work/start/monorepo/.worktrees/task");
      const codex = join(dir, "rollout.jsonl");
      writeFileSync(codex, `${JSON.stringify({ type: "turn_context", payload: { cwd: "/work/codex" } })}\n`);
      expect(await transcriptFolder(codex)).toBe("/work/codex");
      expect(await transcriptFolder(join(dir, "gone.jsonl"))).toBeUndefined();
      expect(await transcriptFolder(undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a filing carries only the folders that hold its files beyond where the session started", () => onDisk(async (disk) => {
    const { start, worktree, elsewhere, pack } = incident(disk);
    const roots = [start, elsewhere];
    expect(await rootsHolding([pack], roots, start)).toEqual([]);
    expect(await rootsHolding([join(elsewhere, "notes.md"), pack], roots, start)).toEqual([elsewhere]);
    // Held only by a temp folder, or not there at all: nothing to carry.
    expect(await rootsHolding([join(disk, "..", "temp"), join(disk, "gone.md")], roots, start)).toEqual([]);
    expect(await rootsHolding([join(worktree, "src", "app.ts")], [worktree], elsewhere)).toEqual([worktree]);
  }));

  test("a folder that isn't there is left out, and so is one inside another", () => onDisk(async (disk) => {
    const { start, worktree, elsewhere } = incident(disk);
    const scope = await reviewLinkScope({ now: worktree, started: join(disk, "gone"), workDirs: [elsewhere, start, "relative/x"] });
    expect(scope).toEqual({ cwd: worktree, roots: [elsewhere, start] });
    // Nothing known: a relative link resolves against the fallback, and only temp folders pass.
    expect(await reviewLinkScope({}, "/fallback")).toEqual({ cwd: "/fallback", roots: [] });
  }));
});

describe("the agent hears about a refused link at its next prompt, once", () => {
  const withNotes = (run: (folder: string) => void) => () => {
    const folder = mkdtempSync(join(tmpdir(), "conch-agent-notes-"));
    try {
      run(join(folder, "agent-notes"));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  };

  test("a note is said once, to its own session", withNotes((folder) => {
    saveAgentNote("s1", "Your last conch:review link was not published: it does not exist.", folder);
    expect(takeAgentNote("s2", folder)).toBeNull();
    expect(takeAgentNote("s1", folder)).toBe("Your last conch:review link was not published: it does not exist.");
    expect(takeAgentNote("s1", folder)).toBeNull();
  }));

  test("a line whose link passed takes the note back, and a day-old note is dropped", withNotes((folder) => {
    saveAgentNote("s1", "old news", folder);
    clearAgentNote("s1", folder);
    expect(takeAgentNote("s1", folder)).toBeNull();
    saveAgentNote("s1", "stale", folder, 1_000);
    expect(takeAgentNote("s1", folder, 1_000 + 25 * 60 * 60 * 1000)).toBeNull();
    // Stale files of sessions that never prompted again go when the next note is written.
    saveAgentNote("gone", "never read", folder);
    const [file] = readdirSync(folder);
    utimesSync(join(folder, file!), new Date(0), new Date(0));
    saveAgentNote("s2", "fresh", folder);
    expect(readdirSync(folder)).toHaveLength(1);
  }));

  test("it reaches the agent as UserPromptSubmit context, which Claude Code adds to the turn", () => {
    const printed = userPromptContext("Your last conch:review link was not published: it does not exist.");
    expect(printed.endsWith("\n")).toBe(true);
    expect(JSON.parse(printed)).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "conch: Your last conch:review link was not published: it does not exist.",
      },
    });
  });

  test("the hook says it at UserPromptSubmit and leaves it at Stop", () => {
    const source = readFileSync(join(import.meta.dir, "../src/hook.ts"), "utf8");
    const prompt = source.slice(source.indexOf('if (event === "UserPromptSubmit")'));
    expect(prompt.indexOf("takeAgentNote(")).toBeGreaterThan(0);
    expect(prompt.indexOf("process.stdout.write(userPromptContext(note))")).toBeLessThan(prompt.indexOf("sendToDaemon("));
    const stop = source.slice(source.indexOf('if (event === "Stop")'));
    expect(stop).toContain("if (checked.refused) saveAgentNote(");
    expect(stop).toContain("...(checked.scope ? { roots: checked.scope.roots, cwd: checked.scope.cwd } : {}),");
  });
});

describe("the socket carries a refusal's words, never a link's folders", () => {
  const turnEnd = (review: Record<string, unknown>, type = "turn-end") =>
    validateSocketTurnEvent({ type, sessionId: "s1", label: "alpha", announce: "done", review: { summary: "pack", ...review } });

  test("linkRefused is one printable line on a turn-end, with no link beside it", () => {
    expect(turnEnd({ linkRefused: "The link /x wasn't published: it does not exist." }).ok).toBe(true);
    expect(turnEnd({ link: "/x", linkRefused: "why" })).toMatchObject({ ok: false });
    expect(turnEnd({ linkRefused: "why" }, "review-published")).toMatchObject({ ok: false });
    expect(turnEnd({ linkRefused: "two\nlines" })).toMatchObject({ ok: false });
    expect(turnEnd({ linkRefused: "x".repeat(1001) })).toMatchObject({ ok: false });
    // The folders a link was checked against are the daemon's own finding.
    expect(turnEnd({ link: "/x", roots: ["/"] })).toMatchObject({ ok: false, err: "review roots are set by the daemon, not sent" });
  });
});

describe("what agents are told", () => {
  const told = AGENT_INSTRUCTIONS.alwaysOn;

  test("the always-on text says what a link is, what a folder does, which line counts, and what a refusal does", () => {
    expect(told).toContain("A link is an http(s) URL, or an absolute path to a file or a folder (shown as its file tree) under this session’s folders");
    expect(told).toContain("where it started, where it is now, its git repository, `conch_working_folders`, or a temp folder (/tmp, or macOS’s per-user /var/folders/…/T)");
    // And what a temp folder means now: a copy that outlives it.
    expect(told).toContain("which conch copies when it files the link, so a cleaned temp folder can’t take it away");
    expect(told).toContain("only the last counts, so link a folder for several things");
    expect(told).toContain("A refused link is dropped and the summary kept; conch tells the user and you why.");
    // Every session carries it: short, and no longer "use your cwd".
    expect(told.split(/\s+/).length).toBeLessThan(380);
    expect(renderAgentsMd()).toContain(told);
  });

  test("the skill's prose gives the same rule for review_to_front and the conch:review line", () => {
    const skill = renderSkillMd();
    expect(skill).not.toContain("must sit under your cwd");
    expect(skill).toContain("the one it is in now and the git repository around that");
    expect(skill).toContain("Only the last such\n  line in a reply counts");
    expect(skill).toContain("the user sees which link and why where the deliverable would be");
    expect(skill).toContain("**outside this session's folders and the temp folders** (the refusal lists them)");
    expect(AGENT_INSTRUCTIONS.tools.conch_working_folders).toContain("your deliverable links may sit under them");
  });
});

describe("the apps say why a link is missing", () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

  test("the Mac's empty deliverable pane shows the refusal, and the old words only when no link was given", () => {
    const models = read("mac-app/conch-mac/Models.swift");
    const review = read("mac-app/conch-mac/ReviewView.swift");
    expect(models).toContain("linkRefused = try? container.decodeIfPresent(String.self, forKey: .linkRefused)");
    expect(review).toContain("linkRefused = review.linkRefused");
    expect(review).toContain("MissingDeliverableView(refusal: item.linkRefused)");
    expect(review).toContain('Text(refusal ?? "No deliverable link was published for this review.")');
  });

  test("the phone's deliverable sheet does the same", () => {
    expect(read("mobile/conch-ios/conch-ios/Models.swift"))
      .toContain("linkRefused = try? c.decodeIfPresent(String.self, forKey: .linkRefused)");
    expect(read("mobile/conch-ios/conch-ios/DeliverableSheet.swift"))
      .toContain('return .unavailable(review.linkRefused ?? "No link on this review.")');
  });
});

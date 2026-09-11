import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVAL_KEYBOARD,
  APPROVAL_KEYS,
  APPROVAL_REASK,
  approvalAnnounce,
  approvalDetail,
  classifyApprovalAnswer,
  confirmAlwaysPrompt,
  confirmsAlways,
  pendingApproval,
  pendingApprovalFromLines,
  summarizeToolUse,
} from "../src/approval.ts";
import { shouldHandleTurnAudibly } from "../src/daemon.ts";

const assistant = (...content: unknown[]) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const user = (...content: unknown[]) => JSON.stringify({ type: "user", message: { role: "user", content } });
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const bash = use("tu_1", "Bash", { command: "git push origin main", description: "Push" });

/** Transcript order (oldest first) is how Claude Code writes; the reader gets it newest first. */
const newestFirst = (...oldestFirst: string[]) => [...oldestFirst].reverse();

describe("what is being asked, from the transcript", () => {
  test("the newest tool_use with no tool_result is the pending prompt", () => {
    expect(pendingApprovalFromLines(newestFirst(
      user({ type: "text", text: "push it" }),
      assistant({ type: "thinking", thinking: "" }),
      assistant(bash),
    ))).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
  });

  test("an answered prompt is not pending", () => {
    // The dialog was answered by hand (or the hook fired late): the result is on disk.
    expect(pendingApprovalFromLines(newestFirst(assistant(bash), user(result("tu_1"))))).toBeNull();
  });

  test("a parallel call with the first already answered names the second", () => {
    const second = use("tu_2", "Edit", { file_path: "/repo/src/app.ts", old_string: "a", new_string: "b" });
    expect(pendingApprovalFromLines(newestFirst(assistant(bash, second), user(result("tu_1")))))
      .toEqual({ id: "tu_2", name: "Edit", summary: "app.ts" });
  });

  test("a question is not a permission", () => {
    // Claude Code fires permission_prompt for an AskUserQuestion too; Enter would pick an option.
    expect(pendingApprovalFromLines(newestFirst(
      assistant(use("tu_q", "AskUserQuestion", { questions: [{ question: "Which?" }] })),
    ))).toBeNull();
  });

  test("a finished reply or a newer prompt from you means nothing is waiting", () => {
    expect(pendingApprovalFromLines(newestFirst(assistant(bash), user(result("tu_1")), assistant({ type: "text", text: "Pushed." })))).toBeNull();
    expect(pendingApprovalFromLines(newestFirst(assistant(bash), user({ type: "text", text: "never mind" })))).toBeNull();
  });

  test("a partial line mid-write and non-message entries are skipped", () => {
    expect(pendingApprovalFromLines(newestFirst(
      assistant(bash),
      JSON.stringify({ type: "progress", data: {} }),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_9","na',
    ))).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
    expect(pendingApprovalFromLines([])).toBeNull();
  });
});

describe("reading the tail of a real transcript file", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("finds the pending call behind a long transcript, and never throws on a missing file", () => {
    const root = mkdtempSync(join(tmpdir(), "conch-approval-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    const filler = Array.from({ length: 400 }, (_, i) => assistant({ type: "text", text: `earlier reply ${i} `.repeat(40) }));
    writeFileSync(path, [...filler, user({ type: "text", text: "push it" }), assistant(bash)].join("\n") + "\n");
    expect(pendingApproval(path)).toEqual({ id: "tu_1", name: "Bash", summary: "git push origin main" });
    expect(pendingApproval(join(root, "missing.jsonl"))).toBeNull();
  });
});

describe("the one spoken line", () => {
  test("names the action the way the tool does", () => {
    expect(summarizeToolUse("Bash", { command: "  git   status\n  && git log " })).toBe("git status && git log");
    expect(summarizeToolUse("Edit", { file_path: "/repo/src/app.ts" })).toBe("app.ts");
    expect(summarizeToolUse("WebFetch", { url: "https://example.com/x" })).toBe("https://example.com/x");
    expect(summarizeToolUse("mcp__linear__save_issue", { title: "Bug", team: "ENG" })).toBe("title Bug, team ENG");
    expect(summarizeToolUse("Odd", {})).toBe("Odd");
    expect(summarizeToolUse("Odd", "not an object")).toBe("Odd");
  });

  test("is capped, because it is read aloud", () => {
    const long = summarizeToolUse("Bash", { command: "x".repeat(500) });
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });

  test("announce and row detail carry the tool and the summary", () => {
    const ask = { name: "Bash", summary: "git push origin main" };
    expect(approvalAnnounce("Fix login", ask)).toBe("Fix login needs permission for Bash: git push origin main. Yes, always, or no?");
    expect(approvalDetail(ask)).toBe("permission: Bash — git push origin main");
    expect(confirmAlwaysPrompt(ask)).toBe("Always allow Bash for this session. Say yes to confirm.");
    expect(APPROVAL_REASK).toContain("always");
    expect(APPROVAL_KEYBOARD).toContain("keyboard");
  });
});

describe("the spoken answer, four ways", () => {
  const cases: Array<[string, ReturnType<typeof classifyApprovalAnswer>]> = [
    ["Yes.", { kind: "once" }],
    ["Yeah, go ahead.", { kind: "once" }],
    ["just this once", { kind: "once" }],
    ["yes, this time", { kind: "once" }],
    ["Always.", { kind: "always" }],
    ["yes, always", { kind: "always" }],
    ["Yes, and don't ask again.", { kind: "always" }],
    ["don't ask me again", { kind: "always" }],
    ["allow it for this session", { kind: "always" }],
    ["No.", { kind: "deny" }],
    ["no thanks", { kind: "deny" }],
    ["Nope, stop.", { kind: "deny" }],
    ["Cancel", { kind: "deny" }],
    ["No, use the main branch instead.", { kind: "instead", text: "use the main branch instead." }],
    ["Don't. Run the tests first.", { kind: "instead", text: "Run the tests first." }],
    ["Instead, push to a feature branch.", { kind: "instead", text: "push to a feature branch." }],
    ["Tell it to skip the push.", { kind: "instead", text: "skip the push." }],
    ["Use the other branch.", null],
    ["Yes. No.", null],
    ["no, always", null],
    ["instead", null],
    ["", null],
    ["   ", null],
  ];
  for (const [heard, expected] of cases) {
    test(`"${heard}" -> ${expected ? expected.kind : "unclear"}`, () => {
      expect(classifyApprovalAnswer([heard])).toEqual(expected);
    });
  }

  test("segments split on a pause are one answer", () => {
    expect(classifyApprovalAnswer(["No,", "use main."])).toEqual({ kind: "instead", text: "use main." });
    expect(classifyApprovalAnswer(["Yes.", "", "  "])).toEqual({ kind: "once" });
  });

  test("each outcome presses what a person would press", () => {
    expect(APPROVAL_KEYS).toEqual({
      once: ["Enter"],
      always: ["Down", "Enter"],
      deny: ["Escape"],
      instead: ["Escape"],
    });
  });
});

describe("the confirm gate for always", () => {
  test("a plain yes or a repeated always confirms; anything else does not", () => {
    expect(confirmsAlways(["yes"])).toBe(true);
    expect(confirmsAlways(["Always."])).toBe(true);
    expect(confirmsAlways(["no"])).toBe(false);
    expect(confirmsAlways(["maybe later"])).toBe(false);
    expect(confirmsAlways(["no, use main"])).toBe(false);
    expect(confirmsAlways([])).toBe(false);
  });
});

describe("the daemon's wiring", () => {
  const read = (file: string) => readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
  const daemon = read("daemon.ts");
  const handleTurn = daemon.slice(
    daemon.indexOf("async function handleTurn("),
    daemon.indexOf('if (event.type === "recite") {'),
  );
  const loop = daemon.slice(
    daemon.indexOf("async function permissionLoop("),
    daemon.indexOf("async function listenForApproval("),
  );
  const listen = daemon.slice(
    daemon.indexOf("async function listenForApproval("),
    daemon.indexOf("Stop a session mid-turn."),
  );

  test("only a permission prompt, only with bypass off, and only for a tool still waiting", () => {
    const read = handleTurn.slice(handleTurn.indexOf("const approval ="), handleTurn.indexOf("const controlledTurn ="));
    expect(read).toContain('event.ntype === "permission_prompt"');
    expect(read).toContain("!cfg.bypassPermissions");
    expect(read).toContain("pendingApproval(event.transcriptPath)");
    // Everything else a needs-you was stays visual-only.
    expect(handleTurn).toContain("if (!approval) return; // stripped");
    // Attached before the predicate, so the gates treat it as the announced turn it is.
    const attach = handleTurn.indexOf("if (approval) event.approval = approval;");
    expect(attach).toBeGreaterThan(handleTurn.indexOf("const approval ="));
    expect(attach).toBeLessThan(handleTurn.indexOf("const controlledTurn = shouldHandleTurnAudibly(event, cfg.workingMic);"));
    expect(handleTurn).toContain("else delete event.approval;");
  });

  test("a permission with a voice is audible; every other needs-you is not", () => {
    const ask = { id: "tu_1", name: "Bash", summary: "git push" };
    expect(shouldHandleTurnAudibly({ type: "needs-you", approval: ask }, false)).toBe(true);
    expect(shouldHandleTurnAudibly({ type: "needs-you" }, false)).toBe(false);
    expect(shouldHandleTurnAudibly({ type: "working", approval: ask }, false)).toBe(false);
  });

  test("the row says what is being asked", () => {
    expect(handleTurn).toContain('const kind = approval ? approvalDetail(approval) : describeNeed(event.ntype);');
  });

  test("the voice runs after the quiet gates, before recite and wake", () => {
    const dispatch = handleTurn.indexOf("await permissionLoop(event, approval, pauseGeneration)");
    expect(dispatch).toBeGreaterThan(handleTurn.indexOf("gateTurnForControls(event, controlledTurn"));
    expect(dispatch).toBeGreaterThan(handleTurn.indexOf("cfg.awayAfterSecs"));
    expect(handleTurn.indexOf('if (event.type === "wake")')).toBe(-1); // sliced before both branches
  });

  test("announce, then listen; the mic is held for the same reasons as a turn", () => {
    const announce = loop.indexOf("await say(approvalAnnounce(event.label, ask))");
    const earElsewhere = loop.indexOf("audioLease.isPhone() || !audioHolder.isLocal()");
    const typing = loop.indexOf("idle < cfg.typingGraceSecs");
    const firstListen = loop.indexOf("await listenForApproval(event)");
    expect(announce).toBeGreaterThan(loop.indexOf("await ringBell()"));
    expect(earElsewhere).toBeGreaterThan(announce);
    expect(typing).toBeGreaterThan(earElsewhere);
    expect(firstListen).toBeGreaterThan(typing);
  });

  test("unclear is re-asked once, then left for the keyboard", () => {
    const reask = loop.indexOf("await say(APPROVAL_REASK)");
    const keyboard = loop.indexOf("await say(APPROVAL_KEYBOARD)");
    expect(reask).toBeGreaterThan(0);
    expect(keyboard).toBeGreaterThan(reask);
    expect(loop.match(/await listenForApproval\(event\)/g)?.length).toBe(3); // ask, re-ask, confirm
  });

  test("always is confirmed by a second spoken yes before any key is pressed", () => {
    const confirm = loop.indexOf("if (!confirmsAlways(confirmation))");
    expect(confirm).toBeGreaterThan(loop.indexOf("await say(confirmAlwaysPrompt(ask))"));
    expect(confirm).toBeLessThan(loop.indexOf("APPROVAL_KEYS[answer.kind]"));
    expect(loop.indexOf("injectKey(")).toBeGreaterThan(confirm);
  });

  test("instead is Escape and then the alternative typed as the next prompt", () => {
    const keys = loop.indexOf("for (const key of APPROVAL_KEYS[answer.kind])");
    const typed = loop.indexOf("injectText(cfg, event.pid, answer.text");
    expect(typed).toBeGreaterThan(keys);
    expect(loop.slice(keys, typed)).toContain('if (answer.kind === "instead")');
    expect(loop.slice(typed)).toContain("markInjected(event.sessionId)");
  });

  test("the permission mic honours the audio gate", () => {
    // reserveNormalMic is the invariant: no mic while TTS speaks.
    const reserve = listen.indexOf("await reserveNormalMic()");
    expect(reserve).toBeGreaterThan(listen.indexOf('await micCue(cfg, "open")'));
    expect(reserve).toBeLessThan(listen.indexOf("session.start()"));
    expect(listen).toContain("return texts;");
  });

  test("Down is a key the injector can press", () => {
    const inject = read("inject.ts");
    expect(inject).toContain('key: "Enter" | "Escape" | "Down"');
    expect(inject).toContain('key === "Down" ? 125');
  });
});

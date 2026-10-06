import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConversation } from "../src/conversation.ts";
import {
  stepPhrase,
  ACTIVITY_MAX_CHARS,
  ActivityReader,
  ActivityThrottle,
  activityAt,
  activityFacts,
  activityRowIds,
  commandPhrase,
  commentaryLine,
  displayPath,
  LiveActivity,
  oneLine,
  type RowActivity,
  shellPhrase,
  withLiveActivity,
} from "../src/live-activity.ts";
import type { PublishedSessionRow, PublishedState } from "../src/panel.ts";

/**
 * The live activity line under a working row (live-activity.ts, 2026-10-03): Tyler, "Could also be cool to see an
 * agent work live in the side bar." What it says, when it says nothing, what it costs to read, and how often it moves.
 */

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

/** Claude Code's shapes: what you said, what the agent wrote, a tool it called, and that tool's result. */
const claude = {
  you: (uuid: string, text: string, at: number) =>
    ({ type: "user", uuid, timestamp: iso(at), message: { content: [{ type: "text", text }] } }),
  says: (uuid: string, text: string, at: number) =>
    ({ type: "assistant", uuid, timestamp: iso(at), message: { content: [{ type: "text", text }] } }),
  thinks: (uuid: string, thinking: string, at: number) =>
    ({ type: "assistant", uuid, timestamp: iso(at), message: { content: [{ type: "thinking", thinking }] } }),
  calls: (uuid: string, id: string, name: string, input: unknown, at: number) =>
    ({ type: "assistant", uuid, timestamp: iso(at), message: { content: [{ type: "tool_use", id, name, input }] } }),
  result: (uuid: string, id: string, at: number, extra: Record<string, unknown> = {}) =>
    ({ type: "user", uuid, timestamp: iso(at), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra }),
};

/** Codex's: what you said, a commentary message, and an `exec` call lifting a shell command, with its output. */
const codex = {
  you: (text: string, at: number) =>
    ({ type: "event_msg", timestamp: iso(at), payload: { type: "user_message", message: text } }),
  says: (id: string, text: string, at: number) => ({
    type: "response_item",
    timestamp: iso(at),
    payload: { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] },
  }),
  execs: (callId: string, cmd: string, at: number) => ({
    type: "response_item",
    timestamp: iso(at),
    payload: { type: "custom_tool_call", call_id: callId, name: "exec", input: `text(await tools.exec_command({cmd:${JSON.stringify(cmd)}}))` },
  }),
  output: (callId: string, at: number) => ({
    type: "response_item",
    timestamp: iso(at),
    payload: { type: "custom_tool_call_output", call_id: callId, output: "Script completed" },
  }),
};

const factsOf = (format: "claude" | "codex", body: string, places: string[] = []) =>
  activityFacts(buildConversation("s", body.split("\n"), format), places);

describe("what a working row says", () => {
  test("a running step is said as what is happening, from the description its agent gave", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "run the tests", 0),
      claude.calls("a1", "c1", "Bash", { description: "Run the test suite", command: "bun test" }, 1_000),
    ));
    expect(activityAt(facts, T0 + 5_000).activity).toEqual({ text: "Running the test suite", kind: "step", at: T0 + 1_000 });
  });

  test("an edit names its file relative to the folder the agent works in", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "fix it", 0),
      claude.calls("a1", "c1", "Edit", {
        file_path: "/Users/you/Projects/conch/.worktrees/fix/src/voice-loop.ts",
        old_string: "a",
        new_string: "b",
      }, 1_000),
    ), ["/Users/you/Projects/conch/.worktrees/fix", "/Users/you"]);
    expect(activityAt(facts, T0 + 2_000).activity?.text).toBe("Editing src/voice-loop.ts");
  });

  test("several steps of one kind at once are counted, not listed", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "look around", 0),
      claude.calls("a1", "c1", "Read", { file_path: "/p/a.ts" }, 1_000),
      claude.calls("a2", "c2", "Read", { file_path: "/p/b.ts" }, 1_001),
      claude.calls("a3", "c3", "Read", { file_path: "/p/c.ts" }, 1_002),
    ));
    expect(activityAt(facts, T0 + 2_000).activity?.text).toBe("Reading 3 files");
  });

  test("a finished step is not running, and the agent's newest words after it stand in", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "fix it", 0),
      claude.calls("a1", "c1", "Bash", { description: "Run the test suite", command: "bun test" }, 1_000),
      claude.result("u2", "c1", 9_000),
      claude.says("a2", "Two tests fail on the throttle.\n\nI'll fix the **trailing edge** in `publish-throttle.ts` next.", 10_000),
    ));
    expect(facts.steps).toEqual([]);
    expect(activityAt(facts, T0 + 20_000).activity).toEqual({
      text: "I'll fix the trailing edge in publish-throttle.ts next.",
      kind: "commentary",
      at: T0 + 10_000,
    });
  });

  test("thinking counts as commentary, as the conversation shows it", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "why is it slow", 0),
      claude.thinks("a1", "The render reads every transcript. Let me measure the tail read first.", 2_000),
    ));
    expect(activityAt(facts, T0 + 3_000).activity?.text).toBe("Let me measure the tail read first.");
  });

  test("the turn's last words stand however old they are: the line goes when the turn does", () => {
    // 2026-10-03: a Codex session's words were three minutes old and still what it was doing; a minute's limit hid them.
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "go", 0),
      claude.says("a1", "Building the app now, then the phone.", 1_000),
    ));
    expect(activityAt(facts, T0 + 10 * 60_000).activity).toEqual({ text: "Building the app now, then the phone.", kind: "commentary", at: T0 + 1_000 });
  });

  test("steps that finish too fast to be caught running still show: the turn's last one, when it is newer than its words", () => {
    // The same session ran a command every few seconds, each done inside one, so none was ever seen running.
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "deploy it", 0),
      claude.says("a1", "Checking the limit, then deploying.", 1_000),
      claude.calls("a2", "c1", "Bash", { description: "Run the test suite", command: "bun test" }, 2_000),
      claude.result("u2", "c1", 2_400),
    ));
    expect(facts.steps).toEqual([]);
    expect(activityAt(facts, T0 + 3_000).activity).toEqual({ text: "Running the test suite", kind: "step", at: T0 + 2_000 });
  });

  test("a tool that describes its own work is said by the description, not by the tool's name", () => {
    const step = (text: string) => stepPhrase({ id: "x", rev: 1, kind: "tool", text, tool: { name: "js", status: "done" } } as never);
    expect(step("recover and inspect the credential visibility state safely")).toBe("Recover and inspect the credential visibility state safely");
    expect(step("Run the migration")).toBe("Running the migration");
  });

  test("a turn with nothing in it yet says nothing", () => {
    const facts = factsOf("claude", jsonl(claude.says("a0", "Earlier turn's words.", 0), claude.you("u1", "next", 1_000)));
    expect(activityAt(facts, T0 + 2_000).activity).toBeNull();
  });

  test("a step left running by an earlier, interrupted turn is not what the agent is doing now", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "first", 0),
      claude.calls("a1", "c1", "Bash", { description: "Run the slow build", command: "make" }, 1_000),
      claude.you("u2", "never mind, read the README", 5_000),
      claude.says("a2", "Reading the README instead.", 6_000),
    ));
    expect(facts.steps).toEqual([]);
    expect(activityAt(facts, T0 + 7_000).activity?.text).toBe("Reading the README instead.");
  });

  test("a message queued while the agent works does not end its turn", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "deploy", 0),
      claude.calls("a1", "c1", "Bash", { description: "Deploy to production", command: "wrangler deploy" }, 1_000),
      {
        type: "attachment",
        uuid: "q1",
        timestamp: iso(2_000),
        attachment: { type: "queued_command", origin: { kind: "human" }, prompt: "also tag it", source_uuid: "s1" },
      },
    ));
    expect(activityAt(facts, T0 + 3_000).activity?.text).toBe("Deploying to production");
  });

  test("a background agent its session started is the agent's row's to describe, not the session's", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "review it", 0),
      claude.calls("a1", "c1", "Agent", { description: "Adversarial review", prompt: "…", run_in_background: true }, 1_000),
      claude.result("u2", "c1", 1_100, { toolUseResult: { agentId: "abc123", isAsync: true } }),
      claude.says("a2", "The reviewer is running; I'll start on the docs meanwhile.", 2_000),
    ));
    expect(facts.steps).toEqual([]);
    expect(activityAt(facts, T0 + 3_000).activity?.kind).toBe("commentary");
  });

  test("a question the agent is waiting on is not activity: the row is blocked, and says so itself", () => {
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "set it up", 0),
      claude.calls("a1", "c1", "AskUserQuestion", { questions: [{ question: "Which account?", header: "Account", options: [{ label: "A" }, { label: "B" }] }] }, 1_000),
    ));
    expect(facts.steps).toEqual([]);
  });
});

describe("one line, never more", () => {
  test("a long line is cut on a word to at most 90 characters, with an ellipsis", () => {
    const long = "Run the full local CI on the settings branch, then rebuild the Mac app and the iPhone app and compare both screenshots";
    const said = commandPhrase(long);
    const line = oneLine(said);
    expect(Array.from(line).length).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS);
    expect(line.endsWith("…")).toBe(true);
    expect(line.startsWith("Running the full local CI")).toBe(true);
    // On a word: the character before the ellipsis ends one.
    expect(said.slice(0, line.length - 1).endsWith(line.slice(0, -1))).toBe(true);
    expect(said[line.length - 1]).toMatch(/[\s,]/);
  });

  test("whitespace and newlines collapse and markdown is stripped", () => {
    expect(commentaryLine("## Plan\n\n- First, **read** the `README.md`\n- Then [open the PR](https://x.test/pr/1) on *main*")).toBe(
      "Then open the PR on main",
    );
    expect(oneLine("  two\n\nlines\tand   tabs ")).toBe("two lines and tabs");
    const facts = factsOf("claude", jsonl(
      claude.you("u1", "go", 0),
      claude.says("a1", "```ts\nconst x = 1;\n```\nThe fix is in.\nRunning the suite again to confirm nothing else moved.", 1_000),
    ));
    const line = activityAt(facts, T0 + 2_000).activity!.text;
    expect(line).toBe("Running the suite again to confirm nothing else moved.");
    expect(line).not.toContain("\n");
  });

  test("a sentence too long for the line is cut, never wrapped", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const facts = factsOf("claude", jsonl(claude.you("u1", "go", 0), claude.says("a1", words, 1_000)));
    const line = activityAt(facts, T0 + 2_000).activity!.text;
    expect(Array.from(line).length).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("Codex", () => {
  test("a running command is said as what it does, and the newest commentary when none runs", () => {
    const running = factsOf("codex", jsonl(
      codex.you("fix the flaky listen test", 0),
      codex.says("m1", "I’m reproducing the flake first.", 1_000),
      codex.execs("call_1", "cd /Users/you/Projects/conch && bun test test/listen.test.ts", 2_000),
    ));
    expect(activityAt(running, T0 + 3_000).activity).toEqual({
      text: "Running bun test test/listen.test.ts",
      kind: "step",
      at: T0 + 2_000,
    });

    const between = factsOf("codex", jsonl(
      codex.you("fix the flaky listen test", 0),
      codex.execs("call_1", "sed -n '1,120p' /Users/you/Projects/conch/src/listen.ts", 2_000),
      codex.output("call_1", 2_500),
      codex.says("m2", "The timeout races the mic release, so I’m moving the release first.", 4_000),
    ), ["/Users/you/Projects/conch"]);
    expect(between.steps).toEqual([]);
    expect(activityAt(between, T0 + 5_000).activity?.text).toBe(
      "The timeout races the mic release, so I’m moving the release first.",
    );
  });

  test("the commands Codex runs most read as what they do", () => {
    const places = ["/Users/you/Projects/morrow-api"];
    expect(shellPhrase("sed -n '355,530p' /Users/you/Projects/morrow-api/server/oauth/owner-consent.ts", places))
      .toBe("Reading server/oauth/owner-consent.ts");
    expect(shellPhrase("rg -n -A7 \"const execute|runner\" server", places)).toBe("Searching for “const execute|runner”");
    expect(shellPhrase("rg --files server/oauth | rg 'store|consent'", places)).toBe("Listing files");
    expect(shellPhrase("cat > test_capture.py <<'PY'", places)).toBe("Writing test_capture.py");
    expect(shellPhrase("python3 - <<'PY'", places)).toBe("Running a python3 script");
    expect(shellPhrase("/Users/you/.local/share/mise/installs/node/22/bin/node --test *.test.mjs", places))
      .toBe("Running node --test *.test.mjs");
    expect(shellPhrase("const r = await Promise.allSettled([", places)).toBe("Running a script");
  });
});

describe("descriptions said as doing", () => {
  test("a known verb is said as -ing, through a list of steps, and an unknown first word is left alone", () => {
    expect(commandPhrase("Commit, push and open the PR")).toBe("Committing, pushing and opening the PR");
    expect(commandPhrase("Re-run the focused tests")).toBe("Re-running the focused tests");
    expect(commandPhrase("Tile the process video")).toBe("Tiling the process video");
    expect(commandPhrase("Git status of the worktree")).toBe("Git status of the worktree");
  });

  test("a path outside every working folder is shortened from home, and to its name when its folder says nothing", () => {
    expect(displayPath("/Users/you/notes/today.md", [], "/Users/you")).toBe("~/notes/today.md");
    expect(displayPath("/var/folders/hj/cg29fnq929v27cj88gsnrskr0000gn/T/conch-next-ideas-design.md", [], "/Users/you"))
      .toBe("conch-next-ideas-design.md");
  });
});

/** A published state with these rows, each otherwise ordinary. */
function stateWith(rows: Array<Partial<PublishedSessionRow> & { id: string }>): PublishedState {
  return {
    v: 1,
    features: { deliverables: 4, viewedState: 1 },
    ownerDeviceId: "mac",
    ts: T0,
    mode: { muted: false, paused: false, holding: 0 },
    live: { state: "idle", label: "" },
    rows: rows.map((row) => ({
      label: row.id,
      status: null,
      needsResponse: false,
      paused: false,
      muted: false,
      live: null,
      active: false,
      ...row,
    })),
    dismissed: [],
    dismissedRows: [],
    seaGlass: 0,
  };
}

/** A LiveActivity whose reads return these conversations by row id, counting each. */
function liveFrom(bodies: Record<string, { format: "claude" | "codex"; body: string }>) {
  const reads: string[] = [];
  const reader = new ActivityReader({
    stat: () => ({ size: 1, mtimeMs: 1, ino: 1 }),
    readTail: async (_path, sessionId) => {
      reads.push(sessionId);
      const { format, body } = bodies[sessionId]!;
      return buildConversation(sessionId, body.split("\n"), format);
    },
  });
  return { live: new LiveActivity({ reader }), reads };
}

describe("which rows carry a line", () => {
  test("only a row working on its own turn: never idle, waiting, needs, or one only its agents keep working", async () => {
    const busy = jsonl(claude.you("u1", "go", 0), claude.calls("a1", "c1", "Bash", { description: "Build the app", command: "make" }, 1_000));
    const ids = ["working", "agent", "idle", "waiting", "needs", "agents-only"];
    const { live } = liveFrom(Object.fromEntries(ids.map((id) => [id, { format: "claude" as const, body: busy }])));
    // Every transcript is busy; the row's status alone decides.
    await live.observe(ids.map((id) => ({ id, transcriptPath: `/t/${id}.jsonl`, format: "claude" as const })));
    const state = stateWith([
      { id: "working", status: "working" },
      { id: "agent", status: "working", parentSessionId: "working" },
      { id: "idle", status: null },
      { id: "waiting", status: "waiting" },
      { id: "needs", status: "needs", needsResponse: true },
      { id: "agents-only", status: "working", waitingOnAgents: true },
    ]);
    expect(activityRowIds(state.rows)).toEqual(["working", "agent"]);
    const { state: shown } = withLiveActivity(state, live, T0 + 2_000);
    expect(shown.rows.filter((row) => row.activity).map((row) => row.id)).toEqual(["working", "agent"]);
    expect(shown.rows.find((row) => row.id === "working")?.activity?.text).toBe("Building the app");
  });

  test("a row that stops working loses its line on the next publish, whatever the throttle holds", async () => {
    const busy = jsonl(claude.you("u1", "go", 0), claude.calls("a1", "c1", "Bash", { description: "Build the app", command: "make" }, 1_000));
    const { live } = liveFrom({ s: { format: "claude", body: busy } });
    await live.observe([{ id: "s", transcriptPath: "/t/s.jsonl", format: "claude" }]);
    const working = withLiveActivity(stateWith([{ id: "s", status: "working" }]), live, T0 + 2_000).state;
    expect(working.rows[0]!.activity?.text).toBe("Building the app");
    // 100 ms later, inside the interval: the turn ended.
    const done = withLiveActivity({ ...working, rows: [{ ...working.rows[0]!, status: "waiting" }] }, live, T0 + 2_100);
    expect(done.changed).toBe(true);
    expect(done.state.rows[0]).not.toHaveProperty("activity");
  });
});

describe("reading costs one stat until the transcript moves", () => {
  test("an unchanged transcript is not read again, and an appended one is", async () => {
    const folder = mkdtempSync(join(tmpdir(), "conch-live-activity-"));
    const path = join(folder, "s.jsonl");
    writeFileSync(path, jsonl(claude.you("u1", "go", 0), claude.calls("a1", "c1", "Bash", { description: "Build the app", command: "make" }, 1_000)));
    const reader = new ActivityReader();
    const source = { id: "s", transcriptPath: path, format: "claude" as const };
    const first = await reader.facts(source);
    expect(first?.steps.map((step) => step.text)).toEqual(["Building the app"]);
    for (let round = 0; round < 5; round += 1) expect(await reader.facts(source)).toBe(first);
    expect(reader.reads).toBe(1);

    appendFileSync(path, jsonl(claude.result("u2", "c1", 3_000), claude.says("a2", "Built; signing it next.", 4_000)));
    const second = await reader.facts(source);
    expect(reader.reads).toBe(2);
    expect(second?.steps).toEqual([]);
    expect(second?.latest).toEqual({ text: "Built; signing it next.", kind: "commentary", at: T0 + 4_000 });

    // Same size, newer mtime: a rewrite in place is read again too.
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    await reader.facts(source);
    expect(reader.reads).toBe(3);
  });

  test("a tail one long line swallowed is read once more, deeper, and no further", async () => {
    const folder = mkdtempSync(join(tmpdir(), "conch-live-activity-"));
    const path = join(folder, "s.jsonl");
    const image = { type: "user", uuid: "big", timestamp: iso(500), message: { content: [{ type: "text", text: "x".repeat(6_000) }] } };
    writeFileSync(path, jsonl(
      claude.you("u1", "go", 0),
      claude.calls("a1", "c1", "Bash", { description: "Render the frames", command: "make" }, 400),
      image,
    ));
    const tails: number[] = [];
    const reader = new ActivityReader({
      tailBytes: 1_024,
      deepTailBytes: 64 * 1_024,
      readTail: async (file, sessionId, format, _window, tailBytes) => {
        tails.push(tailBytes);
        const text = readFileSync(file, "utf8");
        const lines = text.slice(Math.max(0, text.length - tailBytes)).split("\n");
        return buildConversation(sessionId, text.length > tailBytes ? lines.slice(1) : lines, format);
      },
    });
    await reader.facts({ id: "s", transcriptPath: path, format: "claude" });
    expect(tails).toEqual([1_024, 64 * 1_024]);
  });

  test("on a real transcript a render that finds nothing new reads nothing", async () => {
    const folder = mkdtempSync(join(tmpdir(), "conch-live-activity-"));
    const path = join(folder, "rollout-2026-10-03T10-00-00-0000.jsonl");
    writeFileSync(path, jsonl(codex.you("go", 0), codex.execs("call_1", "bun test", 1_000)));
    const live = new LiveActivity();
    const sources = [{ id: "codex", transcriptPath: path, format: "codex" as const }];
    await live.observe(sources);
    await live.observe(sources);
    await live.observe(sources);
    expect(live.reader.reads).toBe(1);
    expect(live.select(["codex"], T0 + 2_000).activities.get("codex")?.text).toBe("Running bun test");
  });
});

describe("the line moves at most once a second", () => {
  const line = (text: string, at = T0): RowActivity => ({ text, kind: "step", at });

  test("the first line shows at once; a change inside the second waits for its end; only the newest is shown", () => {
    const throttle = new ActivityThrottle(1_000);
    expect(throttle.settle("s", line("Reading a.ts"), T0)).toEqual({ shown: line("Reading a.ts") });
    expect(throttle.settle("s", line("Reading b.ts"), T0 + 200)).toEqual({ shown: line("Reading a.ts"), dueAt: T0 + 1_000 });
    expect(throttle.settle("s", line("Reading c.ts"), T0 + 600)).toEqual({ shown: line("Reading a.ts"), dueAt: T0 + 1_000 });
    expect(throttle.settle("s", line("Reading c.ts"), T0 + 1_000)).toEqual({ shown: line("Reading c.ts") });
    // The same words again are no change at all, however soon.
    expect(throttle.settle("s", line("Reading c.ts", T0 + 1_050), T0 + 1_050)).toEqual({ shown: line("Reading c.ts") });
  });

  test("going blank is throttled too, so a step ending as the next starts never flashes the row to one line", () => {
    const throttle = new ActivityThrottle(1_000);
    throttle.settle("s", line("Running the build"), T0);
    expect(throttle.settle("s", null, T0 + 300).shown?.text).toBe("Running the build");
    expect(throttle.settle("s", line("Running the tests"), T0 + 500)).toEqual({ shown: line("Running the build"), dueAt: T0 + 1_000 });
  });

  test("a row that leaves is forgotten, so its next line shows at once", () => {
    const throttle = new ActivityThrottle(1_000);
    throttle.settle("s", line("Running the build"), T0);
    throttle.retain(new Set());
    expect(throttle.settle("s", line("Running the tests"), T0 + 100)).toEqual({ shown: line("Running the tests") });
  });

  test("the publisher is told when to look again, and a look that finds nothing new changes nothing", async () => {
    const steps = jsonl(
      claude.you("u1", "go", 0),
      claude.calls("a1", "c1", "Read", { file_path: "/p/a.ts" }, 1_000),
    );
    const bodies = { s: { format: "claude" as const, body: steps } };
    const { live, reads } = liveFrom(bodies);
    const source = [{ id: "s", transcriptPath: "/t/s.jsonl", format: "claude" as const }];
    await live.observe(source);
    const first = withLiveActivity(stateWith([{ id: "s", status: "working" }]), live, T0 + 1_000);
    expect(first.state.rows[0]!.activity?.text).toBe("Reading /p/a.ts");

    // The step finishes and words follow, 300 ms later: held until a second has passed.
    bodies.s.body = steps + jsonl(claude.result("u2", "c1", 1_200), claude.says("a2", "That file is the culprit; editing it.", 1_300));
    live.reader.retain(new Set());
    await live.observe(source);
    expect(reads).toEqual(["s", "s"]);
    const held = withLiveActivity(first.state, live, T0 + 1_300);
    expect(held.changed).toBe(false);
    expect(held.state).toBe(first.state);
    expect(held.dueAt).toBe(T0 + 2_000);

    const due = withLiveActivity(held.state, live, T0 + 2_000);
    expect(due.changed).toBe(true);
    expect(due.state.rows[0]!.activity).toEqual({ text: "That file is the culprit; editing it.", kind: "commentary", at: T0 + 1_300 });
    // Nothing is due on a clock: the words stand until the turn moves on.
    expect(due.dueAt).toBeNull();
    expect(withLiveActivity(due.state, live, T0 + 30 * 60_000).changed).toBe(false);
  });
});

describe("the daemon's wiring", () => {
  const daemon = readFileSync(join(import.meta.dir, "..", "src", "daemon.ts"), "utf8");

  test("every row working on its own turn is observed, not only the eight with a conversation", () => {
    const observed = daemon.slice(daemon.indexOf("const liveActivityObserved = liveActivity.observe("), daemon.indexOf('breadcrumb("panel: conversations");'));
    expect(observed).toContain("orderedRows.flatMap(");
    expect(observed).toContain('if (row.status !== "working" || row.waitingOnAgents || !session) return [];');
    expect(observed).not.toContain("sessionsToPublish");
  });

  test("a full render puts the lines back on the snapshot it built, and a due line patches it without a scan", () => {
    const render = daemon.slice(daemon.indexOf("lastPublishedPanelState = buildDaemonPublishedState("));
    expect(render.indexOf("applyLiveActivity();")).toBeGreaterThan(render.indexOf("practice.publish(lastPublishedPanelState)"));
    expect(render.indexOf("applyLiveActivity();")).toBeLessThan(render.indexOf("publishedStateWriter.request();"));
    const apply = daemon.slice(daemon.indexOf("function applyLiveActivity(): boolean {"), daemon.indexOf("/** Setup's practice turn"));
    expect(apply).toContain("withLiveActivity(lastPublishedPanelState, liveActivity, now)");
    expect(apply).toContain("if (applyLiveActivity()) publishedStateWriter.request();");
    expect(apply).not.toContain("renderSessionPanel");
  });
});

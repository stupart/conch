import { describe, expect, test } from "bun:test";
import { runMessageCommand, type MessageCliDeps } from "../src/peer-message-cli.ts";
import { conchMessageDelivery } from "../src/peer-messages.ts";
import type { AssistantTail } from "../src/transcript-tail.ts";

// `conch message` as an agent runs it from its shell: exit 0 sent, 1 conch failed, 2 the command was wrong, 3 refused.
function cli(over: Partial<MessageCliDeps> & { reply?: unknown; tails?: AssistantTail[] } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const requests: unknown[] = [];
  let clock = 0;
  const tails = [...(over.tails ?? [])];
  const deps: MessageCliDeps = {
    request: async (line) => {
      requests.push(JSON.parse(line));
      return JSON.stringify(over.reply ?? { kind: "peer-message-sent", msgId: "1a2b3c4d5e6f", session: "s-lantern", label: "lantern" });
    },
    stdin: async () => "from stdin\n",
    stdinIsTTY: true,
    callerPid: 4321,
    readTail: async () => tails.length > 1 ? tails.shift()! : tails[0] ?? { text: "", midTurn: false },
    out: (line) => void out.push(line),
    err: (line) => void err.push(line),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  };
  return { run: (...args: string[]) => runMessageCommand(args, deps), out, err, requests };
}

describe("conch message", () => {
  test("sends, says to whom and the message's id, in the words its row reads back as sent", async () => {
    const c = cli();
    expect(await c.run("lantern", "Your review is in:", "two nits.")).toBe(0);
    expect(c.requests).toEqual([{ kind: "peer-message", callerPid: 4321, to: "lantern", text: "Your review is in: two nits." }]);
    expect(c.out).toEqual(["[conch] sent to \"lantern\" (msg 1a2b3c4d5e6f). Its answer comes back into this session as a message from it."]);
    expect(conchMessageDelivery(c.out.join("\n"), false)).toEqual({ msgId: "1a2b3c4d5e6f", delivery: "sent" });
  });

  test("the words from stdin, with - or from a pipe", async () => {
    const dash = cli();
    expect(await dash.run("lantern", "-")).toBe(0);
    expect(dash.requests[0]).toMatchObject({ text: "from stdin\n" });
    const piped = cli({ stdinIsTTY: false });
    expect(await piped.run("--reply", "000000000001")).toBe(0);
    expect(piped.requests[0]).toMatchObject({ replyTo: "000000000001", text: "from stdin\n" });
  });

  test("a wrong command is exit 2 with the usage, and nothing is asked of conch", async () => {
    for (const args of [[], ["lantern"], ["lantern", "--loud", "hi"], ["lantern", "--wait=0", "hi"]]) {
      const c = cli();
      expect(await c.run(...args)).toBe(2);
      expect(c.err.join("\n")).toContain("usage: conch message");
      expect(c.requests).toEqual([]);
    }
    const long = cli();
    expect(await long.run("lantern", "x".repeat(16_001))).toBe(2);
  });

  test("a refusal is exit 3 with conch's reason; no answer from conch is exit 1", async () => {
    const refused = cli({ reply: { kind: "peer-message-refused", code: "ambiguous", error: "\"tidepool\" names 2 live sessions" } });
    expect(await refused.run("tidepool", "hi")).toBe(3);
    expect(refused.err).toEqual(["[conch] not sent: \"tidepool\" names 2 live sessions"]);
    const down = cli({ request: async () => { throw new Error("connect ENOENT /tmp/conch.sock"); } });
    expect(await down.run("lantern", "hi")).toBe(1);
    expect(down.err[0]).toContain("conch isn't answering");
    const old = cli({ reply: { kind: "session-error", error: "unknown" } });
    expect(await old.run("lantern", "hi")).toBe(1);
  });

  test("--wait prints the reply the other session ends its turn with, not its words mid-turn", async () => {
    const c = cli({
      reply: { kind: "peer-message-sent", msgId: "m1", session: "s-lantern", label: "lantern", transcriptPath: "/t/l.jsonl", cursor: "t1.0000000000000000" },
      tails: [
        { text: "Looking now…", id: "a1", midTurn: true },
        { text: "Two nits: rename x, drop y.", id: "a2", midTurn: false },
      ],
    });
    expect(await c.run("lantern", "--wait", "30", "review?")).toBe(0);
    expect(c.requests[0]).toMatchObject({ wait: true });
    expect(c.out.at(-1)).toBe("[conch] \"lantern\" answered:\nTwo nits: rename x, drop y.");
  });

  test("--wait that runs out says the answer may still come", async () => {
    const c = cli({
      reply: { kind: "peer-message-sent", msgId: "m1", session: "s-lantern", label: "lantern", transcriptPath: "/t/l.jsonl", cursor: "t1.0000000000000000" },
      tails: [{ text: "", midTurn: false }],
    });
    expect(await c.run("lantern", "--wait", "5", "review?")).toBe(0);
    expect(c.out.at(-1)).toContain("no answer from \"lantern\" in 5 s");
  });
});

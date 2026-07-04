import { test, expect } from "bun:test";
import {
  buildRouterPrompt,
  parseRouterDecision,
  matchNameAddress,
  routePrompt,
  type RouteContext,
} from "../src/router.ts";
import { normalizeLabel } from "../src/sessions.ts";
import { lastSentences } from "../src/snippet.ts";
import { loadConfig } from "../src/config.ts";

const ctx = (utterance: string, overrides: Partial<RouteContext> = {}): RouteContext => ({
  utterance,
  sessionLabel: "conch",
  replyTail: "I fixed the login bug. Want me to update the docs too?",
  otherSessions: ["dayloop", "tokenworks"],
  ...overrides,
});

function cfgWith(routerMode: "auto" | "api" | "cli" | "off" = "auto") {
  const cfg = loadConfig();
  cfg.routerMode = routerMode;
  cfg.routerTimeoutMs = 100;
  return cfg;
}

// --- buildRouterPrompt ---

test("prompt embeds context and escapes quotes/newlines safely", () => {
  const p = buildRouterPrompt(ctx('he said "run it"\nnow', { replyTail: 'tail with "quotes"' }));
  expect(p).toContain('"conch"');
  expect(p).toContain(JSON.stringify('he said "run it"\nnow'));
  expect(p).toContain(JSON.stringify('tail with "quotes"'));
  expect(p).toContain("dayloop, tokenworks");
});

test("prompt renders (none) for no other sessions and (unavailable) for no tail", () => {
  const p = buildRouterPrompt(ctx("do the thing", { otherSessions: [], replyTail: "" }));
  expect(p).toContain("(none)");
  expect(p).toContain('"(unavailable)"');
});

// --- parseRouterDecision ---

test("parses clean JSON", () => {
  expect(parseRouterDecision('{"action":"discard"}')).toEqual({ action: "discard", via: "llm" });
});

test("parses fenced JSON", () => {
  expect(parseRouterDecision('```json\n{"action":"send"}\n```')).toEqual({ action: "send", via: "llm" });
});

test("parses JSON buried in prose", () => {
  const raw = 'Sure! Here is the routing: {"action":"redirect","target":"dayloop","cleaned":"fix it"} Hope that helps.';
  expect(parseRouterDecision(raw)).toEqual({ action: "redirect", target: "dayloop", cleaned: "fix it", via: "llm" });
});

test("unknown action returns null; redirect without target downgrades to send", () => {
  expect(parseRouterDecision('{"action":"reply"}')).toBeNull();
  expect(parseRouterDecision("total garbage")).toBeNull();
  expect(parseRouterDecision('{"action":"redirect"}')).toEqual({ action: "send", via: "llm" });
  expect(parseRouterDecision('{"action":"redirect","target":"  "}')).toEqual({ action: "send", via: "llm" });
});

test("empty cleaned is treated as absent", () => {
  expect(parseRouterDecision('{"action":"send","cleaned":""}')).toEqual({ action: "send", via: "llm" });
});

// --- matchNameAddress ---

test("name-address prefix matches and strips", () => {
  expect(matchNameAddress("Hey dayloop, fix the test", ["dayloop"])).toEqual({
    label: "dayloop",
    cleaned: "fix the test",
  });
});

test("whisper splitting the name still matches", () => {
  expect(matchNameAddress("hey day loop try the other approach", ["dayloop"])?.label).toBe("dayloop");
  expect(matchNameAddress("hey day loop try the other approach", ["dayloop"])?.cleaned).toBe("try the other approach");
});

test("bare address returns empty cleaned (voice wake)", () => {
  expect(matchNameAddress("Hey dayloop.", ["dayloop"])).toEqual({ label: "dayloop", cleaned: "" });
});

test("mid-utterance mentions never match; unknown names never match", () => {
  expect(matchNameAddress("the dayloop build is broken", ["dayloop"])).toBeNull();
  expect(matchNameAddress("hey blueprint, do it", ["dayloop"])).toBeNull();
});

// --- routePrompt orchestration (mock invoke) ---

test("short utterances skip the LLM and send", async () => {
  let called = false;
  const d = await routePrompt(cfgWith(), ctx("yes do it"), async () => {
    called = true;
    return '{"action":"discard"}';
  });
  expect(d).toEqual({ action: "send", cleaned: "yes do it", via: "local" });
  expect(called).toBe(false);
});

test("name-addressed utterances redirect locally without the LLM", async () => {
  let called = false;
  const d = await routePrompt(cfgWith(), ctx("hey dayloop, run the tests again please"), async () => {
    called = true;
    return "{}";
  });
  expect(d.action).toBe("redirect");
  expect(d.target).toBe("dayloop");
  expect(d.via).toBe("local");
  expect(called).toBe(false);
});

test("self-address strips the prefix and routes the remainder", async () => {
  const d = await routePrompt(cfgWith(), ctx("hey conch, please rerun the whole failing suite now"), async () =>
    '{"action":"send"}',
  );
  expect(d.action).toBe("send");
  expect(d.cleaned).toBe("please rerun the whole failing suite now");
});

test("bare self-address discards locally (mic is already here)", async () => {
  const d = await routePrompt(cfgWith(), ctx("hey conch"), async () => '{"action":"send"}');
  expect(d).toEqual({ action: "discard", via: "local" });
});

test("llm decision passes through with cleaned fallback", async () => {
  const d = await routePrompt(cfgWith(), ctx("okay so let us try a totally different approach here"), async () =>
    '{"action":"send"}',
  );
  expect(d.action).toBe("send");
  expect(d.via).toBe("llm");
  expect(d.cleaned).toBe("okay so let us try a totally different approach here");
});

test("invoke throwing fails open to send", async () => {
  const d = await routePrompt(cfgWith(), ctx("this is a longer real prompt about the parser"), async () => {
    throw new Error("boom");
  });
  expect(d).toEqual({ action: "send", cleaned: "this is a longer real prompt about the parser", via: "fallback" });
});

test("malformed llm output fails open to send", async () => {
  const d = await routePrompt(cfgWith(), ctx("another long utterance that goes to the model"), async () => "not json at all");
  expect(d.action).toBe("send");
  expect(d.via).toBe("fallback");
});

test("router off sends without invoking", async () => {
  let called = false;
  const d = await routePrompt(cfgWith("off"), ctx("a long utterance that would otherwise route"), async () => {
    called = true;
    return '{"action":"discard"}';
  });
  expect(d.action).toBe("send");
  expect(called).toBe(false);
});

// --- helpers ---

test("normalizeLabel makes spoken variants comparable", () => {
  expect(normalizeLabel("Day Loop!")).toBe("dayloop");
  expect(normalizeLabel("dayloop-feature-work")).toBe("dayloopfeaturework");
});

test("lastSentences takes the tail under the cap", () => {
  expect(lastSentences("One. Two. Three. Four.", 2, 100)).toBe("Three. Four.");
  expect(lastSentences("One. Two.", 5, 100)).toBe("One. Two.");
  expect(lastSentences("One. Two. Three.", 2, 8)).toBe(". Three.");
});

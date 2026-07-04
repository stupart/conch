import type { Config } from "./config.ts";
import { normalizeLabel } from "./sessions.ts";

/**
 * Intent router: decides whether a would-be prompt utterance is actually
 * meant for the session. Motivated by a live incident — the user talking to
 * someone in the room was captured and injected, interrupting a turn.
 *
 * Layering: the local grammar (commands.ts) runs first and is untouched.
 * Only "prompt" classifications reach routePrompt, and even then two local
 * fast paths avoid the LLM entirely:
 *  - name-addressing ("hey dayloop, ...") -> redirect, zero latency
 *  - short utterances (<= 3 significant words) -> send verbatim; they're
 *    dominantly real answers ("yes", "the second one") and too small for
 *    the LLM to judge better than chance
 *
 * Failure policy: FAIL-OPEN. A dropped real prompt is invisible and
 * corrodes trust; a bad injection is visible and correctable. Router-down
 * behavior equals pre-router conch.
 */

export type RouteAction = "send" | "discard" | "redirect";

export interface RouteDecision {
  action: RouteAction;
  target?: string;
  cleaned?: string;
  via: "local" | "llm" | "fallback";
}

export interface RouteContext {
  utterance: string;
  sessionLabel: string;
  /** last sentences of the session's final message, markdown-stripped */
  replyTail: string;
  otherSessions: string[];
}

export type RouterInvoke = (prompt: string, timeoutMs: number) => Promise<string>;

const SIGNIFICANT_WORDS_MAX = 3;

export async function routePrompt(
  cfg: Config,
  ctx: RouteContext,
  invoke: RouterInvoke | null,
): Promise<RouteDecision> {
  const address = matchNameAddress(ctx.utterance, [ctx.sessionLabel, ...ctx.otherSessions]);
  if (address && normalizeLabel(address.label) !== normalizeLabel(ctx.sessionLabel)) {
    return { action: "redirect", target: address.label, cleaned: address.cleaned, via: "local" };
  }
  if (address && !address.cleaned) {
    return { action: "discard", via: "local" }; // bare "hey <current session>" — mic is already here
  }
  const text = address?.cleaned || ctx.utterance; // self-address ("hey conch, ...") just strips the prefix

  if (!invoke || cfg.routerMode === "off") return { action: "send", cleaned: text, via: "local" };
  if (significantWordCount(text) <= SIGNIFICANT_WORDS_MAX) {
    return { action: "send", cleaned: text, via: "local" };
  }

  try {
    const raw = await invoke(buildRouterPrompt({ ...ctx, utterance: text }), cfg.routerTimeoutMs);
    const decision = parseRouterDecision(raw);
    if (!decision) return { action: "send", cleaned: text, via: "fallback" };
    if (!decision.cleaned) decision.cleaned = text;
    return decision;
  } catch {
    return { action: "send", cleaned: text, via: "fallback" };
  }
}

export function buildRouterPrompt(ctx: RouteContext): string {
  const others = ctx.otherSessions.length ? ctx.otherSessions.join(", ") : "(none)";
  return `You are the intent router for a hands-free voice interface to Claude Code. A microphone opened after the coding session "${ctx.sessionLabel}" finished a turn and captured one utterance. The mic sometimes catches speech NOT meant for the assistant: the user talking to another person in the room, a phone call, or TV or media audio.

Session "${ctx.sessionLabel}" last said: ${JSON.stringify(ctx.replyTail || "(unavailable)")}
Other live sessions: ${others}
Transcribed utterance: ${JSON.stringify(ctx.utterance)}

Choose exactly one action:
- "send" — the user is talking to the assistant: an instruction, an answer to what the session said, a question, or a follow-up. A brand-new task on a completely different topic is still "send" — topic change alone is NOT evidence of room talk.
- "redirect" — the utterance addresses a different live session by name. Set "target" to that session's name exactly as listed above and strip the address phrase from "cleaned". Only redirect to a listed session.
- "discard" — clearly not addressed to the assistant. Signals: addressing a person by name, social second-person conversation with no coding content, phone-call cadence, TV or music or scripted dialogue, or a fragment with no actionable content. Require clear evidence; if unsure, choose "send".

"cleaned" — the utterance with disfluencies removed: leading and trailing fillers (um, uh, okay so, sorry), false starts, repeated words, self-corrections. Keep the user's own words in their own order. NEVER paraphrase, summarize, complete a thought, or fix grammar. Omit "cleaned" entirely if there is nothing to remove.

Respond with ONLY a JSON object and no other text:
{"action": "send" | "discard" | "redirect", "target": "<session name, redirect only>", "cleaned": "<edited utterance, only if edited>"}`;
}

/** Tolerant parser: plain JSON, fenced JSON, or JSON buried in prose. */
export function parseRouterDecision(raw: string): RouteDecision | null {
  for (const candidate of jsonCandidates(raw)) {
    let obj: any;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    if (obj.action !== "send" && obj.action !== "discard" && obj.action !== "redirect") return null;
    const decision: RouteDecision = { action: obj.action, via: "llm" };
    if (typeof obj.target === "string" && obj.target.trim()) decision.target = obj.target.trim();
    if (typeof obj.cleaned === "string" && obj.cleaned.trim()) decision.cleaned = obj.cleaned.trim();
    if (decision.action === "redirect" && !decision.target) decision.action = "send"; // can't redirect nowhere
    return decision;
  }
  return null;
}

function* jsonCandidates(raw: string): Generator<string> {
  const trimmed = raw.trim();
  yield trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) yield fenced[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) yield trimmed.slice(first, last + 1);
}

/**
 * Local name-addressing: "hey dayloop, fix the test" -> {label, cleaned}.
 * Prefix-only (never matches mid-utterance mentions); space-insensitive so
 * whisper's "day loop" matches "dayloop". Bare address ("hey dayloop")
 * returns cleaned: "" — the caller treats that as a voice wake.
 */
export function matchNameAddress(
  utterance: string,
  labels: string[],
): { label: string; cleaned: string } | null {
  const words = utterance
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  let start = 0;
  if (words[start] === "hey" || words[start] === "okay" || words[start] === "ok") start++;
  if (start >= words.length) return null;

  for (const label of labels) {
    const target = normalizeLabel(label);
    if (!target) continue;
    for (let take = 1; take <= 3 && start + take <= words.length; take++) {
      const joined = words.slice(start, start + take).join("");
      if (joined === target) {
        // reconstruct the remainder from the ORIGINAL text to preserve casing/punctuation
        const consumed = start + take;
        const original = utterance.split(/\s+/).filter(Boolean);
        const cleaned = original
          .slice(consumed)
          .join(" ")
          .replace(/^[,.\-—:;]+\s*/, "")
          .trim();
        return { label, cleaned };
      }
    }
  }
  return null;
}

function significantWordCount(text: string): number {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Resolve how to reach Haiku, once at daemon startup. Returns null when
 * off/unavailable. `auto` = api-if-key-else-OFF: the cli path measured
 * 7-20s per call live, which is worse in the hot path than the room-talk
 * risk it guards against — so cli is explicit opt-in only. Local fast
 * paths (name-addressing, short-utterance bypass) work in every mode.
 */
export function resolveInvoke(cfg: Config): { invoke: RouterInvoke; mode: "api" | "cli" } | null {
  if (cfg.routerMode === "off") return null;
  const key = cfg.routerApiKey;
  if ((cfg.routerMode === "api" || cfg.routerMode === "auto") && key) {
    return { invoke: makeApiInvoke(cfg, key), mode: "api" };
  }
  if (cfg.routerMode === "cli" && Bun.which(cfg.claudeBin)) {
    return { invoke: makeCliInvoke(cfg), mode: "cli" };
  }
  return null;
}

function makeApiInvoke(cfg: Config, key: string): RouterInvoke {
  return async (prompt, timeoutMs) => {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.routerModel,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`router api ${res.status}`);
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    return (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  };
}

function makeCliInvoke(cfg: Config): RouterInvoke {
  return async (prompt, timeoutMs) => {
    // prompt goes immediately after -p: variadic flags like --mcp-config
    // greedily consume trailing positionals (observed live)
    const proc = Bun.spawn(
      [cfg.claudeBin, "-p", prompt, "--model", "haiku", "--no-session-persistence"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const out = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const code = await proc.exited;
    if (code !== 0 && !out.trim()) throw new Error(`router cli exit ${code}`);
    return out;
  };
}

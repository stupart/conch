/**
 * Local voice-command grammar — instant, no LLM in the path.
 * Only bare commands match; anything else is a prompt for the session.
 * (Intentionally no "no"/"stop" here: those are plausible real replies.)
 */

export type VoiceIntent = "continue" | "repeat" | "discard" | "prompt";

/**
 * Leading spoken address: "hey <name>[,.] rest". Raw text in — command
 * normalization strips the "hey" and punctuation this grammar depends on.
 *
 * A delimiter makes the name boundary explicit. Without one, retain at least
 * one content word and offer up to three-word names longest-first; a single
 * word may stand alone as a bare address candidate.
 */
export function parseNameAddress(text: string): Array<{ name: string; rest: string }> {
  const prefix = text.match(/^\s*hey\s+/i);
  if (!prefix) return [];
  const body = text.slice(prefix[0].length).trim();
  if (!body) return [];

  const delimiterAt = body.search(/[,.:]/);
  if (delimiterAt !== -1) {
    const name = body.slice(0, delimiterAt).trim();
    const nameWords = name.split(/\s+/).filter(Boolean);
    // "within the first 4 words" includes "hey", so spoken names are 1..3 words.
    if (nameWords.length >= 1 && nameWords.length <= 3) {
      return [{ name, rest: body.slice(delimiterAt + 1).trim() }];
    }
  }

  const words = [...body.matchAll(/\S+/g)];
  const maxNameWords = words.length === 1
    ? 1
    : Math.min(3, words.length - 1);
  const candidates: Array<{ name: string; rest: string }> = [];
  for (let count = maxNameWords; count >= 1; count--) {
    const last = words[count - 1]!;
    const end = last.index! + last[0].length;
    candidates.push({
      name: body.slice(0, end).trim(),
      rest: body.slice(end).trim(),
    });
  }
  return candidates;
}

const CONTINUE = new Set([
  "continue", "keep going", "go on", "keep reading",
  "read the rest", "read me the rest", "read more", "more",
]);
const REPEAT = new Set(["repeat", "repeat that", "say that again", "say it again", "what was that"]);
const DISCARD = new Set([
  "cancel", "never mind", "nevermind", "scratch that", "disregard", "disregard that",
  "no response", "no response needed", "no reply", "no reply needed",
  "stop listening", "stop recording", "close the mic", "all good",
  // bare "stop" said to an already-finished session is the user talking to
  // conch, not a prompt — injecting it was observed live and helped nobody
  "stop", "stop reading", "stop talking",
]);

// Only matched in the brief gaps between read-aloud chunks — context makes
// looser phrases safe here ("got it" mid-reading can only mean "stop").
const STOP_READING = new Set([
  "stop", "stop reading", "stop talking", "okay stop", "ok stop",
  "enough", "that's enough", "got it", "thanks", "thank you", "skip",
]);

// In dictation-accumulate mode these submit the held prompt. Deliberately
// short/decisive phrases you wouldn't dictate as content mid-thought.
const SEND = new Set([
  "send", "send it", "sent it", "send that", "go", "go ahead", "submit", "submit it",
  "that's it", "thats it", "okay send", "ok send", "okay send it", "send message",
  "go for it", "fire away", "run it",
]);

export function isSendCommand(text: string): boolean {
  return SEND.has(normalize(text));
}

// Said at the tail of the same breath ("...next part that is. Send.") the word
// never reached isSendCommand, which only ever sees a WHOLE transcript — so it
// landed in the prompt as content. Whisper only starts a new chunk on a real
// pause, and nobody pauses before saying "send".
//
// The sentence boundary is what makes this safe to strip: "tell him to send it"
// has no full stop before the phrase, so it stays content. Phrases that read as
// plausible instructions after a full stop ("go", "run it", "fire away") are
// deliberately NOT here — losing a real instruction is worse than a stray word.
const TRAILING_SEND = new Set([
  "send", "send it", "send that", "send message", "submit", "submit it",
  "okay send", "ok send", "okay send it", "that's it", "thats it", "go ahead",
]);

// Said at the tail, these mean "and don't reply to any of that". Injected as a
// prompt they produce the exact OPPOSITE — the agent answers, and burns a turn.
// Only the explicit no-response family is here: unlike "cancel" or "never mind",
// these are never something you'd dictate as content, and a false positive here
// throws away what you just said.
const TRAILING_DISCARD = new Set([
  "no response", "no response needed", "no response necessary",
  "no reply", "no reply needed", "no reply necessary",
]);

function splitTrailingCommand(text: string, phrases: Set<string>): string | null {
  const match = /^([\s\S]*[.!?,])\s*([a-z' ]+?)\s*[.!?]*\s*$/i.exec(text);
  if (!match) return null;
  const body = match[1]!.trim().replace(/,$/, "");
  if (!body || !phrases.has(normalize(match[2]!))) return null;
  return body;
}

/** The prompt with a trailing spoken send-phrase removed, or null if absent. */
export function splitTrailingSend(text: string): string | null {
  return splitTrailingCommand(text, TRAILING_SEND);
}

/** The prompt preceding a trailing "no response needed", or null if absent. */
export function splitTrailingDiscard(text: string): string | null {
  return splitTrailingCommand(text, TRAILING_DISCARD);
}

/** Classifier for the short listen-gaps between read-aloud chunks. */
export function classifyReadingGap(text: string): "stop" | VoiceIntent {
  const norm = normalize(text);
  // "stop, no response needed" in one breath: stop reading AND close the mic
  // with no reply — saves saying "stop" then "no response needed" separately.
  if (/\b(no response|no reply|nothing|don'?t respond|no answer)\b/.test(norm) && /\b(stop|nope?|no)\b/.test(norm)) {
    return "discard";
  }
  if (STOP_READING.has(norm)) return "stop";
  // During reading, an utterance that BEGINS with a stop word is you cutting
  // in ("stop, for some reason it..."), not a prompt — the trailing words are
  // just you continuing to talk. Injecting them was observed live.
  if (/^(stop|okay stop|ok stop|enough|hold on|wait)\b/.test(norm)) return "stop";
  return classify(text);
}

// Spoken commands arrive wrapped in fillers ("Oh, continue.") — strip the
// wrapping, but never down to nothing, so a bare "Yes." stays a prompt.
const LEADING_FILLERS = new Set(["oh", "okay", "ok", "um", "uh", "ah", "hey", "so", "yeah", "yes", "and", "please", "now", "alright"]);
const TRAILING_FILLERS = new Set(["please", "now", "thanks"]);

function normalize(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  while (words.length > 1 && LEADING_FILLERS.has(words[0]!)) words.shift();
  while (words.length > 1 && TRAILING_FILLERS.has(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

export function classify(text: string): VoiceIntent {
  const norm = normalize(text);
  if (CONTINUE.has(norm)) return "continue";
  if (REPEAT.has(norm)) return "repeat";
  if (DISCARD.has(norm)) return "discard";
  return "prompt";
}

/**
 * An explicit question for conch itself, not the active Claude session.
 * Keep this on the raw transcript: punctuation is part of the address grammar.
 */
export function parseQuery(text: string): string | null {
  const match = text.match(
    /^\s*(?:(?:okay|ok)\s*,?\s*)?(?:hey\s+)?conch(?:\s*[,.:]\s*|\s+)(.+?)\s*$/i,
  );
  const question = match?.[1]?.trim() ?? "";
  return question || null;
}

// Permission prompts get a narrow yes/no vocabulary: "yes" presses Enter
// (accepts the highlighted option), "no" presses Escape. Anything else is
// deliberately unrecognized — free text near a permission dialog is risky.
const APPROVE = new Set([
  "yes", "yeah", "yep", "yup", "sure", "okay", "ok", "confirm", "approve", "approved",
  "allow", "allow it", "accept", "go ahead", "do it", "proceed", "sounds good",
]);
const DENY = new Set([
  "no", "nope", "deny", "denied", "reject", "decline", "cancel", "stop",
  "dont", "do not", "dont do it", "escape",
]);

export function classifyApproval(text: string): "approve" | "deny" | null {
  const norm = normalize(text);
  if (APPROVE.has(norm)) return "approve";
  if (DENY.has(norm)) return "deny";
  return null;
}

/**
 * How much of `heard` is words from `spoken`? Used as the barge-in echo
 * guard: if the mic captured the Mac's own reading (speaker bleed), nearly
 * every word of the transcript appears in the chunk being read.
 */
export function wordOverlapRatio(heard: string, spoken: string): number {
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const heardWords = words(heard);
  if (!heardWords.length) return 0;
  const spokenSet = new Set(words(spoken));
  const hits = heardWords.filter((w) => spokenSet.has(w)).length;
  return hits / heardWords.length;
}

/**
 * Local voice-command grammar — instant, no LLM in the path.
 * Only bare commands match; anything else is a prompt for the session.
 * (Intentionally no "no"/"stop" here: those are plausible real replies.)
 */

export type VoiceIntent = "continue" | "repeat" | "discard" | "prompt";

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

/** Classifier for the short listen-gaps between read-aloud chunks. */
export function classifyReadingGap(text: string): "stop" | VoiceIntent {
  const norm = normalize(text);
  if (STOP_READING.has(norm)) return "stop";
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

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
const DISCARD = new Set(["cancel", "never mind", "nevermind", "scratch that", "disregard", "disregard that"]);

// Spoken commands arrive wrapped in fillers ("Oh, continue.") — strip the
// wrapping, but never down to nothing, so a bare "Yes." stays a prompt.
const LEADING_FILLERS = new Set(["oh", "okay", "ok", "um", "uh", "ah", "hey", "so", "yeah", "yes", "and", "please", "now", "alright"]);
const TRAILING_FILLERS = new Set(["please", "now", "thanks"]);

export function classify(text: string): VoiceIntent {
  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ");
  while (words.length > 1 && LEADING_FILLERS.has(words[0]!)) words.shift();
  while (words.length > 1 && TRAILING_FILLERS.has(words[words.length - 1]!)) words.pop();
  const norm = words.join(" ");
  if (CONTINUE.has(norm)) return "continue";
  if (REPEAT.has(norm)) return "repeat";
  if (DISCARD.has(norm)) return "discard";
  return "prompt";
}

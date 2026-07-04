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

export function classify(text: string): VoiceIntent {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (CONTINUE.has(norm)) return "continue";
  if (REPEAT.has(norm)) return "repeat";
  if (DISCARD.has(norm)) return "discard";
  return "prompt";
}

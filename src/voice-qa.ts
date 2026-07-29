import { parseQuery } from "./commands.ts";
import { lastAssistantText, stripMarkdown } from "./snippet.ts";

const QA_PROMPT = [
  "Answer the question from this coding-assistant reply excerpt in one or two spoken sentences.",
  "Use plain words and no markdown. If the excerpt does not say, say you cannot tell from the last reply.",
].join(" ");

export interface VoiceQaAskOptions {
  timeoutMs?: number;
  maxChars?: number;
}

export type VoiceQaAsk = (
  prompt: string,
  options?: VoiceQaAskOptions,
) => Promise<string | null>;

export interface VoiceQaDependencies {
  askClaude: VoiceQaAsk;
  speak(text: string): Promise<void>;
  inject(text: string): Promise<boolean>;
  readLastAssistantText?: (transcriptPath: string) => Promise<string>;
  canContinue?: () => boolean | Promise<boolean>;
}

/**
 * Route one prompt-shaped utterance. Once the opt-in query prefix matches,
 * every outcome is consumed here and the session injector is unreachable.
 */
export async function routeVoicePrompt(
  enabled: boolean,
  text: string,
  transcriptPath: string | undefined,
  dependencies: VoiceQaDependencies,
): Promise<boolean> {
  const question = enabled ? parseQuery(text) : null;
  if (!question) return dependencies.inject(text);

  const canContinue = dependencies.canContinue ?? (() => true);
  try {
    if (!(await canContinue())) return false;
  } catch {
    return false;
  }

  let context = "";
  try {
    context = transcriptPath
      ? stripMarkdown(
        await (dependencies.readLastAssistantText ?? lastAssistantText)(transcriptPath),
      ).slice(-6000)
      : "";
  } catch {
    // A missing or changing transcript is a normal spoken failure, never a
    // reason to fall through and inject the question into the coding session.
  }

  let answer: string | null = null;
  let modelFailed = false;
  if (context) {
    try {
      // No timeoutMs here — the injected askClaude (askHaiku) carries the
      // live haiku-timeout; passing one would override the setting.
      answer = await dependencies.askClaude(
        `${QA_PROMPT}\n\nReply excerpt:\n${context}\n\nQuestion: ${question}`,
        { maxChars: 300 },
      );
    } catch {
      answer = null;
    }
    // Had a transcript to read but got nothing back = the fast model failed
    // (timed out / errored). Say so plainly — a canned generic line is no
    // answer to a specific question.
    if (answer === null) modelFailed = true;
  }

  try {
    if (!(await canContinue())) return false;
  } catch {
    return false;
  }
  const failureLine = modelFailed
    ? "Something went wrong — I couldn't get an answer."
    : "I couldn't check that.";
  await dependencies.speak(answer ?? failureLine);
  return true;
}

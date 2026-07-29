export const FAST_MODEL = "claude-haiku-4-5";

export interface AskClaudeOptions {
  timeoutMs?: number;
  maxChars?: number;
  bin?: string;
}

export type AskClaude = (
  prompt: string,
  options?: AskClaudeOptions,
) => Promise<string | null>;

/**
 * One isolated fast-model shell-out. Failure is an ordinary null result so
 * every voice feature can keep a deterministic, lossless fallback.
 */
export async function askClaude(
  prompt: string,
  options: AskClaudeOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxChars = options.maxChars ?? 400;
  const bin = options.bin ?? "claude";
  let killProcess: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const proc = Bun.spawn([bin, "-p", "--model", FAST_MODEL], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, CONCH_INTERNAL: "1" },
    });
    killProcess = () => proc.kill();
    const output = new Response(proc.stdout).text().catch(() => "");
    proc.stdin.write(prompt);
    proc.stdin.end();

    const outcome = await Promise.race([
      proc.exited.then((code) => ({ kind: "exit" as const, code })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "timeout" }),
          Math.max(0, timeoutMs),
        );
      }),
    ]);
    if (outcome.kind === "timeout") {
      killProcess();
      return null;
    }
    if (outcome.code !== 0) return null;

    const normalized = (await output).replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    const capped = normalized.slice(0, Math.max(0, Math.floor(maxChars))).trim();
    return capped || null;
  } catch {
    try {
      killProcess?.();
    } catch {}
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

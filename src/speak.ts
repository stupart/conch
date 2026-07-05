import type { Config } from "./config.ts";

/** Play the attention bell without blocking. */
export function bell(cfg: Config): void {
  if (!cfg.bell) return;
  const proc = Bun.spawn(["afplay", cfg.bellSound], { stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

/** Speak text aloud. Await it when the mic opens next (daemon); fire-and-forget otherwise (hook). */
export function speak(cfg: Config, text: string): Promise<number> {
  if (!cfg.speak || !text) return Promise.resolve(0);
  const args = ["say", ...sayFlags(cfg), "--", text];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  proc.unref();
  current = proc; // spacebar-stop must reach plain speech too
  return proc.exited;
}

/** Speak with a kill switch — barge-in cancels playback mid-sentence. */
export function speakCancellable(cfg: Config, text: string): { done: Promise<void>; cancel: () => void } {
  if (!cfg.speak || !text) return { done: Promise.resolve(), cancel() {} };
  const args = ["say", ...sayFlags(cfg), "--", text];
  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
  current = proc;
  return { done: proc.exited.then(() => {}), cancel: () => proc.kill() };
}

function sayFlags(cfg: Config): string[] {
  return [...(cfg.voice ? ["-v", cfg.voice] : []), ...(cfg.sayRate > 0 ? ["-r", String(cfg.sayRate)] : [])];
}

let current: ReturnType<typeof Bun.spawn> | null = null;

/** Kill any in-flight speech — daemon shutdown must not orphan a talking `say` (observed: restart mid-read left two voices overlapping). */
export function stopSpeaking(): void {
  current?.kill();
  current = null;
}

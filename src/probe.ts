/** How long a probe may run, unless its caller says otherwise, before it counts as no answer. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * One external probe, off the thread and on a leash.
 *
 * These ran through `Bun.spawnSync`, and Bun runs the daemon on ONE thread: for
 * as long as `lsof` or `ps` took, voice, injection and publication were frozen —
 * not waiting their turn, unable to run at all. Awaiting the child hands the
 * loop back instead.
 *
 * The timeout is the other half. A probe blocked on a wedged mount would
 * otherwise hold its caller open forever, and every caller already knows how to
 * read "no answer": in Codex discovery a null lock probe falls back to presence
 * and a null process table leaves holders unnamed; in the screen context a port
 * nobody answered for names no session. Slow is reported as unknown, which is
 * true, rather than waited on.
 *
 * `ok` lists the exit codes that are answers rather than failures — `lsof`
 * exits 1 for "none of these are open", which is a result.
 */
export async function probeCommand(argv: string[], ok: readonly number[], timeoutMs = PROBE_TIMEOUT_MS): Promise<string | null> {
  try {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone; the exit observation below still settles */ }
    }, timeoutMs);
    try {
      const text = await new Response(child.stdout).text();
      // A killed child exits on a signal, so its code is never in `ok`: a
      // timed-out probe reports unknown by the same path a failed one does.
      return ok.includes(await child.exited) ? text : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

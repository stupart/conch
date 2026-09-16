/**
 * The tripwire that keeps `bun test` off Tyler's live configuration.
 *
 * Agents run this suite dozens of times a day from throwaway worktrees. One
 * default resolving to a real path would rewrite the hooks in
 * `~/.claude/settings.json` to point at a worktree that is deleted an hour
 * later — conch would stop working for him with no visible cause. So the
 * failure mode is inverted: instead of hoping no test writes there, the run
 * refuses to start unless every such path is provably inside the temp root.
 *
 * Kept side-effect-free and separate from `preload.ts` so a test can import it
 * and prove it bites without re-running the preload's setup.
 */
export function assertUnderTestRoot(
  paths: Readonly<Record<string, string>>,
  root: string,
): void {
  for (const [name, path] of Object.entries(paths)) {
    if (path === root || path.startsWith(`${root}/`)) continue;
    throw new Error(
      `conch test isolation broken: ${name} resolves to ${path}, which is outside `
        + `the test root ${root}. Running the suite would write to the real `
        + `configuration. Redirect it through CONCH_HOME in test/preload.ts.`,
    );
  }
}

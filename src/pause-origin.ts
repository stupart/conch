export type PauseOrigin = "user" | "agent";

/** Why a resume was refused: conch is paused, and no agent made that pause. */
export type ResumeRefusal = "user-paused";

/**
 * Which pauses an AGENT made — every other pause is the person's.
 *
 * `conch_mode resume` from an agent carried no origin, so any session could
 * put the Mac back into auto — mic and voice included — while you were in a
 * meeting you had silenced it for (audit 5d). The physical key, the Mac's
 * toggle, the phone and `conch pause` send no origin and count as you; the MCP
 * tools say `agent`. An agent may undo a pause it made, never anyone else's.
 *
 * Tracking the agent's pauses rather than the person's makes the safe answer
 * the default: a manual mode restored from state.json at boot, or a meeting
 * autopause, has no record here and so is not the agent's to undo.
 *
 * Keyed by session id; "" is the whole daemon.
 */
export class PauseOriginLedger {
  readonly #agentOwned = new Set<string>();

  /**
   * A pause edge. An agent owns a pause only if it made it: pausing what was
   * already paused changes nothing, so it cannot launder yours into its own.
   */
  paused(sessionId: string, origin: PauseOrigin | undefined, wasPaused: boolean): void {
    if (origin !== "agent") this.#agentOwned.delete(sessionId);
    else if (!wasPaused) this.#agentOwned.add(sessionId);
  }

  resumed(sessionId: string): void {
    this.#agentOwned.delete(sessionId);
  }

  agentOwns(sessionId: string): boolean {
    return this.#agentOwned.has(sessionId);
  }

  /** Why this origin may not resume this scope now, or null when it may. */
  refusal(
    sessionId: string,
    origin: PauseOrigin | undefined,
    state: { globalPaused: boolean; sessionPaused: boolean },
  ): ResumeRefusal | null {
    if (origin !== "agent") return null;
    // A scoped resume out of the GLOBAL pause exempts that session from it,
    // which is the same hole — so the global pause is checked for both.
    if (state.globalPaused && !this.agentOwns("")) return "user-paused";
    if (sessionId && state.sessionPaused && !this.agentOwns(sessionId)) return "user-paused";
    return null;
  }
}

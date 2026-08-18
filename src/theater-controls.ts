export interface TheaterControlCallbacks {
  manualSessionId(): string | null;
  globalPaused(): boolean;
  sessionPaused(sessionId: string): boolean;
  setGlobalPaused(next: boolean): void;
  setSessionPaused(sessionId: string, next: boolean): void;
}

/**
 * Dispatch only context-sensitive theater controls. Returning false leaves
 * navigation, talk/stop, settings, and every other key with the daemon.
 */
export function dispatchTheaterControlKey(
  input: string,
  callbacks: TheaterControlCallbacks,
): boolean {
  if (input !== "p") return false;

  const sessionId = callbacks.manualSessionId();
  if (sessionId) {
    callbacks.setSessionPaused(sessionId, !callbacks.sessionPaused(sessionId));
  } else {
    callbacks.setGlobalPaused(!callbacks.globalPaused());
  }
  return true;
}

export const THEATER_KEYBAR =
  "  \x1b[2m↑↓ park · i prompt · space dictate · x interrupt · p auto/manual · ⏎ actions · n new · u restore · ? help · q quit\x1b[0m";

export const FOOTER_KEYBAR =
  "  \x1b[2m↑↓ park · space talk · p auto/manual · ? help · q quit\x1b[0m";

export const DASHBOARD_HELP_KEYS =
  "  \x1b[1mkeys\x1b[0m   \x1b[36m↑↓\x1b[0m park   \x1b[36mi\x1b[0m prompt   \x1b[36mx\x1b[0m interrupt   \x1b[36m⏎\x1b[0m actions   \x1b[36mn\x1b[0m new   \x1b[36mu\x1b[0m restore   \x1b[36mr\x1b[0m recite   \x1b[36mspace\x1b[0m dictate / stop   \x1b[36mp\x1b[0m auto/manual   \x1b[36ml\x1b[0m logs   \x1b[36mv\x1b[0m voices   \x1b[36m?\x1b[0m help   \x1b[36mq\x1b[0m quit";

export const DASHBOARD_HELP_CONTROLS =
  "  \x1b[2mparked cursor stays put: \x1b[36mesc\x1b[0m\x1b[2m releases it   ·   \x1b[36mp\x1b[0m\x1b[2m makes that session manual   ·   no cursor: it changes the whole app   ·   manual HOLDS + replays\x1b[0m";

/** Full dashboard help, ready for logAbove(). */
export function dashboardHelpText(): string {
  return [
    "",
    DASHBOARD_HELP_KEYS,
    DASHBOARD_HELP_CONTROLS,
    "  \x1b[1mactions\x1b[0m park a session + \x1b[36menter\x1b[0m · voice · prioritize · rename · dismiss \x1b[2m(session keeps running)\x1b[0m · close \x1b[2m(clean Ctrl-D)\x1b[0m · \x1b[36mu\x1b[0m restore",
    "  \x1b[1mprompt\x1b[0m  \x1b[36mi\x1b[0m opens one targeted line · enter sends · esc cancels · questions use 1-9 (multi-select: enter submits)",
    "  \x1b[1mmouse\x1b[0m  wheel scrolls the pane · drag selects + copies · CONCH_NO_MOUSE=1 restores native terminal selection",
    '  \x1b[1mvoice\x1b[0m  \x1b[36m"continue"\x1b[0m read more   \x1b[36m"repeat"\x1b[0m again   \x1b[36m"stop"\x1b[0m end reading   \x1b[36m"no response needed"\x1b[0m close mic',
    "  \x1b[1msettings\x1b[0m  conch settings \x1b[2m(list)\x1b[0m · set <key> <value> · get <key> · unset <key>   \x1b[2m— e.g. conch set end-silence 2.5\x1b[0m",
    "  \x1b[1mcli\x1b[0m    conch wake [name] · sessions · voice <session> <voice> · pause · resume · doctor",
    "",
  ].join("\n");
}

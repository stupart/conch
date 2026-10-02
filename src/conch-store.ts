import { join } from "node:path";
import { conchHome } from "./home.ts";

/**
 * conch's own store of files it keeps for the apps and the phone: `~/Library/Application Support/conch`. Copies of
 * deliverables that sat in a temp folder (`deliverables/`, deliverable-store.ts) and pictures of pages `conch_capture`
 * drew (`captures/`, capture-folder.ts) live under it.
 *
 * Not the temp folder: macOS empties /tmp at every restart and sweeps the per-user folder of files nobody opened for
 * days, and these are what the user opens days later. Not `~/.config/conch` either, beside the settings: that is a
 * hidden folder, which the publish rule refuses outright (`checkLocalFile`), so nothing kept there could reach the
 * apps or the phone. This one root is the exception that rule makes beyond a session's folders and the temp folders,
 * because only conch writes in it. One root, so the two stores can't drift apart in what the rule lets through.
 *
 * The Mac app's own data lives under its bundle id (`ai.blueprintstudio.conch`), not here. A leaf module, so the
 * publish rule in snippet.ts can name it without importing either store.
 */
export const CONCH_STORE_PARTS = ["Library", "Application Support", "conch"] as const;

export function conchStoreRoot(home: string = conchHome()): string {
  return join(home, ...CONCH_STORE_PARTS);
}

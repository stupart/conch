import { join } from "node:path";
import { CONCH_STORE_PARTS, conchStoreRoot } from "./conch-store.ts";
import { conchHome } from "./home.ts";

/**
 * Where `conch_capture`'s pictures of pages are kept: `~/Library/Application Support/conch/captures`.
 *
 * Not the temp folder, where the window snapshots for the phone go (`conch-previews`): a capture is a deliverable an
 * agent files and the user may open days later, and macOS sweeps `$TMPDIR` of files nobody touched for three days and
 * `/tmp` at every restart. Not `~/.config/conch` either, beside the daemon's settings: that is a hidden folder, which
 * the publish rule refuses outright (`checkLocalFile`), so a capture filed from there would never reach the apps or the
 * phone. It is in conch's own store (conch-store.ts), the one exception that rule makes outside a session's folders
 * and temp, because only conch writes in it: here the Mac app, 0600, one PNG per request, each checked by the daemon
 * (`PageCaptures.answer`). The copies of temp deliverables share the root (`deliverables/`, deliverable-store.ts), so
 * the rule names one place for both.
 *
 * The Mac app checks the folder the daemon names against the same path (ConchDesign `PageCapture.folder`).
 */
export const CAPTURE_FOLDER_PARTS = [...CONCH_STORE_PARTS, "captures"] as const;

export function captureFolderPath(home: string = conchHome()): string {
  return join(conchStoreRoot(home), "captures");
}

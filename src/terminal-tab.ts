/**
 * Finding the Terminal tab a session runs in, in two Apple events however many windows and tabs there are.
 *
 * 2026-10-11, Tyler: "the asset generator and monorepo session won't let me send a message or open the terminal". That
 * session runs in a plain Terminal tab, so conch reaches it through Terminal's AppleScript, and every script that did
 * walked Terminal's windows and tabs asking each tab for its tty: one Apple event per tab, about 25 with eleven windows
 * open. With the Mac's load average past 250, Terminal took 5 to 90 seconds to answer that walk, conch gave up after
 * four, and said a dialog was open and the window couldn't be found when neither was true. Asking for every window's id
 * and every tab's tty at once is two events, which measured 14 s against the walk's 63 s, and 2.3 s against 15.7 s, on
 * the same Mac a moment apart.
 *
 * The lines below go at the top level of a script, outside any `tell`: they leave `conchWindow` (a window id) and
 * `conchTab` (the tab's index in it), with `conchTab` 0 when no tab is on that tty, for the script to say so its own way.
 * Inside `tell application "Terminal"` after them, `window id conchWindow` and `tab conchTab of window id conchWindow` are
 * the session's. Not the word `tab` for a variable: inside Terminal's tell it names Terminal's tab class.
 */
/** A tty's name as it goes into the script's string: letters, digits, `_` and `-`, so nothing in it can end the string. */
const TTY = /^tty[\w-]{1,16}$/;

/** How long a script that finds a session's tab may take before conch gives up on Terminal: long enough for a Mac that's
 * busy, which is when it matters (2026-10-11). */
export const TERMINAL_SCRIPT_TIMEOUT_MS = 15_000;

export function terminalTabLookup(tty: string): string {
  if (!TTY.test(tty)) throw new Error(`not a tty: ${tty}`);
  return `
tell application "Terminal"
set conchIds to id of every window
set conchTtys to tty of every tab of every window
end tell
set conchWindow to 0
set conchTab to 0
repeat with wi from 1 to count conchTtys
set conchRow to item wi of conchTtys
if class of conchRow is not list then set conchRow to {conchRow}
repeat with ti from 1 to count conchRow
if item ti of conchRow is "/dev/${tty}" then
set conchWindow to item wi of conchIds
set conchTab to ti
exit repeat
end if
end repeat
if conchTab > 0 then exit repeat
end repeat`;
}

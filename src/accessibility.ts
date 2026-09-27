import { dlopen, FFIType } from "bun:ffi";

/**
 * Whether macOS lets this process drive other apps through Accessibility — asked, never prompted for.
 *
 * The daemon's keystrokes go through `osascript` and System Events, and macOS charges them to the daemon's
 * responsible process: conch.app when the app started the daemon (a child inherits it, and bun doesn't disclaim it),
 * the terminal when one did. `AXIsProcessTrusted()` asked here answers for that same process, so it says whether the
 * keys conch is about to type can land. It never shows a prompt; only `AXIsProcessTrustedWithOptions` with the prompt
 * option does, and conch asks that only from Settings, on a press (mac-app/conch-mac/Permissions.swift).
 *
 * Asked each time rather than kept: the answer changes the moment Tyler flips the switch. null off macOS, or when the
 * framework can't be opened.
 */
export function accessibilityTrusted(): boolean | null {
  const read = trustReader();
  if (!read) return null;
  try {
    return read();
  } catch {
    return null;
  }
}

const APPLICATION_SERVICES = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
let reader: (() => boolean) | null | undefined;

/** Lazy, so importing the daemon opens nothing until a send needs the answer. */
function trustReader(): (() => boolean) | null {
  if (reader !== undefined) return reader;
  if (process.platform !== "darwin") return (reader = null);
  try {
    const library = dlopen(APPLICATION_SERVICES, {
      AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    } as const);
    reader = () => library.symbols.AXIsProcessTrusted();
  } catch {
    reader = null;
  }
  return reader;
}

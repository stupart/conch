import Foundation

/// Passkeys in conch's browser, which can't use them yet. WebKit lets an app use passkeys and security keys for any site
/// only with the `com.apple.developer.web-browser.public-key-credential` entitlement (`entitlement`), which Apple grants
/// to apps that act as the user's web browser, through a request form and a managed capability on the app's ID. Without
/// it, a page's `navigator.credentials` request is turned down (NotAllowedError) and WebKit says no platform authenticator
/// is there (`isUserVerifyingPlatformAuthenticatorAvailable()` is false, measured 2026-11-11). Tyler saw it on 2026-10-18
/// (Google's "Use your passkey" failed and fell back to "Choose how you want to sign in", with nothing saying why) and on
/// 2026-11-11 ("passkeys don't work in conch browser yet", signing in to Apple's developer site). So the tab says so under
/// its address bar (`Workbench.passkeyWords`), with Open in Browser, where his passkeys work.
///
/// How a tab knows: the page shows a way to use a passkey or a security key (a button, a link, a heading that names
/// one), or Tyler presses one. `script` watches for that from conch's own content world (`WorkbenchScript.contentWorld`):
/// a MutationObserver and a click listener there are invisible to the page, which keeps every function it had.
///
/// It used to wrap `navigator.credentials.get` and `create` in the page's own world, and `Function.prototype.toString` to
/// hide the wrappers. That was the strongest bot signal the browser gave (2026-11-11, measured on CreepJS): a Proxy round
/// `toString` is the mark of an automation "stealth" plugin, caught by the recursion test, and it made every native
/// function on every page (the canvas, dates, the DOM) read as tampered with: "stealth" 20%, "headless" 33% (its
/// webdriver test reads the lies), and hundreds of lies, against none of any of them without it.
public enum WorkbenchPasskeys {
    /// The message handler the watcher posts to, in conch's world.
    public static let messageHandler = "conchPasskeys"

    /// What the app needs from Apple for passkeys to work in its browser: the Mac app checks its own signature for it
    /// (`WorkbenchPage.passkeysWork`), and with it says nothing.
    public static let entitlement = "com.apple.developer.web-browser.public-key-credential"

    /// What a posted message says: "offer" (the page shows a passkey or a security key to use) or "pressed" (Tyler pressed
    /// one); nil for anything else.
    public static func attempt(_ body: Any?) -> String? {
        guard let what = body as? String, what == "offer" || what == "pressed" else { return nil }
        return what
    }

    /// Words that name a way in a passkey or a security key gives: "Sign in with a passkey", "Use your passkey",
    /// "Use a security key". Matched case-insensitively, by the script and its tests.
    public static let words = #"\bpass-?keys?\b|\bsecurity keys?\b"#

    /// The watcher, at document start in every frame, in conch's world alone.
    public static var script: String {
        source
            .replacingOccurrences(of: handlerPlaceholder, with: messageHandler)
            .replacingOccurrences(of: wordsPlaceholder, with: words)
    }

    static let handlerPlaceholder = "__CONCH_HANDLER__"
    static let wordsPlaceholder = "__CONCH_WORDS__"

    /// test/workbench-passkeys.test.ts reads this out of this file and runs it against a pretend page; WorkbenchPasskeysTests
    /// runs it in real WebKit.
    static let source = #"""
    (() => {
        const W = window, D = document;
        const WORDS = /__CONCH_WORDS__/i;
        // What names a way in: something to press, or a heading or a label over the step.
        const PLACES = 'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="radio"], [role="tab"], summary, label, legend, h1, h2, h3, [role="heading"]';
        const post = (what) => { try { W.webkit.messageHandlers.__CONCH_HANDLER__.postMessage(what); } catch (_) {} };
        const said = (el) => String(el.textContent || "") + " " + String((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("value"))) || "");
        const shown = (el) => { const box = el.getBoundingClientRect ? el.getBoundingClientRect() : null; return !!box && box.width > 0 && box.height > 0; };
        let offered = false;
        const look = () => {
            if (offered || !D.body || !D.querySelectorAll) return;
            for (const el of D.querySelectorAll(PLACES)) {
                if (WORDS.test(said(el)) && shown(el)) { offered = true; post("offer"); return; }
            }
        };
        // Looked at once the page settles, and again a second after it changes (a sign-in's next step), never more often.
        let waiting = 0;
        const soon = () => { if (!offered && !waiting) waiting = W.setTimeout(() => { waiting = 0; look(); }, 1000); };
        D.addEventListener("DOMContentLoaded", soon);
        if (W.MutationObserver) new W.MutationObserver(soon).observe(D, { childList: true, subtree: true, characterData: true });
        // Tyler pressing one: said at once.
        W.addEventListener("click", (event) => {
            if (!event.isTrusted || !event.target || !event.target.closest) return;
            const el = event.target.closest(PLACES);
            if (el && WORDS.test(said(el))) post("pressed");
        }, true);
    })();
    """#
}

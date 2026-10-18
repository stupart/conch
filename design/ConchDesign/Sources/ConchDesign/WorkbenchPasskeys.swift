import Foundation

/// Passkeys in conch's browser, which can't give them. WebKit lets only a browser Apple has approved (the
/// `com.apple.developer.web-browser.public-key-credential` entitlement) use WebAuthn, so a page that asks for a passkey in
/// a Workbench tab is turned down. Tyler saw it on 2026-10-18: Google's "Use your passkey" failed and fell back to
/// "Choose how you want to sign in", with nothing saying why. Now the tab says so under its address bar
/// (`Workbench.passkeyWords`), and he picks his password or another way.
///
/// Two scripts, at document start in every frame, joined by an event whose name is new for every page (`eventName`), so
/// nothing a page can guess:
///
/// - `pageScript`, in the page's own world: `navigator.credentials.get` and `create`, wrapped. Asked for a passkey
///   (`publicKey`, other than the quiet autofill offer a sign-in page makes as it loads, `mediation: "conditional"`), the
///   wrapper dispatches the event, then calls the original and returns exactly what it returns, its rejection included.
///   The wrappers pass for the originals: the same name and length, and `Function.prototype.toString` says what it says
///   of the originals, itself included. Nothing new is put on `window`: a page that looks for `window.webkit` (one way a
///   sign-in tells an embedded browser) finds what it found before.
/// - `listenerScript`, in conch's own content world (`WorkbenchScript.contentWorld`), the only world the app's message
///   handler is in: it hears the event and posts "get" or "create" to `messageHandler`.
public enum WorkbenchPasskeys {
    /// The message handler the listener posts to, in conch's content world.
    public static let messageHandler = "conchPasskeys"

    /// A new event name for each page: "conch-pk-" and 32 hex digits.
    public static func eventName() -> String {
        "conch-pk-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
    }

    /// What a posted message says: "get" or "create"; nil for anything else.
    public static func attempt(_ body: Any?) -> String? {
        guard let op = body as? String, op == "get" || op == "create" else { return nil }
        return op
    }

    /// The page world's half, for one page's event name.
    public static func pageScript(event: String) -> String {
        page.replacingOccurrences(of: placeholder, with: safe(event))
    }

    /// conch's world's half, for the same event name.
    public static func listenerScript(event: String) -> String {
        listener
            .replacingOccurrences(of: placeholder, with: safe(event))
            .replacingOccurrences(of: handlerPlaceholder, with: messageHandler)
    }

    /// Only the characters `eventName` makes: anything else is dropped, so a name can't end the script's string.
    private static func safe(_ event: String) -> String {
        String(event.unicodeScalars.filter { CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-").contains($0) }.map(Character.init))
    }

    static let placeholder = "__CONCH_EVENT__"
    static let handlerPlaceholder = "__CONCH_HANDLER__"

    /// test/workbench-passkeys.test.ts reads this out of this file and runs it, as workbench-script.test.ts does the page script.
    static let page = #"""
    (() => {
        const EVENT = "__CONCH_EVENT__";
        const W = window;
        const C = W.CredentialsContainer;
        const proto = C && C.prototype;
        if (!proto) return;
        const R = Reflect.apply, P = Proxy, D = Object.defineProperty, G = Object.getOwnPropertyDescriptor;
        const dispatch = EventTarget.prototype.dispatchEvent, E = Event, doc = W.document;
        const masks = new WeakMap();
        // A passkey asked for with the person there to give it: not the quiet autofill offer a sign-in page makes as it loads.
        const asksForPasskey = (options) => {
            try {
                return !!(options && typeof options === "object" && options.publicKey && options.mediation !== "conditional");
            } catch (error) {
                return false;
            }
        };
        const say = (op) => {
            try {
                R(dispatch, doc, [new E(EVENT + "-" + op)]);
            } catch (error) {}
        };
        for (const op of ["get", "create"]) {
            const own = G(proto, op);
            if (!own || typeof own.value !== "function") continue;
            const original = own.value;
            const watched = new P(original, {
                apply(target, self, args) {
                    if (asksForPasskey(args[0])) say(op);
                    return R(target, self, args);
                },
            });
            masks.set(watched, original);
            D(proto, op, { value: watched, writable: own.writable, enumerable: own.enumerable, configurable: own.configurable });
        }
        // What a page reads of a wrapper's source is the original's; of toString's own, toString's.
        const FP = Function.prototype;
        const own = G(FP, "toString");
        if (!own || typeof own.value !== "function") return;
        const toString = new P(own.value, {
            apply(target, self, args) {
                return R(target, masks.has(self) ? masks.get(self) : self, args);
            },
        });
        masks.set(toString, own.value);
        D(FP, "toString", { value: toString, writable: own.writable, enumerable: own.enumerable, configurable: own.configurable });
    })();
    """#

    static let listener = #"""
    (() => {
        const EVENT = "__CONCH_EVENT__";
        const post = (op) => {
            try {
                window.webkit.messageHandlers.__CONCH_HANDLER__.postMessage(op);
            } catch (error) {}
        };
        for (const op of ["get", "create"]) document.addEventListener(EVENT + "-" + op, () => post(op));
    })();
    """#
}

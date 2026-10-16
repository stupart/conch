import Foundation

/// The script the Workbench runs in a page for an agent's `read`, `click` and `type` (src/browser-workbench.ts), in a
/// content world of conch's own (`contentWorld`): the page never sees it, and its refs (`window.__conchWorkbench`) are
/// invisible to the page's own scripts.
///
/// One string, so the app runs exactly what is tested: test/workbench-script.test.ts reads it from this file and runs it
/// against a page of fake elements, and holds it to the two rules about secrets.
///
/// - A password's value, a hidden field's, and a one-time code's or a card number's (by `autocomplete`) are never read:
///   `read` lists the field with no value at all.
/// - It never types into a password field, however the field is named (a ref, a selector, its label, an element
///   round it): `type` answers `passwordRefusal`, and the field is left as it was. Signing in is the person's, in the
///   tab, where they can see what they type into.
///
/// Called by `callAsyncJavaScript` with `op` ("read", "click", "type", "locate" or "locate-field"), `how` ("ref",
/// "selector", "text" or "auto"), `what`, `text` and `submit`. It answers an object; `{error}` when it can't do what was
/// asked, saying why.
///
/// So the user can watch an agent work (2026-10-16): `locate` and `locate-field` find what a click or a type will land
/// on, scroll it into view, and answer only its box, which the app marks over the page; and `type` fills a field in a
/// few visible steps, as typing looks, never more than about a third of a second. Every scroll into view is instant,
/// even on a page that asks for smooth scrolling, so the box answered is where the element is, not where it was.
public enum WorkbenchScript {
    /// The content world it runs in.
    public static let contentWorld = "conch-workbench"

    /// Said, word for word, when an agent tries to type into a password field.
    public static let passwordRefusal = "agents don't type passwords; sign in yourself in the tab"

    /// What one `read` brings back at most: its words, and how many of each kind of element.
    public static let textMax = 12_000
    public static let linksMax = 150
    public static let buttonsMax = 100
    public static let fieldsMax = 100

    /// How a type fills its field: this many steps at most, this many milliseconds apart.
    public static let fillSteps = 12
    public static let fillStepMs = 28

    public static let page = #"""
    const W = window, D = document;
    const PASSWORD_REFUSAL = "agents don't type passwords; sign in yourself in the tab";
    const LIMITS = { text: 12000, links: 150, buttons: 100, fields: 100, hidden: 20, bytes: 45000 };
    const FILL = { steps: 12, ms: 28 };
    const state = W.__conchWorkbench || (W.__conchWorkbench = { refs: new Map() });
    const fail = (message) => { throw { conchWorkbench: message }; };
    const fold = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    const cut = (value, max) => { const text = fold(value); return text.length > max ? text.slice(0, max - 1) + "…" : text; };
    const tag = (el) => String((el && el.tagName) || "").toLowerCase();
    const attr = (el, name) => String((el && el.getAttribute && el.getAttribute(name)) || "");
    const typeOf = (el) => {
        const name = tag(el);
        if (name === "input") return (attr(el, "type") || "text").toLowerCase();
        if (name === "textarea" || name === "select") return name;
        return el && el.isContentEditable ? "contenteditable" : name;
    };
    const autocomplete = (el) => " " + attr(el, "autocomplete").toLowerCase() + " ";
    // A password, by its type or by what the page says it is for; a "show password" toggle turns the type to text.
    const isPassword = (el) => typeOf(el) === "password" || / (current-password|new-password) /.test(autocomplete(el));
    // Whose value is never read: a password's, a hidden field's, a one-time code's, a card's number or code.
    const isSecret = (el) => isPassword(el) || typeOf(el) === "hidden" || / (one-time-code|cc-number|cc-csc) /.test(autocomplete(el));
    const visible = (el) => {
        if (!el || !el.getBoundingClientRect) return false;
        const box = el.getBoundingClientRect();
        if (!box || (box.width <= 0 && box.height <= 0)) return false;
        const style = W.getComputedStyle ? W.getComputedStyle(el) : null;
        return !style || (style.visibility !== "hidden" && style.display !== "none");
    };
    const all = (selector, root) => Array.from((root || D).querySelectorAll(selector));
    // Into view at once, whatever the page's own scroll-behavior: a page that scrolls smoothly would still be on its
    // way when the box is measured, and the mark would land where the element was (58 to 891 points off, measured).
    const reveal = (el) => { if (el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); };
    const LINKS = "a[href]";
    const BUTTONS = 'button, [role="button"], input[type="submit"], input[type="button"], input[type="reset"], input[type="image"], summary';
    const FIELDS = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
    const CLICKABLE = LINKS + ", " + BUTTONS + ', [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], label, [onclick]';
    const BUTTON_TYPES = ["submit", "button", "reset", "image"];
    const UNTYPABLE = BUTTON_TYPES.concat(["checkbox", "radio", "file", "hidden", "range", "color"]);
    const editable = (el) => {
        const type = typeOf(el);
        if (tag(el) === "input") return UNTYPABLE.indexOf(type) < 0;
        return type === "textarea" || type === "select" || type === "contenteditable";
    };
    const labelOf = (el) => {
        for (const label of Array.from(el.labels || [])) {
            const words = cut(label.innerText || label.textContent, 120);
            if (words) return words;
        }
        const aria = attr(el, "aria-label");
        if (aria) return cut(aria, 120);
        const by = attr(el, "aria-labelledby");
        if (by) {
            const words = by.split(/\s+/).map((id) => { const named = D.getElementById(id); return named ? named.innerText || named.textContent : ""; }).join(" ");
            if (fold(words)) return cut(words, 120);
        }
        return cut(attr(el, "placeholder") || attr(el, "title"), 120);
    };
    const wordsOf = (el) => {
        const own = cut(el.innerText || el.textContent, 120);
        if (own) return own;
        if (tag(el) === "input" && !isSecret(el)) {
            const said = attr(el, "value") || attr(el, "aria-label") || attr(el, "title") || attr(el, "alt");
            if (said) return cut(said, 120);
        }
        const aria = attr(el, "aria-label") || attr(el, "title");
        if (aria) return cut(aria, 120);
        const image = el.querySelector ? el.querySelector("img") : null;
        return image ? cut(attr(image, "alt"), 120) : "";
    };
    const describe = (el) => {
        const name = tag(el);
        const kind = name === "a" ? "link" : name === "button" || BUTTON_TYPES.indexOf(typeOf(el)) >= 0 || attr(el, "role") === "button" ? "button" : editable(el) ? "field" : name;
        const words = kind === "field" ? labelOf(el) || attr(el, "name") : wordsOf(el);
        return words ? kind + ' "' + cut(words, 80) + '"' : kind;
    };

    // The element a command names: a ref from the last read, a selector, or visible words (a field's by its label).
    const byRef = (ref) => {
        const el = state.refs.get(ref);
        if (!el) fail("there's no " + ref + " on this page; read it again (browser_read) for fresh refs");
        if (el.isConnected === false) fail(ref + " is gone from the page (it changed); read it again for fresh refs");
        return el;
    };
    const bySelector = (selector, quiet) => {
        let el = null;
        try { el = D.querySelector(selector); } catch (_) { if (quiet) return null; fail('"' + selector + "\" isn't a valid CSS selector"); }
        if (!el && !quiet) fail('nothing on the page matches "' + selector + '"');
        return el;
    };
    const byWords = (words, field, quiet) => {
        const wanted = fold(words).toLowerCase();
        const pool = all(field ? FIELDS : CLICKABLE).filter((el) => visible(el) && (!field || typeOf(el) !== "hidden"));
        const said = (el) => fold(field ? labelOf(el) || attr(el, "name") : wordsOf(el)).toLowerCase();
        const found = pool.find((el) => said(el) === wanted) || pool.find((el) => said(el).startsWith(wanted)) || pool.find((el) => said(el).indexOf(wanted) >= 0);
        if (!found && !quiet) fail("nothing " + (field ? "you can type in is labelled" : "you can click says") + ' "' + cut(words, 80) + '"');
        return found || null;
    };
    const target = (field) => {
        if (how === "ref") return byRef(what);
        if (how === "selector") return bySelector(what, false);
        if (how === "text") return byWords(what, field, false);
        if (/^e\d+$/.test(what) && state.refs.has(what)) return byRef(what);
        const found = bySelector(what, true) || byWords(what, field, true);
        if (!found) fail('nothing on the page is "' + cut(what, 80) + '": not a ref from browser_read, a selector that matches, or words on the page');
        return found;
    };

    const read = () => {
        state.refs = new Map();
        let next = 0;
        const ref = (el) => { const name = "e" + (++next); state.refs.set(name, el); return name; };
        const links = [], buttons = [], fields = [];
        for (const el of all(LINKS)) {
            if (links.length >= LIMITS.links) break;
            if (!visible(el)) continue;
            const href = String(el.href || "");
            const link = { ref: ref(el), text: wordsOf(el) };
            if (/^https?:/i.test(href)) link.href = href;
            links.push(link);
        }
        for (const el of all(BUTTONS)) {
            if (buttons.length >= LIMITS.buttons) break;
            if (visible(el)) buttons.push({ ref: ref(el), text: wordsOf(el) });
        }
        let hidden = 0;
        for (const el of all(FIELDS)) {
            if (fields.length >= LIMITS.fields) break;
            const type = typeOf(el);
            if (BUTTON_TYPES.indexOf(type) >= 0) continue;
            if (type === "hidden" ? ++hidden > LIMITS.hidden : !visible(el)) continue;
            const field = { ref: ref(el), type, label: labelOf(el), name: cut(attr(el, "name") || attr(el, "id"), 120) };
            if (el.disabled) field.disabled = true;
            if (isSecret(el)) field.secret = true;
            else if (type === "checkbox" || type === "radio") field.checked = Boolean(el.checked);
            else if (type === "select") { const chosen = el.selectedOptions && el.selectedOptions[0]; field.value = chosen ? cut(chosen.text || chosen.value, 200) : ""; }
            else if (type === "contenteditable") field.value = cut(el.innerText || el.textContent, 500);
            else field.value = String(el.value == null ? "" : el.value).slice(0, 500);
            fields.push(field);
        }
        const body = D.body || D.documentElement;
        let text = String((body && (body.innerText || body.textContent)) || "")
            .replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        let truncated = false;
        if (text.length > LIMITS.text) { text = text.slice(0, LIMITS.text); truncated = true; }
        const page = { text, links, buttons, fields };
        // Inside one control frame with room to spare: the words give way first, then the longest lists.
        const bytes = () => new TextEncoder().encode(JSON.stringify(page)).length;
        for (let rounds = 0; rounds < 40 && bytes() > LIMITS.bytes; rounds++) {
            truncated = true;
            if (page.text.length > 2000) { page.text = page.text.slice(0, Math.floor(page.text.length / 2)); continue; }
            const longest = [links, buttons, fields].sort((a, b) => b.length - a.length)[0];
            if (longest.length <= 10) break;
            longest.length = Math.floor(longest.length * 0.7);
        }
        if (truncated) page.truncated = true;
        return page;
    };

    const click = () => {
        const el = target(false);
        reveal(el);
        const box = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const at = { bubbles: true, cancelable: true, composed: true, view: W, button: 0, buttons: 1, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
        const Pointer = W.PointerEvent || W.MouseEvent;
        el.dispatchEvent(new Pointer("pointerdown", at));
        el.dispatchEvent(new W.MouseEvent("mousedown", at));
        if (el.focus) el.focus();
        el.dispatchEvent(new Pointer("pointerup", Object.assign({}, at, { buttons: 0 })));
        el.dispatchEvent(new W.MouseEvent("mouseup", Object.assign({}, at, { buttons: 0 })));
        el.click();
        return { clicked: describe(el) };
    };

    // The field a type is aimed at: a label, or something round the field, names the field it is for, or the first one
    // inside it. A password field, however it was named, is refused here, before anything is marked or typed.
    const fieldTarget = () => {
        let el = target(true);
        if (tag(el) === "label" && el.control) el = el.control;
        if (!editable(el) && !isPassword(el)) {
            const inside = el.querySelectorAll ? all("input, textarea, select", el).find((field) => typeOf(field) !== "hidden") : null;
            if (inside) el = inside;
        }
        if (isPassword(el)) fail(PASSWORD_REFUSAL);
        return el;
    };

    // Where a click or a type will land, for the app to mark: scrolled into view, and its box. Nothing else about it.
    const locate = (field) => {
        const el = field ? fieldTarget() : target(false);
        reveal(el);
        const box = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return { box: box ? [box.left, box.top, box.width, box.height] : [0, 0, 0, 0] };
    };

    const type = async () => {
        const el = fieldTarget();
        if (!editable(el)) fail(describe(el) + " isn't a field you can type in");
        if (el.disabled || el.readOnly) fail(describe(el) + " is " + (el.disabled ? "disabled" : "read-only"));
        reveal(el);
        if (el.focus) el.focus();
        const kind = typeOf(el);
        if (kind === "select") {
            const wanted = fold(text).toLowerCase();
            const options = Array.from(el.options || []);
            const option = options.find((o) => fold(o.text).toLowerCase() === wanted || String(o.value).toLowerCase() === wanted)
                || options.find((o) => fold(o.text).toLowerCase().indexOf(wanted) >= 0);
            if (!option) fail(describe(el) + ' has no option "' + cut(text, 60) + '"');
            el.value = option.value;
        } else if (kind === "contenteditable") {
            const selection = W.getSelection ? W.getSelection() : null;
            if (selection && D.createRange) { const range = D.createRange(); range.selectNodeContents(el); selection.removeAllRanges(); selection.addRange(range); }
            if (!(D.execCommand && D.execCommand("insertText", false, text))) el.textContent = text;
        } else {
            // The element's own setter, so a page that watches its fields (React) hears the change as typing.
            const prototype = kind === "textarea" ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype;
            const property = Object.getOwnPropertyDescriptor(prototype, "value");
            const put = (value) => { if (property && property.set) property.set.call(el, value); else el.value = value; };
            // In steps the user can watch fill, each heard as typing; the whole of it lands last.
            const steps = typeof W.setTimeout === "function" ? Math.min(text.length, FILL.steps) : 1;
            for (let step = 1; step < steps; step++) {
                put(text.slice(0, Math.ceil(text.length * step / steps)));
                el.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
                await new Promise((resolve) => W.setTimeout(resolve, FILL.ms));
            }
            put(text);
        }
        el.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new W.Event("change", { bubbles: true }));
        if (!submit) return { typed: describe(el) };
        const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
        const unhandled = el.dispatchEvent(new W.KeyboardEvent("keydown", key));
        el.dispatchEvent(new W.KeyboardEvent("keypress", key));
        el.dispatchEvent(new W.KeyboardEvent("keyup", key));
        if (unhandled && el.form && kind !== "textarea") {
            if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
        }
        return { typed: describe(el), submitted: true };
    };

    try {
        if (op === "read") return read();
        if (op === "click") return click();
        if (op === "type") return await type();
        if (op === "locate") return locate(false);
        if (op === "locate-field") return locate(true);
        return { error: "conch's browser has no " + String(op) };
    } catch (thrown) {
        if (thrown && typeof thrown.conchWorkbench === "string") return { error: thrown.conchWorkbench };
        throw thrown;
    }
    """#
}

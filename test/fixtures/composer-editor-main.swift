import AppKit
import ConchDesign
import ObjectiveC
import SwiftUI

// Compiled with mac-app/conch-mac/ComposerEditor.swift and Palette.swift, against ConchDesign built as its own module, by
// test/composer-editor-render.test.ts: the composer's real editor, hosted by SwiftUI as ComposerView hosts it, in a real
// window in Dark mode. Each case prints one JSON line of what it measured; the test decides. Nothing is shown and nothing
// comes forward: the app is `.prohibited`, and the window is borderless, transparent, parked far off every screen and
// never made key. Everything runs on the main actor, as AppKit needs: typing into a text view from the cooperative pool
// crashed it inside its spell checker, the first time this ran.

// MARK: Recording

/// Writes to the spelling flags of an editable text view once the editor exists. There should be none: it sets them
/// once, as it is made, and nothing else may.
var flagWrites: [String] = []
var watchingFlags = false
extension NSTextView {
    @objc dynamic func harness_setCorrection(_ on: Bool) {
        if watchingFlags, isEditable { flagWrites.append("correction=\(on)") }
        harness_setCorrection(on)
    }
    @objc dynamic func harness_setContinuous(_ on: Bool) {
        if watchingFlags, isEditable { flagWrites.append("continuous=\(on)") }
        harness_setContinuous(on)
    }
    @objc dynamic func harness_setQuotes(_ on: Bool) {
        if watchingFlags, isEditable { flagWrites.append("quotes=\(on)") }
        harness_setQuotes(on)
    }
}
func swizzle(_ original: Selector, _ replacement: Selector) {
    method_exchangeImplementations(class_getInstanceMethod(NSTextView.self, original)!, class_getInstanceMethod(NSTextView.self, replacement)!)
}
swizzle(#selector(setter: NSTextView.isAutomaticSpellingCorrectionEnabled), #selector(NSTextView.harness_setCorrection(_:)))
swizzle(#selector(setter: NSTextView.isContinuousSpellCheckingEnabled), #selector(NSTextView.harness_setContinuous(_:)))
swizzle(#selector(setter: NSTextView.isAutomaticQuoteSubstitutionEnabled), #selector(NSTextView.harness_setQuotes(_:)))

/// Text views switched from TextKit 2 to TextKit 1 after they were made. The editor must never be one.
var textKitSwitches = 0
let switchObserver = NotificationCenter.default.addObserver(forName: NSTextView.willSwitchToNSLayoutManagerNotification, object: nil, queue: nil) { _ in
    textKitSwitches += 1
}

/// How many times SwiftUI evaluated the field's body: proof that an "unrelated update" really was one.
var bodies = 0

// MARK: The field, as ComposerView lays it out

/// The draft store's shape (`ComposerDraftStore.textBinding`): read live from a published dictionary, and a write of what
/// it already holds is no change.
final class Drafts: ObservableObject {
    @Published var text: [String: String] = [:]
    @Published var focused = false
    @Published var session = "alpha"
    @Published var tick = 0
    var sends = 0

    func binding(_ id: String) -> Binding<String> {
        Binding(
            get: { [weak self] in self?.text[id] ?? "" },
            set: { [weak self] value in
                guard let self, value != (self.text[id] ?? "") else { return }
                self.text[id] = value.isEmpty ? nil : value
            }
        )
    }

    var focusBinding: Binding<Bool> {
        Binding(get: { [weak self] in self?.focused ?? false }, set: { [weak self] in self?.focused = $0 })
    }

    var draft: String {
        get { text[session] ?? "" }
        set { text[session] = newValue.isEmpty ? nil : newValue }
    }
}

let surface = NSColor(ConchPalette.surface)
// ComposerView's: `fieldInsetTop`, `fieldInsetBottom`, `fieldInsetX` and `caretRaise`.
let insetTop: CGFloat = 8, insetBottom: CGFloat = 4, insetX: CGFloat = 10
let caretRaise = ConchType.readingLineSpacing / 2

struct Field: View {
    @ObservedObject var drafts: Drafts

    var body: some View {
        bodies += 1
        let draft = drafts.binding(drafts.session)
        return ZStack(alignment: .topLeading) {
            ComposerEditor(text: draft, isFocused: drafts.focusBinding, identity: drafts.session, onSend: { drafts.sends += 1 })
                .padding(.top, insetTop + caretRaise)
                .padding(.bottom, insetBottom - caretRaise)
                .padding(.horizontal, insetX)
            if draft.wrappedValue.isEmpty {
                // The placeholder, in the editor's ink so the two can be compared pixel for pixel.
                Text("Message alpha")
                    .font(ConchType.readingBody)
                    .foregroundStyle(ConchPalette.textPrimary)
                    .frame(height: ComposerEditing.lineHeight, alignment: .topLeading)
                    .padding(.top, insetTop)
                    .padding(.bottom, insetBottom)
                    .padding(.horizontal, insetX)
                    .allowsHitTesting(false)
            }
            // Something on screen that changes with nothing to do with the field: conch's state republishing.
            Text("\(drafts.tick)").opacity(0)
        }
        .background(Color(nsColor: surface))
    }
}

// MARK: Looking at it

func say(_ fields: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

@MainActor
func spin(_ seconds: Double = 0.1) async { try? await Task.sleep(for: .milliseconds(Int(seconds * 1000))) }

/// Until `condition` holds, or five seconds: SwiftUI's round trips are not on a clock, and a loaded machine is slow.
@MainActor
@discardableResult
func until(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<250 {
        if condition() { return true }
        await spin(0.02)
    }
    return condition()
}

/// `count` real SwiftUI updates of the field that have nothing to do with it.
@MainActor
func republish(_ drafts: Drafts, _ count: Int) async {
    for _ in 0..<count {
        let before = bodies
        drafts.tick += 1
        await until { bodies > before }
    }
}

func editable(in view: NSView) -> NSTextView? {
    if let text = view as? NSTextView, text.isEditable { return text }
    for child in view.subviews { if let found = editable(in: child) { return found } }
    return nil
}

/// Luma, 0...255, of an sRGB colour.
func luma(_ color: NSColor) -> Int {
    let c = color.usingColorSpace(.sRGB) ?? color
    return Int((0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent) * 255)
}

/// A view's own drawing over the card's colour: the brightest and darkest luma, and the rows (pixels from the top) with
/// ink on them, ink being anything far from the ground.
@MainActor
func ink(_ view: NSView, in rect: NSRect? = nil) -> [String: Any] {
    let area = rect ?? view.bounds
    guard area.width >= 1, area.height >= 1, let rep = view.bitmapImageRepForCachingDisplay(in: area) else { return ["error": "no bitmap"] }
    var ground = 0
    view.effectiveAppearance.performAsCurrentDrawingAppearance {
        ground = luma(surface)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        surface.setFill()
        NSRect(x: 0, y: 0, width: rep.pixelsWide, height: rep.pixelsHigh).fill()
        NSGraphicsContext.restoreGraphicsState()
        view.cacheDisplay(in: area, to: rep)
    }
    var brightest = 0, darkest = 255, top = -1, bottom = -1, inked = 0
    for y in 0..<rep.pixelsHigh {
        var row = false
        for x in 0..<rep.pixelsWide {
            guard let color = rep.colorAt(x: x, y: y) else { continue }
            let l = luma(color)
            brightest = max(brightest, l)
            darkest = min(darkest, l)
            if abs(l - ground) > 70 { row = true; inked += 1 }
        }
        if row {
            if top < 0 { top = y }
            bottom = y
        }
    }
    return ["ground": ground, "brightest": brightest, "darkest": darkest, "top": top, "bottom": bottom, "inked": inked, "scale": Double(rep.pixelsHigh) / Double(area.height)]
}

@MainActor
func spelling(_ view: NSTextView) -> [String: Any] {
    [
        "continuous": view.isContinuousSpellCheckingEnabled,
        "correction": view.isAutomaticSpellingCorrectionEnabled,
        "replacement": view.isAutomaticTextReplacementEnabled,
        "systemReplacement": NSSpellChecker.isAutomaticTextReplacementEnabled,
        "systemCorrection": NSSpellChecker.isAutomaticSpellingCorrectionEnabled,
        "quotes": view.isAutomaticQuoteSubstitutionEnabled,
        "dashes": view.isAutomaticDashSubstitutionEnabled,
    ]
}

/// A key, through the text view's own `keyDown`: the input context, the key bindings and the delegate, as typing goes.
@MainActor
func key(_ view: NSTextView, _ characters: String, code: UInt16 = 0, flags: NSEvent.ModifierFlags = []) {
    let event = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: view.window?.windowNumber ?? 0, context: nil, characters: characters,
        charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code
    )!
    view.keyDown(with: event)
}

@MainActor
func type(_ view: NSTextView, _ text: String) async {
    for character in text {
        key(view, String(character), code: character == " " ? 49 : 0)
        await spin(0.005)
    }
}

/// The field's frame and scroll position, and the line the caret is on, in the text view's points.
@MainActor
func geometry(_ view: NSTextView) -> [String: Any] {
    let scroll = view.enclosingScrollView!
    let layout = view.layoutManager!
    layout.ensureLayout(for: view.textContainer!)
    let used = layout.usedRect(for: view.textContainer!)
    let clip = scroll.contentView.bounds
    // The empty line after a final newline is the layout's extra fragment.
    let location = view.selectedRange().location
    let caretLine: NSRect
    if location == (view.string as NSString).length, view.string.isEmpty || view.string.hasSuffix("\n") {
        caretLine = layout.extraLineFragmentRect
    } else {
        caretLine = layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: max(0, location - 1)), effectiveRange: nil)
    }
    return [
        "field": Double(scroll.frame.height), "width": Double(scroll.frame.width), "textHeight": Double(view.frame.height),
        "used": Double(used.height), "clipY": Double(clip.origin.y), "clipHeight": Double(clip.height),
        "caretLineTop": Double(caretLine.minY), "caretLineBottom": Double(caretLine.maxY),
    ]
}

@MainActor
func fieldHeight(_ view: NSTextView) -> Double { Double(view.enclosingScrollView!.frame.height) }

// MARK: The cases

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.appearance = NSAppearance(named: .darkAqua)

let drafts = Drafts()
drafts.text["alpha"] = "a draft restored at launch"
let window = NSWindow(contentRect: NSRect(x: -8000, y: -8000, width: 560, height: 320), styleMask: [.borderless], backing: .buffered, defer: false)
window.isReleasedWhenClosed = false
window.alphaValue = 0
window.ignoresMouseEvents = true
window.appearance = NSAppearance(named: .darkAqua)
let host = NSHostingView(rootView: AnyView(Field(drafts: drafts).frame(width: 520).fixedSize(horizontal: false, vertical: true)))
window.contentView = host
window.orderFrontRegardless()

DispatchQueue.main.asyncAfter(deadline: .now() + 150) {
    FileHandle.standardError.write("the harness ran out of time\n".data(using: .utf8)!)
    exit(3)
}

Task { @MainActor in
    var found: NSTextView?
    await until { found = editable(in: host); return found != nil }
    guard let view = found else {
        say(["name": "built", "error": "no editable text view"])
        exit(2)
    }
    await spin(0.3)
    say(["name": "built", "class": String(describing: type(of: view)), "textKit2": view.textLayoutManager != nil,
         "switches": textKitSwitches, "text": view.string, "draft": drafts.draft, "spelling": spelling(view),
         "geometry": geometry(view), "ink": ink(view)])

    // Spelling through many SwiftUI updates: focus, typing, unrelated republishing, an outside change.
    watchingFlags = true
    drafts.focused = true
    await until { window.firstResponder === view }
    drafts.draft = ""
    await until { view.string.isEmpty }
    await type(view, "teh ")
    await until { drafts.draft == "teh " }
    await republish(drafts, 5)
    drafts.draft += "and \"quoted\" -- text"
    await until { view.string == drafts.draft }
    await spin(0.3)
    say(["name": "spelling", "text": view.string, "draft": drafts.draft, "firstResponder": window.firstResponder === view,
         "focused": drafts.focused, "spelling": spelling(view), "writes": flagWrites, "switches": textKitSwitches,
         "textKit2": view.textLayoutManager != nil])

    // Typed words are laid out and drawn, light on the dark card.
    drafts.draft = ""
    await until { view.string.isEmpty }
    await type(view, "hello world")
    await until { drafts.draft == "hello world" }
    await spin(0.2)
    say(["name": "typed", "text": view.string, "draft": drafts.draft, "ink": ink(view), "geometry": geometry(view)])

    // The placeholder (SwiftUI's) and the same words typed (the editor's) sit on one line, and the caret spans them.
    drafts.draft = ""
    await until { view.string.isEmpty }
    await spin(0.2)
    let placeholder = ink(host, in: NSRect(x: 0, y: 0, width: 200, height: 34))
    await type(view, "Message alpha")
    await until { drafts.draft == "Message alpha" }
    await spin(0.2)
    let typed = ink(host, in: NSRect(x: 0, y: 0, width: 200, height: 34))
    let caretOnScreen = view.firstRect(forCharacterRange: NSRange(location: (view.string as NSString).length, length: 0), actualRange: nil)
    let caret = host.convert(window.convertFromScreen(caretOnScreen), from: nil)
    say(["name": "baseline", "placeholder": placeholder, "typed": typed, "flipped": host.isFlipped,
         "caretTop": Double(host.isFlipped ? caret.minY : host.bounds.height - caret.maxY),
         "caretBottom": Double(host.isFlipped ? caret.maxY : host.bounds.height - caret.minY)])

    // A composition (press-and-hold's accent menu, a dead key, Japanese input) survives SwiftUI updating the field, and
    // an outside change made meanwhile (a dictation landing) waits for it, then lands after it.
    drafts.draft = ""
    await until { view.string.isEmpty }
    await type(view, "abc")
    await until { drafts.draft == "abc" }
    view.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    await until { drafts.draft == "abcか" }
    let draftWhileMarked = drafts.draft
    let bodiesBefore = bodies
    await republish(drafts, 5)
    let afterUpdates: [String: Any] = ["text": view.string, "marked": view.hasMarkedText(), "updates": bodies - bodiesBefore]
    drafts.draft += " dictated"
    await republish(drafts, 2)
    let afterOutside: [String: Any] = ["text": view.string, "marked": view.hasMarkedText(), "draft": drafts.draft]
    view.setMarkedText("かん", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    await spin()
    view.insertText("漢", replacementRange: view.markedRange())
    await until { drafts.draft == view.string }
    await spin(0.2)
    say(["name": "marked", "draftWhileMarked": draftWhileMarked, "afterUpdates": afterUpdates, "afterOutside": afterOutside,
         "committed": view.string, "draft": drafts.draft, "marked": view.hasMarkedText()])

    // Return sends and leaves the words for the send to take; Shift- and Option-Return break the line; Return inside a
    // composition commits it and sends nothing.
    drafts.draft = ""
    await until { view.string.isEmpty }
    await type(view, "one")
    let sendsBefore = drafts.sends
    key(view, "\r", code: 36)
    await spin()
    let afterReturn: [String: Any] = ["text": view.string, "sends": drafts.sends - sendsBefore]
    key(view, "\r", code: 36, flags: .shift)
    await type(view, "two")
    key(view, "\r", code: 36, flags: .option)
    await type(view, "three")
    await until { drafts.draft == view.string }
    let afterNewlines: [String: Any] = ["text": view.string, "draft": drafts.draft, "sends": drafts.sends - sendsBefore]
    view.setMarkedText("é", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    await spin()
    key(view, "\r", code: 36)
    await until { drafts.draft == view.string }
    say(["name": "return", "afterReturn": afterReturn, "afterNewlines": afterNewlines,
         "afterComposingReturn": ["text": view.string, "draft": drafts.draft, "marked": view.hasMarkedText(), "sends": drafts.sends - sendsBefore]])

    // A long draft grows the field a line at a time to eight and no further, never scrolled while its words fit; at the
    // end the last lines are there to read; emptied, it is one line again with nothing scrolled away.
    drafts.draft = ""
    await until { view.string.isEmpty }
    var heights: [Double] = []
    var clips: [Double] = []
    for n in 1...12 {
        if n > 1 { key(view, "\r", code: 36, flags: .shift) }
        await type(view, "line \(n)")
        let expected = Double(min(22 * n, 176))
        await until { fieldHeight(view) == expected }
        await spin(0.05)
        let g = geometry(view)
        heights.append(g["field"] as! Double)
        clips.append(g["clipY"] as! Double)
    }
    view.scrollRangeToVisible(NSRange(location: (view.string as NSString).length, length: 0))
    await spin(0.2)
    let atEnd = geometry(view)
    let visibleInk = ink(view, in: view.enclosingScrollView!.contentView.documentVisibleRect)
    view.selectAll(nil)
    view.deleteBackward(nil)
    await until { fieldHeight(view) == 22 }
    await spin(0.1)
    let emptied = geometry(view)
    await type(view, "again")
    await until { drafts.draft == "again" }
    await spin(0.2)
    say(["name": "grow", "heights": heights, "clips": clips, "atEnd": atEnd, "visibleInk": visibleInk,
         "emptied": emptied, "again": geometry(view), "againInk": ink(view)])

    // One paragraph that wraps, at two widths: the field is as tall as the text lays out at each, nothing hidden.
    drafts.draft = String(repeating: "wrapping words go on and on ", count: 9)
    await until { view.string == drafts.draft }
    await spin(0.3)
    let wide = geometry(view)
    host.rootView = AnyView(Field(drafts: drafts).frame(width: 300).fixedSize(horizontal: false, vertical: true))
    await until { Double(view.enclosingScrollView!.frame.width) == 280 }
    await spin(0.3)
    let narrow = geometry(view)
    host.rootView = AnyView(Field(drafts: drafts).frame(width: 520).fixedSize(horizontal: false, vertical: true))
    await until { Double(view.enclosingScrollView!.frame.width) == 500 }
    await spin(0.3)
    say(["name": "width", "wide": wide, "narrow": narrow, "back": geometry(view)])

    // Outside changes land where they belong: a dictation after a caret at the end, the caret left on the word it was on
    // when the change is elsewhere, and a delivered send taking back exactly what it sent, in the field's own ink.
    drafts.draft = "hello"
    await until { view.string == "hello" }
    view.setSelectedRange(NSRange(location: 5, length: 0))
    drafts.draft = "hello world"
    await until { view.string == "hello world" }
    let dictated: [String: Any] = ["text": view.string, "caret": view.selectedRange().location]
    view.setSelectedRange(NSRange(location: 2, length: 0))
    drafts.draft = "hello world, more"
    await until { view.string == "hello world, more" }
    let middle: [String: Any] = ["text": view.string, "caret": view.selectedRange().location]
    view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
    drafts.draft = ", more"
    await until { view.string == ", more" }
    let sent: [String: Any] = ["text": view.string, "caret": view.selectedRange().location]
    drafts.draft = ""
    await until { view.string.isEmpty }
    await type(view, "x")
    await until { drafts.draft == "x" }
    await spin(0.2)
    say(["name": "outside", "dictated": dictated, "middle": middle, "sent": sent,
         "typingInk": luma((view.typingAttributes[.foregroundColor] as? NSColor) ?? .black), "afterEmptyInk": ink(view)])

    // Another session's draft replaces the field outright, mid-composition included, with no undo back into the last one.
    drafts.text["beta"] = "beta's own draft"
    drafts.draft = "alpha words"
    await until { view.string == "alpha words" }
    view.setSelectedRange(NSRange(location: (view.string as NSString).length, length: 0))
    view.setMarkedText("か", selectedRange: NSRange(location: 1, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    await until { drafts.draft == "alpha wordsか" }
    drafts.session = "beta"
    await until { view.string == "beta's own draft" }
    await spin(0.2)
    say(["name": "session", "text": view.string, "marked": view.hasMarkedText(), "canUndo": view.undoManager?.canUndo ?? true,
         "alpha": drafts.text["alpha"] ?? "", "beta": drafts.text["beta"] ?? "", "caret": view.selectedRange().location])

    // Focus: the field reports losing the keyboard, and the binding gives it back.
    window.makeFirstResponder(nil)
    let reportedLost = await until { !drafts.focused }
    drafts.focused = true
    let regained = await until { window.firstResponder === view }
    say(["name": "focus", "reportedLost": reportedLost, "regained": regained, "focused": drafts.focused])

    // Drops: files and images go past the editor to the composer's own drop target; text still lands in it.
    say(["name": "drag", "registered": view.registeredDraggedTypes.map(\.rawValue), "acceptable": view.acceptableDragTypes.map(\.rawValue)])

    // Dark to Light and back, as Auto appearance does at sunset: the words follow, dark ink on the light card.
    let darkInk = ink(view)
    window.appearance = NSAppearance(named: .aqua)
    await spin(0.3)
    let lightInk = ink(view)
    window.appearance = NSAppearance(named: .darkAqua)
    await spin(0.3)
    say(["name": "appearance", "dark": darkInk, "light": lightInk, "darkAgain": ink(view)])

    watchingFlags = false
    say(["name": "done", "writes": flagWrites, "switches": textKitSwitches, "textKit2": view.textLayoutManager != nil, "spelling": spelling(view)])
    exit(0)
}
app.run()

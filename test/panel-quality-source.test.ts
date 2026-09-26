import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** A Swift member from its signature to its closing brace at four-space indentation. */
function member(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf("\n    }\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** A top-level Swift type from its declaration to the next top-level declaration or mark. */
function type(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `missing: ${declaration}`).toBeGreaterThan(-1);
  const rest = source.slice(start + declaration.length);
  const next = rest.search(/\n(\/\/\/|\/\/ MARK|private struct|public struct|struct|extension|final class|enum|@MainActor)/);
  return source.slice(start, next < 0 ? undefined : start + declaration.length + next);
}

const panels = read("mac-app/conch-mac/FloatingPanels.swift");
const components = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
const glass = read("design/ConchDesign/Sources/ConchDesign/GlassPanel.swift");
const fogText = read("design/ConchDesign/Sources/ConchDesign/FogText.swift");
const ink = read("mac-app/conch-mac/AgentInkController.swift");
const fog = components.slice(components.indexOf("public struct ConversationFog: View {"), components.indexOf("// MARK: - Previews"));

/**
 * Full screen used to swap the glass out on its first frame: the rounded glass, its hairline and grab bar gone, a
 * square blur and wash in their place while the window was still docked-size, the words laid out at full-screen sizes
 * inside it, and the deliverable zooming in inside the window's own zoom. panel-lab keeps the glass, eases its corner
 * from 30 to 26 with a 12 pt margin, and fades the content in 120 ms after the morph lands.
 */
test("full screen stays glass all the way, and the words come back only once the morph lands", () => {
  // The glass is drawn in every form but the handle, its inset and corner the morph's, frame by frame.
  const host = member(panels, "private struct FogLookHost: View {");
  expect(host).toContain("radius: panels.glass.radius)\n                .padding(panels.glass.insets)");
  expect(host).not.toContain("isFullScreen");
  const step = member(panels, "func step(dt: Double) {");
  expect(step).toContain("glass = done ? morph.glassTo : PanelGlass.Geometry.lerp(morph.glassFrom, morph.glassTo, morph.progress)");
  expect(member(panels, "private func geometry(for form: Form) -> PanelGlass.Geometry {")).toContain("case .fullScreen: .fullScreen(menuBar: insets.top)");
  // No square wash under the words any more: the glass is the wash.
  expect(fog).not.toContain("Rectangle().fill(ConchColor.fog)");
  expect(fog).not.toContain("showsFog");
  // The words step aside as the morph starts, held at the size they had rather than laid out again on the way…
  const morph = member(panels, "private func morph(to target: NSRect, form next: Form) {");
  expect(morph).toContain("        revealAt = nil\n        revealed = false\n");
  expect(morph.indexOf("revealed = false")).toBeLessThan(morph.indexOf("morphing = (from:"));
  expect(morph).toContain("if wordsFrozen == nil { wordsFrozen = words.frame.size }");
  expect(member(panels, "private func layOut(margin: EdgeInsets) {")).toContain("let size = wordsFrozen ?? CGSize(");
  // …lay out for where it is going once it has all but landed, and come back 120 ms later on the reveal spring.
  expect(step).toContain("let arrives = !morph.arrived && (done || morph.progress >= Self.arrives)");
  expect(step).toContain("if arrives { arrive(morph.form, at: morph.form == .collapsed ? 0 : ConchMotion.revealDelay) }");
  const arrive = member(panels, "private func arrive(_ next: Form, at delay: TimeInterval) {");
  expect(arrive).toContain("form = next");
  expect(arrive).toContain("wordsFrozen = nil");
  expect(arrive).toContain("laidGlass = geometry(for: next)");
  expect(arrive).toContain("revealAt = ProcessInfo.processInfo.systemUptime + delay");
  expect(step).toContain("if let at = revealAt, now >= at {\n            revealAt = nil\n            revealed = true");
  // The words lay out for the form it landed in, never the one it is heading for.
  expect(panels).toContain("isFullScreen: panels.form == .fullScreen,");
  expect(panels).toContain("insets: panels.laidInsets.less(glass.insets),");
  expect(panels).toContain(".padding(glass.insets)");
  const revealed = type(panels, "private struct Revealed: ViewModifier {");
  expect(revealed).toContain(".animation(reduceMotion ? nil : (shown ? ConchMotion.reveal : ConchMotion.liftOff).animation(reduceMotion: false)) {");
  expect(revealed).toContain(".scaleEffect(shown || reduceMotion ? 1 : ConchMotion.revealScale)");
  expect(revealed).toContain(".blur(radius: shown || reduceMotion ? 0 : ConchMotion.revealBlur)");
  expect(revealed).toContain(".allowsHitTesting(shown)");
  expect(panels).toContain(".modifier(Revealed(shown: panels.revealed, reduceMotion: reduceMotion))");
  // The deliverable's card only fades: arriving inside the reveal, it never zooms inside a zoom. Its swap between two
  // deliverables is unchanged.
  const card = member(components, "private func deliverable(_ shown: FogContent?, frame: CGRect) -> some View {");
  expect(card).toContain(".offset(x: frame.minX, y: frame.minY)\n                .transition(.opacity)");
  // The canvas's tools hang under the full-screen header row as the full-screen glass lays it out, not the docked inset.
  expect(read("mac-app/conch-mac/Canvas.swift")).toContain("let glass = PanelGlass.Geometry.fullScreen(menuBar: panels.insets.top).insets");
  // Presses mid-morph are nobody's: the morph has the frame.
  expect(member(panels, "func pressed() {")).toContain("guard morphing == nil, form != .collapsed else { return }");
});

/** Collapse and expand were frame cuts, despite `ConchMotion.morph` saying it was for them. */
test("collapsing shrinks the glass into the handle and expanding grows it back, and both cut under Reduce Motion", () => {
  const collapse = member(panels, "private func setCollapsed(_ collapsed: Bool) {");
  expect(collapse).toContain("form: .collapsed)");
  expect(collapse).toContain("glassShows = true\n            morph(to:");
  expect(collapse).not.toContain("fog.setFrame(");
  // The glass gives way to the handle as it lands, which shows at once rather than after the reveal's beat.
  expect(member(panels, "private func arrive(_ next: Form, at delay: TimeInterval) {")).toContain("glassShows = next != .collapsed");
  expect(panels).toContain("if panels.form == .collapsed {\n                FogHandle(corner: panels.corner, hovering: panels.hovering) { panels.toggleCollapsed() }");
  expect(glass).toContain("public static func collapsed(corner: FogCorner) -> Geometry {");
  // Reduce Motion, and anything before the panels are up (a collapsed panel restored at launch), lands at once.
  const morph = member(panels, "private func morph(to target: NSRect, form next: Form) {");
  expect(morph).toContain("guard settled, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {");
  expect(morph).toContain("arrive(next, at: 0)");
  expect(member(panels, "private init(store: StateStore) {").trimEnd().endsWith("settled = true")).toBe(true);
  // The handle is the panel's buttons' glyph and glass.
  const handle = type(components, "public struct FogHandle: View {");
  expect(handle).toContain('.font(.system(size: 15, weight: .semibold))\n                    .foregroundStyle(ConchColor.overlayGlassIcon)');
  expect(handle).toContain(".overlayGlass(Circle())");
  expect(handle).not.toContain("ConchColor.textPrimary");
  expect(handle).not.toContain("weight: .bold");
});

test("the panel's keys: Esc, Command-Return, Previous and Next, Collapse, and the switcher's arrows, only while it has them", () => {
  // Seen before whatever view has the keyboard, so Command-Return works whether or not a reply is being typed.
  expect(panels).toContain("override func sendEvent(_ event: NSEvent) {\n        if event.type == .keyDown, let onKey, onKey(event) { return }\n        super.sendEvent(event)");
  expect(panels).toContain("fog.onKey = { [weak self] event in MainActor.assumeIsolated { self?.key(event) ?? false } }");
  const key = member(panels, "private func key(_ event: NSEvent) -> Bool {");
  expect(key).toContain("typing: fog.firstResponder is NSTextView");
  expect(key).toContain("case .exitFullScreen: if isFullScreen { toggleFullScreen() }");
  // Through the panel's own walk, over what is held (looked at or not), exactly as the buttons are.
  expect(key).toContain("guard let store, !ConchStatusItem.heldRows(store.state).isEmpty else { return false }");
  expect(key).toContain("queue.walk(backward: action == .previous, from: .panel, store: store, panels: self)");
  expect(panels).toContain("onPrevious: walks ? { queue.walk(backward: true, from: .panel, store: store, panels: panels) } : nil,");
  expect(key).toContain("case .collapse: toggleCollapsed()");
  expect(key).toContain("case .closeSwitcher: switching = false");
  expect(key).toContain("case let .move(step): switcherSelection = FogSession.selection(after: switcherSelection, in: switcherSessions, by: step)");
  expect(key).toContain("queue.pick(id, store: store, panels: self)");
  expect(key).toContain("case .giveBack: giveKeysBack()");
  // It takes the keys full screen and with the switcher open, and nowhere else; it gives them back leaving either.
  const toggle = member(panels, "func toggleFullScreen() {");
  expect(toggle.indexOf("takeKeys()")).toBeGreaterThan(toggle.indexOf("isFullScreen = true"));
  expect(toggle.indexOf("giveKeysBack()")).toBeLessThan(toggle.indexOf("} else {"));
  expect(panels.match(/takeKeys\(\)/g)?.length).toBe(3); // the definition, full screen, the switcher
  const switching = member(panels, "private func switchingChanged() {");
  expect(switching).toContain("takeKeys()");
  expect(switching).toContain("if !isFullScreen, !(fog.firstResponder is NSTextView) { giveKeysBack() }");
  // The canvas's way of handing the keys back, never activating anything.
  expect(member(panels, "private func giveKeysBack() {")).toContain("fog.orderOut(nil)\n        fog.orderFrontRegardless()");
  // Esc in the reply line hands the keys back too, docked; it used to leave the panel key and swallow the next keys.
  expect(components).toContain("view.window?.makeFirstResponder(nil)\n                // Left, the field no longer wants the keys; the host decides whether the panel keeps them.\n                field.onLeave?()");
  expect(fog.match(/onLeave: onLeaveReply\)/g)?.length).toBe(2);
  expect(panels).toContain("onLeaveReply: { panels.replyLeft() },");
  expect(member(panels, "func replyLeft() {")).toContain("guard !isFullScreen, !switching else { return }\n        giveKeysBack()");
});

test("the switcher closes on Esc, a click in another app, or the keys going elsewhere, and its rows walk by keyboard", () => {
  // The shortcuts sheet lists the switcher's keys with the panel's.
  expect(read("mac-app/conch-mac/ContentView.swift")).toContain('ShortcutHelpRow(command: "↑ / ↓, Return", result: "Pick a session in the switcher")');
  const switching = member(panels, "private func switchingChanged() {");
  expect(switching).toContain("outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown])");
  expect(switching).toContain("MainActor.assumeIsolated { self?.switching = false }");
  expect(switching).toContain("if let outsideClicks { NSEvent.removeMonitor(outsideClicks) }");
  expect(switching).toContain("switcherSelection = ConversationFogHost.session(store?.state, staged: staged)?.id");
  expect(panels).toContain("didSet { if switching != oldValue { switchingChanged() } }");
  expect(panels).toContain("forName: NSWindow.didResignKeyNotification,\n            object: fog,");
  expect(panels).toContain("self?.released(cancelled: true)\n                self?.switching = false");
  // The keyboard's row is lit like the hovered one.
  expect(panels).toContain("switcherSelection: panels.switcherSelection,");
  expect(components).toContain("let lit = here || session.id == selected || hovered == session.id");
});

/** Tyler's first complaint was the same thing shown twice; the second was replying blind. */
test("the header names the item only where the words are hidden, and the newest reply stays in reach full screen", () => {
  expect(fog.match(/header\(showsItem: shown != nil\)/g)?.length).toBe(2);
  expect(fog).toContain("let named = showsItem ? session : session.with(item: nil)");
  // Full screen on a deliverable: one quiet line of the newest reply above the floating reply, opened by a click.
  expect(fog).toContain("let newest = shown == nil ? nil : turns.last { !$0.fromYou }");
  const line = member(components, "private func newestLine(_ turn: ConversationTurn, width: CGFloat, room: CGFloat) -> some View {");
  expect(line).toContain("Button { newestOpen.toggle() } label: {");
  expect(line).toContain(".lineLimit(1)");
  expect(line).toContain(".fogControl()");
  expect(fog).toContain(".onChange(of: newest?.id) { _, _ in newestOpen = false }");
});

/** Live: the panel stayed on version 1 of an artifact after version 2 was published, until a manual re-pick. */
test("the panel follows a newer version of the item it is on, and the queue and the agent's marks follow with it", () => {
  expect(panels).toContain(".onChange(of: canvas.document?.has(.you) == true ? nil : Self.followed(store.state, staged: panels.staged, lastStaged: queue.lastStaged)) { _, newer in\n            if let newer { queue.follow(to: newer) }");
  // Held while Tyler has marks of his own on the canvas, which a new item would clear: they are on this version.
  expect(read("mac-app/conch-mac/Canvas.swift")).toContain("panels.$staged.combineLatest(panels.queue.$lastStaged)");
  // The header and full screen show the queue's key and nothing else, so they never disagree with the marks.
  expect(member(panels, "static func review(of row: SessionRow, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> ReviewInfo? {")).not.toContain("newest(of:");
  expect(member(panels, "func follow(to key: ReviewItem.ID) {")).toContain("lastStaged = key");
  expect(member(panels, "func newest(of key: ReviewItem.ID) -> ReviewItem.ID {")).toContain("DeliverableGroups.newest(of: key, in: versions) ?? key");
  const followed = member(panels, "static func followed(_ state: PublishedState?, staged: SessionRow.ID?, lastStaged: ReviewItem.ID?) -> ReviewItem.ID? {");
  expect(followed).toContain("guard let lastStaged, let row = state?.row(staged) else { return nil }");
  expect(followed).toContain("return newest == lastStaged ? nil : newest");
  // Following never counts it opened: only a hand-off does.
  expect(member(panels, "func follow(to key: ReviewItem.ID) {")).not.toContain("opened");
  // The agent's marks are drawn for the queue's key, so moving the key moves them.
  expect(ink).toContain("panels.$staged.combineLatest(panels.queue.$lastStaged)");
});

test("the panel says when there is nothing, why a reply didn't go, whom it replies to, and what the voice is reading", () => {
  const host = member(panels, "var body: some View {\n        let row = Self.session(store.state, staged: panels.staged)");
  expect(host).toContain("empty: row == nil ? Self.empty(store.liveness) : nil,");
  expect(host).toContain("showsReply: panels.showsReply && row != nil,");
  expect(host).toContain("notice: row.flatMap { store.rowMessages[$0.id] },");
  expect(host).toContain("speaking: Self.speaking(store.state, besides: row?.id),");
  const empty = member(panels, "static func empty(_ liveness: DaemonLiveness) -> String? {");
  expect(empty).toContain('case .alive: "No sessions yet"');
  expect(empty).toContain(`case .dead, .stalled: "conch isn't running"`);
  const speaking = member(panels, "static func speaking(_ state: PublishedState?, besides shown: SessionRow.ID?) -> FogSession? {");
  expect(speaking).toContain('state.live.state == "speaking", let id = WorkspaceFocus.addressed(in: Workspace(state)), id != shown');
  // The store's failure sentence is the one the dashboard and the phone show (ConchSendFailure).
  expect(read("mac-app/conch-mac/StateStore.swift")).toContain("rowMessages[outcome.sessionId] = ConchSendFailure.sentence(");
  expect(fog.match(/if let notice \{ noticeLine\(notice\) \}/g)?.length).toBe(2);
  expect(fog.match(/placeholder: Self\.placeholder\(for: session\)/g)?.length).toBe(2);
  expect(fog).toContain("SpeakingChip(session: speaking) { onPick(speaking.id) }");
});

test("the switcher, the Newest pill, the floating reply and the handle are glass that blurs what is under it", () => {
  const recipe = member(components, "func overlayGlass<S: InsettableShape>(_ shape: S) -> some View {");
  expect(recipe).toContain("shape.fill(.ultraThinMaterial)\n                shape.fill(ConchColor.overlayGlassStrong)");
  expect(member(components, "private func floatingReply(in size: CGSize, fontSize: CGFloat, height: CGFloat, overflows: Bool) -> some View {")).toContain(".overlayGlass(shape)");
  expect(member(components, "private func pill(top: Bool) -> some View {")).toContain(".overlayGlass(Capsule())");
  expect(type(components, "private struct FogSwitcher: View {")).toContain(".overlayGlass(shape)");
  // Nothing in the panel paints the strong glass on its own, without the blur under it: only the recipe does.
  expect(fog.match(/\.fill\(ConchColor\.overlayGlassStrong\)/g)?.length).toBe(1);
  expect(recipe).toContain(".fill(ConchColor.overlayGlassStrong)");
});

test("one left edge, a quieter faint state, the right marks and glyph sizes, and the lab's switcher", () => {
  expect(components).toContain("static let side: CGFloat = padding");
  // Pointer away, only the button fills fade, never an icon or the name; the lab's 0.4 over everything measured 2.1:1.
  expect(fog).toContain(".environment(\\.overlayFills, isFullScreen || hovering ? 1 : 0)\n                    .opacity(isFullScreen || !floating ? 1 : 0)");
  expect(fog).not.toContain("hovering ? 1 : 0.4");
  expect(type(components, "public struct IconButton: View {")).toContain(".opacity(fills)");
  // Working is the filled dot in active's blue (the menu's own, `StatusMenu.Dot`); the hollow ring is the sidebar's Paused.
  const switcher = type(components, "private struct FogSwitcher: View {");
  expect(switcher).toContain("Image(systemName: FogSession.markSymbol(session.standing))\n                    .font(.system(size: 7))\n                    .foregroundStyle(FogSession.markColor(session.standing))");
  expect(switcher).not.toContain('"circle"');
  expect(switcher).toContain("static let radius: CGFloat = 20");
  // No glyph under 11 pt on the panel: the header's chevron and the Newest pill's.
  for (const tiny of ["size: 9,", "size: 10,"]) expect(fog).not.toContain(tiny);
  expect(member(components, "private func pill(top: Bool) -> some View {")).toContain(".font(.system(size: 11, weight: .bold))");
  // The Newest pill's pop follows Reduce Motion.
  expect(fog).toContain(".transition(reduceMotion ? .opacity : .scale(scale: 0.85, anchor: top ? .top : .bottom).combined(with: .opacity))");
});

test("no spring in the panel is spelled out by hand: each is a ConchMotion token", () => {
  // The one derived spring is the throw's sideways curve, a fraction of the dock's own.
  const literal = /ConchSpring\(bounce: [0-9.a-z ?:]+, response: [0-9.]+\)/g;
  expect(components.match(literal) ?? []).toEqual([]);
  expect(fogText.match(literal) ?? []).toEqual([]);
  expect(panels.match(literal) ?? []).toEqual([]);
  expect(components).toContain("ConchSpring(bounce: 0, response: spring.response * 0.6)");
  expect(fogText).toContain("ConchMotion.sent.resolved(reduceMotion: reduceMotion).step(&flight.progress");
  expect(panels).toContain("if ConchMotion.hover.step(&resizeHover, velocity: &hoverVelocity, to: hoverTarget, dt: dt) {");
});

test("VoiceOver hears the switcher open, each row's standing, the pill's own words, and each panel's name", () => {
  const header = type(components, "private struct FogHeader: View {");
  expect(header).toContain('.accessibilityValue(isOpen ? "Sessions open" : "")');
  expect(type(components, "private struct FogSwitcher: View {")).toContain(".accessibilityValue(session.standing.spoken)");
  const pill = member(components, "private func pill(top: Bool) -> some View {");
  expect(pill).toContain('let label = text.scroll.unseen ? "New reply" : "Newest"');
  expect(pill).toContain(".accessibilityLabel(label)");
  expect(panels).toContain('controlBar.title = "Voice controls"\n        fog.title = "Conversation"');
});

test("every panel button says what it does and its key, and Collapse steps out full screen", () => {
  const button = type(components, "public struct IconButton: View {");
  expect(button).toContain(".help(Self.help(label, shortcut: shortcut))");
  const buttons = components.slice(components.indexOf("public struct FogPanelButtons: View {"), components.indexOf("// MARK: - FogHandle"));
  expect(buttons).toContain('if !isFullScreen {\n                IconButton(\n                    corner.bottom ? "chevron.down" : "chevron.up",\n                    label: "Collapse conversation",');
  for (const key of ["collapse", "previous", "next", "pen"]) expect(buttons).toContain(`shortcut: PanelKeys.Shortcut.${key}`);
  expect(buttons).toContain("shortcut: isFullScreen ? PanelKeys.Shortcut.exitFullScreen : PanelKeys.Shortcut.fullScreen,");
});

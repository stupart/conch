import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The menu bar item, what its Ready for you rows open, and how conch's window comes back. 2026-11-11: these were the
// parts of control-bar-source and overlays-source that guarded code which is still here; the rest of those files pinned
// the floating control bar, the conversation panel and the overlays switch, which went with the old overlays. What the
// rows open is now what it was with the overlays switched off: conch's window, or the deliverable in its own app.

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

const count = (source: string, text: string): number => source.split(text).length - 1;

const components = read("design/ConchDesign/Sources/ConchDesign/Components.swift");
const item = read("mac-app/conch-mac/StatusItem.swift");
const content = read("mac-app/conch-mac/ContentView.swift");
const store = read("mac-app/conch-mac/StateStore.swift");

/**
 * macOS 26 draws status items in Control Center, and the live app never logged its visibility. AppKit still
 * gives the button a stand-in window whose occlusion reports a hide, but it may not exist at install.
 */
test("the menu bar watcher attaches again after the delay, and says so once if it never can", () => {
  const watch = member(item, "private func watchOcclusion() {");
  expect(watch.match(/attachOcclusionObserver\(\)/g)?.length).toBe(2);
  expect(watch.indexOf("try? await Task.sleep(for: .seconds(3))")).toBeLessThan(watch.lastIndexOf("attachOcclusionObserver()"));
  expect(watch).toContain('NSLog("conch: cannot watch the menu bar item');
  expect(watch).not.toContain("guard let window");
  expect(member(item, "private func attachOcclusionObserver() {")).toContain(
    "forName: NSWindow.didChangeOcclusionStateNotification",
  );
});

// A Dock click must look for the dashboard itself, or a visible helper window would make it think conch is already
// showing and never bring the dashboard back. 2026-10-18: a browser page's parking window (visible, and other helpers
// that can be main) answered for it; only the registered dashboard counts, and with none SwiftUI is asked for one, since
// AppKit opens an untitled window only when nothing at all is visible. The floating panels that first made this matter
// went with the old overlays (2026-11-11); the parking windows still do.
test("a Dock click reopens the dashboard while parked pages are showing", () => {
  const app = read("mac-app/conch-mac/ConchMacApp.swift");
  const reopen = app.slice(app.indexOf("func applicationShouldHandleReopen("), app.indexOf("func userNotificationCenter("));
  expect(reopen).toContain("if let dashboard = ReviewNotifications.shared.reviewWindow, sender.windows.contains(where: { $0 === dashboard }) {");
  expect(reopen).toContain("dashboard.makeKeyAndOrderFront(nil)");
  expect(reopen).toContain("if hasVisibleWindows, let opens = sender.delegate?.applicationOpenUntitledFile {");
  expect(reopen).not.toContain("canBecomeMain");
  expect(reopen).not.toContain("if hasVisibleWindows { return true }");
});

test("the menu's Talk and Quiet are the daemon's global resume and pause", () => {
  expect(item).toContain("@objc private func talk() { store.send(.global(.resume)) }");
  expect(item).toContain("@objc private func quietMode() { store.send(.global(.pause)) }");
});

test("Ready is its own orb, the ready colour with a white checkmark", () => {
  // The light green in both schemes, where the white check clears 3:1 (ReadyTests measures it).
  expect(components).toContain(
    'case .ready:\n                Circle().fill(Self.readyFill.color)\n                Image(systemName: "checkmark")',
  );
  expect(components).toContain("public static let readyFill = ConchColor.ready.light");
  expect(components).not.toContain("case .talk, .ready:");
  // The listening mic is dark on the orange: white measured 2.06.
  expect(components).toContain("VoiceGlyph(.listening, size: size / 2).foregroundStyle(Self.onListening.color)");
});

/**
 * Tyler: "it brings 'the scene' to front … It's like the agents are messaging me 'look at this' and showing me stuff vs me
 * having to go find them". ConchDesignTests hold ReviewScene's order; these pin how the Mac wires it.
 */
test("a Ready for you row's scene: the link, else conch's window if open, else the terminal, else conch, falling through on failure", () => {
  const choose = member(components, "public static func choose(kind: Kind = .auto, link: URL?, fileExists: (String) -> Bool, appWindowOpen: Bool, revealable: Bool) -> ReviewScene {");
  const order = [
    "case .conversation: return .app",
    "case .terminal: return revealable ? .terminal : .app",
    "case .auto, .link: break",
    'if let link, ["http", "https"].contains(link.scheme?.lowercased() ?? "") { return .open(link) }',
    "if let link, link.isFileURL, fileExists(link.path) { return .open(link) }",
    "if appWindowOpen { return .app }",
    "if revealable { return .terminal }",
    "\n        return .app",
  ].map((line) => choose.indexOf(line));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  const stage = member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {");
  // The review's own trimmed link, resolved against the session's folder the way the dashboard resolves it.
  expect(stage).toContain("var link = ReviewItem(row: row)?.link.map { LinkTarget.url(for: $0, cwd: row.cwd) }");
  // The scene the review asked for; none, or one this build doesn't know, is auto.
  expect(stage).toContain('let kind = ReviewScene.Kind(rawValue: row.review?.sceneKind ?? "") ?? .auto');
  expect(stage).toContain("switch ReviewScene.choose(\n                kind: kind,\n                link: link,");
  expect(stage).toContain("fileExists: { FileManager.default.fileExists(atPath: $0) },");
  expect(stage).toContain("appWindowOpen: window.map { $0.isVisible && !$0.isMiniaturized } ?? false,");
  // Each scene on its existing path, handed off only when it says so, else the next scene.
  expect(stage).toContain("done.resume(returning: true)\n                    }) { _ in\n                        done.resume(returning: false)");
  expect(stage).toContain("if opened { return true }\n                link = nil");
  expect(stage).toContain("if await store.reveal(row).value {");
  expect(stage.indexOf("openApplication(at: terminal")).toBeLessThan(stage.indexOf("return true\n                }\n                revealable = false"));
  expect(stage).toContain("case .app:\n                openSession(row.id)\n                store.reportShowing(.conch(sessionId: row.id, view: \"main\"), staged: staged)\n                return true");
  expect(stage).toContain('NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal").first?.bundleURL');
  for (const later of ["asyncAfter", "Task.sleep", "Timer"]) expect(stage).not.toContain(later);
  // The door says it opened; reveal's value is the daemon's ack.
  expect(member(store, "func openLink(")).toContain("guard let error else { Task { @MainActor in onOpened(opener) }; return }");
  const reveal = member(store, "func reveal(_ row: SessionRow) -> Task<Bool, Never> {");
  expect(reveal).toContain("case let .acknowledgement(ack)? = try? JSONDecoder().decode(ConchSessionCommandReply.self, from: data) else { return false }");
  expect(reveal).toContain("return ack.changed");
  const open = member(item, "static func openSession(_ id: SessionRow.ID) {");
  expect(open).toContain("bringConchForward()");
  expect(open).toContain("NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: id)");
  expect(member(item, "@objc private func openSession(_ sender: NSMenuItem) {")).toContain("Self.openSession(id)");
});

/**
 * One opening rule for the menu's Ready for you rows: a deliverable conch's window draws in its deliverable pane opens
 * there, beside the conversation, and so does one only conch can show as it was published (marks, a folder's tree);
 * anything else comes forward in its own app. 2026-11-11: the conversation panel this rule used to choose between went with
 * the old overlays, so it is what it already was with them switched off.
 */
test("one opening rule: what conch's window draws, or only conch can show, opens there; anything else stages", () => {
  // The rule is ConchDesign's (XCTests pin its cases): the kinds the deliverable pane's renderers draw, by the filed kind.
  const rule = member(components, "public static func panelShowsContent(kind: Kind, deliverable: String?, link: URL?, fileExists: (String) -> Bool) -> Bool {");
  expect(components).toContain('static let panelKinds: Set<String> = ["page", "markdown", "text", "image", "pdf", "video", "audio", "url", "folder"]');
  expect(rule).toContain("guard case let .open(url) = choose(kind: kind, link: link, fileExists: fileExists, appWindowOpen: false, revealable: false) else { return false }");
  expect(rule).toContain("if let deliverable { return panelKinds.contains(deliverable) }");
  expect(member(components, "public static func opensOnlyInConch(deliverable: String?, marked: Bool) -> Bool {")).toContain(
    'marked || deliverable == "folder"',
  );
  // Read off the row as stage reads a scene, with the kind the daemon filed.
  const windowContent = member(item, "var windowContent: ReviewItem? {");
  expect(windowContent).toContain('let kind = ReviewScene.Kind(rawValue: review.sceneKind ?? "") ?? .auto');
  expect(windowContent).toContain("let link = item.link.map { LinkTarget.url(for: $0, cwd: cwd) }");
  expect(windowContent).toContain("ReviewScene.panelShowsContent(kind: kind, deliverable: review.kind, link: link, fileExists: { FileManager.default.fileExists(atPath: $0) }) ? item : nil");
  // conch's window when it draws it or only it can show it, and that is a handoff; anything else is stage's scene.
  const open = member(item, "static func open(_ row: SessionRow, store: StateStore) async -> Bool {");
  const order = [
    "let marked = !(row.review?.marks.isEmpty ?? true)",
    "if row.windowContent != nil || ReviewScene.opensOnlyInConch(deliverable: row.review?.kind, marked: marked) {",
    "openInWindow(row, store: store)\n            return true",
    "return await stage(row, store: store)",
  ].map((line) => open.indexOf(line));
  expect(order.every((at) => at > -1)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // One door into conch's window: the session, its deliverable pane on that version, beside the conversation.
  const door = member(item, "static func openInWindow(_ row: SessionRow, store: StateStore) {");
  expect(door).toContain("bringConchForward()");
  expect(door).toContain("NotificationCenter.default.post(name: .openInWindowFromStatusItem, object: WindowOpen(sessionId: row.id, reviewId: review?.id))");
  expect(door).toContain('store.reportShowing(.conch(sessionId: row.id, view: "main"), staged: ConchScreenStaged(sessionId: row.id, reviewId: review?.id, link: review?.link))');
  const mac = ["StatusItem.swift", "ContentView.swift"].map((name) => read(`mac-app/conch-mac/${name}`)).join("\n");
  expect(count(mac, ".openInWindowFromStatusItem")).toBe(2);
  expect(content).toContain(".onReceive(NotificationCenter.default.publisher(for: .openInWindowFromStatusItem)) { note in");
  const window = member(content, "private func openInWindow(_ row: SessionRow, review: ReviewItem.ID?) {");
  for (const line of [
    "workspace.viewing = row.id",
    "workspace.show(stage: .sideBySide, for: row.id)",
    "workspace.show(work: .deliverable, for: row.id)",
    "if let review { workspace.select(deliverable: review, for: row.id) }",
    "storedPage = .sessions",
  ]) {
    expect(window).toContain(line);
  }
});

/**
 * The daemon has no opened state for the app to set (`opened` is the terminal renderer's own), so the queue keeps its own,
 * by exact version, only after a handoff, and prefers the unopened. Opens run in order so a late one can't retarget.
 */
test("a row takes the exact review version, runs in order, and counts it opened only once handed off", () => {
  const find = member(item, "private static func find(_ key: ReviewItem.ID, in state: PublishedState?) -> SessionRow? {");
  expect(find).toContain("for row in ConchStatusItem.heldRows(state) {");
  expect(find).toContain("if let review = row.held.first(where: { ReviewItem(row: row, review: $0).id == key }) { return row.holding(review) }");
  // What has been looked at is the daemon's record unioned with this app's optimistic set,
  // and against a daemon too old to remember it is that local set alone.
  const seen = member(item, "private func seen(in held: [ReviewItem], state: PublishedState?) -> Set<ReviewItem.ID> {");
  expect(seen).toContain("guard state?.features?.viewedState != nil else { return opened }");
  // Looked at, or approved (done, 2026-10-05): either way not waiting.
  expect(seen).toContain("opened.union(held.filter { !ReadyForYou.isWaiting(viewedAt: $0.viewedAt, approvedAt: $0.approvedAt) }");
  // ReviewItem.id is the version: what the daemon minted at filing, or the key that stood in for it before there was one.
  expect(read("mac-app/conch-mac/ReviewView.swift")).toContain("id = ReviewIdentity.key(published: review.id, sessionId: row.id, filedAt: review.at)");
  const open = member(item, "func open(session id: SessionRow.ID, store: StateStore) {");
  const steps = [
    "let previous = staging",
    "staging = Task { @MainActor in",
    "await previous?.value",
    "guard let found = Self.find(item.id, in: store.state) else { return }",
    "guard await ConchStatusItem.open(found, store: store) else { return }",
    "opened.insert(item.id)",
    // Only once handed off, and only then told to the daemon, so every other surface agrees.
    "store.markReviewViewed(sessionId: found.id, review: item.id)",
  ].map((line) => open.indexOf(line));
  expect(steps.every((at) => at > -1)).toBe(true);
  expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  expect(item.match(/opened\.insert/g)?.length).toBe(1);
  expect(item.match(/markReviewViewed\(/g)?.length).toBe(1);
  // Nothing sent to the daemon for the scene itself, and no command invented.
  expect(member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {")).not.toContain("store.send(");
  expect(read("mac-app/conch-mac/ConchSocketClient.swift")).not.toMatch(/case (open|opened|markOpened|seen)\b/);
});

/** One queue, so every open agrees on what has been looked at: every deliverable a session that isn't working holds. */
test("the menu's rows open from one queue: every deliverable a session that isn't working holds, by version", () => {
  expect(item).toContain("    static let shared = ReviewQueue()\n");
  expect(item.match(/ReviewQueue\(\)/g)?.length).toBe(1);
  // Every held deliverable, not only each session's newest (`review`), which is all ReviewItem(row:) reads; looked at or
  // not. Only the unlooked-at count as ready (`ready(in:)`).
  expect(member(item, "static func held(_ state: PublishedState?) -> [ReviewItem] {")).toContain(
    "ConchStatusItem.heldRows(state).flatMap { row in row.held.map { ReviewItem(row: row, review: $0) } }",
  );
  const readyIn = member(item, "func ready(in held: [ReviewItem], state: PublishedState?) -> [ReviewItem] {");
  expect(readyIn).toContain("let seen = seen(in: held, state: state)");
  expect(readyIn).toContain("!seen.contains(key)");
  expect(member(item, "nonisolated static func heldRows(_ state: PublishedState?) -> [SessionRow] {")).toContain(
    "state?.rows.filter { $0.review != nil && $0.status != .working } ?? []",
  );
  // A row opens that session's next unlooked-at item, else its newest.
  expect(member(item, "func open(session id: SessionRow.ID, store: StateStore) {")).toContain(
    "guard let item = ready(in: held, state: store.state).first ?? held.last else { return }",
  );
  expect(member(item, "@objc private func openItem(_ sender: NSMenuItem) {")).toContain("ReviewQueue.shared.open(session: id, store: store)");
  expect(item).not.toContain("compactMap(ReviewItem.init(row:))");
  const held = member(item, "var held: [ReviewInfo] {");
  expect(held).toContain("if let reviews, !reviews.isEmpty { return reviews }");
  expect(held).toContain("return review.map { [$0] } ?? []");
  // An older one is staged through stage, unchanged, as the row's review.
  expect(member(item, "func holding(_ review: ReviewInfo) -> SessionRow {")).toContain("row.review = review");
  expect(read("mac-app/conch-mac/Models.swift")).toContain("    var review: ReviewInfo?\n");
});

test("opening a row never starts the mic or stops speech", () => {
  for (const body of [
    member(item, "func open(session id: SessionRow.ID, store: StateStore) {"),
    member(item, "static func open(_ row: SessionRow, store: StateStore) async -> Bool {"),
    member(item, "static func openInWindow(_ row: SessionRow, store: StateStore) {"),
    member(item, "static func stage(_ row: SessionRow, store: StateStore) async -> Bool {"),
  ]) {
    for (const voiceAction of [".dictate", ".stop(", ".wake", ".speak", "store.send("]) expect(body).not.toContain(voiceAction);
  }
});

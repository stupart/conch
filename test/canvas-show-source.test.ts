import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Show: the canvas recorded instead of stilled, and sent as a storyboard of frames. These pin what can't be run
// headless — the recording API, what it leaves out, the mic, narration asked of the daemon — and the rules that keep it
// from ever recording on its own.

const root = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** A Swift member from its signature to its closing brace at `indent` spaces. */
function member(source: string, signature: string, indent = 4): string {
  const start = source.indexOf(signature);
  expect(start, `missing: ${signature}`).toBeGreaterThan(-1);
  const end = source.indexOf(`\n${" ".repeat(indent)}}\n`, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const show = read("mac-app/conch-mac/CanvasShow.swift");
const canvas = read("mac-app/conch-mac/Canvas.swift");
const send = read("mac-app/conch-mac/CanvasSend.swift");
const storyboard = read("design/ConchDesign/Sources/ConchDesign/CanvasShow.swift");
const pill = read("design/ConchDesign/Sources/ConchDesign/CanvasToolPill.swift");
const project = read("mac-app/conch-mac.xcodeproj/project.pbxproj");
/** Every Swift file in the Mac app, by name. */
const macSources = Object.fromEntries(
  readdirSync(join(root, "mac-app/conch-mac"))
    .filter((name) => name.endsWith(".swift"))
    .map((name) => [name, read(`mac-app/conch-mac/${name}`)]),
);
/** The Mac files that mention `needle`. */
const filesWith = (needle: string): string[] => Object.keys(macSources).filter((name) => macSources[name]!.includes(needle)).sort();
/** `first` and `then` are both in `source`, in that order. */
function inOrder(source: string, first: string, then: string): void {
  expect(source, `missing: ${first}`).toContain(first);
  expect(source, `missing: ${then}`).toContain(then);
  expect(source.indexOf(first)).toBeLessThan(source.indexOf(then));
}

const record = member(show, "private func record() async throws {");

describe("the recording", () => {
  test("SCRecordingOutput writes the MP4, added before capture starts; never an asset writer", () => {
    expect(filesWith("SCRecordingOutput(")).toEqual(["CanvasShow.swift"]);
    expect(filesWith("SCStream(")).toEqual(["CanvasShow.swift"]);
    expect(filesWith("AVAssetWriter")).toEqual([]);
    expect(record).toContain("settings.outputFileType = .mp4");
    expect(record).toContain("let output = SCRecordingOutput(configuration: settings, delegate: self)");
    // The first frame is in the file only if the output is on the stream before it starts.
    inOrder(record, "try stream.addRecordingOutput(output)", "try await stream.startCapture()");
    // macOS 15's, and hidden below it.
    expect(show).toContain("@available(macOS 15.0, *)\n    static func start(on display: CGDirectDisplayID) async throws -> CanvasRecorder {");
    expect(canvas).toContain("onShow: CanvasController.canShow ? { canvas.toggleShow() } : nil");
    expect(project).toContain("/* CanvasShow.swift in Sources */ = {isa = PBXBuildFile;");
    expect(project.match(/\/\* CanvasShow\.swift in Sources \*\/,/g)?.length).toBe(1);
  });

  test("it leaves out conch's floating windows — the tools, the panel, the control bar, the ring — but not the glass", () => {
    expect(record).toContain("let hidden = NSApp.windows.filter { $0 is FloatingPanel && !($0.contentView is CanvasInkView) }.map(\\.windowNumber)");
    expect(record).toContain("let filter = SCContentFilter(display: screen, excludingWindows: content.windows.filter { hidden.contains(Int($0.windowID)) })");
    // Each display's glass is a floating panel whose content is its ink: that is what keeps it in.
    const build = member(canvas, "private func buildGlass() {");
    expect(build).toContain("let ink = CanvasInkView(display: display, controller: self)");
    expect(build).toContain("panel.contentView = ink");
    // Leaving out all of conch would drop conch's own window, which may be what is being shown.
    expect(show).not.toContain("excludingApplications");
    // The ring is a floating panel, in the window list before it is read.
    expect(member(show, "private static func ring(on screen: NSScreen) -> FloatingPanel {")).toContain("let panel = FloatingPanel(");
    inOrder(record, "ring.orderFrontRegardless()", "SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)");
  });

  test("it never opens the mic: narration is the daemon's, behind its one mic reservation", () => {
    expect(record).toContain("configuration.captureMicrophone = false");
    expect(record).toContain("configuration.capturesAudio = false");
    expect(filesWith("captureMicrophone")).toEqual(["CanvasShow.swift"]);
    expect(show).not.toMatch(/captureMicrophone = true|capturesAudio = true|microphoneCaptureDeviceID/);
    for (const mic of ["AVCaptureDevice", "AVAudioEngine", "AVAudioRecorder", "AVCaptureSession"]) {
      expect(filesWith(mic), mic).toEqual([]);
    }
    // What narration the app has is three socket requests; the daemon records.
    expect(filesWith('"narration-start"')).toEqual(["CanvasShow.swift"]);
    expect(filesWith("sox")).toEqual([]);
  });
});

describe("narration", () => {
  const narration = show.slice(show.indexOf("final class CanvasNarration {"));

  test("only with the pill's mic on, which is off until Tyler turns it on; the recording doesn't wait for it", () => {
    expect(canvas).toContain("@Published var narrate = false");
    expect(canvas).toContain("narrate: canvas.narrate,\n            onNarrate: { canvas.narrate.toggle() }");
    expect(filesWith("narrate = true")).toEqual([]);
    const toggle = member(show, "    func toggleShow() {");
    expect(toggle).toContain("if narrate { Task { await startNarration(for: recorder) } }");
    inOrder(toggle, "recorder = try await CanvasRecorder.start(on: display)", "if narrate {");
    // Asked from that one place, and only there: its definition and that call.
    expect(Object.values(macSources).join("\n").match(/startNarration\(/g)?.length).toBe(2);
    expect(filesWith("CanvasNarration.start(")).toEqual(["CanvasShow.swift"]);
    expect(show.match(/CanvasNarration\.start\(/g)?.length).toBe(1);
    // The pill's mic can't change a Show already started.
    expect(member(storyboard, "@ViewBuilder var showControl: some View {")).toContain(".disabled(recording != nil)");
  });

  test("refused, the pill says why and the Show goes on silent; one taken too late ends at once", () => {
    const start = member(show, "private func startNarration(for recorder: CanvasRecorder) async {");
    expect(start).toContain('message = "Recording without narration: \\(reason)."');
    expect(start).toContain("guard recorder.isRecording, self.recorder === recorder else { return narration.cancel() }");
    expect(start).not.toContain("stopShow");
    expect(start).not.toContain("discard");
  });

  test("Esc cancels it — the daemon deletes the WAV — before the Show is stopped and its folder removed", () => {
    const discard = member(show, "func discard() async {");
    inOrder(discard, "narration?.cancel()", "await stop()");
    expect(member(narration, "func cancel() {")).toContain('["kind": "narration-cancel", "canvasId": canvasId]');
  });

  test("the Show stopping stops it, and Send waits for the words before the folder moves", () => {
    const stop = member(show, "func stop() async -> TimeInterval {");
    inOrder(stop, "phase = .stopped(length)", "said = Task { await narration.stop(from: began) }");
    const stopNarration = member(narration, "func stop(from began: Date) async -> [CanvasStoryboard.Said] {");
    expect(stopNarration).toContain('["kind": "narration-stop", "canvasId": canvasId]');
    // The daemon's times are from when its recorder started; the storyboard's from when the recording began.
    expect(stopNarration).toContain("let offset = startedAt.timeIntervalSince(began)");
    expect(stopNarration).toContain("CanvasStoryboard.Said(start: $0.start + offset, end: $0.end + offset, text: $0.text)");
    const sendShow = member(show, "    func sendShow(_ recorder: CanvasRecorder) {");
    inOrder(sendShow, "await recorder.stop()", "let said = await recorder.said?.value ?? []");
    inOrder(sendShow, "let said = await recorder.said?.value ?? []", "try recorder.file(under: canvas.id)");
    expect(sendShow).toContain("CanvasRecorder.storyboard(video, ends: ends, said: said, canvas: canvas, about: label)");
    // The WAV moves with the MP4.
    expect(member(show, "func file(under id: String) throws {")).toContain("try files.moveItem(at: voice, to: named.appendingPathComponent(CanvasNarration.file))");
    // The words place frames, and are written beside them.
    const pull = member(show, "nonisolated static func storyboard(");
    expect(pull).toContain("CanvasStoryboard.moments(ends: ends, said: CanvasStoryboard.moments(of: said), length: length)");
    expect(pull).toContain("said: said, about: label, length: length).utf8), \"storyboard.md\", in: folder)");
  });

  test("its connection is the lease: held open, closed when it ends, never inherited by what the app launches", () => {
    const client = read("mac-app/conch-mac/ConchSocketClient.swift");
    const open = member(client, "func open<Request: Encodable>(_ request: Request, timeout: TimeInterval) async -> (reply: Data, descriptor: Int32)? {");
    inOrder(open, "Self.connectedSocket(to: socketPath, deadline: deadline)", "Darwin.fcntl(descriptor, F_SETFD, FD_CLOEXEC)");
    inOrder(open, "Darwin.fcntl(descriptor, F_SETFD, FD_CLOEXEC)", "Self.write(payload, to: descriptor, deadline: deadline)");
    expect(filesWith("ConchSocketClient().open(")).toEqual(["CanvasShow.swift"]);
    const start = member(narration, "static func start(_ canvasId: String) async -> Started {");
    // Refused: closed at once. Taken: kept, and let go after a stop or a cancel.
    inOrder(start, 'guard answer?["kind"] as? String == "narration-started"', "Darwin.close(lease)");
    inOrder(member(narration, "func stop(from began: Date) async -> [CanvasStoryboard.Said] {"), "ConchSocketClient().request(", "end()");
    inOrder(member(narration, "func cancel() {"), "ConchSocketClient().request(", "end()");
    expect(member(narration, "private func end() {")).toContain("Darwin.close(lease)");
  });
});

describe("only on an explicit Show", () => {
  test("recording starts only from toggleShow, which is the pill's record button and R with the pen down", () => {
    expect(filesWith("CanvasRecorder.start(")).toEqual(["CanvasShow.swift"]);
    expect(show.match(/CanvasRecorder\.start\(/g)?.length).toBe(1);
    expect(member(show, "    func toggleShow() {")).toContain("recorder = try await CanvasRecorder.start(on: display)");
    expect(filesWith("startCapture(")).toEqual(["CanvasShow.swift"]);
    expect(show.match(/startCapture\(/g)?.length).toBe(1);
    // Its definition, the pill's button and the R key: nothing else calls it, from outside or within.
    const calls = Object.entries(macSources).flatMap(([name, source]) =>
      (source.match(/[\w?.]*toggleShow\(\)/g) ?? []).map((call) => `${name}: ${call}`),
    );
    expect(calls.sort()).toEqual(["Canvas.swift: canvas.toggleShow()", "Canvas.swift: controller?.toggleShow()", "CanvasShow.swift: toggleShow()"]);
    expect(show).toContain("    func toggleShow() {");
    expect(canvas).toContain("case UInt16(kVK_ANSI_R) where controller?.armed == true:\n            // R with the pen down: Show (panel-lab's R).\n            controller?.toggleShow()");
  });

  test("the Screen Recording grant is checked silently, and asked for once, on a Show", () => {
    const granted = member(show, "static func granted() -> Bool {");
    inOrder(granted, "if CGPreflightScreenCaptureAccess() { return true }", "CGRequestScreenCaptureAccess()");
    expect(granted).toContain("if !asked {\n            asked = true\n            CGRequestScreenCaptureAccess()");
    const toggle = member(show, "    func toggleShow() {");
    inOrder(toggle, "guard CanvasRecorder.granted() else {", "CanvasRecorder.start(");
  });

  test("two minutes at most, then it stops and waits: the cap never sends", () => {
    expect(storyboard).toContain("public static let longest: TimeInterval = 120");
    expect(member(show, "    func toggleShow() {")).toContain("try? await Task.sleep(for: .seconds(CanvasStoryboard.longest))\n            await stopShow(recorder)");
    const stop = member(show, "private func stopShow(_ recorder: CanvasRecorder) async {");
    expect(stop).toContain("guard case .since = recorder.phase else { return }");
    expect(stop).not.toContain("store.send");
    expect(stop).not.toContain("sendShow");
  });
});

describe("Esc and Send", () => {
  test("Esc throws a Show away and says nothing was sent, before it would lift the pen or clear the ink", () => {
    const escape = member(canvas, "func escape() {");
    inOrder(escape, "if recorder != nil { return cancelShow() }", "armed ? lift() : clear()");
    const cancel = member(show, "    func cancelShow() {");
    expect(cancel).toContain("self.recorder = nil");
    expect(cancel).toContain('message = "Recording thrown away. Nothing was sent."');
    expect(cancel).toContain("Task { await recorder.discard() }");
    expect(cancel).not.toContain("store.send");
    expect(cancel).not.toContain("sendShow");
    inOrder(member(show, "func discard() async {"), "await stop()", "try? FileManager.default.removeItem(at: folder)");
  });

  test("Send with a Show goes where a still would, as one message through the composer's path", () => {
    expect(member(send, "    func send() {")).toContain("    func send() {\n        if let recorder { return sendShow(recorder) }\n");
    expect(canvas).toContain("canSend: drawn || canvas.recorder != nil,");
    const sendShow = member(show, "    func sendShow(_ recorder: CanvasRecorder) {");
    // Nowhere to send it: it keeps recording, and the pill says why.
    inOrder(sendShow, "guard let row = Self.route(state, panel: FloatingPanels.installed?.staged) else {", "await recorder.stop()");
    expect(sendShow).toContain("let delivery = store.send(.inject(sessionId: row.id, label: row.label, text: prompt))");
    expect(sendShow).toContain("try await CanvasRecorder.storyboard(video, ends: ends, said: said, canvas: canvas, about: label)");
    inOrder(sendShow, "store.send(.inject(", "clear()");
  });

  test("the message: what was shown and how long, the storyboard, a line a frame, and the MP4 for people", () => {
    const prompt = member(storyboard, "public static func prompt(");
    expect(prompt).toContain('var lines = ["[canvas] Tyler showed \\(label) (\\(clock(length))).", "Storyboard: \\(storyboard)"]');
    expect(prompt).toContain('"\\(stamp(frame.moment.at)) \\(frame.path) — \\(happened(frame.moment, first: index == 0, words: words[index]))"');
    expect(prompt).toContain('lines.append("The recording, for people (agents can\'t watch video): \\(video)")');
    expect(prompt).toContain('return lines.joined(separator: "\\n")');
  });

  test("an agent can answer a Show with marks, as it can a still: its folder is its canvas's id, the prompt says so", () => {
    const sendShow = member(show, "    func sendShow(_ recorder: CanvasRecorder) {");
    // The canvas is the document at Send, as the still's is; the recording moves under its id before anything is written.
    expect(sendShow).toContain("let document = document");
    inOrder(sendShow, "let canvas = recorder.canvas(document)", "try recorder.file(under: canvas.id)");
    inOrder(sendShow, "try recorder.file(under: canvas.id)", "CanvasRecorder.storyboard(video, ends: ends, said: said, canvas: canvas, about: label)");
    const canvasOf = member(show, "func canvas(_ document: CanvasDocument?) -> CanvasDocument {");
    expect(canvasOf).toContain("if let document, document.anchor.id == display { return document }");
    // No ink on the recorded display: that display bare, named by the folder it is already in.
    expect(canvasOf).toContain("return CanvasDocument(anchor: anchor, id: folder.lastPathComponent)");
    expect(show).toContain("anchor = CanvasAnchor(id: display, frame: ring.frame)");
    // The same folder a still of it has, and the one agent ink reads: the canvas root, by id.
    const file = member(show, "func file(under id: String) throws {");
    expect(file).toContain("let named = try CanvasFolder.make(id)");
    expect(file).toContain('try files.moveItem(at: video, to: named.appendingPathComponent("show.mp4"))');
    expect(file).toContain("folder = named");
    expect(member(show, "static func make(_ id: String) throws -> URL {")).toContain("let folder = root.appendingPathComponent(id, isDirectory: true)");
    expect(send).toContain("let folder = root.appendingPathComponent(document.id, isDirectory: true)");
    expect(member(send, "static func anchor(of id: String) -> CanvasAnchor? {")).toContain('root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("canvas.json")');
    // canvas.json is that canvas, always; the prompt ends as the still's does.
    const pull = member(show, "nonisolated static func storyboard(");
    expect(pull).toContain('_ = try CanvasFolder.save(try encoder.encode(canvas), "canvas.json", in: folder)');
    expect(pull).not.toContain("if let document");
    expect(pull).toContain("video: video.path, canvas: canvas)");
    const prompt = member(storyboard, "public static func prompt(");
    inOrder(prompt, "The recording, for people", "lines.append(CanvasPrompt.answer(canvas))");
  });

  test("frames no longer than 1568 px, the storyboard and the canvas beside the MP4, for Tyler alone", () => {
    const pull = member(show, "nonisolated static func storyboard(");
    expect(pull).toContain("let small = frames(160), full = frames(CanvasStoryboard.longEdge)");
    expect(pull).toContain("CanvasStoryboard.keep(moments, prints: prints)");
    expect(pull).toContain('"storyboard.md", in: folder)');
    expect(pull).toContain('"canvas.json", in: folder)');
    expect(storyboard).toContain("public static let longEdge: CGFloat = 1568");
    expect(storyboard).toContain("public static let most = 12");
    const make = member(show, "static func make(_ id: String) throws -> URL {");
    expect(make.match(/\.posixPermissions: 0o700/g)?.length).toBe(3);
    expect(member(show, "static func save(_ data: Data?, _ name: String, in folder: URL) throws -> URL {")).toContain(
      "attributes: [.posixPermissions: 0o600]",
    );
    expect(member(show, "func stop() async -> TimeInterval {")).toContain("[.posixPermissions: 0o600], ofItemAtPath: video.path");
    expect(send).toContain('appendingPathComponent(".cache/conch/canvas", isDirectory: true)');
  });
});

describe("on screen", () => {
  test("a Show keeps the glass and the pill up, and the ring round the screen is click-through and still under Reduce Motion", () => {
    expect(canvas).toContain("var inUse: Bool { armed || document?.isEmpty == false || recorder != nil }");
    // The pen's edge light is on the glass, which is recorded: off while recording, back once it stops.
    expect(member(canvas, "func apply() {")).toContain("armed: armed && recorder?.isRecording != true,");
    expect(member(canvas, "func show(_ document: CanvasDocument?, armed: Bool, agentHidden: Bool = false, agentName: String = \"Claude\") {")).toContain("light(armed)");
    inOrder(member(show, "func stop() async -> TimeInterval {"), "phase = .stopped(length)", "CanvasController.shared.apply()");
    const ring = member(show, "private static func ring(on screen: NSScreen) -> FloatingPanel {");
    expect(ring).toContain("panel.ignoresMouseEvents = true");
    expect(ring).toContain("if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {\n            let breathe = CABasicAnimation(keyPath: \"opacity\")");
    inOrder(ring, "if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {", 'edge.add(breathe, forKey: "breathe")');
    expect(ring).toContain("breathe.duration = ConchMotion.breathPeriod / 2");
    // The record button and its timer ride in the pill, beside undo.
    expect(pill).toContain('.accessibilityLabel("Undo")\n                showControl\n                separator\n                send');
    expect(storyboard).toContain("TimelineView(.periodic(from: start, by: 1)) { context in");
  });
});

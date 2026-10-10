import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeUploadId } from "../src/phone-uploads.ts";
import { VIDEO_TRANSCRIPT_KIND } from "../src/video-transcript.ts";

/**
 * A video dropped on the Mac's composer. Tyler, 2026-10-11: "we should be able to attach videos via drag and drop and
 * based i just tried and it failed."
 *
 * Measured before the fix, by handing SwiftUI's own drop destination a pasteboard shaped like each source (below): a
 * movie from Finder (a file URL) was taken; a PROMISED movie — what a screen recording's floating thumbnail
 * (screencaptureui's `ThumbnailPromiseProvider`), Photos and a browser drag — and a movie's bytes were both refused
 * (`draggingEntered` → no operation), so the drop ring never lit and nothing said why. A promised PNG (a screenshot's
 * thumbnail) was taken, which is why pictures worked and videos didn't. And over the words, which is most of the
 * composer, the editor claimed the drag before the composer could: a promised video by the files-promise type under its
 * dynamic UTI (and turned it away), and a file from Finder by its old URL name (and typed `file:///…/clip.mov`).
 */
const root = join(import.meta.dir, "..");
const mac = (file: string) => readFileSync(join(root, "mac-app", "conch-mac", file), "utf8");
const composer = mac("ComposerView.swift");
const editor = mac("ComposerEditor.swift");
const video = mac("ComposerVideo.swift");
const swift = Bun.which("swift");

function between(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, `missing: ${start}`).toBeGreaterThan(-1);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `missing after ${start}: ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop);
}

/** Compiled, then run: AppKit and SwiftUI need a real binary, not the interpreter. */
function runSwift(source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "conch-video-drop-"));
  try {
    writeFileSync(join(dir, "main.swift"), source);
    const build = Bun.spawnSync(["swiftc", "-o", join(dir, "probe"), join(dir, "main.swift")], { stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`swiftc exited ${build.exitCode}: ${build.stderr.toString()}`);
    const run = Bun.spawnSync([join(dir, "probe")], { stdout: "pipe", stderr: "pipe", cwd: dir });
    if (run.exitCode !== 0) throw new Error(`probe exited ${run.exitCode}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A drag's info, enough for a view's own dragging-destination methods. */
const FAKE_DRAG = `
final class FakeDrag: NSObject, NSDraggingInfo {
    let pasteboard: NSPasteboard; let location: NSPoint; weak var window: NSWindow?
    init(_ p: NSPasteboard, at l: NSPoint, in w: NSWindow) { pasteboard = p; location = l; window = w }
    var draggingDestinationWindow: NSWindow? { window }
    var draggingSourceOperationMask: NSDragOperation { [.copy, .generic, .link, .move] }
    var draggingLocation: NSPoint { location }
    var draggedImageLocation: NSPoint { location }
    var draggedImage: NSImage? { nil }
    var draggingPasteboard: NSPasteboard { pasteboard }
    var draggingSource: Any? { nil }
    var draggingSequenceNumber: Int { 1 }
    func slideDraggedImage(to screenPoint: NSPoint) {}
    override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
    var draggingFormation: NSDraggingFormation = .default
    var animatesToDestination = false
    var numberOfValidItemsForDrop = 1
    func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:], using block: @escaping (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    var springLoadingHighlight: NSSpringLoadingHighlight { .none }
    func resetSpringLoading() {}
}
final class Promiser: NSObject, NSFilePromiseProviderDelegate {
    func filePromiseProvider(_ p: NSFilePromiseProvider, fileNameForType fileType: String) -> String { "Screen Recording.mov" }
    func filePromiseProvider(_ p: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) { completionHandler(nil) }
}
let promiser = Promiser()
/** Each source's pasteboard: Finder's file URL, a promised movie, a movie's bytes, a promised picture. */
func pasteboard(_ shape: String) -> NSPasteboard {
    let board = NSPasteboard(name: NSPasteboard.Name("conch-video-drop-\\(UUID().uuidString)"))
    board.clearContents()
    switch shape {
    case "finder": board.writeObjects([URL(fileURLWithPath: "/tmp/clip.mov") as NSURL])
    case "promised movie": board.writeObjects([NSFilePromiseProvider(fileType: UTType.quickTimeMovie.identifier, delegate: promiser)])
    case "promised picture": board.writeObjects([NSFilePromiseProvider(fileType: UTType.png.identifier, delegate: promiser)])
    default:
        let item = NSPasteboardItem()
        item.setData(Data("ftypmp42".utf8), forType: NSPasteboard.PasteboardType(UTType.mpeg4Movie.identifier))
        board.writeObjects([item])
    }
    return board
}
`;

describe("what the composer's drop target takes", () => {
  /** The composer's own drop types, as `ComposerDropTarget` declares them. */
  const declared = between(composer, "content.onDrop(of: ", ", isTargeted: $isTargeted)").slice("content.onDrop(of: ".length);

  test.skipIf(!swift)("a promised movie and a movie's bytes are taken, as a movie, and the types before this were refusing them", () => {
    const out = runSwift(`import AppKit
import SwiftUI
import UniformTypeIdentifiers
${FAKE_DRAG}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
for (name, types) in [("composer", ${declared} as [UTType]), ("before", [.fileURL, .image] as [UTType])] {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 200), styleMask: [.borderless], backing: .buffered, defer: false)
    let host = NSHostingView(rootView: Color.gray.frame(width: 300, height: 200).onDrop(of: types, isTargeted: nil) { providers in
        print(name, "registered", providers.flatMap(\\.registeredTypeIdentifiers).joined(separator: ","))
        return true
    })
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    func destination(_ view: NSView) -> NSView? {
        if !view.registeredDraggedTypes.isEmpty { return view }
        for sub in view.subviews { if let found = destination(sub) { return found } }
        return nil
    }
    guard let target = destination(host) else { print(name, "no destination"); continue }
    for shape in ["finder", "promised movie", "movie bytes", "promised picture"] {
        let drag = FakeDrag(pasteboard(shape), at: NSPoint(x: 150, y: 100), in: window)
        let taken = target.draggingEntered(drag) != []
        print(name, shape, taken ? "taken" : "refused")
        if taken, shape == "promised movie" { _ = target.performDragOperation(drag) }
        target.draggingExited(drag)
    }
}
`);
    const said = (line: string) => expect(out, out.join("\n")).toContain(line);
    said("composer finder taken");
    said("composer promised movie taken");
    said("composer movie bytes taken");
    said("composer promised picture taken");
    // What SwiftUI hands `load`: a provider holding a QuickTime movie, which `receive` asks for as a file.
    said("composer registered com.apple.quicktime-movie");
    // The fix is the type, not the harness: the composer's old types refuse exactly the videos.
    said("before finder taken");
    said("before promised movie refused");
    said("before movie bytes refused");
    said("before promised picture taken");
  }, 120_000);

  test.skipIf(!swift)("over the words, the editor no longer claims a promised video; text drags are still its own", () => {
    const refused = between(editor, "    static let refusedDragTypes: Set<NSPasteboard.PasteboardType> = [", "\n    override var acceptableDragTypes");
    const out = runSwift(`import AppKit
import UniformTypeIdentifiers
${FAKE_DRAG}
final class Editor: NSTextView {
${refused}
    override var acceptableDragTypes: [NSPasteboard.PasteboardType] { super.acceptableDragTypes.filter { !Self.refusedDragTypes.contains($0) } }
}
for view in [Editor(usingTextLayoutManager: false), NSTextView(usingTextLayoutManager: false)] {
    view.isRichText = false
    view.importsGraphics = false
    let name = view is Editor ? "editor" : "plain"
    for shape in ["finder", "promised movie", "movie bytes", "promised picture"] {
        let claims = Set(pasteboard(shape).types ?? []).intersection(view.acceptableDragTypes)
        print(name, shape, claims.isEmpty ? "leaves it" : "claims it")
    }
    let link = NSPasteboard(name: NSPasteboard.Name("conch-video-drop-link-\(UUID().uuidString)"))
    link.clearContents()
    link.writeObjects([URL(string: "https://example.com/talk")! as NSURL])
    print(name, "web link", Set(link.types ?? []).intersection(view.acceptableDragTypes).isEmpty ? "leaves it" : "takes it")
    print(name, "text", view.acceptableDragTypes.contains(NSPasteboard.PasteboardType("NSStringPboardType")) ? "takes it" : "leaves it")
}
`);
    const said = (line: string) => expect(out, out.join("\n")).toContain(line);
    for (const shape of ["finder", "promised movie", "movie bytes", "promised picture"]) said(`editor ${shape} leaves it`);
    // Words and links dragged in are still the editor's.
    said("editor text takes it");
    said("editor web link takes it");
    // A plain text view claims a promised video and a file from Finder (by its old URL name, as `file:///…`): the
    // editor's list is what stops it.
    said("plain promised movie claims it");
    said("plain finder claims it");
  }, 120_000);

  test("the refused types name the files promise as AppKit registers it, and a file's URL by its old name", () => {
    const refused = between(editor, "    static let refusedDragTypes: Set<NSPasteboard.PasteboardType> = [", "\n    override var acceptableDragTypes");
    expect(refused).toContain("filePromise, filePromiseAsRegistered,");
    expect(refused).toContain('static let filePromise = NSPasteboard.PasteboardType("Apple files promise pasteboard type")');
    expect(refused).toContain('UTType(tag: filePromise.rawValue, tagClass: UTTagClass(rawValue: "com.apple.nspboard-type"), conformingTo: .data)?.identifier');
    expect(refused).toContain('NSPasteboard.PasteboardType("CorePasteboardFlavorType 0x6D6F6F76")');
    expect(refused).toContain('NSPasteboard.PasteboardType("Apple URL pasteboard type")');
  });
});

describe("what a drop becomes", () => {
  const load = between(composer, "    private func load(_ providers: [NSItemProvider]) {", "\n    }\n\n    /// A video without a file of its own");
  const receive = between(composer, "    private func receive(_ type: String, from provider: NSItemProvider) {", "\n    }\n");

  test("a file, then a video without a file of its own, then picture bytes; anything else is said", () => {
    const order = [
      "provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)",
      "UTType($0)?.conforms(to: .movie) == true",
      "receive(movie, from: provider)",
      "UTType($0)?.conforms(to: .image) == true",
    ].map((step) => load.indexOf(step));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nothing vanishes: a file not there, a picture that can't be read, a kind conch doesn't take.
    expect(load).toContain('videos.refused(name, to: session, because: "conch couldn\'t find it")');
    expect(load).toContain('videos.refused(name, to: session, because: "conch couldn\'t read it")');
    expect(load).toContain('because: "conch attaches files, pictures and videos")');
  });

  test("a promised or handed-over video is kept under its own name, attached as a file, and said when it never comes", () => {
    expect(receive).toContain("let arrival = videos.arriving(suggested ?? \"A video\", to: session)");
    expect(receive).toContain("provider.loadFileRepresentation(forTypeIdentifier: type)");
    // Copied inside the handler: the provider's file is gone once it returns.
    expect(receive.indexOf("ComposerDropFolder.keep(file, named: suggested, type: UTType(type))")).toBeLessThan(receive.indexOf("Task { @MainActor in"));
    // Known as a video by its name, so a name without an extension is given the type's.
    expect(video).toContain("if copy.pathExtension.isEmpty, let ext = type?.preferredFilenameExtension { copy.appendPathExtension(ext) }");
    expect(receive).toContain("attach([url])");
    expect(receive).toContain('videos.arrived(arrival, to: session, failure: "It never arrived")');
    expect(receive).toContain("try? await Task.sleep(for: .seconds(300))");
    expect(receive).toContain("progress.cancel()");
    // The folder is conch's, for Tyler alone, pruned as canvases are.
    expect(video).toContain('appendingPathComponent(".cache/conch/attachments", isDirectory: true)');
    expect(video).toContain("attributes: [.posixPermissions: 0o700]");
  });

  test("the + picker offers videos too", () => {
    expect(composer).toContain("panel.allowedContentTypes = [.image, .movie, .pdf, .plainText]");
    expect(composer).toContain('.help("Attach pictures, videos or files")');
  });

  test("every way on (dropped, picked, received) makes a video ready from the moment it is attached", () => {
    const attach = between(composer, "    private func attach(_ urls: [URL]) {", "\n    }\n");
    expect(attach).toContain("for url in fresh where VideoAttachment.isVideo(url) { ComposerVideos.shared.prepare(url, again: true) }");
    // One that failed is tried again when it is attached again, not every time its tile is drawn.
    expect(video).toContain("case .failed? where !again:");
    // And a draft's video after a relaunch, from its tile.
    expect(between(composer, "private struct VideoTile<Remove: View>: View {", "\n}\n")).toContain("videos.prepare(url)");
  });
});

describe("what a video sends", () => {
  test("the message is the phone's: paths, then each video's contact sheet and words, then his words", () => {
    expect(composer).toContain("VideoAttachment.message(text: draft, attachments: attachments) { videos.block(for: $0) }");
    expect(video).toContain("return brief.block(video: url.path)");
    expect(readFileSync(join(root, "design/ConchDesign/Sources/ConchDesign/VideoAttachment.swift"), "utf8"))
      .toContain("VideoStoryboard.prompt(frames, said: said, length: length, sheet: sheet, video: video, from: .mac)");
  });

  test("it doesn't send until every video is ready, and the button says why", () => {
    const canSend = between(composer, "    private var canSend: Bool {", "\n    }\n");
    expect(canSend).toContain("videoReadiness == nil");
    expect(composer).toContain("VideoAttachment.readiness(attachments.filter(VideoAttachment.isVideo).map { videos.status(of: $0) })");
    expect(composer).toContain('.help(messageUnavailableReason ?? videoReadiness ?? "Send to \\(sessionLabel)")');
  });

  test("made ready in order: its sound, its words from the daemon, then its frames, into conch's uploads", () => {
    const prepare = between(video, "    static func prepare(_ url: URL) async -> VideoAttachment.Status {", "\n    }\n");
    const order = [
      "asset.loadTracks(withMediaType: .video)",
      "VideoStoryboard.speech(of: url)",
      'save(speech, as: "\\(id).wav")',
      "said = await transcript(of: wav)",
      "FileManager.default.removeItem(at: wav)",
      "VideoStoryboard.sheet(of: url, said: said, length: min(length, VideoStoryboard.longest))",
      'save(sheet.jpeg, as: "\\(id).jpg")',
      "return .ready(VideoAttachment.Brief(frames: sheet.frames, said: said, length: length, sheet: file.path))",
    ].map((step) => prepare.indexOf(step));
    expect(order.every((at) => at >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A video that can't be read says so on its tile.
    for (const why of ["There's no video in it", "conch can't read this video", "conch couldn't take frames from it"]) {
      expect(prepare).toContain(`.failed("${why}")`);
    }
    // The daemon's folder (`new PhoneUploads(join(CONCH_DATA, "uploads"))`) and its request, by name.
    expect(video).toContain('appendingPathComponent(".cache/conch/uploads", isDirectory: true)');
    expect(readFileSync(join(root, "src/daemon.ts"), "utf8")).toContain('new PhoneUploads(join(CONCH_DATA, "uploads"))');
    expect(video).toContain(`ConchSocketClient().request(["kind": "${VIDEO_TRANSCRIPT_KIND}", "path": wav.path], timeout: reading)`);
    // Named as the uploads folder names things, so the daemon transcribes it and the receipt and `/file` know it.
    expect(prepare).toContain('let id = "mac-\\(UUID().uuidString)"');
    expect(sanitizeUploadId(`mac-${crypto.randomUUID().toUpperCase()}`)).not.toBeNull();
    expect(video).toContain("files.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])");
  });

  test("its tile never reads a video as a picture", () => {
    const preview = between(composer, "private struct AttachmentPreview: View {", "private var removeButton");
    expect(preview).toContain("private var image: NSImage? { isVideo ? nil : NSImage(contentsOf: url) }");
    expect(preview.indexOf("if isVideo {")).toBeLessThan(preview.indexOf("} else if let image {"));
  });

  test("the app builds it", () => {
    const project = readFileSync(join(root, "mac-app/conch-mac.xcodeproj/project.pbxproj"), "utf8");
    expect(project.match(/\/\* ComposerVideo\.swift in Sources \*\/,/g)?.length).toBe(1);
  });
});

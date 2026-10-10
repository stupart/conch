import AppKit
import AVFoundation
import ConchDesign
import SwiftUI
import UniformTypeIdentifiers

/// Videos on the composer, made ready for an agent as the phone's are.
///
/// Tyler, 2026-10-11: "we should be able to attach videos via drag and drop and based i just tried and it failed." Two
/// ways it failed. A screen recording's floating thumbnail, a video from Photos or one from a browser is a PROMISED file,
/// a movie the source writes once the drop is taken; the composer took files, image bytes and promised images only, so
/// the drop was refused and nothing on screen said so. A video from Finder did attach, and went as its bare path, which
/// no agent can watch. So a video now goes as the phone's does (`VideoStoryboard`): a contact sheet of its frames and
/// its words, timed, which an agent reads at once, and the file itself, for people. Its sound and frames are pulled by
/// the phone's own code (`VideoFrames.swift`), whisper reads the sound in the daemon (`src/video-transcript.ts`), and
/// the files land beside the phone's uploads, so the same receipt (`SentReceipt`) stands for it in the conversation.
///
/// Made ready as it is attached, not at Send: a video that can't be read says so on its tile, before anything goes.
@MainActor
final class ComposerVideos: ObservableObject {
    static let shared = ComposerVideos()

    /// A drop on its way to the composer, or one that never arrived and why: a promised video takes a moment to be
    /// written (Photos may fetch it from iCloud first), and one that fails must say so rather than vanish.
    struct Arrival: Identifiable, Equatable {
        let id = UUID()
        let name: String
        var failure: String?
    }

    /// Each video's state, by its file, wherever it is attached: one dropped on the window's composer and sent from the
    /// panel's is the same video.
    @Published private(set) var statuses: [URL: VideoAttachment.Status] = [:]
    /// Each session's drops on their way, and those that failed, until they land or are dismissed.
    @Published private(set) var arrivals: [String: [Arrival]] = [:]

    func status(of url: URL) -> VideoAttachment.Status? { statuses[url] }

    /// Starts making `url` ready, unless it is being made ready or already is (and its contact sheet is still there:
    /// conch's uploads folder keeps a day). One that failed is tried `again` only when it is attached again, not each
    /// time its tile is drawn.
    func prepare(_ url: URL, again: Bool = false) {
        switch statuses[url] {
        case .preparing?:
            return
        case let .ready(brief)? where FileManager.default.fileExists(atPath: brief.sheet):
            return
        case .failed? where !again:
            return
        default:
            break
        }
        statuses[url] = .preparing
        Task {
            // Off the main thread: reading two minutes of sound and pulling frames is seconds of work.
            let status = await Task.detached(priority: .userInitiated) { await ComposerVideoPrep.prepare(url) }.value
            statuses[url] = status
        }
    }

    /// The message's block for `url`, once it is ready.
    func block(for url: URL) -> String? {
        guard case let .ready(brief)? = statuses[url] else { return nil }
        return brief.block(video: url.path)
    }

    func arriving(_ name: String, to session: String) -> UUID {
        let arrival = Arrival(name: name)
        arrivals[session, default: []].append(arrival)
        return arrival.id
    }

    /// It landed (and is attached), or it didn't and the reason stays on the composer until dismissed.
    func arrived(_ id: UUID, to session: String, failure: String? = nil) {
        guard let index = arrivals[session]?.firstIndex(where: { $0.id == id }) else { return }
        if let failure {
            arrivals[session]?[index].failure = failure
        } else {
            dismiss(id, from: session)
        }
    }

    /// Something dropped that can't be attached at all, said on the composer.
    func refused(_ name: String, to session: String, because failure: String) {
        var arrival = Arrival(name: name)
        arrival.failure = failure
        arrivals[session, default: []].append(arrival)
    }

    func dismiss(_ id: UUID, from session: String) {
        arrivals[session]?.removeAll { $0.id == id }
        if arrivals[session]?.isEmpty == true { arrivals[session] = nil }
    }
}

/// The work of making a video ready, off the main thread: whether it is one, its sound, its words, its contact sheet.
enum ComposerVideoPrep {
    /// conch's uploads folder (`PhoneUploads`, `~/.cache/conch/uploads`): where the phone's video lands, and so where
    /// the daemon transcribes from and the receipt and the phone's `/file` look for a contact sheet. Swept after a day.
    static let uploads = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/conch/uploads", isDirectory: true)
    /// Reading two minutes of voice: the warm server, else the cold one once (`CanvasNarration.reading`).
    static let reading: TimeInterval = 150

    static func prepare(_ url: URL) async -> VideoAttachment.Status {
        guard FileManager.default.fileExists(atPath: url.path) else { return .failed("It isn't there any more") }
        let asset = AVURLAsset(url: url)
        let length: Double
        do {
            guard try await !asset.loadTracks(withMediaType: .video).isEmpty else { return .failed("There's no video in it") }
            length = try await asset.load(.duration).seconds
        } catch {
            NSLog("conch: couldn't read the video %@: %@", url.path, error.localizedDescription)
            return .failed("conch can't read this video")
        }
        guard length.isFinite, length > 0 else { return .failed("conch can't read this video") }
        // Names the uploads folder takes (`sanitizeUploadId`), marked as the Mac's.
        let id = "mac-\(UUID().uuidString)"
        var said: [CanvasStoryboard.Said] = []
        // Without words it goes on, as the phone's does: its frames every three seconds instead of where he spoke.
        if let speech = try? await VideoStoryboard.speech(of: url), let wav = try? save(speech, as: "\(id).wav") {
            said = await transcript(of: wav)
            try? FileManager.default.removeItem(at: wav)
        }
        guard let sheet = await VideoStoryboard.sheet(of: url, said: said, length: min(length, VideoStoryboard.longest)) else {
            return .failed("conch couldn't take frames from it")
        }
        guard let file = try? save(sheet.jpeg, as: "\(id).jpg") else { return .failed("conch couldn't save its frames") }
        return .ready(VideoAttachment.Brief(frames: sheet.frames, said: said, length: length, sheet: file.path))
    }

    /// What was said in the recording at `wav`, timed, from the daemon's whisper; nothing when it can't say.
    static func transcript(of wav: URL) async -> [CanvasStoryboard.Said] {
        let outcome = await ConchSocketClient().request(["kind": "video-transcript", "path": wav.path], timeout: reading)
        guard case let .reply(data) = outcome, let reply = try? JSONDecoder().decode(Transcript.self, from: data) else {
            NSLog("conch: no words for a video: %@", String(describing: outcome))
            return []
        }
        if let error = reply.error { NSLog("conch: no words for a video: %@", error) }
        return (reply.segments ?? []).map { CanvasStoryboard.Said(start: $0.start, end: $0.end, text: $0.text) }
    }

    private struct Transcript: Decodable {
        struct Segment: Decodable {
            let start: Double
            let end: Double
            let text: String
        }

        let segments: [Segment]?
        let error: String?
    }

    /// A file in the uploads folder, for Tyler alone (the folder 0700, the file 0600), never over anything there.
    static func save(_ data: Data, as name: String) throws -> URL {
        let files = FileManager.default
        try files.createDirectory(at: uploads, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = uploads.appendingPathComponent(name)
        guard !files.fileExists(atPath: url.path),
              files.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        return url
    }

    /// Its first frame, small, for its tile.
    static func poster(of url: URL) async -> NSImage? {
        guard let image = try? await VideoStoryboard.frames(of: url, edge: 160).image(at: CMTime(seconds: 0.1, preferredTimescale: 600)).image else {
            return nil
        }
        return NSImage(cgImage: image, size: .zero)
    }
}

/// Where a video that arrived without a file of its own is kept: one promised by Photos, a screen recording's
/// thumbnail or a browser, or handed over as bytes. `~/.cache/conch/attachments/<id>/<its name>`, so the agent and the
/// tile see the name it had, for Tyler alone, and gone two weeks on, as canvases are (`CanvasFolder`).
enum ComposerDropFolder {
    static let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cache/conch/attachments", isDirectory: true)
    static let kept: TimeInterval = 14 * 24 * 3600

    /// A copy of `file`, which is the provider's and goes once its handler returns, named `name` when it has one, and
    /// always with an extension that says it is a `type`: a video is known as one by its name (`VideoAttachment.isVideo`).
    static func keep(_ file: URL, named name: String?, type: UTType? = nil) throws -> URL {
        let files = FileManager.default
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        prune(files)
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try files.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        var copy = folder.appendingPathComponent(fileName(file, named: name))
        if copy.pathExtension.isEmpty, let ext = type?.preferredFilenameExtension { copy.appendPathExtension(ext) }
        try files.copyItem(at: file, to: copy)
        try? files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: copy.path)
        return copy
    }

    /// The name a provider suggests, with the extension its file has; else the file's own. Never a path.
    static func fileName(_ file: URL, named name: String?) -> String {
        let suggested = (name ?? "").replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !suggested.isEmpty, !suggested.hasPrefix(".") else { return file.lastPathComponent }
        let ext = file.pathExtension
        return ext.isEmpty || suggested.lowercased().hasSuffix(".\(ext.lowercased())") ? suggested : "\(suggested).\(ext)"
    }

    static func prune(_ files: FileManager) {
        let old = Date().addingTimeInterval(-kept)
        for folder in (try? files.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [] {
            if let changed = try? folder.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, changed < old {
                try? files.removeItem(at: folder)
            }
        }
    }
}

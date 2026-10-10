import Foundation
import UniformTypeIdentifiers

/// A video on the Mac's composer, made ready for an agent the way the phone makes one (`VideoStoryboard`).
///
/// Tyler, 2026-10-11: "we should be able to attach videos via drag and drop and based i just tried and it failed." A
/// screen recording's thumbnail, a video from Photos, one from QuickTime or a browser arrives as a promised file the
/// composer refused, so nothing happened at all; one from Finder went as its bare path, which an agent can't watch. So a
/// video goes as the phone's does: a contact sheet of its frames and its words, timed, and the file itself, for people.
/// This is the pure part: what a video on the composer is, what it says while it gets ready, and the message it makes.
/// The work itself is the Mac app's (`ComposerVideo.swift`), on `VideoFrames.swift`'s code, the phone's own.
public enum VideoAttachment {
    /// What an agent is sent for a video, once its frames and words are read.
    public struct Brief: Equatable, Sendable {
        public let frames: [CanvasStoryboard.Moment]
        public let said: [CanvasStoryboard.Said]
        /// The whole video's length, in seconds; its frames and words cover at most `VideoStoryboard.longest` of it.
        public let length: Double
        /// The contact sheet's path.
        public let sheet: String

        public init(frames: [CanvasStoryboard.Moment], said: [CanvasStoryboard.Said], length: Double, sheet: String) {
            self.frames = frames
            self.said = said
            self.length = length
            self.sheet = sheet
        }

        /// The message's block for the video at `video`, in the phone's words but from the Mac.
        public func block(video: String) -> String {
            VideoStoryboard.prompt(frames, said: said, length: length, sheet: sheet, video: video, from: .mac)
        }
    }

    public enum Status: Equatable, Sendable {
        /// Its sound being read, its words transcribed, its frames pulled.
        case preparing
        case ready(Brief)
        /// Why it can't go, in the chip's words.
        case failed(String)
    }

    /// Whether `url` is a video, by what the file says it is, else by its extension (a file not yet there).
    public static func isVideo(_ url: URL) -> Bool {
        let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType ?? UTType(filenameExtension: url.pathExtension)
        return type?.conforms(to: .movie) == true
    }

    /// The message: each other file's path first, a line each (Claude Code and Codex read a picture by its path), then
    /// each video's block, then the words. A video without a block yet goes as its path; the composer doesn't send one
    /// (`readiness`).
    public static func message(text: String, attachments: [URL], block: (URL) -> String?) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let videos = attachments.filter(isVideo)
        let files = attachments.filter { !isVideo($0) }.map(\.path)
        let blocks = videos.map { block($0) ?? $0.path }
        return (files + blocks + (words.isEmpty ? [] : [words])).joined(separator: "\n")
    }

    /// Whether the composer can send with these videos on it, and when not, why: one still getting ready, or one that
    /// can't go until it is taken off. Nil when every video is ready.
    public static func readiness(_ statuses: [Status?]) -> String? {
        if statuses.contains(where: { if case .failed = $0 { true } else { false } }) {
            return "Remove the video conch couldn't read to send"
        }
        if statuses.contains(where: { if case .ready = $0 { false } else { true } }) {
            return "Getting the video ready for the agent…"
        }
        return nil
    }

    /// What a video's tile says under its picture: how long, and, cut, how much of it the agent reads.
    public static func caption(length: Double) -> String {
        VideoStoryboard.isCut(length)
            ? "first \(CanvasStoryboard.clock(VideoStoryboard.longest)) of \(CanvasStoryboard.clock(length))"
            : CanvasStoryboard.clock(length)
    }
}

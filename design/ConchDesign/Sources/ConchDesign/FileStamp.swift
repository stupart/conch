import Foundation

/// What changes when a file is written: which file it is (device and inode), its size and its modification time, read
/// with one `stat` and never the file itself.
///
/// The Mac polls the daemon's published state four times a second, and it read and decoded the whole file every time:
/// 277 KB of JSON (Tyler's, 28 Sep), four decodes a second, with the daemon publishing about once every seven seconds.
/// The daemon publishes by renaming a new file over the old one (`publishSessionsFile`), so every publish is a new
/// inode and a stamp that matches the last one is the file already decoded.
public struct ConchFileStamp: Equatable, Sendable {
    let device: Int64
    let inode: UInt64
    let size: Int64
    let seconds: Int
    let nanoseconds: Int

    /// Nil when nothing readable is there: no file, or not a regular one.
    public init?(path: String) {
        var info = stat()
        guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { return nil }
        device = Int64(info.st_dev)
        inode = UInt64(info.st_ino)
        size = Int64(info.st_size)
        seconds = info.st_mtimespec.tv_sec
        nanoseconds = info.st_mtimespec.tv_nsec
    }
}

/// A file read and turned into a value only when its stamp moved (`ConchFileStamp`); otherwise the value it made last
/// time. A read that made nothing (unreadable, half-written, a version this build refuses) is not remembered, so the
/// next poll tries again.
public struct ConchStampedRead<Value> {
    private var stamp: ConchFileStamp?
    private var value: Value?
    /// How many times it actually read the file, for the poll's tests and measurements.
    public private(set) var reads = 0
    /// Whether the last `value(at:read:)` answered with a value it read just then, rather than the one it read before.
    ///
    /// The value read before is one its reader has already taken in, so everything worked out from it alone is already
    /// worked out. The Mac's poll took the same snapshot in again four times a second: the deep comparison of every row
    /// and conversation that keeps an unchanged state from republishing, the outbox against every conversation, and the
    /// rest (`StateStore.revisit`).
    public private(set) var fresh = false

    public init() {}

    public mutating func value(at path: String, read: () -> Value?) -> Value? {
        let now = ConchFileStamp(path: path)
        // Only a value is remembered: a read that made nothing is tried again however the stamp stands.
        if let now, now == stamp, let value {
            fresh = false
            return value
        }
        reads += 1
        // The stamp taken BEFORE the read: a rewrite between the two is a newer stamp next time, read again, never a
        // newer file hidden behind an older stamp.
        stamp = now
        value = read()
        fresh = value != nil
        return value
    }
}

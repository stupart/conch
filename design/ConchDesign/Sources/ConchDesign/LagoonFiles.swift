import Foundation

/// What a `conch-lagoon://` request may read, decided before a byte is read (spec §3). The app's `WKURLSchemeHandler`
/// (mac-app/conch-mac/LagoonWeb.swift) asks these and does only the reading.
///
/// Two kinds of file, one rule: a request names a folder it may not leave. The bundle's files come from the app's own
/// `Resources/Lagoon`; a deliverable's from the folder its file is in, and only while the session still holds that review
/// in the current snapshot (the app looks that up; this says what to do with what it found). Nothing escapes its folder:
/// not by `..`, not by an encoded `/` or `..`, not by a symlink that points out.
public enum LagoonFiles {
    /// What a request asks for, read off its URL and nothing else.
    public enum Route: Equatable, Sendable {
        /// A file of the page, by its path inside the bundle (decoded, one component each).
        case bundle([String])
        /// A deliverable: `review/<session>/<review>/<rest…>`. An empty `rest` is the review itself, which redirects to
        /// its file's name (`Review.resolve`).
        case review(sessionId: String, reviewId: String, rest: [String])
        case refused(String)
    }

    /// The route for a request URL. Only `conch-lagoon://lagoon/…`; each path component is percent-decoded once, and any
    /// that decodes to nothing, `.`, `..`, or to something holding `/`, `\` or a NUL refuses the whole request, so no
    /// spelling of a parent folder survives to be joined onto a path. (WebKit already folds a literal `../` out of an
    /// address before it asks; `%2F..%2F` it hands over as it is.)
    public static func route(_ url: URL) -> Route {
        guard url.scheme?.lowercased() == Lagoon.scheme, url.host?.lowercased() == Lagoon.host else {
            return .refused("not a lagoon address")
        }
        // The path as it was written, still encoded: `url.path` would decode `%2F` into a separator first.
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        var encoded = raw.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if encoded.first == "" { encoded.removeFirst() }
        if encoded.isEmpty || encoded == [""] { return .bundle(["index.html"]) }
        var parts: [String] = []
        for piece in encoded {
            guard let part = piece.removingPercentEncoding else { return .refused("a path that doesn't decode") }
            parts.append(part)
        }
        // A review's session and id are names to look up in the state, never paths: any characters, so long as there are some.
        let isReview = parts.first == "review"
        let path = isReview ? Array(parts.dropFirst(3)) : parts
        guard path.allSatisfy(isPlainComponent) else { return .refused("a path that leaves its folder") }
        guard isReview else { return .bundle(parts) }
        guard parts.count >= 3, !parts[1].isEmpty, !parts[2].isEmpty else { return .refused("a review needs its session and its id") }
        return .review(sessionId: parts[1], reviewId: parts[2], rest: path)
    }

    /// One folder's or file's name: not empty, not `.` or `..`, and holding no separator or NUL.
    static func isPlainComponent(_ part: String) -> Bool {
        part != "" && part != "." && part != ".." && !part.contains("/") && !part.contains("\\") && !part.contains("\u{0}")
    }

    /// The file `components` names inside `root`, or nil: not there, not a plain file, or (once every symlink on the way is
    /// followed) not inside `root` any more.
    public static func file(in root: URL, _ components: [String]) -> URL? {
        guard !components.isEmpty, components.allSatisfy(isPlainComponent) else { return nil }
        let base = root.standardizedFileURL.resolvingSymlinksInPath()
        var candidate = base
        for component in components { candidate.appendPathComponent(component, isDirectory: false) }
        let real = candidate.resolvingSymlinksInPath().standardizedFileURL
        guard contains(base, real) else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: real.path, isDirectory: &isDirectory), !isDirectory.boolValue else { return nil }
        return real
    }

    /// `folder` itself or anything below it, compared component by component (so `/a/bc` is not inside `/a/b`).
    public static func contains(_ folder: URL, _ url: URL) -> Bool {
        let outer = folder.standardizedFileURL.pathComponents
        let inner = url.standardizedFileURL.pathComponents
        return inner.count >= outer.count && Array(inner.prefix(outer.count)) == outer
    }

    // MARK: Deliverables

    public enum Review: Equatable, Sendable {
        /// `…/review/<s>/<r>` with nothing after it: go to `…/review/<s>/<r>/<name>`, so a page's relative links resolve
        /// beside it, as they do over the bridge.
        case redirect(String)
        case file(URL)
        case refused(String)
    }

    /// The link a request may serve, looked up in the CURRENT state at the moment of the request: the session must be a row
    /// in it, holding a review under that key (`LagoonSnapshot.reviewKey`), with a link that isn't a web link. A review the
    /// session has since dropped, a session that has gone, or a key from an older snapshot is nothing, so the page can't
    /// keep reading a file conch no longer offers.
    public static func heldLink(sessionId: String, reviewId: String, in source: LagoonSnapshot.Source) -> (link: String, cwd: String?)? {
        guard let row = source.rows.first(where: { $0.id == sessionId }) else { return nil }
        for (index, review) in row.reviews.enumerated()
        where LagoonSnapshot.reviewKey(id: review.id, artifact: review.artifact, index: index) == reviewId {
            guard let link = review.link?.trimmingCharacters(in: .whitespacesAndNewlines), !link.isEmpty,
                  !LagoonSnapshot.isWebLink(link) else { return nil }
            return (link, row.cwd)
        }
        return nil
    }

    /// What `…/review/<s>/<r>/<rest…>` serves, given the file the review's link resolves to (`LinkTarget.url(for:cwd:)`
    /// in the app). A web link isn't served here: the snapshot hands those to the page as they are. A folder deliverable
    /// serves the folder, starting at its `index.html`.
    public static func review(target: URL, rest: [String]) -> Review {
        guard target.isFileURL else { return .refused("a web link isn't served here") }
        let target = target.standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.path, isDirectory: &isDirectory) else { return .refused("not there") }
        let folder = isDirectory.boolValue ? target : target.deletingLastPathComponent()
        if rest.isEmpty {
            return .redirect(isDirectory.boolValue ? "index.html" : target.lastPathComponent)
        }
        guard let file = file(in: folder, rest) else { return .refused("not in the deliverable's folder") }
        return .file(file)
    }

    /// The bare review's address, made into its file's (`…/review/<s>/<r>/<name>`), encoded the way `reviewURL` encodes.
    public static func redirectURL(sessionId: String, reviewId: String, to name: String) -> String {
        Lagoon.reviewURL(sessionId: sessionId, reviewKey: reviewId) + "/" + Lagoon.encodeComponent(name)
    }

    // MARK: Byte ranges

    /// The part of a file a `Range` header asks for (RFC 9110 §14), because WebKit won't play a video without ranges.
    public enum ByteRange: Equatable, Sendable {
        /// No range, or one this doesn't take (several at once, another unit, or malformed): the whole file, 200.
        case whole
        /// 206, `Content-Range: bytes <lower>-<upper>/<length>`.
        case part(ClosedRange<Int>)
        /// 416, `Content-Range: bytes */<length>`.
        case unsatisfiable
    }

    public static func byteRange(_ header: String?, length: Int) -> ByteRange {
        guard let header = header?.trimmingCharacters(in: .whitespaces), !header.isEmpty else { return .whole }
        let lowered = header.lowercased()
        guard lowered.hasPrefix("bytes=") else { return .whole }
        let spec = lowered.dropFirst("bytes=".count).trimmingCharacters(in: .whitespaces)
        guard !spec.contains(","), let dash = spec.firstIndex(of: "-") else { return .whole }
        let first = spec[..<dash].trimmingCharacters(in: .whitespaces)
        let last = spec[spec.index(after: dash)...].trimmingCharacters(in: .whitespaces)
        let digits = CharacterSet(charactersIn: "0123456789")
        func number(_ text: String) -> Int? {
            guard !text.isEmpty, text.unicodeScalars.allSatisfy(digits.contains) else { return nil }
            return Int(text) ?? Int.max
        }
        switch (number(first), number(last)) {
        case let (start?, nil) where last.isEmpty:
            return start < length ? .part(start...(length - 1)) : .unsatisfiable
        case let (start?, end?):
            guard start <= end else { return .whole }
            return start < length ? .part(start...min(end, length - 1)) : .unsatisfiable
        case let (nil, suffix?) where first.isEmpty:
            guard suffix > 0, length > 0 else { return .unsatisfiable }
            return .part(max(0, length - suffix)...(length - 1))
        default:
            return .whole
        }
    }
}

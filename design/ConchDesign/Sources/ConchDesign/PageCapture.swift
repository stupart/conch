import CoreGraphics
import Foundation

/// `conch_capture`'s decisions, pure: when a page has settled enough to capture, where to scroll its target, which part
/// of the view to capture, where the target is in the picture, whether the page is a sign-in screen, and whether a folder
/// the daemon names is conch's own. The daemon's half is src/page-capture.ts; the Mac app's web view, which asks these
/// questions as it draws, is PageCapturer.swift there.
///
/// Tyler (2026-10-02, item 2): an agent showing one section of a live page drove Chrome to it, waited on lazy images,
/// scrolled again after the layout shifted, screenshotted, and guessed the box by eye. Each rule here is one of those
/// steps, written down once so it is the same every time.
public enum PageCapture {
    // MARK: Settling

    /// One look at the page while it settles, taken a frame apart.
    public struct Sample: Equatable, Sendable {
        /// `document.readyState`.
        public var readyState: String
        /// `document.fonts.status == "loaded"`: a web font still on its way swaps in and moves every line.
        public var fontsLoaded: Bool
        /// Images in or near the view (or anywhere, for a full page) not yet `complete`.
        public var pendingImages: Int
        /// The target's client rect, in CSS pixels from the view's top left; nil without a target, or before it is found.
        public var target: CGRect?
        /// The document's height: a page still growing is still being built.
        public var scrollHeight: CGFloat
        /// Seconds since this wait began.
        public var elapsed: TimeInterval

        public init(readyState: String, fontsLoaded: Bool, pendingImages: Int, target: CGRect?, scrollHeight: CGFloat, elapsed: TimeInterval) {
            self.readyState = readyState
            self.fontsLoaded = fontsLoaded
            self.pendingImages = pendingImages
            self.target = target
            self.scrollHeight = scrollHeight
            self.elapsed = elapsed
        }
    }

    public struct SettleRules: Equatable, Sendable {
        /// Looks in a row with nothing moved: four frames, long enough to see a layout shift that comes a frame late.
        public var stableSamples: Int
        /// How far, in CSS pixels, a box may move and still count as still (subpixel layout jitters).
        public var tolerance: CGFloat
        /// And this long since anything moved: a page's script often moves things again a moment after an image lands
        /// (a carousel measuring itself, a banner put in once the hero has loaded), and four frames is only 70 ms.
        public var quiet: TimeInterval
        /// How long images are waited for. A lazy image whose server never answers mustn't hold the capture hostage.
        public var imageWait: TimeInterval
        /// The whole wait, past which the page is captured as it is, and the capture says so.
        public var cap: TimeInterval

        public init(stableSamples: Int = 4, tolerance: CGFloat = 0.5, quiet: TimeInterval = 0.3, imageWait: TimeInterval = 6, cap: TimeInterval = 10) {
            self.stableSamples = stableSamples
            self.tolerance = tolerance
            self.quiet = quiet
            self.imageWait = imageWait
            self.cap = cap
        }
    }

    public enum Verdict: Equatable, Sendable {
        case wait
        case settled
        /// The cap ran out first, and why: what was still moving.
        case gaveUp(String)
    }

    /// The wait after a load or a scroll: settled once the page has loaded and its fonts, the images near the target
    /// have (or `imageWait` has passed), and neither the target's box nor the document's height has moved for
    /// `stableSamples` looks in a row and `quiet` seconds. Past `cap` it gives up, saying what was still moving.
    public struct Settle: Sendable {
        public let rules: SettleRules
        private var last: Sample?
        private var unchanged = 0
        /// When the last move was seen, in the samples' own seconds.
        private var movedAt: TimeInterval = 0

        public init(rules: SettleRules = SettleRules()) {
            self.rules = rules
        }

        public mutating func observe(_ sample: Sample) -> Verdict {
            let still = last.map { Self.same($0, sample, within: rules.tolerance) } ?? false
            unchanged = still ? unchanged + 1 : 0
            if !still { movedAt = sample.elapsed }
            last = sample
            let loaded = sample.readyState == "complete" && sample.fontsLoaded
            let images = sample.pendingImages == 0 || sample.elapsed >= rules.imageWait
            let stable = unchanged + 1 >= rules.stableSamples && sample.elapsed - movedAt >= rules.quiet
            if loaded && images && stable { return .settled }
            guard sample.elapsed >= rules.cap else { return .wait }
            if !loaded { return .gaveUp("the page was still loading") }
            if !images { return .gaveUp(sample.pendingImages == 1 ? "an image was still loading" : "\(sample.pendingImages) images were still loading") }
            return .gaveUp("the layout was still moving")
        }

        static func same(_ a: Sample, _ b: Sample, within tolerance: CGFloat) -> Bool {
            guard abs(a.scrollHeight - b.scrollHeight) <= tolerance else { return false }
            switch (a.target, b.target) {
            case (nil, nil): return true
            case let (x?, y?):
                return abs(x.minX - y.minX) <= tolerance && abs(x.minY - y.minY) <= tolerance
                    && abs(x.width - y.width) <= tolerance && abs(x.height - y.height) <= tolerance
            default: return false
            }
        }
    }

    // MARK: Placing the target

    /// The margin round a target in its capture, in CSS pixels: enough to see what it sits in, not so much it is lost.
    public static let padding: CGFloat = 24

    /// Where a target is scrolled to: the middle of the view when it fits there with its margin, else its top at the top.
    public enum Alignment: String, Sendable {
        case center
        case start
    }

    public static func alignment(target: CGSize, viewport: CGSize, padding: CGFloat = padding) -> Alignment {
        target.height + 2 * padding <= viewport.height ? .center : .start
    }

    /// Whether the target sits where it was scrolled to, near enough: in view across, and, when it fits, wholly in view
    /// within a quarter of the view from the middle; when it doesn't, its top within a quarter of the view from the top.
    /// A layout that shifted after the scroll (an image above it loading in) moves it off, and it is scrolled again.
    public static func isPlaced(_ target: CGRect, viewport: CGSize, padding: CGFloat = padding) -> Bool {
        let slack = viewport.height / 4
        if target.width <= viewport.width, target.minX < -0.5 || target.maxX > viewport.width + 0.5 { return false }
        switch alignment(target: target.size, viewport: viewport, padding: padding) {
        case .center:
            return target.minY >= -0.5 && target.maxY <= viewport.height + 0.5 && abs(target.midY - viewport.height / 2) <= slack
        case .start:
            return target.minY >= -0.5 && target.minY <= padding + slack
        }
    }

    // MARK: The picture

    /// The part of the view captured, in CSS pixels from its top left, and whether the target ran past it.
    public struct Crop: Equatable, Sendable {
        public let rect: CGRect
        /// The target is larger than the view, or runs off it: only the part the view holds is in the picture.
        public let clipped: Bool

        public init(rect: CGRect, clipped: Bool) {
            self.rect = rect
            self.clipped = clipped
        }
    }

    /// The target with `padding` round it, kept inside the view and on whole CSS pixels; the whole view without a target.
    /// Nil when the target isn't in the view at all.
    public static func crop(target: CGRect?, viewport: CGSize, padding: CGFloat = padding) -> Crop? {
        let view = CGRect(origin: .zero, size: viewport)
        guard let target else { return Crop(rect: view, clipped: false) }
        let seen = target.intersection(view)
        guard !seen.isNull, seen.width >= 1, seen.height >= 1 else { return nil }
        let rect = target.insetBy(dx: -padding, dy: -padding).integral.intersection(view)
        let clipped = target.minX < -0.5 || target.minY < -0.5 || target.maxX > viewport.width + 0.5 || target.maxY > viewport.height + 0.5
        return Crop(rect: rect, clipped: clipped)
    }

    /// The target's box in the picture, in its pixels: where it is in the crop, times the pixels a CSS pixel was drawn
    /// with. Only the part inside the crop; nil when none is.
    public static func box(target: CGRect, crop: CGRect, scale: CGFloat) -> CGRect? {
        let inside = target.intersection(crop)
        guard !inside.isNull, inside.width > 0, inside.height > 0, scale > 0 else { return nil }
        let left = ((inside.minX - crop.minX) * scale).rounded()
        let top = ((inside.minY - crop.minY) * scale).rounded()
        let right = ((inside.maxX - crop.minX) * scale).rounded()
        let bottom = ((inside.maxY - crop.minY) * scale).rounded()
        guard right > left, bottom > top else { return nil }
        return CGRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// The most pixels one capture may hold: a full page at Retina is 2880 by 32000 pixels, 360 MB as it is drawn.
    public static let maxPixels: Double = 40_000_000

    /// The width, in points, to ask the snapshot for so the picture stays within `maxPixels`; nil when it already does.
    public static func snapshotWidth(for size: CGSize, scale: CGFloat, maxPixels: Double = maxPixels) -> CGFloat? {
        guard size.width > 0, size.height > 0, scale > 0 else { return nil }
        let pixels = Double(size.width * scale) * Double(size.height * scale)
        guard pixels > maxPixels else { return nil }
        return (size.width * CGFloat((maxPixels / pixels).squareRoot())).rounded(.down)
    }

    /// The tallest a full page is drawn, in CSS pixels. WebKit draws only what its view holds, so a full page is drawn by
    /// making the view as tall as the page, and a window much taller than this isn't one macOS draws reliably.
    public static let fullPageMax: CGFloat = 10_000

    /// How tall a full page is drawn: all of it, up to `fullPageMax`, and never less than the view.
    public static func fullPageHeight(scrollHeight: CGFloat, viewport: CGSize) -> CGFloat {
        min(max(scrollHeight.rounded(.up), viewport.height), fullPageMax)
    }

    // MARK: Sign-in screens

    /// What a page says about itself that tells a sign-in screen apart.
    public struct PageSignals: Equatable, Sendable {
        /// Where the page ended up, after every redirect.
        public var url: URL?
        public var title: String
        /// Visible password fields.
        public var passwordFields: Int
        /// A visible heading, button or label says sign in, log in, or continue with an identity provider.
        public var signInWords: Bool

        public init(url: URL?, title: String, passwordFields: Int, signInWords: Bool) {
            self.url = url
            self.title = title
            self.passwordFields = passwordFields
            self.signInWords = signInWords
        }
    }

    /// Identity providers' own sign-in hosts: a page that ended up on one was sent there to sign in.
    static let signInHosts: Set<String> = [
        "accounts.google.com", "login.microsoftonline.com", "login.live.com", "appleid.apple.com", "idmsa.apple.com",
        "id.atlassian.com", "signin.aws.amazon.com", "auth.openai.com", "login.salesforce.com", "account.box.com",
    ]
    /// Hosted sign-in services, by the end of their hosts: Auth0, Okta, OneLogin, Clerk's development instances, WorkOS.
    static let signInHostSuffixes = [".auth0.com", ".okta.com", ".oktapreview.com", ".onelogin.com", ".clerk.accounts.dev", ".authkit.app"]
    /// Hosts that are sign-in by their first label (`login.example.com`, `sso.…`, `auth.…`, Clerk's `clerk.…`).
    static let signInHostPrefixes = ["login.", "signin.", "sso.", "auth.", "clerk.", "identity."]
    /// Paths a site signs in at: GitHub's and Vercel's `/login`, Vercel's `/sso-api` (a protected preview deployment
    /// sends you there), Auth0's `/u/login`, Clerk's `/sign-in`, and the usual others. Not `/session`: an app's own
    /// `/sessions/…` is a page like any other.
    static let signInPath = try! NSRegularExpression(
        pattern: "^/(?:login|log-in|signin|sign-in|sign_in|sso|sso-api|saml|oauth2?|auth/login|auth/signin|u/login|users/sign_in|account/login|accounts/login)(?:/|$)",
        options: [.caseInsensitive]
    )
    static let signInTitle = try! NSRegularExpression(
        pattern: "^(?:sign in|sign-in|signin|log in|log-in|login)\\b|\\b(?:sign in|log in) to\\b|[|·–—-]\\s*(?:sign in|log in|login)\\s*$",
        options: [.caseInsensitive]
    )

    /// Whether the page is a sign-in screen rather than the page asked for: it ended up at an identity provider or at a
    /// sign-in path, or it shows a password field or sign-in words under a title that says sign in, or a password field
    /// beside words that say so. A password field alone isn't one (a settings page changes a password), sign-in words
    /// alone aren't (every site's header has a Log in button), and a title alone isn't (a docs page about logging in).
    public static func loginWall(_ page: PageSignals) -> Bool {
        if let url = page.url, url.scheme == "http" || url.scheme == "https", let host = url.host?.lowercased() {
            if signInHosts.contains(host) || signInHostSuffixes.contains(where: host.hasSuffix) || signInHostPrefixes.contains(where: host.hasPrefix) {
                return true
            }
            let path = url.path.isEmpty ? "/" : url.path
            if signInPath.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil { return true }
        }
        let title = page.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let titled = signInTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
        return titled ? page.passwordFields > 0 || page.signInWords : page.passwordFields > 0 && page.signInWords
    }

    // MARK: Where it is written

    /// conch's capture folder under a home folder (src/capture-folder.ts `CAPTURE_FOLDER_PARTS`).
    public static let folderParts = ["Library", "Application Support", "conch", "captures"]

    /// The folder the daemon named, when it is conch's capture folder under `home`, by real path; nil for anything else,
    /// which is never written to.
    public static func folder(_ named: String, home: String) -> String? {
        func real(_ path: String) -> String { URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path }
        let expected = folderParts.reduce(home) { ($0 as NSString).appendingPathComponent($1) }
        let folder = real(named)
        return folder == real(expected) ? folder : nil
    }

    /// The file a request's capture is written to: `<id>.png`, or `<id>-seen.png` for a picture of what was seen instead.
    /// Nil for an id that isn't the daemon's shape (letters, digits and dashes), which names no file.
    public static func fileName(request: String, seen: Bool = false) -> String? {
        guard !request.isEmpty, request.count <= 64,
              request.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-").contains($0) })
        else { return nil }
        return seen ? "\(request)-seen.png" : "\(request).png"
    }
}

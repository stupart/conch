import ConchDesign
import SwiftUI
import UIKit
import WebKit

// Agent ink on the phone: the marks an agent published with a review (`scene.marks`, `features.deliverables` 3), drawn over
// what the review sheet shows, as the Mac draws them (#412) and from the same pure pieces: `AgentInk` places a mark, and
// `CanvasInk` builds its path, its spine and where its label goes. Tyler: "transparent canvas that both the ai and the user
// can write to over top of what they're looking at". Where each mark goes depends on its frame:
//
// - `{image}`: on the image while the sheet shows it, which is when the review's own link is that image.
// - `{selector}` and `{quote}`: found in the sheet's page (a local page, a dev server's, a web page) by the one read-only
//   script both apps run (`AgentInk.finder`), in conch's own content world, the strings passed as arguments.
// - `{canvas}`: on a display of the Mac's; a phone has none of those, so these are left out.
//
// Nothing is drawn at a guessed position: a mark that can't be placed is left out.

/// Which surface a mark belongs to. Foundation only, so the bun test runs it under `swift`.
enum InkSurface {
    /// The same file, however the two paths are spelled.
    static func sameFile(_ a: String, _ b: String) -> Bool {
        URL(fileURLWithPath: a).standardizedFileURL.path == URL(fileURLWithPath: b).standardizedFileURL.path
    }

    /// Whether the page on screen is still the review's own: its address but for the fragment, not one browsed to since.
    static func isReviewPage(_ url: URL?, entry: URL) -> Bool {
        func key(_ url: URL) -> String { String(url.absoluteString.split(separator: "#", maxSplits: 1).first ?? "") }
        guard let url else { return false }
        return key(url) == key(entry)
    }
}

/// An agent's marks drawn in the agent's violet over a view, each in that view's own 0-1 space: a new mark draws on as a
/// pen would, 60 ms after the one before, and its label pops as the mark is four fifths drawn; Reduce Motion fades them in.
/// It never takes a touch: whatever is under it keeps scrolling and zooming.
final class AgentInkView: UIView {
    /// Whose marks: its name leads every label ("Claude · …").
    var agentName = "Claude"
    private(set) var marks: [CanvasMark] = []
    private var ink = CALayer()
    private var labels: [UIView] = []
    /// Ids drawn on already: moved or shown again, a mark doesn't draw on twice.
    private var drawnBefore: Set<CanvasMark.ID> = []
    private var laidOut: CGSize = .zero

    static let drawOnTime: CFTimeInterval = 0.4
    static let widest: CGFloat = 240
    static let gap: CGFloat = 6
    static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        layer.addSublayer(ink)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        // A new size is a new place for every mark: drawn again where they now are, without drawing on.
        if bounds.size != laidOut { build(animating: false) }
    }

    func show(_ marks: [CanvasMark]) {
        guard marks != self.marks else { return }
        self.marks = marks
        build(animating: true)
    }

    /// Out of sight while what it is on moves, and back once it is still (120 ms).
    func hide(_ hidden: Bool) {
        guard (alpha == 0) != hidden else { return }
        UIView.animate(withDuration: 0.12) { self.alpha = hidden ? 0 : 1 }
    }

    private func build(animating: Bool) {
        laidOut = bounds.size
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        ink.removeFromSuperlayer()
        labels.forEach { $0.removeFromSuperview() }
        labels = []
        ink = CALayer()
        ink.frame = bounds
        layer.addSublayer(ink)
        guard bounds.width > 0, bounds.height > 0 else { return CATransaction.commit() }
        var order = 0
        for mark in marks {
            let fresh = animating && !drawnBefore.contains(mark.id)
            drawnBefore.insert(mark.id)
            let delay = fresh ? Double(order) * 0.06 : 0
            if fresh { order += 1 }
            if mark.kind == .note {
                let badge = Self.badge(for: mark, in: bounds.size)
                ink.addSublayer(badge)
                if fresh { Self.pop(badge, from: 0.5, after: delay) }
                if let bubble = bubble(for: mark, beside: badge.position) {
                    addSubview(bubble)
                    labels.append(bubble)
                    if fresh { Self.pop(bubble.layer, from: 1, after: delay) }
                }
                continue
            }
            let drawn = Self.layer(for: mark, in: bounds.size)
            ink.addSublayer(drawn)
            if fresh { drawOn(drawn, mark, after: delay) }
            if let bubble = bubble(for: mark, beside: nil) {
                addSubview(bubble)
                labels.append(bubble)
                if fresh { Self.pop(bubble.layer, from: 0.85, after: delay + (Self.reduceMotion ? 0 : Self.drawOnTime * 0.8)) }
            }
        }
        CATransaction.commit()
    }

    /// A finished mark: its ink, and a box's wash under it (`CanvasInk.shape`).
    static func layer(for mark: CanvasMark, in size: CGSize) -> CALayer {
        let shape = CanvasInk.shape(of: mark, in: size)
        let ink = CAShapeLayer()
        ink.frame = CGRect(origin: .zero, size: size)
        ink.path = shape.ink
        ink.fillColor = CanvasInk.fill(of: mark).cgColor
        ink.strokeColor = nil
        guard let wash = shape.wash else { return ink }
        let under = CAShapeLayer()
        under.frame = ink.frame
        under.path = wash
        under.fillColor = CanvasInk.colour(mark.author).cgColor.copy(alpha: CanvasInk.washOpacity)
        under.addSublayer(ink)
        return under
    }

    /// A pin's badge, ✦ for an agent's, its sharper corner on the spot it marks: where it grows from.
    static func badge(for mark: CanvasMark, in size: CGSize) -> CALayer {
        let side = CanvasInk.pinSide
        let spot = mark.points.first?.point(in: size) ?? .zero
        let shape = CAShapeLayer()
        var home = CGAffineTransform(translationX: -spot.x, y: -(spot.y - side))
        shape.path = CanvasInk.shape(of: mark, in: size).ink.copy(using: &home)
        shape.fillColor = CanvasInk.colour(mark.author).cgColor
        shape.shadowOpacity = 0.3
        shape.shadowRadius = 6
        shape.shadowOffset = CGSize(width: 0, height: 3)
        let star = CATextLayer()
        star.string = "✦"
        star.font = UIFont.systemFont(ofSize: 12, weight: .bold)
        star.fontSize = 12
        star.foregroundColor = UIColor.white.cgColor
        star.alignmentMode = .center
        star.frame = CGRect(x: 0, y: (side - 15) / 2, width: side, height: 15)
        star.contentsScale = UIScreen.main.scale
        let badge = CALayer()
        badge.bounds = CGRect(x: 0, y: 0, width: side, height: side)
        badge.anchorPoint = CGPoint(x: 0, y: 1)
        badge.position = spot
        badge.addSublayer(shape)
        badge.addSublayer(star)
        return badge
    }

    /// The agent's words: its name in its colour, then what it said, on the phone's thin material. Beside a pin's badge,
    /// on its left when the right is out of room; for any other mark at `CanvasInk.labelSpot`, kept inside the view.
    private func bubble(for mark: CanvasMark, beside pin: CGPoint?) -> UIView? {
        guard let words = mark.text, !words.isEmpty else { return nil }
        let text = NSMutableAttributedString(string: "\(agentName) · ", attributes: [
            .font: UIFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: UIColor(cgColor: CanvasInk.agent.cgColor),
        ])
        text.append(NSAttributedString(string: words, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: UIColor.label]))
        let label = UILabel()
        label.attributedText = text
        label.numberOfLines = 0
        let fits = label.sizeThatFits(CGSize(width: Self.widest - 20, height: .greatestFiniteMagnitude))
        let size = CGSize(width: ceil(fits.width) + 20, height: ceil(fits.height) + 14)
        let bubble = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
        bubble.layer.cornerRadius = 12
        bubble.layer.borderWidth = 0.5
        bubble.layer.borderColor = UIColor.black.withAlphaComponent(0.14).cgColor
        bubble.clipsToBounds = true
        label.frame = CGRect(x: 10, y: 7, width: ceil(fits.width), height: ceil(fits.height))
        bubble.contentView.addSubview(label)
        var origin: CGPoint
        if let pin {
            let side = CanvasInk.pinSide
            let leftward = pin.x + side + Self.gap + size.width > bounds.width - 8
            origin = CGPoint(x: leftward ? pin.x - Self.gap - size.width : pin.x + side + Self.gap, y: pin.y - side)
        } else {
            guard let spot = CanvasInk.labelSpot(of: mark, in: bounds.size) else { return nil }
            origin = spot
        }
        origin.x = min(max(origin.x, 8), max(8, bounds.width - size.width - 8))
        origin.y = min(max(origin.y, 8), max(8, bounds.height - size.height - 8))
        bubble.frame = CGRect(origin: origin, size: size)
        return bubble
    }

    /// Drawn on as a pen would: the ink revealed along its own line (`CanvasInk.spine`) by a mask whose stroke grows to
    /// its end, on panel-lab's curve. Reduce Motion: a fade.
    private func drawOn(_ layer: CALayer, _ mark: CanvasMark, after delay: CFTimeInterval) {
        let start = CACurrentMediaTime() + delay
        guard !Self.reduceMotion, let spine = CanvasInk.spine(of: mark, in: bounds.size) else {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.2
            fade.beginTime = start
            fade.fillMode = .backwards
            return layer.add(fade, forKey: "appear")
        }
        let reveal = CAShapeLayer()
        reveal.frame = layer.bounds
        reveal.path = spine.path
        reveal.lineWidth = spine.width
        reveal.lineCap = .round
        reveal.lineJoin = .round
        reveal.fillColor = nil
        reveal.strokeColor = UIColor.black.cgColor
        layer.mask = reveal
        let draw = CABasicAnimation(keyPath: "strokeEnd")
        draw.fromValue = 0
        draw.toValue = 1
        draw.duration = Self.drawOnTime
        draw.beginTime = start
        draw.fillMode = .backwards
        draw.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0.1, 0.2, 1)
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak layer] in layer?.mask = nil }
        reveal.add(draw, forKey: "draw")
        CATransaction.commit()
    }

    /// In on the pop spring, `delay` from now, growing from `scale`. Reduce Motion: a fade.
    private static func pop(_ layer: CALayer, from scale: CGFloat, after delay: CFTimeInterval) {
        let reduce = reduceMotion
        let start = CACurrentMediaTime() + delay
        let spring = ConchMotion.pop.resolved(reduceMotion: reduce)
        let grow = CASpringAnimation(perceptualDuration: spring.response, bounce: spring.bounce)
        grow.keyPath = "transform.scale"
        grow.fromValue = reduce ? 1 : scale
        grow.toValue = 1
        grow.duration = grow.settlingDuration
        grow.beginTime = start
        grow.fillMode = .backwards
        let appear = CABasicAnimation(keyPath: "opacity")
        appear.fromValue = 0
        appear.toValue = 1
        appear.duration = 0.18
        appear.beginTime = start
        appear.fillMode = .backwards
        layer.add(grow, forKey: "pop")
        layer.add(appear, forKey: "appear")
    }
}

/// A review's `{selector}` and `{quote}` marks, found in the page on screen and drawn over it. A page moves under its marks
/// (a scroll, a pinch, a rotation), and following it frame by frame would mean running script in the page every frame; so,
/// as on the Mac, it looks five times a second, hides the marks while the page moves, and brings them back where they are
/// once it is still. Only while the page is still the review's own.
@MainActor
final class PageInk {
    private weak var page: WKWebView?
    private let ink = AgentInkView()
    private let asked: [[String]]
    private let marks: [AgentMark]
    private let entry: URL
    private let key: String
    private var watching: Task<Void, Never>?
    private var seen: [CanvasMark]?
    private var drawn: [CanvasMark]?

    /// Nil when the review has no mark a page can place.
    init?(page: WKWebView, marks: [AgentMark], entry: URL, key: String, agent: String) {
        asked = marks.compactMap { mark in
            switch mark.frame {
            case let .selector(selector): [mark.id, "selector", selector]
            case let .quote(quote): [mark.id, "quote", quote]
            case .canvas, .image: nil
            }
        }
        guard !asked.isEmpty else { return nil }
        self.page = page
        self.marks = marks
        self.entry = entry
        self.key = key
        ink.agentName = agent
        ink.frame = page.bounds
        ink.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        page.addSubview(ink)
        watching = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self else { return }
                await self.look()
            }
        }
    }

    func stop() {
        watching?.cancel()
        ink.removeFromSuperview()
    }

    private func look() async {
        guard let page else { return stop() }
        let placed = await place(on: page)
        if placed != seen {
            // Moving: out of sight until it is still.
            seen = placed
            ink.hide(true)
            return
        }
        if placed != drawn {
            drawn = placed
            ink.show(placed)
        }
        ink.hide(false)
    }

    /// Every mark found in the page, in the web view's 0-1 space: `AgentInk.finder`'s client rects, through the page's
    /// viewport and the web view's insets into its points, then placed on (`AgentInk.mark(on:)`). A mark whose selector or
    /// quote isn't on the page, or whose middle is out of sight, is left out.
    private func place(on page: WKWebView) async -> [CanvasMark] {
        guard InkSurface.isReviewPage(page.url, entry: entry), !page.isLoading else { return [] }
        guard let answer = try? await page.callAsyncJavaScript(AgentInk.finder, arguments: ["marks": asked], in: nil, contentWorld: .defaultClient) as? [String: Any],
              let view = answer["viewport"] as? [String: Double], let found = answer["found"] as? [String: [Double]]
        else { return [] }
        let viewport = AgentInk.Viewport(left: view["left"] ?? 0, top: view["top"] ?? 0, scale: view["scale"] ?? 1, width: view["width"] ?? 0)
        let size = page.bounds.size
        let inset = page.scrollView.adjustedContentInset
        guard size.width > 0, size.height > 0 else { return [] }
        return marks.compactMap { mark in
            guard let xywh = found[mark.id], xywh.count == 4, let kind = AgentInk.Kind(rawValue: mark.kind.rawValue) else { return nil }
            let local = AgentInk.viewRect(
                client: CGRect(x: xywh[0], y: xywh[1], width: xywh[2], height: xywh[3]),
                viewport: viewport,
                viewWidth: size.width - inset.left - inset.right
            ).offsetBy(dx: inset.left, dy: inset.top)
            guard CGRect(origin: .zero, size: size).contains(CGPoint(x: local.midX, y: local.midY)) else { return nil }
            let unit = CGRect(x: local.minX / size.width, y: local.minY / size.height, width: local.width / size.width, height: local.height / size.height)
            return AgentInk.mark(id: "\(key)/\(mark.id)", kind: kind, label: mark.label, on: unit, size: size)
        }
    }
}

/// What the ink over a review's page or image needs from the sheet: the review's marks, its key (so its marks keep their
/// ids from one look to the next), and whose they are.
struct InkSpec {
    let marks: [AgentMark]
    let key: String
    let agent: String
}

/// The image, decoded off the main thread no larger than a zoomed phone draws it, with its marks over it.
struct MarkedImage: View {
    let url: URL
    let marks: [CanvasMark]
    let agent: String
    let onFailure: (String) -> Void
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                MarkedImageView(image: image, marks: marks, agent: agent)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: url) {
            let preview = await ImageDownsampler.filePreview(at: url, maxBytes: 64 * 1024 * 1024, maxPixelSize: 4096)
            if case let .image(decoded) = preview { image = UIImage(cgImage: decoded) } else { onFailure("iPhone couldn't read this image") }
        }
    }
}

/// A review's `{image}` marks on its own image, in the image's 0-1 space; each mark only with the geometry its kind takes.
func imageInk(_ marks: [AgentMark], link: String?, key: String) -> [CanvasMark] {
    guard let link else { return [] }
    let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
    return marks.compactMap { mark in
        guard case let .image(path) = mark.frame, InkSurface.sameFile(path, link), let kind = AgentInk.Kind(rawValue: mark.kind.rawValue) else { return nil }
        return AgentInk.mark(id: "\(key)/\(mark.id)", kind: kind, label: mark.label, at: mark.at, to: mark.to, rect: mark.rect, pts: mark.pts, in: whole)
    }
}

/// An image with an agent's marks on it, pinch to zoom as Quick Look does, the marks zooming with it and drawn again sharp
/// once the pinch ends.
struct MarkedImageView: UIViewRepresentable {
    let image: UIImage
    let marks: [CanvasMark]
    let agent: String

    func makeUIView(context: Context) -> MarkedImageScroller {
        let view = MarkedImageScroller(image: image)
        view.ink.agentName = agent
        view.ink.show(marks)
        return view
    }

    func updateUIView(_ view: MarkedImageScroller, context: Context) {
        view.ink.show(marks)
    }
}

final class MarkedImageScroller: UIScrollView, UIScrollViewDelegate {
    let ink = AgentInkView()
    private let content = UIView()
    private let picture: UIImageView

    init(image: UIImage) {
        picture = UIImageView(image: image)
        super.init(frame: .zero)
        picture.contentMode = .scaleAspectFit
        content.addSubview(picture)
        content.addSubview(ink)
        addSubview(content)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 6
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        backgroundColor = .clear
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard zoomScale == 1, let size = picture.image?.size, size.width > 0, size.height > 0 else { return }
        content.frame = bounds
        contentSize = bounds.size
        picture.frame = content.bounds
        // The ink over the image itself, where aspect-fit put it.
        let scale = min(bounds.width / size.width, bounds.height / size.height)
        let fitted = CGSize(width: size.width * scale, height: size.height * scale)
        ink.frame = CGRect(x: (bounds.width - fitted.width) / 2, y: (bounds.height - fitted.height) / 2, width: fitted.width, height: fitted.height)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        // Paths drawn at the zoom they are seen at, not stretched.
        let sharp = scale * (window?.screen.scale ?? UIScreen.main.scale)
        func sharpen(_ layer: CALayer) {
            layer.contentsScale = sharp
            layer.sublayers?.forEach(sharpen)
        }
        sharpen(ink.layer)
    }
}

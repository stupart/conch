import SwiftUI
import XCTest
@testable import ConchDesign

final class ConchDesignTests: XCTestCase {
    func testTheLiveVoiceOutranksEverything() {
        XCTAssertEqual(VoiceState.resolve(live: "speaking", paused: true, readyCount: 2), .speaking)
        XCTAssertEqual(VoiceState.resolve(live: "listening", paused: false, readyCount: 1), .listening)
        XCTAssertEqual(VoiceState.resolve(live: "recording", paused: true, readyCount: 0), .listening)
    }

    func testReadyOutranksTheModeAndTheModeDecidesTheRest() {
        XCTAssertEqual(VoiceState.resolve(live: "paused", paused: true, readyCount: 1), .ready)
        XCTAssertEqual(VoiceState.resolve(live: "idle", paused: true, readyCount: 0), .quiet)
        XCTAssertEqual(VoiceState.resolve(live: "muted", paused: false, readyCount: 0), .quiet)
        XCTAssertEqual(VoiceState.resolve(live: "idle", paused: false, readyCount: 0), .talk)
        // Transcribing has shut the mic: not Listening.
        XCTAssertEqual(VoiceState.resolve(live: "transcribing", paused: false, readyCount: 0), .talk)
    }

    func testEveryTextLevelReadsAtFourPointFiveOnEveryGround() {
        for scheme in [ColorScheme.light, .dark] {
            for text in ConchColor.text {
                for ground in ConchColor.grounds {
                    let ratio = text.rgba(scheme).contrast(on: ground.rgba(scheme))
                    XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(text.name) on \(ground.name), \(scheme): \(ratio)")
                }
            }
            let onAccent = ConchColor.onAccent.rgba(scheme).contrast(on: ConchColor.accent.rgba(scheme))
            XCTAssertGreaterThanOrEqual(onAccent, 4.5, "onAccent on accent, \(scheme)")
        }
    }

    /// Ready used to be drawn as Talk's grey mic. It is the ready colour now, with a white checkmark.
    @MainActor
    func testTheReadyOrbIsTheReadyColourNotTalksGrey() throws {
        /// The orb's colour at (x, y) from its top left, over white, at 1x.
        func pixel(_ state: VoiceState, x: Int, y: Int) throws -> [Double] {
            let renderer = ImageRenderer(content: VoiceOrb(state: state, size: 36).environment(\.colorScheme, .light))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            var rgba: [UInt8] = [0, 0, 0, 0]
            rgba.withUnsafeMutableBytes { buffer in
                let context = CGContext(
                    data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )!
                context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
                context.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
                context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
            }
            return rgba.prefix(3).map { Double($0) / 255 }
        }
        // Inside the circle, clear of the glyph.
        let ready = try pixel(.ready, x: 4, y: 18)
        let green = ConchColor.ready.light
        XCTAssertEqual(ready[0], green.red, accuracy: 0.04)
        XCTAssertEqual(ready[1], green.green, accuracy: 0.04)
        XCTAssertEqual(ready[2], green.blue, accuracy: 0.04)
        // Talk keeps its quiet grey fill.
        let talk = try pixel(.talk, x: 4, y: 18)
        XCTAssertGreaterThan(talk[0], 0.85)
        // And the ready mark in the middle is white, not a grey mic.
        let check = try (8...28).flatMap { y in try (8...28).map { x in try pixel(.ready, x: x, y: y) } }
        XCTAssertTrue(check.contains { $0.allSatisfy { $0 > 0.95 } }, "no white checkmark in the ready orb")
    }

    /// The springs are the overlay lab's, in SwiftUI's own terms, so the apps move the way the lab felt.
    func testTheSpringsAreTheOverlayLabsAndStepLikeSwiftUI() {
        XCTAssertEqual(ConchMotion.dock, ConchSpring(bounce: 0.2, response: 0.45))
        XCTAssertEqual(ConchMotion.morph, ConchSpring(bounce: 0.12, response: 0.46))
        XCTAssertEqual(ConchMotion.pop, ConchSpring(bounce: 0.34, response: 0.36))
        XCTAssertEqual(ConchMotion.grow, ConchSpring(bounce: 0.12, response: 0.34))
        // panel-lab's stage swoop, for one deliverable in the panel giving way to the next.
        XCTAssertEqual(ConchMotion.swap, ConchSpring(bounce: 0.08, response: 0.52))
        // Stepped by hand, a spring follows the same curve SwiftUI animates.
        for (name, spring) in ConchMotion.springs {
            let swiftUI = Spring(duration: spring.response, bounce: spring.bounce)
            XCTAssertEqual(spring.stiffness, swiftUI.stiffness, accuracy: 0.01, name)
            XCTAssertEqual(spring.damping, swiftUI.damping, accuracy: 0.01, name)
        }
        // Reduce Motion keeps the timing and drops the overshoot.
        XCTAssertEqual(ConchMotion.dock.resolved(reduceMotion: true), ConchSpring(bounce: 0, response: 0.45))
        XCTAssertEqual(ConchMotion.dock.resolved(reduceMotion: false), ConchMotion.dock)
        // A 1000 pt/s flick carries about 500 pt.
        XCTAssertEqual(ConchMotion.projectedDistance(1000), 499, accuracy: 0.01)
    }

    /// The overlay's words read at 4.5:1 on its own wash, in light and in dark.
    func testTheOverlaysWordsReadOnItsWash() {
        for scheme in [ColorScheme.light, .dark] {
            for text in [ConchColor.overlayText, ConchColor.overlayTextSecondary] {
                let ratio = text.rgba(scheme).contrast(on: ConchColor.fog.rgba(scheme))
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(text.name) on the wash, \(scheme): \(ratio)")
            }
        }
    }

    func testHairlinesStayAtTenPercentOrLess() {
        for line in [ConchColor.hairline, ConchColor.hairlineStrong] {
            XCTAssertLessThanOrEqual(line.light.alpha, 0.1)
            XCTAssertLessThanOrEqual(line.dark.alpha, 0.1)
        }
    }

    /// The Ready pill brings the scene to you: the deliverable, else conch's window if open, else the terminal, else conch.
    func testTheReadyPillsSceneIsTheLinkThenConchsWindowThenTheTerminal() {
        let page = URL(string: "https://example.com/pull/1")!
        let file = URL(fileURLWithPath: "/tmp/guide.md")
        let there: (String) -> Bool = { $0 == "/tmp/guide.md" }
        let gone: (String) -> Bool = { _ in false }
        // A web page, or a file that is there, whatever else is open.
        XCTAssertEqual(ReviewScene.choose(link: page, fileExists: gone, appWindowOpen: true, revealable: true), .open(page))
        XCTAssertEqual(ReviewScene.choose(link: file, fileExists: there, appWindowOpen: true, revealable: true), .open(file))
        // A file that has gone, or a link that is neither, is no scene of its own.
        XCTAssertEqual(ReviewScene.choose(link: file, fileExists: gone, appWindowOpen: false, revealable: true), .terminal)
        XCTAssertEqual(ReviewScene.choose(link: URL(string: "mailto:a@b.c"), fileExists: there, appWindowOpen: false, revealable: true), .terminal)
        // Then conch's window if it is open, then the terminal, then conch's window anyway.
        XCTAssertEqual(ReviewScene.choose(link: nil, fileExists: there, appWindowOpen: true, revealable: true), .app)
        XCTAssertEqual(ReviewScene.choose(link: nil, fileExists: there, appWindowOpen: false, revealable: true), .terminal)
        XCTAssertEqual(ReviewScene.choose(link: nil, fileExists: there, appWindowOpen: false, revealable: false), .app)
    }

    /// A review can ask for its scene (v1): auto is the order above, link the same said explicitly, conversation conch's
    /// window even with a link, terminal the terminal else conch's window.
    func testTheSceneAReviewAsksForDecidesWhatTheClickBringsForward() {
        let page = URL(string: "https://example.com/pull/1")!
        let there: (String) -> Bool = { _ in true }
        // auto, which is also no kind at all: today's order.
        XCTAssertEqual(ReviewScene.choose(kind: .auto, link: page, fileExists: there, appWindowOpen: true, revealable: true), .open(page))
        XCTAssertEqual(ReviewScene.choose(link: page, fileExists: there, appWindowOpen: true, revealable: true), .open(page))
        XCTAssertEqual(ReviewScene.choose(kind: .auto, link: nil, fileExists: there, appWindowOpen: false, revealable: true), .terminal)
        // link: the link; once its open has failed and there is no link left, the rest of the order.
        XCTAssertEqual(ReviewScene.choose(kind: .link, link: page, fileExists: there, appWindowOpen: true, revealable: true), .open(page))
        XCTAssertEqual(ReviewScene.choose(kind: .link, link: nil, fileExists: there, appWindowOpen: true, revealable: true), .app)
        XCTAssertEqual(ReviewScene.choose(kind: .link, link: nil, fileExists: there, appWindowOpen: false, revealable: true), .terminal)
        // conversation: conch's window even with a link, open or not.
        XCTAssertEqual(ReviewScene.choose(kind: .conversation, link: page, fileExists: there, appWindowOpen: false, revealable: true), .app)
        XCTAssertEqual(ReviewScene.choose(kind: .conversation, link: page, fileExists: there, appWindowOpen: true, revealable: true), .app)
        // terminal: the terminal even with a link and an open window; conch's window when it can't be revealed.
        XCTAssertEqual(ReviewScene.choose(kind: .terminal, link: page, fileExists: there, appWindowOpen: true, revealable: true), .terminal)
        XCTAssertEqual(ReviewScene.choose(kind: .terminal, link: page, fileExists: there, appWindowOpen: true, revealable: false), .app)
        // A kind this build doesn't know reads as auto.
        XCTAssertEqual(ReviewScene.Kind(rawValue: "conversation"), .conversation)
        XCTAssertEqual(ReviewScene.Kind(rawValue: "simulator") ?? .auto, .auto)
    }

    /// "Ready for you · 2 sessions": oldest filed first, ties in a fixed order, the unopened before the opened, round and round.
    func testEachClickShowsTheNextReadyReview() {
        let ready: [(key: String, at: Double)] = [("c@3", 3), ("b@1", 1), ("a@1", 1)]
        // Oldest first, a tie by version whatever order the rows came in, and round again.
        XCTAssertEqual(ReviewScene.next(after: nil, in: ready, opened: []), "a@1")
        XCTAssertEqual(ReviewScene.next(after: "a@1", in: ready, opened: []), "b@1")
        XCTAssertEqual(ReviewScene.next(after: "b@1", in: ready, opened: []), "c@3")
        XCTAssertEqual(ReviewScene.next(after: "c@3", in: ready, opened: []), "a@1")
        // The unopened first, wherever the last click was; once every one is opened, round them all again.
        XCTAssertEqual(ReviewScene.next(after: "a@1", in: ready, opened: ["a@1", "c@3"]), "b@1")
        XCTAssertEqual(ReviewScene.next(after: "c@3", in: ready, opened: ["a@1", "b@1"]), "c@3")
        XCTAssertEqual(ReviewScene.next(after: "c@3", in: ready, opened: ["a@1", "b@1", "c@3"]), "a@1")
        // A newer review from the same session is a new version, unopened; one no longer ready starts over; none, nothing.
        XCTAssertEqual(ReviewScene.next(after: "a@1", in: [("a@5", 5), ("b@1", 1)], opened: ["a@1", "b@1"]), "a@5")
        XCTAssertEqual(ReviewScene.next(after: "gone", in: ready, opened: []), "a@1")
        XCTAssertNil(ReviewScene.next(after: "a@1", in: [], opened: []))
    }

    /// Every deliverable a ready session holds is in the queue, not only its newest: the walk interleaves two sessions'
    /// by when each was filed, reaches an older one still unopened, and comes round.
    func testTheQueueWalksEveryHeldDeliverableAcrossSessions() {
        // Session a holds two, b one; b's was filed between a's.
        let held: [(key: String, at: Double)] = [("a#2", 30), ("a#1", 10), ("b#1", 20)]
        XCTAssertEqual(ReviewScene.next(after: nil, in: held, opened: []), "a#1")
        XCTAssertEqual(ReviewScene.next(after: "a#1", in: held, opened: ["a#1"]), "b#1")
        XCTAssertEqual(ReviewScene.next(after: "b#1", in: held, opened: ["a#1", "b#1"]), "a#2")
        // a's older one, opened on another device, is passed over for the one nobody has seen.
        XCTAssertEqual(ReviewScene.next(after: nil, in: held, opened: ["a#1", "b#1"]), "a#2")
        // All seen: round them all again, oldest first.
        XCTAssertEqual(ReviewScene.next(after: "a#2", in: held, opened: ["a#1", "b#1", "a#2"]), "a#1")
    }

    /// 09-21, "BOTH": a deliverable conch can draw is shown by conch itself; an app window, the Simulator, a terminal, a
    /// design other than a Figma file, or an office document still comes forward in its own app. The panel's rule, kept as
    /// the window's deliverable pane's once the panel went (2026-11-11).
    func testAPanelPickShowsAPageDocumentPictureOrLiveUrlInThePanel() {
        let gone: (String) -> Bool = { _ in false }
        let live = URL(string: "http://localhost:3111/invite")!
        let page = URL(fileURLWithPath: "/tmp/site/index.html")
        func shows(_ deliverable: String?, _ link: URL?, kind: ReviewScene.Kind = .auto, fileExists: (String) -> Bool = { _ in true }) -> Bool {
            ReviewScene.panelShowsContent(kind: kind, deliverable: deliverable, link: link, fileExists: fileExists)
        }
        for kind in ["page", "markdown", "text", "image", "pdf", "video", "audio", "url"] {
            XCTAssertTrue(shows(kind, page), kind)
            XCTAssertTrue(shows(kind, live), kind)
        }
        // By the kind it was filed as, whatever the link looks like; and a kind this build has never heard of is not.
        for kind in ["app", "simulator", "terminal", "design", "document", "other", "slides"] {
            XCTAssertFalse(shows(kind, live), kind)
            XCTAssertFalse(shows(kind, page), kind)
        }
        // Only where the pill's scene would open the link: none, a file gone, or a scene asked for by name is as before.
        XCTAssertFalse(shows("page", nil))
        XCTAssertFalse(shows("page", page, fileExists: gone))
        XCTAssertFalse(shows("url", URL(string: "mailto:a@b.c")))
        XCTAssertFalse(shows("url", live, kind: .terminal))
        XCTAssertFalse(shows("url", live, kind: .conversation))
        XCTAssertTrue(shows("url", live, kind: .link))
        // Filed without a kind, by a daemon older than kinds: the link says, as src/deliverables.ts reads it.
        XCTAssertTrue(shows(nil, live))
        // A Figma file, filed as a design or with no kind: drawn here, as Figma's embed (2026-11-11, Tyler: "Make figma
        // show in the deliverables area instead of automatically sending me to figma"). Figma's other pages aren't.
        XCTAssertTrue(shows(nil, URL(string: "https://www.figma.com/design/abc/Icons")))
        XCTAssertTrue(shows(nil, URL(string: "https://figma.com/file/abc")))
        XCTAssertTrue(shows("design", URL(string: "https://www.figma.com/design/abc/Icons")))
        XCTAssertFalse(shows(nil, URL(string: "https://www.figma.com/pricing")))
        XCTAssertFalse(shows("design", URL(string: "https://www.figma.com/design/abc/Icons"), kind: .terminal))
        XCTAssertTrue(shows(nil, URL(fileURLWithPath: "/tmp/hero-390.PNG")))
        XCTAssertTrue(shows(nil, URL(fileURLWithPath: "/tmp/notes.md")))
        XCTAssertFalse(shows(nil, URL(fileURLWithPath: "/tmp/brief.docx")))
        XCTAssertFalse(shows(nil, URL(fileURLWithPath: "/tmp/build.zip")))
    }
}

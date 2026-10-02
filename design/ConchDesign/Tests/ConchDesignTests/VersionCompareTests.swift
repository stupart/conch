import XCTest
@testable import ConchDesign

/// Comparing two versions of one artifact (feedback 2026-10-03: an agent hand-stitched a before/after composite with PIL,
/// because nothing in conch could put two versions side by side). The rules, without a window.
final class VersionCompareTests: XCTestCase {
    // Newest first, as `DeliverableGroup.versions` holds them.
    private let versions = ["v4", "v3", "v2", "v1"]

    // MARK: - Which two

    func testItOpensOnTheNewestAndTheVersionBeforeIt() {
        XCTAssertEqual(VersionCompare.defaultPair(in: versions), VersionPair(before: "v3", after: "v4"))
        // One no longer held is no pick: the newest again.
        XCTAssertEqual(VersionCompare.defaultPair(in: versions, from: "gone"), VersionPair(before: "v3", after: "v4"))
    }

    func testAnOlderVersionOnScreenIsComparedWithTheOneBeforeIt() {
        XCTAssertEqual(VersionCompare.defaultPair(in: versions, from: "v2"), VersionPair(before: "v1", after: "v2"))
        // The oldest has nothing before it: compared with the one after, and still the before.
        XCTAssertEqual(VersionCompare.defaultPair(in: versions, from: "v1"), VersionPair(before: "v1", after: "v2"))
    }

    func testOneVersionHasNothingToCompare() {
        XCTAssertNil(VersionCompare.defaultPair(in: ["v1"]))
        XCTAssertNil(VersionCompare.defaultPair(in: []))
        XCTAssertFalse(VersionCompare.canCompare(["v1"]))
        XCTAssertFalse(VersionCompare.canCompare(["v1", "v1"]))
        XCTAssertTrue(VersionCompare.canCompare(["v2", "v1"]))
    }

    func testAPickedPairPutsTheOlderOnTheLeftWhicheverWasPickedFirst() {
        XCTAssertEqual(VersionCompare.pair("v4", "v1", in: versions), VersionPair(before: "v1", after: "v4"))
        XCTAssertEqual(VersionCompare.pair("v1", "v4", in: versions), VersionPair(before: "v1", after: "v4"))
        XCTAssertNil(VersionCompare.pair("v2", "v2", in: versions), "a version against itself is no comparison")
        XCTAssertNil(VersionCompare.pair("v2", "elsewhere", in: versions))
    }

    /// A version taken off, or dropped past the daemon's cap, ends the comparison rather than leaving half of one.
    func testAComparisonEndsWhenEitherVersionIsGone() {
        let pair = VersionPair(before: "v1", after: "v3")
        XCTAssertEqual(VersionCompare.resolve(pair, in: versions), pair)
        XCTAssertNil(VersionCompare.resolve(pair, in: ["v4", "v3", "v2"]))
        XCTAssertNil(VersionCompare.resolve(nil, in: versions))
        // Stored the wrong way round, it is put right.
        XCTAssertEqual(VersionCompare.resolve(VersionPair(before: "v3", after: "v1"), in: versions), pair)
    }

    func testTheMenuOffersTheDefaultPartnerFirstThenTheRestNewestFirst() {
        XCTAssertEqual(VersionCompare.partners(of: "v4", in: versions), ["v3", "v2", "v1"])
        XCTAssertEqual(VersionCompare.partners(of: "v2", in: versions), ["v1", "v4", "v3"])
        XCTAssertEqual(VersionCompare.partners(of: "v1", in: versions), ["v2", "v4", "v3"])
        XCTAssertEqual(VersionCompare.partners(of: "v1", in: ["v1"]), [])
    }

    // MARK: - Which ways

    func testWhatTwoVersionsAreIsReadOffTheirLinksAsTheViewersRouteThem() {
        XCTAssertEqual(CompareContent.of(kind: "image", link: "/tmp/hero.png"), .image)
        XCTAssertEqual(CompareContent.of(kind: nil, link: "/tmp/HERO.JPG"), .image)
        XCTAssertEqual(CompareContent.of(kind: nil, link: "file:///tmp/shot.webp"), .image)
        // An agent may call a PNG mockup a design: the picture is still pixels.
        XCTAssertEqual(CompareContent.of(kind: "design", link: "/tmp/mock.png"), .image)
        XCTAssertEqual(CompareContent.of(kind: "markdown", link: "/work/plan.md"), .text)
        XCTAssertEqual(CompareContent.of(kind: nil, link: "/work/src/app.swift"), .text)
        XCTAssertEqual(CompareContent.of(kind: nil, link: "/work/LICENSE"), .text)
        // A name that says nothing: the agent's kind decides.
        XCTAssertEqual(CompareContent.of(kind: "text", link: "/work/notes"), .text)
        XCTAssertEqual(CompareContent.of(kind: nil, link: "/work/notes"), .other)
        // A web address is a page whatever it ends in; so is a local page.
        XCTAssertEqual(CompareContent.of(kind: "url", link: "https://example.com/hero.png"), .other)
        XCTAssertEqual(CompareContent.of(kind: "page", link: "/work/site/index.html"), .other)
        XCTAssertEqual(CompareContent.of(kind: "pdf", link: "/work/spec.pdf"), .other)
        XCTAssertEqual(CompareContent.of(kind: "simulator", link: nil), .other)
    }

    func testTwoVersionsCompareAsWhatTheyBothAre() {
        XCTAssertEqual(CompareContent.shared(.image, .image), .image)
        XCTAssertEqual(CompareContent.shared(.image, .other), .other)
        XCTAssertEqual(CompareContent.shared(.text, .image), .other)
    }

    func testEachKindOffersTheWaysItCanHonestlyBeCompared() {
        XCTAssertEqual(VersionCompare.modes(for: .image, wide: true), [.slider, .sideBySide])
        XCTAssertEqual(VersionCompare.modes(for: .image, wide: false), [.slider, .sideBySide])
        XCTAssertEqual(VersionCompare.modes(for: .text, wide: true), [.diff, .sideBySide])
        XCTAssertEqual(VersionCompare.modes(for: .text, wide: false), [.diff, .flip])
        // A page or a PDF has no slider and no diff: two of it, or one at a time where there is no room for two.
        XCTAssertEqual(VersionCompare.modes(for: .other, wide: true), [.sideBySide])
        XCTAssertEqual(VersionCompare.modes(for: .other, wide: false), [.flip])
    }

    func testAPickedModeHoldsWhileItIsOfferedAndTheFirstOtherwise() {
        XCTAssertEqual(VersionCompare.mode(nil, for: .image, wide: true), .slider)
        XCTAssertEqual(VersionCompare.mode(.sideBySide, for: .image, wide: true), .sideBySide)
        XCTAssertEqual(VersionCompare.mode(.slider, for: .text, wide: true), .diff)
        XCTAssertEqual(VersionCompare.mode(.slider, for: .other, wide: false), .flip)
    }

    /// conch keeps a link to each version, not a copy: a picture edited in place and published again is one file twice.
    func testTwoVersionsOfOneFileOrOnePageAreSaidToBeTheSame() {
        XCTAssertTrue(VersionCompare.sharesLink("/tmp/photo.jpg", "/tmp/photo.jpg"))
        XCTAssertTrue(VersionCompare.sharesLink("/tmp/./photo.jpg", " /tmp/photo.jpg "))
        XCTAssertTrue(VersionCompare.sharesLink("file:///tmp/photo.jpg", "/tmp/photo.jpg"))
        XCTAssertTrue(VersionCompare.sharesLink("https://example.com/p#top", "https://example.com/p#pricing"))
        XCTAssertFalse(VersionCompare.sharesLink("/tmp/photo.jpg", "/tmp/photo-after.jpg"))
        XCTAssertFalse(VersionCompare.sharesLink("https://example.com/a", "https://example.com/b"))
        XCTAssertFalse(VersionCompare.sharesLink(nil, nil), "two linkless versions are two filings, not one file")
    }

    // MARK: - The slider

    func testTheDividerGoesWhereYouPressAndStaysOnThePicture() {
        XCTAssertEqual(CompareSlider.fraction(atX: 50, width: 200), 0.25)
        XCTAssertEqual(CompareSlider.fraction(atX: -30, width: 200), 0)
        XCTAssertEqual(CompareSlider.fraction(atX: 260, width: 200), 1)
        XCTAssertEqual(CompareSlider.fraction(atX: 10, width: 0), CompareSlider.start)
        XCTAssertEqual(CompareSlider.dividerX(0.25, width: 200), 50)
        XCTAssertEqual(CompareSlider.dividerX(3, width: 200), 200)
        XCTAssertEqual(CompareSlider.clamp(.nan), CompareSlider.start)
    }

    func testArrowsStepTheDividerAndLandOnTheSteps() {
        XCTAssertEqual(CompareSlider.moved(0.5, by: 1), 0.55)
        XCTAssertEqual(CompareSlider.moved(0.5, by: -1), 0.45)
        XCTAssertEqual(CompareSlider.moved(0.5, by: 1, large: true), 0.75)
        // From a dragged position, the next step in the direction pressed.
        XCTAssertEqual(CompareSlider.moved(0.437, by: 1), 0.45)
        XCTAssertEqual(CompareSlider.moved(0.437, by: -1), 0.4)
        XCTAssertEqual(CompareSlider.moved(0.45, by: -1), 0.4)
        // Never past either edge.
        XCTAssertEqual(CompareSlider.moved(0.98, by: 1), 1)
        XCTAssertEqual(CompareSlider.moved(0.02, by: -1, large: true), 0)
        XCTAssertEqual(CompareSlider.moved(1, by: 1), 1)
        // Twenty steps cross the whole picture, with no drift.
        var fraction = 0.0
        for _ in 0 ..< 20 { fraction = CompareSlider.moved(fraction, by: 1) }
        XCTAssertEqual(fraction, 1)
    }

    func testBothVersionsAreFittedWholeIntoTheSameRect() {
        // A landscape picture in a tall box: full width, centred vertically.
        XCTAssertEqual(CompareSlider.fit(CGSize(width: 400, height: 300), in: CGSize(width: 200, height: 400)),
                       CGRect(x: 0, y: 125, width: 200, height: 150))
        // A portrait one in a wide box: full height, centred horizontally.
        XCTAssertEqual(CompareSlider.fit(CGSize(width: 300, height: 600), in: CGSize(width: 500, height: 300)),
                       CGRect(x: 175, y: 0, width: 150, height: 300))
        XCTAssertEqual(CompareSlider.fit(.zero, in: CGSize(width: 10, height: 10)), .zero)
    }

    func testVoiceOverHearsHowMuchOfEachVersionShows() {
        XCTAssertEqual(CompareSlider.accessibilityValue(0.3, before: "v1", after: "v2"), "30 percent v1, 70 percent v2")
    }

    /// A chip names the version under it; with the divider nearly over it, what is under it is the other version.
    func testASidesNameGoesWhenTheDividerAlmostHidesThatSide() {
        XCTAssertTrue(CompareSlider.showsBeforeLabel(0.5))
        XCTAssertTrue(CompareSlider.showsAfterLabel(0.5))
        XCTAssertFalse(CompareSlider.showsBeforeLabel(0.1))
        XCTAssertTrue(CompareSlider.showsAfterLabel(0.1))
        XCTAssertFalse(CompareSlider.showsAfterLabel(0.95))
        XCTAssertTrue(CompareSlider.showsBeforeLabel(0.95))
    }

    // MARK: - Side by side

    func testSideBySideArrangesThePicturesWhicheverWayDrawsThemBigger() {
        let landscape = CGSize(width: 1600, height: 900)
        let portrait = CGSize(width: 900, height: 1600)
        // A phone held upright: two landscape shots stack.
        XCTAssertEqual(CompareLayout.axis(before: landscape, after: landscape, in: CGSize(width: 390, height: 640)), .vertical)
        // A Mac pane: they sit beside each other once each half is wide enough.
        XCTAssertEqual(CompareLayout.axis(before: portrait, after: portrait, in: CGSize(width: 1000, height: 700)), .horizontal)
        XCTAssertEqual(CompareLayout.axis(before: landscape, after: landscape, in: CGSize(width: 1400, height: 500)), .horizontal)
        // A tie stays beside.
        XCTAssertEqual(CompareLayout.axis(before: .zero, after: .zero, in: CGSize(width: 100, height: 100)), .horizontal)
    }

    // MARK: - What each side is called

    func testEachSideIsNamedByVersionAgeAndSummary() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let twoHoursAgo = (now.timeIntervalSince1970 - 7_200) * 1_000
        XCTAssertEqual(
            VersionLabel.line(version: 1, place: 1, filedAt: twoHoursAgo, summary: "Flat grade, straight from the camera", now: now),
            "v1 · 2h ago — Flat grade, straight from the camera"
        )
        // An older daemon numbers none: the version's place stands in. No time, no age.
        XCTAssertEqual(VersionLabel.line(version: nil, place: 2, filedAt: nil, summary: "after", now: now), "v2 — after")
        XCTAssertEqual(VersionLabel.line(version: 3, place: 1, filedAt: nil, summary: "  ", now: now), "v3")
        // A long summary is cut, not left to run the width of the screen.
        let long = String(repeating: "x", count: 100)
        XCTAssertEqual(VersionLabel.line(version: 1, place: 1, filedAt: nil, summary: long, now: now, maxSummary: 10), "v1 — xxxxxxxxx…")
    }

    func testAgesAreTheLedgersWithAgo() {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let ms = { (seconds: Double) in (now.timeIntervalSince1970 - seconds) * 1_000 }
        XCTAssertEqual(VersionLabel.age(epochMilliseconds: ms(20), now: now), "just now")
        XCTAssertEqual(VersionLabel.age(epochMilliseconds: ms(12 * 60), now: now), "12m ago")
        XCTAssertEqual(VersionLabel.age(epochMilliseconds: ms(3 * 3_600), now: now), "3h ago")
        XCTAssertEqual(VersionLabel.age(epochMilliseconds: ms(2 * 86_400), now: now), "2d ago")
        XCTAssertNil(VersionLabel.age(epochMilliseconds: nil, now: now))
        XCTAssertNil(VersionLabel.age(epochMilliseconds: 0, now: now))
    }

    // MARK: - Text

    func testADiffReadsAsKeptRemovedAndAdded() throws {
        let diff = try XCTUnwrap(TextDiff.between("a\nb\nc\nd\n", "a\nc\nd\ne\n"))
        XCTAssertEqual(diff.lines.map(\.change), [.same, .removed, .same, .same, .added])
        XCTAssertEqual(diff.lines.map(\.text), ["a", "b", "c", "d", "e"])
        XCTAssertEqual(diff.lines[1].before, 2)
        XCTAssertNil(diff.lines[1].after)
        XCTAssertEqual(diff.lines[4].after, 4)
        XCTAssertNil(diff.lines[4].before)
        XCTAssertEqual(diff.removed, 1)
        XCTAssertEqual(diff.added, 1)
        XCTAssertFalse(diff.isIdentical)
    }

    func testAChangedLineIsARemovalAndAnAddition() throws {
        let diff = try XCTUnwrap(TextDiff.between("title\nold words\nend", "title\nnew words\nend"))
        XCTAssertEqual(diff.lines.map(\.change), [.same, .removed, .added, .same])
        XCTAssertEqual(diff.lines.map(\.text), ["title", "old words", "new words", "end"])
    }

    func testTheSameTextIsNoChangeAndLineEndsAreLines() throws {
        let diff = try XCTUnwrap(TextDiff.between("one\r\ntwo\r\n", "one\ntwo"))
        XCTAssertTrue(diff.isIdentical)
        XCTAssertEqual(diff.lines.count, 2)
        XCTAssertEqual(try XCTUnwrap(TextDiff.between("", "")).lines, [])
        XCTAssertEqual(try XCTUnwrap(TextDiff.between("", "x\ny")).lines.map(\.change), [.added, .added])
        XCTAssertEqual(try XCTUnwrap(TextDiff.between("x\ny", "")).lines.map(\.change), [.removed, .removed])
    }

    /// Myers' script is the SHORTEST: applied to the before, it makes the after, with as few changes as can.
    func testTheDiffRebuildsBothTextsWithTheFewestChanges() throws {
        var seed: UInt64 = 42
        func next(_ bound: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(bound))
        }
        for _ in 0 ..< 200 {
            let before = (0 ..< next(14)).map { _ in "l\(next(5))" }
            let after = (0 ..< next(14)).map { _ in "l\(next(5))" }
            let diff = try XCTUnwrap(TextDiff.between(before.joined(separator: "\n"), after.joined(separator: "\n")))
            XCTAssertEqual(diff.lines.filter { $0.change != .added }.map(\.text), before)
            XCTAssertEqual(diff.lines.filter { $0.change != .removed }.map(\.text), after)
            XCTAssertEqual(diff.lines.filter { $0.change == .same }.count, Self.lcs(before, after), "\(before) → \(after)")
        }
    }

    func testTooLargeOrTooChangedIsNoDiff() {
        let many = (0 ..< 30).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertNil(TextDiff.between(many, "", maxLines: 20))
        let other = (0 ..< 30).map { "other \($0)" }.joined(separator: "\n")
        XCTAssertNil(TextDiff.between(many, other, maxChanges: 10))
        XCTAssertNotNil(TextDiff.between(many, other, maxChanges: 60))
    }

    func testLongUnchangedRunsFoldAroundTheChanges() throws {
        let before = (1 ... 20).map { "line \($0)" }
        var after = before
        after[9] = "line 10, edited"
        let diff = try XCTUnwrap(TextDiff.between(before.joined(separator: "\n"), after.joined(separator: "\n")))
        let rows = diff.rows(context: 2)
        // 7 folded, 2 of context, the change (removed + added), 2 of context, 8 folded.
        XCTAssertEqual(rows.count, 1 + 2 + 2 + 2 + 1)
        guard case let .fold(first, firstCount) = rows[0], case let .fold(_, lastCount) = rows.last! else {
            return XCTFail("both ends fold")
        }
        XCTAssertEqual(firstCount, 7)
        XCTAssertEqual(lastCount, 8)
        // Opened, a fold is its lines.
        XCTAssertEqual(diff.rows(context: 2, expanded: [first]).count, rows.count - 1 + 7)
        // Nothing changed folds nothing away that matters: the whole text is one fold.
        let same = try XCTUnwrap(TextDiff.between(before.joined(separator: "\n"), before.joined(separator: "\n")))
        XCTAssertEqual(same.rows().count, 1)
        // A fold of a single line is just that line.
        let short = try XCTUnwrap(TextDiff.between("a\nb\nc\nd\ne", "a\nb\nc\nd\nE"))
        XCTAssertEqual(short.rows(context: 3).count, 6)
    }

    func testRowIdentitiesAreUnique() throws {
        let diff = try XCTUnwrap(TextDiff.between("a\nb\nc\n\n\nd", "a\nB\nc\n\nd\ne"))
        let ids = diff.rows(context: 0).map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }

    private static func lcs(_ a: [String], _ b: [String]) -> Int {
        var table = [[Int]](repeating: [Int](repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        return table[0][0]
    }
}

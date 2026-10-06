import SwiftUI
import XCTest
@testable import ConchDesign

/// The sidebar's rows as a name first (SidebarRow.swift): the name keeps its beginning and fades at its end, and the
/// words the row no longer draws beside it go to its second line, its tooltip or VoiceOver.
final class SidebarRowTests: XCTestCase {
    // MARK: The second line

    func testOnlyWhatAsksSomethingEarnsASecondLine() {
        XCTAssertNil(SidebarRowText.subtitle(message: nil, blockedOn: nil, startedBy: nil))
        XCTAssertEqual(
            SidebarRowText.subtitle(message: nil, blockedOn: "Allow rm -rf build/ in morrow-site?", startedBy: nil),
            "Allow rm -rf build/ in morrow-site?"
        )
        XCTAssertEqual(
            SidebarRowText.subtitle(message: nil, blockedOn: nil, startedBy: "Sidebar names redesign"),
            "started by Sidebar names redesign"
        )
    }

    /// conch's own word about the row (a failed rename) outranks the question, which outranks the starter.
    func testConchsWordComesFirstThenTheQuestionThenTheStarter() {
        XCTAssertEqual(
            SidebarRowText.subtitle(message: "Couldn't rename", blockedOn: "Allow rm?", startedBy: "Parent"),
            "Couldn't rename"
        )
        XCTAssertEqual(SidebarRowText.subtitle(message: nil, blockedOn: "Allow rm?", startedBy: "Parent"), "Allow rm?")
    }

    func testBlankWordsAreNoLine() {
        XCTAssertNil(SidebarRowText.subtitle(message: "  ", blockedOn: "\n", startedBy: ""))
        XCTAssertEqual(SidebarRowText.subtitle(message: " ", blockedOn: " Allow rm? ", startedBy: nil), "Allow rm?")
    }

    // MARK: What a working agent is doing (2026-10-03)

    func testAWorkingRowSaysWhatItsAgentIsDoing() {
        XCTAssertEqual(SidebarActivity.line("Running the test suite", working: true), "Running the test suite")
        XCTAssertEqual(
            SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: "Editing src/voice-loop.ts", startedBy: nil),
            SidebarRowText.SecondLine(text: "Editing src/voice-loop.ts", kind: .activity)
        )
    }

    /// Idle, waiting and blocked rows stay their name alone, as does one whose own turn is over while only its agents
    /// run, and one a usage limit stopped: whatever the daemon sent, nothing changes for them.
    func testOnlyARowWorkingOnItsOwnTurnShowsTheLine() {
        XCTAssertNil(SidebarActivity.line("Running the test suite", working: false))
        XCTAssertNil(SidebarActivity.line("Running the test suite", working: true, waitingOnAgents: true))
        XCTAssertNil(SidebarActivity.line("Running the test suite", working: true, usageLimited: true))
        XCTAssertNil(SidebarActivity.line(nil, working: true))
        XCTAssertNil(SidebarActivity.line(" \n\t ", working: true))
    }

    func testTheLineIsOneLineOfAtMostNinetyCharacters() throws {
        XCTAssertEqual(SidebarActivity.clean("Reading\n  three\tfiles "), "Reading three files")
        let long = "Running the full local CI on the settings branch, then rebuilding the Mac app and the iPhone app and comparing"
        let line = try XCTUnwrap(SidebarActivity.clean(long))
        XCTAssertLessThanOrEqual(line.count, SidebarActivity.maxCharacters)
        XCTAssertTrue(line.hasSuffix("…"))
        XCTAssertFalse(line.contains("\n"))
        // Cut on a word: what is left before the ellipsis is a whole-word prefix of the original.
        let kept = String(line.dropLast())
        XCTAssertTrue(long.hasPrefix(kept))
        XCTAssertTrue([" ", ","].contains(long[long.index(long.startIndex, offsetBy: kept.count)]))
        // A line exactly at the cap is kept whole, and characters are counted as a reader sees them.
        let exact = String(repeating: "é", count: SidebarActivity.maxCharacters)
        XCTAssertEqual(SidebarActivity.clean(exact), exact)
        let emoji = String(repeating: "👩‍💻", count: SidebarActivity.maxCharacters + 5)
        XCTAssertEqual(SidebarActivity.clean(emoji)?.count, SidebarActivity.maxCharacters)
    }

    /// conch's word and the question a blocked row waits on outrank what the agent is doing; what it is doing outranks
    /// which session started it, which its indent under the starter already says.
    func testTheActivitySitsBelowConchsWordAndTheQuestionAndAboveTheStarter() {
        XCTAssertEqual(
            SidebarRowText.secondLine(message: "Couldn't rename", blockedOn: nil, activity: "Running tests", startedBy: "Parent")?.kind,
            .message
        )
        XCTAssertEqual(
            SidebarRowText.secondLine(message: nil, blockedOn: "Allow rm?", activity: "Running tests", startedBy: "Parent")?.kind,
            .question
        )
        XCTAssertEqual(
            SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: "Running tests", startedBy: "Parent"),
            SidebarRowText.SecondLine(text: "Running tests", kind: .activity)
        )
        XCTAssertEqual(
            SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: "  ", startedBy: "Parent"),
            SidebarRowText.SecondLine(text: "started by Parent", kind: .startedBy)
        )
        // The old rule's answers are unchanged for every row with no activity.
        XCTAssertEqual(SidebarRowText.subtitle(message: nil, blockedOn: nil, startedBy: "Parent"), "started by Parent")
    }

    // MARK: The tooltip

    /// The whole name, which the row may fade, then the summary the row no longer draws.
    func testTheTooltipCarriesTheWholeNameAndTheSummary() {
        let name = "Prime design system studio, with Mara's review notes"
        XCTAssertEqual(
            SidebarRowText.tooltip(name: name, snippet: "Mara's review notes folded into the tokens page", startedBy: nil),
            "\(name)\nMara's review notes folded into the tokens page"
        )
        XCTAssertEqual(
            SidebarRowText.tooltip(name: "codex review", snippet: "", startedBy: "Sidebar names redesign"),
            "codex review\nStarted by Sidebar names redesign"
        )
        XCTAssertEqual(SidebarRowText.tooltip(name: "Scratch", snippet: nil, startedBy: nil), "Scratch")
        XCTAssertEqual(SidebarRowText.tooltip(name: "Scratch", snippet: "Scratch", startedBy: nil), "Scratch")
    }

    // MARK: VoiceOver

    func testVoiceOverHearsTheWholeNameTheStateAndTheAgent() {
        let name = "flight and hotel research for the Seashell Bay trip in October"
        let label = SidebarRowText.accessibilityLabel(
            name: name, state: "Ready for you — work to look at", agent: "Codex", voice: nil, startedBy: nil
        )
        XCTAssertEqual(label, "\(name), Ready for you — work to look at, Codex")
    }

    /// What a working agent is doing is read with its state, before the agent's name: "Working, Running the test suite".
    func testVoiceOverHearsWhatAWorkingAgentIsDoing() {
        let label = SidebarRowText.accessibilityLabel(
            name: "conch brand", state: "Working", agent: "Claude", voice: nil, startedBy: nil,
            activity: "Running the test suite"
        )
        XCTAssertEqual(label, "conch brand, Working, Running the test suite, Claude")
        XCTAssertEqual(
            SidebarRowText.accessibilityLabel(name: "conch brand", state: "Working", agent: "Claude", voice: nil, startedBy: nil, activity: " "),
            "conch brand, Working, Claude"
        )
    }

    func testVoiceOverHearsQuietAndTheStarterWhenTheyApply() {
        let label = SidebarRowText.accessibilityLabel(
            name: "codex review", state: "Working", agent: "Codex", voice: .quiet, startedBy: "Sidebar names redesign"
        )
        XCTAssertEqual(label, "codex review, Working, Codex, \(SessionVoice.Mark.quiet.meaning), started by Sidebar names redesign")
    }

    // MARK: The fade

    /// A name too long for its line shows its beginning, and fades out over its last points instead of ending in an
    /// ellipsis: the last columns are faint, the ones before the fade are full ink.
    @MainActor
    func testALongNameShowsItsBeginningAndFadesAtItsEnd() throws {
        let coverage = try inkByColumn(TailFadeText("Prime design system studio and its tokens"), width: 90)
        XCTAssertEqual(coverage.count, 90, "it takes the width it is offered, not the text's")
        // Its beginning: ink from the first few points, so it is not the middle or the end that shows.
        XCTAssertGreaterThan(coverage.prefix(4).max() ?? 0, 0.5)
        // Full ink up to the fade…
        XCTAssertGreaterThan(coverage[40..<60].max() ?? 0, 0.85)
        // …and faint in the last few points, where an ellipsis would be solid dots.
        XCTAssertLessThan(coverage.suffix(4).max() ?? 1, 0.3)
    }

    /// A name that fits is drawn plainly, even when it only just fits: no fade eats its last letters.
    @MainActor
    func testANameThatFitsIsNotFaded() throws {
        let name = "Kokoro voice bundling"
        // Its own width, drawn unconstrained, then a line two points wider: the end lands inside where the fade would be.
        let natural = try XCTUnwrap(ImageRenderer(content: Text(name).font(.system(size: 13)).fixedSize()).cgImage).width
        let coverage = try inkByColumn(TailFadeText(name), width: CGFloat(natural + 2))
        let lastInk = try XCTUnwrap(coverage.lastIndex { $0 > 0.05 })
        XCTAssertGreaterThan(lastInk, natural - 6, "the end of the name is at the end of the line")
        XCTAssertGreaterThan(coverage[(lastInk - 3)...lastInk].max() ?? 0, 0.85)
    }

    /// The strongest ink in each column, 0…1, of `view` drawn black at 1× in `width` points.
    @MainActor
    private func inkByColumn(_ view: some View, width: CGFloat) throws -> [Double] {
        let content = view
            .font(.system(size: 13))
            .foregroundStyle(.black)
            .frame(width: width, alignment: .leading)
            .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        let (w, h) = (image.width, image.height)
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        pixels.withUnsafeMutableBytes { buffer in
            let context = CGContext(
                data: buffer.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            )!
            context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        return (0..<w).map { x in
            (0..<h).map { y in Double(pixels[(y * w + x) * 4 + 3]) / 255 }.max() ?? 0
        }
    }
}

import XCTest
@testable import ConchDesign

/// 2026-10-05, Tyler: "trying to start a new session (background session with claude account) and it didn't start …
/// and the modal didn't close". The phone's yes, for a start naming no folder, has to go back with that start.
final class StartTrustTests: XCTestCase {
    private let home = "/Users/t"
    private let help = "/Users/t/.config/conch/help"

    /// The bug: a blank folder field sends no folder, so a yes looked up by the folder sent was never found.
    func testAYesForTheFolderTheMacNamedGoesBackWithAStartNamingNone() {
        var answers = StartTrustAnswers()
        XCTAssertFalse(answers.trustFolder(sent: nil))
        answers.asked(about: home, sent: nil)
        XCTAssertFalse(answers.trustFolder(sent: nil), "asked is not answered")
        answers.trust(home)
        XCTAssertTrue(answers.trustFolder(sent: nil))
        XCTAssertTrue(answers.trustFolder(sent: "  "))
    }

    func testANamedFolderCarriesItsOwnYesAndNoOther() {
        var answers = StartTrustAnswers()
        answers.asked(about: "/p", sent: "/p")
        answers.trust("/p")
        XCTAssertTrue(answers.trustFolder(sent: "/p"))
        XCTAssertTrue(answers.trustFolder(sent: " /p "))
        XCTAssertFalse(answers.trustFolder(sent: "/q"))
        XCTAssertFalse(answers.trustFolder(sent: nil), "a named folder's yes is not the default folder's")
    }

    func testTypingTheDefaultFolderByNameIsTheSameYes() {
        var answers = StartTrustAnswers()
        answers.asked(about: home, sent: nil)
        answers.trust(home)
        XCTAssertTrue(answers.trustFolder(sent: home))
        XCTAssertFalse(answers.trustFolder(sent: "/elsewhere"))
    }

    /// Help names no folder either, but its folder is conch's own: a yes for one is not a yes for the other.
    func testHelpAndABlankFieldAreDifferentStarts() {
        var answers = StartTrustAnswers()
        answers.asked(about: help, sent: nil, help: true)
        answers.trust(help)
        XCTAssertTrue(answers.trustFolder(sent: nil, help: true))
        XCTAssertFalse(answers.trustFolder(sent: nil))
        answers.asked(about: home, sent: nil)
        XCTAssertFalse(answers.trustFolder(sent: nil))
        answers.trust(home)
        XCTAssertTrue(answers.trustFolder(sent: nil))
        XCTAssertTrue(answers.trustFolder(sent: nil, help: true))
    }

    func testTheNoticeNamesThePromptAndTheButtonThatAnswersIt() {
        let claude = StartedSessionWatch.notCheckedIn(backend: "claude", background: true, onPhone: false)
        XCTAssertTrue(claude.contains("trust or login prompt"))
        XCTAssertTrue(claude.contains("open its startup terminal to answer it"))
        XCTAssertTrue(StartedSessionWatch.notCheckedIn(backend: "claude", background: true, onPhone: true)
            .contains("open its startup terminal on your Mac"))
        XCTAssertFalse(StartedSessionWatch.notCheckedIn(backend: "codex", background: true, onPhone: false).contains("trust"))
        XCTAssertTrue(StartedSessionWatch.notCheckedIn(backend: "claude", background: false, onPhone: true)
            .contains("Terminal on your Mac may be waiting"))
    }
}

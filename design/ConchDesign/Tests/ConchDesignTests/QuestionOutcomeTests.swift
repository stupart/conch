import XCTest
@testable import ConchDesign

final class QuestionOutcomeTests: XCTestCase {
    private let options = ["Keep them under legacy", "Migrate everything", "Keep"]

    func testTheAnswerNamesOneOption() {
        XCTAssertEqual(
            QuestionOutcome.chosen(from: options, in: "The user chose Migrate everything."),
            ["Migrate everything"]
        )
    }

    /// The shadowing case: "Keep" lives inside "Keep them under legacy", and reporting both
    /// would invent a decision nobody made.
    func testAShorterLabelInsideALongerOneIsNotASecondChoice() {
        XCTAssertEqual(
            QuestionOutcome.chosen(from: options, in: "chose Keep them under legacy"),
            ["Keep them under legacy"]
        )
    }

    func testMultipleChoicesComeBackInTheQuestionsOrder() {
        XCTAssertEqual(
            QuestionOutcome.chosen(from: options, in: "Migrate everything; also Keep"),
            ["Migrate everything", "Keep"]
        )
    }

    func testMatchingIgnoresCase() {
        XCTAssertEqual(QuestionOutcome.chosen(from: options, in: "MIGRATE EVERYTHING"), ["Migrate everything"])
    }

    /// Nothing recognisable, no result at all: claim nothing, and let the row stay as it is.
    func testAnUnrecognisableAnswerClaimsNothing() {
        XCTAssertTrue(QuestionOutcome.chosen(from: options, in: "Something else entirely").isEmpty)
        XCTAssertTrue(QuestionOutcome.chosen(from: options, in: nil).isEmpty)
        XCTAssertTrue(QuestionOutcome.chosen(from: options, in: "").isEmpty)
    }

    func testTheCollapsedLineIsTheOne3Describes() {
        XCTAssertEqual(
            QuestionOutcome.summary(header: "Legacy keys", chosen: ["Keep them under legacy"]),
            "Legacy keys · you chose Keep them under legacy"
        )
        XCTAssertEqual(
            QuestionOutcome.summary(header: "", chosen: ["Keep"]), "you chose Keep"
        )
        XCTAssertNil(QuestionOutcome.summary(header: "Legacy keys", chosen: []))
    }

    /// Several questions in one call: each answer is read from Claude Code's own
    /// `"<question>"="<answer>"`, the recorded shape (2.1.280), not by searching for labels,
    /// so one question's option can never be mistaken for another's answer.
    func testSeveralQuestionsAreReadAnswerByAnswer() {
        let result = #"Your questions have been answered: "Pick alpha?"="B1", "Pick beta?"="my own words, with a comma". You can now continue with these answers in mind."#
        XCTAssertEqual(
            QuestionOutcome.answers(to: ["Pick alpha?", "Pick beta?"], in: result),
            ["B1", "my own words, with a comma"]
        )
        // A question the result does not name: nothing certain, so nothing claimed.
        XCTAssertNil(QuestionOutcome.answers(to: ["Pick alpha?", "Pick gamma?"], in: result))
        XCTAssertNil(QuestionOutcome.answers(to: ["Pick alpha?"], in: nil))
    }
}

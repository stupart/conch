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
}

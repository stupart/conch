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

    /// A lone question answered in words collapses to those words, as recorded; one answered
    /// with exactly its options still says "you chose"; ticked options beside words are quoted whole.
    func testALoneQuestionAnsweredInWordsCollapsesToThem() {
        let options = ["The reviewed six (Recommended)", "Home page LTV bar", "Nav fix as it is"]
        let question = "Which should I audit against Jonah's rules and open as PRs tonight?"
        let typed = #"The user answered: "Which should I audit against Jonah's rules and open as PRs tonight?"="Lets review everything we've done thats not live". Read the answers carefully."#
        XCTAssertEqual(
            QuestionOutcome.summary(header: "Ship tonight", question: question, options: options, result: typed),
            "Ship tonight · you answered “Lets review everything we've done thats not live”"
        )
        let picked = #"The user answered: "Pick gammas?"="G1, G3". Read the answers carefully."#
        XCTAssertEqual(
            QuestionOutcome.summary(header: "Gamma", question: "Pick gammas?", options: ["G1", "G2", "G3"], result: picked),
            "Gamma · you chose G1, G3"
        )
        let both = #"The user answered: "Pick gammas?"="G1, G3, plus my words". Read the answers carefully."#
        XCTAssertEqual(
            QuestionOutcome.summary(header: "", question: "Pick gammas?", options: ["G1", "G2", "G3"], result: both),
            "you answered “G1, G3, plus my words”"
        )
        // Words with a comma on a multi-select question come back quoted twice (measured in the lab).
        let quoted = #"The user answered: "Pick gammas?"=""Lets review everything, then audit"". Read the answers carefully."#
        XCTAssertEqual(
            QuestionOutcome.summary(header: "Gamma", question: "Pick gammas?", options: ["G1", "G2", "G3"], result: quoted),
            "Gamma · you answered “Lets review everything, then audit”"
        )
        XCTAssertEqual(
            QuestionOutcome.answers(to: ["Pick gammas?", "Pick delta?"], in: #"answered: "Pick gammas?"=""a, b"", "Pick delta?"="D2". Read"#),
            ["a, b", "D2"]
        )
        // No recorded answer: the options named anywhere, as before; nothing named, nothing said.
        XCTAssertEqual(
            QuestionOutcome.summary(header: "Legacy keys", question: "Keep?", options: self.options, result: "chose Keep them under legacy"),
            "Legacy keys · you chose Keep them under legacy"
        )
        XCTAssertNil(QuestionOutcome.summary(header: "Gamma", question: "Pick gammas?", options: ["G1"], result: "User declined to answer questions"))
        XCTAssertNil(QuestionOutcome.summary(header: "Gamma", question: "Pick gammas?", options: ["G1"], result: nil))
    }

    /// A finished card drawn in full keeps what was chosen marked, per question, and nothing else.
    func testAFinishedCardKnowsWhatEachQuestionChose() {
        let result = #"The user answered: "Pick alpha?"="A2", "Pick gammas?"="G1, G3, words". Read the answers carefully."#
        XCTAssertEqual(
            QuestionOutcome.chosenPerQuestion(questions: ["Pick alpha?", "Pick gammas?"], options: [["A1", "A2"], ["G1", "G2", "G3"]], result: result),
            [["A2"], ["G1", "G3"]]
        )
        XCTAssertEqual(
            QuestionOutcome.chosenPerQuestion(questions: ["Pick alpha?", "Pick beta?"], options: [["A1"], ["B1"]], result: "declined"),
            [[], []]
        )
        XCTAssertEqual(QuestionOutcome.chosenPerQuestion(questions: ["Keep?"], options: [self.options], result: "chose Keep"), [["Keep"]])
        XCTAssertEqual(QuestionOutcome.chosenPerQuestion(questions: ["Keep?"], options: [self.options], result: nil), [[]])
    }

    /// Only the newest running question with nothing Tyler said after it can be answered: one he
    /// has talked past is still "running" on disk, and the daemon refuses an answer to it.
    func testOnlyTheQuestionNothingWasSaidAfterIsLive() {
        struct Row { let id: String; let user: Bool; let asking: Bool }
        let live = { (rows: [Row]) in
            QuestionOutcome.liveQuestionID(in: rows, id: \.id, isUser: \.user, isRunningQuestion: \.asking)
        }
        XCTAssertEqual(live([Row(id: "u1", user: true, asking: false), Row(id: "q1", user: false, asking: true), Row(id: "t1", user: false, asking: false)]), "q1")
        XCTAssertNil(live([Row(id: "q1", user: false, asking: true), Row(id: "u2", user: true, asking: false)]))
        XCTAssertEqual(live([Row(id: "q1", user: false, asking: true), Row(id: "q2", user: false, asking: true)]), "q2")
        XCTAssertNil(live([Row(id: "q1", user: false, asking: false)]))
        XCTAssertNil(live([]))
    }
}

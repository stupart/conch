import XCTest
@testable import ConchDesign

/// What conch makes of macOS's answers about its permissions, and what it says when a feature stops for want of one.
///
/// The Mac app gathers the answers silently (`PermissionCenter`); these are the rules that turn them into a row in
/// Settings, a button, and a line where something failed. Onboarding shows the same rows.
final class PermissionsTests: XCTestCase {
    // MARK: Readings

    func testAccessibilityIsGrantedOnlyWhenTrustedAndAnswering() {
        XCTAssertEqual(ConchPermissionReading.accessibility(trusted: false, answered: nil), .denied)
        XCTAssertEqual(ConchPermissionReading.accessibility(trusted: false, answered: false), .denied)
        XCTAssertEqual(ConchPermissionReading.accessibility(trusted: true, answered: nil), .granted)
        XCTAssertEqual(ConchPermissionReading.accessibility(trusted: true, answered: true), .granted)
        // Trusted, and still refused: the grant came after conch started.
        XCTAssertEqual(ConchPermissionReading.accessibility(trusted: true, answered: false), .needsRelaunch)
    }

    func testScreenRecordingTurnedOnSinceLaunchNeedsAReopen() {
        XCTAssertEqual(ConchPermissionReading.screenRecording(thisProcess: true, newProcess: nil), .granted)
        XCTAssertEqual(ConchPermissionReading.screenRecording(thisProcess: true, newProcess: false), .granted)
        XCTAssertEqual(ConchPermissionReading.screenRecording(thisProcess: false, newProcess: true), .needsRelaunch)
        XCTAssertEqual(ConchPermissionReading.screenRecording(thisProcess: false, newProcess: false), .denied)
        // A new process that couldn't say is no evidence of a grant.
        XCTAssertEqual(ConchPermissionReading.screenRecording(thisProcess: false, newProcess: nil), .denied)
    }

    func testMicrophoneReadsAVFoundationsFourAnswers() {
        XCTAssertEqual(ConchPermissionReading.microphone(0), .notAsked)
        XCTAssertEqual(ConchPermissionReading.microphone(1), .restricted)
        XCTAssertEqual(ConchPermissionReading.microphone(2), .denied)
        XCTAssertEqual(ConchPermissionReading.microphone(3), .granted)
        XCTAssertEqual(ConchPermissionReading.microphone(9), .unknown("macOS gave an answer conch doesn't know."))
    }

    func testAutomationNeedsEveryAppConchDrives() {
        let ok: Int32 = 0, denied = ConchPermissionReading.notPermitted, unasked = ConchPermissionReading.wouldRequireConsent
        let closed = ConchPermissionReading.procNotFound
        XCTAssertEqual(denied, -1743)
        XCTAssertEqual(unasked, -1744)
        XCTAssertEqual(closed, -600)
        XCTAssertEqual(ConchPermissionReading.automation([("Terminal", ok), ("System Events", ok)]), .granted)
        // One refusal is a refusal, whatever the other says.
        XCTAssertEqual(ConchPermissionReading.automation([("Terminal", ok), ("System Events", denied)]), .denied)
        XCTAssertEqual(ConchPermissionReading.automation([("Terminal", unasked), ("System Events", denied)]), .denied)
        XCTAssertEqual(ConchPermissionReading.automation([("Terminal", ok), ("System Events", unasked)]), .notAsked)
        // macOS answers only for a running app: not a dead end, since Allow… opens it in the background and asks.
        XCTAssertEqual(
            ConchPermissionReading.automation([("Terminal", closed), ("System Events", ok)]),
            .unanswered("Terminal isn't open, so macOS can't say yet.")
        )
        XCTAssertEqual(
            ConchPermissionReading.automation([("Terminal", closed), ("System Events", closed)]),
            .unanswered("Terminal and System Events aren't open, so macOS can't say yet.")
        )
        XCTAssertEqual(ConchPermissionStatus.unanswered("Terminal isn't open.").action, .ask)
        // A refusal from the app that is running still counts while the other is closed.
        XCTAssertEqual(ConchPermissionReading.automation([("Terminal", closed), ("System Events", denied)]), .denied)
        XCTAssertEqual(ConchPermissionReading.automation([("Terminal", -50), ("System Events", ok)]), .unknown("macOS didn't say."))
        XCTAssertEqual(ConchPermissionReading.automation([]), .unknown("macOS didn't say."))
    }

    // MARK: The row

    func testEachStatusHasItsOneButton() {
        XCTAssertNil(ConchPermissionStatus.granted.action)
        XCTAssertEqual(ConchPermissionStatus.denied.action, .openSettings)
        XCTAssertEqual(ConchPermissionStatus.notAsked.action, .ask)
        XCTAssertEqual(ConchPermissionStatus.needsRelaunch.action, .reopen)
        XCTAssertNil(ConchPermissionStatus.restricted.action)
        XCTAssertNil(ConchPermissionStatus.unknown("Terminal isn't open.").action)
        XCTAssertEqual(ConchPermissionStatus.needsRelaunch.label, "Allowed. Reopen conch to use it.")
        XCTAssertEqual(ConchPermissionStatus.unknown("Terminal isn't open.").label, "Terminal isn't open.")
        XCTAssertEqual(ConchPermissionStatus.granted.tone, .good)
        XCTAssertEqual(ConchPermissionStatus.denied.tone, .needsYou)
        // Allowed already: marked as nearly there, not as wrong.
        XCTAssertEqual(ConchPermissionStatus.needsRelaunch.tone, .almost)
        XCTAssertEqual(ConchPermissionStatus.notAsked.tone, .quiet)
    }

    /// One vocabulary: the canvas's notice and a permission row name the same two buttons the same way.
    func testTheButtonsAreTheCanvassWords() {
        XCTAssertEqual(ConchPermissionAction.openSettings.title, CanvasToolPill.Notice.Action.openSettings.title)
        XCTAssertEqual(ConchPermissionAction.reopen.title, CanvasToolPill.Notice.Action.reopen.title)
        XCTAssertEqual(ConchPermissionAction.ask.title, "Allow…")
    }

    // MARK: Every state can be finished (2026-11-11)

    /// Tyler: "it says i need to connect permissions but can't." No state that isn't already settled is left without a
    /// button, and every button has words for its help.
    func testEveryUnsettledStateHasAButtonThatSaysWhatItDoes() {
        let states: [ConchPermissionStatus] = [.denied, .notAsked, .needsRelaunch, .unanswered("Terminal isn't open."), .grantedToAnotherBuild]
        for permission in ConchPermission.allCases {
            for state in states {
                let action = try? XCTUnwrap(state.action, "\(permission) \(state)")
                XCTAssertNotNil(action, "\(permission): \(state) has no button")
                XCTAssertFalse(action?.help(for: permission).isEmpty ?? true)
            }
        }
        // Settled: nothing conch can do, and nothing offered.
        for state in [ConchPermissionStatus.granted, .restricted] {
            XCTAssertNil(state.action)
            for permission in ConchPermission.allCases { XCTAssertNil(state.secondaryAction(for: permission)) }
        }
    }

    /// A refused Automation prompt is never shown again, and System Settings can't add conch to Automation by hand:
    /// Reset… beside Open Settings is the way out. The Microphone's list is the person's own too; Accessibility and
    /// Screen Recording are switched in System Settings itself.
    func testResetIsOfferedWhereMacOSWontAskAgain() {
        XCTAssertEqual(ConchPermissionStatus.denied.secondaryAction(for: .automation), .reset)
        XCTAssertEqual(ConchPermissionStatus.denied.secondaryAction(for: .microphone), .reset)
        XCTAssertEqual(ConchPermissionStatus.grantedToAnotherBuild.secondaryAction(for: .automation), .reset)
        // Switched off and on for this build, Screen Recording and Accessibility reach conch on reopening.
        XCTAssertEqual(ConchPermissionStatus.grantedToAnotherBuild.secondaryAction(for: .screenRecording), .reopen)
        XCTAssertEqual(ConchPermissionAction.reopen.workingTitle, "Reopening…")
        XCTAssertNil(ConchPermissionStatus.denied.secondaryAction(for: .accessibility))
        XCTAssertNil(ConchPermissionStatus.denied.secondaryAction(for: .screenRecording))
        XCTAssertNil(ConchPermissionStatus.notAsked.secondaryAction(for: .automation), "not asked yet: Allow… asks")
        XCTAssertEqual(ConchPermissionAction.reset.title, "Reset…")
        // conch's own entry, in the list tccutil names, and nobody else's.
        XCTAssertEqual(ConchPermission.automation.resetArguments(bundleId: "ai.example.conch"), ["reset", "AppleEvents", "ai.example.conch"])
        XCTAssertEqual(ConchPermission.microphone.resetArguments(bundleId: "ai.example.conch"), ["reset", "Microphone", "ai.example.conch"])
        let confirm = ConchPermission.automation.resetConfirmation
        XCTAssertEqual(confirm.title, "Reset conch's Automation answer?")
        XCTAssertTrue(confirm.message.contains("Terminal and System Events"))
        XCTAssertTrue(confirm.message.contains("Nothing else changes."))
    }

    /// The hard states explain themselves under the status, in the words of the fix.
    func testTheHardStatesSayWhatToDo() throws {
        let automation = try XCTUnwrap(ConchPermissionStatus.denied.guidance(for: .automation))
        XCTAssertTrue(automation.contains("won't ask again"))
        XCTAssertTrue(automation.contains("isn't listed there"))
        XCTAssertTrue(automation.contains("Reset…"))
        // One line's worth: none of them runs past two lines of the row's text column.
        for permission in ConchPermission.allCases {
            for state in [ConchPermissionStatus.denied, .grantedToAnotherBuild, .needsRelaunch] {
                XCTAssertLessThanOrEqual(state.guidance(for: permission)?.count ?? 0, 120, "\(permission) \(state)")
            }
        }
        XCTAssertTrue(try XCTUnwrap(ConchPermissionStatus.denied.guidance(for: .microphone)).contains("Reset…"))
        let stale = try XCTUnwrap(ConchPermissionStatus.grantedToAnotherBuild.guidance(for: .screenRecording))
        XCTAssertTrue(stale.contains("off and on again"))
        XCTAssertFalse(stale.contains("Reset…"), "Screen Recording has no reset")
        XCTAssertTrue(try XCTUnwrap(ConchPermissionStatus.grantedToAnotherBuild.guidance(for: .automation)).contains("Reset…"))
        XCTAssertTrue(try XCTUnwrap(ConchPermissionStatus.needsRelaunch.guidance(for: .accessibility)).contains("sessions keep running"))
        XCTAssertNil(ConchPermissionStatus.unanswered("Terminal isn't open.").guidance(for: .automation), "the label and Allow… say it")
        XCTAssertNil(ConchPermissionStatus.restricted.guidance(for: .microphone), "the label says it")
        XCTAssertNil(ConchPermissionStatus.granted.guidance(for: .microphone))
        XCTAssertNil(ConchPermissionStatus.notAsked.guidance(for: .microphone))
        XCTAssertEqual(ConchPermissionStatus.grantedToAnotherBuild.tone, .needsYou)
        XCTAssertEqual(ConchPermissionStatus.grantedToAnotherBuild.action, .openSettings)
    }

    /// A no to this build after a yes to another is a grant System Settings shows on for the wrong build.
    func testAGrantRememberedForAnotherBuildIsSaidAsThat() {
        XCTAssertEqual(ConchPermissionGrantMemory.status(.denied, lastAllowedBuild: "old", thisBuild: "new"), .grantedToAnotherBuild)
        XCTAssertEqual(ConchPermissionGrantMemory.status(.denied, lastAllowedBuild: "same", thisBuild: "same"), .denied)
        XCTAssertEqual(ConchPermissionGrantMemory.status(.denied, lastAllowedBuild: nil, thisBuild: "new"), .denied)
        XCTAssertEqual(ConchPermissionGrantMemory.status(.denied, lastAllowedBuild: "old", thisBuild: nil), .denied, "unsigned: nothing to compare")
        // Only a no is reinterpreted: an answer macOS hasn't given, or a grant, is what it is.
        XCTAssertEqual(ConchPermissionGrantMemory.status(.notAsked, lastAllowedBuild: "old", thisBuild: "new"), .notAsked)
        XCTAssertEqual(ConchPermissionGrantMemory.status(.granted, lastAllowedBuild: "old", thisBuild: "new"), .granted)
        // Remembered once allowed, a reopen away included; a no keeps what was.
        XCTAssertEqual(ConchPermissionGrantMemory.remember(.granted, lastAllowedBuild: "old", thisBuild: "new"), "new")
        XCTAssertEqual(ConchPermissionGrantMemory.remember(.needsRelaunch, lastAllowedBuild: nil, thisBuild: "new"), "new")
        XCTAssertEqual(ConchPermissionGrantMemory.remember(.denied, lastAllowedBuild: "old", thisBuild: "new"), "old")
        XCTAssertTrue(ConchPermissionGrantMemory.stillOff(.screenRecording).hasSuffix("turn it off and on again."))
        XCTAssertTrue(ConchPermissionGrantMemory.stillOff(.microphone).contains("under Microphone"))
        XCTAssertNotNil(ConchPermissionHost.signatureCaution(adHoc: true))
        XCTAssertNil(ConchPermissionHost.signatureCaution(adHoc: false))
    }

    /// A press macOS answers without a prompt says so, instead of doing nothing anyone can see.
    func testAnAskThatShowedNoPromptSaysWhy() throws {
        let ok: Int32 = 0, denied = ConchPermissionReading.notPermitted, closed = ConchPermissionReading.procNotFound
        XCTAssertNil(ConchPermissionReading.automationAskOutcome([("Terminal", ok), ("System Events", ok)]))
        XCTAssertTrue(try XCTUnwrap(ConchPermissionReading.automationAskOutcome([("Terminal", denied), ("System Events", ok)])).contains("Reset…"))
        XCTAssertTrue(try XCTUnwrap(ConchPermissionReading.automationAskOutcome([("Terminal", ok), ("System Events", closed)])).hasPrefix("System Events wouldn't open"))
        XCTAssertNotNil(ConchPermissionReading.automationAskOutcome([("Terminal", ConchPermissionReading.wouldRequireConsent)]))
        XCTAssertNil(ConchPermissionReading.microphoneAskOutcome(granted: true, askedBefore: false))
        XCTAssertNil(ConchPermissionReading.microphoneAskOutcome(granted: false, askedBefore: false), "asked and refused: the row says Not allowed")
        XCTAssertNotNil(ConchPermissionReading.microphoneAskOutcome(granted: false, askedBefore: true), "refused before: no prompt came")
    }

    /// A stale grant is off for the features that need it, and the window's line says the fix.
    func testAStaleGrantIsATroubleWithItsFix() {
        var statuses = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.granted) })
        statuses[.microphone] = .grantedToAnotherBuild
        let notice = ConchPermissionNotice.current(noted: [], statuses: statuses, daemonIsConchs: true)
        XCTAssertEqual(notice?.trouble, .hearing)
        XCTAssertEqual(notice?.action, .openSettings)
        XCTAssertEqual(notice?.text, "Microphone is on for an earlier build of conch, not this one: turn conch off and on again in System Settings.")
        // The window's line offers Reset… where Settings does.
        XCTAssertEqual(notice?.secondary, .reset)
        XCTAssertNil(ConchPermissionNotice(trouble: .typing, status: .denied).secondary, "Accessibility is switched in System Settings")
    }

    /// Each Open Settings lands on the permission's own list, not Privacy & Security's front page.
    func testEachDeepLinkIsThePermissionsOwnList() {
        XCTAssertEqual(ConchPermission.accessibility.settingsURL.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        XCTAssertEqual(ConchPermission.automation.settingsURL.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
        XCTAssertEqual(ConchPermission.screenRecording.settingsURL.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        XCTAssertEqual(ConchPermission.microphone.settingsURL.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        XCTAssertEqual(Set(ConchPermission.allCases.map(\.settingsAnchor)).count, 4)
    }

    func testEveryPermissionSaysWhatItIsFor() {
        XCTAssertEqual(ConchPermission.accessibility.purpose, "Lets conch see which app and page you're on, and type your replies into Terminal.")
        for permission in ConchPermission.allCases {
            XCTAssertTrue(permission.purpose.hasPrefix("Lets conch "), permission.rawValue)
            XCTAssertTrue(permission.purpose.hasSuffix("."), permission.rawValue)
        }
    }

    // MARK: Where a feature failed

    func testASendsFailureNamesItsTrouble() {
        XCTAssertEqual(ConchPermissionTrouble(sendFailure: "accessibility-permission-denied"), .typing)
        XCTAssertEqual(ConchPermissionTrouble(sendFailure: "automation-permission-denied"), .controlling)
        for reason in [nil, "", "automation-failed", "delivery-unconfirmed", "system-dialog-blocking"] {
            XCTAssertNil(ConchPermissionTrouble(sendFailure: reason), reason ?? "nil")
        }
        XCTAssertEqual(ConchPermissionTrouble.typing.line, "conch can't type into Terminal: allow conch in Accessibility.")
        // The phone says the same about the same send.
        XCTAssertEqual(
            ConchSendFailure.sentence(reason: "accessibility-permission-denied"),
            "Not delivered — conch can't type into Terminal: allow conch in Accessibility."
        )
    }

    func testAMissingPermissionIsATroubleWhereverItHolds() {
        let allowed = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.granted) })
        XCTAssertNil(ConchPermissionNotice.current(noted: [], statuses: allowed, daemonIsConchs: true))

        // No Accessibility: the observer sees the app alone, and says so.
        var statuses = allowed
        statuses[.accessibility] = .denied
        let context = ConchPermissionNotice.current(noted: [], statuses: statuses, daemonIsConchs: true)
        XCTAssertEqual(context?.trouble, .screenContext)
        XCTAssertEqual(context?.text, "conch sees only which app is in front: allow conch in Accessibility to see the page or document too.")
        XCTAssertEqual(context?.action, .openSettings)

        // A refused keystroke outranks it: it is the same grant, and the louder failure.
        XCTAssertEqual(ConchPermissionNotice.current(noted: [.typing], statuses: statuses, daemonIsConchs: true)?.trouble, .typing)

        // The microphone off is a trouble on its own; not yet asked is not, since the first listen asks.
        var mic = allowed
        mic[.microphone] = .denied
        XCTAssertEqual(ConchPermissionNotice.current(noted: [], statuses: mic, daemonIsConchs: true)?.text, "conch can't hear you: allow conch in Microphone.")
        mic[.microphone] = .notAsked
        XCTAssertNil(ConchPermissionNotice.current(noted: [], statuses: mic, daemonIsConchs: true))
    }

    func testAGrantFixesItsTrouble() {
        let allowed = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.granted) })
        XCTAssertNil(ConchPermissionNotice.current(noted: [.typing, .controlling, .screen], statuses: allowed, daemonIsConchs: true))
    }

    func testTheFirstTroubleIsTheOneShown() {
        let statuses = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.denied) })
        let noted: [ConchPermissionTrouble] = [.screen, .controlling, .typing]
        XCTAssertEqual(ConchPermissionNotice.current(noted: noted, statuses: statuses, daemonIsConchs: true)?.trouble, .typing)
        XCTAssertEqual(ConchPermissionNotice.current(noted: noted, statuses: statuses, dismissed: [.typing], daemonIsConchs: true)?.trouble, .controlling)
        XCTAssertEqual(ConchPermissionNotice.current(noted: noted, statuses: statuses, dismissed: [.typing, .controlling, .hearing], daemonIsConchs: true)?.trouble, .screen)
        XCTAssertEqual(ConchPermissionTrouble.allCases, [.typing, .controlling, .hearing, .screen, .screenContext])
    }

    /// A daemon started from a terminal types and listens on that terminal's grants: conch's own say nothing about them.
    func testADaemonConchDidntStartIsntJudgedByConchsGrants() {
        let statuses = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.denied) })
        let notice = ConchPermissionNotice.current(noted: [.typing, .controlling], statuses: statuses, daemonIsConchs: false)
        // The typing, the Apple Events and the mic are the daemon's; the front window and the canvas are conch's own.
        XCTAssertEqual(notice?.trouble, .screenContext)
        XCTAssertEqual(ConchPermissionNotice.current(noted: [.screen], statuses: statuses, dismissed: [.screenContext], daemonIsConchs: false)?.trouble, .screen)
        XCTAssertTrue(ConchPermissionTrouble.typing.isDaemons)
        XCTAssertTrue(ConchPermissionTrouble.hearing.isDaemons)
        XCTAssertFalse(ConchPermissionTrouble.screen.isDaemons)
        XCTAssertFalse(ConchPermissionTrouble.screenContext.isDaemons)
    }

    func testTheButtonFollowsTheStatus() {
        XCTAssertEqual(ConchPermissionNotice(trouble: .screen, status: .needsRelaunch).text, "Screen Recording is on for conch: reopen conch to finish.")
        XCTAssertEqual(ConchPermissionNotice(trouble: .screen, status: .needsRelaunch).action, .reopen)
        XCTAssertEqual(ConchPermissionNotice(trouble: .controlling, status: .notAsked).action, .ask)
        XCTAssertEqual(ConchPermissionNotice(trouble: .controlling, status: .denied).action, .openSettings)
        XCTAssertNil(ConchPermissionNotice(trouble: .hearing, status: .restricted).action)
        // Accessibility granted after launch and still refused: the observer's line says to reopen.
        var statuses = Dictionary(uniqueKeysWithValues: ConchPermission.allCases.map { ($0, ConchPermissionStatus.granted) })
        statuses[.accessibility] = .needsRelaunch
        let notice = ConchPermissionNotice.current(noted: [], statuses: statuses, daemonIsConchs: true)
        XCTAssertEqual(notice?.text, "Accessibility is on for conch: reopen conch to finish.")
        XCTAssertEqual(notice?.action, .reopen)
    }

    func testSettingsSaysWhoMacOSIsAskingWhenItIsntConch() {
        XCTAssertNil(ConchPermissionHost.caution(startedBy: "app"))
        XCTAssertNil(ConchPermissionHost.caution(startedBy: nil))
        XCTAssertEqual(
            ConchPermissionHost.caution(startedBy: "terminal"),
            "conch's daemon was started from a terminal, so macOS checks that terminal's permissions when it types and listens, not conch's. Stop it there, and conch starts its own."
        )
        XCTAssertTrue(ConchPermissionHost.caution(startedBy: "launchd")?.contains("bun's permissions") == true)
    }
}

import XCTest
@testable import ConchDesign

/// Opening conch at login: the first launch registers, visibly, and only the first; a switch turned off stays off; the
/// switches show macOS's own answer; and every line that needs a fix carries the button to Login Items.
///
/// The Mac app reads `SMAppService.mainApp` and keeps the record in its defaults (`LoginItem`, OnboardingSupport.swift).
/// Nothing here registers anything.
final class LoginItemPolicyTests: XCTestCase {
    private let fresh = LoginItemRecord()

    // MARK: The first launch

    func testTheFirstInstalledLaunchRegisters() {
        for status in [LoginItemStatus.notRegistered, .notFound] {
            let step = LoginItemPolicy.atLaunch(fresh, legacyDecided: false, status: status, installed: true)
            XCTAssertTrue(step.register, "\(status)")
            XCTAssertEqual(step.record, fresh, "nothing is recorded until macOS has answered")
        }
    }

    func testAfterRegisteringItIsOnceAndSaidOnce() {
        let taken = LoginItemPolicy.registered(fresh, refused: false)
        XCTAssertEqual(taken, LoginItemRecord(choice: .on, registeredOnce: true, announce: true, refused: false))
        let refused = LoginItemPolicy.registered(fresh, refused: true)
        XCTAssertEqual(refused, LoginItemRecord(choice: .on, registeredOnce: true, announce: true, refused: true))
        // The launch after: nothing, whatever macOS says now.
        for record in [taken, refused] {
            for status in [LoginItemStatus.enabled, .requiresApproval, .notRegistered, .notFound] {
                XCTAssertFalse(LoginItemPolicy.atLaunch(record, legacyDecided: false, status: status, installed: true).register, "\(status)")
            }
        }
    }

    func testACopyOutsideApplicationsNeitherRegistersNorWrites() {
        for record in [fresh, LoginItemRecord(choice: .on), LoginItemRecord(choice: .off, registeredOnce: true)] {
            for legacy in [false, true] {
                let step = LoginItemPolicy.atLaunch(record, legacyDecided: legacy, status: .notRegistered, installed: false)
                XCTAssertFalse(step.register)
                XCTAssertEqual(step.record, record, "a copy that isn't installed shares its defaults with the one that is")
            }
        }
    }

    func testAlreadyRegisteredIsRecordedWithoutAWordOrARegistration() {
        // An older conch registered silently, or the person added it in System Settings.
        for status in [LoginItemStatus.enabled, .requiresApproval] {
            let step = LoginItemPolicy.atLaunch(fresh, legacyDecided: false, status: status, installed: true)
            XCTAssertFalse(step.register)
            XCTAssertEqual(step.record, LoginItemRecord(choice: .on, registeredOnce: true, announce: false, refused: false))
        }
    }

    // MARK: Never again

    func testTurnedOffInConchNeverRegistersAgain() {
        let off = LoginItemPolicy.switched(LoginItemPolicy.registered(fresh, refused: false), on: false, installed: true)
        XCTAssertEqual(off.choice, .off)
        for status in [LoginItemStatus.notRegistered, .notFound] {
            XCTAssertFalse(LoginItemPolicy.atLaunch(off, legacyDecided: false, status: status, installed: true).register)
        }
        // Turned off before conch ever registered (from outside Applications): still never.
        let offFirst = LoginItemPolicy.switched(fresh, on: false, installed: false)
        XCTAssertFalse(LoginItemPolicy.atLaunch(offFirst, legacyDecided: false, status: .notRegistered, installed: true).register)
    }

    func testTurnedOffInSystemSettingsNeverRegistersAgain() {
        // Registered at first launch, then removed in System Settings: macOS says not registered, conch says nothing.
        let registered = LoginItemPolicy.registered(fresh, refused: false)
        let step = LoginItemPolicy.atLaunch(registered, legacyDecided: false, status: .notRegistered, installed: true)
        XCTAssertFalse(step.register)
        XCTAssertNil(LoginItemPolicy.announcement(registered, status: .notRegistered), "removed, not refused: nothing to say")
    }

    func testAnOlderConchsDecisionIsADecision() {
        // #441's You're set set the switch: off stays off, and on is never registered again.
        let off = LoginItemPolicy.atLaunch(fresh, legacyDecided: true, status: .notRegistered, installed: true)
        XCTAssertFalse(off.register)
        XCTAssertEqual(off.record, LoginItemRecord(choice: .off, registeredOnce: true))
        let on = LoginItemPolicy.atLaunch(fresh, legacyDecided: true, status: .enabled, installed: true)
        XCTAssertFalse(on.register)
        XCTAssertEqual(on.record, LoginItemRecord(choice: .on, registeredOnce: true))
    }

    func testTurnedOnOutsideApplicationsRegistersAtTheFirstLaunchFromThere() {
        let asked = LoginItemPolicy.switched(fresh, on: true, installed: false)
        XCTAssertEqual(asked, LoginItemRecord(choice: .on, registeredOnce: false))
        XCTAssertTrue(LoginItemPolicy.atLaunch(asked, legacyDecided: false, status: .notRegistered, installed: true).register)
    }

    func testASwitchEndsTheFirstLaunchsLine() {
        let pending = LoginItemPolicy.registered(fresh, refused: true)
        for on in [true, false] {
            let next = LoginItemPolicy.switched(pending, on: on, installed: true)
            XCTAssertFalse(next.announce)
            XCTAssertFalse(next.refused)
            XCTAssertTrue(next.registeredOnce)
            XCTAssertEqual(next.choice, on ? .on : .off)
        }
    }

    // MARK: What the switch shows

    func testTheSwitchIsMacOSsAnswer() {
        XCTAssertTrue(LoginItemPolicy.isOn(.enabled))
        XCTAssertTrue(LoginItemPolicy.isOn(.requiresApproval))
        XCTAssertFalse(LoginItemPolicy.isOn(.notRegistered))
        XCTAssertFalse(LoginItemPolicy.isOn(.notFound))
    }

    func testTheNoteBesideTheSwitch() {
        XCTAssertNil(LoginItemPolicy.note(status: .enabled, installed: true, refusal: nil))
        XCTAssertNil(LoginItemPolicy.note(status: .notRegistered, installed: true, refusal: nil))
        XCTAssertEqual(LoginItemPolicy.note(status: .requiresApproval, installed: true, refusal: nil), .needsApproval)
        XCTAssertEqual(LoginItemPolicy.note(status: .notRegistered, installed: false, refusal: nil), .notInApplications)
        // A copy outside Applications whose installed twin is registered shows it on, without the move note.
        XCTAssertNil(LoginItemPolicy.note(status: .enabled, installed: false, refusal: nil))
        // The last press's refusal wins over everything.
        XCTAssertEqual(LoginItemPolicy.note(status: .enabled, installed: true, refusal: .refusedOff), .refusedOff)
        XCTAssertEqual(LoginItemPolicy.note(status: .notRegistered, installed: true, refusal: .refused), .refused)
    }

    // MARK: The line

    func testTheFirstLaunchsLineFollowsMacOS() {
        let taken = LoginItemPolicy.registered(fresh, refused: false)
        XCTAssertEqual(LoginItemPolicy.announcement(taken, status: .enabled), .added)
        XCTAssertEqual(LoginItemPolicy.announcement(taken, status: .requiresApproval), .needsApproval)
        let refused = LoginItemPolicy.registered(fresh, refused: true)
        XCTAssertEqual(LoginItemPolicy.announcement(refused, status: .notRegistered), .refused)
        XCTAssertEqual(LoginItemPolicy.announcement(refused, status: .notFound), .refused)
        // Allowed since: it reads as added.
        XCTAssertEqual(LoginItemPolicy.announcement(refused, status: .enabled), .added)
        // Seen: nothing.
        var seen = taken
        seen.announce = false
        XCTAssertNil(LoginItemPolicy.announcement(seen, status: .enabled))
        XCTAssertNil(LoginItemPolicy.announcement(fresh, status: .enabled))
    }

    func testTheWordsAndWhichCarryTheButton() {
        XCTAssertEqual(LoginItemLine.added.words, "conch opens when you log in, so your agents can reach you. Turn this off in Settings.")
        XCTAssertEqual(LoginItemLine.needsApproval.words, "Allow conch in System Settings › General › Login Items.")
        for line in [LoginItemLine.needsApproval, .refused, .refusedOff] {
            XCTAssertTrue(line.opensLoginItems, "\(line)")
            XCTAssertTrue(line.words.contains("System Settings › General › Login Items"), "\(line)")
        }
        XCTAssertFalse(LoginItemLine.added.opensLoginItems)
        XCTAssertFalse(LoginItemLine.notInApplications.opensLoginItems, "Login Items can't move conch into Applications")
        XCTAssertEqual(LoginItemLine.openLoginItems, "Open Login Items")
    }

    // MARK: Installed

    func testInstalledIsApplicationsOrALinkThere() {
        let home = "/Users/someone"
        XCTAssertTrue(LoginItemPolicy.installed(bundlePath: "/Applications/conch.app", home: home))
        XCTAssertTrue(LoginItemPolicy.installed(bundlePath: "/Applications/conch.app/", home: home))
        XCTAssertTrue(LoginItemPolicy.installed(bundlePath: "/Users/someone/Applications/conch.app", home: home))
        XCTAssertTrue(LoginItemPolicy.installed(bundlePath: "/Users/someone/Applications/conch.app", home: home + "/"))
        // Homebrew: /Applications/conch.app is a link to the copy in its Cellar.
        let cellar = "/opt/homebrew/Cellar/conch/0.9.0/conch.app"
        XCTAssertTrue(LoginItemPolicy.installed(bundlePath: cellar, home: home, linkedCopies: [cellar]))
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: cellar, home: home, linkedCopies: ["/opt/homebrew/Cellar/conch/0.8.0/conch.app"]))
        // A build run from Xcode, a checkout, a download that macOS moved aside.
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: "/Users/someone/Library/Developer/Xcode/DerivedData/x/Build/Products/Debug/conch-mac.app", home: home))
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: "/private/var/folders/ab/AppTranslocation/1/d/conch.app", home: home))
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: "/Users/someone/Downloads/conch.app", home: home))
        // Another user's Applications, and a name that only starts like it.
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: "/Users/other/Applications/conch.app", home: home))
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: "/ApplicationsOld/conch.app", home: home))
        XCTAssertFalse(LoginItemPolicy.installed(bundlePath: "/Users/someone/ApplicationsOld/conch.app", home: home))
    }
}

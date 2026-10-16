import AppKit
import SwiftUI
import XCTest
@testable import ConchDesign

/// The Workdesk's browser, drawn: the strip's + and its tabs, a blank tab with its profile picker, an agent clicking and
/// typing where the user can watch, a tab the user paused agents in, and a new profile being named. Hosted in a window
/// off every screen rather than `ImageRenderer`, so the address field and the buttons draw as they do in the app.
///
/// `CONCH_WORKDESK_RENDERS=<dir>` also writes each picture, light and dark, as a PNG to look at. Everything in them is
/// invented: no real page, session, account or person.
@MainActor
final class WorkdeskRenderTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() {
        MainActor.assumeIsolated {
            windows.forEach { $0.orderOut(nil) }
            windows = []
        }
        super.tearDown()
    }

    // MARK: - Drawing

    private func picture(_ content: some View, size: CGSize, dark: Bool, name: String) throws -> NSBitmapImageRep {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: -30_000, y: -30_000, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let view = NSHostingView(rootView: content
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(ConchColor.ground)
            .environment(\.colorScheme, dark ? .dark : .light))
        window.contentView = view
        window.orderFrontRegardless()
        windows.append(window)
        for _ in 0..<20 {
            view.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        if let directory = ProcessInfo.processInfo.environment["CONCH_WORKDESK_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png")
            try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
        }
        return rep
    }

    /// The colour at a point in the picture's own points (from the top left).
    private func color(_ rep: NSBitmapImageRep, _ x: CGFloat, _ y: CGFloat) -> (r: Int, g: Int, b: Int) {
        let scale = CGFloat(rep.pixelsWide) / rep.size.width
        let color = rep.colorAt(x: Int(x * scale), y: Int(y * scale))?.usingColorSpace(.sRGB) ?? .black
        return (Int(color.redComponent * 255), Int(color.greenComponent * 255), Int(color.blueComponent * 255))
    }

    private func isAgentBlue(_ c: (r: Int, g: Int, b: Int)) -> Bool { c.b > 180 && c.b > c.r + 60 }

    // MARK: - The scenes

    func testAnAgentClickingWhereTheUserCanWatch() throws {
        for dark in [false, true] {
            let rep = try picture(Scene.clicking, size: Scene.size, dark: dark, name: "workdesk-agent-clicking")
            // The ripple sits where the click landed: the middle of Export CSV.
            XCTAssertTrue(isAgentBlue(color(rep, Scene.exportButton.midX, Scene.pageTop + Scene.exportButton.midY)), "the click's mark, \(dark ? "dark" : "light")")
        }
    }

    func testANewBlankTabWithItsProfilePicker() throws {
        for dark in [false, true] {
            _ = try picture(Scene.newTab, size: Scene.size, dark: dark, name: "workdesk-new-tab-profile-picker")
        }
    }

    func testAnAgentTypingIntoAField() throws {
        for dark in [false, true] {
            let rep = try picture(Scene.typing, size: Scene.size, dark: dark, name: "workdesk-agent-typing")
            // The field's outline, on its left edge.
            XCTAssertTrue(isAgentBlue(color(rep, Scene.emailField.minX - 4, Scene.pageTop + Scene.emailField.midY)), "the typed field's outline, \(dark ? "dark" : "light")")
        }
    }

    func testATabTheUserPausedAgentsIn() throws {
        for dark in [false, true] {
            _ = try picture(Scene.paused, size: Scene.size, dark: dark, name: "workdesk-paused")
        }
    }

    func testANewProfileBeingNamed() throws {
        for dark in [false, true] {
            _ = try picture(Scene.naming, size: CGSize(width: 300, height: 250), dark: dark, name: "workdesk-new-profile")
        }
    }
}

// MARK: - Invented pages

/// The scenes: a Workdesk strip, a bar and a page under it, as the app lays them out.
@MainActor
private enum Scene {
    static let size = CGSize(width: 860, height: 470)
    /// Where the page begins under the strip (34), its hairline, the bar (26) and its hairline.
    static let pageTop: CGFloat = 34 + 1 + 26 + 1
    static let exportButton = CGRect(x: 640, y: 64, width: 112, height: 30)
    static let emailField = CGRect(x: 250, y: 150, width: 360, height: 30)

    static let profiles = [
        WorkbenchProfileList.Profile(id: "default", name: "Default"),
        WorkbenchProfileList.Profile(id: "7d4e1c2a-9b3f-4a5e-8c6d-0f1e2d3c4b5a", name: "Work"),
        WorkbenchProfileList.Profile(id: "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0", name: "Personal"),
    ]

    static let dashboard = Workbench.Tab(id: "tab-1", sessionId: "s1", url: "https://analytics.northwind.example/dashboard", title: "Dashboard · Northwind Analytics", profile: profiles[1].id, openedAt: 1)
    static let billing = Workbench.Tab(id: "tab-2", sessionId: "s1", url: "https://billing.northwind.example/invoices", title: "Invoices", profile: profiles[1].id, openedAt: 2)
    static let bank = Workbench.Tab(id: "tab-3", sessionId: "s1", url: "https://bank.example/accounts", title: "Accounts · Example Bank", openedAt: 3, openedByUser: true, paused: true)
    static let blank = Workbench.Tab(id: "tab-4", sessionId: "s1", url: "", openedAt: 4, openedByUser: true)
    static let signup = Workbench.Tab(id: "tab-5", sessionId: "s1", url: "https://app.fieldnotes.example/signup", title: "Create your account · Fieldnotes", openedAt: 5)

    static var clicking: some View {
        pane(
            tabs: [(dashboard, true, true, false), (billing, false, false, true), (bank.with(paused: false), false, false, false)],
            bar: WorkbenchBar.Facts(canGoBack: true, isSecure: true, hasPage: true, profileName: "Work", isDefaultProfile: false, agentWork: "Clicking"),
            address: dashboard.url,
            page: AnyView(DashboardPage()),
            mark: WorkbenchMark(kind: .click, rect: exportButton, serial: 1),
            // Just after the click lands: the outline held, the ripple starting out from the point.
            since: WorkbenchMarkMotion.clickLead + 0.08
        )
    }

    static var typing: some View {
        pane(
            tabs: [(dashboard, false, false, false), (signup, true, true, false)],
            bar: WorkbenchBar.Facts(canGoBack: true, isSecure: true, hasPage: true, agentWork: "Typing"),
            address: signup.url,
            page: AnyView(SignupPage(typed: "jordan@northw")),
            mark: WorkbenchMark(kind: .type, rect: emailField, serial: 1),
            since: 0.2
        )
    }

    static var paused: some View {
        pane(
            tabs: [(dashboard, false, false, false), (bank, true, false, false)],
            bar: WorkbenchBar.Facts(canGoBack: true, isSecure: true, hasPage: true, paused: true),
            address: bank.url,
            page: AnyView(BankPage()),
            mark: nil,
            since: 0
        )
    }

    static var newTab: some View {
        ZStack(alignment: .topLeading) {
            pane(
                tabs: [(dashboard, false, false, false), (blank, true, false, false)],
                bar: WorkbenchBar.Facts(canPickProfile: true),
                address: "",
                page: AnyView(WorkbenchBlankPage(profileName: "Default")),
                mark: nil,
                since: 0,
                newTabHovered: true
            )
            // The picker as the chip opens it: a popover can't be drawn offscreen, so its content in a popover's card,
            // its right edge on the chip's (the chip ends 85.5 from the right: the close, open and pause buttons and gaps).
            WorkbenchProfileList(profiles: profiles, selected: "default", pick: { _ in }, create: { _ in nil })
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ConchColor.surfaceRaised))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
                .shadow(color: .black.opacity(0.14), radius: 8, y: 6)
                .offset(x: size.width - 85.5 - 240, y: 34 + 1 + 26 + 6)
        }
    }

    static var naming: some View {
        WorkbenchProfileList(profiles: profiles, selected: "default", naming: true, draft: "Client work", pick: { _ in }, create: { _ in nil })
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(ConchColor.surfaceRaised))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(ConchColor.hairlineStrong, lineWidth: 0.5))
            .padding(20)
    }

    /// The Workdesk as the app lays it out: the strip (its place tabs, a hairline, the browser tabs and a deliverable,
    /// then the +), the bar, and the page with the agent's mark over it.
    static func pane(
        tabs: [(Workbench.Tab, Bool, Bool, Bool)],
        bar: WorkbenchBar.Facts,
        address: String,
        page: AnyView,
        mark: WorkbenchMark?,
        since: Double,
        newTabHovered: Bool = false
    ) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                PlaceTab(symbol: "folder", name: "Files")
                PlaceTab(symbol: "chevron.left.forwardslash.chevron.right", name: "Shell")
                Rectangle().fill(ConchColor.hairline).frame(width: 1, height: 14).padding(.horizontal, 2)
                // The filed work scrolls in the strip's own run, as the app's does: each tab at its own width.
                WorkdeskTabRun(shown: tabs.first(where: \.1).map { AnyHashable($0.0.id) }, newTab: {}, newTabHovered: newTabHovered) {
                    ForEach(tabs, id: \.0.id) { tab, selected, working, activity in
                        WorkbenchTabButton(tab: tab, isSelected: selected, agentWorking: working, hasActivity: activity, open: {}, close: {})
                            .workdeskTab(tab.id)
                    }
                    DeliverableStandIn(summary: "Pricing page, second pass", age: "4m")
                }
            }
            .padding(.leading, 6)
            .padding(.trailing, 6)
            .padding(.vertical, 5)
            .background(ConchColor.surface)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            BarHarness(facts: bar, draft: address)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            ZStack(alignment: .topLeading) {
                page
                if let mark { WorkbenchMarkView(mark: mark, since: since) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .clipped()
        }
        .background(ConchColor.surface)
    }
}

/// The bar, with the focus it needs.
private struct BarHarness: View {
    let facts: WorkbenchBar.Facts
    @State var draft: String
    @FocusState private var editing: Bool

    var body: some View {
        WorkbenchBar(facts: facts, draft: $draft, editing: $editing, actions: .init())
    }
}

/// Files and Shell, as the app's strip draws them (DashboardView `FilesTab`, `ShellTab`).
private struct PlaceTab: View {
    let symbol: String
    let name: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(name).font(.system(size: 11))
        }
        .foregroundStyle(ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
    }
}

/// A deliverable's tab, as the app's strip draws one looked at (DashboardView `DeliverableTab`).
private struct DeliverableStandIn: View {
    let summary: String
    let age: String

    var body: some View {
        HStack(spacing: 5) {
            Text(summary).font(.system(size: 11)).lineLimit(1)
            Text(age).font(.system(size: 10.5)).foregroundStyle(ConchColor.textTertiary).monospacedDigit()
        }
        .foregroundStyle(ConchColor.textSecondary)
        .padding(.horizontal, 8)
        .frame(height: 24)
    }
}

/// An invented analytics dashboard, with its Export CSV where the scene's click lands.
private struct DashboardPage: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            VStack(alignment: .leading, spacing: 18) {
                Text("Dashboard").font(.system(size: 22, weight: .semibold)).foregroundStyle(Color(white: 0.1))
                Text("Northwind Analytics · last 30 days").font(.system(size: 12)).foregroundStyle(Color(white: 0.45))
                HStack(spacing: 14) {
                    stat("Visitors", "48,210")
                    stat("Sign-ups", "1,904")
                    stat("Conversion", "3.9%")
                }
                .padding(.top, 14)
                RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.96)).frame(height: 150)
                    .overlay(alignment: .bottomLeading) {
                        HStack(alignment: .bottom, spacing: 10) {
                            ForEach([40, 62, 55, 80, 96, 74, 110, 92, 120, 104], id: \.self) { height in
                                RoundedRectangle(cornerRadius: 3).fill(Color(red: 0.35, green: 0.45, blue: 0.62)).frame(width: 26, height: CGFloat(height))
                            }
                        }
                        .padding(14)
                    }
            }
            .padding(.horizontal, 28)
            .padding(.top, 22)
            Text("Export CSV")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: Scene.exportButton.width, height: Scene.exportButton.height)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(white: 0.15)))
                .offset(x: Scene.exportButton.minX, y: Scene.exportButton.minY)
        }
    }

    private func stat(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name).font(.system(size: 11)).foregroundStyle(Color(white: 0.45))
            Text(value).font(.system(size: 18, weight: .semibold)).foregroundStyle(Color(white: 0.1))
        }
        .padding(12)
        .frame(width: 150, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(white: 0.88)))
    }
}

/// An invented sign-up form, its email field mid-fill.
private struct SignupPage: View {
    let typed: String

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color(white: 0.985)
            VStack(spacing: 8) {
                Text("Create your account").font(.system(size: 20, weight: .semibold)).foregroundStyle(Color(white: 0.1))
                Text("Fieldnotes keeps your team's research in one place.").font(.system(size: 12)).foregroundStyle(Color(white: 0.45))
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 34)
            label("Work email", y: Scene.emailField.minY - 20)
            field(typed, rect: Scene.emailField)
            label("Password", y: Scene.emailField.maxY + 18)
            field("", rect: Scene.emailField.offsetBy(dx: 0, dy: 68))
            Text("Continue")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: Scene.emailField.width, height: 34)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(red: 0.2, green: 0.36, blue: 0.3)))
                .offset(x: Scene.emailField.minX, y: Scene.emailField.minY + 124)
        }
    }

    private func label(_ text: String, y: CGFloat) -> some View {
        Text(text).font(.system(size: 11.5, weight: .medium)).foregroundStyle(Color(white: 0.25))
            .offset(x: Scene.emailField.minX, y: y)
    }

    private func field(_ text: String, rect: CGRect) -> some View {
        Text(text.isEmpty ? " " : text)
            .font(.system(size: 13))
            .foregroundStyle(Color(white: 0.1))
            .padding(.horizontal, 10)
            .frame(width: rect.width, height: rect.height, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(.white))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(white: 0.8)))
            .offset(x: rect.minX, y: rect.minY)
    }
}

/// An invented bank's page, in a tab the user took over.
private struct BankPage: View {
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            VStack(alignment: .leading, spacing: 14) {
                Text("Your accounts").font(.system(size: 20, weight: .semibold)).foregroundStyle(Color(white: 0.1))
                ForEach([("Everyday checking ··· 0000", "$2,480.15"), ("Savings ··· 0000", "$11,920.00")], id: \.0) { name, amount in
                    HStack {
                        Text(name).font(.system(size: 13)).foregroundStyle(Color(white: 0.2))
                        Spacer()
                        Text(amount).font(.system(size: 13, weight: .medium)).monospacedDigit().foregroundStyle(Color(white: 0.1))
                    }
                    .padding(14)
                    .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Color(white: 0.88)))
                }
            }
            .padding(28)
            .frame(maxWidth: 520, alignment: .leading)
        }
    }
}

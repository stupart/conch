import CoreGraphics
import ImageIO
import SwiftUI
import XCTest
@testable import ConchDesign

/// Teams drawn offscreen and read back by pixel (2026-11-12, TeamsViews.swift): the sidebar's team header keeps one
/// height whatever its task says or whether it is folded, and its name's line never moves; a type's card draws its whole
/// tree inside the card.
///
/// `CONCH_TEAMS_RENDERS=<dir>` also writes each picture as a PNG at 2x, to look at.
@MainActor
final class TeamsRenderTests: XCTestCase {
    private static let sidebarWidth: CGFloat = 248

    private func render(_ view: some View, width: CGFloat, name: String? = nil) throws -> SidebarActivityRenderTests.Pixels {
        let content = view
            .frame(width: width)
            .fixedSize(horizontal: false, vertical: true)
            .background(ConchColor.ground.light.color)
            .environment(\.colorScheme, .light)
            .environment(\.conchRendersStatically, true)
        if let name, let directory = ProcessInfo.processInfo.environment["CONCH_TEAMS_RENDERS"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            let url = URL(fileURLWithPath: directory).appendingPathComponent("\(name).png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, try XCTUnwrap(renderer.cgImage), nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        return SidebarActivityRenderTests.Pixels(try XCTUnwrap(renderer.cgImage))
    }

    // MARK: - The sidebar's header

    func testATeamsHeaderIsOneHeightWhateverItsTaskSays() throws {
        let tasks = [
            "Dark mode",
            "Add a dark mode to the settings page",
            "Add a dark mode to the settings page, following the system appearance, with a switch to pin it either way, and the same for onboarding",
        ]
        let pictures = try tasks.enumerated().map { index, task in
            try render(TeamHeader(name: "Build + review", task: task, count: 4, isCollapsed: false), width: Self.sidebarWidth, name: "team-header-\(index)")
        }
        XCTAssertEqual(Set(pictures.map(\.height)), [Int(TeamHeader.height)], "a long task is cut, never wrapped")
        // The name's line is the same picture, pixel for pixel, whatever the task.
        let nameBand = 0..<24
        for picture in pictures.dropFirst() {
            XCTAssertTrue(picture.sameBand(nameBand, as: pictures[0]), "the team's name doesn't move with its task")
        }
    }

    func testFoldedTheHeaderKeepsItsHeight() throws {
        let header = try render(TeamHeader(name: "Build + review", task: "Add a dark mode to the settings page", count: 4, isCollapsed: false),
                                width: Self.sidebarWidth)
        // Folded, its count shows and nothing else moves down.
        let folded = try render(TeamHeader(name: "Build + review", task: "Add a dark mode to the settings page", count: 4, isCollapsed: true),
                                width: Self.sidebarWidth)
        XCTAssertEqual(folded.height, header.height)
    }

    // MARK: - A type's card

    func testATypesCardDrawsEachRoleAsALineInsideTheCard() throws {
        func type(roles: Int) -> TeamType {
            var list = [TeamRole(id: "lead", name: "Lead", backend: .claude, model: "opus", effort: "high", atStart: true)]
            for index in 1..<roles {
                list.append(TeamRole(id: "role-\(index)", name: "Role \(index)", reportsTo: index == 3 ? "role-2" : "lead", backend: .codex,
                                     workspace: .worktree, maxConcurrent: index))
            }
            return TeamType(id: "t", name: "Build + review", summary: "Split, build, review: nobody merges.", roles: list,
                            rules: ["The lead plans and delegates.", "Nobody merges."])
        }
        let two = try render(TeamTypeCard(type: type(roles: 2)), width: 640, name: "team-card-2")
        let four = try render(TeamTypeCard(type: type(roles: 4)), width: 640, name: "team-card-4")
        XCTAssertGreaterThan(four.height, two.height, "more roles, a taller tree")
        // The card's top band (its name, summary and buttons) is the same picture whatever its roles.
        XCTAssertTrue(four.sameBand(0..<40, as: two), "the card's top doesn't change with its roles")
        // Its last rows are the card's own (its rules line), not cut off: the bottom edge is drawn on the ground.
        let ground = two.darkest(0..<1)
        XCTAssertTrue(four.inked((four.height - 30)..<(four.height - 8), ground: ground), "the rules line is inside the card")
    }
}

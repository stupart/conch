import AppKit
import ConchDesign
import SwiftUI

/// The sidebar organised (2026-11-12): Tyler's own groups among the folders, a session being dragged (the drop line over
/// a row, the ring on a header), a row's Move To menu, and Not in conch folded and open, light and dark; then the
/// phone's list with the same groups. The rows are `SidebarSessionRow` (the Mac's `DashboardRow` anatomy, main.swift);
/// the groups and their order are `SessionGrouping.sidebar` with a `SidebarLayout`, the rows of Not in conch are
/// `ElsewhereRow`. Names are made up.
func renderSidebarOrganise() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    func mark(_ name: String) -> Image? {
        let path = root.appendingPathComponent("mac-app/conch-mac/Assets.xcassets/\(name).imageset/\(name)-3x.png")
        return NSImage(contentsOf: path).map { Image(nsImage: $0).renderingMode(.template) }
    }
    let claude = mark("AgentClaude")
    let codex = mark("AgentCodex")

    let home = "/Users/alex"
    let sessions = [
        SessionGrouping.Session(id: "brand", cwd: "\(home)/Projects/conch", workDirs: nil, parentSessionId: nil, startedBySessionId: nil),
        SessionGrouping.Session(id: "perf", cwd: "\(home)/Projects/harbor", workDirs: nil, parentSessionId: nil, startedBySessionId: nil),
        SessionGrouping.Session(id: "sidebar", cwd: "\(home)/Projects/conch", workDirs: nil, parentSessionId: nil, startedBySessionId: nil),
        SessionGrouping.Session(id: "lastscreen", cwd: "\(home)/Projects/harbor-design", workDirs: nil, parentSessionId: nil, startedBySessionId: nil),
        SessionGrouping.Session(id: "site", cwd: "\(home)/Projects/site", workDirs: nil, parentSessionId: nil, startedBySessionId: nil),
    ]
    var layout = SidebarLayout.empty
    layout = layout.creatingGroup(named: "Harbor", id: "group:harbor", placing: "perf",
                                  shown: SessionGrouping.sidebar(sessions, home: home, order: [], layout: layout))
    layout = layout.moving("lastscreen", into: "group:harbor", before: "perf",
                           shown: SessionGrouping.sidebar(sessions, home: home, order: [], layout: layout))
    layout = layout.creatingGroup(named: "Later", id: "group:later",
                                  shown: SessionGrouping.sidebar(sessions, home: home, order: [], layout: layout))
    let sections = SessionGrouping.sidebar(sessions, home: home, order: [], layout: layout)
    let rows: [String: (SidebarMark, String)] = [
        "brand": (.waiting, "Conch brand pass"),
        "perf": (.working, "Offline sync"),
        "sidebar": (.review, "Sidebar groups and drag"),
        "lastscreen": (.needs, "Checkout crash"),
        "site": (.idle, "Landing page copy"),
    ]

    let agents = [
        ElsewhereAgent(id: "claude:4927", backend: "claude", pid: 4927, host: "tmux", reason: "profile", remedy: "add-account",
                       label: "harbor-12", cwd: "\(home)/Projects/Harbor", account: "~/.claude-work",
                       conversationId: "00000000-0000-4000-8000-000000000001"),
        ElsewhereAgent(id: "claude:802", backend: "claude", pid: 802, host: "iterm", reason: "profile", remedy: "resume",
                       cwd: "\(home)/Projects/site", account: "~/.claude-studio", conversationId: "00000000-0000-4000-8000-000000000002"),
        ElsewhereAgent(id: "codex:724", backend: "codex", pid: 2192, host: "chatgpt", reason: "app", remedy: "start-sheet"),
        ElsewhereAgent(id: "claude:9", backend: "claude", pid: 9, host: "vscode", reason: "no-registry", remedy: "none", cwd: "\(home)/Projects/api"),
    ]

    func list(dropOn: String? = nil, ringOn: String? = nil, elsewhereOpen: Bool, message: [String: String] = [:]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(sections) { section in
                GalleryFolderHeader(name: section.name, count: section.sessionIDs.count, isGroup: section.isGroup, isDropTarget: ringOn == section.id)
                if section.sessionIDs.isEmpty, section.isGroup {
                    Text("Drag a session here").font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary)
                        .frame(maxWidth: .infinity, minHeight: 24, alignment: .leading).padding(.leading, 20)
                }
                ForEach(section.sessionIDs, id: \.self) { id in
                    if let (mark, label) = rows[id] {
                        SidebarSessionRow(mark: mark, label: label, summary: mark.asks ? "Which of the two crash logs is the real one?" : "")
                            .overlay(alignment: .top) { if dropOn == id { SidebarDropLine().offset(y: -4) } }
                    }
                }
            }
            GalleryFolderHeader(name: ElsewhereText.header, count: agents.count, isCollapsed: !elsewhereOpen, alwaysCounts: true)
            if elsewhereOpen {
                ForEach(agents) { agent in
                    ElsewhereRow(agent, mark: agent.backend == "codex" ? codex : claude, message: message[agent.id], onAction: {})
                }
            }
        }
        .frame(width: 264)
    }

    try render("sidebar-organise", width: 1330) {
        Heading(title: "The sidebar, organised",
                note: "Tyler's groups among the folders (an empty one is a place to drop), a session dragged onto a row and onto a header, and Not in conch, folded and open")
        HStack(alignment: .top, spacing: 28) {
            SidebarColumn(title: "Groups and folders · Not in conch folded") { list(elsewhereOpen: false) }
            SidebarColumn(title: "Dragging: lands above Landing page copy") { list(dropOn: "site", elsewhereOpen: false) }
            SidebarColumn(title: "Dragging onto the Later group's header") { list(ringOn: "group:later", elsewhereOpen: false) }
            SidebarColumn(title: "Not in conch, open") { list(elsewhereOpen: true, message: ["claude:802": "Resuming in conch…"]) }
        }
        HStack(alignment: .top, spacing: 28) {
            SidebarColumn(title: "A row's menu: Move To, Move Up and Down") {
                GalleryMenu(items: [
                    ("Rename", false), ("Fork", false), ("Make Quiet", false), ("Move To ▸", true), ("Move Up", false), ("Move Down", false), ("Dismiss", false),
                ], submenu: SidebarMove.moves(for: "sidebar", layout: layout, shown: sections, topLevel: SessionGrouping.topLevel(sessions),
                                              folder: SessionGrouping.homeFolders(sessions, home: home)["sidebar"]).filter { $0.kind != .up && $0.kind != .down }.map(\.title))
            }
            SidebarColumn(title: "A group's header menu") {
                GalleryMenu(items: [("Rename Group…", false), ("Delete Group", false), ("—", false), ("New Group…", false)], submenu: [])
            }
            VStack(alignment: .leading, spacing: 10) {
                Caption("What each agent outside conch says, and its one thing (tooltip)")
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(agents) { agent in
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(ElsewhereText.title(agent)) — \(ElsewhereText.line(agent))").font(.system(size: 12, weight: .medium))
                            Text(ElsewhereText.fix(agent)).font(.system(size: 11)).foregroundStyle(ConchColor.textSecondary)
                        }
                    }
                }
                .frame(width: 520, alignment: .leading)
            }
        }
    }

    try render("sidebar-organise-phone", width: 390) {
        Heading(title: "The phone's list", note: "the same groups (an empty one is the Mac's to drop into), and Not in conch to read")
        VStack(alignment: .leading, spacing: 0) {
            ForEach(sections.filter { !($0.isGroup && $0.sessionIDs.isEmpty) }) { section in
                Text(section.name).font(.caption).foregroundStyle(ConchColor.textTertiary).padding(.top, 14).padding(.bottom, 4)
                ForEach(section.sessionIDs, id: \.self) { id in
                    if let (mark, label) = rows[id] {
                        HStack(spacing: 12) {
                            SidebarGlyph(mark: mark).frame(width: 22)
                            Text(label).font(.body)
                            Spacer()
                        }
                        .padding(.vertical, 10)
                        Rectangle().fill(ConchColor.hairline).frame(height: 1)
                    }
                }
            }
            HStack {
                Text(ElsewhereText.header)
                Spacer()
                Text("\(agents.count)").monospacedDigit()
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
            }
            .font(.caption).foregroundStyle(ConchColor.textTertiary).padding(.top, 14).padding(.bottom, 4)
            ForEach(agents) { agent in
                ElsewhereRow(agent, mark: agent.backend == "codex" ? codex : claude, nameFont: .body, lineFont: .caption)
                Rectangle().fill(ConchColor.hairline).frame(height: 1)
            }
            Text("Bring these into conch from Not in conch on your Mac.").font(.caption).foregroundStyle(ConchColor.textTertiary).padding(.top, 6)
        }
    }
}

/// DashboardView's `FolderHeader`: the chevron, the name in 12 pt, the count when folded (always, for Not in conch), the
/// drop ring; a group's name is the same, its menu is what differs.
struct GalleryFolderHeader: View {
    let name: String
    let count: Int
    var isGroup = false
    var isCollapsed = false
    var alwaysCounts = false
    var isDropTarget = false

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .rotationEffect(.degrees(isCollapsed ? 0 : 90))
                .opacity(isCollapsed ? 1 : 0.35)
                .frame(width: 10)
            Text(name).font(.system(size: 12, weight: .medium)).lineLimit(1)
            Spacer(minLength: 4)
            if isCollapsed || alwaysCounts { Text("\(count)").font(.system(size: 10, weight: .medium)).monospacedDigit() }
        }
        .foregroundStyle(ConchColor.textTertiary)
        .padding(.horizontal, 6)
        .padding(.top, 8)
        .padding(.bottom, 2)
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ConchColor.active, lineWidth: isDropTarget ? 2 : 0))
    }
}

/// A context menu, drawn: macOS draws the real one, which an offscreen render can't open.
struct GalleryMenu: View {
    let items: [(String, Bool)]
    let submenu: [String]

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    if item.0 == "—" {
                        Rectangle().fill(ConchColor.hairlineStrong).frame(height: 1).padding(.vertical, 4)
                    } else {
                        Text(item.0).font(.system(size: 13))
                            .foregroundStyle(item.1 ? Color.white : ConchColor.textPrimary.light.color)
                            .padding(.horizontal, 10).padding(.vertical, 3)
                            .frame(width: 150, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: 4).fill(item.1 ? ConchColor.active.light.color : .clear))
                    }
                }
            }
            .padding(5)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.96)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.black.opacity(0.12)))
            if !submenu.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(submenu.enumerated()), id: \.offset) { index, title in
                        if title == "New Group…", index > 0 { Rectangle().fill(Color.black.opacity(0.1)).frame(height: 1).padding(.vertical, 4) }
                        Text(title).font(.system(size: 13)).foregroundStyle(ConchColor.textPrimary.light.color)
                            .padding(.horizontal, 10).padding(.vertical, 3).frame(width: 150, alignment: .leading)
                    }
                }
                .padding(5)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color(white: 0.96)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.black.opacity(0.12)))
                .padding(.top, 70)
            }
        }
        .environment(\.colorScheme, .light)
    }
}

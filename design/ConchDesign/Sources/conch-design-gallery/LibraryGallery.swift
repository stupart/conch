import ConchDesign
import SwiftUI

/// Settings › Skills as the Mac lays it out, list beside reader, light and dark (2026-11-11): what each skill is, how to use
/// it in an open session, where each copy lives and what can be done to it. The Mac's own page reads the daemon, so these
/// are its rows and reader panel drawn from made-up skills and sessions; the reader's file view below each panel stands in
/// as its first lines. The helpers below draw Settings › Workflows too (WorkflowsGallery.swift).
func renderSkillsLibrary() throws {
    // Skills
    let handoff = InstalledSkillInfo(
        id: "skill:own:handoff", name: "handoff",
        description: "Writes the hand-off note for the next session: what changed, what is half done, and what to do next.",
        origin: "user",
        locations: [
            SkillLocationInfo(agent: "claude", accountId: "default", accountLabel: "Personal", origin: "user",
                              path: "/Users/alex/.claude/skills/handoff/SKILL.md", invocation: "/handoff"),
            SkillLocationInfo(agent: "claude", accountId: "work", accountLabel: "Studio", origin: "user",
                              path: "/Users/alex/.config/claude-studio/skills/handoff/SKILL.md", enabled: false, invocation: "/handoff"),
            SkillLocationInfo(agent: "codex", origin: "user", path: "/Users/alex/.agents/skills/handoff/SKILL.md", invocation: "$handoff"),
        ], versions: 2)
    let deploy = InstalledSkillInfo(
        id: "skill:own:deploy-check", name: "deploy-check", description: "Checks a branch is ready to ship: tests, migrations and the changelog.",
        origin: "project",
        locations: [SkillLocationInfo(agent: "claude", origin: "project", path: "/Users/alex/Projects/storefront/.claude/skills/deploy-check/SKILL.md",
                                      projectPath: "/Users/alex/Projects/storefront", enabled: nil, invocation: "/deploy-check")])
    let design = InstalledSkillInfo(
        id: "skill:plugin:design:review", name: "review", description: "Reviews a screen against the design system's tokens and spacing.",
        origin: "plugin", plugin: "design",
        locations: [SkillLocationInfo(agent: "claude", accountId: "default", accountLabel: "Personal", origin: "plugin",
                                      path: "/Users/alex/.claude/plugins/cache/market/design/2.1.0/skills/review/SKILL.md",
                                      pluginId: "design@market", pluginVersion: "2.1.0", invocation: "/design:review")])
    func skillsList(selected: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Yours · 1").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard { InstalledSkillRow(skill: handoff, isSelected: selected == handoff.id) {} }
            Text("In your projects · 1").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard { InstalledSkillRow(skill: deploy, isSelected: selected == deploy.id) {} }
            Text("From plugins · 1").font(.system(size: 12, weight: .semibold)).foregroundStyle(ConchColor.textSecondary)
            OnboardingCard { InstalledSkillRow(skill: design, isSelected: selected == design.id) {} }
        }
        .padding(18)
        .frame(width: 340, alignment: .topLeading)
    }

    let skillFile = ["SKILL.md", "---", "name: handoff", "description: Writes the hand-off note for the next session…", "---", "", "# Hand-off"]

    try render("library-skills-before", width: 1040) {
        Heading(title: "Settings › Skills, before", note: "The reader was the copy's folder and its SKILL.md, with Try… and a copies menu: nothing said which sessions had it, nor how to run it in one, switch it off or remove it.")
        libraryPage(list: { skillsList(selected: handoff.id) }) {
            libraryBar("handoff", "Claude · Personal · /handoff · ~/.claude/skills/handoff/SKILL.md") {
                Text("3 copies").font(.system(size: 12)).foregroundStyle(ConchColor.textSecondary)
                LibraryPill("Try…")
            }
            libraryFile(skillFile)
        }
    }

    try render("library-skills", width: 1040) {
        Heading(title: "Settings › Skills", note: "What it does, then Use: run it in an open session or type it into one, or try it in a new one. Each copy says where it lives, whether it is on, and what can be done to it; the sessions that have it open from their chips.")
        Caption("Your skill in two Claude accounts and Codex, off in one; three open sessions have it")
        libraryPage(list: { skillsList(selected: handoff.id) }) {
            libraryBar("handoff", "Claude · Personal · /handoff · ~/.claude/skills/handoff/SKILL.md")
            SkillDetailPanel(skill: handoff, uses: LibraryUses.skill(handoff, among: librarySessions), reading: nil, actions: .none)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            libraryFile(skillFile)
        }
        Caption("A plugin's skill: switched with its plugin, in Plugins & MCP")
        libraryPage(list: { skillsList(selected: design.id) }) {
            libraryBar("review", "Claude · Personal · /design:review · ~/.claude/plugins/cache/market/design/2.1.0/skills/review/SKILL.md")
            SkillDetailPanel(skill: design, uses: LibraryUses.skill(design, among: librarySessions), reading: nil, actions: .none)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            libraryFile(["SKILL.md", "---", "name: review", "---"])
        }
        Caption("A project's skill with no session open in the project: Try… leads")
        libraryPage(list: { skillsList(selected: deploy.id) }) {
            libraryBar("deploy-check", "Claude · Projects/storefront · /deploy-check")
            SkillDetailPanel(skill: deploy, uses: LibraryUses.skill(deploy, among: Array(librarySessions.dropFirst())), reading: nil, actions: .none)
            Rectangle().fill(ConchColor.hairline).frame(height: 1)
            libraryFile(["SKILL.md", "---", "name: deploy-check", "---"])
        }
    }
}

/// Made-up open sessions, two accounts and both agents.
let librarySessions = [
    LibrarySession(id: "s1", label: "storefront checkout", agent: "claude", accountId: nil, folders: ["/Users/alex/Projects/storefront"]),
    LibrarySession(id: "s2", label: "docs refresh", agent: "claude", accountId: nil, folders: ["/Users/alex/Projects/docs"]),
    LibrarySession(id: "s3", label: "api migration", agent: "codex", folders: ["/Users/alex/Projects/api"]),
    LibrarySession(id: "s4", label: "studio brief", agent: "claude", accountId: "work", folders: ["/Users/alex/Projects/brief"]),
]

func libraryFile(_ lines: [String]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
            Image(systemName: "doc.text").font(.system(size: 10.5))
            Text(lines[0]).font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(ConchColor.textSecondary)
        ForEach(Array(lines.dropFirst().enumerated()), id: \.offset) { _, line in
            Text(line).font(.system(size: 11, design: .monospaced)).foregroundStyle(ConchColor.textTertiary)
        }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .topLeading)
}

func libraryBar(_ title: String, _ subtitle: String, @ViewBuilder trailing: () -> some View = { EmptyView() }) -> some View {
    HStack(spacing: 8) {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(ConchColor.textPrimary)
            Text(subtitle).font(.system(size: 11)).foregroundStyle(ConchColor.textTertiary).lineLimit(1).truncationMode(.middle)
        }
        Spacer()
        trailing()
        Image(systemName: "folder").font(.system(size: 11, weight: .medium)).foregroundStyle(ConchColor.textSecondary).frame(width: 28)
        Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 11, weight: .medium)).foregroundStyle(ConchColor.textSecondary).frame(width: 28)
    }
    .padding(.leading, 14).padding(.trailing, 8)
    .frame(height: 52)
    .background(ConchColor.surfaceRaised)
    .overlay(alignment: .bottom) { Rectangle().fill(ConchColor.hairline).frame(height: 1) }
}

func libraryPage<List: View, Reader: View>(@ViewBuilder list: () -> List, @ViewBuilder reader: () -> Reader) -> some View {
    HStack(alignment: .top, spacing: 0) {
        list()
        Rectangle().fill(ConchColor.hairline).frame(width: 1)
        VStack(alignment: .leading, spacing: 0) { reader() }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .background(ConchColor.surface)
    }
    .frame(width: 960, alignment: .topLeading)
    .background(ConchColor.ground)
    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium))
    .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium).strokeBorder(ConchColor.hairlineStrong, lineWidth: 1))
}

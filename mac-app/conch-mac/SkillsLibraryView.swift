import AppKit
import ConchDesign
import SwiftUI

/// Settings › Skills and Settings › Benchmarks (2026-10-28). Tyler: "is there a nice screen or view in conch with all my
/// skills and if not can u find and scrape all my skills from all my accounts and put them there as well as find other
/// skill index's or databases like vercel has for example and show them there as things i can add and test and then lets
/// also make a new tab for benchmarks".
///
/// Laid out as a mail app is, the third column of the Settings page: the list, with the section's header over it, and a
/// reader beside it the whole height of the page. The reader is the deliverables pane's own: a skill is its folder, shown
/// as a folder deliverable is (`WorkspaceFilesView`), its tree with SKILL.md open; a benchmark is its page, in the pane's
/// web view under its origin line. The hairline between them drags, as the file tree's does.
///
/// Everything is read from the daemon (src/skills-library.ts, src/skill-indexes.ts, src/benchmarks.ts). Add shows every
/// file and where it lands before anything is written (the write pass's shape, B3); Try asks the daemon for a trial
/// folder and a first message, then starts the session through the same `session-start` the New session sheet sends.

// MARK: - The store

@MainActor
final class SkillsLibraryStore: ObservableObject {
    enum Phase: Equatable {
        case loading, loaded, needsUpdate, unreachable
        case failed(String)
    }

    @Published private(set) var installedPhase: Phase = .loading
    @Published private(set) var accounts: [LibraryAccountInfo] = []
    @Published private(set) var skills: [InstalledSkillInfo] = []
    @Published private(set) var problems: [String] = []

    @Published private(set) var discoverPhase: Phase = .loading
    @Published private(set) var indexes: [SkillIndexInfo] = []
    @Published private(set) var entries: [DiscoverSkillInfo] = []
    @Published private(set) var discoverTotal = 0
    @Published private(set) var discoverNext: Int?
    @Published private(set) var refreshing = false
    @Published private(set) var isLoadingMore = false

    /// What Discover was last asked for: a reply to an older ask is dropped.
    private var discoverAsk = SkillsLibraryRequest.discover()
    private var pollTask: Task<Void, Never>?

    /// Opening a skill from an index can fetch its repository; adding one copies it.
    private static let slowTimeout: TimeInterval = 70
    private static let timeout: TimeInterval = 20

    func loadInstalled(refresh: Bool = false) async {
        var offset = 0
        var collected: [InstalledSkillInfo] = []
        while true {
            let result: Result<SkillsInstalledPage, Failure> = await send(.installed(offset: offset, refresh: refresh && offset == 0))
            switch result {
            case let .failure(failure):
                installedPhase = failure.phase(had: installedPhase == .loaded)
                return
            case let .success(page):
                collected += page.skills
                if offset == 0 {
                    accounts = page.accounts
                    problems = page.problems
                }
                guard let next = page.next, next > offset else {
                    skills = collected
                    installedPhase = .loaded
                    return
                }
                offset = next
            }
        }
    }

    func search(query: String, index: String?, refresh: Bool = false) async {
        let ask = SkillsLibraryRequest.discover(query: query, index: index, refresh: refresh)
        discoverAsk = ask
        let result: Result<SkillsDiscoverPage, Failure> = await send(ask, timeout: Self.timeout)
        guard ask == discoverAsk else { return }
        switch result {
        case let .failure(failure):
            discoverPhase = failure.phase(had: discoverPhase == .loaded)
        case let .success(page):
            take(page, replacing: true)
            discoverPhase = .loaded
        }
        watchWhileRefreshing()
    }

    func loadMore() async {
        guard let next = discoverNext, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        var ask = discoverAsk
        ask.offset = next
        ask.refresh = nil
        let result: Result<SkillsDiscoverPage, Failure> = await send(ask, timeout: Self.timeout)
        guard case let .success(page) = result, discoverAsk.query == ask.query, discoverAsk.index == ask.index else { return }
        take(page, replacing: false)
    }

    private func take(_ page: SkillsDiscoverPage, replacing: Bool) {
        indexes = page.indexes
        entries = replacing ? page.entries : entries + page.entries.filter { entry in !entries.contains { $0.id == entry.id } }
        discoverTotal = page.total
        discoverNext = page.next
        refreshing = page.refreshing
    }

    /// While the daemon reads the indexes, ask again every two seconds, so they appear as they arrive.
    private func watchWhileRefreshing() {
        pollTask?.cancel()
        guard refreshing else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                var ask = self.discoverAsk
                ask.refresh = nil
                let result: Result<SkillsDiscoverPage, Failure> = await self.send(ask, timeout: Self.timeout)
                guard case let .success(page) = result, ask.query == self.discoverAsk.query, ask.index == self.discoverAsk.index else { continue }
                self.take(page, replacing: true)
                if !page.refreshing { return }
            }
        }
    }

    func open(_ entry: DiscoverSkillInfo) async -> Result<SkillOpenReply, Failure> {
        await send(.open(entry.id), timeout: Self.slowTimeout)
    }

    func preview(_ entry: DiscoverSkillInfo, agent: String, accountId: String) async -> Result<SkillAddPreviewReply, Failure> {
        await send(.addPreview(entry.id, agent: agent, accountId: accountId), timeout: Self.slowTimeout)
    }

    func add(_ entry: DiscoverSkillInfo, preview: SkillAddPreviewInfo) async -> Result<SkillAddedReply, Failure> {
        let result: Result<SkillAddedReply, Failure> = await send(
            .add(entry.id, agent: preview.agent, accountId: preview.accountId, planHash: preview.planHash), timeout: Self.slowTimeout)
        if case .success = result { await loadInstalled() }
        return result
    }

    func trial(_ request: SkillsLibraryRequest) async -> Result<SkillTrialReply, Failure> {
        await send(request, timeout: Self.slowTimeout)
    }

    /// Why a request didn't come back, in words, and what the section shows for it.
    struct Failure: Error, Equatable {
        enum Kind: Equatable { case unreachable, needsUpdate, refused }
        let kind: Kind
        let message: String

        func phase(had list: Bool) -> Phase {
            switch kind {
            case .unreachable: list ? .failed(message) : .unreachable
            case .needsUpdate: .needsUpdate
            case .refused: .failed(message)
            }
        }
    }

    private func send<Reply: Decodable>(_ request: SkillsLibraryRequest, timeout: TimeInterval = SkillsLibraryStore.timeout) async -> Result<Reply, Failure> {
        switch await ConchSocketClient().request(request, timeout: timeout) {
        case .connectFailed:
            return .failure(Failure(kind: .unreachable, message: "conch's daemon isn't running. Turn it on in General."))
        case .timeout:
            return .failure(Failure(kind: .refused, message: "The daemon took too long to answer. Try again."))
        case let .reply(data):
            if let reply = try? JSONDecoder().decode(Reply.self, from: data) { return .success(reply) }
            let refusal = try? JSONDecoder().decode(SkillsLibraryRefusal.self, from: data)
            // A daemon from before the library answers that it doesn't know the kind.
            if let error = refusal?.error, error.contains("unknown runtime control message kind") || error.contains("requires an updated") {
                return .failure(Failure(kind: .needsUpdate, message: "Needs an updated conch daemon"))
            }
            return .failure(Failure(kind: .refused, message: refusal?.error ?? "The daemon answered in a way this app doesn't know."))
        }
    }
}

/// Every open and reveal here goes through the app's one door (`StateStore.openLink`, A13), which says why one failed and
/// files it; `failed` gets the words, for the line the failure is shown on.
@MainActor
func libraryOpen(_ store: StateStore, _ link: String, reveal: Bool = false, failed: @escaping @MainActor (String) -> Void) {
    store.openLink(link, cwd: nil, rowId: nil, reveal: reveal, onFailure: failed)
}

extension PaneSplit {
    /// Settings › Skills' and Benchmarks' list beside the reader: wide enough for a skill's name, description and the
    /// chips under it, and never so wide the SKILL.md beside it can't be read.
    static let library = PaneSplit(key: "conch.libraryListWidth", standard: 400, minimum: 300, maximum: 620, trailingMinimum: 300)
}

extension EnvironmentValues {
    /// One pane at a time (`LibraryLayout`): the reader's bar offers the way back to the list rather than widening.
    @Entry var libraryCompact = false
}

// MARK: - Skills

struct ConchSkillsSettingsView: View {
    enum Tab: String { case installed, discover }

    @StateObject private var store = SkillsLibraryStore()
    @EnvironmentObject private var stateStore: StateStore
    /// A link or folder that would not open, in the OS's own words (A13).
    @State private var linkFailure: String?
    @AppStorage("conch.skills.tab") private var tab: Tab = .installed
    @AppStorage(PaneSplit.library.key) private var listWidth = Double(PaneSplit.library.standard)
    @State private var query = ""
    @State private var discoverQuery = ""
    /// The words Discover last asked for, so a search isn't asked twice.
    @State private var searched = ""
    @State private var scope: SkillsLibrary.Scope = .all
    @State private var index: String?
    @State private var picked: InstalledSkillInfo.ID?
    @State private var pickedEntry: DiscoverSkillInfo.ID?
    @State private var adding: DiscoverSkillInfo?
    @State private var trying: SkillTryTarget?
    /// The reader across the whole section, the list put away: the reader's ⤢, or a pick in a compact section.
    @State private var readerWide = false
    /// Too narrow for the list and the reader side by side (`LibraryLayout`).
    @State private var compact = false

    var body: some View {
        // Exactly the room the page gives it: a row or a page wider than that is clipped, never let push the section
        // over the Settings list beside it.
        GeometryReader { proxy in
            Group {
                if readerWide {
                    reader
                } else if compact {
                    listColumn
                } else {
                    ConchSplitView(split: .library, width: $listWidth, label: "Resize the skills list") {
                        listColumn
                    } trailing: {
                        reader
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .environment(\.libraryCompact, compact)
            .onChange(of: proxy.size.width, initial: true) { _, width in compact = LibraryLayout.isCompact(width: width) }
        }
        .background(ConchPalette.bg)
        .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
        .task { await store.loadInstalled() }
        .task(id: tab) { if tab == .discover, store.discoverPhase == .loading { await store.search(query: "", index: nil) } }
        // As you type, a beat after the last key (skills.sh is asked only for two letters or more, by the daemon).
        .task(id: discoverQuery) {
            guard tab == .discover, discoverQuery != searched else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            searched = discoverQuery
            await store.search(query: discoverQuery, index: index)
        }
        .sheet(item: $adding) { entry in
            SkillAddSheet(entry: entry, accounts: store.accounts, store: store) { adding = nil }
        }
        .sheet(item: $trying) { target in
            SkillTrySheet(target: target, accounts: store.accounts, store: store) { trying = nil }
        }
    }

    private var listColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The header's gap to what follows is every section's (`SettingsLayout.headerGap`), as Plugins & MCP's tabs
            // sit under its title; the controls under it, 12 apart. All of it was 12 apart, which put the tabs 8 points
            // closer to the subtitle than any other section puts what follows it.
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Skills", subtitle: subtitle) {
                    Button {
                        Task {
                            if tab == .installed { await store.loadInstalled(refresh: true) }
                            else { await store.search(query: discoverQuery, index: index, refresh: true) }
                        }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .help(tab == .installed ? "Read every account's skills again" : "Read every index again")
                }
                VStack(alignment: .leading, spacing: ConchSpace.x3) {
                    Picker("", selection: $tab) {
                        Text(store.skills.isEmpty ? "Installed" : "Installed · \(store.skills.count)").tag(Tab.installed)
                        Text("Discover").tag(Tab.discover)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    filters
                }
            }
            .padding([.top, .horizontal], SettingsLayout.inset)
            .padding(.bottom, ConchSpace.x3)

            Rectangle().fill(ConchPalette.divider).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                    if tab == .installed { installedList } else { discoverList }
                }
                .font(ConchTypography.font(size: 12))
                .padding(SettingsLayout.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(ConchPalette.bg)
    }

    private var subtitle: String {
        tab == .installed
            ? "Every skill in every account, for both agents."
            : "Skills you don't have yet, from the public indexes."
    }

    @ViewBuilder
    private var filters: some View {
        if tab == .installed {
            HStack(spacing: ConchSpace.x2) {
                LibrarySearchField(text: $query, prompt: "Filter skills")
                Picker("", selection: $scope) {
                    ForEach(SkillsLibrary.scopes(accounts: store.accounts, skills: store.skills), id: \.scope) { option in
                        Text(option.title).tag(option.scope)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .help("Show one account's skills, or every project's")
            }
        } else {
            VStack(alignment: .leading, spacing: ConchSpace.x2) {
                LibrarySearchField(text: $discoverQuery, prompt: "Search every index (skills.sh too)") {
                    searched = discoverQuery
                    Task { await store.search(query: discoverQuery, index: index) }
                }
                IndexChips(indexes: store.indexes, selected: index) { picked in
                    index = picked
                    Task { await store.search(query: discoverQuery, index: picked) }
                }
            }
        }
    }

    // MARK: Installed

    private var visibleSkills: [InstalledSkillInfo] {
        SkillsLibrary.filter(store.skills, query: query, scope: scope)
    }

    /// The top row as the list lays it out (by group), which the reader shows while nothing is picked.
    private var firstShown: InstalledSkillInfo? {
        SkillsLibrary.groups(visibleSkills).first?.skills.first
    }

    @ViewBuilder
    private var installedList: some View {
        switch store.installedPhase {
        case .loading:
            LibraryStatus(spinning: true, text: "Reading every account's skills…")
        case .needsUpdate:
            LibraryStatus(text: "Needs an updated conch daemon", isProblem: true)
        case .unreachable:
            LibraryStatus(text: "conch's daemon isn't running, so your skills can't be read. Turn it on in General.")
        case let .failed(message) where store.skills.isEmpty:
            LibraryStatus(text: message, isProblem: true)
        default:
            Text(installedSummary)
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(store.problems, id: \.self) { problem in
                LibraryStatus(text: problem, isProblem: true)
            }
            let groups = SkillsLibrary.groups(visibleSkills)
            if groups.isEmpty {
                LibraryStatus(text: query.isEmpty ? "No skills here." : "Nothing matches “\(query)”.")
            }
            ForEach(groups) { group in
                // 12 under the subheading and a 13-point mark, as Logins', Browser's and Environments' blocks have.
                VStack(alignment: .leading, spacing: ConchSpace.x3) {
                    SettingsSubheading(title: "\(group.title) · \(group.skills.count)") {
                        Image(systemName: group.symbol).font(.system(size: 13, weight: .regular))
                    }
                    OnboardingCard {
                        ForEach(Array(group.skills.enumerated()), id: \.element.id) { offset, skill in
                            if offset > 0 { SettingsHairline() }
                            // One pane at a time, nothing reads as picked until something is.
                            InstalledSkillRow(skill: skill, isSelected: (picked ?? (compact ? nil : firstShown?.id)) == skill.id) {
                                picked = skill.id
                                if compact { readerWide = true }
                            }
                                .contextMenu { installedMenu(skill) }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
                }
            }
        }
    }

    private var installedSummary: String {
        let places = store.skills.reduce(0) { $0 + $1.locations.count }
        let perAccount = store.accounts.map { "\(SkillsLibrary.agentName($0.agent)) · \($0.label) \($0.skills)" }.joined(separator: ", ")
        return "\(store.skills.count) skills in \(places) places. \(perAccount)."
    }

    @ViewBuilder
    private func installedMenu(_ skill: InstalledSkillInfo) -> some View {
        Button("Try…") { trying = .installed(skill) }
        if let location = SkillsLibrary.primaryLocation(skill) {
            Button("Reveal in Finder") { libraryOpen(stateStore, location.path, reveal: true) { linkFailure = $0 } }
            Button("Copy Path") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(location.path, forType: .string)
            }
        }
    }

    // MARK: Discover

    @ViewBuilder
    private var discoverList: some View {
        switch store.discoverPhase {
        case .loading:
            LibraryStatus(spinning: true, text: "Reading the indexes…")
        case .needsUpdate:
            LibraryStatus(text: "Needs an updated conch daemon", isProblem: true)
        case .unreachable:
            LibraryStatus(text: "conch's daemon isn't running, so the indexes can't be read. Turn it on in General.")
        case let .failed(message) where store.entries.isEmpty:
            LibraryStatus(text: message, isProblem: true)
        default:
            LibraryStatus(spinning: store.refreshing, text: discoverSummary)
            ForEach(store.indexes.filter { $0.error != nil }) { failed in
                LibraryStatus(text: "\(failed.name) couldn't be read: \(failed.error ?? "")", isProblem: true)
            }
            if store.entries.isEmpty, !store.refreshing {
                LibraryStatus(text: index == "skills-sh" && discoverQuery.trimmingCharacters(in: .whitespaces).count < 2
                    ? "skills.sh is a search: type two letters or more."
                    : discoverQuery.isEmpty ? "Nothing listed yet." : "Nothing matches “\(discoverQuery)”.")
            }
            if !store.entries.isEmpty {
                OnboardingCard {
                    ForEach(Array(store.entries.enumerated()), id: \.element.id) { offset, entry in
                        if offset > 0 { SettingsHairline() }
                        DiscoverSkillRow(entry: entry, detail: SkillsLibrary.discoverDetail(entry, indexes: store.indexes),
                                         isSelected: (pickedEntry ?? (compact ? nil : store.entries.first?.id)) == entry.id) {
                            pickedEntry = entry.id
                            if compact { readerWide = true }
                        }
                            .contextMenu {
                                Button("Add…") { adding = entry }
                                Button("Try…") { trying = .discovered(entry) }
                                Button("Open Source Page") { open(entry.url) }
                            }
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
            }
            if store.discoverNext != nil {
                HStack {
                    Spacer()
                    Button(store.isLoadingMore ? "Loading…" : "Show more") { Task { await store.loadMore() } }
                        .disabled(store.isLoadingMore)
                    Spacer()
                }
                .onAppear { Task { await store.loadMore() } }
            }
        }
    }

    private var discoverSummary: String {
        let shown = store.entries.count
        let words = discoverQuery.trimmingCharacters(in: .whitespaces)
        let found = words.isEmpty ? "\(store.discoverTotal.formatted()) skills" : "\(store.discoverTotal.formatted()) matches for “\(words)”"
        let reading = store.refreshing ? " Reading the indexes…" : ""
        return shown < store.discoverTotal ? "\(found), the first \(shown.formatted()) shown.\(reading)" : "\(found).\(reading)"
    }

    // MARK: The reader

    @ViewBuilder
    private var reader: some View {
        Group {
            if tab == .installed {
                if let skill = store.skills.first(where: { $0.id == picked }) ?? (picked == nil ? firstShown : nil) {
                    InstalledSkillReader(skill: skill, isWide: $readerWide) { trying = .installed(skill) }
                        .id(skill.id)
                } else {
                    ReaderPlaceholder(text: "Pick a skill to read its SKILL.md here.")
                }
            } else {
                // Nothing picked yet: the first, as Installed opens on its first, so the reader is never empty for nothing.
                if let entry = store.entries.first(where: { $0.id == pickedEntry }) ?? (pickedEntry == nil ? store.entries.first : nil) {
                    DiscoverSkillReader(entry: entry, store: store, isWide: $readerWide,
                                        onAdd: { adding = entry }, onTry: { trying = .discovered(entry) })
                        .id(entry.id)
                } else {
                    ReaderPlaceholder(text: "Pick a skill to read it here. conch fetches its folder from where the index says it lives.")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.surface)
        .clipped()
    }

    private func open(_ link: String) {
        libraryOpen(stateStore, link) { linkFailure = $0 }
    }
}

/// What Try starts from: one of Tyler's skills, or one from an index.
enum SkillTryTarget: Identifiable {
    case installed(InstalledSkillInfo)
    case discovered(DiscoverSkillInfo)

    var id: String {
        switch self {
        case let .installed(skill): "installed:\(skill.id)"
        case let .discovered(entry): "discovered:\(entry.id)"
        }
    }

    var name: String {
        switch self {
        case let .installed(skill): skill.name
        case let .discovered(entry): entry.name
        }
    }
}

/// The search field, in the page's style: a magnifier, the words, and a clear button once there are any.
///
/// As tall as the pop-up and the segmented control beside and above it, and as round: AppKit draws both 24 points tall
/// at a radius of about 6 (measured in the shots, 48 pixels at 2x). The field was 28 at 7, two points proud of the
/// account menu at either edge.
private struct LibrarySearchField: View {
    @Binding var text: String
    let prompt: String
    var onSubmit: (() -> Void)?

    static let height: CGFloat = 24

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(ConchPalette.textFaint)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain)
                .font(ConchTypography.font(size: 12.5))
                .onSubmit { onSubmit?() }
            if !text.isEmpty {
                Button {
                    text = ""
                    onSubmit?()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(ConchPalette.textFaint)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear the search")
            }
        }
        .padding(.horizontal, 9)
        .frame(height: Self.height)
        .background(RoundedRectangle(cornerRadius: ConchRadius.small, style: .continuous).fill(ConchPalette.fill))
        .frame(maxWidth: .infinity)
    }
}

/// The indexes Discover reads, as chips to narrow it to one: each with how many it lists, and a mark when it failed.
///
/// Eight apart, as the search field and the menu beside it are, and in balanced lines (`LibraryFlow`). A count is in the
/// chip's own colour, set apart by weight: in the tertiary colour it measured 4.13:1 on the chip's fill in light.
private struct IndexChips: View {
    let indexes: [SkillIndexInfo]
    let selected: String?
    let onSelect: (String?) -> Void

    var body: some View {
        LibraryFlow(spacing: ConchSpace.x2, balanced: true) {
            chip(title: "All", count: nil, isOn: selected == nil, help: "Every index") { onSelect(nil) }
            ForEach(indexes) { index in
                chip(title: index.name, count: index.id == "skills-sh" ? nil : index.count, isOn: selected == index.id,
                     failed: index.error != nil,
                     help: "\(index.maintainer) · \(SkillsLibrary.fetched(index.fetchedAt))\(index.id == "skills-sh" ? " · searched as you type" : "")") {
                    onSelect(selected == index.id ? nil : index.id)
                }
            }
        }
    }

    private func chip(title: String, count: Int?, isOn: Bool, failed: Bool = false, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if failed { Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 9)) }
                Text(title).font(.system(size: 11, weight: .medium))
                if let count { Text(count.formatted()).font(.system(size: 11)).foregroundStyle(ConchPalette.textDim) }
            }
            .foregroundStyle(isOn ? ConchPalette.textPrimary : ConchPalette.textDim)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(Capsule(style: .continuous).fill(isOn ? ConchPalette.selection : ConchPalette.fill))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(help)
    }
}

/// A line of status in the list: a spinner when it is working, the attention colour when something failed.
private struct LibraryStatus: View {
    var spinning = false
    let text: String
    var isProblem = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
            if spinning { ProgressView().controlSize(.small) }
            Text(text)
                .foregroundStyle(isProblem ? ConchPalette.statusNeeds : ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

private struct ReaderPlaceholder: View {
    let text: String

    var body: some View {
        VStack(spacing: 9) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(ConchPalette.textFaint)
            Text(text)
                .font(ConchTypography.font(size: 12.5))
                .foregroundStyle(ConchPalette.textDim)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.surface)
    }
}

/// The reader's line over what it shows: the name, where this copy is, and what can be done with it.
private struct ReaderBar<Actions: View>: View {
    let title: String
    let subtitle: String
    @Binding var isWide: Bool
    @ViewBuilder var actions: Actions

    @Environment(\.libraryCompact) private var compact

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: ConchSpace.x2) {
                // One pane at a time: the way back to the list leads the bar, where a back control sits everywhere else.
                if compact {
                    ReaderIconButton(symbol: "chevron.left", help: "Back to the list") { isWide = false }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(ConchTypography.font(size: 13, weight: .semibold))
                        .foregroundStyle(ConchPalette.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(subtitle)
                        .font(ConchTypography.font(size: 11))
                        .foregroundStyle(ConchPalette.textFaint)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                Spacer(minLength: ConchSpace.x2)
                actions
                if !compact {
                    ReaderIconButton(symbol: isWide ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                                     help: isWide ? "Show the list again" : "Widen the reader over the list") { isWide.toggle() }
                }
            }
            // The session bar's insets (DashboardView): words 14 from the edge, an icon button's box 8, so its glyph sits
            // about as far in as the words do. At 14 a side the ⤢ glyph sat 22.5 points from the right edge against the
            // title's 14.5 from the left.
            .padding(.leading, compact ? ReaderInset.button : ReaderInset.words)
            .padding(.trailing, ReaderInset.button)
            .frame(height: 52)
            Rectangle().fill(ConchPalette.divider).frame(height: 1)
        }
        .background(ConchPalette.raised)
    }
}

/// The reader's insets from its edges: the session bar's 14 for words, 8 for an icon button's box (`ReaderIconButton`).
private enum ReaderInset {
    static let words: CGFloat = 14
    static let button: CGFloat = ConchSpace.x2
}

/// The header's buttons' size and states (HeaderButton), for the reader's bar.
private struct ReaderIconButton: View {
    let symbol: String
    let help: String
    let action: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .medium))
                .frame(width: 28, height: 28)
                .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(isHovered ? ConchPalette.hover : .clear))
                .foregroundStyle(isHovered ? ConchPalette.textPrimary : ConchPalette.textDim)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

/// One of Tyler's skills: the folder of the copy picked (the first switched on), as a folder deliverable shows, SKILL.md
/// open. With copies in several places, a menu picks which one to read.
private struct InstalledSkillReader: View {
    let skill: InstalledSkillInfo
    @Binding var isWide: Bool
    let onTry: () -> Void
    @State private var locationID: SkillLocationInfo.ID?
    @EnvironmentObject private var stateStore: StateStore
    @State private var linkFailure: String?

    private var location: SkillLocationInfo? {
        skill.locations.first { $0.id == locationID } ?? SkillsLibrary.primaryLocation(skill)
    }

    var body: some View {
        VStack(spacing: 0) {
            ReaderBar(title: skill.name, subtitle: location.map(subtitle) ?? "", isWide: $isWide) {
                if skill.locations.count > 1 {
                    Menu {
                        ForEach(skill.locations) { candidate in
                            Button(SkillsLibrary.locationTitle(candidate) + (candidate.enabled == false ? " (off)" : "")) { locationID = candidate.id }
                        }
                    } label: {
                        Text("\(skill.locations.count) copies")
                    }
                    .menuStyle(.borderlessButton)
                    .fixedSize()
                    .help("Read another copy")
                }
                Button("Try…", action: onTry)
                    .controlSize(.small)
                    .help("Start a session that shows what this skill does")
                if let location {
                    ReaderIconButton(symbol: "folder", help: "Reveal in Finder") {
                        libraryOpen(stateStore, location.path, reveal: true) { linkFailure = $0 }
                    }
                }
            }
            if let location {
                // Commands share their folder with every other command, so their tree opens on their own file.
                WorkspaceFilesView(root: location.folder, rowID: "", changed: ConchFileChanges(changed: [], relativeTo: ""),
                                   focus: [location.file])
                    .id(location.id)
            }
        }
        .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
    }

    private func subtitle(_ location: SkillLocationInfo) -> String {
        [SkillsLibrary.locationTitle(location), location.invocation, (location.path as NSString).abbreviatingWithTildeInPath]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

/// A skill from an index: fetched to this Mac when picked (the daemon's `open`), then shown as one of Tyler's is.
private struct DiscoverSkillReader: View {
    let entry: DiscoverSkillInfo
    @ObservedObject var store: SkillsLibraryStore
    @Binding var isWide: Bool
    let onAdd: () -> Void
    let onTry: () -> Void
    @State private var folder: String?
    @State private var failure: String?
    @EnvironmentObject private var stateStore: StateStore
    @State private var linkFailure: String?

    var body: some View {
        VStack(spacing: 0) {
            ReaderBar(title: entry.name, subtitle: SkillsLibrary.discoverDetail(entry, indexes: store.indexes), isWide: $isWide) {
                Button("Add…", action: onAdd)
                    .controlSize(.small)
                    .disabled(entry.needsPlugin == true)
                    .help(entry.needsPlugin == true ? "It runs from its plugin's own folder: install the plugin in Plugins & MCP" : "Copy it into one of your accounts")
                Button("Try…", action: onTry)
                    .controlSize(.small)
                    .disabled(entry.needsPlugin == true)
                    .help("Start a session that shows what it does, without adding it anywhere")
                ReaderIconButton(symbol: "arrow.up.forward.app", help: "Open its page in your browser") {
                    libraryOpen(stateStore, entry.url) { linkFailure = $0 }
                }
            }
            if entry.needsPlugin == true {
                Text("This skill runs from its plugin's own folder, so it can't be copied alone. Install \(entry.plugin ?? "its plugin") in Settings › Plugins & MCP.")
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .padding(.horizontal, ReaderInset.words)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let folder {
                WorkspaceFilesView(root: folder, rowID: "", changed: ConchFileChanges(changed: [], relativeTo: ""), focus: ["SKILL.md"])
            } else if let failure {
                ReaderPlaceholder(text: failure)
            } else {
                VStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text("Fetching it from \(entry.repo ?? "its index")…")
                        .font(ConchTypography.font(size: 12.5))
                        .foregroundStyle(ConchPalette.textDim)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
        .task {
            switch await store.open(entry) {
            case let .success(reply): folder = reply.folder
            case let .failure(error): failure = error.message
            }
        }
    }
}

// MARK: - Add

/// The write pass's shape for a skill (B3): pick the account, see every file and where it lands, then Add. Nothing is
/// written until Add, Add carries the preview's hash, and every refusal is the daemon's own words.
struct SkillAddSheet: View {
    let entry: DiscoverSkillInfo
    let accounts: [LibraryAccountInfo]
    @ObservedObject var store: SkillsLibraryStore
    let onDone: () -> Void
    @State private var accountKey: String
    @State private var preview: SkillAddPreviewInfo?
    @State private var message: String?
    @State private var busy = false
    @State private var added: String?

    init(entry: DiscoverSkillInfo, accounts: [LibraryAccountInfo], store: SkillsLibraryStore, onDone: @escaping () -> Void) {
        self.entry = entry
        self.accounts = accounts
        self.store = store
        self.onDone = onDone
        _accountKey = State(initialValue: accounts.first?.key ?? "claude:default")
    }

    private var account: LibraryAccountInfo? { accounts.first { $0.key == accountKey } }

    /// Fifteen of the list's lines (10.5-point monospaced, 13 tall, 3 apart) and its 10-point padding top and bottom.
    private static let fileListCap: CGFloat = 15 * 13 + 14 * 3 + 2 * 10

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Add \(entry.name)")
                .font(ConchTypography.font(size: 15, weight: .semibold))
                .foregroundStyle(ConchPalette.textPrimary)
            // The label on the menu's own baseline: centred, its 12-point words sat half a point above the menu's 13.
            HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                Text("Into")
                    .font(ConchTypography.font(size: 12))
                    .foregroundStyle(ConchPalette.textDim)
                Picker("Into", selection: $accountKey) {
                    ForEach(accounts) { account in
                        Text("\(SkillsLibrary.agentName(account.agent)) · \(account.label)").tag(account.key)
                    }
                }
                .labelsHidden()
                .fixedSize()
                .disabled(busy || added != nil)
            }
            if let preview {
                Text(preview.refusal == nil ? "These files land in \((preview.destination as NSString).abbreviatingWithTildeInPath):" : "Not added: \(preview.refusal!).")
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(preview.refusal == nil ? ConchPalette.textDim : ConchPalette.statusNeeds)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                // One line a file, its size at the right; the box as tall as the list, up to fifteen lines. The box takes
                // its height from the lines themselves (`fixedSize` over a capped frame) rather than a count times a
                // guessed line: 16.5 a line against the 16 they set left the box 4 points deeper under its last line
                // than over its first, with two files, and 10 deeper with fifteen.
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(preview.files, id: \.self) { file in
                            HStack(spacing: ConchSpace.x2) {
                                Text("+ \(file.path)")
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                    .help(file.path)
                                Spacer(minLength: ConchSpace.x2)
                                Text(SkillsLibrary.bytes(file.bytes)).foregroundStyle(ConchPalette.textFaint)
                            }
                        }
                        ForEach(preview.skipped, id: \.self) { skipped in
                            Text("  \(skipped.path): left out, \(skipped.reason)")
                                .foregroundStyle(ConchPalette.textFaint)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(ConchPalette.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                }
                .frame(maxHeight: Self.fileListCap)
                .fixedSize(horizontal: false, vertical: true)
                .background(ConchPalette.raised, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ConchPalette.divider, lineWidth: 1))
                Text("\(preview.files.count) files, \(SkillsLibrary.bytes(preview.totalBytes)). Applies to the next session; a running session is untouched.")
                    .font(ConchTypography.font(size: 10.5))
                    .foregroundStyle(ConchPalette.statusWaiting)
            } else if message == nil {
                LibraryStatus(spinning: true, text: "Fetching it and reading its files…")
            }
            if let message {
                Text(message)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(added == nil ? ConchPalette.statusNeeds : ConchPalette.textDim)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(added == nil ? "Cancel" : "Done", role: .cancel, action: onDone)
                    .keyboardShortcut(.cancelAction)
                Button("Add") { add() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(preview == nil || preview?.refusal != nil || busy || added != nil)
            }
        }
        .padding(16)
        .frame(width: 560)
        .background(ConchPalette.bg)
        .task(id: accountKey) { await loadPreview() }
    }

    private func loadPreview() async {
        guard let account, added == nil else { return }
        preview = nil
        message = nil
        switch await store.preview(entry, agent: account.agent, accountId: account.id) {
        case let .success(reply): preview = reply.preview
        case let .failure(error): message = error.message
        }
    }

    private func add() {
        guard let preview else { return }
        busy = true
        Task { @MainActor in
            switch await store.add(entry, preview: preview) {
            case let .success(reply):
                added = reply.added
                message = "Added to \((reply.added as NSString).abbreviatingWithTildeInPath). Start a new session to use it."
            case let .failure(error):
                message = error.message
            }
            busy = false
        }
    }
}

// MARK: - Try

/// Try: where the session runs (the account a copy is in, or any account for a skill from an index), the first message
/// it gets, and Start. The trial folder is the daemon's (`trial`); the start is the New session sheet's own.
struct SkillTrySheet: View {
    let target: SkillTryTarget
    let accounts: [LibraryAccountInfo]
    @ObservedObject var store: SkillsLibraryStore
    let onDone: () -> Void
    @EnvironmentObject private var stateStore: StateStore
    @AppStorage("conch.session.host") private var host = "terminal"
    @State private var choice: String
    @State private var message: String?
    @State private var busy = false
    /// The folder the agent asked to be trusted, waiting on Tyler's yes.
    @State private var pendingTrust: (trial: SkillTrialReply, cwd: String)?

    init(target: SkillTryTarget, accounts: [LibraryAccountInfo], store: SkillsLibraryStore, onDone: @escaping () -> Void) {
        self.target = target
        self.accounts = accounts
        self.store = store
        self.onDone = onDone
        _choice = State(initialValue: Self.choices(target, accounts).first?.id ?? "")
    }

    struct Choice: Identifiable {
        let id: String
        let title: String
        let request: SkillsLibraryRequest
    }

    /// An installed skill runs where a copy of it is; one from an index, in any account of either agent.
    static func choices(_ target: SkillTryTarget, _ accounts: [LibraryAccountInfo]) -> [Choice] {
        switch target {
        case let .installed(skill):
            return skill.locations.flatMap { location -> [Choice] in
                if location.accountId != nil {
                    return [Choice(id: location.id, title: SkillsLibrary.locationTitle(location) + (location.enabled == false ? " (off there)" : ""),
                                   request: .trial(location: location, accountId: nil))]
                }
                // A project's or `~/.agents`' copy: every account of its agent loads it.
                return accounts.filter { $0.agent == location.agent }.map { account in
                    Choice(id: "\(location.id)|\(account.id)", title: "\(SkillsLibrary.locationTitle(location)) as \(account.label)",
                           request: .trial(location: location, accountId: account.id))
                }
            }
        case let .discovered(entry):
            return accounts.map { account in
                Choice(id: account.key, title: "\(SkillsLibrary.agentName(account.agent)) · \(account.label)",
                       request: .trial(entryId: entry.id, agent: account.agent, accountId: account.id))
            }
        }
    }

    private var options: [Choice] { Self.choices(target, accounts) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Try \(target.name)")
                .font(ConchTypography.font(size: 15, weight: .semibold))
                .foregroundStyle(ConchPalette.textPrimary)
            Text(explanation)
                .font(ConchTypography.font(size: 11.5))
                .foregroundStyle(ConchPalette.textDim)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: ConchSpace.x2) {
                // The label on its menu's baseline, as Add's "Into" is. Only the pair: with the segmented control in the
                // same baseline row the row came out half a point taller than its controls, and the sheet with it.
                HStack(alignment: .firstTextBaseline, spacing: ConchSpace.x2) {
                    Text("In")
                        .font(ConchTypography.font(size: 12))
                        .foregroundStyle(ConchPalette.textDim)
                    Picker("In", selection: $choice) {
                        ForEach(options) { Text($0.title).tag($0.id) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                Spacer(minLength: ConchSpace.x2)
                Picker("", selection: $host) {
                    Text("Terminal").tag("terminal")
                    Text("Background").tag("background")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 180)
                .disabled(stateStore.state?.features?.sessionHosts != 1)
            }
            .disabled(busy || pendingTrust != nil)
            if let pendingTrust {
                Text("\(agentName(pendingTrust.trial.agent)) asks whether you trust \((pendingTrust.cwd as NSString).abbreviatingWithTildeInPath) before it starts there. conch made the folder for this trial.")
                    .font(ConchTypography.font(size: 11.5))
                    .foregroundStyle(ConchPalette.statusWaiting)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let message {
                Text(message)
                    .font(ConchTypography.font(size: 11))
                    .foregroundStyle(ConchPalette.statusNeeds)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel, action: onDone)
                    .keyboardShortcut(.cancelAction)
                Button(pendingTrust == nil ? "Start session" : "Trust and start") { start() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || options.isEmpty)
            }
        }
        .padding(16)
        .frame(width: 560)
        .background(ConchPalette.bg)
    }

    private var explanation: String {
        switch target {
        case .installed:
            "conch starts a new session where this skill is installed and asks it to show what the skill does on a small example. A skill from a project runs in that project; any other runs in a new folder of its own, so whatever it makes stays there."
        case .discovered:
            "conch puts this skill in a new folder of its own, as that folder's skill, and starts a session there that shows what it does. Nothing is added to your accounts."
        }
    }

    private func agentName(_ agent: String) -> String { agent == "codex" ? "Codex" : "Claude Code" }

    private func start() {
        guard let picked = options.first(where: { $0.id == choice }) else { return }
        busy = true
        message = nil
        Task { @MainActor in
            defer { busy = false }
            let trial: SkillTrialReply
            if let pending = pendingTrust {
                trial = pending.trial
            } else {
                switch await store.trial(picked.request) {
                case let .success(reply): trial = reply
                case let .failure(error):
                    message = error.message
                    return
                }
            }
            let before = Set((stateStore.state?.rows ?? []).map(\.id))
            let outcome = await stateStore.startSession(
                backend: trial.agent == "codex" ? .codex : .claude,
                host: stateStore.state?.features?.sessionHosts == 1 ? host : "terminal",
                resumeSessionId: nil,
                claudeAccountId: trial.agent == "claude" ? trial.accountId : nil,
                codexAccountId: trial.agent == "codex" ? trial.accountId : nil,
                cwd: trial.cwd,
                trustFolder: pendingTrust != nil,
                prompt: trial.prompt
            )
            switch outcome {
            case let .failed(error):
                message = error
            case let .needsTrust(cwd):
                pendingTrust = (trial, cwd)
            case let .started(sessionId, _):
                onDone()
                SettingsRouter.shared.close()
                await select(sessionId: sessionId, notIn: before)
            }
        }
    }

    /// The new session, picked once it checks in: by its id when the daemon knew it, else the first row that wasn't there.
    private func select(sessionId: String?, notIn before: Set<SessionRow.ID>) async {
        for _ in 0..<60 {
            let rows = stateStore.state?.rows ?? []
            if let row = rows.first(where: { sessionId != nil ? $0.id == sessionId : !before.contains($0.id) }) {
                NotificationCenter.default.post(name: .selectSessionFromStatusItem, object: row.id)
                return
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }
}

// MARK: - Benchmarks

/// Settings › Benchmarks: the catalog this conch carries (src/benchmarks.ts, 106 indexes on 28 Oct 2026), searched,
/// narrowed by kind and domain, and laid out by kind, aggregators first. Each index's page opens in the reader beside the
/// list; the report on which evals to trust opens as `atlas_show` shows an Atlas page, from its Markdown copy on this Mac.
struct ConchBenchmarksSettingsView: View {
    @State private var catalog: BenchmarkCatalogInfo?
    @State private var all: [BenchmarkIndexInfo] = []
    @State private var reportCopy: String?
    @State private var failure: String?
    @State private var query = ""
    @State private var kind: String?
    @State private var domain: String?
    @State private var picked: BenchmarkIndexInfo.ID?
    @State private var showsReport = false
    @State private var readerWide = false
    @State private var compact = false
    @EnvironmentObject private var stateStore: StateStore
    @State private var linkFailure: String?
    @AppStorage(PaneSplit.library.key) private var listWidth = Double(PaneSplit.library.standard)

    private var indexes: [BenchmarkIndexInfo] {
        SkillsLibrary.filterBenchmarks(all, kind: kind, domain: domain, query: query)
    }

    var body: some View {
        GeometryReader { proxy in
            Group {
                if readerWide {
                    reader
                } else if compact {
                    listColumn
                } else {
                    ConchSplitView(split: .library, width: $listWidth, label: "Resize the benchmarks list") {
                        listColumn
                    } trailing: {
                        reader
                    }
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
            .clipped()
            .environment(\.libraryCompact, compact)
            .onChange(of: proxy.size.width, initial: true) { _, width in compact = LibraryLayout.isCompact(width: width) }
        }
        .background(ConchPalette.bg)
        .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
        .task { await load() }
    }

    private var listColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Skills' header: every section's gap under the subtitle, the controls 12 apart under it.
            VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                SettingsSectionHeader(title: "Benchmarks", subtitle: subtitle) { EmptyView() }
                VStack(alignment: .leading, spacing: ConchSpace.x3) {
                    LibrarySearchField(text: $query, prompt: "Search benchmarks")
                    BenchmarkFilters(kinds: SkillsLibrary.benchmarkKinds.filter { kind in all.contains { $0.kind == kind } },
                                     domains: SkillsLibrary.benchmarkDomains(all), kind: $kind, domain: $domain)
                }
            }
            .padding([.top, .horizontal], SettingsLayout.inset)
            .padding(.bottom, ConchSpace.x3)

            Rectangle().fill(ConchPalette.divider).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: SettingsLayout.headerGap) {
                    if let failure {
                        LibraryStatus(text: failure, isProblem: true)
                    } else if catalog == nil {
                        LibraryStatus(spinning: true, text: "Reading the catalog…")
                    } else {
                        if let report = catalog?.report { reportCard(report) }
                        if indexes.count != all.count {
                            LibraryStatus(text: indexes.isEmpty ? "Nothing in the catalog matches." : "\(indexes.count) of \(all.count) match.")
                        }
                        ForEach(SkillsLibrary.benchmarkGroups(indexes)) { group in
                            // Skills' groups, and Logins': 12 under the subheading, a 13-point mark.
                            VStack(alignment: .leading, spacing: ConchSpace.x3) {
                                SettingsSubheading(title: "\(group.title) · \(group.indexes.count)") {
                                    Image(systemName: group.symbol).font(.system(size: 13, weight: .regular))
                                }
                                OnboardingCard {
                                    ForEach(Array(group.indexes.enumerated()), id: \.element.id) { offset, index in
                                        if offset > 0 { SettingsHairline() }
                                        BenchmarkRow(index: index, isSelected: !showsReport && (compact ? picked : currentID) == index.id) {
                                            picked = index.id
                                            showsReport = false
                                            if compact { readerWide = true }
                                        }
                                        .contextMenu {
                                            Button("Open in Browser") { libraryOpen(stateStore, index.url) { linkFailure = $0 } }
                                            Button("Copy Link") {
                                                NSPasteboard.general.clearContents()
                                                NSPasteboard.general.setString(index.url, forType: .string)
                                            }
                                        }
                                    }
                                }
                                .clipShape(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous))
                            }
                        }
                    }
                }
                .font(ConchTypography.font(size: 12))
                .padding(SettingsLayout.inset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(ConchPalette.bg)
    }

    private var subtitle: String {
        guard let catalog else { return "Indexes and leaderboards for judging models and agents." }
        return "Indexes and leaderboards for judging models and agents: \(all.count) of them, researched \(catalog.updatedAt)."
    }

    private var currentID: BenchmarkIndexInfo.ID? { picked ?? indexes.first?.id }

    private func reportCard(_ report: BenchmarkCatalogInfo.Report) -> some View {
        Button {
            showsReport = true
            if compact { readerWide = true }
        } label: {
            HStack(alignment: .center, spacing: ConchSpace.x3) {
                Image(systemName: "doc.text")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(ConchPalette.textDim)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(report.title)
                        .font(ConchTypography.font(size: 12.5, weight: .medium))
                        .foregroundStyle(ConchPalette.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Atlas · \(report.atlasPath)")
                        .font(ConchTypography.font(size: 11))
                        .foregroundStyle(ConchPalette.textFaint)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(ConchPalette.textFaint)
            }
            // 16 in, as the rows under it are (`LibraryRowInset`), so its mark's column starts where their words do.
            .padding(.horizontal, ConchSpace.x4)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).fill(showsReport ? ConchPalette.selection : ConchPalette.surface))
            .overlay(RoundedRectangle(cornerRadius: ConchRadius.medium, style: .continuous).strokeBorder(ConchPalette.divider, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("The index map and the guide to which evals to trust")
    }

    @ViewBuilder
    private var reader: some View {
        Group {
            if showsReport, let report = catalog?.report {
                VStack(spacing: 0) {
                    ReaderBar(title: report.title, subtitle: "Atlas · \(report.atlasPath)", isWide: $readerWide) { EmptyView() }
                    if let reportCopy {
                        // As `atlas_show` files a page: its Markdown copy, read by the deliverables pane's renderer.
                        WorkspaceFilesView(root: (reportCopy as NSString).deletingLastPathComponent, rowID: "",
                                           changed: ConchFileChanges(changed: [], relativeTo: ""), focus: [(reportCopy as NSString).lastPathComponent])
                    } else {
                        ReaderPlaceholder(text: "No copy of this Atlas page is on this Mac yet. Atlas has no web view of a page: an agent shows it with atlas_show, which keeps its Markdown in ~/Documents/conch-notes/atlas.")
                    }
                }
            } else if let index = indexes.first(where: { $0.id == currentID }) {
                BenchmarkReader(index: index, isWide: $readerWide).id(index.id)
            } else {
                ReaderPlaceholder(text: "Pick a benchmark to open its page here.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ConchPalette.surface)
    }

    /// Every page of the catalog, in turn.
    private func load() async {
        var offset = 0
        var collected: [BenchmarkIndexInfo] = []
        while true {
            switch await ConchSocketClient().request(BenchmarksRequestInfo(offset: offset), timeout: 5) {
            case .connectFailed:
                failure = "conch's daemon isn't running, so the catalog can't be read. Turn it on in General."
                return
            case .timeout:
                failure = "The daemon took too long to answer. Try again."
                return
            case let .reply(data):
                guard let page = try? JSONDecoder().decode(BenchmarksReplyInfo.self, from: data), page.kind == "benchmarks" else {
                    failure = (try? JSONDecoder().decode(SkillsLibraryRefusal.self, from: data))?.error.map { error in
                        error.contains("unknown runtime control message kind") ? "Needs an updated conch daemon" : error
                    } ?? "The daemon answered in a way this app doesn't know."
                    return
                }
                collected += page.catalog.indexes
                if offset == 0 {
                    catalog = page.catalog
                    reportCopy = page.reportCopy
                }
                guard let next = page.next, next > offset else {
                    all = collected
                    failure = nil
                    return
                }
                offset = next
            }
        }
    }
}

/// Kind and domain, each a menu: all of them, or one.
private struct BenchmarkFilters: View {
    let kinds: [String]
    let domains: [String]
    @Binding var kind: String?
    @Binding var domain: String?

    var body: some View {
        HStack(spacing: ConchSpace.x2) {
            Picker("", selection: $kind) {
                Text("Every kind").tag(String?.none)
                ForEach(kinds, id: \.self) { Text(SkillsLibrary.benchmarkKindTitle($0)).tag(String?.some($0)) }
            }
            .labelsHidden()
            .fixedSize()
            Picker("", selection: $domain) {
                Text("Every domain").tag(String?.none)
                ForEach(domains, id: \.self) { Text($0).tag(String?.some($0)) }
            }
            .labelsHidden()
            .fixedSize()
            Spacer(minLength: 0)
        }
    }
}

/// A benchmark's page, in the deliverables pane's web view under its origin line, with the way out to the browser.
private struct BenchmarkReader: View {
    let index: BenchmarkIndexInfo
    @Binding var isWide: Bool
    @State private var isLoading = false
    @State private var current: String?
    @State private var failure: DeliverableNavigationFailure?
    @State private var reload = UUID()
    @EnvironmentObject private var stateStore: StateStore
    @State private var linkFailure: String?

    var body: some View {
        VStack(spacing: 0) {
            ReaderBar(title: index.name, subtitle: origin, isWide: $isWide) {
                if isLoading { ProgressView().controlSize(.small) }
                ReaderIconButton(symbol: "arrow.clockwise", help: "Load the page again") { reload = UUID() }
                ReaderIconButton(symbol: "arrow.up.forward.app", help: "Open in your browser") {
                    libraryOpen(stateStore, current ?? index.url) { linkFailure = $0 }
                }
            }
            ZStack {
                DeliverableWebView(link: index.url, reloadID: reload, isLoading: $isLoading, currentLink: $current) { failure = $0 }
                if let failure {
                    VStack(spacing: 8) {
                        Text(failure.title).font(ConchTypography.font(size: 13, weight: .medium)).foregroundStyle(ConchPalette.textPrimary)
                        Text(failure.message).font(ConchTypography.font(size: 11.5)).foregroundStyle(ConchPalette.textDim)
                            .multilineTextAlignment(.center).frame(maxWidth: 320)
                        Button("Open in Browser") { libraryOpen(stateStore, index.url) { linkFailure = $0 } }
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(ConchPalette.surface)
                }
            }
        }
        .overlay(alignment: .bottom) { LinkFailureLine(message: $linkFailure) }
    }

    /// Scheme and host, as the deliverables pane's origin line names a page, so a third party's page can't pass as conch's.
    private var origin: String {
        guard let url = URL(string: current ?? index.url), let host = url.host else { return index.url }
        return "\(url.scheme ?? "https")://\(host)"
    }
}

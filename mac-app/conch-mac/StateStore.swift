import AppKit
import Combine
import Foundation

enum DaemonLiveness: Equatable, Sendable {
    case checking
    case alive
    case dead
    case stalled
}

struct SessionDismissUndo: Equatable, Sendable {
    let id: String
    let label: String
}

@MainActor
final class StateStore: ObservableObject {
    @Published private(set) var state: PublishedState?
    @Published private(set) var daemonMessage: String?
    @Published private(set) var liveness = DaemonLiveness.checking
    @Published private(set) var isLedgerFrozen = false
    @Published private(set) var rowMessages: [String: String] = [:]
    @Published private(set) var undoDismissal: SessionDismissUndo?
    @Published private(set) var newerDaemonWarningVisible = false
    @Published private(set) var isLogDrawerOpen = false
    @Published private(set) var logLines: [String] = []

    private static let snapshotFreshness: TimeInterval = 45
    private static let failedProbeSpacing: TimeInterval = 2
    private static let stuckMicAge: TimeInterval = 30
    private static let undoLifetimeNanoseconds: UInt64 = 6_000_000_000

    private let reader: StateSnapshotReader
    private let socketClient: ConchSocketClient
    private var sourceState: PublishedState?
    private var pollingTask: Task<Void, Never>?
    private var deliveryTask: Task<Void, Never>?
    private var probeTask: Task<Void, Never>?
    private var sessionCommandTask: Task<Void, Never>?
    private var undoTask: Task<Void, Never>?
    private var controlSequence = 0

    private var labelOverrides: [SessionRow.ID: LabelOverride] = [:]
    private var optimisticDismissals: [SessionRow.ID: DismissalOverlay] = [:]
    private var optimisticRestores: [SessionRow.ID: RestoreOverlay] = [:]
    private var commandGenerations: [SessionRow.ID: Int] = [:]
    private var latestEnqueuedCommands: [SessionRow.ID: EnqueuedSessionCommand] = [:]
    private var dismissCompletions: [SessionRow.ID: DismissCommandCompletion] = [:]
    private var transportErrorSessionIDs: Set<SessionRow.ID> = []
    private var dockBadgeCount = 0
    private var undoGeneration = 0
    private var dismissedNewerDaemonVersion: Int?

    private var lastConfirmedAliveAt: Date?
    private var lastProbeAttemptAt: Date?
    private var probeFailure: ProbeFailure?

    init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        let snapshotURL = Self.fileURL(
            environment["CONCH_STATE_FILE"],
            defaultPath: "/tmp/conch-sessions.json"
        )
        let logURL = Self.fileURL(
            environment["CONCH_LOG_FILE"],
            defaultPath: "/tmp/conch-daemon.log"
        )
        let reader = StateSnapshotReader(
            snapshotURL: snapshotURL,
            logURL: logURL
        )
        self.reader = reader
        socketClient = ConchSocketClient(environment: environment)

        pollingTask = Task { @MainActor [weak self, reader] in
            while !Task.isCancelled {
                guard let self else { return }
                let result = await reader.read(includeLog: isLogDrawerOpen)
                if let snapshot = result.snapshot {
                    accept(snapshot)
                }
                if !result.logLines.isEmpty {
                    appendLogLines(result.logLines)
                }
                evaluateLiveness()

                do {
                    try await Task.sleep(nanoseconds: 250_000_000)
                } catch {
                    return
                }
            }
        }
    }

    deinit {
        pollingTask?.cancel()
        deliveryTask?.cancel()
        probeTask?.cancel()
        sessionCommandTask?.cancel()
        undoTask?.cancel()
    }

    func send(_ event: ConchDaemonEvent) {
        controlSequence &+= 1
        let sequence = controlSequence
        let socketClient = socketClient
        let previousDelivery = deliveryTask

        deliveryTask = Task { @MainActor [weak self] in
            await previousDelivery?.value
            guard !Task.isCancelled else { return }
            let delivered = await socketClient.send(event)
            guard let self, controlSequence == sequence else { return }
            if !delivered {
                forceLivenessProbe()
            }
        }
    }

    func forceLivenessProbe() {
        scheduleProbe(force: true)
    }

    func dismissNewerDaemonWarning() {
        guard let version = sourceState?.v, version > PublishedState.knownVersion else {
            return
        }
        dismissedNewerDaemonVersion = version
        updateNewerDaemonWarning()
    }

    func toggleLogDrawer() {
        isLogDrawerOpen.toggle()
    }

    func renameSession(id: SessionRow.ID, label: String) {
        rowMessages[id] = nil
        transportErrorSessionIDs.remove(id)
        enqueueSessionCommand(
            id: id,
            command: .rename,
            label: label,
            fallbackDismissedRow: nil
        )
    }

    func dismissSession(_ row: SessionRow) {
        rowMessages[row.id] = nil
        transportErrorSessionIDs.remove(row.id)
        let dismissedRow = DismissedSessionRow(id: row.id, label: row.label)
        let context = enqueueSessionCommand(
            id: row.id,
            command: .dismiss,
            label: nil,
            fallbackDismissedRow: dismissedRow
        )
        optimisticRestores[row.id] = nil
        optimisticDismissals[row.id] = DismissalOverlay(
            row: dismissedRow,
            generation: context.generation,
            baselineTimestamp: context.baselineTimestamp
        )
        showUndo(for: row.id, label: row.label)
        rebuildPresentedState()
    }

    func restoreSession(id: SessionRow.ID, label: String) {
        let fallback = optimisticDismissals[id]?.row
            ?? state?.dismissedRows.first(where: { $0.id == id })
            ?? DismissedSessionRow(id: id, label: label)

        rowMessages[id] = nil
        transportErrorSessionIDs.remove(id)
        let context = enqueueSessionCommand(
            id: id,
            command: .restore,
            label: nil,
            fallbackDismissedRow: fallback
        )
        optimisticDismissals[id] = nil
        optimisticRestores[id] = RestoreOverlay(
            generation: context.generation,
            baselineTimestamp: context.baselineTimestamp
        )
        if undoDismissal?.id == id {
            clearUndo()
        }
        rebuildPresentedState()
    }

    func undoLastDismissal() {
        guard let undoDismissal else { return }
        restoreSession(id: undoDismissal.id, label: undoDismissal.label)
    }

    @discardableResult
    private func enqueueSessionCommand(
        id: SessionRow.ID,
        command: ConchSessionCommand,
        label: String?,
        fallbackDismissedRow: DismissedSessionRow?
    ) -> SessionCommandContext {
        let generation = (commandGenerations[id] ?? 0) &+ 1
        commandGenerations[id] = generation
        let previousEnqueuedCommand = latestEnqueuedCommands[id]

        let request = ConchSessionCommandRequest(
            sessionId: id,
            command: command,
            label: label
        )
        let context = SessionCommandContext(
            id: id,
            command: command,
            generation: generation,
            fallbackDismissedRow: fallbackDismissedRow,
            baselineTimestamp: sourceState?.ts,
            predecessorDismissGeneration: command == .restore
                && previousEnqueuedCommand?.command == .dismiss
                ? previousEnqueuedCommand?.generation
                : nil
        )
        latestEnqueuedCommands[id] = EnqueuedSessionCommand(
            generation: generation,
            command: command
        )
        let socketClient = socketClient
        let previousCommand = sessionCommandTask

        sessionCommandTask = Task { @MainActor [weak self] in
            await previousCommand?.value
            guard !Task.isCancelled else { return }
            let outcome = await socketClient.request(request)
            guard let self else { return }
            finishSessionCommand(context, outcome: outcome)
        }
        return context
    }

    private func finishSessionCommand(
        _ context: SessionCommandContext,
        outcome: ConchSocketRequestOutcome
    ) {
        let isLatest = commandGenerations[context.id] == context.generation

        switch outcome {
        case let .reply(data):
            if isLatest {
                transportErrorSessionIDs.remove(context.id)
            }
            guard let reply = try? JSONDecoder().decode(
                ConchSessionCommandReply.self,
                from: data
            ) else {
                recordCompletion(.failed, for: context)
                failSessionCommand(
                    context,
                    message: "invalid reply from daemon",
                    isLatest: isLatest
                )
                return
            }

            switch reply {
            case let .acknowledgement(acknowledgement):
                guard acknowledgement.sessionId == context.id,
                      acknowledgement.command == context.command.rawValue else {
                    recordCompletion(.failed, for: context)
                    failSessionCommand(
                        context,
                        message: "unexpected reply from daemon",
                        isLatest: isLatest
                    )
                    return
                }
                if context.command == .rename, acknowledgement.label == nil {
                    recordCompletion(.failed, for: context)
                    failSessionCommand(
                        context,
                        message: "invalid reply from daemon",
                        isLatest: isLatest
                    )
                    return
                }
                recordCompletion(
                    .acknowledged(label: acknowledgement.label),
                    for: context
                )
                applyAcknowledgement(
                    acknowledgement,
                    context: context,
                    isLatest: isLatest
                )
            case let .error(error):
                let message = error.error.trimmingCharacters(in: .whitespacesAndNewlines)
                recordCompletion(.failed, for: context)
                failSessionCommand(
                    context,
                    message: message.isEmpty ? "session command failed" : message,
                    isLatest: isLatest
                )
            case .unknown:
                recordCompletion(.failed, for: context)
                failSessionCommand(
                    context,
                    message: "unexpected reply from daemon",
                    isLatest: isLatest
                )
            }
        case .connectFailed:
            recordCompletion(.failed, for: context)
            if isLatest {
                transportErrorSessionIDs.insert(context.id)
            }
            failSessionCommand(
                context,
                message: "daemon not running",
                isLatest: isLatest
            )
            forceLivenessProbe()
        case .timeout:
            recordCompletion(.failed, for: context)
            if isLatest {
                transportErrorSessionIDs.insert(context.id)
            }
            failSessionCommand(
                context,
                message: "daemon did not reply",
                isLatest: isLatest
            )
            forceLivenessProbe()
        }
    }

    private func applyAcknowledgement(
        _ acknowledgement: ConchSessionAcknowledgement,
        context: SessionCommandContext,
        isLatest: Bool
    ) {
        guard isLatest else { return }
        transportErrorSessionIDs.remove(context.id)

        switch context.command {
        case .rename:
            guard let canonicalLabel = acknowledgement.label else { return }
            labelOverrides[context.id] = LabelOverride(
                label: canonicalLabel,
                generation: context.generation,
                baselineTimestamp: sourceState?.ts
            )
        case .dismiss:
            var overlay = optimisticDismissals[context.id]
                ?? DismissalOverlay(
                    row: context.fallbackDismissedRow
                        ?? DismissedSessionRow(id: context.id, label: context.id),
                    generation: context.generation,
                    baselineTimestamp: sourceState?.ts
                )
            guard overlay.generation == context.generation else { break }
            if let canonicalLabel = acknowledgement.label {
                overlay.row = DismissedSessionRow(
                    id: context.id,
                    label: canonicalLabel
                )
                if undoDismissal?.id == context.id {
                    showUndo(for: context.id, label: canonicalLabel)
                }
            }
            overlay.baselineTimestamp = sourceState?.ts
            optimisticDismissals[context.id] = overlay
        case .restore:
            var overlay = optimisticRestores[context.id]
                ?? RestoreOverlay(
                    generation: context.generation,
                    baselineTimestamp: sourceState?.ts
                )
            guard overlay.generation == context.generation else { break }
            overlay.baselineTimestamp = sourceState?.ts
            optimisticRestores[context.id] = overlay
            if let canonicalLabel = acknowledgement.label {
                labelOverrides[context.id] = LabelOverride(
                    label: canonicalLabel,
                    generation: context.generation,
                    baselineTimestamp: sourceState?.ts
                )
            }
        }

        rowMessages[context.id] = nil
        rebuildPresentedState()
    }

    private func failSessionCommand(
        _ context: SessionCommandContext,
        message: String,
        isLatest: Bool
    ) {
        rowMessages[context.id] = message
        guard isLatest else { return }

        switch context.command {
        case .rename:
            break
        case .dismiss:
            if optimisticDismissals[context.id]?.generation == context.generation {
                optimisticDismissals[context.id] = nil
            }
            if undoDismissal?.id == context.id {
                clearUndo()
            }
        case .restore:
            if optimisticRestores[context.id]?.generation == context.generation {
                optimisticRestores[context.id] = nil
            }
            if shouldRestoreDismissalFallback(for: context),
               var fallback = context.fallbackDismissedRow {
                if let predecessor = context.predecessorDismissGeneration,
                   let completion = dismissCompletions[context.id],
                   completion.generation == predecessor,
                   case let .acknowledged(canonicalLabel) = completion.result,
                   let canonicalLabel {
                    fallback = DismissedSessionRow(
                        id: fallback.id,
                        label: canonicalLabel
                    )
                }
                optimisticDismissals[context.id] = DismissalOverlay(
                    row: fallback,
                    generation: context.generation,
                    baselineTimestamp: context.baselineTimestamp
                )
            }
        }

        rebuildPresentedState()
    }

    private func recordCompletion(
        _ completion: SessionCommandCompletion,
        for context: SessionCommandContext
    ) {
        guard context.command == .dismiss else { return }
        dismissCompletions[context.id] = DismissCommandCompletion(
            generation: context.generation,
            result: completion
        )
    }

    private func shouldRestoreDismissalFallback(
        for context: SessionCommandContext
    ) -> Bool {
        guard !snapshotAdvanced(
            sourceState?.ts,
            beyond: context.baselineTimestamp
        ), !sourceShowsDismissed(context.id),
              let predecessor = context.predecessorDismissGeneration,
              let completion = dismissCompletions[context.id],
              completion.generation == predecessor,
              case .acknowledged = completion.result else {
            return false
        }
        return true
    }

    private func showUndo(for id: SessionRow.ID, label: String) {
        undoGeneration &+= 1
        let generation = undoGeneration
        undoDismissal = SessionDismissUndo(id: id, label: label)
        undoTask?.cancel()
        undoTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(nanoseconds: Self.undoLifetimeNanoseconds)
            } catch {
                return
            }
            guard let self, undoGeneration == generation else { return }
            undoDismissal = nil
        }
    }

    private func clearUndo() {
        undoGeneration &+= 1
        undoTask?.cancel()
        undoTask = nil
        undoDismissal = nil
    }

    private func accept(_ snapshot: PublishedState) {
        let previousTimestamp = sourceState?.ts
        let timestampAdvanced = previousTimestamp == nil || snapshot.ts > (previousTimestamp ?? 0)
        sourceState = snapshot
        reconcilePresentationOverlays(with: snapshot)
        rebuildPresentedState()
        updateNewerDaemonWarning()

        let now = Date()
        if timestampAdvanced, snapshotAge(at: now) < Self.snapshotFreshness {
            markAlive(at: now, resetsBaseline: false)
        } else {
            refreshLivenessPresentation(at: now)
        }
    }

    private func reconcilePresentationOverlays(with snapshot: PublishedState) {
        let completedLabelIDs = labelOverrides.compactMap { id, overlay in
            snapshotAdvanced(snapshot.ts, beyond: overlay.baselineTimestamp) ? id : nil
        }
        for id in completedLabelIDs {
            labelOverrides[id] = nil
        }

        let completedDismissalIDs = optimisticDismissals.compactMap { id, overlay in
            snapshotAdvanced(snapshot.ts, beyond: overlay.baselineTimestamp)
                ? id
                : nil
        }
        for id in completedDismissalIDs {
            optimisticDismissals[id] = nil
        }

        let completedRestoreIDs = optimisticRestores.compactMap { id, overlay in
            snapshotAdvanced(snapshot.ts, beyond: overlay.baselineTimestamp)
                ? id
                : nil
        }
        for id in completedRestoreIDs {
            optimisticRestores[id] = nil
        }
    }

    private func rebuildPresentedState() {
        guard let sourceState else {
            state = nil
            return
        }

        let hiddenIDs = Set(optimisticDismissals.keys)
        var seenActiveIDs: Set<SessionRow.ID> = []
        let rows = sourceState.rows.compactMap { row -> SessionRow? in
            guard seenActiveIDs.insert(row.id).inserted else { return nil }
            guard !hiddenIDs.contains(row.id) else { return nil }
            guard let override = labelOverrides[row.id]?.label,
                  override != row.label else {
                return row
            }
            return row.replacingLabel(with: override)
        }

        let activeIDs = Set(rows.map(\.id))
        var dismissedRows: [DismissedSessionRow] = []
        var seenDismissedIDs: Set<SessionRow.ID> = []

        for row in sourceState.dismissedRows {
            guard optimisticRestores[row.id] == nil,
                  !activeIDs.contains(row.id),
                  seenDismissedIDs.insert(row.id).inserted else {
                continue
            }
            let label = labelOverrides[row.id]?.label ?? row.label
            dismissedRows.append(DismissedSessionRow(id: row.id, label: label))
        }
        for id in sourceState.dismissed {
            guard optimisticRestores[id] == nil,
                  !activeIDs.contains(id),
                  seenDismissedIDs.insert(id).inserted else {
                continue
            }
            dismissedRows.append(
                DismissedSessionRow(id: id, label: labelOverrides[id]?.label ?? id)
            )
        }
        for overlay in optimisticDismissals.values {
            let row = overlay.row
            guard optimisticRestores[row.id] == nil,
                  !activeIDs.contains(row.id),
                  seenDismissedIDs.insert(row.id).inserted else {
                continue
            }
            let label = labelOverrides[row.id]?.label ?? row.label
            dismissedRows.append(DismissedSessionRow(id: row.id, label: label))
        }

        let next = PublishedState(
            v: sourceState.v,
            ts: sourceState.ts,
            mode: sourceState.mode,
            live: sourceState.live,
            reply: sourceState.reply,
            preview: sourceState.preview,
            rows: rows,
            dismissed: sourceState.dismissed,
            dismissedRows: dismissedRows
        )
        if next != state {
            state = next
            updateDockBadge(for: next.rows)
        }
    }

    private func updateDockBadge(for rows: [SessionRow]) {
        let nextCount = rows.count { row in
            row.status == .needs || row.status == .review
        }
        guard nextCount != dockBadgeCount else { return }

        dockBadgeCount = nextCount
        NSApp.dockTile.badgeLabel = nextCount == 0 ? nil : String(nextCount)
    }

    private func updateNewerDaemonWarning() {
        guard let sourceState, sourceState.newerDaemon else {
            newerDaemonWarningVisible = false
            return
        }
        newerDaemonWarningVisible = dismissedNewerDaemonVersion != sourceState.v
    }

    private func evaluateLiveness(at now: Date = Date()) {
        refreshLivenessPresentation(at: now)
        guard probeTask == nil else { return }

        if probeFailure != nil {
            guard canAttemptProbe(at: now) else { return }
            scheduleProbe(force: false, now: now)
            return
        }

        guard effectiveSnapshotAge(at: now) >= Self.snapshotFreshness,
              canAttemptProbe(at: now) else {
            return
        }
        scheduleProbe(force: false, now: now)
    }

    private func scheduleProbe(force: Bool, now: Date = Date()) {
        guard probeTask == nil else { return }
        if !force {
            let needsConfirmation = probeFailure != nil
            guard needsConfirmation || effectiveSnapshotAge(at: now) >= Self.snapshotFreshness,
                  canAttemptProbe(at: now) else {
                return
            }
        }

        lastProbeAttemptAt = now
        let socketClient = socketClient
        let sourceTimestampAtStart = sourceState?.ts
        probeTask = Task { @MainActor [weak self] in
            let outcome = await socketClient.request(ConchGetConfigRequest())
            guard let self else { return }
            probeTask = nil
            handleProbeOutcome(
                outcome,
                sourceTimestampAtStart: sourceTimestampAtStart,
                at: Date()
            )
        }
    }

    private func handleProbeOutcome(
        _ outcome: ConchSocketRequestOutcome,
        sourceTimestampAtStart: TimeInterval?,
        at now: Date
    ) {
        switch outcome {
        case let .reply(data):
            guard Self.isValidJSONReply(data) else {
                registerProbeFailureUnlessSuperseded(
                    .stalled,
                    sourceTimestampAtStart: sourceTimestampAtStart,
                    at: now
                )
                return
            }
            markAlive(at: now, resetsBaseline: true)
        case .connectFailed:
            registerProbeFailureUnlessSuperseded(
                .dead,
                sourceTimestampAtStart: sourceTimestampAtStart,
                at: now
            )
        case .timeout:
            registerProbeFailureUnlessSuperseded(
                .stalled,
                sourceTimestampAtStart: sourceTimestampAtStart,
                at: now
            )
        }
    }

    private func registerProbeFailureUnlessSuperseded(
        _ kind: DaemonLiveness,
        sourceTimestampAtStart: TimeInterval?,
        at now: Date
    ) {
        if snapshotAdvanced(sourceState?.ts, beyond: sourceTimestampAtStart),
           snapshotAge(at: now) < Self.snapshotFreshness {
            markAlive(at: now, resetsBaseline: false)
            return
        }
        registerProbeFailure(kind, at: now)
    }

    private func registerProbeFailure(_ kind: DaemonLiveness, at now: Date) {
        if var failure = probeFailure {
            guard now.timeIntervalSince(failure.lastAt) >= Self.failedProbeSpacing else {
                return
            }
            failure.count += 1
            failure.lastAt = now
            failure.kind = kind
            probeFailure = failure
            if failure.count >= 2 {
                liveness = kind
            }
        } else {
            probeFailure = ProbeFailure(
                lastAt: now,
                count: 1,
                kind: kind
            )
        }
        refreshLivenessPresentation(at: now)
    }

    private func markAlive(at now: Date, resetsBaseline: Bool) {
        if resetsBaseline {
            lastConfirmedAliveAt = now
        }
        probeFailure = nil
        liveness = .alive
        for id in transportErrorSessionIDs {
            rowMessages[id] = nil
        }
        transportErrorSessionIDs.removeAll()
        refreshLivenessPresentation(at: now)
    }

    private func canAttemptProbe(at now: Date) -> Bool {
        if let probeFailure {
            return now.timeIntervalSince(probeFailure.lastAt) >= Self.failedProbeSpacing
        }
        guard let lastProbeAttemptAt else { return true }
        return now.timeIntervalSince(lastProbeAttemptAt) >= Self.failedProbeSpacing
    }

    private func snapshotAge(at now: Date) -> TimeInterval {
        guard let timestamp = sourceState?.ts,
              timestamp.isFinite,
              timestamp > 0 else {
            return .infinity
        }
        return max(0, now.timeIntervalSince1970 - timestamp / 1_000)
    }

    private func effectiveSnapshotAge(at now: Date) -> TimeInterval {
        let publishedAt = sourceState.flatMap { snapshot -> Date? in
            guard snapshot.ts.isFinite, snapshot.ts > 0 else { return nil }
            return Date(timeIntervalSince1970: snapshot.ts / 1_000)
        }
        let baseline = [publishedAt, lastConfirmedAliveAt]
            .compactMap { $0 }
            .max()
        guard let baseline else { return .infinity }
        return max(0, now.timeIntervalSince(baseline))
    }

    private func refreshLivenessPresentation(at now: Date) {
        switch liveness {
        case .checking, .alive:
            daemonMessage = nil
            isLedgerFrozen = false
        case .dead:
            daemonMessage = "daemon not running"
            isLedgerFrozen = true
        case .stalled:
            let liveState = sourceState?.live.state ?? "idle"
            let micCanBeStuck = liveState == "speaking"
                || liveState == "listening"
                || liveState == "recording"
            daemonMessage = micCanBeStuck && snapshotAge(at: now) >= Self.stuckMicAge
                ? "mic stuck open · press space to stop"
                : "daemon not responding"
            isLedgerFrozen = true
        }
    }

    private static func isValidJSONReply(_ data: Data) -> Bool {
        guard !data.isEmpty,
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return false
        }
        return object is [String: Any]
    }

    private func snapshotAdvanced(
        _ timestamp: TimeInterval?,
        beyond baseline: TimeInterval?
    ) -> Bool {
        guard let timestamp, timestamp.isFinite, timestamp > 0 else {
            return false
        }
        guard let baseline, baseline.isFinite, baseline > 0 else {
            return true
        }
        return timestamp > baseline
    }

    private func sourceShowsDismissed(_ id: SessionRow.ID) -> Bool {
        guard let sourceState else { return false }
        return sourceState.dismissed.contains(id)
            || sourceState.dismissedRows.contains { $0.id == id }
    }

    private static func fileURL(_ override: String?, defaultPath: String) -> URL {
        let path = override?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return URL(
            fileURLWithPath: path.isEmpty ? defaultPath : path,
            isDirectory: false
        )
    }

    private func appendLogLines(_ lines: [String]) {
        guard !lines.isEmpty else { return }
        for line in lines {
            logRing.append(line)
        }
        logLines = logRing.values
    }

    private var logRing = FixedLineRing(capacity: 500)
}

private struct SessionCommandContext: Sendable {
    let id: SessionRow.ID
    let command: ConchSessionCommand
    let generation: Int
    let fallbackDismissedRow: DismissedSessionRow?
    let baselineTimestamp: TimeInterval?
    let predecessorDismissGeneration: Int?
}

private struct LabelOverride: Sendable {
    let label: String
    let generation: Int
    let baselineTimestamp: TimeInterval?
}

private struct DismissalOverlay: Sendable {
    var row: DismissedSessionRow
    let generation: Int
    var baselineTimestamp: TimeInterval?
}

private struct RestoreOverlay: Sendable {
    let generation: Int
    var baselineTimestamp: TimeInterval?
}

private struct EnqueuedSessionCommand: Sendable {
    let generation: Int
    let command: ConchSessionCommand
}

private struct DismissCommandCompletion: Sendable {
    let generation: Int
    let result: SessionCommandCompletion
}

private enum SessionCommandCompletion: Sendable {
    case acknowledged(label: String?)
    case failed
}

private struct ProbeFailure: Sendable {
    var lastAt: Date
    var count: Int
    var kind: DaemonLiveness
}

private struct FixedLineRing {
    private let capacity: Int
    private var storage: [String?]
    private var start = 0
    private var count = 0

    init(capacity: Int) {
        self.capacity = max(1, capacity)
        storage = Array(repeating: nil, count: max(1, capacity))
    }

    mutating func append(_ line: String) {
        if count < capacity {
            storage[(start + count) % capacity] = line
            count += 1
            return
        }
        storage[start] = line
        start = (start + 1) % capacity
    }

    var values: [String] {
        (0..<count).compactMap { storage[(start + $0) % capacity] }
    }
}

private struct StatePollResult: Sendable {
    let snapshot: PublishedState?
    let logLines: [String]
}

private actor StateSnapshotReader {
    private let snapshotURL: URL
    private var logReader: DaemonLogTailReader

    init(snapshotURL: URL, logURL: URL) {
        self.snapshotURL = snapshotURL
        logReader = DaemonLogTailReader(sourceURL: logURL)
    }

    func read(includeLog: Bool) -> StatePollResult {
        StatePollResult(
            snapshot: StateSnapshotFile.read(from: snapshotURL),
            logLines: includeLog ? logReader.readDelta() : []
        )
    }
}

private struct DaemonLogTailReader {
    private static let maximumReadSize = 64 * 1_024
    private static let maximumCarrySize = 64 * 1_024

    private let sourceURL: URL
    private var offset: UInt64?
    private var carry = Data()
    private var discardsLeadingPartialLine = false

    init(sourceURL: URL) {
        self.sourceURL = sourceURL
    }

    mutating func readDelta() -> [String] {
        guard let attributes = try? FileManager.default.attributesOfItem(
            atPath: sourceURL.path
        ),
        let rawSize = attributes[.size] as? NSNumber else {
            return []
        }

        let size = rawSize.uint64Value
        if offset == nil {
            let initialOffset = size > UInt64(Self.maximumReadSize)
                ? size - UInt64(Self.maximumReadSize)
                : 0
            offset = initialOffset
            discardsLeadingPartialLine = initialOffset > 0
        } else if size < (offset ?? 0) {
            offset = 0
            carry.removeAll(keepingCapacity: true)
            discardsLeadingPartialLine = false
        }

        guard let currentOffset = offset, size > currentOffset else { return [] }
        let readCount = Int(
            min(UInt64(Self.maximumReadSize), size - currentOffset)
        )
        guard readCount > 0,
              let handle = try? FileHandle(forReadingFrom: sourceURL) else {
            return []
        }
        defer { try? handle.close() }

        do {
            try handle.seek(toOffset: currentOffset)
            guard let data = try handle.read(upToCount: readCount), !data.isEmpty else {
                return []
            }
            offset = currentOffset + UInt64(data.count)
            return consume(data)
        } catch {
            return []
        }
    }

    private mutating func consume(_ data: Data) -> [String] {
        var bytes = [UInt8](data)
        if discardsLeadingPartialLine {
            guard let newline = bytes.firstIndex(of: 0x0A) else { return [] }
            bytes.removeFirst(newline + 1)
            discardsLeadingPartialLine = false
        }

        carry.append(contentsOf: bytes)
        var lines: [String] = []
        while let newline = carry.firstIndex(of: 0x0A) {
            var line = Data(carry[..<newline])
            carry.removeSubrange(...newline)
            if line.last == 0x0D {
                line.removeLast()
            }
            lines.append(String(decoding: line, as: UTF8.self))
        }

        if carry.count > Self.maximumCarrySize {
            carry = Data(carry.suffix(Self.maximumCarrySize))
        }
        return lines
    }
}

private enum StateSnapshotFile {
    static func read(from sourceURL: URL) -> PublishedState? {
        guard let data = try? Data(contentsOf: sourceURL) else {
            return nil
        }
        return try? JSONDecoder().decode(PublishedState.self, from: data)
    }
}

import Combine
import Foundation

@MainActor
final class StateStore: ObservableObject {
    @Published private(set) var state: PublishedState?
    @Published private(set) var daemonMessage: String?

    private let reader: StateSnapshotReader
    private let socketClient: ConchSocketClient
    private var pollingTask: Task<Void, Never>?
    private var deliveryTask: Task<Void, Never>?
    private var controlSequence = 0

    init() {
        let reader = StateSnapshotReader()
        self.reader = reader
        socketClient = ConchSocketClient()
        state = StateSnapshotFile.read()

        pollingTask = Task { @MainActor [weak self, reader] in
            while !Task.isCancelled {
                if let snapshot = await reader.read() {
                    self?.accept(snapshot)
                }

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
            daemonMessage = delivered ? nil : "conch daemon not running"
        }
    }

    private func accept(_ snapshot: PublishedState) {
        guard snapshot != state else { return }
        state = snapshot
    }
}

private actor StateSnapshotReader {
    func read() -> PublishedState? {
        StateSnapshotFile.read()
    }
}

private enum StateSnapshotFile {
    private static let sourceURL = URL(
        fileURLWithPath: "/tmp/conch-sessions.json",
        isDirectory: false
    )

    static func read() -> PublishedState? {
        guard let data = try? Data(contentsOf: sourceURL) else {
            return nil
        }
        return try? JSONDecoder().decode(PublishedState.self, from: data)
    }
}

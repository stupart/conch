import Combine
import Foundation

@MainActor
final class StateStore: ObservableObject {
    @Published private(set) var state: PublishedState?

    private let reader: StateSnapshotReader
    private var pollingTask: Task<Void, Never>?

    init() {
        let reader = StateSnapshotReader()
        self.reader = reader
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

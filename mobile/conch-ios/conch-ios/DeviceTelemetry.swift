import Foundation
import UIKit

/// What conch costs the phone it runs on.
///
/// A voice loop that lives on a phone is judged on battery long before it is
/// judged on features, and "does this drain my phone" is not answerable by
/// opinion. Tyler asked for numbers: "we should install telemetry on how the
/// app is impacting the phone performance and stuff too".
///
/// Everything here is read from the OS about THIS process — no profiler, no
/// third party, nothing that leaves the pair of devices. It goes to the daemon
/// on the same socket everything else uses, so it lands in conch's own log
/// rather than a service.
struct DeviceSample: Encodable, Equatable, Sendable {
    /// Physical memory this process holds, in megabytes. The number iOS
    /// actually kills apps over.
    let footprintMB: Double
    /// 0–1, or nil when the device will not report it (Simulator).
    let battery: Double?
    /// "unplugged", "charging", "full" — a drain reading means nothing without
    /// knowing whether it was on a cable.
    let batteryState: String
    /// "nominal", "fair", "serious", "critical". Sustained audio and the mic
    /// are exactly what pushes a phone up this ladder.
    let thermal: String
    /// True while iOS is conserving power, which throttles the CPU and is the
    /// single most common cause of a phone-side slowdown that looks like a bug.
    let lowPower: Bool
    /// Seconds since the app launched, so a footprint can be read as a trend
    /// rather than a snapshot.
    let uptime: Double

    static func current(uptime: Double) -> DeviceSample {
        DeviceSample(
            footprintMB: Self.footprintMB(),
            battery: Self.batteryLevel(),
            batteryState: Self.batteryStateName(),
            thermal: Self.thermalName(),
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
            uptime: uptime
        )
    }

    /// `phys_footprint` rather than `resident_size`: it is the figure iOS
    /// measures against the jetsam limit, so it is the one that predicts a
    /// termination. Resident size flatters the app by excluding dirty pages
    /// that still count against it.
    private static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size) / 4
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.phys_footprint) / 1_048_576
    }

    private static func batteryLevel() -> Double? {
        let level = UIDevice.current.batteryLevel
        // -1 means "not being monitored", which is not the same as empty.
        return level < 0 ? nil : Double(level)
    }

    private static func batteryStateName() -> String {
        switch UIDevice.current.batteryState {
        case .charging: return "charging"
        case .full: return "full"
        case .unplugged: return "unplugged"
        default: return "unknown"
        }
    }

    private static func thermalName() -> String {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }
}

/// Samples the device and hands each reading to whoever wants it.
///
/// Deliberately slow: a telemetry loop that wakes often enough to matter is
/// itself the drain it claims to measure. Five minutes is frequent enough to
/// watch a trend across a working session and rare enough to be free.
@MainActor
final class DeviceTelemetry: ObservableObject {
    /// The most recent reading, so the app can show it without waiting for a
    /// round trip.
    @Published private(set) var latest: DeviceSample?

    var report: ((DeviceSample) -> Void)?

    private var timer: Timer?
    private let launchedAt = Date()
    private static let interval: TimeInterval = 300

    func start() {
        guard timer == nil else { return }
        // Off by default on the device, and the level reads -1 until it is on.
        UIDevice.current.isBatteryMonitoringEnabled = true
        sample()
        let timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) {
            [weak self] _ in
            Task { @MainActor in self?.sample() }
        }
        // Tolerance lets iOS coalesce this with work it was already doing,
        // which is the difference between a timer that costs nothing and one
        // that wakes the CPU on its own schedule.
        timer.tolerance = 60
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        // Battery monitoring is a subscription, not a read. Leaving it on means
        // iOS keeps delivering level and state changes to a process that has
        // stopped asking — exactly the kind of thing that should only be on
        // while it is needed.
        UIDevice.current.isBatteryMonitoringEnabled = false
    }

    private func sample() {
        let sample = DeviceSample.current(uptime: Date().timeIntervalSince(launchedAt))
        latest = sample
        report?(sample)
    }
}

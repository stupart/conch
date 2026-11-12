import ConchDesign
import Foundation
import SwiftUI

// Still running (2026-11-11, ConchDesign/StillRunning.swift): what sessions left running, in the sidebar beside them.
// Everything here is invented: no real session, folder, port or person.
func renderStillRunning() throws {
    let now = Date()
    let ms = now.timeIntervalSince1970 * 1_000
    let minute = 60_000.0
    let items: [ResourceItem] = [
        ResourceItem(id: "p43091", kind: "server", title: "vite :5297", command: "node node_modules/.bin/vite --port 5297",
                     owner: .init(label: "Landing page", live: false, how: "environment", endedAt: ms - 2 * 1_440 * minute),
                     startedAt: ms - 2 * 1_440 * minute - 30 * minute, cpu: 0.1, memory: 258 * 1_048_576, state: "asking", reason: "its session ended"),
        ResourceItem(id: "p94214", kind: "server", title: "python http.server :5260", command: "python -m http.server 5260",
                     owner: .init(label: "Landing page", live: false, how: "environment", endedAt: ms - 26 * 60 * minute),
                     startedAt: ms - 27 * 60 * minute, cpu: 0, memory: 15 * 1_048_576, state: "asking", reason: "its session ended"),
        ResourceItem(id: "p6100", kind: "watcher", title: "tsc -w -p .", command: "tsc -w -p .",
                     owner: .init(sessionId: "s2", label: "Docs refresh", live: true, how: "declared"),
                     startedAt: ms - 95 * minute, cpu: 2.4, memory: 180 * 1_048_576, lifetime: .init(kind: "turn"),
                     why: "rebuild while editing", state: "asking", reason: "its turn is over"),
        ResourceItem(id: "vm-ci", kind: "vm", title: "colima ci", command: "limactl hostagent colima-ci",
                     owner: .init(sessionId: "s1", label: "Build farm", live: true, how: "environment"),
                     startedAt: ms - 45 * minute, cpu: 133.2, memory: 12 * 1_073_741_824, state: "running"),
        ResourceItem(id: "p63965", kind: "server", title: "next :3193 :3194", command: "next dev",
                     owner: .init(sessionId: "s1", label: "Build farm", live: true, how: "tree"),
                     startedAt: ms - 9 * minute, cpu: 88.5, memory: 1.4 * 1_073_741_824, state: "running"),
        ResourceItem(id: "p7001", kind: "browser", title: "headless Chrome :9222", command: "Google Chrome --headless",
                     owner: .init(label: "Scraper", live: false, how: "tree"), startedAt: ms - 6 * 1_440 * minute, cpu: 0, memory: 640 * 1_048_576,
                     state: "kept", reason: "you kept it"),
        ResourceItem(id: "sim-9acc7dd3", kind: "simulator", title: "Test Phone simulator", command: "launchd_sim",
                     startedAt: ms - 28 * 60 * minute, cpu: 1.1, memory: 3.1 * 1_073_741_824, state: "unowned", reason: "no session started it"),
    ]
    let resources = PublishedResources(sampledAt: ms, asking: 3, items: items)
    func row(_ name: String, _ count: Int?, activity: String? = nil) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle().fill(activity == nil ? ConchColor.ready : ConchColor.active).frame(width: 7, height: 7).padding(.top, 5)
            VStack(alignment: .leading, spacing: 1) {
                TailFadeText(name).font(.system(size: 12.5, weight: .medium)).foregroundStyle(ConchColor.textPrimary)
                if let line = SidebarRowText.secondLine(message: nil, blockedOn: nil, activity: activity, stillRunning: count, startedBy: nil) {
                    SidebarSecondLine(line)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }
    try render("still-running", width: 720) {
        Heading(title: "Still running", note: "Beside the sessions: what they left running, whose, how old, CPU and memory; asking first, with Stop, Keep and Ask later")
        HStack(alignment: .top, spacing: 32) {
            SidebarColumn(title: "Asking open, the rest folded (as it starts)") {
                row("Build farm", 2)
                row("Docs refresh", 1, activity: "Running the test suite")
                StillRunningSection(resources: resources, now: now) { _, _ in nil }
            }
            .frame(width: 280)
            SidebarColumn(title: "Every group open") {
                StillRunningSection(resources: resources, now: now, open: ["asking", "running", "kept", "unowned"]) { _, _ in nil }
            }
            .frame(width: 280)
        }
    }
}

import Foundation

// Compiled with mac-app/conch-mac/DaemonHost.swift by test/daemon-host-launch.test.ts:
// the app's real daemon resolution, run against a fake filesystem. Each case
// prints `<name> <source> <executable>` (or `<name> none`), and the test reads
// the lines back.

let home = URL(fileURLWithPath: "/Users/tester")
let app = URL(fileURLWithPath: "/Applications/conch.app")
let bundled = app.appendingPathComponent("Contents/Helpers/conch-daemon").path
let bun = home.appendingPathComponent(".bun/bin/bun").path
let entry = home.appendingPathComponent("conch/src/cli.ts").path
let brewConch = "/opt/homebrew/bin/conch"

/// A bundle whose Info.plist says `ConchDaemonSource`, as a built app's does.
func makeBundle(source: String?) -> Bundle {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("daemon-launch-\(UUID().uuidString).app")
    let contents = root.appendingPathComponent("Contents")
    try! FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
    var info: [String: Any] = ["CFBundleIdentifier": "test.conch.\(UUID().uuidString)", "CFBundlePackageType": "APPL"]
    if let source { info["ConchDaemonSource"] = source }
    let data = try! PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
    try! data.write(to: contents.appendingPathComponent("Info.plist"))
    return Bundle(url: root)!
}

func run(
    _ name: String,
    present: Set<String>,
    source: String? = "bundled",
    environment: [String: String] = ["PATH": "/usr/bin:/bin"],
    preferCheckout: Bool? = nil
) {
    let bundle = makeBundle(source: source)
    // The bundled daemon is looked up inside the bundle passed in: map the
    // fixture's bundle path onto the /Applications path the cases name.
    let inBundle = bundle.bundleURL.appendingPathComponent("Contents/Helpers/conch-daemon").path
    let exists: (String) -> Bool = { path in
        path == inBundle ? present.contains(bundled) : present.contains(path)
    }
    let command = DaemonHost.launchCommand(
        bundle: bundle,
        preferCheckout: preferCheckout,
        environment: environment,
        fileExists: exists,
        isFile: exists,
        home: home
    )
    guard let command else { print("\(name) none"); return }
    let executable = command.executable.path == inBundle ? bundled : command.executable.path
    print("\(name) \(command.source.rawValue) \(executable) \(command.arguments.joined(separator: ","))")
}

let everything: Set<String> = [bundled, bun, entry, brewConch]
run("release-all", present: everything)
run("release-no-bundle", present: [bun, entry, brewConch])
run("release-checkout-only", present: [bun, entry])
run("release-nothing", present: [])
run("dev-all", present: everything, source: "checkout")
run("dev-no-checkout", present: [bundled, brewConch], source: "checkout")
run("dev-checkout-without-bun", present: [bundled, entry], source: "checkout")
run("dev-only-path", present: [brewConch], source: "checkout")
run("env-beats-plist", present: everything, source: "bundled", environment: ["PATH": "/usr/bin", "CONCH_DAEMON_SOURCE": "checkout"])
run("env-bundled-beats-dev-plist", present: everything, source: "checkout", environment: ["PATH": "/usr/bin", "CONCH_DAEMON_SOURCE": "bundled"])
run("no-plist-key", present: everything, source: nil)
run("inherited-path", present: ["/Users/tester/tools/conch"], environment: ["PATH": "/Users/tester/tools:/usr/bin"])
print("prefers-checkout-plist \(DaemonHost.prefersCheckout(bundle: makeBundle(source: "checkout"), environment: [:]))")
print("prefers-checkout-release \(DaemonHost.prefersCheckout(bundle: makeBundle(source: "bundled"), environment: [:]))")

// Which identity the health check may signal (DaemonHost.signallableIdentity): `identity-<case> <pid>` or `none`.
let written = 1_790_524_645_000.0 // epoch ms, when the daemon wrote the file
func signallable(_ name: String, _ identity: DaemonHost.Identity?, processStarted: Double?) {
    let found = DaemonHost.signallableIdentity(
        socketPath: "/tmp/test-conch.sock",
        identity: identity,
        processStartedAt: { _ in processStarted.map { Date(timeIntervalSince1970: $0 / 1_000) } }
    )
    print("identity-\(name) \(found.map { String($0.pid) } ?? "none")")
}
let current = DaemonHost.Identity(pid: 4242, version: "1", startedBy: "app", startedAt: written, socketPath: "/tmp/test-conch.sock")
signallable("current", current, processStarted: written - 2_000)
signallable("other-socket", DaemonHost.Identity(pid: 4242, version: "1", startedBy: "terminal", startedAt: written, socketPath: "/tmp/other.sock"), processStarted: written - 2_000)
signallable("older-daemon", DaemonHost.Identity(pid: 4242, version: "1", startedBy: "app"), processStarted: written - 2_000)
signallable("reused-pid", current, processStarted: written + 60_000)
signallable("process-gone", current, processStarted: nil)
signallable("absent", nil, processStarted: written - 2_000)

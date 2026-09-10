import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderServicePlist, serviceOff } from "../src/install.ts";

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8");

/**
 * A2/A3: who owns the daemon, and how the app stops guessing.
 *
 * `daemon-identity.ts` was written and tested but called by nothing, so the
 * app could only say "started outside this app". The daemon now writes its
 * identity once it owns the socket; the launchd plist and the app each name
 * themselves in CONCH_STARTED_BY; the app reads the file when it adopts and
 * says who, keeps the switch (disabled, with the reason) instead of hiding it,
 * and when launchd is the owner offers to take over — `conch service off`
 * then its own start(). The Swift never runs here, so it is pinned as text.
 */

test("the daemon claims the identity only after winning the socket, and drops it on shutdown", () => {
  const daemon = read("src", "daemon.ts");
  const won = daemon.indexOf("if (!await controlServer.start()) {");
  const claim = daemon.indexOf("writeIdentity();");
  expect(won).toBeGreaterThan(-1);
  expect(claim).toBeGreaterThan(-1);
  // A loser of the ownership race exits inside that block; writing first
  // would overwrite the real owner's record with a pid about to vanish.
  expect(claim).toBeGreaterThan(won);

  const shutdownAt = daemon.indexOf("const shutdown = async (): Promise<void> => {");
  const clear = daemon.indexOf("clearIdentity();");
  expect(shutdownAt).toBeGreaterThan(-1);
  expect(clear).toBeGreaterThan(shutdownAt);
  // Before the synchronous exit, or the default path never clears it.
  expect(clear).toBeLessThan(daemon.indexOf("if (!diagnosticsEnabled) process.exit(0);", shutdownAt));
});

test("the launchd plist names launchd as the daemon's owner", () => {
  const plist = renderServicePlist({
    daemonArgv: ["/usr/local/bin/conch", "daemon"],
    conchRoot: "/checkout",
    path: "/usr/bin:/bin",
    carriedEnv: "",
  });
  expect(plist).toContain("<key>CONCH_STARTED_BY</key><string>launchd</string>");
  expect(plist).toContain("<string>/usr/local/bin/conch</string><string>daemon</string>");
});

test("service off unloads the agent by label and drops the plist — never a kill by pattern", () => {
  const ran: string[][] = [];
  const unlinked: string[] = [];
  serviceOff(502, "/tmp/agent.plist", (argv) => ran.push(argv), (path) => unlinked.push(path));
  expect(ran).toEqual([["launchctl", "bootout", "gui/502/com.conch.daemon"]]);
  expect(unlinked).toEqual(["/tmp/agent.plist"]);
  // A plist already gone is the same outcome, not an error.
  expect(() => serviceOff(502, "/gone.plist", () => {}, () => { throw new Error("ENOENT"); })).not.toThrow();
});

test("the app names itself, reads the identity file on adopt, and takes over from launchd by service off then start()", () => {
  const host = read("mac-app", "conch-mac", "DaemonHost.swift");
  expect(host).toContain('environment["CONCH_STARTED_BY"] = "app"');
  expect(host).toContain('.appendingPathComponent(".cache/conch/daemon.json")');
  // Liveness, the whole point of the identity file: a stale record names nobody.
  expect(host).toContain("kill($0, 0) == 0");

  const readAt = host.indexOf("adoptedIdentity = DaemonHost.readIdentity()");
  const adoptAt = host.indexOf("state = .adopted");
  expect(readAt).toBeGreaterThan(-1);
  expect(adoptAt).toBeGreaterThan(-1);
  expect(readAt).toBeLessThan(adoptAt); // right on the first paint, not a poll later

  const takeAt = host.indexOf("func takeOverFromLaunchd() {");
  expect(takeAt).toBeGreaterThan(-1);
  const take = host.slice(takeAt, host.indexOf("\n    }\n", takeAt)); // the function body, not the file
  expect(take).toContain('adoptedIdentity?.startedBy == "launchd"');
  expect(take).toContain('launchCommand(subcommand: ["service", "off"])');
  expect(take).toContain("startOnceSocketQuiet()");
  const quietAt = host.indexOf("private func startOnceSocketQuiet() async {");
  expect(quietAt).toBeGreaterThan(-1);
  expect(host.slice(quietAt)).toContain("state = .stopped\n        start()");
  expect(host).not.toMatch(/pkill|killall/);
});

test("the settings row keeps the switch, says who started the daemon, and offers the takeover", () => {
  const view = read("mac-app", "conch-mac", "SettingsView.swift");
  expect(view).toContain('"Running — started by the launchd service"');
  expect(view).toContain('"Running — started from a terminal (pid \\(identity.pid))"');
  expect(view).toContain(`"the app can't stop what it didn't start"`);
  expect(view).not.toContain('Text("started elsewhere")');
  expect(view).toContain('Button("Let the app own it") { daemon.takeOverFromLaunchd() }');
  expect(view).toContain('daemon.adoptedIdentity?.startedBy == "launchd"');

  const rowAt = view.indexOf("private struct DaemonPowerRow: View {");
  expect(rowAt).toBeGreaterThan(-1);
  const row = view.slice(rowAt);
  const toggleAt = row.indexOf('Toggle("", isOn:');
  expect(toggleAt).toBeGreaterThan(-1);
  expect(row.slice(toggleAt, toggleAt + 400)).toContain(".disabled(adopted)");
});

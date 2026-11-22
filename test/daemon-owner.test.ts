import { expect, test } from "bun:test";
import { renderServicePlist, serviceOff } from "../src/install.ts";

/** The launchd service names itself as the daemon's owner, and `conch service off` unloads it by label. */

test("the launchd plist names launchd as the daemon's owner", () => {
  const plist = renderServicePlist({
    daemonArgv: ["/usr/local/bin/conch", "daemon"],
    conchRoot: "/checkout",
    path: "/usr/bin:/bin",
    carriedEnv: "",
  });
  expect(plist).toContain("<key>CONCH_STARTED_BY</key><string>launchd</string>");
  expect(plist).toContain("<string>/usr/local/bin/conch</string><string>daemon</string>");
  // A daemon that exits 0 because another owns the socket is not restarted every ten seconds; a crash still is.
  expect(plist).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
  expect(Bun.spawnSync(["/usr/bin/plutil", "-lint", "-"], { stdin: new Blob([plist]) }).exitCode).toBe(0);
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

import { expect, test } from "bun:test";
import { renderServicePlist, serviceDaemonArgv } from "../src/install.ts";

/**
 * launchd runs ProgramArguments without a shell. The compiled install wrote a
 * shell-quoted path as argv[0] — literal quote characters — so the service
 * launched nothing for every brew user (found 2026-09-11). No element may
 * carry a quote, and the compiled form is exactly [binary, "daemon"].
 */
test("the service plist's argv carries no shell quoting", () => {
  const compiled = serviceDaemonArgv(true, "/opt/homebrew/bin/conch", "/unused");
  expect(compiled).toEqual(["/opt/homebrew/bin/conch", "daemon"]);
  const source = serviceDaemonArgv(false, "/opt/homebrew/bin/bun", "/Users/t/conch");
  expect(source).toEqual(["/opt/homebrew/bin/bun", "/Users/t/conch/src/cli.ts", "daemon"]);
  for (const argv of [compiled, source]) {
    for (const word of argv) expect(word).not.toMatch(/["']/);
  }
  const plist = renderServicePlist({ daemonArgv: compiled, conchRoot: "/unused", path: "/opt/homebrew/bin", carriedEnv: "" });
  expect(plist).toContain("<string>/opt/homebrew/bin/conch</string><string>daemon</string>");
  expect(plist).not.toContain("&quot;");
  expect(plist).not.toContain('<string>"');
});

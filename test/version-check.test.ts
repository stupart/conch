import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeNotice,
  fetchLatestVersion,
  isCheckDue,
  isNewer,
  parseVersion,
  readVersionCheck,
  updateNotice,
  writeVersionCheck,
} from "../src/version-check.ts";

test("newer means newer, component by component", () => {
  expect(isNewer("0.3.0", "0.2.1")).toBe(true);
  expect(isNewer("0.2.2", "0.2.1")).toBe(true);
  expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  expect(isNewer("v0.3.0", "0.2.1")).toBe(true);

  expect(isNewer("0.2.1", "0.2.1")).toBe(false);
  expect(isNewer("0.2.0", "0.2.1")).toBe(false);
  // 10 is newer than 9, which string comparison gets backwards.
  expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  expect(isNewer("0.9.0", "0.10.0")).toBe(false);
});

test("anything unparseable is treated as nothing to say", () => {
  // A wrong "you are out of date" sends someone to upgrade what is already
  // current, and the next real notice gets ignored. Silence is the safe answer.
  expect(parseVersion("nightly")).toBeNull();
  expect(parseVersion("0.3")).toBeNull();
  expect(parseVersion("0.3.0-rc1")).toBeNull();
  expect(isNewer("nightly", "0.2.1")).toBe(false);
  expect(isNewer("0.3.0", "not-a-version")).toBe(false);
});

test("a source checkout is never told to brew upgrade", () => {
  // `git pull` is the upgrade path there, so the brew advice would be both
  // wrong and impossible to follow.
  expect(updateNotice("0.2.1", "0.3.0", true)).toBeNull();
  const notice = updateNotice("0.2.1", "0.3.0", false);
  expect(notice).not.toBeNull();
  expect(notice!.command).toBe("brew upgrade conch");
  expect(describeNotice(notice!)).toBe(
    "conch 0.3.0 is available (running 0.2.1) — brew upgrade conch",
  );
});

test("nothing is said when there is nothing to say", () => {
  expect(updateNotice("0.3.0", "0.3.0", false)).toBeNull();
  expect(updateNotice("0.3.0", undefined, false)).toBeNull();
  expect(updateNotice("0.4.0", "0.3.0", false)).toBeNull();
});

test("the check is due on a fresh install, and once a day after", () => {
  const day = 24 * 60 * 60 * 1000;
  expect(isCheckDue(null, 1_000, day)).toBe(true);
  expect(isCheckDue({ checkedAt: 1_000 }, 1_000 + day, day)).toBe(true);
  expect(isCheckDue({ checkedAt: 1_000 }, 1_000 + day - 1, day)).toBe(false);
  // A clock that moved backwards must not park the next check in the future
  // forever — sleep, a timezone change, or NTP all do this.
  expect(isCheckDue({ checkedAt: 10_000 }, 5_000, day)).toBe(true);
});

test("the record survives a round trip and shrugs off a corrupt one", () => {
  const path = join(mkdtempSync(join(tmpdir(), "conch-vc-")), "version-check.json");
  expect(readVersionCheck(path)).toBeNull();

  writeVersionCheck(path, { checkedAt: 42, latest: "0.3.0" });
  expect(readVersionCheck(path)).toEqual({ checkedAt: 42, latest: "0.3.0" });

  // A failed check still records the attempt, so a network outage cannot turn
  // into a request on every daemon start.
  writeVersionCheck(path, { checkedAt: 99 });
  expect(readVersionCheck(path)).toEqual({ checkedAt: 99 });

  Bun.write(path, "{ not json");
  expect(readVersionCheck(path)).toBeNull();
});

test("a hostile or broken response is never believed", async () => {
  const reply = (body: unknown, ok = true) =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

  expect(await fetchLatestVersion(50, reply({ tag_name: "v0.3.0" }))).toBe("0.3.0");
  expect(await fetchLatestVersion(50, reply({ tag_name: "nightly" }))).toBeNull();
  expect(await fetchLatestVersion(50, reply({ tag_name: 3 }))).toBeNull();
  expect(await fetchLatestVersion(50, reply({}))).toBeNull();
  expect(await fetchLatestVersion(50, reply({ tag_name: "v9.9.9" }, false))).toBeNull();

  // A throwing fetch (no network, DNS, rate limit) is silence, not a crash.
  const throws = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await fetchLatestVersion(50, throws)).toBeNull();
});

test("the daemon checks once at startup, without blocking or failing", () => {
  const daemon = readFileSync(join(import.meta.dir, "../src/daemon.ts"), "utf8");
  const fn = daemon.slice(daemon.indexOf("function checkForUpdate(): void {"));
  const body = fn.slice(0, fn.indexOf("\n  }"));

  // A checkout upgrades with git pull, so it is never told to brew upgrade.
  expect(body).toContain("if (runningFromSource()) return;");
  // Fire and forget: a version notice must never delay the daemon coming up.
  expect(body).toContain("void fetchLatestVersion()");
  expect(body).not.toContain("await fetchLatestVersion()");
  // The attempt is recorded whether or not it succeeded, so an outage cannot
  // become a request on every single start.
  expect(body).toContain("writeVersionCheck(path, { checkedAt: Date.now()");
  // ...and a known-stale version is still reported between checks.
  expect(body).toContain("const known = updateNotice(CONCH_VERSION, state?.latest, false)");

  expect(daemon).toContain("checkForUpdate(); // fire and forget");
});

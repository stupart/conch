/**
 * Sabotage each cache guarantee the two readers rest on, and prove a test catches it.
 *
 * The decisions live in ConchDesign, where `swift test` executes them; the wiring that
 * uses them lives in two apps CI never builds, where a string pin is the only automated
 * reader. Both are mutated here, each by string replacement, reverted the same way, with
 * the restored file verified byte-for-byte against its original checksum.
 *
 *   bun scripts/check-records-ui-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const checksum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const design = "design/ConchDesign/Sources/ConchDesign/History.swift";

const mutations = [
  {
    name: "a body held at an older revision is treated as still true",
    file: design,
    find: "guard let body = held[item.id], let revision = body.revision, revision != item.revision else { return nil }",
    replace: "guard let body = held[item.id], let revision = body.revision, revision == item.revision else { return nil }",
    runner: "swift",
  },
  {
    name: "the newest page replaces the older pages instead of merging with them",
    file: design,
    find: "        items = Self.merge(newer: page.items, into: items)",
    replace: "        items = page.items",
    runner: "swift",
  },
  {
    name: "a tool row stops being matched by its call id",
    file: design,
    find: "        if let toolId, toolId == id { return true }",
    replace: "        if let toolId, toolId == id, false { return true }",
    runner: "swift",
  },
  {
    name: "the Mac keeps bodies a page has already revised",
    file: "mac-app/conch-mac/HistoryStore.swift",
    find: "            retire(HistoryCache.stale(bodies, against: page.items))",
    replace: "            _ = HistoryCache.stale(bodies, against: page.items)",
    runner: "bun",
    test: "test/mac-history-source.test.ts",
  },
  {
    name: "the phone waits for a body no page it holds will ever name",
    file: "mobile/conch-ios/conch-ios/HistoryStore.swift",
    find: "        if paging.items.isEmpty { loadOlder() } else { loadNewest() }",
    replace: "        if paging.items.isEmpty { loadOlder() } else { drainWantedBodies() }",
    runner: "bun",
    test: "test/ios-history-source.test.ts",
  },
] as const;

const run = (mutation: (typeof mutations)[number]): number => {
  const command = mutation.runner === "swift"
    ? ["swift", "test", "--package-path", "design/ConchDesign"]
    : ["bun", "test", (mutation as { test: string }).test];
  return Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode ?? 1;
};

let failures = 0;
for (const mutation of mutations) {
  const path = join(root, mutation.file);
  const original = readFileSync(path, "utf8");
  const expected = checksum(original);
  const occurrences = original.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    console.log(`FAIL ${mutation.name}: anchor appears ${occurrences} times in ${mutation.file}`);
    failures++;
    continue;
  }

  const baseline = run(mutation);
  writeFileSync(path, original.replace(mutation.find, mutation.replace));
  const sabotaged = run(mutation);
  const mutated = readFileSync(path, "utf8");
  writeFileSync(path, mutated.replace(mutation.replace, mutation.find));
  const restoredText = readFileSync(path, "utf8");
  const restored = run(mutation);
  const identical = checksum(restoredText) === expected;

  const ok = baseline === 0 && sabotaged !== 0 && restored === 0 && identical;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${mutation.name}`);
  console.log(`  baseline ${baseline}, mutant ${sabotaged}, restored ${restored}, file identical ${identical}`);
}

console.log(failures ? `${failures} mutation check(s) failed` : "every mutation was caught and every file restored");
process.exit(failures ? 1 : 0);

/**
 * Sabotage each guarantee this change rests on, and prove a test catches it. Every
 * mutation is applied by string replacement, reverted the same way, and the restored
 * file is verified byte-for-byte against its original checksum.
 *
 *   bun scripts/check-history-branch-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const checksum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const mutations = [
  {
    name: "the Mac asks for history without saying which window it is",
    file: "mac-app/conch-mac/HistoryStore.swift",
    find: "            branch: paging.branchTip,",
    replace: "            branch: nil,",
    test: "test/mac-history-source.test.ts",
  },
  {
    name: "the phone asks for history without saying which window it is",
    file: "mobile/conch-ios/conch-ios/HistoryStore.swift",
    find: "            branch: paging.branchTip,",
    replace: "            branch: nil,",
    test: "test/ios-history-source.test.ts",
  },
  {
    name: "the tip is re-captured whenever the view points the reader at the session again",
    file: "design/ConchDesign/Sources/ConchDesign/History.swift",
    find: "        guard session != self.session else { return }",
    replace: "        guard session != self.session else { self.branchTip = branchTip ?? self.branchTip; return }",
    test: "swift",
  },
  {
    name: "a tip that proved nothing is reported as this window's branch anyway",
    file: "src/records-history.ts",
    find: "    const coverage = this.coverage(session.id, ancestry.nativeIds.length > 0);",
    replace: "    const coverage = this.coverage(session.id, !!request.branch);",
    test: "test/history-branch.test.ts",
  },
  {
    name: "the ancestry is re-read past the fence its traversal was opened at",
    file: "src/records-history.ts",
    find: "      WHERE session_id=? AND native_id=? AND created_sequence<=? ORDER BY order_key,id LIMIT 1",
    replace: "      WHERE session_id=? AND native_id=? AND created_sequence<=?+2000000000 ORDER BY order_key,id LIMIT 1",
    test: "test/history-branch.test.ts",
  },
  {
    name: "only a record id is accepted as a tip, so the id an app actually holds proves nothing",
    file: "src/records-history.ts",
    find: "    let row = byItemId ?? (ancestor.get(session.id, tip, fence) as typeof byItemId);",
    replace: "    let row = byItemId;",
    test: "test/history-branch.test.ts",
  },
];

const runTest = (target: string): number => {
  const command = target === "swift"
    ? ["swift", "test", "--package-path", "design/ConchDesign"]
    : ["bun", "test", target];
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

  const baseline = runTest(mutation.test);
  writeFileSync(path, original.replace(mutation.find, mutation.replace));
  const sabotaged = runTest(mutation.test);
  const mutated = readFileSync(path, "utf8");
  writeFileSync(path, mutated.replace(mutation.replace, mutation.find));
  const restoredText = readFileSync(path, "utf8");
  const restored = runTest(mutation.test);
  const identical = checksum(restoredText) === expected;

  const ok = baseline === 0 && sabotaged !== 0 && restored === 0 && identical;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${mutation.name}`);
  console.log(`  baseline ${baseline}, mutant ${sabotaged}, restored ${restored}, file identical ${identical}`);
}

console.log(failures ? `${failures} mutation check(s) failed` : "every mutation was caught and every file restored");
process.exit(failures ? 1 : 0);

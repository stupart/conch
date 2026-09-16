/**
 * Sabotage the two guarantees this change rests on and prove a test catches each.
 *
 * Every mutation is applied by string replacement, reverted the same way, and
 * the restored file is verified byte-for-byte against its original checksum.
 *
 *   bun scripts/check-hook-cursor-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const checksum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const mutations = [
  {
    name: "the whole-file scan is reintroduced",
    file: "src/snippet.ts",
    find: "const from = usableResume(resume, version) ? resume!.from : 0;",
    replace: "const from = 0;",
    test: "test/prompt-cursor.test.ts",
  },
  {
    name: "the records-off path falls through to the store",
    file: "src/prompt-cursor.ts",
    find: "  if (!config.recordsEnabled) return mark(transcriptPath);",
    replace: "  if (!config.recordsEnabled && false) return mark(transcriptPath);",
    test: "test/prompt-cursor.test.ts",
  },
];

const runTest = (file: string): number => {
  const result = Bun.spawnSync(["bun", "test", file], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return result.exitCode ?? 1;
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
  console.log(`  baseline=${baseline} sabotaged=${sabotaged} restored=${restored} checksum=${identical ? "identical" : "CHANGED"}`);
}

console.log(failures ? `${failures} mutation check(s) failed` : "all mutation checks passed");
process.exit(failures ? 1 : 0);

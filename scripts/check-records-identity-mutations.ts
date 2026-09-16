/**
 * Sabotage each identity and recovery guarantee this change rests on, and prove a test
 * catches it. Every mutation is applied by string replacement, reverted the same way, and
 * the restored file is verified byte-for-byte against its original checksum.
 *
 *   bun scripts/check-records-identity-mutations.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const checksum = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const mutations = [
  {
    name: "a message goes back to being one item per content block",
    file: "src/records-claude.ts",
    find: "        if (messageWritten || !visible.length) continue;\n        messageWritten = true;\n        append(rootId, {",
    replace: "        if (!visible.length) continue;\n        messageWritten = true;\n        append(recordKey(rootId, \"text\", blockIndex), {",
    test: "test/records-history.test.ts",
  },
  {
    name: "a tool item stops carrying the call id a live row is keyed by",
    file: "src/records-history.ts",
    find: "const TOOL_ID = `CASE WHEN length(CAST(t.native_id AS BLOB))<=160 THEN t.native_id END`;",
    replace: "const TOOL_ID = `NULL`;",
    test: "test/records-history.test.ts",
  },
  {
    name: "items stop recording the provider's parent, so ancestry cannot heal",
    file: "src/records-store.ts",
    find: "          item.parentNativeId ?? null, item.kind,",
    replace: "          null, item.kind,",
    test: "test/records-history.test.ts",
  },
  {
    name: "a file replacing another at its path stops advancing the epoch",
    file: "src/records-store.ts",
    find: "    if (replaced) this.db.query(\"UPDATE sessions SET history_epoch=history_epoch+1 WHERE id=?\").run(sessionId);",
    replace: "    if (replaced && false) this.db.query(\"UPDATE sessions SET history_epoch=history_epoch+1 WHERE id=?\").run(sessionId);",
    test: "test/records-indexer.test.ts",
  },
  {
    name: "an exited worker is held onto instead of replaced",
    file: "src/records-runtime.ts",
    find: "    if (this.client !== client || client.failed !== true || this.closed) return;",
    replace: "    if (true) return;",
    test: "test/records-runtime.test.ts",
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
  console.log(`  baseline ${baseline}, mutant ${sabotaged}, restored ${restored}, file identical ${identical}`);
}

console.log(failures ? `${failures} mutation check(s) failed` : "every mutation was caught and every file restored");
process.exit(failures ? 1 : 0);

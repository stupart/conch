import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordStore } from "../src/records-store.ts";
import { RecordsIndexer } from "../src/records-indexer.ts";

test("a worker crash mid-batch preserves the checkpoint and replay recovers the remaining record", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-record-worker-crash-"));
  let store: RecordStore | undefined;
  let indexer: RecordsIndexer | undefined;
  try {
    const claudeHome = join(root, "claude");
    const project = join(claudeHome, "projects", "fixture");
    const configDir = join(root, "config");
    mkdirSync(project, { recursive: true });
    const nativeId = "00000000-0000-4000-8000-000000000001";
    writeFileSync(join(project, `${nativeId}.jsonl`), ["one", "two"].map((uuid) => JSON.stringify({
      type: "user", uuid, message: { role: "user", content: uuid },
    }) + "\n").join(""));
    const options = { ownerDeviceId: "fixture-device", claudeHome, codexHome: join(root, "absent-codex"), batchBytes: 1024, batchLines: 1 };
    store = new RecordStore({ configDir });
    indexer = new RecordsIndexer(store, options);
    await indexer.tick();
    expect(store.counts().items).toBe(1);
    const before = store.sourcePage()[0]!.source;
    await indexer.stop();
    store.close();
    store = undefined;

    const workerPath = join(root, "worker.ts");
    writeFileSync(workerPath, `
      import { RecordStore } from ${JSON.stringify(new URL("../src/records-store.ts", import.meta.url).href)};
      import { RecordsIndexer } from ${JSON.stringify(new URL("../src/records-indexer.ts", import.meta.url).href)};
      const store = new RecordStore({configDir:${JSON.stringify(configDir)}});
      const ingest = store.ingest.bind(store);
      store.ingest = input => ingest(input, () => process.exit(71));
      const indexer = new RecordsIndexer(store, ${JSON.stringify(options)});
      await indexer.tick();
      process.exit(72);
    `);
    const childPath = join(root, "child.ts");
    writeFileSync(childPath, `
      import { Worker } from "node:worker_threads";
      const worker = new Worker(${JSON.stringify(workerPath)});
      worker.on("exit", code => process.exit(code));
      worker.on("error", () => process.exit(73));
    `);
    const child = Bun.spawn([process.execPath, childPath], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).toBe(71);
    store = new RecordStore({ configDir });
    expect(store.source(before.id)).toEqual(before);
    expect(store.counts().items).toBe(1);
    indexer = new RecordsIndexer(store, options);
    for (let tick = 0; tick < 4; tick++) await indexer.tick();
    expect(store.counts().items).toBe(2);
    expect(store.sourcePage()[0]!.coverage.status).toBe("complete");
  } finally {
    await indexer?.stop();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

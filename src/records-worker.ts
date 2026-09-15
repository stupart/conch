import { parentPort, workerData } from "node:worker_threads";
import { RecordStore } from "./records-store.ts";
import type { RecordsReply, RecordsRequest } from "./records-client.ts";

const port = parentPort;
if (!port) throw new Error("records-worker must run in a worker");
const reply = (message: RecordsReply) => port.postMessage(message);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

try {
  if (typeof workerData?.configDir !== "string" || !workerData.configDir) {
    throw new Error("record worker requires a config directory");
  }
  const store = new RecordStore({ configDir: workerData.configDir });
  port.on("message", (request: RecordsRequest) => {
    try {
      let value: unknown;
      switch (request.method) {
        case "ingest": value = store.ingest(...request.args); break;
        case "source": value = store.source(...request.args); break;
        case "appendReceipt": value = store.appendReceipt(...request.args); break;
        case "receipts": value = store.receipts(...request.args); break;
        case "reindex": value = store.reindex(...request.args); break;
        case "counts": value = store.counts(); break;
        case "close": store.close(); break;
        default: throw new Error("unknown record worker operation");
      }
      reply({ kind: "result", id: request.id, value });
    } catch (error) {
      reply({ kind: "error", id: request.id, error: errorText(error) });
    } finally {
      if (request.method === "close") port.close();
    }
  });
  reply({ kind: "ready" });
} catch (error) {
  reply({ kind: "fatal", error: errorText(error) });
  port.close();
}

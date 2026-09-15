import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the production Swift receipt parser preserves drafts unless an explicit submission receipt arrives", async () => {
  const root = mkdtempSync(join(tmpdir(), "conch-receipt-swift-"));
  try {
    const harness = join(root, "main.swift"), binary = join(root, "receipt-tests");
    writeFileSync(harness, `import Foundation
func receipt(_ text: String) -> InjectReceipt { InjectReceipt.decode(status: 200, body: Data(text.utf8)) }
for text in ["", "{}", "null", "oops", "{\\"kind\\":\\"ack\\"}", "{\\"kind\\":\\"inject-done\\"}", "{\\"kind\\":\\"inject-done\\",\\"delivered\\":1}", "{\\"kind\\":\\"inject-done\\",\\"delivered\\":true,\\"staged\\":true}"] {
  let outcome = receipt(text)
  precondition(!outcome.reachedMac)
  precondition(outcome.remainingDraft("fixture words plus new words", sent: "fixture words") == "fixture words plus new words")
}
precondition(receipt("{\\"kind\\":\\"inject-done\\",\\"delivered\\":true}") == .delivered)
precondition(receipt("{\\"kind\\":\\"inject-accepted\\"}") == .accepted)
let staged = receipt("{\\"kind\\":\\"inject-done\\",\\"delivered\\":false,\\"staged\\":true}")
precondition(staged == .staged && !staged.reachedMac)
precondition(staged.remainingDraft("fixture words", sent: "fixture words") == "fixture words")
precondition(InjectReceipt.delivered.remainingDraft("fixture words plus new words", sent: "fixture words") == "plus new words")
precondition(InjectReceipt.delivered.remainingDraft("edited while waiting", sent: "fixture words") == "edited while waiting")
precondition(!receipt("{\\"kind\\":\\"inject-done\\",\\"delivered\\":false}").reachedMac)
precondition(!InjectReceipt.decode(status: 502, body: Data()).reachedMac)
print("receipt and draft assertions passed")
`);
    const compiler = Bun.spawn(["swiftc", join(import.meta.dir, "../mobile/conch-ios/conch-ios/InjectReceipt.swift"), harness, "-o", binary], { stdout: "pipe", stderr: "pipe" });
    const diagnostics = await new Response(compiler.stderr).text();
    expect(await compiler.exited, diagnostics).toBe(0);
    const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
    expect(await new Response(run.stdout).text()).toContain("receipt and draft assertions passed");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

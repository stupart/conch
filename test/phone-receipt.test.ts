import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEAD_TARGET_REASONS } from "../src/dead-target.ts";

const root = join(import.meta.dir, "..");

/**
 * What the phone makes of the Mac's answer to a send (InjectReceipt.swift, which has no test target of its own).
 *
 * On 2026-09-16 a modal dialog was open on Tyler's Mac and three messages from his phone showed a bare failure, though
 * the daemon knew exactly why. The sentences themselves are pinned in ConchDesign's SendFailureTests; this holds every
 * reason the daemon can name to one of them, and the draft to the rule that only a proven delivery clears it.
 */

/** Every reason `injectText` itself can report, read from the daemon's own source: the TS side of the Swift table. */
function injectReasons(): string[] {
  const source = readFileSync(join(root, "src/inject.ts"), "utf8");
  const start = source.indexOf("  reason?:");
  expect(start).toBeGreaterThan(-1);
  const union = source.slice(start, source.indexOf(";", start));
  return [...union.matchAll(/"([a-z][a-z-]+)"/g)].map((match) => match[1]!);
}

/** A Swift string literal. None of these carry `\(`, so JSON escaping is exactly Swift's. */
const swift = (value: string): string => JSON.stringify(value);
const receiptJSON = (reply: Record<string, unknown>): string => swift(JSON.stringify(reply));

test("the Swift receipt parser gives every reason the daemon can name a sentence, and keeps the draft", async () => {
  const root_ = mkdtempSync(join(tmpdir(), "conch-receipt-swift-"));
  try {
    const harness = join(root_, "main.swift"), binary = join(root_, "receipt-tests");
    // Both production sources, compiled as one module. ConchDesign is not LINKED here
    // because SwiftPM's build layout moves between toolchains, and a test that has to
    // guess where a built module landed is a test that fails on someone else's machine
    // (it did, on CI). The real `import ConchDesign` is proven by the two app builds,
    // which link the package for real; here it is only in the way.
    const app = readFileSync(join(root, "mobile/conch-ios/conch-ios/InjectReceipt.swift"), "utf8");
    expect(app, "the app must take its sentences from the shared design package").toContain("import ConchDesign\n");
    const receipt = join(root_, "InjectReceipt.swift");
    writeFileSync(receipt, app.replace("import ConchDesign\n", ""));
    const reasons = [...injectReasons(), ...DEAD_TARGET_REASONS];
    expect(reasons).toContain("system-dialog-blocking");
    // A reason with no sentence reaches the phone as a bare "Not delivered.": a wasted fact.
    const undelivered = reasons.map((reason) =>
      `precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, reason })}) != .failed("Not delivered."), ${swift(reason)})`
    );
    // Neither confirmed nor refused: every one of these keeps the words in the draft.
    const unconfirmed = ["", "{}", "null", "oops",
      JSON.stringify({ kind: "ack" }),
      JSON.stringify({ kind: "inject-done" }),
      JSON.stringify({ kind: "inject-done", delivered: 1 }),
      JSON.stringify({ kind: "inject-done", delivered: true, staged: true }),
      JSON.stringify({ kind: "inject-done", delivered: false, reason: "system-dialog-blocking" }),
      JSON.stringify({ kind: "inject-done", delivered: false, reason: "not-a-reason-conch-knows" }),
    ].map(swift).join(", ");

    writeFileSync(harness, `import Foundation
func receipt(_ text: String) -> InjectReceipt { InjectReceipt.decode(status: 200, body: Data(text.utf8)) }

${undelivered.join("\n")}

// A cause conch is not sure of is never invented.
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, reason: "delivery-fell-over" })}) == .failed("Not delivered."))

// The draft survives anything short of an explicit submission receipt.
for text in [${unconfirmed}] {
  let outcome = receipt(text)
  precondition(!outcome.confirmed, text)
  precondition(outcome.remainingDraft("fixture words plus new words", sent: "fixture words") == "fixture words plus new words", text)
}
// Accepted is NOT sent. The daemon answers it after twenty seconds with the delivery still
// running, so the words have to stay exactly where an unsent word lives until something
// PROVES they landed. Clearing them here is the lie Tyler hit: a message that never arrived,
// reported as delivered, with the draft already gone.
precondition(InjectReceipt.accepted.remainingDraft("fixture words plus new words", sent: "fixture words")
  == "fixture words plus new words")
precondition(!InjectReceipt.accepted.confirmed)
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: true })}) == .delivered)
precondition(receipt(${receiptJSON({ kind: "inject-accepted" })}) == .accepted)
let staged = receipt(${receiptJSON({ kind: "inject-done", delivered: false, staged: true })})
precondition(staged == .staged && !staged.confirmed)
precondition(staged.remainingDraft("fixture words", sent: "fixture words") == "fixture words")
precondition(InjectReceipt.delivered.remainingDraft("fixture words plus new words", sent: "fixture words") == "plus new words")
precondition(InjectReceipt.delivered.remainingDraft("edited while waiting", sent: "fixture words") == "edited while waiting")
precondition(!InjectReceipt.decode(status: 502, body: Data()).confirmed)

// Not hearing is NOT a refusal. A relay hiccup, an unreadable answer, or no answer at all
// leaves the send open, so the receipt the daemon publishes afterwards can still settle it.
// Treating these as failure is what made a message that landed show as failed for good.
precondition(InjectReceipt.decode(status: 502, body: Data()).deliveryState.isTerminal == false)
precondition(receipt("oops").deliveryState.isTerminal == false)
precondition(!receipt("oops").deliveryState.clearsDraft)
precondition(receipt(${receiptJSON({ kind: "ack" })}).deliveryState.isTerminal == false)

// A rejection the Mac actually named stays final: nothing may quietly upgrade it.
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, reason: "system-dialog-blocking" })}).deliveryState.isTerminal)
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: true })}).deliveryState.isTerminal)

print("receipt and draft assertions passed")
`);
    const compiler = Bun.spawn([
      "swiftc", join(root, "design/ConchDesign/Sources/ConchDesign/SendFailure.swift"),
      join(root, "design/ConchDesign/Sources/ConchDesign/DeliveryOutbox.swift"), receipt, harness, "-o", binary,
    ], { stdout: "pipe", stderr: "pipe" });
    const diagnostics = await new Response(compiler.stderr).text();
    expect(await compiler.exited, diagnostics).toBe(0);
    const run = Bun.spawn([binary], { stdout: "pipe", stderr: "pipe" });
    expect(await run.exited, await new Response(run.stderr).text()).toBe(0);
    expect(await new Response(run.stdout).text()).toContain("receipt and draft assertions passed");
  } finally { rmSync(root_, { recursive: true, force: true }); }
}, 300_000);

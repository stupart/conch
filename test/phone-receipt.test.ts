import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/**
 * What the phone actually says when a send doesn't land, for every reason the Mac can name.
 *
 * On 2026-09-16 a modal dialog was open on Tyler's Mac, so every AppleScript call conch made
 * was swallowed. Three messages from his phone fell back to the Mac's clipboard and the phone
 * showed a bare failure: no cause, and no hint that his words were sitting on a machine he was
 * nowhere near. The daemon knew exactly why the whole time.
 *
 * The sentences live in ConchDesign (`ConchSendFailure`) so the Mac app shows the same ones.
 * This is the table pinned against the daemon's own reasons, end to end from the wire.
 */
const SENTENCES: Record<string, string> = {
  "system-dialog-blocking": "Not delivered — a dialog is open on your Mac and it's blocking conch. Dismiss it and send again.",
  "automation-permission-denied": "Not delivered — macOS is blocking conch from controlling Terminal. Turn conch on under Privacy & Security → Automation.",
  "window-not-focusable": "Not delivered — couldn't reach that session's window.",
  "clipboard-fallback": "Not delivered — couldn't reach that session's window.",
  "session-not-routable": "Not delivered — conch can't tell which window that session is in.",
  "front-window-changed": "Not delivered — another window came to the front on your Mac, so conch stopped typing.",
  "keystroke-fallback-off": "Not delivered — conch is set not to type into windows, and that session isn't in a tmux pane.",
  "clipboard-changed": "Not delivered — something else copied on your Mac mid-send, so conch stopped.",
  "clipboard-unavailable": "Not delivered — conch couldn't use the Mac's clipboard.",
  "clipboard-unpreservable": "Not delivered — something on your Mac's clipboard can't be put back, so conch left it alone. Copy something else and send again.",
  "automation-failed": "Not delivered — the Mac wouldn't let conch type into that session.",
  "delivery-failed": "Not delivered — the Mac wouldn't let conch type into that session.",
  "transport-error": "Not delivered — the Mac wouldn't let conch type into that session.",
  "submit-failed": "Not delivered — the words went in but the Return didn't.",
  "submit-error": "Not delivered — the words went in but the Return didn't.",
  "delivery-unconfirmed": "Not delivered — conch typed it but the session never took it.",
  "delivery-unattributed": "Not delivered — another window shares this session, so conch can't tell whether it landed.",
  "delivery-interrupted": "Not delivered — the send was stopped before it went in.",
};

/** Every reason `injectText` itself can report, read from the daemon's own source. */
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

/**
 * The table cannot quietly fall behind the daemon. A new reason in `src/inject.ts` with no
 * sentence here would reach the phone as "Not delivered" — honest, but a wasted fact.
 */
test("every reason the daemon can name has a sentence for the phone", () => {
  const reasons = injectReasons();
  expect(reasons).toContain("system-dialog-blocking");
  expect(reasons).toContain("automation-permission-denied");
  expect(reasons.length).toBeGreaterThanOrEqual(10);
  for (const reason of reasons) {
    expect(SENTENCES[reason], `src/inject.ts can report "${reason}" and no sentence says so`).toBeTruthy();
  }
});

test("the Swift receipt parser turns the Mac's reason into the sentence, and keeps the draft", async () => {
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
    const undelivered = Object.entries(SENTENCES).map(([reason, sentence]) =>
      `precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, reason })}) == .failed(${swift(sentence)}), ${swift(reason)})`
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

// Where the words ended up is part of the answer: on the Mac's clipboard they are a paste
// away, and saying so is the difference between a lost message and a recoverable one.
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, reason: "window-not-focusable", onClipboard: true })})
  == .failed(${swift("Not delivered — couldn't reach that session's window. Your words are on the Mac's clipboard.")}))
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, onClipboard: true })})
  == .failed(${swift("Not delivered. Your words are on the Mac's clipboard.")}))

// A cause conch is not sure of is never invented — an unknown reason, and no reason at all,
// say the same thing and nothing more.
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false, reason: "delivery-fell-over" })}) == .failed("Not delivered."))
precondition(receipt(${receiptJSON({ kind: "inject-done", delivered: false })}) == .failed("Not delivered."))

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

/**
 * The seam Codex found: a phone request that never comes back says nothing about whether the
 * Mac typed the message. Classifying that as failure made it terminal, and a terminal entry
 * refuses the authoritative outcome that arrives later — so a message that landed sat there
 * failed, with its words stuck in the draft.
 */
test("a send whose answer never arrived stays open, and keeps its pictures", () => {
  const bridge = readFileSync(join(root, "mobile/conch-ios/conch-ios/BridgeClient.swift"), "utf8");
  expect(bridge).toContain('return .unknown("Not confirmed — \\(error.localizedDescription) Your words are kept.")');
  expect(bridge).not.toContain('return .failed("Not delivered — \\(error.localizedDescription)")');

  // Uncertainty must keep the attachments too: clearing them would make the retry send the
  // words without the pictures, for a message that may never have arrived.
  const session = readFileSync(join(root, "mobile/conch-ios/conch-ios/SessionView.swift"), "utf8");
  expect(session).toMatch(/case \.unknown:[\s\S]{0,200}?break/);
});

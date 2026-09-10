# Control server extraction — cut three

`src/control-server.ts` now owns the Unix control socket: framing, parsing,
classification, settings/turn validation, inject scoping, dispatch, response
serialization, and explicit `start()` / `close()` lifecycle. Listening checks,
stale-path removal and mode `0600` live behind that lifecycle. The daemon keeps
signals, exit decisions and its shutdown ordering.

The boundary takes a socket path, an opaque owner token, logging, two local
session reads (`resolve` and `current`), and five typed application entries:
configuration, session, runtime, turn and device. Requests entering those five
methods are decoded. Accepted turns are delivered synchronously and receive an
empty response without waiting for injection or interrupt completion.

Socket dispatch helpers, turn validators, inject scoping, targeted audio
enrichment and the listener probe moved with the socket. Their existing
`daemon.ts` exports remain re-exports. The extracted module does not import the
daemon façade. Settings validation still uses `settings.ts`; auxiliary device
decoding preserves the previous coercions, defaults and truncation lengths.

The daemon still owns configuration application, the shared session controller
and pause lifetime, process/UI operations, queue and immediate turn handling,
recorders, speech, dictation, all phone latch transitions and disconnect
cleanup, the wake backstop and `reconnectNow()`, and complete device actions.
Selecting phone audio still cancels speech, pending audio and recording before
changing the sink. `AudioSinkLease`, `forgetGone`, completeness and publication
ownership were not changed. Stop still uses `busy() || capturing()` at the
socket and the equivalent predicate at the physical key.

## Reserved C9b routing boundary

The optional wrapper is separate from every legacy body:

```json
{
  "kind": "control-envelope",
  "ownerDeviceId": "opaque-owner",
  "body": { "type": "wake", "sessionId": "local-key" }
}
```

Missing owner or this daemon's owner proceeds through ordinary local handling.
An explicit foreign owner receives
`{kind: "routing-error", code: "foreign-owner", ownerDeviceId, error}` before
any address, publication or canonical metadata read, or application dispatch.
An owner of the wrong type receives `code: "invalid-envelope"`.

Existing clients send unwrapped bodies and are unchanged. There is no remote
routing, broadcast, cross-device ledger key, or combined published document.
The daemon supplies a process-local random owner token; persistent device
identity remains for C9b. `ControlSessionReference` reserves
`{ownerDeviceId, localSessionKey}` for a later phone speech report while the
current decoder continues accepting only its label. Labels are presentation;
`sessionId` remains the local address, distinct from `agentSessionId`.

## Verification

- Before extraction: `bun test` — **1,211 pass, 0 fail**.
- Final restored source: `bun test` — **1,233 pass, 0 fail**, 127 files,
  5,264 assertions. This includes the project typecheck test.
- `bun run typecheck` was also run during extraction; its façade imports were
  checked along with the new module. No dependencies were added.
- The 22 new tests use real Unix sockets under short temporary `/tmp` paths
  and a stub recording all five application entries. They also cover local
  address resolution, canonical inject scoping, invalid/unpublished input,
  permissive device decoding, stale sockets, permissions and live ownership.
- Retargeted the requested source guards and the additional moved dispatcher
  marker in `mic-open-latency.test.ts`. New slice/order checks establish marker
  presence first. Existing behavior assertions did not need changing.

Each mutation below was applied alone, its targeted test was run with
`bun test test/control-server.test.ts -t <test name>`, and the original source
was restored. **All 19 mutations were caught with exit code 1.** The full suite
above ran after the final restoration.

| Mutation | Failing executable test / observed failure |
| --- | --- |
| Disable newline dispatch | Newline framing: timed out waiting for the response. |
| Check the cap before appending | Oversized frame: received a configuration reply instead of an empty connection close. |
| Do not destroy an oversized connection | Oversized frame: response timed out. |
| Replace destroy with FIN (`sock.end`) | Oversized frame: server close timed out while the client kept its write half open. |
| Reject `>= 64_000` instead of `> 64_000` | Exact-cap test: the valid 64,000-character frame returned empty data instead of the configuration reply. |
| Dispatch every line in one frame | Newline framing: the second device request was delivered. |
| Remove the handled guard from incoming data | Pending runtime request: later oversized data destroyed the connection and its expected reply was empty. |
| Disable `allowHalfOpen` | Buffered EOF request: the delayed runtime reply was empty. |
| Discard the buffered EOF request | EOF test: timed out waiting for runtime dispatch. |
| Leave empty EOF connections open | Empty and whitespace EOF tests: response timed out. |
| Await turn completion | Accepted-turn test: response timed out on the pending completion promise. |
| Return JSON acknowledgement for an accepted turn | Accepted-turn test: acknowledgement differed from the required empty reply. |
| Defer turn delivery to a microtask | Accepted-turn test: synchronous delivery checkpoint recorded `0` instead of `1`. |
| Let foreign envelopes fall through | Foreign-owner tests: ordinary/empty replies replaced the typed refusal. |
| Consult local readers before checking owner | Foreign-owner tests: both reader call records were nonempty despite the correct refusal. |
| Refuse the local owner too | Local-envelope test: refusal differed from the equivalent legacy response. |
| Make `close()` a no-op | Close/rebind test: the socket path still existed after close. |
| Skip stale-path cleanup | Lifecycle test: start failed with `EADDRINUSE`. |
| Skip mode `0600` | Lifecycle test: socket permissions differed from `0600`. |

## Findings preserved, not fixed

**A14:** inject and interrupt still enter `handle` immediately and reset the
shared `stopKey` / `micOpen` state. Delivery and interrupt failure paths can
call `speak`. Extraction does not fix that race or promise those paths produce
no speech; only their accepted socket response is empty and does not wait for
completion.

**Oversized-frame EOF dispatch on Bun 1.4.0 (`34cbb9a40`):** the original
`sock.destroy()` path can emit `end` with `sock.destroyed === true`. Because
the unchanged EOF handler still has `handled === false`, it can parse and
dispatch buffered JSON after destruction. A 64,001-character frame consisting
of `{"kind":"get-config"}`, padding spaces and a newline reproduced this with
the original handler: `destroy 64001 → end true → dispatch get-config`, while
the client received no bytes. A parseable oversized mutation request could
therefore still reach application logic without receiving an acknowledgement.
The extraction preserves that behavior. The cap test proves append-before-cap,
actual destruction (not just FIN), and no wire reply; it deliberately does not
claim destruction prevents this existing EOF dispatch.

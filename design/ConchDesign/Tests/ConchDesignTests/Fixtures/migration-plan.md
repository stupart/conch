---
type: document
title: Morrow — module and migration plan
status: proposal
created: 2026-09-20
---

# Module and migration plan

This is the proposed implementation sequence after review. Importing past events is out of scope. No phase silently enables automatic rescheduling, new notification types, provider write-back or production migrations. A phase passing local tests is not permission to skip its deployment gate.

## Dependency and repository shape

```text
Morrow repository (incremental target)
  apps/web/                    browser application; independent build/tests
  apps/booking/                public booking pages; read-mostly client
  packages/contracts/          public schemas, compatibility versions, fixtures
  packages/scheduling/         existing portable domain, preserved behavior
  packages/morrow-client/      transport and operations; compatible exports
  packages/recurrence/         rule expansion and exception handling
  server/modules/
    identity-policy/          authenticated principals and resource decisions
    commands/                 receipts, preconditions, transactional execution
    events/                   append/read/publication contract
    calendars/                stable IDs, revisions, move/restore lifecycle
    projections/              agendas, free/busy, deterministic rebuild
    holds/                    tentative claims on time and their expiry
    rescheduling/             proposals, approvals and run records
    execution/                jobs, leases, budgets, effect receipts
    providers/                later connector/version/retention intake
  server/adapters/             HTTP and persistence implementation
  migrations/                 one existing migration lineage, kept in place
  tests/{contract,integration,replay,fixtures}/
  scripts/{read-only,fixtures,admin}/
  docs/{architecture,decisions,operations}/

Phone repository             existing iOS and Android apps, offline queue
Booking widget repository    embeddable picker for other people's sites
```

This is a dependency map, not a bulk move checklist. Keep existing paths until extracting a tested unit earns the move. Pure domain and contract code imports no HTTP, database, filesystem or credential code. Application modules depend on explicit transaction, query and clock interfaces. Adapters implement them. Enforce import boundaries in CI and make startup an explicit composition root; importing a module must not start a reminder job.

Use the existing client export surface as a compatibility bridge rather than forcing every consumer to rename packages at once. Publish and pin a client release. A release manifest records the release ID, source commits, API compatibility range and the schema version each client expects. Upgrade and rollback install atomically while existing sessions keep the version they started with. No new package exists solely to make the folder tree look modular.

## Route-specific dependency gates

The phases below organize related work, not one all-or-nothing platform rewrite. Deliver narrow useful slices as soon as their dependencies are proved.

| Slice | Must be proved first | Not a prerequisite / claim limit |
| --- | --- | --- |
| Owner-only calendar view | Inert harness; authenticated owner identity; side-effect-free reads; consistent event ID and revision references; explicit unavailable or stale results; no private data in logs | Does not require every sync repair, connector tables or the new sharing policy. Uses existing personal access and makes no promise about shared calendars or live provider freshness |
| Delegated assistant access | Policy across every reachable direct, derived and legacy read and write route, cache and revocation tests, explicit denial | Cannot bypass policy through a broad legacy token or an unguarded internal route |
| Guarded event edit | Consistent read and compare-and-set on revisions; editor generation and conflict tests | Does not require a job scheduler, booking pages or generalized approvals |
| Booking and holds | Command receipts, authoritative preconditions, ordered hold/booking/worker effects, relevant released-client fixtures | Existing booking links keep working; new holds are additive |
| Automatic rescheduling | Resource policy, persisted bounded assignment, evidence manifest, lease fencing, checked effect receipts and recovery | A setting that says "allowed" does not implement responsibility or execution |

The first agenda response uses a tagged citation such as `{kind: "event_revision", eventId, revisionId, calendarAtRead}`. Provider version citations can be added later. Initial missing-input reporting covers requested calendars that are absent, denied or unavailable; it must not invent coverage of calendars nobody connected.

## Contracts each module must prove

| Module | Inputs → result | Essential invariants and tests |
| --- | --- | --- |
| Identity/policy | authenticated principal + action/resource + policy version → decision | Account isolation, revocation, all read variants, derived-data audience, no self-asserted privilege |
| Commands | intent + existing request identity + expected state → stable committed receipt | Same retry returns the same IDs and results; conflicting reuse rejected; a concurrent stale action fails consistently |
| Events | validated envelope + transaction → ordered append/read | Per-account sequence intact; durable wakeup publication; existing upload envelopes and side effects preserved |
| Calendars | event ID + expected revision + edit → revision receipt | Consistent field/revision pair; atomic compare-and-set; create/delete/restore/move races; history continuity |
| Recurrence | series rule + exceptions + window → expanded instances | Exceptions keep their identity across series edits; daylight-saving transitions; all-day and floating events |
| Projections | versioned ordered input prefix → agenda + watermark | Full replay equals incremental; no skipped prerequisites; a stale worker cannot publish |
| Holds | slot + expiry + requester → hold receipt | Expired holds release once; two guests cannot book the same slot; a released hold cannot be confirmed |
| Rescheduling | assignment + evidence manifest → proposal/run/effects | Duties do not grant permission; review requirements explicit; per-effect idempotency; partial apply visible |
| Execution | trigger + lease generation + budget → bounded run outcome | A lost lease cancels or fences writes; a crash resumes safely; provider failures contained |
| Web | session + event/edit generation + response → next UI state | Late responses cannot overwrite another event, account or newer edit; offline conflicts preserve work |
| Providers, later | allowed provider version + sync token → durable intake receipt | Snapshot and live overlap safe; dedup preserves distinct events; deletion and retention explicit |

Do not try to make all modules share one universal envelope or one generic "write object" API. Scheduling intent, event revisions, provider intake and run effects have different authorization and concurrency requirements. They can share transaction, policy and outbox primitives where the semantics match.

## Phase 0 — Freeze evidence and create an inert compatibility harness

Deliverables: a release and runtime manifest, the current route inventory, immutable synthetic fixtures from the released phone encoders and decoders, explicit test composition, a disposable database setup, and a reviewed list of in-flight branches. Record the backend commit, image digest, package versions, schema ledger and worker flags before any deploy. Public health checks and matching frontend assets are insufficient for that mapping. Establish which installed phone versions are supported using real adoption numbers; without them, do not assume older releases are retired merely because a new one is available.

The harness rejects non-allowlisted endpoints and database targets, uses disposable identities and stores, and does not read anyone's real credentials. Tests run without an implicit fallback to production configuration. API composition injects inert schedulers and notification senders; integration tests enable only the modules being exercised. Preserve the old phone protocol, including sign-in, recovery, push and calendar routes, not merely event commands.

**Acceptance:** fixture decoding and replay pass against the pinned baseline; production-host refusal and worker-inertness tests pass; server and client workspace tests are both enumerated; database skips cannot count as a green integration gate. This phase changes no shared behavior. It is the first build unit.

**Reviewable changes:** test infrastructure and characterization fixtures; pure module extraction only where the harness needs it.

## Phase 1 — Repair durable write and ordering guarantees

Split into independently reviewed changes with fault and concurrency tests before each implementation:

1. **Command receipts.** Store the normalized input fingerprint, generated IDs, event identities and response. Preserve account-wide legacy idempotency keys and phone retry behavior across token rotation. Replay and body/key conflict tests include generated IDs, a lost response and multi-event commands.
2. **Ordered authoritative execution.** Coordinate command, upload and worker writes under one ordering and transaction strategy. A per-account lock is an acceptable first simplification. Evaluate command preconditions against complete authoritative state inside that boundary. Write the precise transaction design before coding.
3. **Event compare-and-set and lifecycle outbox.** Make field and revision reads consistent, use transaction-local revision checks, return stable conflict errors, and commit notification intent atomically. Preserve revision IDs and history. Test create, update, delete, restore and process failures before and after commit.
4. **Projection and stream repair.** Ensure replay never skips missing prerequisites. Treat push notifications as wakeups for ordered durable reads, with periodic catch-up and bounded slow-consumer handling. Do not infer missing events from gaps in a date-filtered sequence.

Before Phase 1 behavioral coding, approve one concrete transaction design: lock key and acquisition order, isolation level, authoritative state source, transaction handle propagation, event allocation and commit point. Enumerate internal helpers, connectors and administrative writers as well as HTTP paths. Never hold this lock during provider calls, email sends or unbounded agenda rebuilds. Receipt design must specify in-progress and committed state, normalization, key retention and authorization; expiry must not allow an old offline retry to create a second event.

The deployment transition is part of correctness. Test a request committed by the old server whose response is lost, followed by a retry on the new server with no new-format receipt; link legacy effects using stable identity evidence rather than inventing a second event. Ambiguous historical matches must surface as unresolved, not be guessed from titles or times. Exercise simultaneous old and new writers and a rollback to writers that ignore the new protocol.

**Acceptance:** forced interleavings and crash boundaries produce a complete, reproducible final state; lost responses retry to the same result; replay matches rebuilt projections; released phone fixtures remain valid. New tables and columns are additive; the old server must still run on the expanded schema. Test migration lock duration on realistic synthetic volume.

**Deployment:** separate rollout from code extraction. No bundling with UI work or sign-in changes. Establish a rollback image compatible with the expanded schema; monitor command errors, retries and duplicates, projection lag, push catch-up and database pressure. A rollback cannot unsend an invitation.

## Phase 2 — Establish policy and supported client ownership

Create resource and action policy and trustworthy authenticated provenance inside application services. Cover direct, list, search, batch, history, free/busy and agenda outputs, commands, uploads, workers and moves. Keep client-declared source fields where existing phones rely on them, but separate claimed origin from authenticated actor and never use a writable label as permission.

Run policy in observation mode for existing trusted clients first. Enforce fail-closed behavior for newly restricted clients only after route coverage; compatibility policy explicitly preserves supported phone behavior. A newly restricted assistant cannot fall back to an unrestricted legacy route.

Specify whether a read returns stale-but-disclosed output, queues a rebuild, or calls a narrowly authorized internal materializer. A read grant must not indirectly become broad write permission. Recheck delegated authority and revocation at the effect boundary; a worker's infrastructure credential does not replace the caller's narrower grant. Derived outputs carry source revisions and audience constraints.

**Acceptance:** denied events are absent from search, free/busy, history and cached agendas; revocation and account switch invalidate managed access; policies survive alternate route attempts; old phone fixtures still pass. Do not advertise shared-calendar isolation until these tests pass.

## Phase 3 — Deliver one complete calendar workflow

Use existing calendars; no import dependency. Add policy-aware paginated reads, stable identities, revision history, recurrence exceptions and a small agenda API returning source versions, freshness and missing inputs. Generated agendas derive from authoritative events; they never become another independently maintained truth.

Build `apps/web` as a client of those contracts. Start with sign-in, the week view, event detail and history, and a tested editor state machine. Add visible focus protection and booking links as their services become available. Keep the old surface until the new one covers the workflows people use.

**Acceptance:** on a fresh laptop and phone, a person can see every event with its exact revision, edit one, recover a conflict, and see recurrence exceptions behave. Test late saves, account switches, poor networks, offline conflicts, more than 2,000 events, deleted and renamed calendars and permission changes. This is the first complete product milestone; avoid delaying it for a universal sharing UI or a connector marketplace.

Read-only prototypes can be developed against fixtures alongside earlier phases. Production claims still wait for the relevant correctness and policy gates. Parallel development is not a license to weaken those dependencies.

## Phase 4 — Rescheduling, first as proposals

Represent assignment scope, allowed kinds of moves, notice periods, budget, review rule and escalation. Grants remain separate. Each run records a unique ID, input manifest, rule versions, proposals and per-effect outcomes. A confident score does not make a move accepted.

A run receives approved evidence or a restricted read adapter and returns proposals through its result channel. It cannot reach a write-capable route outside its contract. The executor rechecks permission, lease generation, expected revision and ownership before each effect; partially applied work remains visible and resumable. A stale lease cannot publish even if its computation finishes later.

First useful task: propose moving one meeting out of a protected focus block, with a reason the organizer can read. Approved or pre-authorized bounded execution follows proven proposal behavior.

**Acceptance:** missing evidence never becomes "nothing to move"; malformed output cannot write; concurrent phone edits survive; retries do not duplicate effects; lease loss, stale revisions, revocation, partial apply, provider timeouts and Sydney/Los Angeles day boundaries are covered.

## Phase 5 — Expand providers and optional surfaces

After the above works, implement one provider adapter against the versioned intake contract. Keep provider data, Morrow's interpretation and delivered agendas separate. Expose connector health and resumable checkpoints.

Importing history remains deferred until someone asks for it. This phase's tests use synthetic providers. A desktop widget or menu bar view uses base revisions, stable IDs and conflict handling; it does not become a second source of truth.

**Acceptance:** duplicate and reordered batches, restarts, snapshot-plus-live changes, provider corrections and deletions, two-device copies, retention, permission changes and attachment unavailability are handled without phantom events. Resource limits protect the shared database from intake pressure.

## Release gates that apply across phases

Before production behavior changes, run the [phone fixture matrix](phone-compatibility-audit.md): all command kinds, encoding and response shapes, pagination 0/1/500/501+, interleaved days, lost responses, full replay, deleted and restored events, recurrence exceptions, attendees, identity recovery, push and calendar routes, concurrent edits and time zones.

Roll out expand-only schema, then candidate behavior behind explicit controls to internal accounts, then broader adoption after monitored gates. Record exact image, schema and flag combinations and old-server compatibility. Stop on changed account ownership, duplicate effects, unexpected events, lost pending work, decode failures or unacceptable query pressure.

Rollback disables new workers and writers first, then restores the compatible old behavior. Preserve accepted revisions, checkpoints and events. Image rollback does not unsend notifications or undo revocations; those need reviewed compensation. Never restore a whole old database over later legitimate phone activity.

## Retirement and documentation discipline

Retire a path only with a named successor, a known consumer inventory, replay or contract equivalence where relevant, a rollback window and a migration note. Candidates include the old reminder scheduler, the legacy booking endpoint and duplicated vendored packages. Keep compatibility adapters until unsupported usage is proved, not assumed.

Maintain one repository architecture entrypoint, concise decision records, an operations runbook and a release manifest. Link to exact commits and accepted decisions, and explicitly mark superseded guidance. Do not create competing "current" documents.

No fixed calendar estimate is justified yet. Phase exits are evidence-based, and each PR should have one behavior or invariant, its meaningful tests and a rollback note where relevant. The next build should start with Phase 0, not a wholesale filesystem rewrite.

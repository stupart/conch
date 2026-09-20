---
type: document
title: Atlas and Nura — module and migration plan
status: proposal
created: 2026-09-20
---

# Module and migration plan

This is the proposed implementation sequence after review. Backfilling personal context is out of scope. No phase silently enables dream, notifications, resummarization, connectors or production migrations. A phase passing local tests is not permission to skip its deployment gate.

## Dependency and repository shape

```text
Atlas repository (incremental target)
  apps/web/                    browser application; independent build/tests
  packages/contracts/          public schemas, compatibility versions, fixtures
  packages/dayloop-domain/     existing portable domain, preserved behavior
  packages/atlas-client/       transport and operations; compatible @atlas/core exports
  packages/atlas-mcp/          supported tools plus explicit legacy adapter
  plugins/atlas/               host manifests, skills, immutable runtime packaging
  server/modules/
    identity-policy/          authenticated principals and resource decisions
    commands/                 receipts, preconditions, transactional execution
    events/                   append/read/publication contract
    vault/                    stable IDs, revisions, move/restore lifecycle
    projections/              deterministic rebuild and fenced publication
    knowledge/                query, relationships, context delivery
    stewardship/              duties, proposals, acceptance and run records
    execution/                jobs, leases, budgets, effect receipts
    sources/                  later connector/version/retention intake
  server/adapters/             HTTP and persistence implementation
  drizzle/                    one existing migration lineage, kept in place
  tests/{contract,integration,replay,fixtures}/
  scripts/{read-only,fixtures,admin}/
  docs/{architecture,decisions,operations}/

Nura repository              assistant package, workflow stages, runner adapters
Conch repository             existing capture/control plus optional future exporter
DayLoop repository           existing app; compatibility harness independent of live install
```

This is a dependency map, not a bulk move checklist. Keep existing paths until extracting a tested unit earns the move. Pure domain/contracts import no HTTP, database, filesystem, model or credential code. Application modules depend on explicit transaction/query/model/clock interfaces. Adapters implement them. Enforce import boundaries in CI and make startup an explicit composition root; importing a module must not start a scheduler.

Use the existing `@atlas/core` export surface as a compatibility bridge rather than forcing every consumer to rename packages at once. Publish/pin a client release and generate a self-contained plugin artifact. A release manifest records canonical release ID, runtime content hash, source commits, SDK/API compatibility range, tool-catalog digest and per-host wrapper version. Wrapper cache-busting versions and protocol versions may legitimately differ; both hosts must resolve to the same declared immutable runtime. Upgrade/rollback installs atomically while existing sessions retain their known version. Never launch a mutable development source path or silently fall back to Nura/another host's credentials. Nura consumes that client and owns Nura-specific workflows. No new package exists solely to make the folder tree look modular.

## Route-specific dependency gates

The phases below organize related work, not one all-or-nothing platform rewrite. Deliver narrow useful slices as soon as their dependencies are proved.

| Slice | Must be proved first | Not a prerequisite / claim limit |
| --- | --- | --- |
| Owner-only document context | Inert harness; authenticated owner identity; non-materializing reads; consistent Vault ID/revision references; explicit unavailable/stale results; no private data in logs | Does not require all DayLoop write repairs, connector tables or new restricted-agent policy. Uses existing broad personal access and makes no project-isolation or live-day freshness promise |
| Restricted-agent context | Policy across every reachable direct/derived/legacy read and write route, cache/revocation tests, explicit denial | Cannot bypass policy through a broad legacy token or an unguarded MCP tool |
| Human guarded wiki edit | Vault consistent read/CAS and required lifecycle guarantees; editor/session generation and conflict tests | Does not require a scheduler, Nura or generalized assignments |
| Shared-day/domain writes | Command receipts, authoritative preconditions, ordered raw/command/worker effects, relevant released-client fixtures | Current domain is event-owned; explicit commands and authenticated legacy raw uploads remain supported |
| Automated stewardship | Resource policy, persisted bounded assignment, evidence manifest, lease fencing, checked effect receipts and recovery | An owner label or permission does not implement responsibility/execution |

The first context response uses a tagged citation such as `{kind: "vault_revision", documentId, revisionId, pathAtRead}`. Connector source-version citations can be added later. Initial missing-input reporting covers requested documents that are absent, denied or unavailable; it must not invent coverage of unconnected chats/files. Start with an on-demand orientation composed from those exact revisions. If a maintained orientation document is later added, give it one canonical ID and explicit dependencies rather than storing competing summaries.

## Contracts each module must prove

| Module | Inputs → result | Essential invariants and tests |
| --- | --- | --- |
| Identity/policy | authenticated principal + action/resource + policy version → decision | Tenant isolation, revocation, all read variants, derived-data audience, no self-asserted privilege |
| Commands | intent + existing request identity + expected state → stable committed receipt | Same retry returns same IDs/results; conflicting reuse rejected; concurrent stale action fails consistently; existing event dedup keys preserved |
| Events | validated envelope + transaction → ordered append/read | Tenant sequence/idempotency intact; durable wakeup publication; existing raw-upload envelopes and side effects preserved |
| Vault | document ID + expected revision + edit → revision/lifecycle receipt | Consistent content/revision pair; atomic CAS; create/delete/restore/move races; lifecycle outbox; history continuity |
| Projections | versioned ordered input prefix → output + watermark | Full replay equals incremental; no skipped prerequisites; stale worker cannot publish; bindings identify exact document revision |
| Knowledge/context | principal + project/task/budget + optional continuation → cited context | Only visible evidence; exact revisions; accepted/superseded status; missing/lagging sources explicit; stable pagination |
| Stewardship | assignment + evidence manifest → proposal/run/effects | Duties do not grant permission; review requirements explicit; per-effect idempotency; partial apply visible |
| Execution | trigger + lease generation + budget → bounded run outcome | Lost lease cancels/fences writes; crash resumes safely; terminal attempt recovery; model/provider failure contained |
| Web | session + document/edit generation + response → next UI state | Late responses cannot overwrite another document/account/newer edits; offline conflicts preserve work |
| Plugin | installed artifact + profile → supported tool session | Missing/wrong/revoked identity fails clearly; no side effects at startup; install/update/rollback reproducible |
| Sources, later | allowed source version + checkpoint → durable intake receipt | Snapshot/live overlap safe; dedup preserves distinct objects; no task events; retention/invalidation; explicit coverage |

Do not try to make all modules share one universal event envelope or one generic “write object” API. Domain intent, document revisions, source intake and run effects have different authorization and concurrency requirements. They can share transaction, policy and outbox primitives where semantics match.

## Phase 0 — Freeze evidence and create an inert compatibility harness

Deliverables: release/source/runtime manifest, current route/producer inventory, immutable synthetic fixtures from released Swift encoders/decoders/reducers, explicit test composition, disposable Postgres setup, and a reviewed inventory of dirty pairing changes. Record backend commit/image digest/Fly release, Node/package versions, schema ledger and worker flags before any deploy. Public health checks and matching frontend assets are insufficient for that mapping. Establish which installed-client cohorts are supported using available release/adoption evidence; absent adoption evidence, do not assume older releases are retired merely because 1.2.0 is available. Map each supported cohort to source and fixtures, recording unknown provenance as an open gate.

The harness rejects non-allowlisted endpoints and database targets, uses disposable identities/stores, and does not read personal Keychain or home-directory defaults. Tests run without implicit dotenv production fallback. API composition injects inert schedulers/models/notifications; integration tests enable only the modules being exercised. Preserve the old phone protocol, including auth/recovery/account/push/calendar/analytics routes, not merely task commands.

**Acceptance:** fixture decoding and replay pass against the pinned baseline; production-host refusal and worker-inertness tests pass; root/server and client workspace tests are both enumerated; database skips cannot count as a green integration gate. This phase changes no shared behavior. It is the first build unit.

**Reviewable changes:** test infrastructure and characterization fixtures; pure module extraction only if needed by the harness. Keep pairing work on its own branch and review its old-device behavior separately.

## Phase 1 — Repair durable write and ordering guarantees

Split into independently reviewed changes with fault/concurrency tests before each implementation:

1. **Command receipts.** Store normalized input fingerprint, canonical generated IDs, event identities and response. Preserve tenant-wide legacy event idempotency keys and phone retry behavior across token rotation. Authorization of receipt retrieval is separate from the dedup identity; do not accidentally change dedup scope by token/principal migration. Replay and body/key conflict tests include generated IDs, lost response, multi-event commands and command/raw overlap.
2. **Ordered authoritative execution.** Coordinate relevant command, raw-event and worker writes under a shared ordering/transaction strategy. A per-user lock is an acceptable initial simplicity tradeoff. Evaluate command preconditions against complete authoritative state inside that boundary. Raw upload remains raw upload; do not replay it as a newly planned command or silently add command-only side effects. Choose synchronous transactional domain projections or locked ordered durable replay with authoritative command reads; write the precise transaction design before coding.
3. **Vault CAS and lifecycle outbox.** Make content/revision reads consistent, use transaction-local revision checks, return stable conflict errors, and commit lifecycle publication intent atomically. Preserve revision IDs and history. Test create/update/delete/restore and process failures before/after commit.
4. **Projection and stream repair.** Ensure replay never skips missing prerequisites; bind sidecars to exact output revision/version. Treat SSE notifications as wakeups for ordered durable reads, including periodic catch-up and bounded slow-consumer handling. Do not infer missing events from numerical gaps in a day-filtered sequence.

Before Phase 1 behavioral coding, approve one concrete transaction design: lock key/acquisition order, isolation level, authoritative state source, transaction handle propagation, event allocation and commit point. Enumerate internal append helpers, connectors and administrative writers as well as HTTP paths. Never hold this lock during model calls, external requests, SSE writes or unbounded markdown/index rebuilds. Avoid recursive appends through post-commit hooks. Receipt design must specify in-progress/committed state, normalization, key retention and authorization; expiry must not permit an old offline retry to create a second entity. Outbox design must distinguish revision commit/occurrence time from eventual event append/delivery order and define honest timeline cursors.

The deployment transition is part of correctness. Test a request committed by the old server whose response is lost, followed by a retry on the new server with no new-format receipt; link legacy durable effects using stable identity evidence rather than inventing a second generated entity. Ambiguous historical matches must surface as unresolved, not be guessed from titles/timestamps. Exercise simultaneous old/new writers and rollback to writers that ignore the new protocol. Select a compatibility bridge or a proved drain/fence procedure before activation. Schema compatibility alone is insufficient, and the plan must preserve phone queuing/retry behavior during any transition.

**Acceptance:** forced interleavings and crash boundaries produce a complete, reproducible final state; lost responses retry to the same result; replay matches rebuilt projections; v1 Swift fixtures remain valid. Known defective behavior is documented with an explicit intended correction, not blindly preserved because it is old. New tables/columns are additive; the old server must still run on expanded schema. Test migration lock duration/query pressure on isolated realistic synthetic volume.

**Deployment:** separate rollout from code extraction. No bundling with UI, auth pairing or Nura restart. Establish a rollback image compatible with expanded schema; monitor command/raw errors, retries/duplicates, projection lag, SSE catch-up and database pressure. A rollback cannot undo an already appended event.

## Phase 2 — Establish policy and supported client/tool ownership

Create resource/action policy and trustworthy authenticated provenance inside application services. Cover direct/list/search/batch/history/components/context/derived outputs, commands, raw events, workers and moves. Keep client-declared source fields where existing phones rely on them, but separate claimed origin from authenticated actor and do not use a writable label as permission.

Run policy in observation mode for existing trusted clients first. Enforce fail-closed behavior for new restricted clients only after route coverage; compatibility policy explicitly preserves supported phone behavior. Do not globally replace `kernel:*` or tighten device recovery as a side effect of agent grants. A newly restricted agent cannot fall back to an unrestricted legacy route.

Specify whether a read returns stale-but-disclosed output, queues a rebuild, or invokes a narrowly authorized internal materializer. A read grant must not indirectly become broad write permission. Recheck delegated authority/revocation at the effect boundary; a worker's infrastructure credential does not replace the caller's narrower grant. Derived outputs carry source revisions and audience constraints. Test same-title generated entities, renamed aliases, tombstones and generated-path prose; a blocked materialization must not publish new task-map/surface bindings for an uncommitted document revision.

Move generic Atlas tool definitions into Atlas ownership behind compatible adapters; add typed domain tools and truthful compound day reads. Retain raw-event capability only for clients that need it; ordinary agents receive intent tools. Split Nura notes/session/prompt functions from the generic default. Produce immutable versioned plugins with diagnostics and disposable-profile installation tests.

**Acceptance:** denied data is absent from snippets, graph edges, history and cached/derived context; revocation and account switch invalidate managed access; policies survive alternate route attempts; both host packages pass local HTTP conformance; old phone fixtures still pass. Do not advertise project-level isolation until these tests pass. Existing broad personal access can continue under its explicitly documented limits meanwhile.

## Phase 3 — Deliver one complete Atlas context/wiki workflow

Use existing project documents; no source import/backfill dependency. Add policy-aware paginated reads, stable identity/path aliases, revision history/diffs, status/supersession and a small context API returning source versions, freshness, missing inputs and a delivery receipt. Generated orientation derives from authoritative entities; it does not become another independently maintained truth.

Build `apps/web` as a client of those contracts. Start with connect/read/orient/history and a tested editor state machine. Add visible agent grants/responsibilities/outcomes as their services become available. Retain same-origin deployment initially; keep the old surface until the new one covers necessary workflows. Existing Nura conversation and daily-ingest routes remain inventoried compatibility adapters until explicitly retired.

Add host-specific project start/resume context adapters where supported. Skills remain useful guidance, while the adapter makes delivery explicit and reports stale/unavailable state. Cache by principal/policy/project/environment/source watermark, with bounded storage. No global personal prompt injection into unrelated work.

**Acceptance:** in a fresh Codex and Claude session, an agent can identify current accepted decisions with exact citations, disclose a superseded/unknown item, and retrieve only its permitted project. The user can inspect the same evidence and a guarded edit in the web UI. Test late-save/account/navigation races, poor network/offline conflicts, >500 documents, deleted/renamed references and source-policy changes. This is the first complete product milestone; avoid delaying it for a universal graph UI or connector marketplace.

Read-only context/UI prototypes can be developed against fixtures alongside earlier phases. Production claims and newly restricted principals still wait for the relevant correctness/policy gates. Parallel development is not a license to weaken those dependencies.

## Phase 4 — Stewardship and Nura, first as proposals

Represent assignment scope, allowed maintenance, required sources/freshness, cadence, budget, review rule and escalation. Grants remain separate. Each run records a unique ID, input manifest, stage versions and hashes, model/configuration identity, proposals and per-effect outcomes. A model's confidence does not make a decision accepted.

Port useful dream transforms behind injected clock/model/storage dependencies. Inference isolation specifies effective tools, reachable endpoints/credentials, input locations, output schema and cancellation. A stage receives approved evidence or a restricted read adapter and returns proposals through its result channel. It cannot inherit a shell reaching a write-capable CLI, unrelated MCP servers or the interactive host's broad token. Test that attempted out-of-contract effects are unavailable; prompts alone are insufficient. The executor rechecks permission, lease generation, expected revision and domain ownership before each effect; partially applied work remains visible and resumable. Implement budget admission and cancellation without blocking DayLoop capture. A stale lease cannot publish even if its model call finishes later.

First useful Nura task: propose a daily narrative/rolling-note or project orientation update from explicit current inputs. User-reviewed or pre-authorized bounded execution follows proven proposal behavior. Task/moment state remains event-owned, reached through explicit commands and retained authenticated legacy raw-event uploads. Do not copy the old shell script into a cloud cron job.

**Acceptance:** missing evidence never becomes “nothing happened”; malformed model output cannot write; concurrent phone edits survive; retries do not duplicate effects; multi-host lease loss, disk full, stale revisions, source revocation, partial apply, provider timeout and Sydney/Los Angeles day boundaries are covered. Review model quality on synthetic/de-identified fixtures with citations/invariants and human rubric, not brittle exact wording. Only then evaluate scheduled dream with one explicitly designated runner.

## Phase 5 — Expand sources and optional local surfaces

After the above product works, implement one source adapter against the versioned intake contract, preferably reusing Conch records. Add selected folder/artifact sources as needed. Keep evidence retention, model interpretation, accepted knowledge and delivered context separate. Captured/indexed/reviewed progress are distinct. Expose connector health and resumable checkpoints.

Historical backfill remains deferred until the user resumes that work. This phase's tests use synthetic sources. A future Finder view or project checkout uses base revisions, stable IDs, conflict handling and explicit direction; it does not revive the frozen mirror as authority. A separate sync product or native File Provider is optional future scope.

**Acceptance:** duplicate/reordered batches, restart, snapshot-plus-live changes, source correction/deletion, two-device copies, retention, permission changes and attachment unavailability are handled without task events or wiki fact promotion. Resource limits protect the shared database/API from ingestion pressure.

## Release gates that apply across phases

Before production behavior changes, use the [DayLoop fixture matrix](dayloop-compatibility-audit.md): all 19 command kinds and generated raw events, encoding/response shapes, pagination 0/1/500/501+, interleaved days, lost responses, full replay, tombstones and protected-delete interactions, visibility, local media references, multiple moments, plain completion, identity recovery, account/push/calendar/analytics routes, concurrent edits and time zones.

The normal Debug app can connect to production. DebugDev disables sync, so it is not a network compatibility harness. Base URL is absent from existing client cache identity. Use injected headless clients and ephemeral state; any later network-enabled app needs a separate bundle/keychain/storage namespace and disposable identity. No copying of real phone credentials/queues.

Roll out expand-only schema, then candidate behavior behind explicit controls to disposable/internal scopes, then broader adoption after monitored gates. Record exact image/schema/flag combinations and old-server compatibility. Stop on changed account ownership, duplicate effects, unexpected task events, lost pending work, decode failures or unacceptable query pressure. Observe recovery latency, projection watermark and errors rather than only a green health endpoint.

Rollback disables new workers/writers first, then restores the compatible old application behavior. Preserve accepted revisions/checkpoints/events. Image rollback does not undo sent notifications, revocations or bad events; those require reviewed compensation. Never restore a whole old database over later legitimate phone activity.

## Retirement and documentation discipline

Retire a path only with a named successor, known consumer inventory, replay/contract equivalence where relevant, rollback window and migration note. Candidates include old generic Nura MCP ownership, markdown task helpers, frozen mirror jobs, legacy hosted chat/upload, legacy dream scheduler and duplicated vendored packages. Keep compatibility adapters until unsupported usage is proved, not assumed.

Maintain one repository architecture entrypoint, concise decision records, an operations runbook and a release/contract manifest. In the canonical Atlas wiki, link to exact commits and accepted decisions, and explicitly mark superseded guidance. Do not create competing “current” documents or hand-maintain a generated index. This review packet is a dated proposal/evidence set; accepting implementation decisions should update their canonical homes.

No fixed calendar estimate is justified yet. Phase exits are evidence-based and each PR should have one behavior/invariant, its meaningful tests and a rollback/retirement note where relevant. The next build should start with Phase 0, not a wholesale filesystem rewrite.

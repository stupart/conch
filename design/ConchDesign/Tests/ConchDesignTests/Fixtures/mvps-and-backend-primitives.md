---
type: document
status: proposal
created: 2026-09-20
updated: 2026-09-20
review_status: bounded-astra-review-ready-for-mvp1-planning
---

# Atlas MVPs and backend primitives

Tyler's direction: make the first useful product an Atlas-branded Wikipedia-like viewer/editor; organize later work into achievable MVPs; compare actual backend architecture; explore an instance as a virtual workspace with folder scopes and standardized, lintable content. This document develops those ideas into proposed product milestones and backend contracts. It supplements the existing reviewed migration plan; it does not relax its route-specific dependency gates or authorize a rollout. Historical backfill remains deferred.

> **Product clarification, 2026-09-20:** The subsequent [[projects/atlas/memory-core-and-ux-2026-09-20|memory-core and UX proposal]] recovers the older tags, tiered summaries, generated pages and context-delivery designs. It distinguishes MVP 1A (inspect/edit the wiki) from a small MVP 1B proof (one new decision → maintained project knowledge → useful context in a fresh session). The backend gates and later scoped-agent/DayLoop milestones below remain applicable. A read-only wiki is useful, but does not by itself prove the memory loop.

One GPT-6 Astra reviewer assessed this addition against the earlier reviewed plan and core audit. Verdict: ready for bounded MVP 1 planning, with the four route-specific build-contract requirements incorporated below. This is architecture review, not implementation or deployment verification. See [[projects/atlas/astra-mvp-primitives-review-2026-09-20|Review and limits]].

## Product milestones

MVPs describe outcomes the user can try. Engineering phases describe prerequisites. A useful wiki need not wait for all DayLoop write repairs, every agent permission feature, or a connector ecosystem.

| Milestone | Useful outcome | Completion demonstration and boundary |
| --- | --- | --- |
| Foundation, before live writes | Safe development and a known production baseline | An inert disposable environment runs released-client fixtures; tests cannot reach production or start real schedulers. Record the deployed source/image/schema/flags before deploying. Obtain a recoverable backup and demonstrate restore into isolation before the first production schema/write change. This is enabling work, not a separate consumer product. |
| MVP 1: My Atlas wiki | Tyler signs in on this laptop, browses/searches existing knowledge, edits prose, and sees history and diffs | Link to the existing account through a verified enrollment flow. Browse more than 500 docs, identify current/superseded/generated content, preview/save a guarded edit, and recover a two-tab conflict without losing text. A retry returns a stable outcome. Use Wikipedia-like typography/navigation with Atlas branding. Generated DayLoop state is visibly read-only; no task effects from prose editing. Avoid shipping move/restore until their separate atomic contracts pass. Show the exact document source/revision agents receive; this is not yet a promise of per-agent visibility simulation. |
| MVP 2: Scoped agent workspace | Connect an agent to a project and inspect its effective access | Both host plugins support the same versioned operations. A fresh agent receives a bounded orientation with exact sources, rules, and capabilities. Denial holds across search, history, components, old tools, and caches. Owner can inspect effective permissions and the returned context through the same server policy. Revoke one integration without changing phone access. A host's broad credential must be removed from a supposedly restricted run; a session label alone supplies no isolation. |
| MVP 3: Shared day and interactive Nura | Nura can understand today's live plan and make explicitly requested changes that DayLoop sees | Test create/complete/reschedule plus offline retries and phone recovery. Duplicate requests create one effect, stale changes conflict predictably, generated daily sections remain event-owned, and phone proof/media semantics survive. Nura is a separate app/client using Atlas contracts. Typed day operations require the reviewed command/ordering repairs, irrespective of how early UI development begins. |
| MVP 4: A dependable custodian | Assign Nura or another agent one bounded maintenance duty | Run against a fixed evidence set, produce a cited diff/proposal, approve/apply it once, and inspect the result. Then allow selected duties to run automatically with explicit grants, budgets, fenced workers, and failure recovery. Begin with existing project prose; shared-day automation also requires MVP 3's domain guarantees. Sleeping/dreaming can become scheduling over these runs. |
| MVP 5: One connector that stays correct | A chosen source can add new context and keep it current | Start with synthetic fixtures and one explicitly selected source, source IDs/versions/checkpoints, deduplication, deletion/retention behavior, and coverage reporting. A Conch exporter is a candidate, not a chosen owner of all storage. Historical ingestion remains a separate decision. |

MVP 1 auth can be a narrow owner enrollment/recovery path with ordinary web sessions. It must not be presented as complete multi-provider SSO, cross-user collaboration, or all future MCP enrollment. A read-only fixture-backed viewer can be prototyped immediately; live owner reads and guarded writes follow their specific safety gates. Formal steward assignments are unnecessary for ordinary authorized human edits.

## What the backend comparisons actually imply

These are selected primitives from documented architectures, not claims that we have audited all their production infrastructure.

| Concern | MediaWiki / Wikipedia software | Mastodon, as a concrete social backend | Proposed Atlas |
| --- | --- | --- | --- |
| Primary objects | Page, revision, content/slots, actor, user, links | Account, status, relationship, media attachment, notification | Existing account boundary; stable document plus revisions; typed task/moment entities backed by existing events; actor and grant |
| Durable storage | Relational tables for identity/content/history | PostgreSQL for durable application data | Keep existing PostgreSQL and migration lineage; documents and domain events remain different models |
| Current view versus history | A page points to its current revision; revision history is separate from the recent-changes feed | Application records plus derived feeds/streaming | Explicit current document revision; ordered domain projections; activity views referencing revisions/events rather than duplicate canonical facts |
| Concurrency | Edit API accepts a base revision to detect conflicting edits | No universal Mastodon write-isolation guarantee inferred from its architecture docs | Atomic revision preconditions for prose; an authoritative ordered transaction boundary for related domain effects |
| Retry deduplication | Base-revision conflict detection is a different mechanism from a replayable operation receipt | Status creation accepts an Idempotency-Key; its documented retention is up to one hour | Stable operation receipts and legacy event dedup that remain safe for long-lived offline retries |
| Permissions | Users/groups and page protection; private per-page reading is not its native design target | OAuth app scopes and object visibility | Account isolation plus action/resource grants, applied to every API and derived response |
| Background work | Job machinery and derived content exist in the schema | Sidekiq background processes and Redis queues; separate web and streaming processes | Initially database-backed jobs and a transactional outbox; independently testable workers, explicit startup, retry/fencing |
| Navigation | Links, categories, namespaces | Relationships and feeds | Human paths/folders plus stable IDs and typed relationships; a graph database is not required for linked knowledge |

Sources: [MediaWiki schema](https://www.mediawiki.org/wiki/Manual:Database_layout), [revision model](https://www.mediawiki.org/wiki/Manual:Revision_table/en), [edit API](https://www.mediawiki.org/wiki/API:Edit), [access restrictions](https://www.mediawiki.org/wiki/Manual:Preventing_access), [Mastodon architecture](https://docs.joinmastodon.org/dev/overview/), [scaling and processes](https://docs.joinmastodon.org/admin/scaling/), [status objects/actions](https://docs.joinmastodon.org/methods/statuses/), and [OAuth scopes](https://docs.joinmastodon.org/api/oauth-scopes/).

The resulting Atlas architecture is a modular application with transactional persistence, versioned documents, and selective event sourcing for the existing DayLoop domain. It is not necessary to event-source every settings field or to reconstruct a wiki article from every keystroke. Durable domain events, document revisions, operational logs, and delivery jobs have different purposes and retention rules.

## Primitive inventory and module ownership

| Primitive | Meaning and owner | Existing versus proposed |
| --- | --- | --- |
| Account boundary | Whose data this is; identity/policy module | Existing user/tenant ownership. Start one personal workspace per existing owner; do not migrate phone IDs to speculative multi-workspace tenancy. |
| Principal, credential, session | Who acts; how they authenticate; one connection | Existing human/device/service identities and tokens; enrollment, recovery and restricted delegation need design. |
| Grant | Allowed action on resource/subtree, expiry and review conditions | Broad scopes exist; comprehensive resource policy is proposed. |
| Document and revision | Stable object and an exact version of its prose | Existing Vault foundation; consistent reads, guarded writes, lifecycle receipts and identity-preserving moves need repair. |
| Path/container and relation | Human location; membership; links between stable objects | Paths/tags/links exist. Stable container scopes and move semantics need a defined migration before restricted access. |
| Domain command and event | Requested intent versus accepted fact, e.g. complete task | Existing typed domain and raw-phone event uploads; retain both supported protocols. |
| Request receipt | Persisted identity/input fingerprint/result of one logical mutation | Existing event dedup is insufficient; durable operation receipts proposed. |
| Outbox item | Follow-up work durably recorded with the change | Proposed repair for commit/publication gaps; delivery may repeat. |
| Projection and checkpoint | Rebuildable current view and exact processed position | Existing projections/cursors; ordering, versioning and publication need repair. |
| Ruleset and validation result | Versioned deterministic content/operation requirements and actionable diagnostics | Current schemas, wiki instructions and guards are fragmented; shared executable validation proposed. |
| Proposal/approval | Exact proposed effect and a reviewer's bounded authorization | Explicit product/service contract proposed; prose saying approved is not authorization. |
| Assignment, run, effect | Duty; one attempt with evidence; each applied consequence | Nura job/workflow pieces exist; bounded evidence, authority and fencing need repair. |
| Source version, checkpoint | External provenance and progress | Later connector module; no backfill prerequisite for the wiki. |

Modules should expose typed application services to HTTP, MCP, CLI, and web adapters. These adapters share policy and domain behavior. The web app is a consumer of Atlas, and Nura is another. Use database constraints and explicit transaction interfaces underneath; an SDK guard is useful feedback but cannot be the only enforcement boundary.

## Idempotency and concurrency, concretely

Idempotency means retrying the same logical request does not apply it twice. This differs from concurrency control, which decides what happens when two different requests edit the same thing.

Example: an agent submits create-task request `K`, Atlas commits task `T`, then the connection drops. Retrying `K` with the same normalized input returns the existing receipt and `T`. Reusing `K` for a different request body produces a defined conflict. Two intentionally different requests for equal-looking tasks remain different; titles/content hashes alone are not operation identities. Clients must persist request IDs with their offline queues, and agent adapters must reuse a pending operation ID rather than generate a new one on every retry. A second model turn with a new ID is not automatically recognizable as the same intent.

Stripe documents this request-key/parameter-checking pattern. Its documented ability to prune keys after 24 hours is not suitable to copy blindly into Atlas: a phone or agent may retry an old queued operation. Atlas needs durable domain dedup or a defined expired-key protocol that never silently re-executes an ambiguous old request. See [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests).

Proposed transactional path: authenticate and authorize; normalize input; reserve/check the operation identity under a unique constraint; evaluate revision/domain preconditions against authoritative state; commit the mutation, generated IDs, receipt and outbox intent together. Define a stable lock order and bounded transaction duration. No LLM call or network request belongs inside the lock. Concurrent same-key requests wait for the committed result or receive a retryable in-progress response; they do not both execute. Validation failures before execution, rolled-back transient failures, committed success, and committed terminal outcomes need explicit classifications. A crash after commit but before response must be recoverable from the receipt.

Receipt lookup still checks the caller's current authority; a revoked grant must not reveal old private response bodies. Dedup scope must preserve existing tenant-wide phone keys across token rotation and adapters. A new receipt table cannot identify an old-server commit retroactively without stable evidence: test lost-response retries across old/new versions, mixed writers, and rollback. Never guess an ambiguous old task match from a title.

Document concurrency example: both Tyler and an agent read revision 12. The agent saves revision 13. Tyler's save against 12 returns a conflict with a path to compare/rebase, preserving Tyler's draft. A successful response binds exact content to its revision. Database unique constraints alone cannot make two independent reads a consistent snapshot; PostgreSQL's ordinary read-committed isolation can see different committed states across statements. See [PostgreSQL isolation](https://www.postgresql.org/docs/current/transaction-iso.html).

The outbox records that a committed change needs follow-up. A worker may receive the item twice; a unique effect identity/checkpoint makes repeated processing harmless. External APIs require their own idempotency support or reconciliation when delivery is ambiguous. We should promise the tested effect semantics, not universal exactly-once delivery.

## The instance as a virtual workspace

The useful analogy is a persistent namespace containing resources, users/agents, grants, rules, history, and activity. An agent can start at `/projects/conch/`, retrieve applicable instructions, and navigate permitted resources. The same workspace can have web, MCP and optional file interfaces.

This does not require a VM per account. Atlas data stays in the database; a future actual VM/container/remote Mac is an execution environment that connects with a bounded credential. Multiple isolated runs can use one workspace, or one run can receive approved access to several scopes. Keeping execution separate supports the old-Mac prototype idea without making every wiki need an operating system. Actual shell isolation is a separate boundary: Claude Code likewise distinguishes tool permission checks from operating-system-enforced filesystem/network sandboxing. See [Claude sandboxing](https://code.claude.com/docs/en/sandboxing).

Proposed authorization calculation: authenticated principal grant intersected with the session's allowed scope, permitted action, and any required approval. A requested working folder narrows navigation; changing it cannot grant access. An assignment adds obligations, not authority. A subagent must inherit equal or narrower access if it is presented as restricted; copying a broad host token defeats that property.

Use paths for humans and stable IDs for identity. A document rename should preserve its revisions and direct grants. Moving between permission containers can change inherited audience, so moving requires source/destination authorization, a preview of affected access, and an atomic update. Folder inheritance and explicit object exceptions need deterministic precedence. Aliases must resolve to the object before authorization; string-prefix checks must not confuse `/projects/conch/` with `/projects/conch-secret/`. Do not ship writable filesystem mounts before conflict, rename, delete and reconnect semantics are specified.

The boundary must cover transclusions, generated indexes, backlinks, search snippets, history, exports and cached context. A private page included in a public summary cannot leak through that summary. Default to preserving source restrictions or recomputing from allowed sources; widening an audience requires explicit authorized publication. Revocation blocks future server delivery, but cannot erase text already received by an agent.

PostgreSQL row-level security can add an account-isolation backstop, but it is not a substitute for application resource policy or worker/client isolation. Roles that own tables or bypass RLS need special attention; pooled connections must not retain another request's identity. Adopting it would be a separate tested migration. See [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## A shared validator and a linter

The existing wiki conventions are the starting inventory, not proof every instruction is implemented or suitable as a hard rule. Separate three layers:

| Layer | Example | Behavior |
| --- | --- | --- |
| Structural validation | Required type fields, valid references, accepted schema version, deterministic path-derived tags | Shared pure validator; authoritative server check on relevant writes; exact field/rule diagnostics |
| Operation/policy invariants | Wrong revision, insufficient permission, editing generated task proof, unauthorized move | Always enforced inside the operation boundary; no linter override or model approval can bypass |
| Editorial and semantic checks | Missing source, stale summary tiers, orphan page, potential contradiction, unclear ownership | Visible warnings and suggested diffs; uncertain LLM findings are not factual verdicts or silent edits |

Use one versioned validation library from the server, browser, CLI/MCP and tests. A proposed `atlas lint`/validate tool should report rule ID, severity, source range/field, ruleset version and a suggested repair. These names are proposals, not currently installed commands. Re-run validation at commit because a prior dry run does not lock the document or policy. Rules that involve other records must use the transaction/policy boundary, not only local lint.

Readable rule pages can describe the effective policy, while changing permissions/rules goes through separately authorized typed operations. A wiki author must not gain access by editing an instruction page or setting a frontmatter field. Imported text is evidence, not a new system instruction. Existing messy documents remain readable; introduce editorial warnings first and explicitly migrate schemas rather than making every old document suddenly uneditable. Generated indexes and summaries remain derived and carry dependencies; editing a summary is not automatically an authoritative update to all sources.

## Auth as part of MVP 1 and MVP 2

Separate login (prove identity), authorization (allowed access), and review (consent to one bounded action). MVP 1 needs a verified path into the existing owner account and a secure browser session; MVP 2 needs enrollment and revocation for restricted integrations. Nura can subsequently sign the human into the same identity provider and request its own Atlas grant. Each browser/device/host has its own credential; no shared master token.

Current public web options report Apple web login and bootstrap disabled; a human/device bearer-to-cookie exchange and one-time handoff exist in source. New laptop agent profiles do not provide a human login. First design and verify owner enrollment/recovery, potentially using the already authenticated old laptop. Do not treat knowing a user ID, an email match, or possession of a service token as proof of human ownership. Preserve existing DayLoop device-owner mapping and supported recovery responses.

For the browser, specify secure HTTP-only session cookies, CSRF protection, login-state/redirect validation, expiry, logout and account-switch behavior, and safe rendering of user markdown. Human identity can use a standard provider; the precise provider/account-linking proof remains an implementation decision. Future remote HTTP MCP can use standard delegated OAuth; local plugins need an enrollment flow and secure local credential storage even when their host transport is stdio. Re-check scope and revocation when applying an effect, including after a user approved a proposal. Bind that approval to the exact operation, target IDs, revision, payload, permitted actor and expiry; a changed proposal needs fresh review.

## Backend acceptance matrix

| Principle | Required behavior | Demonstration |
| --- | --- | --- |
| Identity/isolation | Existing owners stay owners; wrong account cannot read or mutate resources | Cross-account ID, recovery, session switch and revoked-token cases |
| Atomicity | Mutation, revision/event identity, receipt and required publication intent commit coherently | Crash before/after every commit/publication boundary |
| Concurrency | Two conflicting changes cannot silently overwrite each other | Forced interleavings for edit/delete/restore and domain writers |
| Idempotency | One logical request retains one outcome across retry and token rotation | Lost response, simultaneous retry, changed payload, old-client/new-server transition |
| Ordering | Projections process a complete ordered relevant input prefix | Shuffle/delay notifications; rebuild and incremental output match |
| Consistency | Exact revisions on source reads; derived lag explicitly disclosed | Read-after-write and lag tests; command validation never trusts a stale display projection |
| Delivery | Notifications wake durable reads; jobs may repeat safely | Lost SSE notification, slow client, crash, expired lease, duplicate job |
| API contracts | Versioned shapes and recoverable errors shared by adapters | Released Swift fixtures, plugin conformance, absent/null fields, request/continuation IDs |
| Security of derived data | Denied sources stay denied through indirect reads | Search, include, graph edge, history, export and cache tests |
| Validation | Same rules and structured diagnostics for humans and agents | Fixture corpus across all adapters; preflight/commit race |
| Availability and limits | Expensive context/AI jobs cannot monopolize normal app operations | Pagination, request/input limits, query plans, job concurrency, rate and budget tests |
| Operations | Failures are attributable without logging private bodies or credentials | Correlation through request/run/receipt, conflict/lag/retry metrics, alert drill |
| Recovery and retention | Backups restore; corrections preserve history; erasure is explicit | Isolated restore; documented recovery objectives and retention/export/deletion behavior; distinguish business history from security audit |
| Migration | Existing app versions survive additive rollout and rollback | Old/new schema and mixed-writer tests; compatible image rollback; no rewriting past domain events |

A database backup does not prove phone-local media are backed up. Privacy erasure and retention also mean append-oriented business history must not be advertised as an eternal compliance archive. Measure before adding separate caches, brokers, vector stores or independent services; each creates another consistency and operational boundary.

## Next bounded build specification

Write the MVP 1 contract around owner enrollment, paginated read/search, exact source/revision display, guarded prose editing, and history/diff. Define which current daily/generated pages are view-only. Build the fixture-backed viewer and inert contract harness, then repair only the backend boundaries that live MVP 1 routes actually require. Keep the existing phone routes, paused automation, and other sessions' dirty pairing work outside incidental changes. The architecture still needs concrete transaction/auth details and deployment evidence before production activation.

The Astra review identified four acceptance details that belong in this first build brief:

1. Define an authoritative server rule for the initial writable prose classes, starting with ordinary project documents. Explicitly classify daily pages, generated entities, conversation data and control/operational pages. All new MVP 1 mutation routes enforce it; UI read-only labels and client-supplied `skipDailySync` flags are insufficient because existing generic Vault writes can invoke daily ingestion. Retain old supported routes under their existing compatibility policy.
2. Keep every MVP 1 read, including component expansion, non-materializing. Return exact source/revision pairs, generated-state lag or unavailability, and later policy-safe handling of denied references. Reading stored generated prose is not a freshness guarantee.
3. Specify Vault-specific edit/create receipts without waiting for the entire DayLoop command-receipt project. A retry must recover its own committed outcome even if another edit has since advanced the page; latest-content/no-op checks alone do not prove that. Preserve current authorization, lifecycle publication and editor generation guards.
4. Specify the exact owner enrollment/recovery proof, existing-device behavior, browser session protections, and sanitized markdown/link rendering. Fixture-only UI development can proceed while the live enrollment route is unresolved.

The acceptance matrix is a coverage map for introduced routes, not a requirement to build every platform feature before MVP 1. Containers, generalized approvals, assignments and external sources remain in their later milestones. The custodian's apply-once demonstration means one committed Atlas effect per operation/effect identity; it does not promise universal exactly-once external delivery.

Related: [[projects/atlas/pre-build-migration-plan-2026-09-20|Reviewed implementation dependencies]] and [[projects/atlas/ax-and-identity-direction-2026-09-20|Product and sign-in direction]].

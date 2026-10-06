---
type: document
status: proposal
created: 2026-09-20
updated: 2026-09-20
review_status: bounded-review-ready-for-mvp1-planning
---

# Morrow MVPs and backend primitives

The team's direction: make the first useful product a calendar people trust more than the one they already have; organize later work into achievable MVPs; compare actual backend architectures; treat a workspace as a shared scheduling space with folder-like scopes and standardized, lintable events. This document develops those ideas into proposed product milestones and backend contracts. It supplements the existing reviewed migration plan; it does not relax its route-specific dependency gates or authorize a rollout. Importing years of past events remains deferred.

> **Product clarification, 2026-09-20:** The later [[docs/morrow/focus-and-ux-2026-09-20|focus and UX proposal]] brings back the older ideas of soft holds, tiered reminders, generated agendas and travel buffers. It separates MVP 1A (see and edit your own calendar) from a small MVP 1B proof (one protected focus block → a meeting request that respects it → a sensible counter-proposal). The backend gates and later shared-scheduling milestones below still apply. A read-only calendar is useful, but does not by itself prove that Morrow protects anyone's time.

One reviewer assessed this addition against the earlier reviewed plan and the sync audit. Verdict: ready for bounded MVP 1 planning, with the four route-specific build-contract requirements folded in below. This is architecture review, not implementation or deployment verification. See [[docs/morrow/mvp-primitives-review-2026-09-20|Review and limits]].

## Product milestones

MVPs describe outcomes a person can try. Engineering phases describe prerequisites. A useful calendar need not wait for every sync repair, every sharing feature, or a marketplace of connectors.

| Milestone | Useful outcome | Completion demonstration and boundary |
| --- | --- | --- |
| Foundation, before live writes | Safe development and a known production baseline | An inert disposable environment runs released-client fixtures; tests cannot reach production calendars or start real reminder jobs. Record the deployed source, image, schema and flags before deploying. Take a recoverable backup and demonstrate a restore into isolation before the first production schema or write change. This is enabling work, not a separate product anyone would download. |
| MVP 1: A calendar you can trust | A person signs in on a laptop and a phone, sees every event from their existing calendars, edits one, and sees the change everywhere within seconds | Connect one existing account through a verified sign-in. Load more than 2,000 events across three calendars, mark which ones Morrow can edit and which are read-only, save a guarded edit, and recover a two-device conflict without losing either version. A retry returns a stable outcome. Recurring events show their exceptions correctly. Avoid shipping drag-to-move across calendars until its separate atomic contract passes. Show exactly what the server stored; this is not yet a promise of offline editing. |
| MVP 2: Focus time that defends itself | Mark focus blocks and have new meeting requests respect them | A protected block declines or counters a conflicting request with a reason the organizer can read. Protection holds across the web app, the phone, the invite links and the connectors. The owner can inspect why a request was countered and override it once. Turning protection off for one calendar leaves the others alone. A focus block is never silently shortened to make room. |
| MVP 3: Shared scheduling with guests | A guest picks a time from a booking link and both calendars agree afterwards | Test book/reschedule/cancel plus offline retries and a guest who changes time zones mid-flow. Duplicate submissions create one booking, stale slots conflict predictably, holds expire on schedule, and the organizer's phone shows the same result as the web. The booking page is a separate client using Morrow's public contracts. Typed booking operations require the reviewed ordering repairs, however early the page design begins. |
| MVP 4: A dependable rescheduler | Ask Morrow to move one meeting, or a whole afternoon, and inspect the plan before it happens | Run against a fixed set of calendars, produce a proposed set of moves with reasons, approve and apply it once, and inspect the result. Then allow chosen kinds of moves to run automatically with explicit limits, notice periods and failure recovery. Begin with the owner's own events; moving other people's meetings also requires MVP 3's guarantees. |
| MVP 5: One connector that stays correct | A chosen external calendar stays in step in both directions | Start with synthetic fixtures and one explicitly selected provider, provider IDs, versions and sync tokens, deduplication, deletion behavior and coverage reporting. A second provider is a candidate, not a commitment. Importing a decade of history remains a separate decision. |

MVP 1 auth can be a narrow owner sign-in and recovery path with ordinary web sessions. It must not be presented as complete single sign-on, team administration, or every future integration's enrollment. A read-only fixture-backed calendar can be prototyped immediately; live reads and guarded writes follow their specific safety gates. Formal delegation is unnecessary for a person editing their own events.

## What the backend comparisons actually imply

These are selected primitives from documented architectures, not claims that we have audited anyone's production infrastructure.

| Concern | CalDAV / iCalendar servers | Google Calendar API, as a hosted backend | Proposed Morrow |
| --- | --- | --- | --- |
| Primary objects | Calendar collection, calendar object resource, component, property | Calendar, event, ACL rule, settings, channel | Existing account boundary; calendars; stable events plus revisions; series and exceptions; holds and bookings; actor and grant |
| Durable storage | Server-defined; resources addressed by URL | Hosted; storage is not exposed | Keep the existing PostgreSQL database and migration lineage; events and their history remain separate models |
| Current view versus history | A resource has a current ETag; history is not part of the protocol | Events carry an etag and an updated time; deleted events can be listed with showDeleted | Explicit current event revision; ordered projections for agendas and free/busy; activity views that reference revisions rather than duplicating them |
| Concurrency | Conditional requests with If-Match on the resource ETag | Conditional updates using the event etag | Atomic revision preconditions for every edit; one ordered transaction boundary for related scheduling effects |
| Retry deduplication | A PUT to the same URL is naturally repeatable; a POST is not | Clients may supply an event ID on insert, and a duplicate ID is rejected | Stable operation receipts plus provider IDs, safe for long-lived offline retries from phones |
| Permissions | Access control lists on collections and resources | Per-calendar ACL rules and OAuth scopes | Account isolation plus action/resource grants, applied to every API and every derived response such as free/busy |
| Background work | Not specified; servers vary | Push notification channels that expire and must be renewed | Database-backed jobs and a transactional outbox at first; independently testable workers, explicit startup, retry and fencing |
| Recurrence | RRULE with overrides keyed by RECURRENCE-ID | Recurring events with instances that point back to their series | Series rules plus explicit exceptions; an exception keeps its identity when the series changes |

Sources: [CalDAV](https://www.rfc-editor.org/rfc/rfc4791), [iCalendar](https://www.rfc-editor.org/rfc/rfc5545), [collection synchronization](https://www.rfc-editor.org/rfc/rfc6578), [Google Calendar sync](https://developers.google.com/calendar/api/guides/sync), and [push notifications](https://developers.google.com/calendar/api/guides/push).

The resulting Morrow architecture is a modular application with transactional persistence, versioned events, and an ordered log for scheduling effects. It is not necessary to log every preference toggle or to rebuild a calendar from every keystroke in the editor. Durable scheduling events, event revisions, operational logs and delivery jobs have different purposes and different retention rules.

## Primitive inventory and module ownership

| Primitive | Meaning and owner | Existing versus proposed |
| --- | --- | --- |
| Account boundary | Whose data this is; identity/policy module | Existing user ownership. Start with one personal space per existing owner; do not migrate phone IDs to speculative multi-team tenancy. |
| Principal, credential, session | Who acts; how they authenticate; one connection | Existing human, device and service identities and tokens; enrollment, recovery and restricted delegation need design. |
| Grant | Allowed action on a calendar or event, expiry and review conditions | Broad scopes exist; fine-grained resource policy is proposed. |
| Calendar and event | A named collection and a stable event within it | Existing tables; consistent reads, guarded writes and moves between calendars need repair. |
| Event revision | An exact version of an event's fields | Partly present as updated timestamps; real revisions with preconditions are proposed. |
| Series and exception | A recurrence rule and the instances that differ from it | Rules exist; exceptions lose their identity when the series is edited and need repair. |
| Hold and booking | A tentative claim on time and the confirmed result | Booking links exist; holds that expire on schedule are proposed. |
| Request receipt | Persisted identity, input fingerprint and result of one logical change | Existing dedup is insufficient; durable operation receipts are proposed. |
| Outbox item | Follow-up work durably recorded with the change | Proposed repair for commit and notification gaps; delivery may repeat. |
| Projection and checkpoint | Rebuildable agenda or free/busy view and the exact position processed | Existing caches; ordering, versioning and invalidation need repair. |
| Ruleset and validation result | Versioned deterministic requirements and actionable diagnostics | Current checks are scattered across clients; shared executable validation is proposed. |
| Proposal/approval | An exact proposed set of moves and a person's bounded authorization | Explicit product and service contract proposed; a chat message saying yes is not authorization. |
| Source version, checkpoint | External provider provenance and sync progress | Later connector module; no history import is required for the calendar. |

Modules should expose typed application services to HTTP, CLI, web and phone adapters. These adapters share policy and scheduling behavior. The web app is one consumer of Morrow, the phone app is another, and the booking page is a third. Use database constraints and explicit transaction interfaces underneath; a client-side guard is useful feedback but cannot be the only enforcement boundary.

## Idempotency and concurrency, concretely

Idempotency means retrying the same logical request does not apply it twice. This differs from concurrency control, which decides what happens when two different requests change the same thing.

Example: a phone submits create-event request `K`, Morrow commits event `E`, then the connection drops in a tunnel. Retrying `K` with the same normalized input returns the existing receipt and `E`. Reusing `K` for a different request body produces a defined conflict. Two intentionally different requests for events that look alike remain different; titles and times alone are not operation identities. Clients must persist request IDs with their offline queues, and integrations must reuse a pending operation ID rather than mint a new one on every retry.

Some public APIs keep idempotency keys for only a day. That window is not suitable to copy blindly into Morrow: a phone left in a drawer may retry an old queued operation a week later. Morrow needs durable dedup or a defined expired-key protocol that never silently re-executes an ambiguous old request.

Proposed transactional path: authenticate and authorize; normalize input; reserve or check the operation identity under a unique constraint; evaluate revision and scheduling preconditions against authoritative state; commit the change, generated IDs, receipt and outbox intent together. Define a stable lock order and a bounded transaction duration. No network request to a calendar provider belongs inside the lock. Concurrent same-key requests wait for the committed result or receive a retryable in-progress response; they do not both execute. A crash after commit but before the response must be recoverable from the receipt.

Receipt lookup still checks the caller's current authority; a revoked grant must not reveal an old private response. Dedup scope must preserve existing account-wide phone keys across token rotation. A new receipt table cannot identify an old server's commit retroactively without stable evidence: test lost-response retries across old and new versions, mixed writers, and rollback. Never guess an ambiguous old event match from a title.

Edit concurrency example: a person and their assistant both read revision 12 of a meeting. The assistant saves revision 13 with a new room. The person's save against 12 returns a conflict with a way to compare and merge, keeping the person's draft. A successful response binds exact fields to their revision. Unique constraints alone cannot make two independent reads a consistent snapshot; read-committed isolation can see different committed states across statements.

The outbox records that a committed change needs follow-up, such as an invitation email or a provider update. A worker may receive the item twice; a unique effect identity makes repeated processing harmless. External providers need their own idempotency support or reconciliation when delivery is ambiguous. We should promise the tested effect semantics, not universal exactly-once delivery.

## The instance as a virtual workspace

The useful analogy is a persistent space containing calendars, people, grants, rules, history and activity. An integration can start at one team's calendars, read the scheduling rules that apply, and act only on what it is allowed to see. The same space can have web, phone and API interfaces.

This does not require a server per team. Morrow data stays in the database; a future dedicated deployment is an execution environment that connects with a bounded credential. Several integrations can share one space, or one integration can receive approved access to several. Keeping execution separate from data keeps the small-team case cheap.

Proposed authorization calculation: the authenticated principal's grants intersected with the session's allowed scope, the permitted action, and any required approval. Choosing a calendar narrows what is shown; it cannot grant access. An assignment adds obligations, not authority. A delegated assistant must inherit equal or narrower access if it is presented as restricted; copying a broad token defeats that property.

Use names for people and stable IDs for identity. Renaming a calendar should preserve its events and direct grants. Moving an event between calendars can change who sees it, so moving requires authorization on both sides, a preview of the change in audience, and an atomic update. String-prefix checks must not confuse `team/design` with `team/design-private`.

The boundary must cover free/busy, generated agendas, search snippets, history, exports and reminders. A private event included in a shared agenda cannot leak through that agenda. Default to preserving source restrictions; widening an audience requires an explicit, authorized share. Revocation blocks future delivery, but cannot erase an invitation already sent.

## A shared validator and a linter

The existing event conventions are the starting inventory, not proof that every rule is implemented or suitable as a hard rule. Separate three layers:

| Layer | Example | Behavior |
| --- | --- | --- |
| Structural validation | Required fields, valid time zones, end after start, a recurrence rule the server can expand | Shared pure validator; authoritative server check on relevant writes; exact field and rule diagnostics |
| Operation/policy invariants | Wrong revision, insufficient permission, editing a read-only provider event, an unauthorized move | Always enforced inside the operation boundary; no override from the client can bypass it |
| Scheduling hints | Back-to-back meetings, no travel time, a focus block shorter than its minimum, a guest outside working hours | Visible warnings and suggested fixes; hints are never silent edits |

Use one versioned validation library from the server, browser, phone and tests. A proposed `morrow lint` command should report rule ID, severity, field, ruleset version and a suggested repair. These names are proposals, not shipped commands. Re-run validation at commit, because a prior dry run does not lock the event or the policy.

Readable rule pages can describe the effective policy, while changing permissions or rules goes through separately authorized typed operations. A guest must not gain access by editing an event description. Imported text is data, not an instruction. Existing messy events remain readable; introduce hints first and migrate deliberately rather than making old events suddenly uneditable.

## Auth as part of MVP 1 and MVP 2

Separate sign-in (prove identity), authorization (allowed access), and review (consent to one bounded action). MVP 1 needs a verified path into the existing owner account and a secure browser session; MVP 2 needs enrollment and revocation for connected calendars. Each browser, device and integration has its own credential; there is no shared master token.

Current public options report that web sign-in through the phone is disabled; a device-to-browser handoff exists in source. First design and verify owner enrollment and recovery, possibly using an already signed-in phone. Do not treat knowing a user ID, an email match, or possession of a service token as proof of ownership. Preserve existing device-owner mapping and supported recovery responses.

For the browser, specify secure HTTP-only session cookies, CSRF protection, redirect validation, expiry, sign-out and account-switch behavior, and safe rendering of event descriptions. Re-check scope and revocation when applying an effect, including after a person approved a proposal. Bind that approval to the exact operation, event IDs, revision, payload, permitted actor and expiry; a changed proposal needs fresh review.

## Backend acceptance matrix

| Principle | Required behavior | Demonstration |
| --- | --- | --- |
| Identity/isolation | Existing owners stay owners; the wrong account cannot read or change calendars | Cross-account ID, recovery, session switch and revoked-token cases |
| Atomicity | Change, revision, receipt and required notification intent commit together | Crash before and after every commit and notification boundary |
| Concurrency | Two conflicting edits cannot silently overwrite each other | Forced interleavings for edit, move, delete and series changes |
| Idempotency | One logical request keeps one outcome across retry and token rotation | Lost response, simultaneous retry, changed payload, old-client/new-server transition |
| Ordering | Projections process a complete ordered input prefix | Shuffled and delayed notifications; rebuild and incremental output match |
| Consistency | Exact revisions on reads; projection lag explicitly disclosed | Read-after-write and lag tests; validation never trusts a stale agenda |
| Delivery | Notifications wake durable reads; jobs may repeat safely | Lost push notification, slow client, crash, expired lease, duplicate job |
| API contracts | Versioned shapes and recoverable errors shared by adapters | Released phone fixtures, absent and null fields, request and continuation IDs |
| Time zones | An event means the same moment on every device | Daylight-saving transitions, travelling guests, all-day events and floating times |
| Security of derived data | Denied events stay denied through indirect reads | Free/busy, search, agenda, export and reminder tests |
| Availability and limits | Expensive rescheduling jobs cannot starve normal app operations | Pagination, input limits, query plans, job concurrency and rate tests |
| Operations | Failures are attributable without logging private event bodies or credentials | Correlation through request, run and receipt; conflict, lag and retry metrics; an alert drill |
| Recovery and retention | Backups restore; corrections preserve history; deletion is explicit | Isolated restore; documented recovery objectives and retention, export and deletion behavior |
| Migration | Existing app versions survive additive rollout and rollback | Old/new schema and mixed-writer tests; compatible image rollback; no rewriting of past events |

A database backup does not prove that phone-local drafts are backed up. Deletion and retention also mean an append-oriented history must not be advertised as an eternal archive. Measure before adding separate caches, brokers or services; each creates another consistency and operational boundary.

## Next bounded build specification

Write the MVP 1 contract around owner enrollment, paginated reads, exact revision display, guarded editing, recurrence exceptions and history. Define which provider calendars are view-only. Build the fixture-backed calendar and inert contract harness, then repair only the backend boundaries that live MVP 1 routes actually require. Keep the existing phone routes and reminder jobs outside incidental changes.

The review identified four acceptance details that belong in this first build brief:

1. Define an authoritative server rule for which calendars and events are writable, starting with the owner's own events on Morrow calendars. Explicitly classify provider events, generated agendas, booking holds and system calendars. All new MVP 1 write routes enforce it; read-only labels in the UI are insufficient because existing generic routes can still write.
2. Keep every MVP 1 read side-effect free, including recurrence expansion. Return exact revisions, projection lag or unavailability, and later policy-safe handling of denied events. Reading a cached agenda is not a freshness guarantee.
3. Specify event edit and create receipts without waiting for the full receipt project. A retry must recover its own committed outcome even if another edit has since moved the event; latest-content checks alone do not prove that.
4. Specify the exact owner enrollment and recovery proof, existing-device behavior, browser session protections, and sanitized rendering of event descriptions. Fixture-only UI work can proceed while the live enrollment route is unresolved.

The acceptance matrix is a coverage map for introduced routes, not a requirement to build every platform feature before MVP 1. Shared calendars, generalized approvals and external providers remain in their later milestones. The rescheduler's apply-once demonstration means one committed Morrow effect per operation; it does not promise exactly-once delivery to other providers.

Related: [[docs/morrow/pre-build-migration-plan-2026-09-20|Reviewed implementation dependencies]] and [[docs/morrow/sign-in-direction-2026-09-20|Product and sign-in direction]].

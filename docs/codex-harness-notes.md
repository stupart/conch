# Codex as a harness: what it exposes, and what conch should use

Research notes, 2026-09-11. Source: `openai/codex` at tag **`rust-v0.153.4`**, commit
**`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`** (committed 2026-09-04). Paths are relative to that
repo unless they start with `src/` or `plugin/` (conch).

Versions on this Mac while writing: Homebrew's `codex` is now **0.154.0** (`/opt/homebrew/bin/codex` →
`Caskroom/codex/0.154.0`, upgraded 14:22 today; tag `rust-v0.154.0`, `6b9826e`, 2026-09-09), and the
ChatGPT app bundles its own **0.153.4** (`/Applications/ChatGPT.app/Contents/Resources/codex --version`).
Help text quoted below is from 0.154.0. The one difference that matters here: 0.154.0 removed
`codex mcp-server` (section 8). Nothing was started, resumed or forked, and nothing under `~/.codex`
was written: SQLite was opened `mode=ro`, rollouts read with `jq`, locks inspected with `lsof`.

The live example throughout is session `01a08ea0…` ("Clone Blueprint Studio monorepo"), running as
`codex resume 01a08ea0… -c model_provider=openai-api -c model=gpt-6-astra …` (pid 2383) with ten
`thread_spawn` helpers.

## 1. app-server protocol

**What it speaks.** JSON-RPC 2.0 with the `"jsonrpc"` field omitted. Transports: stdio JSONL (the
default), a unix socket carrying websocket frames (`--listen unix://`, default
`$CODEX_HOME/app-server-control/app-server-control.sock`), `ws://IP:PORT` ("experimental /
unsupported"), or off (`codex-rs/app-server/README.md:20-44`; `codex app-server --help` shows the same
plus `--ws-auth capability-token|signed-bearer-token`). Every connection sends `initialize`
(`clientInfo`, optional `capabilities.experimentalApi` and `optOutNotificationMethods`) and then
`initialized`; anything sent first is refused (`README.md:85-169`).

**Methods.** The registry is `codex-rs/app-server-protocol/src/protocol/common.rs`: client requests at
496-1411, server→client requests at 1686-1741, notifications at 1841-1956. Descriptions are in
`README.md:171-307`.

| need | method(s) |
|---|---|
| start / resume / fork | `thread/start`, `thread/resume`, `thread/fork` (`lastTurnId`, `ephemeral`) |
| send a user turn | `turn/start`; `turn/steer` adds input to the running turn; `thread/queue/add`…`start` (experimental) queues until idle; `thread/inject_items` appends history without a turn |
| interrupt | `turn/interrupt` (threadId, turnId); the turn ends `interrupted` |
| approvals (server→client requests) | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, then `serverRequest/resolved` |
| streamed events | `turn/started`, `turn/completed`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/reasoning/*`, `item/commandExecution/outputDelta`, `turn/diff/updated`, `turn/plan/updated`, `thread/compacted`, `hook/started`, `hook/completed`, `error`, `warning` |
| status | `thread/status/changed` (`notLoaded` · `idle` · `active` · `systemError`), `thread/started`, `thread/closed`, `thread/loaded/list` |
| token usage | `thread/tokenUsage/updated` (`total`, `last`, `modelContextWindow`); `account/usage/read {threadId}` returns an estimated `ThreadUsage` in credits and USD when a billing route exists (`v2/account.rs:417-435`, `v2/thread_usage.rs`) |
| session listing | `thread/list` (cursor; filters `sourceKinds`, `cwd`, `modelProviders`, `searchTerm`, experimental `parentThreadId`/`ancestorThreadId`), `thread/read`, `thread/turns/list`, `thread/items/list`, all without resuming |
| name / title | `thread/name/set`, then `thread/name/updated` |
| also | `thread/compact/start`, `thread/revert`, `review/start`, `config/read`, `config/value/write`, `config/batchWrite`, `skills/list`, `hooks/list`, `plugin/list`, `mcpServerStatus/list`, `mcpServer/tool/call`, `model/list`, `command/exec`, `fs/*`, `remoteControl/*`, and an experimental voice path, `thread/realtime/*` (audio in and out of a thread) |

**Attaching to a thread another process runs: no, unless both go through the same app-server.**
"Only one app-server process can hold a paginated thread open for writing at a time. If another
process already owns the thread, `thread/resume` … fail[s] with JSON-RPC error `-32600`"
(`README.md:439`). The owner is enforced by an exclusive lock on `thread-writer-locks/<id>.lock`
(`codex-rs/thread-store/src/local/writer_lock.rs:40-75`: `try_lock`, else "thread … already has an
active writer"). A plain `codex` TUI is its own in-process ("embedded") app-server.

The exception is new. `codex app-server daemon start|stop` runs a shared local daemon on the unix
socket, and a TUI launched with **no** `-c`, profile or strict-config overrides connects to it
automatically when the socket answers (`codex-rs/tui/src/startup_orchestration.rs:138-190`;
`codex-rs/tui/src/lib.rs:862-927`: "A reused daemon cannot adopt this invocation's full launch config
state"). `codex --remote unix://` forces the connection. Clients of one daemon share threads:
`thread/resume` on a running thread subscribes the new connection and re-sends the thread's pending
approvals to it (`codex-rs/app-server/src/request_processors/thread_lifecycle.rs:792`). Read-only calls
(`thread/read`, `thread/turns/list`) work on any thread.

On this Mac nothing is attachable today:

- no daemon socket exists (`~/.codex/app-server-control` is absent);
- Tyler's session was launched with `-c` overrides, so it would be embedded even if a daemon ran;
- the ChatGPT app talks to its bundled app-server over private stdio (pid 74676 holds a Desktop
  thread's lock).

**Versioning.** There is no protocol version on the wire. The contract is "generated for the binary
you run": `generate-ts` and `generate-json-schema` output "is specific to the version of Codex you used
to run the command" (`README.md:59-64`). Stability is a capability, not a number. Experimental methods
and fields are refused with `<descriptor> requires experimentalApi capability` unless the client opts
in at `initialize` (`README.md:2815-2870`). Deprecations arrive as `deprecationNotice`, and v1
compatibility methods (`getConversationSummary`, `fuzzyFileSearch`, …) are still registered
(`common.rs:1375-1411`). The pace is real: 0.153.4 to 0.154.0 took five days, touched 56 files across
protocol and rollout, and removed a subcommand.

**Could conch drive Codex through it?** For sessions conch starts, yes, and it would replace more
than injection.

It covers:

- start, resume and fork without launch-flag strings or the trust prompt (`thread/start` with a `cwd`
  and workspace-write marks the project trusted itself, `README.md:174`);
- sending text whether idle or busy (`turn/start`, `turn/steer`), with no tmux and no focus check;
- interrupt;
- turn end and status without polling rollouts;
- approvals (section 4) and token usage (section 6);
- rename (`thread/name/set`; the Codex adapter has `renameCommand: () => null`,
  `src/agent-adapter.ts:280`).

It does not cover:

- a TUI already running embedded, which includes every session started with `-c` (Tyler's too);
- ChatGPT-app threads;
- anything, if the daemon is not running;
- a screen for the person, unless their TUI is itself a client of the same daemon
  (`codex --remote unix://…`).

`app-server` is still labelled `[experimental]` in `codex --help`.

**What conch should do.** Give the Codex adapter row a *transport* (E8). For sessions conch starts:
run or reuse `codex app-server daemon`, open the visible TUI as `codex --remote unix://` in Terminal,
and connect conch as a second client for turns, interrupts, status and approvals. Keep keystrokes and
rollout polling for sessions it only finds. Generate the client types from the installed binary
(`generate-json-schema`), and refuse to talk to a version whose schema it has not seen. Touches E8,
C2, B5, the phone bridge.

## 2. Session storage

**Rollout record types.** Each JSONL line is one `RolloutItem`, serialized as `{"timestamp", "type":
<snake_case variant>, "payload"}` (`codex-rs/history/src/lib.rs:102-117`,
`codex-rs/history/src/rollout_payload.rs:23`).

| `type` | payload | source |
|---|---|---|
| `session_meta` | `id`, `session_id` (= root thread), `forked_from_id`, `parent_thread_id`, `source`, `thread_source`, `agent_nickname`/`agent_role`/`agent_path`, `model_provider`, `cli_version`, `originator`, `base_instructions`, `dynamic_tools`; 0.154 adds `history_mode`, `multi_agent_version`, `context_window` | `codex-rs/protocol/src/protocol.rs:3037-3077` |
| `turn_context` | per turn: `turn_id`, `root_turn_id`, `cwd`, `approval_policy`, `sandbox_policy`, `permission_profile`, `model`, `effort`, `summary`, `collaboration_mode`, … | `TurnContextItem` |
| `response_item` | the model-visible Responses API items: `message`, `reasoning` (with `encrypted_content`), `function_call`/`_output`, `custom_tool_call`/`_output`, `agent_message` (inter-agent traffic carries `author`, `recipient`, `content`) | |
| `event_msg` | UI events: `task_started`, `task_complete`, `turn_aborted`, `token_count`, `item_completed`, `user_message`, `agent_message`, `thread_settings_applied`, … | |
| `token_usage_record` | one per model response: `thread_id`, `session_id`, `turn_id`, `root_turn_id`, `response_id`, `usage`, `turn_token_usage`, `thread_token_usage` | `protocol.rs:2239-2248` |
| `inter_agent_communication` / `inter_agent_communication_metadata` | the full envelope (`author`, `recipient`, `other_recipients`, `content`, `encrypted_content?`, `trigger_turn`) / only `{trigger_turn}` | `protocol.rs:804-820` |
| `compacted` | `message` (the summary), `replacement_history`, window ids, `latest_token_usage_record` | `CompactedItem` |
| `world_state` | `{full, state}`: a baseline, then patches, of the model's environment context (`environments`, `permissions`, `model`, `skills`, `agents_md`, …) | `protocol.rs:3172-3186` |
| `security_risk_score`, `realtime_item` | rare | |

`token_count` is not a record type: it is `event_msg` with `payload.type == "token_count"`. Counts in
the live parent rollout:

- 439 `event_msg:item_completed`, 205 `token_count` and 186 `token_usage_record`;
- 162 `reasoning` and 41 `inter_agent_communication_metadata`;
- 17 `world_state`, 9 `turn_context` and 1 `compacted`.

conch reads `session_meta`, `event_msg`, `response_item` and `token_count`
(`src/conversation.ts:843-990`, `src/context-meter.ts:34-41`) and nothing else.

**Databases.** All live under `~/.codex`, in WAL mode.

- `state_5.sqlite` holds `threads`. Its migrations are `codex-rs/state/migrations/0001…0052`; live
  columns include `name`, `title`, `preview`, `first_user_message`, `source`, `thread_source`,
  `agent_nickname`, `agent_path`, `model_provider`, `model`, `reasoning_effort`, `tokens_used`,
  `history_mode` and `recency_at_ms`. It also holds `thread_spawn_edges(parent_thread_id,
  child_thread_id, status)` (migration `0021`), plus projects and sections.
- `thread_history_1.sqlite` holds `thread_turns` (status, start and completion times, rollout
  offsets) and `thread_items`, whose `item_json` is the app-server `ThreadItem`
  (`codex-rs/state/thread_history_migrations/0001-0006`).
- Also: `queue_1` (queued turns), `goals_1`, `logs_2`, `memories_1`.

conch's note that `thread_turns` is sparse ("7 of them on this machine", `src/codex-threads.ts:675`)
is stale: 34 of 36 local threads have turn rows, and every thread is `history_mode = paginated`.

**The lock, and identifying a live process from outside.** The lock is
`thread-writer-locks/<thread-id>.lock`. A process opens it and holds an exclusive `try_lock` for as
long as it has the thread open for writing, under a `.coordination.lock`. The file is empty (no pid
inside), and the next process to acquire any lock deletes stale files (`writer_lock.rs:17-18,
40-160`).

So the reliable outside test is what conch does, `lsof` on the lock, with one refinement: the holder is
**whichever process hosts the app-server for that thread**, not necessarily a terminal. Live now:

- pid 2383 (the TUI) holds four locks: the parent and three running helpers;
- pid 74676 (the ChatGPT app's `codex app-server`) holds a Desktop thread's lock.

**Why conch misses the pid.** In order of likelihood:

1. The thread is inside conch's eight-hour window but no process has it open: a closed TUI, a
   finished helper, or a Desktop thread unloaded after "no subscribers and no thread activity for 30
   minutes" (`README.md:211`). There is no holder, so pid 0 is the truth, not an error.
2. `readCodexThreadPid` caches a miss for 30 s (`src/codex-threads.ts:306-330`), so a thread opened
   just after a poll stays pid-less until the cache expires.
3. A failing `lsof` returns undefined.

Two cases give a pid that is wrong to type into:

- a Desktop thread, whose holder is app-server with no tty;
- new with 0.154, any plain `codex` TUI once a daemon runs (`codex remote-control start` starts one).
  The holder becomes the daemon, and the TUI's tty is nowhere in the lock.

**Names and titles.** `thread/name/set` appends `{id, thread_name, updated_at}` to
`~/.codex/session_index.jsonl` ("append-only; the most recent entry wins",
`codex-rs/rollout/src/session_index.rs:21-50`). For paginated threads it also sets `threads.name`
(`codex-rs/thread-store/src/local/update_thread_metadata.rs:127-140`). `threads.title`, `preview` and
`first_user_message` come from the first prompt, and helpers carry `agent_nickname` and `agent_path`.
conch's `codexThreadLabel` (name, then nickname, then title) reads the right columns.

**What conch should do.** Demote "Codex row has no pid" to debug when no lock is held, since that
means closed. When one is held, log the holder's command, so an app-server or daemon holder is named
instead of typed into. Read `thread_turns` as the primary busy/idle source now that it is populated.
Touches the R seam, E8, C4/C15.

## 3. Hooks

Codex has a Claude-shaped hook system.

- **Events:** `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`,
  `Interrupt` (`codex-rs/protocol/src/protocol.rs:1576`,
  `codex-rs/app-server-protocol/src/protocol/v2/hook.rs:19-21`). Handler types are `command`,
  `mcp_tool`, `prompt` and `agent`, sync or async.
- **Config**, per layer: a `hooks.json` beside that layer's config, or `[hooks]` TOML inside
  `config.toml` (it warns when both are present); plugin-shipped `hooks/hooks.json`; managed hooks in
  `requirements.toml` (`codex-rs/hooks/src/engine/discovery.rs:128-175, 339-343`;
  `docs/config.md:9-15`).
- **Trust:** non-managed hooks run only once trusted by hash, and an edited hook becomes `Modified`
  and stops (`discovery.rs:794-811`). `--dangerously-bypass-hook-trust` overrides that for one
  invocation.
- **Payloads:** schemas are checked in at
  `codex-rs/hooks/schema/generated/*.command.{input,output}.schema.json`. `Stop` input is
  `session_id, turn_id, cwd, transcript_path, model, permission_mode, stop_hook_active,
  last_assistant_message, hook_event_name`. `PermissionRequest` adds `tool_name, tool_input, agent_id,
  agent_type` and returns a decision in `hookSpecificOutput`. `SubagentStop` adds `agent_id,
  agent_type, agent_transcript_path`.

`src/codex-hook.ts` reads exactly those Stop, UserPromptSubmit and SessionStart fields (`:23-32`) and
drops subagents by `agent_type != null` (`:211-212`), which matches the schema. It does not use:

- `SessionEnd`, which would remove a row at once instead of waiting for pid death;
- `Interrupt`;
- `SubagentStart` or `SubagentStop`;
- `PermissionRequest`.

The architecture's reason for polling still holds: hooks are config, and conch would additionally
have to get them *trusted*.

**What conch should do.** Do not grow the hook path; for sessions conch starts, the app-server stream
is strictly better. If hooks stay, add `SessionEnd` to `codex-hook.ts` and have `conch setup` say that
Codex will ask to trust the hook. Touches E8, B5.

## 4. Approvals and sandbox

**Flow** (`README.md:1924-1975, 2020-2064`; `common.rs:1690-1721`):

1. `item/started` announces the pending `commandExecution` or `fileChange`.
2. The server sends a request. `item/commandExecution/requestApproval` carries `threadId`, `turnId`,
   `itemId`, `command`, `cwd`, `reason`, `commandActions`, and optionally `availableDecisions`,
   network context and proposed policy amendments. `item/fileChange/requestApproval` carries `reason`
   and `grantRoot`. `item/permissions/requestApproval` carries the requested filesystem and network
   grants.
3. The client answers `{decision}`:
   - commands: `accept`, `acceptForSession`, `acceptWithExecpolicyAmendment`,
     `applyNetworkPolicyAmendment`, `decline`, `cancel`;
   - file changes: `accept`, `acceptForSession`, `decline`, `cancel`;
   - permissions: the granted subset plus `scope: turn|session`.
4. `serverRequest/resolved`.
5. `item/completed`, with `completed`, `failed` or `declined`.

Policy knobs:

- `--ask-for-approval on-request|never` (granular is experimental);
- `--sandbox read-only|workspace-write|danger-full-access`;
- permission profiles (`permissionProfile/list`);
- `approvalsReviewer: user|auto_review` (Guardian), and `--approve-for-me`.

**Can an outside process see or answer one?** Only as an app-server client subscribed to that thread.
Requests go to every subscribed connection (`codex-rs/app-server/src/outgoing_message.rs:295-345`).
A pending request is re-sent to a client that resumes the running thread (`outgoing_message.rs:362-382`,
`thread_lifecycle.rs:792`), and the first answer resolves it. Against an embedded TUI the only way in
is a `PermissionRequest` command hook that blocks and prints a decision, which means config plus trust
at every session start. The rollout is not a channel; conch measured no approval records there (B5).

**What B5 needs for Codex.** A daemon-hosted session with conch subscribed. conch speaks `command` and
`reason` from the request and maps yes to `accept`, "always" to `acceptForSession` (or the offered
amendment), and no to `decline`. It drops its prompt on `serverRequest/resolved` when the TUI answered
first. The value depends on Tyler's own policy: 560 of 561 local rollouts ran `approval_policy: never`
(B5). Touches B5, V.

## 5. Subagents

**Spawn and link.**

- A helper is its own thread. Its `session_meta.source` is
  `{"subagent":{"thread_spawn":{parent_thread_id, depth, agent_path, agent_nickname, agent_role}}}`
  (`SubAgentSource::ThreadSpawn`, `protocol.rs:2822-2837`). `parent_thread_id` is also top-level in
  `SessionMeta`, and `session_id` names the root.
- The state DB keeps the edge in `thread_spawn_edges` (live: ten `open` children under `01a08ea0`),
  and `thread/list` answers `parentThreadId` and `ancestorThreadId` (`README.md:178, 564-581`).
- Helpers run inside the parent's process (pid 2383 holds their locks). Under Multi-Agent V2 they
  refuse direct input with `-32600` "direct app-server input is not allowed for multi-agent v2
  sub-agents" (`README.md:1889`).
- The tools are `spawn_agent`, `send_input`, `resume_agent`, `wait` and `close_agent`
  (`collabToolCall` items), plus `subAgentActivity` items.
- `forked_from_id` (`protocol.rs:3042`) is set only by `thread/fork` or `codex fork`: a user's branch,
  not a helper.

**Messages** are `InterAgentCommunication {author, recipient, other_recipients, content,
encrypted_content?, trigger_turn}`, with agent paths such as `/root/ci_release` → `/root`
(`protocol.rs:804-820`). The enum has a separate `inter_agent_communication` record type, but in the
live parent they appear as `response_item` `agent_message` items with `author` and `recipient` (42 of
them), each followed by an `inter_agent_communication_metadata {trigger_turn}` line. conch detects them
by a text header (`isInterAgentEnvelope`, `src/codex-threads.ts:425`); the fields are the reliable test.

**Tokens live only in each thread's own rollout.**

- All 186 `token_usage_record` lines in the live parent carry the parent's own `thread_id`.
- Each helper's records are in its own file.
- `threads.tokens_used` is that thread's `total_token_usage.total_tokens`
  (`codex-rs/state/src/extract.rs:109`).

Live figures: the parent has 420.6 M, and the ten helpers 88.8 M between them (Bohr 30.9 M, Goodall
20.9 M, Zeno 14.0 M, …). Nothing rolls children up, which is why the earlier analysis found helpers
holding more than their parent: a meter on the parent alone undercounts by exactly its descendants.

**What conch should do.** Give the Codex adapter a `subagentSessions` (today `() => []`,
`src/agent-adapter.ts:284`) built from `thread_spawn_edges` plus `threads`. Nest live helpers under
their parent the way C4 does for Claude, and classify inter-agent messages by `author`/`recipient`.
Touches C4/C15, E8, the cost meter.

## 6. Context and cost

**Window.** The reported `model_context_window` is the resolved window × `effective_context_window_percent`,
which defaults to 95 (`codex-rs/protocol/src/openai_models.rs:377, 495`). The live session passes
`-c model_context_window=258400`, and its `token_count` says 245 480.

**Auto-compaction.**

- The limit is `min(model_auto_compact_token_limit, 90 % of the context window)`
  (`openai_models.rs:499-507`).
- It is measured either over the whole active context or only over the body after the initial prefix
  (`model_auto_compact_token_limit_scope`: `Total` | `BodyAfterPrefix`,
  `codex-rs/core/src/session/context_window.rs:61-80`).
- It fires when the scoped count reaches the limit (plus a fallback buffer when a fallback prompt is
  configured), or when the active context reaches the full window (`context_window.rs:95-110`).
- A compaction writes a `compacted` record with the summary and replacement history and emits
  `thread/compacted` / `contextCompaction`. Usage then restarts from the new history.

**Token fields** (`TokenUsage`, `protocol.rs:2216-2235`; helpers at `:2391-2436`):

- `input_tokens` includes cached input (`non_cached_input = input − cached`).
- `cached_input_tokens` counts cache reads.
- `cache_write_input_tokens` is new: serde default 0, present in 0.154 rollouts and absent from older
  ones. In the sample it fits inside the non-cached part (46 268 − 45 785 = 483 ≥ 480). That is
  inferred, not documented.
- `output_tokens` includes `reasoning_output_tokens`.
- `total_tokens = input + output`.

In `token_count`, `last_token_usage` is the latest response (its `total_tokens` is what Codex calls
`tokens_in_context_window`), and `total_token_usage` is the thread's running sum. Codex's own "% left"
subtracts a 12 000-token baseline (`BASELINE_TOKENS`, `protocol.rs:2391`). So conch's
`last.total_tokens / model_context_window` (`src/context-meter.ts:34-41`) is right, but reads a few
points fuller than the TUI.

**An accurate per-session cost meter:**

- sums `token_usage_record.usage` per `response_id` (deduplicated; one per response);
- prices non-cached input, cached input, cache writes and output separately, using the model from the
  matching `turn_context` (the record carries no model);
- adds every descendant from `thread_spawn_edges`.

For ChatGPT-plan sessions, `account/usage/read {threadId}` returns Codex's own estimate
(`estimatedUsageCreditsMicros`, `estimatedUsageUsdMicros`, per-model groups).

**What conch should do.** Keep the context bar and add the compaction line at 90 %. Build cost from
`token_usage_record` over the spawn tree, not from `token_count`, which is per thread and repeats
totals. Touches the cost/context meter, C4/C15.

## 7. Portability

**Providers.** A provider is `[model_providers.<id>]` with `name`, `base_url`, `env_key` and
`wire_api` (the local `openai-api` entry has exactly these keys). `wire_api` has one value left,
`responses` (`codex-rs/model-provider-info/src/lib.rs:63-69`). `--oss` and `--local-provider
lmstudio|ollama` cover local models.

**Encrypted reasoning.**

- Every request asks for `include: ["reasoning.encrypted_content"]` (`codex-rs/core/src/client.rs:995`).
- Reasoning is stored as a `response_item` `reasoning` with the ciphertext and usually an empty
  summary: 167 of 167 in the live parent, none readable. It is replayed as input on later turns.
- For a non-OpenAI provider, the client clears Codex's internal message metadata and encrypted function
  arguments (`client.rs:976-985`).
- I found no code that drops encrypted reasoning when the provider changes, so a different vendor
  would be sent ciphertext it cannot use. Not verified against a live non-OpenAI provider.

**Resume or fork with a different provider or model.**

- `thread/resume` reuses the thread's persisted model and effort unless `model`, `modelProvider`,
  `config.model` or `config.model_reasoning_effort` is supplied (`README.md:443`).
- The TUI tears down its embedded app-server when the provider changed at startup, because
  "App-server providers are fixed at startup" (`tui/src/lib.rs:1613-1619`).
- A respawned helper is pinned to its stored provider, and fails if that provider has gone from config
  (`codex-rs/core/src/agent/control/spawn.rs:424-435`).

Tyler's ChatGPT → OpenAI-API switch stayed within one vendor, and the session continued.

**A neutral record of a Codex thread** (for Atlas) needs:

- thread id and root `session_id`;
- the parent edge, `forked_from_id` and `forked_from_ordinal_exclusive`;
- cwd and git (`threads.git_*`), originator and CLI version;
- per turn, the provider, model and effort (`turn_context`);
- user messages and final assistant messages;
- tool calls with their outputs, file changes and the turn diff;
- compaction boundaries with their summary;
- inter-agent messages with author and recipient;
- per-response token usage.

Drop `encrypted_content`, `base_instructions` and `world_state`. The cleanest source is
`thread_items.item_json` (or `thread/turns/list` plus `thread/items/list`): the app-server's own
de-duplicated `ThreadItem`s, readable without resuming. A cross-harness continue is then a fresh thread
seeded with plain messages (`thread/start` plus `thread/inject_items`, `README.md:1150-1160`), never a
live join (C8's rule).

**What conch should do.** When Atlas starts, write the neutral record from `thread_items`, not from the
rollout conch parses today. Touches the Atlas index, C2.

## 8. MCP

**Codex as an MCP client.**

- Servers come from `[mcp_servers.<name>]` in any config layer and from enabled plugins.
- Each thread starts its own servers and fixes its MCP extension profile at thread start
  (`README.md:119-127`).
- `config/mcpServer/reload` applies on each thread's next turn, and `mcpServerStatus/list` reports
  runtime state.
- `mcpServer/tool/call` lets an app-server client call a thread's MCP tool directly.

conch reaches Codex through the plugin: `[plugins."conch@conch-local"]` is enabled, and conch's MCP
server runs as a child of the TUI (pid 2383, twice) and of the ChatGPT app-server (pid 74676).

One finding. The installed copy's `.mcp.json` uses absolute paths
(`~/.codex/plugins/cache/conch-local/conch/0.2.1/.mcp.json`). The shipped one
(`plugin/plugins/conch/.mcp.json`) runs `sh ${CLAUDE_PLUGIN_ROOT}/bin/conch-mcp`, and codex-rs never
expands `CLAUDE_PLUGIN_ROOT`. It expands only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`, for
Agent-Plugins-schema files (`codex-rs/codex-mcp/src/agent_plugin_config.rs:17-18, 177-230`). So a
marketplace install of conch into Codex is likely to fail to start its MCP server. Not verified on a
clean install.

**`codex mcp-server`.** In 0.153.4 it exists, prints "`codex mcp-server` is deprecated and will be
removed in a future release" (`codex-rs/cli/src/main.rs:155-156, 1183`), and exposes two tools,
`codex` and `codex-reply` (`codex-rs/mcp-server/src/codex_tool_config.rs:116, 235`;
`codex-rs/docs/codex_mcp_interface.md`). In 0.154.0 it is gone: `codex mcp-server --help` falls through
to the top-level help, and the tag diff deletes the subcommand. The supported programmatic surface is
app-server.

**What conch should do.** Check whether Codex's plugin loader resolves the shipped `.mcp.json`. If not,
ship a Codex-specific one: the Agent Plugins schema with `${PLUGIN_ROOT}`, or a bare `conch-mcp`
command. Do not build on `codex mcp-server`. Touches the plugin (C5), E8.

## 9. remote-control

**What it is.** `codex remote-control start|stop|pair` ("Manage the app-server daemon with remote
control enabled"; `pair` prints a short-lived manual pairing code; `--json`). Underneath are
`remoteControl/enable|disable|status/read|pairing/start|pairing/status|client/list|client/revoke` and
`remoteControl/status/changed` (`README.md:280-287`).

**How it works.**

- The daemon enrols with ChatGPT and holds an outbound websocket to
  `wss://chatgpt.com/backend-api/wham/remote/control/server` (the derivation is asserted in
  `codex-rs/app-server-transport/src/transport/remote_control/protocol.rs:300-309`).
- Frames carry whole app-server JSON-RPC messages, chunked and acknowledged (`protocol.rs:106-166`),
  so a paired device (the ChatGPT phone app) is simply another app-server client.
- It needs a ChatGPT sign-in, and admins can forbid it (`allowRemoteControl`, `README.md:307`).
- I found no application-layer encryption in that module; it relies on TLS to OpenAI.

**Overlap with conch's phone bridge.** The shape is the same: a relay, pairing, and a phone driving Mac
sessions. The scope differs:

- Codex's is Codex-only, OpenAI-hosted and account-bound, has no voice, and reaches only threads that
  daemon hosts.
- conch's relay is Tyler's own Worker, sees only encrypted bytes, and carries both agents plus audio.

One side effect to remember: `remote-control start` starts the daemon, so plain TUIs begin attaching
to it (section 2).

**What conch should do.** Keep the phone bridge, and do not try to join Codex's relay. Detect "a daemon
is running" (socket present) as a state, because it changes who holds locks and where turns can be
sent. Touches the phone bridge, C9b.

## 10. What conch reimplements, and conventions worth copying

Already exposed by Codex, rebuilt by conch:

| conch | Codex already has |
|---|---|
| turn-end detection from a 1 MB rollout tail (`src/codex-threads.ts:448`) | `turn/completed`, `thread/status/changed`; `thread_turns.status` on disk |
| message de-duplication across `response_item`/`event_msg` by text hash (`src/conversation.ts:813-841`) | `thread_items.item_json`, one `ThreadItem` per thing said |
| trust check by walking `config.toml` lines (`src/codex-threads.ts:117`) | `config/read`; `thread/start` marks trust itself |
| hand-read capability inventory (`src/agent-capabilities.ts`) and the B3 TOML writer (`src/config-write.ts`) | `skills/list`, `plugin/list`, `hooks/list`, `mcpServerStatus/list`, `config/read`, `configRequirements/read`; `config/value/write`, `config/batchWrite` (refuses managed keys) |
| "Codex has no rename" (`src/agent-adapter.ts:280`) | `thread/name/set` |
| interrupt by keystroke | `turn/interrupt` |
| resumable list by SQL | `thread/list` with filters and `useStateDbOnly` |
| C2's agent-to-agent delivery (shelved) | `codex queue --thread <id|name> --message <text>`, but only through a daemon; against an embedded session it refuses (`codex-rs/tui/src/session_queue_commands.rs:37-46`) |

Conventions worth copying:

- **Generated, pinned schemas.** The protocol types are the source of truth. JSON Schema and
  TypeScript are generated from them, checked in under `app-server-protocol/schema/{json,typescript}`,
  and a test regenerates and diffs them (`codex-rs/app-server-protocol/src/schema_fixtures_tests.rs:19-40`;
  `just write-app-server-schema`, `justfile:181`). conch's socket and relay protocols, hand-mirrored in
  Swift, would benefit from the same.
- **Protocol tests against a mock model.** They drive a real app-server against a mock model server
  (`codex-rs/app-server/tests/common/{test_app_server,mock_model_server}.rs`), compare whole objects
  rather than fields (`AGENTS.md:29`), and keep tests in sibling `*_tests.rs` files
  (`AGENTS.md:165-174`). The conch analogue is a fake `codex app-server` that replays recorded JSONL,
  so a Codex client can be tested without a model.

**What conch should do.** Replace these reimplementations only where the app-server path lands
(sections 1 and 4). Read `thread_items` and `thread_turns` now, since they need nothing new. Touches R,
E8, B3.

## Top five for conch

Ranked by value.

1. **Drive the Codex sessions conch starts through app-server, not keystrokes.** Run or reuse
   `codex app-server daemon`, open the TUI as `codex --remote unix://`, and join as a second client
   using `turn/start`/`turn/steer`, `turn/interrupt`, `thread/status/changed`, `turn/completed` and
   `thread/name/set`. For those sessions it removes tmux/AppleScript, the pid lookup, rollout polling
   and the trust prompt. It cannot reach an embedded TUI or ChatGPT-app threads, because one
   app-server holds a thread's writer lock. Evidence: `README.md:20-44, 171-307, 439`;
   `tui/src/lib.rs:862-927`; `thread_lifecycle.rs:792`. Rows: E8, C2, phone bridge.
2. **Voice approvals for Codex (B5).** Approval requests reach every subscribed client and are replayed
   on resume. conch answers `accept`, `acceptForSession` or `decline`, and stands down on
   `serverRequest/resolved`. Evidence: `common.rs:1690-1721`; `README.md:1924-1975, 2020-2064`;
   `outgoing_message.rs:295-382`. It depends on 1, and is worth it only once Tyler runs something
   other than `approval_policy: never`. Row: B5.
3. **A cost meter that counts helpers.** Sum `token_usage_record` per response across the
   `thread_spawn_edges` tree, priced by `turn_context.model`, with cached input, cache writes and output
   kept separate. Add the compaction line at min(configured, 90 % of the window). Evidence: a helper's
   tokens are only in its own rollout (all 186 parent records are the parent's; ten helpers hold
   88.8 M); `protocol.rs:2216-2248`; `openai_models.rs:499-507`. Rows: cost/context meter, C4/C15.
4. **Read Codex's own indexes instead of reconstructing them.** Use `thread_spawn_edges` to nest live
   helpers (the Codex adapter's `subagentSessions` is empty), `thread_turns` for busy/idle (no longer
   sparse), and `threads.name` / `session_index.jsonl` for names. Name the writer-lock holder in the
   log: pid 0 with no holder means closed; an app-server or daemon holder means do not type. Evidence:
   `state/migrations/0021`, `0041`; `writer_lock.rs:40-160`; live `lsof` (2383 holds the parent and
   three helpers, 74676 the Desktop thread). Rows: C4/C15, E8, R.
5. **Atlas's neutral Codex record, from `thread_items` and without the ciphertext.** Keep messages,
   tool calls, diffs, compaction summaries, inter-agent messages, per-turn provider and model, and
   per-response usage. Drop `encrypted_content` (all 167 reasoning items in the live parent are
   opaque). Continue elsewhere as `thread/start` plus `thread/inject_items`. Evidence:
   `client.rs:995`; `README.md:443, 1150-1160`; `spawn.rs:424-435`. Rows: Atlas, C2.

Also found, smaller: the shipped plugin's `${CLAUDE_PLUGIN_ROOT}` is never expanded by Codex
(section 8), and `codex mcp-server` no longer exists in 0.154.0.

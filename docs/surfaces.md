# The surfaces conch has to account for

Research date: 2026-08-17. This document is the master inventory behind the
backlog item “conch should know about skills and plugins, then toggle them”
(`docs/backlog.md:140-145`). It starts from conch's implementation, then checks
the current Claude Code and Codex documentation and a fresh checkout of t3code.

The short answer is that “installed” or “enabled” is not one state. For almost
every entity below there are four different truths:

1. **Configured**: a file on disk says the entity should exist.
2. **Available**: a newly initialized agent host can discover it.
3. **Loaded**: this particular running session has it in its effective runtime.
4. **Observed**: conch has seen the session actually use it.

Conch can cheaply establish much of (1), can establish (2) by launching a
separate probe, already sees fragments of (4), and usually cannot prove (3) for
a session it did not start. A fresh probe is not evidence about an unrelated
running process: that process may have different CLI flags, environment,
configuration home, working directory, trust decisions, session-time choices,
or an older snapshot of the same files.

That distinction should be part of the product model, not a caveat buried in a
tooltip. A row should say **configured**, **available in a fresh session**,
**loaded** or **used this turn**, and it should say how conch knows. “On” is only
honest when the host itself reports that state.

## Research basis and current conch boundary

The local pass covered the roadmap, prior parity study, vision, UI audit,
control contract, plugin template and installer, both session-discovery paths,
hooks, MCP server, transcript reducers, published panel state, Mac/iPhone
clients, lifecycle controls, and relevant tests. Generated/build output,
dependencies, lockfiles, binary/media fixtures and Xcode derived data were
excluded. Those files do not define an agent-facing surface.

Conch today is an observer and terminal operator, not an agent host:

- Claude sessions come from `~/.claude/sessions/<pid>.json`; conch keeps only
  session id, backend, name, cwd, pid, status, kind, entrypoint and transcript
  path (`src/sessions.ts:37-61`, `src/sessions.ts:77-121`).
- Codex sessions come from conch's optional hook registry and, when that is
  absent, read-only access to Codex's SQLite state, history, rollout paths and
  writer locks (`src/sessions.ts:311-332`, `src/codex-threads.ts:496-617`). The
  fallback is deliberately observational: the database is opened read-only and
  the session does not know conch is there (`src/codex-threads.ts:1-20`,
  `src/codex-threads.ts:109-136`).
- The published row contains backend, context usage, status, transcript, voice,
  priority, attention state and artifact, but no model, configuration source,
  permission mode, plugin, skill, MCP, hook or agent inventory
  (`src/panel.ts:150-182`, `src/panel.ts:330-401`).
- Transcript folding recognizes commands, file changes, reads, searches, web,
  subagents, plans, questions and MCP calls (`src/conversation.ts:303-359`). It
  observes an invocation, not the catalog from which that invocation came.
- Conch's own MCP server implements nine tools and advertises only the MCP
  `tools` capability; it does not expose resources or prompts
  (`src/mcp.ts:34-35`, `src/mcp.ts:121-250`, `src/mcp.ts:947-966`).
- Conch now starts or resumes a terminal session, but the launch contract has
  only backend, session id and cwd (`src/settings.ts:705-714`), and the actual
  command is plain `claude [--resume id]` or `codex [resume id]`
  (`src/session-lifecycle.ts:36-46`). It does not choose a configuration home,
  profile, model, permissions, plugins or MCP set.

The difficulty labels used below mean:

- **Cheap**: deterministic read-only parsing or a small extension of data conch
  already publishes. Cheap does not mean safe to edit globally.
- **Real work**: precedence, trust, secrets, watching, version skew, protocol
  integration or a new cross-client model has to be handled.
- **Blocked for attached sessions**: the host keeps authoritative state in
  memory and exposes it only inside that session or through a control protocol
  conch does not own. Conch can still offer a next-session change, or an
  authoritative feature for sessions it launches through such a protocol.

## The lesson from current t3code

The fresh study used t3code commit
[`a4cc1367`](https://github.com/pingdotgg/t3code/tree/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2),
committed 2026-08-17. The central claim in `docs/parity.md:3-6` remains exactly
right: t3code owns its agent runtimes while conch attaches to someone else's.
The implementation now makes the consequence even clearer:

- T3 Code is now a provider-neutral “agent harness control surface” for Codex,
  Claude, Cursor, Grok Build and OpenCode, with desktop, web and native mobile
  clients, not merely the narrower comparison captured in the old study
  ([current README](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/README.md)).
- It keeps configured provider instances separate from live adapters and routes
  every turn, approval, interrupt, checkpoint and session-stop operation through
  a provider service
  ([provider architecture](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/docs/internals/providers.md)).
- Its Codex provider starts a Codex app-server, asks that host for `model/list`
  and `skills/list`, and owns another app-server process for the session itself
  ([Codex probe](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/server/src/provider/Layers/CodexProvider.ts#L291-L415),
  [session runtime](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L900-L954)).
  It can therefore send per-turn model, effort, collaboration and permission
  choices and explicitly reload MCP before a turn
  ([turn construction](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L1803-L1835)).
- Its Claude provider owns an Agent SDK query. A separate no-prompt initialization
  probe disables hooks and MCP to discover account data and slash commands, and
  a filesystem scanner builds the skills picker
  ([Claude probe](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/server/src/provider/Layers/ClaudeProvider.ts#L600-L773),
  [skill scan](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/server/src/provider/Drivers/ClaudeSkills.ts#L1-L155)).
- Its composer resolves skills, slash commands and model lists per provider
  instance, rather than treating a provider name as the environment
  ([composer](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/web/src/components/chat/ChatComposer.tsx#L831-L850),
  [skill and command menus](https://github.com/pingdotgg/t3code/blob/a4cc1367b03ee0c1dc2b50fceac81ef5e63212e2/apps/web/src/components/chat/ChatComposer.tsx#L1047-L1105)).

What is stale or wrong in `docs/parity.md` now:

- “Codex has no hook mechanism” (`docs/parity.md:18-20`) is wrong. Current
  Codex has eleven documented lifecycle events and a trust UI, described under
  **Hooks** below. Conch's database observer is still necessary for sessions
  that did not start with its hooks.
- The table-stakes gaps at `docs/parity.md:29-36` are stale. The Mac composer,
  tool kinds, interrupt, questions, plans, diffs and queued delivery are shipped;
  the current roadmap says Phases 1 and 2 are complete
  (`docs/backlog.md:17-37`).
- “Neither agent exposes a cancel an outside process could call”
  (`docs/parity.md:79-81`) remains true for an arbitrary attached terminal, but
  not for a host-owned Codex session: app-server exposes turn interruption, and
  T3 Code uses its provider command path for it. The missing phrase is “outside
  process that did not create or connect to the host.”
- The 48-name runtime vocabulary is still visible in current t3code, but the old
  document now omits the surfaces relevant to this roadmap: multiple provider
  instances/accounts, model and skill catalogs, provider slash commands, hook
  activity, MCP status/OAuth, and per-thread permission modes.
- The old “Questions” item at `docs/parity.md:86-87` is complete, including voice
  and tap answers (`docs/backlog.md:31-37`).

No fourth comparator is included. Current t3code already contributes the lesson
that Claude Code and Codex themselves do not: an owning control plane can report
and change live state, while a passive companion must label inference. Another
IDE panel would add examples of layout, not another ecosystem entity or a new
answer to the attachment problem.

## 1. Runtime environment and provider instance

**What it is.** The executable, version, account/provider, configuration home,
environment, launch flags, cwd, trust state and host surface that determine
which of every later entity can exist.

**Outside-session discovery.** Claude normally uses `~/.claude`, but
`CLAUDE_CONFIG_DIR`, CLI flags, authentication/provider environment variables,
Desktop/IDE embedding, and the original cwd can produce different environments.
Codex similarly uses `$CODEX_HOME` (normally `~/.codex`), optional profiles,
project configuration, CLI overrides and different model providers. Codex's
documented precedence is CLI overrides, trusted project `.codex/config.toml`
layers, the selected `~/.codex/<profile>.config.toml`, user config, system config
and defaults ([Codex config basics](https://learn.chatgpt.com/docs/config-file/config-basic#configuration-precedence)).
Disk inspection can enumerate candidates; process environment and argv can
sometimes narrow them; neither proves every host-supplied or in-memory choice.

**Conch today.** Claude discovery is rooted at one configured `claudeDir`, and
Codex observation defaults to `~/.codex` unless a test/config override supplies
another home (`src/sessions.ts:271-347`, `src/codex-threads.ts:490-504`). The row
records cwd and backend, but no binary, version, account, configuration home,
profile, source surface or trust state (`src/sessions.ts:37-61`). A session held
on Claude's trust prompt may not register at all (`docs/backlog.md:140-143`).

**Good UI.** A session inspector should lead with backend and host surface
(Claude terminal, Claude IDE/Desktop/SDK, Codex TUI/IDE/app-server), version,
account/provider without exposing tokens, cwd/additional roots, configuration
home/profile, launch flags that conch can safely read, and trust/diagnostic
warnings. Every value needs a provenance chip: transcript, registry, process,
disk default, probe or unknown. New-session UI should let the user select a
named environment/profile rather than silently assuming the default home.

**Running-session truth.** Cwd can change live in both products. Account,
configuration home, most launch flags and trust initialization are start-bound.
A separate capability probe reports a fresh environment, not this running one.

**Difficulty: real work.** Process-to-session correlation, redaction, alternate
homes, provider-specific environments, trust and IDE-hosted sessions all matter.
It is foundational work because every later “effective” calculation is wrong
without it.

## 2. Plugins and marketplaces

**What it is.** An installable bundle that can contribute several other
surfaces as one unit, plus the marketplace/source and policy that distribute it.

**Outside-session discovery.** Claude plugins may contain skills, agents, hooks,
MCP and LSP servers, monitors, output styles, themes, workflows, binaries and
settings. A plugin has an optional `.claude-plugin/plugin.json`, conventional
component directories, and can be loaded from a marketplace/cache, a skills
directory, `--plugin-dir` or `--plugin-url`. Installation state lives in scoped
settings; copied packages live under `~/.claude/plugins/cache`; `claude plugin
list --json` is the best supported machine-readable inventory. Install scopes
are user, project, local and managed
([Claude plugin reference](https://code.claude.com/docs/en/plugins-reference#plugin-installation-scopes)).

Codex now has a real plugin system, not merely “plugin equivalents”: universal
marketplaces, `.codex-plugin/plugin.json`, bundled skills, MCP servers, hooks and
apps/connectors. `codex plugin list --json` returns installed and available
entries with enabled state, source, version and policy; marketplace list is also
machine-readable. Plugins work in the CLI and ChatGPT surfaces, but not the
Codex IDE extension
([Codex plugins](https://learn.chatgpt.com/docs/plugins),
[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-plugin)).

**Conch today.** Conch ships parallel Claude and Codex marketplace manifests,
plugin manifests, one skill, an AGENTS file, an MCP declaration and launcher
(`plugin/.claude-plugin/marketplace.json:1-14`,
`plugin/.agents/plugins/marketplace.json:1-16`,
`plugin/plugins/conch/.codex-plugin/plugin.json:1-10`). The installer materializes
that bundle under `~/.config/conch/plugin-dist` and invokes each product's
marketplace/install CLI (`src/plugin-install.ts:145-171`,
`src/plugin-install.ts:187-215`). The Mac app's only general plugin awareness is
a one-time boolean: it searches a few directories or the text `conch@`, with no
version, enabled state, scope or component validation
(`mac-app/conch-mac/PluginPresence.swift:3-48`,
`mac-app/conch-mac/StateStore.swift:26-28`,
`mac-app/conch-mac/StateStore.swift:70-86`). Its copied Claude marketplace
command is unrelated to the local installer and should not be treated as a
source of truth (`mac-app/conch-mac/DashboardView.swift:297-327`).

**Good UI.** Show installed, enabled and available plugins grouped by ecosystem,
marketplace and scope; version/update state; source and trust/policy; components
and their token/tool implications; authentication/setup failures; and whether
the plugin can apply to the selected host surface. Let users install, update,
enable, disable and remove at an explicit scope, inspect the manifest and data
directory, and copy the exact recovery command. Conch's own plugin should get a
health check: manifests present, correct version, skill available, MCP declared,
nine tools advertised, and hooks separately wired where required.

**Running-session truth.** In Claude, skill text changes are live, but other
plugin component changes require `/reload-plugins` or restart. Enabling or
disabling a plugin does not become a truthful runtime state until that reload;
already-running monitors survive a mid-session disable and require session end
to stop. Marketplace updates keep old paths in a running session until reload,
and monitors keep them until restart
([Claude plugin reload behavior](https://code.claude.com/docs/en/plugins-reference#edit-reload-and-disable-a-skills-directory-plugin),
[plugin path lifetime](https://code.claude.com/docs/en/plugins-reference#plugin-root)).
Codex tells users to start a new session after installing a plugin before using
its skills or tools ([Codex plugin browser](https://learn.chatgpt.com/docs/plugins#plugin-browser-in-codex-cli)).
For an arbitrary attached session, conch can safely offer **change for future
sessions**. It cannot call the internal reload/browser and then certify success.

**Difficulty: real work.** CLI inventories make installation state tractable,
but cross-scope precedence, policies, version skew, component health and the
attached-session boundary rule out a simple toggle.

## 3. Skills, legacy commands and workflows

**What it is.** A named `SKILL.md` procedure whose small metadata is always
discoverable and whose full instructions/resources load only when invoked;
custom command and workflow surfaces increasingly converge on this form.

**Outside-session discovery.** Claude loads personal `~/.claude/skills`, project
`.claude/skills` walking parent/nested directories, added-directory skills,
managed skills and plugin skills. Legacy `.claude/commands` shares the command
namespace. The initial context contains names and descriptions; full skill text
loads on invocation, remains in context, and is reattached after compaction
within documented budgets
([Claude skills](https://code.claude.com/docs/en/skills#how-skills-work),
[skill context cost](https://code.claude.com/docs/en/skills#context-costs)).
The `/skills` menu can persist `on`, `name-only`, `user-invocable-only` (shown
as “user-only” in the menu) or `off` for non-plugin skills in
`.claude/settings.local.json`; plugin skills are managed as plugins
([Claude skill overrides](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings)).

Codex scans `.agents/skills` from cwd to repository root, `$HOME/.agents/skills`,
`/etc/codex/skills`, system skills and plugin skills; symlinks are supported.
Its initial skill list contains name, description and path, capped at 2% of the
context window or 8,000 characters, while a selected skill loads in full.
`[[skills.config]]` entries disable local skills by path
([Codex skills](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills),
[progressive disclosure](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills)).
A fresh app-server can `skills/list(forceReload)`, emits `skills/changed`, and
can `skills/config/write`, but that is the state of that app-server host
([Codex app-server skills API](https://learn.chatgpt.com/docs/app-server#skills)).

**Conch today.** Conch generates the `conch-control` SKILL from the single
agent-facing contract and a short always-on Codex AGENTS preamble
(`src/plugin-install.ts:69-106`, `src/plugin-install.ts:199-215`). The skill says
what each of conch's tools does and when to surface artifacts
(`docs/conch-control-skill.md:19-85`). Conch neither inventories other skills nor
publishes whether its own skill is discoverable, loaded or invoked. A skill
invocation may appear merely as a generic tool/command in the transcript.

**Good UI.** Show name, description, scope, provider, file path, plugin owner,
enabled/visibility state, invocation policy, allowed tools, model/effort/context
mode, bundled scripts/references, validation errors and approximate listing/full
token cost. Distinguish **available** from **loaded in this conversation** and
show observed invocations in the timeline. Let users open/edit their own skill,
change visibility at an explicit scope, invoke it into the composer, and install
or remove plugin-owned skills through the plugin. Do not expose arbitrary
script execution as a preview.

**Running-session truth.** Claude watches existing skill directories and applies
add/edit/remove in the current session. Creating the first top-level skills
directory requires restart; plugin non-skill components still require reload
([Claude live skill detection](https://code.claude.com/docs/en/skills#live-change-detection)).
Codex says it detects skill changes automatically, with restart as the fallback
([Codex build skills](https://learn.chatgpt.com/docs/build-skills#create-a-skill)).
The official Codex docs do not clearly promise that hand-editing
`[[skills.config]]` changes an already-running unrelated TUI; treat that control
as next-session unless conch owns an app-server and gets confirmation from
`skills/config/write`. Already-invoked instructions remain in conversation
context even if their source is later disabled.

**Difficulty: real work.** Filesystem inventory is cheap, but correct discovery
depends on cwd, nested roots, config home, plugin ownership, shadowing and
runtime invalidation. Loaded-state proof is blocked for attached sessions.

## 4. MCP server definitions, transport, authentication and health

**What it is.** A named connection from the agent host to an MCP server, with a
transport, credentials, lifecycle, capability catalog and tool policy.

**Outside-session discovery.** Claude supports stdio, Streamable HTTP, legacy
SSE and WebSocket definitions, with OAuth for compatible remote transports.
Local and user entries live in `~/.claude.json`, project entries in `.mcp.json`,
managed entries in managed configuration, and plugins can bundle `.mcp.json`.
Duplicate precedence is local, project, user, then plugin/connector handling;
`claude mcp list` and `get` enumerate configured servers
([Claude MCP transports and CLI](https://code.claude.com/docs/en/mcp#add-an-mcp-server),
[scopes and precedence](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)).
Connection state such as connected, cached, pending, failed, disabled or needing
authentication is runtime state shown by `/mcp`, not derivable from the config.

Codex supports stdio and Streamable HTTP, bearer/OAuth/ChatGPT authentication,
startup/tool timeouts, required servers, enable flags, tool allow/deny lists and
per-server/per-tool approval modes in `[mcp_servers.<name>]`. `codex mcp list`
reports configured servers; CLI, app and IDE share the user/project config
([Codex MCP](https://learn.chatgpt.com/docs/extend/mcp),
[configuration keys](https://learn.chatgpt.com/docs/config-file/config-reference#mcp_servers)).
An app-server can report full server, tool, resource and auth status and read a
resource
([Codex app-server MCP API](https://learn.chatgpt.com/docs/app-server#configuration-and-mcp-apis)).

**Conch today.** The conch plugin contributes one stdio MCP definition. The
installer rewrites it to the correct Bun/compiled invocation
(`plugin/plugins/conch/.mcp.json:1-8`, `src/plugin-install.ts:130-159`,
`src/plugin-install.ts:199-210`). The Mac “plugin installed” badge does not test
whether this server connects. Conversation rows render a used MCP call by its
server and tool name (`src/conversation.ts:337-342`,
`src/conversation.ts:559-570`); there is no configured-server inventory or
health/auth model.

**Good UI.** For each server show source/scope/precedence, transport, endpoint or
redacted command, enabled/required state, connection/auth status, startup and
tool timeouts, server instructions, plugin owner, available/disabled tools,
approval policy, resource/prompt counts, last error and last observed call.
Credentials must be represented as “from environment/keychain/header helper,”
never echoed. Let users add/edit/remove, enable/disable, authenticate, retry and
open logs at a chosen scope. A server from a project or plugin should link back
to that owner rather than look like an unrelated global entry.

**Running-session truth.** Claude's `/mcp` can disable or re-enable a configured
server for the current project and persists that project choice; servers can
refresh tools, resources and prompts live with MCP `list_changed`. Editing the
MCP configuration itself takes effect only after restart. Plugin server changes
require `/reload-plugins`, although unchanged connections are retained
([Claude MCP server management](https://code.claude.com/docs/en/mcp#manage-your-servers),
[dynamic capability refresh](https://code.claude.com/docs/en/mcp#dynamic-tool-updates),
[configuration restart boundary](https://code.claude.com/docs/en/prompt-caching#connecting-or-disconnecting-an-mcp-server)).
Codex app-server has `config/mcpServer/reload`, which reloads disk configuration
and queues a refresh for threads loaded by that server. A new app-server cannot
apply it to an unrelated TUI process. For an attached session conch may say
“configured; restart required,” never “connected.”

**Difficulty: real work; live attached health is blocked.** Config parsing and
CLI inventory are manageable. Authentication, safe redaction, non-default homes,
process lifecycle, reconnect state and authoritative runtime catalogs require a
host connection.

## 5. MCP tools

**What it is.** Model-callable operations advertised by a connected MCP server,
including schema, annotations, approval behavior and runtime results.

**Outside-session discovery.** A config entry does not contain the catalog. The
host learns it from `tools/list`; Claude may defer most definitions with tool
search and load them only when needed. Claude permission rules use scoped names
such as `mcp__server__tool`, while plugin servers are additionally scoped
([Claude tool search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search),
[MCP permission rules](https://code.claude.com/docs/en/permissions#mcp)). Codex
app-server's `mcpServerStatus/list` can return tools and auth state. Starting or
connecting to a configured server independently merely to enumerate it may run
an arbitrary stdio command or touch a remote service; it is an explicit probe,
not passive file reading.

**Conch today.** It folds calls from both ecosystems into `mcp_tool_call` and
shows a readable server/tool label, arguments summary, completion and result
(`src/conversation.ts:303-359`, `src/conversation.ts:559-570`). It does not keep
schemas, descriptions, annotations, tool policy or a never-used catalog. Its own
server defines nine schemas but exports no catalog into panel state
(`src/mcp.ts:115-250`).

**Good UI.** Under each server, show tool name/description, input shape in human
language, read-only/destructive/interaction annotations, approval policy,
enabled state, source, observed usage and last error. Search should work across
tools; policy changes should say whether they affect the server, one tool, one
project or only a future session. The conversation should link a tool call back
to its catalog entry.

**Running-session truth.** Tool catalogs can change live only through the
connected host's MCP negotiation and `list_changed`. A call observed in a
transcript proves that tool was available at that moment; it does not prove it
is still available. Conch cannot honestly provide a live tool enable/disable
for an arbitrary attached session.

**Difficulty: blocked for exact attached catalogs.** Observed-call enrichment is
cheap. Full schemas and current policy require a safe capability probe or an
owned host; probing every configured server by spawning it is too consequential
to do silently.

## 6. MCP resources, prompts, server instructions and elicitation

**What it is.** Non-tool MCP surfaces: browsable/readable resources, reusable
server prompts, host-visible server guidance, and server requests for human
input or authorization.

**Outside-session discovery.** Claude exposes resources in `@` completion and
adds list/read resource tools; MCP prompts appear as
`/mcp__server__prompt`. Both update dynamically, and MCP elicitation can request
a form or URL-mode interaction
([Claude resources](https://code.claude.com/docs/en/mcp#use-mcp-resources),
[MCP prompts](https://code.claude.com/docs/en/mcp#use-mcp-prompts-as-commands),
[elicitation](https://code.claude.com/docs/en/mcp#respond-to-mcp-elicitation-requests)).
Codex documents reading server `instructions` and app-server explicitly lists
and reads resources. The current Codex host docs do not document MCP prompts as
a Codex UI surface; conch should record that as **unknown/not exposed**, not
infer support from the MCP protocol
([Codex supported MCP features](https://learn.chatgpt.com/docs/extend/mcp#supported-mcp-features),
[Codex app-server MCP API](https://learn.chatgpt.com/docs/app-server#configuration-and-mcp-apis)).

**Conch today.** None are modeled. Conch's MCP server advertises only tools
(`src/mcp.ts:947-964`). Claude's `elicitation_dialog` is treated as a generic
“needs you” notification with no form fields (`src/hook.ts:79-80`,
`src/hook.ts:250-270`).

**Good UI.** Put resources in the attachment/mention picker with URI, MIME type,
server and refresh state; put prompts in the command palette with arguments;
show server instructions in the inspector; render elicitation as a typed form
or safe external authorization link and send an explicit accept/decline result.
Do not display an elicitation as a yes/no permission unless its schema is
actually yes/no.

**Running-session truth.** These are live connection capabilities. Claude can
refresh them in-session. Codex resources are live through the app-server that
owns the initialized server. An attached transcript may prove a specific use,
but conch otherwise cannot inventory or answer them from outside.

**Difficulty: blocked for attached sessions; real work for owned sessions.** It
requires capability schemas, secure rendering, URI handling and an actual
response channel. Generic keypress injection is not adequate for a form.

## 7. Persistent instructions and memory

**What it is.** Files and generated memory that become model context without an
explicit skill invocation.

**Outside-session discovery.** Claude uses managed/user/project/local
`CLAUDE.md`, imports, `.claude/rules/*.md`, nested and path-scoped instructions,
plus machine-local auto memory under `~/.claude/projects/<project>/memory/`.
`/memory` lists candidate files; `/context` says which ones actually loaded.
Only the first 200 lines or 25KB of `MEMORY.md` load at conversation start
([Claude memory](https://code.claude.com/docs/en/memory)).

Codex builds an AGENTS chain once per run: `$CODEX_HOME/AGENTS.override.md` or
`AGENTS.md`, then at most one `AGENTS.override.md`, `AGENTS.md` or configured
fallback per directory from project root to cwd. Later/closer text wins and the
default combined cap is 32KiB
([Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md#how-codex-discovers-guidance)).
Logs or saved session JSONL can sometimes audit what Codex loaded; filesystem
resolution alone still misses launch overrides and truncation effects.

**Conch today.** The plugin installs a short AGENTS instruction for Codex and a
progressively loaded skill. The old installer paths for modifying global
CLAUDE.md/AGENTS remain as unused helpers, while setup explicitly says it no
longer writes those global prompts (`src/install.ts:13-116`,
`src/install.ts:412-422`). Conch does not inventory the user's instructions or
memory and does not show which part of its contract reached a session.

**Good UI.** Show the resolved chain in load order, scope, byte/token size,
imports, shadowed/override status, path conditions, truncation and a content
hash. Separate “would load for cwd” from “confirmed loaded.” Provide open/edit,
validation and an instruction-conflict warning; never silently rewrite a user's
global prompt. Auto memory should be browsable, searchable and clearly marked
as agent-written machine-local state.

**Running-session truth.** Claude reads root/user CLAUDE files at session start
and keeps that version; edits apply after `/clear`, `/compact` or restart.
Nested/path-scoped instructions can load later when their path is touched
([Claude prompt caching](https://code.claude.com/docs/en/prompt-caching#editing-claudemd)).
Codex builds its AGENTS chain once per run and requires restart for changes
([Codex verification](https://learn.chatgpt.com/docs/agent-configuration/agents-md#verify-your-setup)).
Conch can safely offer “edit source,” but not claim an attached session has the
new text.

**Difficulty: real work.** Resolution and display are tractable, but imports,
nested lazy load, path rules, byte budgets, alternate homes and proof of actual
load need careful provenance.

## 8. Subagent definitions and live subagent threads

**What it is.** Reusable specialist definitions, plus the child contexts that a
main agent spawns to do delegated work.

**Outside-session discovery.** Claude has built-in Explore, Plan,
general-purpose and other agent types; custom Markdown definitions live in
managed scope, `~/.claude/agents`, project `.claude/agents`, plugins or `--agents`.
Definitions can choose tools, disallowed tools, model, effort, permission mode,
skills, MCP, hooks, memory, background mode and worktree isolation. Existing
agent directories are watched live. Runtime child transcripts are under the
parent session's `subagents/agent-<id>.jsonl`
([Claude subagents](https://code.claude.com/docs/en/sub-agents),
[scope and live detection](https://code.claude.com/docs/en/sub-agents#choose-the-subagent-scope)).

Codex enables subagent workflows by default in current local clients. Custom
TOML agents live in `~/.codex/agents` and `.codex/agents`; `name`, `description`
and `developer_instructions` are required, and other config keys can override
model, reasoning, sandbox, MCP and skills. The CLI's `/agent`/`/subagents` opens
live child threads
([Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents),
[Codex agent command](https://learn.chatgpt.com/docs/developer-commands?surface=cli#switch-agent-threads-with-agent)).
Codex app-server exposes parent/ancestor thread filters and runtime events for
child threads, but only for a host conch is connected to
([Codex app-server thread list](https://learn.chatgpt.com/docs/app-server#list-threads-with-filters-and-pagination)).

**Conch today.** The transcript vocabulary has a `subagent` tool kind
(`src/conversation.ts:303-324`). Claude's `SubagentStop` is explicitly discarded
so it cannot masquerade as the main turn ending (`src/hook.ts:144-147`), and
Codex hook payloads with `agent_type` are discarded (`src/codex-hook.ts:206-220`).
Conch scans fresh Claude child transcript files only to decide whether the main
session still has background work; it publishes no child identity, task or
progress (`src/agent-activity.ts:133-159`). It has no definition library.

**Good UI.** Two views are needed. **Library** shows built-in/custom/plugin
agents, scope, prompt summary, tools, model/effort, permissions, skills/MCP,
background/isolation and validation. **Runtime** shows a parent-child tree,
task, status, start/end, model, token usage, latest summary, pending question,
files/worktree and whether the child is blocking the parent. Let users open a
child transcript and, only with a real control channel, steer/interrupt/close it.
The feed should surface a child that needs a decision without announcing every
child completion as a completed main turn.

**Running-session truth.** Claude picks up edits in agent directories that
existed at session start; a newly created agents directory, added-directory
agents and slash-command-disabled sessions require restart. A running child
keeps the definition it started with. Current Codex docs do not promise hot
reload for custom-agent TOML, so treat edits as next-spawn/next-session unless a
connected host reports otherwise. Runtime controls are blocked for arbitrary
attached sessions; sending a prompt to the parent is not the same as steering a
child.

**Difficulty: real work for inventory and observation; blocked for direct
attached controls.** Claude transcript evidence can improve incrementally.
Codex parentage and precise live state require app-server or reliance on
unstable internal rollout/database fields.

## 9. Agent teams, shared tasks and background sessions

**What it is.** Coordinated multi-agent state above individual subagents:
members, mailboxes, task dependencies, ownership, worktrees and background
session lifecycle.

**Outside-session discovery.** Claude team configuration is written under
`~/.claude/teams/session-<first-eight-id>/config.json`, mailboxes under that
team's `inboxes`, and tasks under `~/.claude/tasks/<team-name>/`. Team config is
updated as members join/idle/leave and removed when the session ends; task state
persists for resume
([Claude agent-team architecture](https://code.claude.com/docs/en/agent-teams#architecture)).
Codex represents spawned agents as related threads and exposes them in supported
clients and app-server. Both ecosystems also have background work that can
outlive a foreground turn.

**Conch today.** Plans become checklist rows, and a boolean prevents a Claude
main session from being announced while fresh background subagent work remains
(`src/conversation.ts:508-556`, `src/agent-activity.ts:133-180`). Team members,
mailboxes, task assignment/dependencies and background session controls are not
published.

**Good UI.** Show a compact task tree/list with owner, dependencies, status,
last activity, blockers and result; team members with role and current task;
background sessions as separate children; and a single “needs you” item for a
blocked decision. Read team runtime files defensively and never edit Claude's
mailboxes/config directly. Mutations should go through the owning agent host.

**Running-session truth.** Files can make this observable in near-real time, but
the producer owns their consistency and cleanup. Stop, reassign, approve-plan or
message operations need a host-supported command; file mutation would be an
unsupported interference with a live session.

**Difficulty: real work to observe; blocked to control attached teams.** It is
valuable to the feed because tasks and blockers are attention units, but it must
start read-only.

## 10. Hooks

**What it is.** User/plugin/managed handlers that run at defined lifecycle
events and can observe, add context, request decisions, or block work.

**Outside-session discovery.** Claude hooks merge from managed, user, project
and local settings, plugin `hooks/hooks.json`, invoked-skill frontmatter,
subagent frontmatter and in-memory SDK/session hooks. Handler types include
command, HTTP, MCP tool, prompt and experimental agent handlers. Current Claude
Code documents 31 events:

`SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`,
`PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`,
`PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`,
`SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`,
`TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`,
`DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`,
`PostCompact`, `Elicitation`, `ElicitationResult`, and `SessionEnd`
([Claude hook reference](https://code.claude.com/docs/en/hooks#hook-lifecycle)).

Codex merges hooks from `~/.codex/hooks.json`, inline user config, trusted
project `.codex` hooks/config, plugins and managed requirements. Current Codex
documents eleven events: `SessionStart`, `SessionEnd`, `SubagentStart`,
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`UserPromptSubmit`, `SubagentStop`, and `Stop`. Only command handlers run today;
prompt and agent types are parsed but skipped. Non-managed definitions are
hash-trusted, and `/hooks` can inspect, trust and disable them
([Codex hooks](https://learn.chatgpt.com/docs/hooks)).

**Conch today.** Setup installs only Claude `Stop`, `Notification` and
`UserPromptSubmit` hooks (`src/install.ts:720-759`). Optional Codex installation
installs only `SessionStart`, `UserPromptSubmit` and `Stop`
(`src/install.ts:645-712`). The Claude receiver handles those three, filters
notification subtypes and rejects all unknown events (`src/hook.ts:116-163`,
`src/hook.ts:250-272`); the Codex receiver likewise rejects every other event
and all subagent events (`src/codex-hook.ts:206-220`). There is no hook library,
health, trust or recent-execution UI.

**Good UI.** Show every configured hook grouped by event, source/scope, matcher,
handler type, command/URL with secrets redacted, timeout/async status, trust,
managed lock, plugin/skill/agent owner, last execution/duration/exit and whether
it can block. Let users open its source, run a non-executing validation, trust or
disable where the host supports it, and disable all at an explicit scope with a
clear warning. Conch's own hook health should say installed, trusted, last seen
and which event coverage is intentionally absent.

**Running-session truth.** Claude's `/hooks` is a read-only browser; individual
disable is not supported, while `disableAllHooks` and direct settings edits are
normally file-watched into the running session. Managed hooks may be immune,
and a `ConfigChange` hook can block a change from applying
([Claude hook menu and disable rules](https://code.claude.com/docs/en/hooks#the-hooks-menu)).
Codex `/hooks` can trust/disable non-managed hooks, but the docs do not promise
that an external edit is adopted by an already-running unrelated TUI. Plugin
and session hooks may also be absent from disk. Therefore attached-session hook
editing is not a reliable live toggle.

**Difficulty: real work.** Static parsing is modest; merged semantics, trust,
managed policy, plugin ownership, in-memory hooks and execution telemetry are
not. Conch must never “test” a hook by executing its command without consent.

## 11. Slash commands and command palettes

**What it is.** User-entered commands that operate the host, expand a skill or
workflow, or invoke an MCP prompt without a normal model turn.

**Outside-session discovery.** Claude's command set is version/plan/platform
dependent and combines built-ins, skills/legacy commands, plugin commands and
dynamic MCP prompts. A Claude Agent SDK initialization result can enumerate the
commands of the fresh SDK host, which is the approach current t3code uses; disk
scanning alone misses built-ins and connected prompts. The current command
reference includes session lifecycle, model/effort, permissions, MCP/plugins,
skills, agents/tasks, context/memory, goals/schedules, worktrees and diagnostics
([Claude commands](https://code.claude.com/docs/en/commands)).

Codex documents `/model`, `/fast`, `/personality`, `/permissions`, `/approve`,
`/agent`, `/plugins`, `/hooks`, `/skills`, `/mcp`, `/status`, `/debug-config`,
`/compact`, `/fork`, `/rename`, `/review` and others
([Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#slash-commands)).
Plugins, skills and host version can add or remove palette items.

**Conch today.** Composer/voice text is delivered to the terminal as user input;
there is no provider command catalog, completion, argument UI or distinction
between a command and a model prompt. Plans/questions are recognized only after
they appear in transcript events (`src/conversation.ts:370-556`).

**Good UI.** A unified command palette should group **conch controls**,
**provider host commands**, **skills**, **MCP prompts** and **session actions**;
show description, arguments, provider/version availability, whether it costs a
model turn, and whether it is safe while a turn is running. Selecting a skill
should fill or send its canonical invocation. Commands with interactive menus
need a real response UI, not blind key sequences.

**Running-session truth.** Commands are intrinsically live when entered in the
target host, and some can be queued while a turn runs. Conch can type into a
routable Terminal session, but many commands open a picker or confirmation and
there is no structured acknowledgement. Exact catalog and completion are
blocked without a host protocol; a separate SDK/app-server probe is only an
“available in a fresh host” catalog.

**Difficulty: real work; exact attached catalog is blocked.** A useful static
palette is possible, but a trustworthy execution path needs command-specific
handling and readback.

## 12. Settings, configuration layers, feature flags and policy

**What it is.** The layered configuration that enables features and supplies
defaults, environment, tools, retention, notifications, UI behavior and
enterprise constraints.

**Outside-session discovery.** Claude settings span managed/server/MDM sources,
CLI `--settings`, local, project and user JSON. Precedence is key-specific and
array values often merge; `/status` identifies sources actually loaded. Most
settings files are watched live, while selected system-prompt/startup keys are
not
([Claude settings](https://code.claude.com/docs/en/settings#settings-files),
[when edits take effect](https://code.claude.com/docs/en/settings#when-edits-take-effect)).

Codex configuration spans CLI `-c`/flags, trusted nested project TOML, profile,
user, system defaults and managed `requirements.toml`. It includes model and
provider, reasoning/personality, approval/sandbox/permission profiles, web and
network policy, features, apps, MCP, skills, agents, hooks, rules, shell
environment, history, notifications and TUI behavior. `config/read` on a Codex
app-server resolves the effective disk layering for that host
([Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[app-server config API](https://learn.chatgpt.com/docs/app-server#configuration-and-mcp-apis)).

**Conch today.** Conch has its own curated live daemon settings through the
socket/MCP, but no reader or editor for Claude/Codex settings. Its new-session
request cannot choose a profile or one-off override (`src/settings.ts:705-725`,
`src/settings.ts:979-1004`). Its assumption about effective session behavior is
therefore independent of the files that determine that behavior.

**Good UI.** Use a resolved inspector, not a raw settings dump: key, effective
value, source layer, lower-priority values, merge behavior, managed constraint,
validation/deprecation warning, secret redaction and restart boundary. Editing
must require a target scope and show the exact file/diff before saving. Offer
named launch profiles for conch-started sessions. Raw JSON/TOML editing can be a
secondary escape hatch.

**Running-session truth.** Claude explicitly hot-reloads most settings,
including permissions, hooks and credential helpers; `model` from settings is a
startup default changed live through `/model`, and `outputStyle` waits for
`/clear` or restart. Codex has live commands for selected values, but a disk
change does not prove a running attached TUI adopted it. CLI/env/session
overrides are not recoverable from base config alone.

**Difficulty: real work.** Correct precedence and schema/version handling are
the feature. A generic key-value editor would be cheap and misleading.

## 13. Permissions, sandbox, approvals and trust

**What it is.** The effective limits on tool use, filesystem and network access,
plus each pending human authorization decision.

**Outside-session discovery.** Claude modes are default/manual, accept-edits,
plan, auto, don't-ask and bypass; deny beats ask beats allow, and rules can
target tools, paths, commands, domains, MCP and subagents. `/permissions` shows
sources and edits rules. Permanent Bash/WebFetch approvals are saved to project
local settings, while file-edit approval lasts only for the session
([Claude permissions](https://code.claude.com/docs/en/permissions)). Workspace
trust additionally gates project settings/plugins and executable configuration.

Codex combines approval policy with OS sandbox, network/web policy, rules,
permission profiles and managed requirements. `/permissions` changes the active
mode; `/status` reports active model, approval policy and writable roots
([Codex approvals and sandbox](https://learn.chatgpt.com/docs/agent-approvals-security),
[Codex commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli#update-permissions-with-permissions)).
App-server has structured approval and permission-profile requests for clients.

**Conch today.** Claude `permission_prompt`/elicitation notifications become a
generic attention event. The daemon asks for voice yes/no and injects terminal
keys, but the notification can also represent `AskUserQuestion`, so conch
deliberately avoids claiming it knows the exact permission request
(`src/hook.ts:250-270`, `src/daemon.ts:2394-2408`). Structured questions are
instead parsed from transcript tool calls. The four-way “approve once / session
/ permanent / decline” remains blocked because a blind keypress can approve the
wrong menu choice (`docs/parity.md:91-105`). No effective permission mode or
rule set is published.

**Good UI.** Show active mode, approval policy, sandbox roots, network/web
access, relevant rules with source/precedence, managed locks and workspace
trust. Pending approval cards must show the exact tool, arguments/diff/path or
network destination, risk annotation and every decision the host supports,
including the persistence scope. Let a user change live mode only with a
structured acknowledgement or verifiable host readback.

**Running-session truth.** Claude applies `/permissions` changes starting with
the next tool call even in the same turn, and hot-reloads permission settings
([Claude live permission changes](https://code.claude.com/docs/en/permissions#manage-permissions)).
Codex `/permissions` changes the current session. Those are real live features
inside each host. Conch's attached key-injection path cannot reliably read the
prompt, distinguish persistence options, or verify the result, and some observed
Codex rows have no routable pid.

**Difficulty: blocked for safe attached approval/control.** Read-only configured
rules are real work but feasible. Exact effective state and safe decisions need
a session-owned Agent SDK/app-server request channel or richer official hook
payloads, not UI automation guesses.

## 14. Models, providers, effort, service/speed tiers and context

**What it is.** The active model endpoint and per-turn/session reasoning,
speed/service and context-window choices that determine capability, latency and
cost.

**Outside-session discovery.** Claude has aliases/full IDs, organization/model
allowlists, third-party providers and gateway mappings; `/model` changes the
current model immediately and `/effort` changes effort, with cache-cost
confirmation in a used conversation. Settings and environment establish startup
defaults, and a resumed session may restore its transcript model
([Claude model configuration](https://code.claude.com/docs/en/model-config)).

Codex supports model/provider catalogs, reasoning effort, verbosity,
personality, service tiers and custom model providers. `/model` changes the
interactive session; app-server `model/list` returns the actual catalog and
capabilities available to that host
([Codex models](https://learn.chatgpt.com/docs/models),
[Codex app-server models](https://learn.chatgpt.com/docs/app-server#list-models)).

**Conch today.** Context usage is derived from transcript token records. Claude's
model id is used internally only to infer a likely 200k/1M denominator; Codex
uses the transcript-reported model context window (`src/context-meter.ts:8-25`,
`src/context-meter.ts:34-58`). Neither active model id, effort, provider nor
service tier reaches `PublishedSessionRow` (`src/panel.ts:150-182`). Start UI
cannot select any of them.

**Good UI.** Show active model, provider/account, effort, speed/service tier,
context used/limit, compaction threshold, price/usage caveat and source of each
claim. The picker should be populated from the selected environment's live or
fresh-host catalog, not a hard-coded model list. New-session and per-turn
choices should be separate. Changing a deep session should warn about cache
rebuild/cost where the host does.

**Running-session truth.** Both hosts can switch models live through `/model`;
effort and some tier/personality choices can also change live. A `model` setting
edited on disk is a startup default, not proof of the current session. Transcript
messages can often confirm the model that produced a turn, which is strong
**observed** evidence but can lag a just-made selection.

**Difficulty: real work; live mutation is blocked for some attachments.**
Publishing observed model ids is comparatively cheap. Correct catalogs,
providers, resume behavior and verifiable switching require environment-aware
probes or host ownership.

## 15. Session controls, goals, schedules and cross-session messaging

**What it is.** Host-level actions and durable/session-scoped intent: rename,
fork, resume, compact, clear, rewind/revert, goals, scheduled work, remote
control, channels and messages between sessions.

**Outside-session discovery.** Claude has named/resumable sessions, checkpoints,
`/clear`, `/compact`, `/rewind`, goals, scheduled tasks, background workflows,
channels and cross-session messaging; availability depends on host/version/plan
([Claude sessions](https://code.claude.com/docs/en/sessions),
[checkpointing](https://code.claude.com/docs/en/checkpointing),
[scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks),
[goals](https://code.claude.com/docs/en/goal)). Codex has resume/fork/compact,
archive/pin/name/status and app-server thread/turn APIs. Much of the durable
thread metadata is discoverable from history/database; queued commands and
in-memory goals are not necessarily.

**Conch today.** It has a session ledger, resume picker, conversation, composer,
interrupt, clean terminal close, local rename/priority/dismiss, voice mode and
artifact handoff. Rename is only conch's label, not the provider session name
(`src/settings.ts:686-714`). Checkpoint/revert remains intentionally unbuilt
because blindly driving a destructive terminal menu has unsafe failure modes
(`docs/parity.md:102-105`). Conch's MCP contract can see and steer sibling
sessions at this limited level (`docs/conch-control-skill.md:40-85`).

**Good UI.** Show provider name vs conch alias, created/updated/runtime state,
queued turns, parent/fork, goal, next scheduled run, channel/remote-control
status and checkpoint availability. Let users resume, rename at the provider,
fork, compact and rewind only where capability and confirmation are known. A
cross-session send should identify sender, recipient, delivery policy and
whether the recipient accepted, held or refused it.

**Running-session truth.** Composer delivery and interrupt are already live via
terminal routing. Provider rename/model/compact commands may be injectable but
need structured confirmation. Checkpoint contents and rewind are host-owned;
Claude's checkpoint coverage excludes Bash/external changes and subagent edits,
so “undo turn” must never imply full workspace rollback
([Claude checkpoint limits](https://code.claude.com/docs/en/checkpointing#limitations)).
Schedules/goals loaded only inside the session cannot be inferred from base
files.

**Difficulty: real work; destructive controls are blocked without readback.**
The existing lifecycle path is a base, but each command has different queuing,
confirmation and persistence semantics.

## 16. Presentation surfaces: output styles, themes, status lines and keybindings

**What it is.** Host UI/system-prompt customization that changes how the agent
speaks or how its native client renders and is operated.

**Outside-session discovery.** Claude output styles may be user, project,
managed or plugin-provided and alter the main system prompt; themes,
status-line commands and keybindings are separate host UI surfaces. An output
style selected in settings takes effect after `/clear` or restart and does not
apply to subagents in the same way
([Claude output styles](https://code.claude.com/docs/en/output-styles),
[status line](https://code.claude.com/docs/en/statusline),
[keybindings](https://code.claude.com/docs/en/keybindings)). Codex config exposes
personality, TUI status-line fields, notifications and contextual keymaps; the
current `/statusline` UI persists choices in config
([Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[Codex status-line command](https://learn.chatgpt.com/docs/developer-commands?surface=cli#configure-footer-items-with-statusline)).

**Conch today.** Conch owns its own visual themes/voice settings but neither
discovers nor shows the agent host's output style, theme, status line or
keybindings. The published session schema has no presentation fields
(`src/panel.ts:150-182`).

**Good UI.** Put these in a lower-priority “host appearance and behavior” group,
not beside safety controls. Show available/selected style, source and prompt
impact; theme/status-line/keybinding sources and conflicts; and open the native
file/editor for advanced changes. A voice UI may care about output style because
it directly changes what conch will speak.

**Running-session truth.** Claude output-style changes are not live until
`/clear` or restart. Theme/statusline/keybinding behavior varies and is host UI,
not agent capability. Codex personality/model-visible behavior can change live
through host commands, while config edits are defaults unless confirmed.

**Difficulty: cheap to inventory, real work to resolve, low priority.** It is
useful context but does not unblock fleet control.

## 17. Workspaces, added directories, worktrees, artifacts and file state

**What it is.** The filesystem roots and isolated copies a session may access,
plus the concrete files/diffs/artifacts its work produces.

**Outside-session discovery.** Claude has cwd, `/cd`, `--add-dir`/`/add-dir`,
permission-granted additional directories, worktree isolation, checkpoints and
background worktrees. Added directories load skills/commands/agents as special
exceptions but not all `.claude` configuration
([Claude working directories](https://code.claude.com/docs/en/permissions#working-directories)).
Codex has cwd, writable roots, sandbox policy and app-server thread workspaces.
Git status and filesystem state are observable, but which roots the host
actually granted can differ from disk defaults.

**Conch today.** Rows carry cwd and transcript, conversations render file
changes/diffs, and `review_to_front` gives one artifact pane per session
(`src/panel.ts:150-182`, `docs/conch-control-skill.md:45-76`). New sessions can
choose one cwd only. There is no additional-root, worktree, checkpoint or
artifact-history model; `docs/vision.md:31-53` says the eventual unit should be
the artifact rather than the session.

**Good UI.** Show primary cwd, repo root, branch/worktree, additional readable
and writable roots, sandbox boundaries, changed files, checkpoint coverage and
artifact history. An artifact should link back to the turn, tool/subagent and
workspace that produced it. Launch UI should offer worktree/isolation and
additional roots with their security consequence.

**Running-session truth.** Cwd and added directories can change live inside
Claude; permission roots can change live; worktree/isolation is generally a
launch/spawn choice. Disk inspection sees files but not necessarily host grants.
Conch must not equate “path exists” with “session may access it.”

**Difficulty: real work.** Much of the filesystem data is available, but joining
it to permission state, child worktrees, checkpoints and the artifact-first feed
is a cross-cutting model change.

## 18. Connectors/apps, LSP servers, monitors and plugin executables

**What it is.** Remaining plugin/runtime components that are neither a skill nor
a plain MCP tool catalog but still change what a session can do or what runs in
the background.

**Outside-session discovery.** Claude.ai connectors appear as managed/cloud MCP
servers with organization tool policy; Claude plugins can also contain LSP
servers, session-long monitors, themes, workflows and `bin` commands. Monitors
stream notifications and may start always or on skill invocation; LSP servers
have crash/restart state
([Claude plugin components](https://code.claude.com/docs/en/plugins-reference),
[Claude connectors](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claudeai)).
Codex apps/connectors are enabled through plugins/config, have per-app/per-tool
approval policy and can return richer app context/UI. App-server exposes
`app/list` and app-backed MCP call metadata
([Codex plugins](https://learn.chatgpt.com/docs/plugins),
[Codex app-server](https://learn.chatgpt.com/docs/app-server#configuration-and-mcp-apis)).

**Conch today.** These components are invisible except when a connector call
looks like another MCP call. Plugin presence does not inspect components or
background processes. No LSP/monitor/app status reaches the panel.

**Good UI.** Nest components under their plugin. Show connector identity/auth
and organization policy, LSP language/status/restarts/log, monitor trigger and
running task, executable paths and requested permissions, plus observed events.
Never start a plugin executable simply to populate a detail view.

**Running-session truth.** Connector/MCP state is live. Claude plugin reload can
replace hooks/MCP/LSP but already-running monitors survive disable and require
session restart. Codex plugin components are available to new sessions; an
owned app-server can report app state. An attached session remains opaque.

**Difficulty: real work and mostly later.** These are important to account for
in the schema now so “plugin components” is not hard-coded to skills plus MCP,
but dedicated controls should follow the core inventory.

## What “toggle” can honestly mean

The UI should use explicit verbs rather than a universal switch:

- **Edit configuration**: changes a named file/scope and says which sessions may
  hot-reload it.
- **Enable for future sessions**: persists a plugin, Codex skill, profile or
  startup default and does not claim the selected session changed.
- **Reload this session**: shown only when conch has a structured connection to
  that host, or can invoke a documented command and verify the result.
- **Disable connection now**: appropriate for Claude `/mcp` or an owned host,
  with confirmation of disconnected state.
- **Hide from model / user-invocable-only**: skill visibility, not
  installation.
- **Allow/ask/deny**: a permission policy, not a plugin or tool enable bit.
- **Observed unavailable**: a runtime failure, not the same as disabled.

For conch's current attached mode, most mutation belongs behind a preview such
as “write project setting; existing Claude sessions normally hot-reload this”
or “disable for the next Codex session.” If conch later starts an owned provider
runtime, the same entity can gain a real live control without changing the
meaning of the read-only attached view.

## Ranked build order

1. **Build the evidence-labeled session environment inspector and shared entity
   model first.** Add provider instance/config home, host surface, version,
   model evidence and the four states—configured, available, loaded, observed—to
   daemon state before adding switches. This is the dependency for every honest
   feature below and fixes conch's current assumption that one `~/.claude` and
   one `~/.codex` describe every session.

2. **Ship a read-only MCP inspector.** MCP is the broadest and highest-risk
   surface: servers bring credentials, arbitrary local processes, remote data,
   dozens of tools and their own prompts/resources. Start with configured
   servers, source/scope, redacted transport, policy and observed calls; add a
   deliberate fresh-host health probe. For attached sessions, say “runtime
   unknown.” Conch already renders MCP calls and ships an MCP server, so this
   joins existing facts rather than inventing a new product area.

3. **Ship the plugin and skill library, including a proper conch-plugin doctor.**
   Use the supported Claude/Codex JSON CLIs plus filesystem metadata. Show scope,
   version, enabled/configured state, components, validation and skill
   descriptions; link observed invocations. Offer install/update/remove and
   **next-session** enable/disable first. Replace the current one-bit, one-time
   presence guess. This directly answers Tyler's request without promising live
   state conch cannot see.

4. **Expand conch's existing session launcher into named launch profiles.** Let
   a user choose environment/account, cwd/worktree, model/effort and permission
   mode, with optional plugin/MCP/skill profile. Because conch already starts
   terminal sessions, start-time controls are honest and useful immediately.
   Record the exact launch receipt so those sessions have stronger provenance
   than passively attached ones.

5. **Turn subagents, tasks, hook failures and approvals into attention objects.**
   The session ledger, conversation view, artifact pane and voice loop already
   exist. The next leverage is to surface “child blocked,” “team task ready,”
   “hook failed,” “MCP needs auth,” and the exact structured question as feed
   items. Begin read-only from transcripts/team files and preserve the existing
   rule that a child stopping is not the main turn stopping.

6. **Add an optional owned-runtime mode for authoritative live controls.** Use
   Codex app-server and Claude's Agent SDK for sessions deliberately launched
   through conch, while retaining passive attachment as a first-class mode. This
   is what unlocks truthful live model/permission changes, exact skills and MCP
   catalogs, structured approvals, child steering and runtime events. A new
   probe app-server must never be presented as controlling an unrelated TUI.

7. **Then add scoped settings/hook editors and advanced plugin components.** By
   this point conch will have the precedence/provenance model needed to edit
   safely. Add exact diff-and-scope confirmation, hook trust/health, output
   styles, apps/connectors, LSP and monitors. These are real surfaces, but they
   are poor first builds because a raw editor adds risk without improving the
   core attention loop.

The product direction is therefore not “clone an IDE settings screen.” It is:
make the invisible environment around each session legible, use that context to
rank what needs attention, and reserve live toggles for states conch can actually
confirm. That preserves the thing `docs/parity.md` got right and
`docs/vision.md` depends on: conch can remain the voice-and-artifact layer over
sessions the user started elsewhere, while sessions intentionally launched
through conch can grow a richer, authoritative control plane.

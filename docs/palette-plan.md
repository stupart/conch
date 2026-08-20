# Agent capability palette plan

Research updated 2026-08-19. This is the implementation plan for the read-first
half of “conch should know about skills and plugins, then toggle them.” The
broader surface inventory remains in `docs/surfaces.md`; this document turns
that survey into a palette and reader contract.

## The boundary for this pass

This pass only reads. It may parse provider configuration, manifests, skill
metadata, provider state and already-decoded conversation events. It must not:

- edit `~/.codex/config.toml`, `~/.claude.json` or scoped provider settings;
- run plugin install/enable/disable commands;
- start an MCP server, connect to one, or ask it for `tools/list`;
- launch a fresh agent and present that probe as evidence about an attached
  session; or
- open SQLite state in a mode that can write or take a writer lock.

The palette therefore reports four separate facts: **configured**,
**available**, **loaded**, and **observed**. A value also carries its evidence
basis. Unknown is a valid result, especially for an attached session.

## Verified Codex findings

The mid-flight findings were checked against the files on this machine and the
current official configuration reference before changing the plan.

| Claim | Verification on 2026-08-19 | Consequence |
| --- | --- | --- |
| `~/.codex/config.toml` is the MCP registry | Nine top-level `mcp_servers` tables are present. Five use `command`/`args` and four use `url`. | Codex MCP transport and configured state are cheap, deterministic reads. |
| A server has an `enabled` switch | One of the nine currently says `enabled = false`; the other eight omit the key. The earlier measurement of one explicit `true` no longer matches the live file. The official reference says `enabled` disables without removing the definition, so omission means the normal enabled default. | The reader reports omitted Codex server flags as enabled-for-next-session, not unknown. A future Codex row can offer a real next-session switch. |
| MCP tools have their own policy | Four tool tables currently carry `approval_mode = "approve"`: three under Linear and one under atlas-nura. The official schema also defines server allow/deny lists and per-tool approval modes. | Tool policy belongs on child rows. It must not be collapsed into the server switch. |
| Codex records project trust | The file has 34 `projects` tables; every observed table contains only `trust_level`, and the current repository plus its parent are marked `trusted`. | Trust is a cheap Codex context read and closes the untrusted-folder visibility gap for Codex sessions. Untrusted project config can be inventoried, but it must not be applied as effective config. |
| Plugins and skills live on disk | Both `~/.codex/plugins` and `~/.codex/skills` are directories. The current config names 16 plugins; the plugin directory contains marketplace caches. The skills directory currently has eight user skills and six `.system` skills with `SKILL.md`. This differs from the older six-name snapshot, so names must be scanned rather than hard-coded. | Filesystem discovery is a strong configured/discoverable signal. Cache presence alone is not installation state; join it to the config plugin table. |
| Threads record per-session configuration | The read-only `threads` schema in `~/.codex/state_5.sqlite` has `sandbox_policy`, `approval_mode`, `model`, `reasoning_effort`, `memory_mode`, `history_mode`, `agent_path` and `cli_version`, as well as source/provider/timestamps. The current thread row agrees with the running Codex environment for model, effort, approval, sandbox and CLI version. | For a Codex session id, show a **Codex-recorded thread configuration** receipt. This is stronger than a disk default, but it is not proof that every value remains live in process memory. |
| `.codex-global-state.json` is not the registry | The file is currently 203,617 bytes. A recursive key-name scan found only six MCP/plugin/skill matches, all UI/onboarding/reconciliation feature state rather than server, plugin or skill definitions. | Do not mine this file for the capability inventory. |

The supported keys are documented in the
[Codex configuration reference](https://developers.openai.com/codex/config-reference):
`mcp_servers.<id>.enabled`, `enabled_tools`, `disabled_tools`,
`mcp_servers.<id>.tools.<tool>.approval_mode`,
`projects.<path>.trust_level`, and `skills.config` are first-class settings.

## Revised difficulty ratings

The providers should not be forced into one lowest-common-denominator row.

| Surface | Codex | Claude | Honest palette behavior now |
| --- | --- | --- | --- |
| Configured MCP servers and transport | **Cheap** | **Real work** because project decisions and scopes must be joined | Show redacted definitions, source/scope and transport. |
| Server enabled state | **Cheap and authoritative for the next host** | **No equivalent universal boolean**; project approval/disable lists are different semantics | Codex: “enabled for next session.” Claude: show its project decision, never a matching switch that implies the same mechanism. |
| Per-tool policy | **Cheap when explicitly configured** | **Real work** across scoped permission rules | Show only named policy entries. Do not claim they are a complete `tools/list` catalog. |
| Project trust | **Cheap** from `projects.<path>.trust_level` | **Cheap** when `hasTrustDialogAccepted` exists in Claude state | Put trust in the session context and explain unknown/missing decisions. |
| Plugin inventory | **Cheap-to-moderate** from config plus cached manifest | **Moderate** from install ledger, scoped settings and manifest | Group by provider, marketplace and owner; retain separate provider actions. |
| Skill inventory/default enablement | **Cheap-to-moderate** from discovery roots plus `skills.config` | **Moderate** because visibility, legacy commands and live detection differ | Show scope, path, metadata, owner and configured default. Loaded/invoked remain separate. |
| Configuration a particular session ran with | **Cheap for recorded thread fields** | **Blocked for an arbitrary attached session** unless transcript/process evidence supplies it | Codex gets a provider-state receipt; Claude stays unknown rather than inheriting global defaults. |
| Exact loaded MCP/skill catalog | **Blocked for an unrelated attached TUI** | **Blocked for an unrelated attached host** | Use observed calls as positive history only. An owned host may add a verified live state later. |
| Enable/disable mutation | **Technically direct but future work**: edit the correct TOML layer and say “takes effect next session” | **Provider-specific real work**: plugin settings, skill visibility and MCP project choices are different actions | No writes in this pass. Future controls need diff preview, scope, atomic write, rollback and post-write readback. |

The largest rating change is on the Codex side: configured MCP enablement,
explicit tool policy, trust, plugin/skill locations and the per-thread receipt
are not guesses. The remaining hard problem is **loaded now**, not
**configured for a new session**.

## Reader and wire contract

The daemon accepts an `agent-capabilities` request with provider, absolute cwd
and optional session id. The read returns:

- context: provider/cwd/session plus project trust and, for a matching Codex
  thread, its provider-recorded configuration;
- plugin entities joined to manifests and component counts;
- skill entities from provider discovery roots with scope, invocation metadata,
  owner and configured next-session state;
- MCP server entities with redacted transport, credential *sources*, enable
  default, project decision and operational settings;
- MCP tool child entities only when configuration, manifest hints or observed
  calls name them; and
- diagnostics plus a `complete` bit, so a torn or incompatible read never looks
  like an authoritative empty inventory.

Secrets do not cross the daemon wire. URLs are reduced to their origin; command
arguments, environment values, headers and tokens are omitted. SQLite is opened
through the same read-only path used by the Codex ledger. A redirected conch
configuration directory suppresses accidental reads of the real provider home.

Stable palette identity is the provider, entity kind, logical name and scope or
owner—not a session row, plugin cache version or transcript event. That lets the
same subject accumulate configured and observed evidence without jumping in the
feed after an upgrade.

### One shape, four states, one rankable subject

The implemented TypeScript contract is deliberately shared across providers:

```ts
interface AgentCapabilitiesRead {
  schemaVersion: 1;
  context: {
    backend: "claude" | "codex";
    cwd: string;
    sessionId?: string;
    projectTrust?: AgentProjectTrust;
    threadConfiguration?: AgentThreadConfiguration;
  };
  entities: AgentCapabilityEntity[];
  diagnostics: AgentCapabilityDiagnostic[];
  complete: boolean;
  readAt: number;
}

interface AgentCapabilityBase {
  id: string;
  subject: { id: string; type: "agent-capability"; title: string };
  backend: "claude" | "codex";
  kind: "plugin" | "skill" | "mcp-server" | "mcp-tool";
  name: string;
  displayName: string;
  parentId?: string;
  scope: "user" | "project" | "local" | "plugin" | "system"
    | "admin" | "managed" | "unknown";
  sources: AgentCapabilitySource[];
  evidence: {
    configured: AgentCapabilityEvidence;
    available: AgentCapabilityEvidence;
    loaded: AgentCapabilityEvidence;
    observed: AgentCapabilityEvidence;
  };
  diagnostics: AgentCapabilityDiagnostic[];
}
```

Each evidence value is `{ state: "yes" | "no" | "unknown", basis, detail,
at? }`. The bases are `config`, `filesystem`, `provider-state`, `provider-cli`,
`runtime`, `transcript`, and `none`.

- **Configured** means a definition, installation record or policy exists in a
  named candidate source. An observed-only entity has configured `unknown`.
- **Available** means discovery plus policy could make the entity usable. A
  disabled setting, rejected/trust-blocked project definition, invalid skill,
  exclusive managed MCP set, or managed requirement can prove `no`. Disk
  presence alone does not prove `yes`.
- **Loaded** is in-memory state for the selected session. The passive reader
  always returns `unknown` here.
- **Observed** is timestamped positive history from provider usage state or an
  MCP call conch already decoded. No matching event remains `unknown`, never
  `no`.

Every entity is already a feed subject. `subject.id` equals its stable entity
ID, child rows point at parent IDs, and diagnostics carry `subjectId`. The feed
can therefore rank “plugin package missing,” “skill metadata invalid,” “MCP
blocked by policy,” or a later “MCP needs auth” observation without introducing
a settings-only object that has to be remodeled later. `complete` means all
attempted candidate sources were readable and within bounds; it does not mean
the attached process's effective environment is completely known.

## Exact readers

The synchronous reader is one bounded pass selected by `{ backend, cwd,
sessionId? }`:

| Reader | Exact inputs | What it produces |
| --- | --- | --- |
| Claude state | `~/.claude.json`: top-level `mcpServers`, `pluginUsage`, `skillUsage`, and exact `projects[resolve(cwd)]` | User/local MCP definitions, positive historic plugin/skill use, trust, the four MCP project lists, and MCP-shaped `allowedTools`. |
| Claude settings/policy | `~/.claude/settings.json`, repository `.claude/settings.json`, `.claude/settings.local.json`, OS `managed-settings.json`, sorted `managed-settings.d/*.json` | Scoped plugin state, non-plugin skill visibility, MCP permission names, and file-based managed overrides. |
| Claude plugins | `~/.claude/plugins/installed_plugins.json`, only its selected install paths, compatible plugin manifest, skill root, and wrapped or legacy direct-map `.mcp.json` | Installed/scoped plugins and owned components. Orphaned cache versions do not become installed rows. |
| Claude skills | `~/.claude/skills`, managed-directory `.claude/skills`, and project `.claude/skills` from repository root through cwd | Bounded frontmatter: name/description, invocation, allowed tools, argument hint, model, bytes, owner and scope. |
| Claude MCP | State definitions, project `.mcp.json` roots, plugin MCP, and OS `managed-mcp.json` | Redacted definitions, source/scope, project decision/trust, managed exclusive-control evidence and only config/manifest-named tools. It never connects. |
| Codex config/policy | `$CODEX_HOME/config.toml`, trusted project `.codex/config.toml` roots, `/etc/codex/managed_config.toml`, `/etc/codex/requirements.toml` | Effective plugin/MCP/skill defaults, trust, managed plugin disable and exact/prefix MCP identity constraints. Administrator regex is deliberately not executed on the render path; that policy result remains unknown. |
| Codex plugins | Effective plugin tables, configured marketplace source paths, selected compatible manifests, skills and `.mcp.json` | Installed/configured plugin rows and owned components. Cache presence without a configured plugin is ignored. |
| Codex skills | Project `.agents/skills` roots, `$HOME/.agents/skills`, `$CODEX_HOME/skills`, `$CODEX_HOME/skills/.system`, `/etc/codex/skills` | The same frontmatter plus `[[skills.config]]` next-session state. Untrusted project config does not change the effective skill map. |
| Codex thread receipt | `$CODEX_HOME/state_5.sqlite`, only when `sessionId` is supplied | One row's known non-secret configuration fields. The database uses the existing read-only SQLite helper; missing old-schema columns are tolerated. |
| Observation join | The selected session's already-bounded published conversation | Positive MCP server/tool history. Unknown observed entities are retained instead of discarded or guessed into config. |

JSON/TOML files are capped at 8 MiB, each `SKILL.md` header at 128 KiB, and
the result at 2,000 entities. Skill discovery lists one known root level and
does not crawl resources or execute inline commands. Malformed/unreadable
sources add a diagnostic and set `complete: false`. `CONCH_CONFIG_DIR`
suppresses accidental real-home reads unless explicit provider homes are
passed, matching `resumable.ts`.

Two slower readers must remain separate:

1. A palette-open/background provider catalog refresh using `claude plugin
   list --json`, `claude plugin marketplace list --json`, and `codex plugin
   list --available --json`. Its cached rows can add `provider-cli` evidence;
   it must not block rendering.
2. An owned/fresh host protocol for exact slash commands, loaded skills, MCP
   connection/auth/health, dynamic tools/resources/prompts, and confirmed live
   mutation. A fresh probe describes that probe, never an unrelated TUI.

File-based managed policy is included now. Claude server-managed settings,
MDM preferences, policy-helper output, Codex signed cloud requirements/MDM,
profiles, CLI overrides, alternate homes and embedder settings still require
the selected host's effective-config API. Passive results must continue to say
“candidate configuration.”

## Measured cost

Measured on Tyler's current Mac on 2026-08-19 with Bun 1.3.3 and cwd
`/Users/tylerstupart/conch`. Disk numbers are 100 iterations after a first call
and include parsing, manifest/frontmatter joins, policy evaluation and sorting;
serialization is separate. They are filesystem-cache-warm measurements, not a
cold-boot promise.

| Operation | Current rows | First observed | Median | p95 | Encode median | Wire bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude passive reader | 205: 11 plugins, 168 skills, 8 servers, 18 tools | 38.198 ms | 8.162 ms | 9.024 ms | 0.631 ms | 430,146 |
| Codex passive reader | 107: 16 plugins, 74 skills, 13 servers, 4 tools | 27.012 ms | 3.457 ms | 4.225 ms | 0.297 ms | 186,764 |
| Codex reader with matching thread receipt | same inventory plus context receipt | — | 3.802 ms | 4.627 ms | — | — |

The supported CLI probes were each measured five times:

| Command | Result | Samples in ms | Median |
| --- | ---: | --- | ---: |
| `claude plugin list --json` | 11 installed | 346.72, 277.56, 279.91, 279.49, 278.37 | 279.49 ms |
| `claude plugin marketplace list --json` | 6 marketplaces | 250.53, 252.68, 253.68, 255.09, 280.26 | 253.68 ms |
| `codex plugin list --json` | 16 installed | 101.14, 57.44, 58.47, 57.01, 56.80 | 57.44 ms |
| `codex plugin list --available --json` | 16 installed, 177 available | 57.64, 57.00, 58.86, 58.38, 56.01 | 57.64 ms |

The passive p95 fits a 16.7 ms frame budget on this machine, but the 183–421
KiB response should still be requested on palette open/source change, not sent
with every dashboard frame. The provider CLIs clearly require a cached
background refresh.

## Verified Claude project state

`~/.claude.json` was inspected read-only on 2026-08-19. It was 116,141 bytes
and had 32 exact-path project records.

| Key | Records containing key | Non-empty / value count |
| --- | ---: | ---: |
| `enabledMcpServers` | 3 | 3 non-empty |
| `disabledMcpServers` | 4 | 4 non-empty |
| `enabledMcpjsonServers` | 32 | 0 non-empty |
| `disabledMcpjsonServers` | 32 | 0 non-empty |
| `hasTrustDialogAccepted` | 32 | 12 true, 20 false |
| `allowedTools` | 32 | 0 non-empty |
| project-local `mcpServers` | 32 | 2 non-empty records |

The records are exact-path, not inherited. `/Users/tylerstupart` currently has
trust accepted, two enabled MCP names and two disabled names, while the child
`/Users/tylerstupart/conch` has trust false and empty project-MCP/permission
arrays. A session can nevertheless exist in the child. The flag is persisted
project UI state; it is not proof that an attached process is currently at or
past a trust prompt.

The public Claude docs define `enabledMcpjsonServers` and
`disabledMcpjsonServers` as approval/rejection lists for names in project
`.mcp.json`. The sparse non-JSON pair contains global/plugin/connector names on
this machine, so it is useful persisted per-project selection evidence, but its
full lifecycle is not documented and it is not connection evidence.
`allowedTools` exists in every record but all local examples are empty. Conch
can recognize a future MCP-shaped entry as a persisted allow record; this
sample cannot establish its expiry, merge or removal behavior.

This state honestly identifies persisted exact-path trust, project-MCP
approval/rejection, sparse selection for other MCP sources, local definitions
and stored MCP-shaped allows. It does not identify current connection/auth,
loaded state, a complete/current tool catalog, or session/CLI/embedder/managed
overrides.

## Palette surfaces and actions

The first UI is an inspector over subjects, with context header, provider-
separated groups, owned child rows, evidence chips and inline diagnostics. It
must derive controls from provider semantics rather than render one universal
switch. This pass intentionally exposes no mutation.

### `/plugins`

Show canonical ID, provider, marketplace, scope, version/package, next-session
configuration, components, diagnostics and the four evidence lanes.

- **Inspect source**, **open package**, and **copy recovery command** are honest
  passive actions.
- **Open provider `/plugins`** may deliver the command once to a routable idle
  terminal and reveal it. Conch acknowledges delivery, not the picker result.
- Future **install**, **update**, **remove**, **enable for the next session**
  and **disable for the next session** must call the supported CLI at an
  explicit scope, show output, and refresh the provider inventory.
- Claude may then offer **send `/reload-plugins` and open terminal**, but conch
  cannot certify reload or that an old monitor stopped. Codex changes remain
  next-session for an unrelated TUI.

### `/skills`

Show name/description, provider, scope/path, plugin owner, validation,
visibility, user/model invocation, allowed tools, model, bytes, use history and
evidence.

- **Fill composer with invocation** is safe; let the user add arguments.
- **Send invocation** only means text reached a routable idle terminal, not
  that the skill loaded.
- **Open `SKILL.md`** is passive. Never execute scripts to preview a skill.
- Future **hide from model**, **user-invocable only**, or **enable for the next
  session** must name provider/scope. Plugin skills are controlled through the
  plugin.
- Live filesystem watching does not prove this attached conversation adopted
  a change, and already-invoked content stays in context. Loaded remains
  unknown.

### `/mcp`

Show source/scope/owner, redacted transport, trust/project decision,
next-session enable state, required/timeouts, credential-source names,
config/manifest-named tool policy, observations and evidence.

- **Open source** and **copy redacted recovery command** are passive.
- **Open the agent's `/mcp`** may deliver the command and focus the terminal.
- **Disable connection now** exists only inside Claude's interactive `/mcp` or
  an owned runtime that confirms disconnection. Conch cannot honestly expose
  that verb as its own attached-session button.
- Future **enable/disable for the next session**, **add**, **edit**, and
  **remove** change a named scope and state the restart/reload boundary.
- A runtime failure may become **observed unavailable** with time/error. That
  is not the same as configured off.

MCP tools appear only from explicit config policy, a manifest display hint, a
positive call, or a future authoritative catalog. A manifest hint is not
`tools/list`. Future **allow/ask/deny** and enabled/disabled-tool edits are
scoped next-session policy; conch cannot toggle a live tool in an arbitrary
attached host.

## Slash-command palette behavior

One visual palette should group five execution contracts:

1. **Conch commands** such as `/plugins`, `/skills`, `/mcp` and session actions:
   conch intercepts these and gets structured daemon results/acks.
2. **Provider host commands**: static documented entries are hints unless the
   selected host reports its catalog. Exact non-interactive commands can be
   typed; delivery is the acknowledgement.
3. **Skills/workflows**: inventory-backed entries fill the canonical provider
   invocation rather than silently submit it.
4. **MCP prompts**: show only from a connected-host catalog or positive
   observation. Config files do not enumerate dynamic prompts.
5. **Session actions**: existing conch controls with structured acks.

When a command opens an interactive picker (`/plugins`, `/skills`, `/mcp`,
permissions, model selection and similar), conch must not send blind
arrow/enter sequences. It verifies the terminal is routable/idle, delivers the
command once, reveals/focuses the terminal, and says “continue in the agent
terminal.” It cannot read the selection, prove the picker opened, answer its
confirmation, or certify the resulting state. Without a routable terminal, the
honest actions are **copy command** and **open terminal**.

## Conch cannot honestly know this while attached

- The alternate config home, profile, launch flags, `--settings`,
  `--mcp-config`, `--plugin-dir`, added directories, environment/account, or
  embedder settings used by an arbitrary existing process.
- Server/MDM/cloud-managed policy or policy-helper output actually loaded by
  that process; file-based managed policy is only one candidate layer.
- Whether a configured plugin/skill was in startup discovery, whether a
  skill's full instructions are in current context, or whether reload finished.
- Current MCP connection, authentication, health, instructions, resources,
  prompts, or complete/dynamic tool catalog.
- Whether an external disk edit or persisted MCP project choice was adopted by
  the attached process.
- The exact provider slash-command catalog for this version/host, or the
  state/result of an interactive terminal picker after handoff.

These are findings, not missing booleans. Only an acknowledging protocol for a
session conch owns, or a timestamped observation kept distinct from current
state, can change them.

## Verification gate for this pass

- Synthetic fixtures cover explicit and omitted Codex MCP enablement, per-tool
  approval modes, trusted and untrusted project config, plugin/skill joins,
  redaction, file-based Claude/Codex managed policy, stable upgrade identity,
  observed-only MCP calls and a read-only thread receipt.
- The control-message validator rejects malformed inventory responses.
- A live read must return the current project trust and thread values while a
  before/after checksum confirms that provider config and state files did not
  change. The five-file config/state checksum check passed on 2026-08-19.
- The full Bun test suite and TypeScript check must pass.

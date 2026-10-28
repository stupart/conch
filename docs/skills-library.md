# Skills and Benchmarks

Built 2026-10-28. Tyler: *"is there a nice screen or view in conch with all my skills and if not can u find and scrape
all my skills from all my accounts and put them there as well as find other skill index's or databases like vercel has
for example and show them there as things i can add and test and then lets also make a new tab for benchmarks"*.

Two sections of the Settings page, beside Plugins & MCP: **Skills** (Installed and Discover) and **Benchmarks**. The
header's ✦ opens Skills; so do ⌘K's "Skills…" and "Benchmarks…". Each is a list with a reader beside it the height of the
page, the deliverables pane's own: a skill is its folder, as a folder deliverable shows (`WorkspaceFilesView`), with
SKILL.md open; a benchmark is its page in the pane's web view. Narrower than 760 points (the conch panel's 860-point window
leaves 639) the list and the reader take turns. This is the first cut of roadmap C3: skills only, not plugins, MCP servers
or the rest of the marketplace idea.

## Installed (`src/skills-library.ts`)

The capability inspector's read (`accountCapabilities`) once per account conch knows — Claude's default folder and each
profile in `claude-accounts.json`, Codex's and each in `codex-accounts.json`, none named in code — plus what it never
looked at:

- **claude.ai's skills.** Claude Code copies the signed-in claude.ai account's skills into
  `<config>/skills/synced/<organizationUuid>_<accountUuid>/`, with a `manifest.json` naming where each came from
  (`anthropic`, `anthropic-example`). Only the bucket of the sign-in the profile holds now (`oauthAccount` in its
  `.claude.json`) is loaded, as `anthropic-skills:<name>`; the others are left behind by sign-ins since swapped out, and
  are not listed. On 2026-10-28 both of Tyler's profiles held three buckets each.
- **Commands** (`commands/*.md`: the user's, each plugin's, each project's), listed as commands.
- **`~/.agents/skills`**, which every Codex profile reads.
- **Projects**: each folder in `working-folders.json` (and its repository's top), and folders up to three levels under
  them with skills of their own, which Claude Code loads when it works on files beneath them (dependencies, builds and
  worktrees are skipped). A `.claude/skills` there is every Claude account's, an `.agents/skills` every Codex account's.

One skill in several places is one entry with a location each, keyed by its origin's family, plugin and name
(`skillKey`): a plugin's skill across accounts and agents, a skill copied into both agents, claude.ai's skills in each
profile. Codex's own skill-creator and claude.ai's stay two. Each location carries a digest, so an entry says when its
copies differ. On 2026-10-28: 99 skills in 159 places — Claude · Default 60, Claude · Blueprint 37, Codex · Default 24,
and 24 in one project's subfolder (`conch-design/brand`).

## Discover (`src/skill-indexes.ts`)

Checked by hand on 2026-10-28, each read without a key, cached under `~/.cache/conch/skill-indexes/`, re-read once a day
in the background (or on Refresh):

| Index | Maintainer | Read | Skills |
|---|---|---|---|
| anthropics/skills | Anthropic | codeload tarball, ETag | 15 (19 less the 4 proprietary) |
| openai/skills, `.curated` | OpenAI | codeload tarball, ETag | 39 |
| openai/plugins | OpenAI | codeload tarball (26 MB), ETag | 506 |
| Claude plugin directory | Anthropic | `api.anthropic.com/api/directory/plugins`, 1,000 a page | 17,784 in 3,600 plugins |
| skills.sh | Vercel | `/api/search` as you type, `/api/download` on open | search only |

- The **directory** is what Claude Code's `/plugin` and claude.com/plugins browse. It names each plugin's repository at
  the commit Anthropic reviewed, not the skill's folder, so opening a skill downloads that commit and finds the SKILL.md
  whose name matches. Each entry says who reviewed its plugin: Anthropic, a partner, or nobody (community).
- **Proprietary skills are never copied or kept.** Anthropic's docx, pdf, pptx and xlsx reserve every right (their
  licence keeps them inside Anthropic's own services, where Tyler has them through claude.ai), so a skill whose LICENSE
  reserves all rights is left out of a listing, and refused when skills.sh offers it.
- **openai/skills is deprecated** in favour of openai/plugins; it stays because Codex's own `skill-installer` reads it.
  Its `.system` skills ship with Codex and are left out.
- A skill whose SKILL.md reaches into its plugin's folder (`${CLAUDE_PLUGIN_ROOT}`) is marked: it can't be added or tried
  alone, and says to install its plugin in Plugins & MCP.

Rejected:

- **skills.sh's documented API** (`/api/v1/*`) needs a Vercel OIDC token; its open endpoints give no descriptions and no
  full list (and its robots.txt disallows `/api/`), so it is a search, asked only when Tyler types one.
- **SkillsMP** (skillsmp.com): 50 requests a day, behind a Cloudflare challenge.
- **skillmd.com**: a stale mirror (Anthropic's docx last synced in July), and it installs SKILL.md alone.
- **ClawHub**: OpenClaw's upload registry, not GitHub, with re-uploads of proprietary skills.
- **claude-plugins.dev**: real and searchable, but third party and partly stale; the directory covers the same ground
  first-hand.
- **skills.cat, skillsdirectory.com, tessl.io**: copies of other indexes. **agentskills.io** is the spec, not an index.
  The awesome lists are Markdown only.

## Add and Try (`src/skill-install.ts`)

**Add** is the write pass's shape (B3, `config-write.ts`): pick the account, see every file and its size and where it
lands (`<CLAUDE_CONFIG_DIR>/skills/<name>` or `<CODEX_HOME>/skills/<name>`), then Add, which carries the preview's hash
and is refused if the files changed. Nothing is replaced (a skill already there is a refusal), links are never copied,
and the copy lands beside the destination and is renamed into place, then read back. It reaches the next session.

**Try** starts a new session that uses the skill. A skill from an index is copied into a new folder under
`~/.cache/conch/skill-trials/` as that folder's own skill (`.claude/skills` or `.agents/skills`), so it is tried without
being added anywhere; an installed one runs where a copy is (a project's in its project, any other in a new trial folder).
The daemon makes the folder and the first message (`/name …`, `/plugin:name …`, `$name …`); the app starts the session
through the ordinary `session-start`, which now takes a `prompt`: the agent's own positional first message, refused for a
resume, never a flag, one line. Trial folders are kept 14 days.

## Benchmarks (`src/benchmarks.ts`)

`assets/benchmarks.json`, compiled into the daemon: 106 indexes researched on 2026-10-28 (aggregators, leaderboards,
benchmarks, suites), each with what it measures, its domains, its maintainer, how fresh it is and a one-line take. Shape
checked whole (`isBenchmarkCatalog`); sent a page at a time. Its report, the index map and eval guide, lives in Atlas, which
has no web view of a page, so it opens from the Markdown copy `atlas_show` keeps in `~/Documents/conch-notes/atlas/`.

## The wire

`{ kind: "skills-library", action: "installed" | "discover" | "open" | "add-preview" | "add" | "trial", … }` and
`{ kind: "benchmarks", offset? }`. Lists come in pages that fit one control frame (64 KiB, the phone bridge's), with
`next`. `conch skills` and `conch skills discover <words>` print the same.

## Checking it

- `bun scripts/skills-library-e2e.ts [--start]`: this checkout's daemon in a sandbox with made-up accounts, against the
  real indexes: the inventory, Discover, Add (and a stale plan refused), Try (with `--start`, a background session of a
  fake `claude`, its first message checked).
- `bun scripts/shoot-skills-library.ts [out] --cache <index cache>`: the Mac app's own views, compiled from its sources,
  against a sandboxed daemon reading copies of this Mac's skills, drawn to PNGs light and dark, at the panel's width, and
  the Add and Try sheets.

# codex-cc-skill

A **Codex code-review skill** for [Claude Code](https://docs.claude.com/en/docs/claude-code) (and any agent that can run shell commands), plus an optional **git pre-commit review gate** — installable as a **Claude Code plugin** or as a plain vendored skill. Everything drives the [`codex`](https://github.com/openai/codex) CLI directly — **no companion runtime, just the `codex` binary** (plus git and a POSIX shell).

## What's in here

| Path | What it is |
|:---|:---|
| `skills/codex-review/SKILL.md` | A model-invocable skill: run an independent Codex review of your git changes with `codex exec review`, present the findings, never auto-fix. |
| `hooks/pre-commit` | A tiny **git** hook that hard-blocks a commit until Codex approves the staged diff (`ALLOW:` / `BLOCK:`). Fires for every `git commit` — from Claude Code, the terminal, another agent, an IDE, or CI. |
| `.claude-plugin/` | Claude Code plugin manifest (`codex-review`) and a one-plugin marketplace (`codex-cc-skill`). |
| `commands/init.md` | Plugin command `/codex-review:init`: installs or upgrades the git gate in the current repository, approval-gated. |
| `hooks/hooks.json`, `scripts/gate.sh` | Plugin session-start check: when the current repository doesn't have the gate active, Claude offers `/codex-review:init`. |
| `AGENT-INSTALL.md` | Deterministic, copy-paste install steps written for an AI agent to execute (skill + the git gate), without the plugin. |

## Why a git hook (and not a pre-command agent hook)

`codex exec review` (built into the Codex CLI) already performs a full, repo-aware code review. This project packages that as (a) a Claude Code skill the agent can invoke on its own initiative, and (b) an optional enforcement gate — with **zero extra runtime**: no wrapper script around codex, no path resolver.

The gate is a **git `pre-commit` hook** rather than an agent-side "before the tool runs" hook on purpose. A pre-command hook only sees the *shell command string* and has to guess — with regex — whether it will run `git commit` and exactly what it will commit; that is a losing battle against ordinary shell (newlines, wrappers like `timeout`/`sudo`, here-docs, command substitution, quoting). The git hook runs at **commit time against the real staged index** (`git diff --cached`), so it reviews exactly what is about to be committed, no command-parsing required, and it cannot be dodged by how the commit is spelled. It fires no matter who runs `git commit`. (The plugin's only Claude Code hook is the read-only session-start check below; it never gates commands.)

## Prerequisites

```bash
npm install -g @openai/codex
codex login   # skip if codex uses an API key or a custom model_provider in ~/.codex/config.toml
```

## Install as a Claude Code plugin (recommended)

```text
/plugin marketplace add Ruisi-Lu/codex-cc-skill
/plugin install codex-review@codex-cc-skill
```

Or from your shell: `claude plugin marketplace add Ruisi-Lu/codex-cc-skill && claude plugin install codex-review@codex-cc-skill`.

The plugin provides:

- **`/codex-review:codex-review`** — the review skill (Claude also invokes it on its own when a review is due).
- **`/codex-review:init`** — installs the git gate into the current repository: `.githooks/pre-commit` + `core.hooksPath=.githooks`. It checks first, shows the plan, and **writes nothing until you approve**. Re-running upgrades in place.
- **A session-start check** — when a session starts in a git repository where the gate isn't active (never installed, a different version, or a fresh clone that hasn't set `core.hooksPath` yet), Claude mentions it once and offers `/codex-review:init`. It is read-only and never installs anything by itself.

`init` **fails closed** on anything it doesn't own. It refuses — and writes nothing — when `core.hooksPath` already points somewhere else (husky, lefthook, a global hooks dir), when `.githooks/pre-commit` exists and isn't this gate, or when hooks in `.git/hooks` would silently stop running once `core.hooksPath` is set. Those cases need your decision; it explains them instead of working around them.

Not interested in the gate for a repository? Hide the notice:

```bash
git config codex-review.skipInit true            # this repository
git config --global codex-review.skipInit true   # every repository
```

If you previously vendored the skill into `.claude/skills/codex-review/`, remove that copy after installing the plugin so the skill isn't loaded twice.

## Installing with an AI coding agent (no plugin)

Paste this prompt into Claude Code (or any agent that can fetch a URL) — it reads the runbook, shows you a plan, and writes nothing until you approve:

```text
Read https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/AGENT-INSTALL.md
and follow it to install the Codex review gate into this repository.
```

Idempotent — re-running the prompt upgrades in place. Prefer to do it by hand? The same steps are written for humans in [`AGENT-INSTALL.md`](AGENT-INSTALL.md).

> **Trust & security.** The prompt has your agent fetch scripts from this repo and merge them into your repo — treat it like any `curl | sh`: trust flows from the repo, not the paste. The approval gate lets you review the plan before anything is written; for a stronger guarantee, skim the bytes that get installed ([`hooks/pre-commit`](hooks/pre-commit), [the skill](skills/codex-review/SKILL.md)) and **pin `main` to a commit SHA or tag** in the prompt — or clone the repo and point the prompt at your local copy. The same applies to the plugin: it installs this repo's code, and `init` copies its bundled `hooks/pre-commit` verbatim.

## Install the skill only (no plugin)

From your project root:

```bash
npx skills add Ruisi-Lu/codex-cc-skill -a claude-code --copy
```

This vendors `skills/codex-review/SKILL.md` into `.claude/skills/codex-review/` and records it in `skills-lock.json` so updates can be tracked. (Or just copy that folder into `.claude/skills/` yourself.)

## Enforce a review at every commit (optional, by hand)

With the plugin, `/codex-review:init` does this for you. Otherwise, install the git hook yourself. It runs the `ALLOW:` / `BLOCK:` review, is **fail-closed** (a missing or erroring `codex` blocks the commit — never waved through), and **skips** empty / message-only and merge/cherry-pick/revert commits.

```bash
mkdir -p .githooks
cp hooks/pre-commit .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks   # once per clone
```

Setting `core.hooksPath` makes git stop running hooks in `.git/hooks` — move any you rely on into `.githooks/` first.

Now every `git commit` — including the ones Claude Code runs — reviews the staged diff first and is blocked, with the findings on stderr, unless Codex returns `ALLOW:`. Claude Code sees the block in the command output and can fix and re-commit in the same conversation. Keep a slow review under `CODEX_GATE_TIMEOUT` (default 840s).

### Bypass & defense-in-depth

- **Bypass** (human, emergencies): `git commit --no-verify` (git's built-in hook skip) or `CODEX_GATE_BYPASS=1 git commit …`. These are visible in the command — use them deliberately, not to skip fixes.
- **A local hook is honor-limited.** It reviews *content* robustly, but anyone (including an agent) with shell access can `--no-verify`, edit the hook, or unset `core.hooksPath`. For a hard, un-bypassable guarantee, enforce **server-side**: branch protection with a required status check, or a `pre-receive` hook — something the committer cannot reach. Treat this hook as an early, in-loop reviewer, and the server as the gate of record.

## Development

Tests exercise `scripts/gate.sh` against throwaway repositories with a stubbed `codex` (no real codex call). The toolchain is pinned in `.prototools`:

```bash
proto use
bun test
claude plugin validate .
```

Plugin users stay on the `version` in `.claude-plugin/plugin.json` until it changes, so bump it with every release.

## Credits / Derived from

The review-gate mechanism — the `ALLOW:` / `BLOCK:` stop-gate verdict contract — is derived from OpenAI's **Codex Claude Code plugin**: <https://github.com/openai/codex-plugin-cc> (Apache-2.0, © OpenAI). This project reimplements that idea against the plain `codex` CLI so it needs nothing beyond the `codex` binary, and follows the same safety discipline as upstream — repository-derived values such as branch names and diffs are never passed through a shell (see upstream #447 / **v1.0.6**, which this project is tracked against).

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

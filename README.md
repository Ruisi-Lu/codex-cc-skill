# codex-cc-skill

A **Codex code-review skill** for [Claude Code](https://docs.claude.com/en/docs/claude-code) (and any agent that can run shell commands), plus an optional **git pre-commit review gate** — installable as a **Claude Code plugin** or as a plain vendored skill. Everything drives the [`codex`](https://github.com/openai/codex) CLI directly — **no companion runtime, just the `codex` binary** (plus git and a POSIX shell).

## What's in here

| Path | What it is |
|:---|:---|
| `skills/codex-review/SKILL.md` | A model-invocable skill: run an independent Codex review of your git changes with `codex exec review`, present the findings, never auto-fix. |
| `hooks/pre-commit` | A tiny **git** hook that hard-blocks a commit until Codex approves the staged diff (`ALLOW:` / `BLOCK:`). Fires for every `git commit` — from Claude Code, the terminal, another agent, an IDE, or CI. |
| `.claude-plugin/` | Claude Code plugin manifest (`codex-review`) and a one-plugin marketplace (`codex-cc-skill`). |
| `commands/init.md` | Plugin command `/codex-review:init`: installs or upgrades the git gate in the current repository, approval-gated. |
| `hooks/hooks.json`, `scripts/gate.sh` | Plugin hooks: at session start, activate a gate the repository ships or offer `/codex-review:init`; before Bash, deny Claude's `git commit` while a shipped gate is inactive. |
| `AGENT-INSTALL.md` | Deterministic, copy-paste install steps written for an AI agent to execute (skill + the git gate), without the plugin. |

## Why a git hook (and not a pre-command agent hook)

`codex exec review` (built into the Codex CLI) already performs a full, repo-aware code review. This project packages that as (a) a Claude Code skill the agent can invoke on its own initiative, and (b) an optional enforcement gate — with **zero extra runtime**: no wrapper script around codex, no path resolver.

The gate is a **git `pre-commit` hook** rather than an agent-side "before the tool runs" hook on purpose. A pre-command hook only sees the *shell command string* and has to guess — with regex — whether it will run `git commit` and exactly what it will commit; that is a losing battle against ordinary shell (newlines, wrappers like `timeout`/`sudo`, here-docs, command substitution, quoting). The git hook runs at **commit time against the real staged index** (`git diff --cached`), so it reviews exactly what is about to be committed, no command-parsing required, and it cannot be dodged by how the commit is spelled. It fires no matter who runs `git commit`. (The plugin's Claude Code hooks only help the git hook reach every clone — see [Team enforcement](#team-enforcement); none of them reviews anything.)

## Prerequisites

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh   # or: npm install -g @openai/codex  /  brew install --cask codex
codex login   # skip if codex uses an API key or a custom model_provider in ~/.codex/config.toml
```

Verified against codex-cli **0.160.0**; the commit gate needs **0.119.0 or newer**. Note that `codex exec review` accepts either a scope flag (`--base`, `--uncommitted`, `--commit`) or a custom-instructions prompt, never both.

## Install as a Claude Code plugin (recommended)

```text
/plugin marketplace add Ruisi-Lu/codex-cc-skill
/plugin install codex-review@codex-cc-skill
```

Or from your shell: `claude plugin marketplace add Ruisi-Lu/codex-cc-skill && claude plugin install codex-review@codex-cc-skill`.

The plugin provides:

- **`/codex-review:codex-review`** — the review skill (Claude also invokes it on its own when a review is due).
- **`/codex-review:init`** — installs the git gate into the current repository: `.githooks/pre-commit` + `core.hooksPath=.githooks`. It checks first, shows the plan, and **writes nothing until you approve**. Re-running upgrades in place.
- **A session-start check** — in a repository that already ships the gate (a teammate committed `.githooks/pre-commit`), it activates the plugin's own copy of the gate in your clone by itself; see [Team enforcement](#team-enforcement). In a repository that doesn't, Claude mentions it once and offers `/codex-review:init`, and installs nothing by itself.
- **A commit guard** — while a shipped gate is not active in your clone, Claude's `git commit` calls are denied.

`init` **fails closed** on anything it doesn't own. It refuses — and writes nothing — when `core.hooksPath` already points somewhere else (husky, lefthook, a global hooks dir), when `.githooks/pre-commit` exists and isn't this gate, or when hooks in `.git/hooks` would silently stop running once `core.hooksPath` is set. Those cases need your decision; it explains them instead of working around them.

Not interested in the gate for a repository that doesn't ship it? Hide the notice (this does not opt out of a gate the repository ships):

```bash
git config codex-review.skipInit true            # this repository
git config --global codex-review.skipInit true   # every repository
```

If you previously vendored the skill into `.claude/skills/codex-review/`, remove that copy after installing the plugin so the skill isn't loaded twice.

## Team enforcement

Git never copies `core.hooksPath` into a clone, so committing `.githooks/pre-commit` alone leaves every other clone unprotected until someone activates it. The plugin closes that gap in layers, from soft to hard:

1. **Teammates get the plugin.** `/codex-review:init` also enables the plugin in the repository's `.claude/settings.json` (`extraKnownMarketplaces` + `enabledPlugins`). Commit it with the gate; a teammate's Claude Code offers to install the plugin when they trust the folder.
2. **The plugin activates the gate in each clone.** At session start, when the repository ships the gate and `core.hooksPath` is unset, the plugin copies **its own bundled gate** to the clone's `.git/hooks/pre-commit` and says so; later sessions keep that copy current with the plugin. The shipped `.githooks/pre-commit` is only the signal: neither it nor anything else in `.githooks/` runs, so a branch or pull request you check out cannot slip hooks in. It does this only when codex is on `PATH` (a fail-closed gate would otherwise block every commit), `core.hooksPath` is unset, and `.git/hooks/pre-commit` is free or already the plugin's; other hooks in `.git/hooks` keep running. Otherwise it explains what needs a decision. `codex-review.skipInit` does not opt out of a shipped gate. To run the repository's `.githooks/` instead, run `/codex-review:init`, which points `core.hooksPath` there after your approval; from then on git runs whatever any checked-out branch puts in `.githooks/`.
3. **Claude cannot commit around it.** While a shipped gate is not active, the plugin denies Bash commands that name `git` and `commit`, with a message saying how to activate it. This is a best-effort net matched on the command text, not the gate: it also denies reads such as `git log --grep commit`, and it checks the repository of the shell's working directory, so `cd elsewhere && git commit` in one command is not caught. If your hook manager (husky, lefthook, …) calls the gate itself, record that once per clone with `git config codex-review.gateWired true`; the guard trusts that setting without verifying it.
4. **People without the plugin** activate it once per clone: `git config core.hooksPath .githooks`. Put that line in the project's setup script (a `bootstrap` script, a `Makefile` `setup` target, a package.json `prepare` script, …) so a fresh clone gets it with the rest of the setup.
5. **Server-side, for a hard guarantee.** Everything above runs on the committer's machine, so `--no-verify`, an edited hook, or unsetting `core.hooksPath` gets past it. To make the review binding, protect the default branch: require pull requests and a status check that the committer cannot skip — for example a CI job that runs a Codex review of the pull request diff with an API key stored as a CI secret, marked as a required check in branch protection (or a `pre-receive` hook on a self-hosted server).

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

With the plugin, `/codex-review:init` does this for you. Otherwise, install the git hook yourself. It runs the `ALLOW:` / `BLOCK:` review, is **fail-closed** (a commit passes only when the staged diff was captured and `codex` exits successfully with `ALLOW:`; a missing or erroring `codex` or a failed diff capture blocks it — never waved through), and **skips** empty / message-only commits. Concluding a merge, cherry-pick or revert by hand (after a conflict, or `--no-commit`) is reviewed against git's own automatic result, so Codex sees only the conflict resolutions and any extra edits, not the changes being brought in; a commit identical to git's result passes without a review. That needs git 2.40+; with an older git, an octopus merge, or a root commit, the whole staged diff is reviewed instead.

Run this from the root of the repository you want to protect:

```bash
mkdir -p .githooks
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/hooks/pre-commit \
  -o .githooks/pre-commit
# or copy it from a local clone: cp /path/to/codex-cc-skill/hooks/pre-commit .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks   # once per clone
```

Setting `core.hooksPath` makes git stop running hooks in `.git/hooks` — move any you rely on into `.githooks/` first.

Now every `git commit` — including the ones Claude Code runs — reviews the staged diff first and is blocked, with the findings on stderr, unless Codex returns `ALLOW:`. Claude Code sees the block in the command output and can fix and re-commit in the same conversation. Keep a slow review under `CODEX_GATE_TIMEOUT` (default 840s). If codex fails without a verdict (not logged in, a CLI older than 0.119.0, a timeout), the block message says so and shows the end of codex's own output. Reviews run with `--ephemeral`, so staged diffs are not kept in codex's session history.

### Bypass & defense-in-depth

- **Bypass** (human, emergencies): `git commit --no-verify` (git's built-in hook skip) or `CODEX_GATE_BYPASS=1 git commit …`. These are visible in the command — use them deliberately, not to skip fixes.
- **A local hook is honor-limited.** It reviews *content* robustly, but anyone (including an agent) with shell access can `--no-verify`, edit the hook, or unset `core.hooksPath`. For a hard, un-bypassable guarantee, enforce **server-side**: branch protection with a required status check, or a `pre-receive` hook — something the committer cannot reach (see [Team enforcement](#team-enforcement)). Treat this hook as an early, in-loop reviewer, and the server as the gate of record.

## Development

Tests exercise `scripts/gate.sh` and `hooks/pre-commit` (through real `git commit`s) against throwaway repositories with a stubbed `codex` (no real codex call). The toolchain is pinned in `.prototools`:

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

# codex-cc-skill

A standalone **Codex code-review skill** for [Claude Code](https://docs.claude.com/en/docs/claude-code) (and any agent that can run shell commands), plus an optional **git pre-commit review gate**. Everything drives the [`codex`](https://github.com/openai/codex) CLI directly — **no Claude Code plugin, no companion runtime, just the `codex` binary**.

## What's in here

| Path | What it is |
|:---|:---|
| `skills/codex-review/SKILL.md` | A model-invocable skill: run an independent Codex review of your git changes with `codex exec review`, present the findings, never auto-fix. |
| `hooks/pre-commit` | A tiny **git** hook that hard-blocks a commit until Codex approves the staged diff (`ALLOW:` / `BLOCK:`). Fires for every `git commit` — from Claude Code, the terminal, another agent, an IDE, or CI. |
| `AGENT-INSTALL.md` | Deterministic, copy-paste install steps written for an AI agent to execute (skill + the git gate). |

## Why a git hook (and not a pre-command agent hook)

`codex exec review` (built into the Codex CLI) already performs a full, repo-aware code review. This project packages that as (a) a Claude Code skill the agent can invoke on its own initiative, and (b) an optional enforcement gate — with **zero extra runtime**: no plugin, no wrapper script, no path resolver.

The gate is a **git `pre-commit` hook** rather than an agent-side "before the tool runs" hook on purpose. A pre-command hook only sees the *shell command string* and has to guess — with regex — whether it will run `git commit` and exactly what it will commit; that is a losing battle against ordinary shell (newlines, wrappers like `timeout`/`sudo`, here-docs, command substitution, quoting). The git hook runs at **commit time against the real staged index** (`git diff --cached`), so it reviews exactly what is about to be committed, no command-parsing required, and it cannot be dodged by how the commit is spelled. It fires no matter who runs `git commit`.

## Installing with an AI coding agent

Paste this prompt into Claude Code (or any agent that can fetch a URL) — it reads the runbook, shows you a plan, and writes nothing until you approve:

```text
Read https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/AGENT-INSTALL.md
and follow it to install the Codex review gate into this repository.
```

Idempotent — re-running the prompt upgrades in place. Prefer to do it by hand? The same steps are written for humans in [`AGENT-INSTALL.md`](AGENT-INSTALL.md).

> **Trust & security.** The prompt has your agent fetch scripts from this repo and merge them into your repo — treat it like any `curl | sh`: trust flows from the repo, not the paste. The approval gate lets you review the plan before anything is written; for a stronger guarantee, skim the bytes that get installed ([`hooks/pre-commit`](hooks/pre-commit), [the skill](skills/codex-review/SKILL.md)) and **pin `main` to a commit SHA or tag** in the prompt — or clone the repo and point the prompt at your local copy.

## Prerequisites

```bash
npm install -g @openai/codex
codex login
```

## Install the skill (Claude Code)

From your project root:

```bash
npx skills add Ruisi-Lu/codex-cc-skill -a claude-code --copy
```

This vendors `skills/codex-review/SKILL.md` into `.claude/skills/codex-review/` and records it in `skills-lock.json` so updates can be tracked. (Or just copy that folder into `.claude/skills/` yourself.)

## Enforce a review at every commit (optional)

Install the git hook. It runs the `ALLOW:` / `BLOCK:` review, is **fail-closed** (a missing or erroring `codex` blocks the commit — never waved through), and **skips** empty / message-only and merge/cherry-pick/revert commits.

```bash
mkdir -p .githooks
cp hooks/pre-commit .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks   # once per clone
```

Now every `git commit` — including the ones Claude Code runs — reviews the staged diff first and is blocked, with the findings on stderr, unless Codex returns `ALLOW:`. Claude Code sees the block in the command output and can fix and re-commit in the same conversation. Keep a slow review under `CODEX_GATE_TIMEOUT` (default 840s).

### Bypass & defense-in-depth

- **Bypass** (human, emergencies): `git commit --no-verify` (git's built-in hook skip) or `CODEX_GATE_BYPASS=1 git commit …`. These are visible in the command — use them deliberately, not to skip fixes.
- **A local hook is honor-limited.** It reviews *content* robustly, but anyone (including an agent) with shell access can `--no-verify`, edit the hook, or unset `core.hooksPath`. For a hard, un-bypassable guarantee, enforce **server-side**: branch protection with a required status check, or a `pre-receive` hook — something the committer cannot reach. Treat this hook as an early, in-loop reviewer, and the server as the gate of record.

## Credits / Derived from

The review-gate mechanism — the `ALLOW:` / `BLOCK:` stop-gate verdict contract — is derived from OpenAI's **Codex Claude Code plugin**: <https://github.com/openai/codex-plugin-cc> (Apache-2.0, © OpenAI). This project reimplements that idea against the plain `codex` CLI so it needs no plugin, and follows the same safety discipline as upstream — repository-derived values such as branch names and diffs are never passed through a shell (see upstream #447 / **v1.0.6**, which this project is tracked against).

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

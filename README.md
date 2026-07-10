# codex-cc-skill

A standalone **Codex code-review skill** for [Claude Code](https://docs.claude.com/en/docs/claude-code) (and any agent that can run shell commands), plus optional **commit-review gates** — a Claude Code hook, a git pre-commit hook, or both. Everything drives the [`codex`](https://github.com/openai/codex) CLI directly — **no Claude Code plugin, no companion runtime, just the `codex` binary**.

## What's in here

| Path | What it is |
|:---|:---|
| `skills/codex-review/SKILL.md` | A model-invocable skill: run an independent Codex review of your git changes with `codex exec review`, present the findings, never auto-fix. |
| `hooks/codex-commit-gate.sh` | A Claude Code `PreToolUse` hook that blocks Claude from running `git commit` until Codex approves the staged diff (`ALLOW:` / `BLOCK:`) — the in-loop counterpart to the git hook. |
| `hooks/pre-commit` | A tiny git hook that hard-blocks a commit until Codex approves the staged diff, for commits made outside Claude Code. |
| `AGENT-INSTALL.md` | Deterministic, copy-paste install steps written for an AI agent to execute (skill + either commit gate), including a safe `jq` merge into an existing `settings.json`. |

## Why

`codex exec review` (built into the Codex CLI) already performs a full, repo-aware code review. This project packages that as (a) a Claude Code skill the agent can invoke on its own initiative, and (b) optional enforcement gates — a Claude Code hook and/or a git hook — with **zero extra runtime**: no plugin, no wrapper script, no path resolver.

## Installing with an AI coding agent
 Paste this prompt into Claude Code (or any agent that can fetch a URL) — it reads the runbook, shows you a plan, and writes nothing until you approve:

```text
Read https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/AGENT-INSTALL.md
and follow it to install the Codex review gate into this repository.
```

Idempotent — re-running the prompt upgrades in place. Prefer to do it by hand? The same steps are written for humans in [`AGENT-INSTALL.md`](AGENT-INSTALL.md).

> **Trust & security.** The prompt has your agent fetch scripts from this repo and merge them into your `.claude/` — treat it like any `curl | sh`: trust flows from the repo, not the paste. The approval gate lets you review the plan before anything is written; for a stronger guarantee, skim the bytes that get installed ([`hooks/codex-commit-gate.sh`](hooks/codex-commit-gate.sh), [`hooks/pre-commit`](hooks/pre-commit), [the skill](skills/codex-review/SKILL.md)) and **pin `main` to a commit SHA or tag** in the prompt — or clone the repo and point the prompt at your local copy.

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

Two ways to hard-block an unreviewed commit — **pick by how you commit.** Both run the same `ALLOW:` / `BLOCK:` review, are **fail-closed** (a missing or erroring `codex` blocks the commit — never waved through), and **skip** empty / message-only and merge/cherry-pick/revert commits.

### Using Claude Code → the `PreToolUse` hook

This is the path for work driven **through Claude Code.** It gates the commit *inside Claude's tool loop*, so when Codex blocks, the findings come straight back to the model and it can fix them and re-commit without leaving the conversation.

```bash
mkdir -p .claude/hooks
cp hooks/codex-commit-gate.sh .claude/hooks/
chmod +x .claude/hooks/codex-commit-gate.sh
```

Then register it in `.claude/settings.json` (create the file if it doesn't exist):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

Now whenever Claude runs `git commit`, the staged diff is reviewed first and the commit is blocked — with the findings handed to Claude — unless Codex returns `ALLOW:`. Keep `timeout` (seconds) above a slow review; it must exceed `CODEX_GATE_TIMEOUT` (default 840s).

### Not using Claude Code → the git pre-commit hook

This is the path for commits made **outside Claude Code** — from the terminal, another agent, an IDE, or CI. It hooks git itself, so it fires no matter who runs `git commit`.

```bash
mkdir -p .githooks
cp hooks/pre-commit .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks   # once per clone
```

### Bypass & defense-in-depth

- **Bypass** (human, emergencies):
  - The **git hook** (`hooks/pre-commit`, terminal/CI) honors `git commit --no-verify` or `CODEX_GATE_BYPASS=1 git commit …` — a human at a real terminal.
  - The **Claude hook** (`hooks/codex-commit-gate.sh`) is **human-only by construction**: it fires only for commits the model runs, so it does **not** honor a model-issued `--no-verify` or inline `CODEX_GATE_BYPASS=1 git commit …` (the model must not wave itself past its own gate). The one accepted override is `CODEX_GATE_BYPASS=1` in the environment Claude Code is launched with.
- The two are **complementary, not either/or.** The Claude hook only fires when Claude Code is driving; install **both** and the git hook becomes a universal backstop that also covers terminal / other-agent / CI commits.
- **Any local hook is honor-limited** — a shell the model controls could edit the hook or use a wrapper the trigger misses. For a hard guarantee, enforce server-side (branch protection / required checks / a pre-receive hook).

## Credits / Derived from

The review-gate mechanism — the `ALLOW:` / `BLOCK:` stop-gate verdict contract — is derived from OpenAI's **Codex Claude Code plugin**: <https://github.com/openai/codex-plugin-cc> (Apache-2.0, © OpenAI). This project reimplements that idea against the plain `codex` CLI so it needs no plugin, and follows the same safety discipline as upstream — repository-derived values such as branch names and diffs are never passed through a shell (see upstream #447 / **v1.0.6**, which this project is tracked against).

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

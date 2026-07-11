# codex-cc-skill — Agent Install Runbook

> **Written for an AI coding agent** (Claude Code, Cursor, …) installing into the **current repository** on the user's behalf. If you are that agent: do the steps in order, **never skip the approval gate in Step 2**, and **merge, never overwrite**. A human can follow the same steps by hand.

## What you are installing

Everything is scoped to **this repo** — nothing global, nothing outside the repo. Two pieces:

- **The review skill** → `.claude/skills/codex-review/SKILL.md` — lets the agent run `codex exec review` on the diff on demand.
- **The commit gate** → a **git `pre-commit` hook** at `.githooks/pre-commit` + `core.hooksPath`. Same `ALLOW:` / `BLOCK:` Codex review, **fail-closed** (a missing or erroring `codex` blocks the commit). It fires for every `git commit` — from Claude Code, the terminal, another agent, an IDE, or CI — and reviews the **real staged index** at commit time, so it can't be dodged by how the commit is spelled.

**Source of truth for every file:** `https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/…` — or a local clone, if you're running in one.

> ⚠️ **Commit pinning:** if the user's install prompt referenced this runbook at a **tag or commit SHA** instead of `main`, fetch **every file from that same ref** — never fall back to `main`. Pinning only means something if what the user reviewed is exactly what installs.

> **Portability:** prefer your own **Read / Write / Edit** tools over the shell snippets below — they behave identically on macOS, Linux, WSL, and native Windows. The `curl` / `chmod` lines are references, not requirements: on native Windows without a POSIX shell, fetch files with your tools and skip `chmod`.

## Prerequisite (hard gate)

`codex` must be installed and authenticated, or the gate can't run:

```bash
command -v codex >/dev/null && codex --version || echo "MISSING: npm i -g @openai/codex && codex login"
```

If it's missing or unauthenticated, tell the user to install and `codex login`, then **stop** — do not substitute another review tool.

## Step 1 — Preflight (read-only, write nothing)

Gather the current state before proposing anything:

1. Confirm the repo root: `git rev-parse --show-toplevel`.
2. Note what's already installed: `.claude/skills/codex-review/SKILL.md`? `git config --get core.hooksPath`?
3. If `core.hooksPath` is already set to something other than `.githooks`, **stop and ask** — don't silently repoint it.

## Step 2 — Present the plan and get approval

Show the user a table of every change you intend to make — each file, the exact modification, and whether it's **create / merge / skip**. **Do not write anything until the user approves.** Re-running later is an idempotent upgrade, so it's safe to approve again.

## Step 3 — Apply

### 3.1 Install the review skill

```bash
mkdir -p .claude/skills/codex-review
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/skills/codex-review/SKILL.md \
  -o .claude/skills/codex-review/SKILL.md
```

### 3.2 Install the git pre-commit gate

```bash
mkdir -p .githooks
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/hooks/pre-commit \
  -o .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks   # once per clone
```

Commit `.githooks/pre-commit` to the repo so it travels with clones; each fresh clone still runs `git config core.hooksPath .githooks` once (git does not adopt `core.hooksPath` automatically).

## Step 4 — Verify and hand off

1. `.claude/skills/codex-review/SKILL.md` exists and `codex` is on `PATH`.
2. `git config core.hooksPath` prints `.githooks`, and `.githooks/pre-commit` is executable.
3. Summarize what changed and how a **human** bypasses in an emergency: `git commit --no-verify` or `CODEX_GATE_BYPASS=1 git commit …` — visible, deliberate, not for skipping fixes. Note that a local hook is honor-limited (anyone with shell access can `--no-verify` or unset `core.hooksPath`); for a hard guarantee, enforce **server-side** (branch protection + a required check, or a `pre-receive` hook). **Do not** run a codex review just to test the install — a smoke test spends a real codex call. Only do so if the user asks.

## Uninstall

```bash
# review skill
rm -rf .claude/skills/codex-review

# git hook
git config --unset core.hooksPath
rm -f .githooks/pre-commit
```

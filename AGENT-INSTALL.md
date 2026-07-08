# codex-cc-skill — Agent Install Runbook

> **Written for an AI coding agent** (Claude Code, Cursor, …) installing into the **current repository** on the user's behalf. If you are that agent: do the steps in order, **never skip the approval gate in Step 2**, and **merge, never overwrite**. A human can follow the same steps by hand.

## What you are installing

Everything is scoped to **this repo** — nothing global, nothing outside the repo. Up to two pieces:

- **The review skill** → `.claude/skills/codex-review/SKILL.md` — lets the agent run `codex exec review` on the diff on demand.
- **A commit gate** (pick one; both is fine) — same `ALLOW:` / `BLOCK:` Codex review, **fail-closed** (a missing or erroring `codex` blocks the commit):
  - **2a · Claude Code hook** → `.claude/hooks/codex-commit-gate.sh` + a `PreToolUse` entry in `.claude/settings.json`. Fires when Claude Code runs `git commit`; the block reason returns to the model in-loop.
  - **2b · git hook** → `.githooks/pre-commit` + `core.hooksPath`. Fires for commits from anywhere (terminal, other agents, IDE, CI).

**Source of truth for every file:** `https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/…` — or a local clone, if you're running in one.

> ⚠️ **Commit pinning:** if the user's install prompt referenced this runbook at a **tag or commit SHA** instead of `main`, fetch **every file from that same ref** — never fall back to `main`. Pinning only means something if what the user reviewed is exactly what installs.

> **Portability:** prefer your own **Read / Write / Edit** tools over the shell snippets below — they behave identically on macOS, Linux, WSL, and native Windows. The `curl` / `jq` / `chmod` lines are references, not requirements: on native Windows without a POSIX shell, fetch files with your tools, merge JSON by parsing it yourself, and skip `chmod`.

## Prerequisite (hard gate)

`codex` must be installed and authenticated, or neither gate can run:

```bash
command -v codex >/dev/null && codex --version || echo "MISSING: npm i -g @openai/codex && codex login"
```

If it's missing or unauthenticated, tell the user to install and `codex login`, then **stop** — do not substitute another review tool.

## Step 1 — Preflight (read-only, write nothing)

Gather the current state before proposing anything:

1. Confirm the repo root: `git rev-parse --show-toplevel`.
2. Read `.claude/settings.json` if it exists — note any existing `hooks.PreToolUse` and `permissions`. You will **merge** into them, never replace the file.
3. Note what's already installed: `.claude/skills/codex-review/SKILL.md`? `.claude/hooks/codex-commit-gate.sh`? `git config --get core.hooksPath`?
4. **Choose the gate.** You are a Claude Code agent, so default to **2a**. Also recommend **2b** if the user commits outside Claude Code (terminal / CI / other agents). If unsure, ask in the plan.

## Step 2 — Present the plan and get approval

Show the user a table of every change you intend to make — each file, the exact modification, and whether it's **create / merge / skip** — plus the settings.json backup line (3.1). **Do not write anything until the user approves.** Re-running later is an idempotent upgrade, so it's safe to approve again.

## Step 3 — Apply

### 3.1 Back up settings.json (if it exists)

```bash
[ -f .claude/settings.json ] && cp .claude/settings.json ".claude/settings.json.bak-$(date +%Y%m%d-%H%M%S)"
```

### 3.2 Install the review skill

```bash
mkdir -p .claude/skills/codex-review
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/skills/codex-review/SKILL.md \
  -o .claude/skills/codex-review/SKILL.md
```

### 3.3a Claude Code hook (recommended)

Fetch the script:

```bash
mkdir -p .claude/hooks
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/hooks/codex-commit-gate.sh \
  -o .claude/hooks/codex-commit-gate.sh
chmod +x .claude/hooks/codex-commit-gate.sh
```

**Merge** this entry into `.claude/settings.json` under `.hooks.PreToolUse` — keep `$CLAUDE_PROJECT_DIR` **literal**, and keep every existing key intact:

```json
{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh", "timeout": 900 } ] }
```

Reference `jq` recipe (idempotent — creates the file if absent, appends if present, won't double-add on re-run):

```bash
f=.claude/settings.json
[ -f "$f" ] || echo '{}' > "$f"
tmp=$(mktemp)
jq --arg cmd '$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh' '
  if any(.hooks.PreToolUse[]?.hooks[]?; .command == $cmd) then .
  else .hooks.PreToolUse = ((.hooks.PreToolUse // []) +
    [{matcher:"Bash", hooks:[{type:"command", command:$cmd, timeout:900}]}])
  end' "$f" > "$tmp" && mv "$tmp" "$f"
```

`timeout` is **seconds** and must exceed a slow review — keep it above `CODEX_GATE_TIMEOUT` (default 840).

### 3.3b git hook (for commits made outside Claude Code)

```bash
mkdir -p .githooks
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/hooks/pre-commit \
  -o .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
```

## Step 4 — Verify and hand off

1. `.claude/skills/codex-review/SKILL.md` exists and `codex` is on `PATH`.
2. **(2a)** `jq -e '.hooks.PreToolUse[].hooks[] | select(.command|endswith("codex-commit-gate.sh"))' .claude/settings.json` succeeds, and the script is executable.
3. **(2b)** `git config core.hooksPath` prints `.githooks`.
4. Tell the user to **restart the Claude Code session (or approve the new project hook)** — project hooks are loaded at session start / after approval, so the gate isn't live until then.
5. Summarize what changed, where the settings.json backup is, and how to bypass: `git commit --no-verify`, or `CODEX_GATE_BYPASS=1 git commit …`. **Do not** run a codex review just to test the install — a smoke test spends a real codex call. Only do so if the user asks.

## Uninstall

```bash
# review skill
rm -rf .claude/skills/codex-review

# Claude hook — drop our PreToolUse entry (keeps any other hooks), then the script
tmp=$(mktemp)
jq --arg cmd '$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh' \
  'if .hooks.PreToolUse then .hooks.PreToolUse |= map(select(any(.hooks[]?; .command==$cmd) | not)) else . end' \
  .claude/settings.json > "$tmp" && mv "$tmp" .claude/settings.json
rm -f .claude/hooks/codex-commit-gate.sh

# git hook
git config --unset core.hooksPath
rm -f .githooks/pre-commit
```

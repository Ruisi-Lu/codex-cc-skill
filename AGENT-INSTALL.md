# Agent install guide

Deterministic, copy-paste steps for an **AI coding agent** (Claude Code, Cursor, …) to install this project into a target repository. A human can follow it too, but the [README](README.md) is friendlier. Every step is **idempotent** — safe to re-run.

> **Canonical URL of this guide** — hand it to an agent verbatim:
> `https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/AGENT-INSTALL.md`
>
> The steps below fetch each file from that same repo with `curl` — no clone required.

You are installing up to three things:

1. **The review skill** — lets the agent run `codex exec review` on the diff on demand.
2. **A commit gate** *(optional)* — hard-blocks an unreviewed commit. Two flavors:
   - **Claude Code `PreToolUse` hook** — fires when *Claude Code* runs `git commit`; the block reason returns to the model in-loop.
   - **git `pre-commit` hook** — fires for commits from anywhere (terminal, other agents, IDE, CI).

Both gates run the same `ALLOW:` / `BLOCK:` review and are **fail-closed** (a missing or erroring `codex` blocks the commit).

---

## 0 · Preconditions

Run every command below from the **target repo root** (the repository you want to protect). Fetching files requires `curl`.

The `codex` CLI must be installed and authenticated:

```bash
command -v codex >/dev/null && codex --version || echo "MISSING: run 'npm i -g @openai/codex && codex login'"
```

If `codex` is missing or unauthenticated, tell the user to install and `codex login`, then **stop** — do not substitute a different review tool.

> Prefer a local clone over `curl`? `git clone https://github.com/Ruisi-Lu/codex-cc-skill` and `cp` from it instead of the `curl` lines below.

---

## 1 · Install the review skill

```bash
mkdir -p .claude/skills/codex-review
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/skills/codex-review/SKILL.md \
  -o .claude/skills/codex-review/SKILL.md
```

**Verify:** `test -s .claude/skills/codex-review/SKILL.md && echo OK`

---

## 2 · Install a commit gate (optional, recommended)

Pick by how the user commits — ask if unsure; you may install both:

| The user commits… | Do |
|:--|:--|
| through **Claude Code** | **2a** — the `PreToolUse` hook |
| from **terminal / other agent / IDE / CI** | **2b** — the git hook |
| both | **2a and 2b** (git hook becomes a universal backstop) |

### 2a · Claude Code `PreToolUse` hook

Fetch the script:

```bash
mkdir -p .claude/hooks
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/hooks/codex-commit-gate.sh \
  -o .claude/hooks/codex-commit-gate.sh
chmod +x .claude/hooks/codex-commit-gate.sh
```

Register it in `.claude/settings.json` (shared with the team — use `.claude/settings.local.json` instead for just yourself). **Merge; never clobber an existing file.** This `jq` recipe creates the file if absent, appends if present, and won't double-add on re-run:

```bash
mkdir -p .claude
f=.claude/settings.json
[ -f "$f" ] || echo '{}' > "$f"
tmp=$(mktemp)
jq --arg cmd '$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh' '
  if any(.hooks.PreToolUse[]?.hooks[]?; .command == $cmd) then .
  else .hooks.PreToolUse = ((.hooks.PreToolUse // []) +
    [{matcher:"Bash", hooks:[{type:"command", command:$cmd, timeout:900}]}])
  end' "$f" > "$tmp" && mv "$tmp" "$f"
```

> Keep `$CLAUDE_PROJECT_DIR` **literal** in the file (single-quote it in the shell as above) — Claude Code expands it at runtime.

The entry it produces, for reference / manual editing:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh", "timeout": 900 }
        ]
      }
    ]
  }
}
```

**Verify:** `jq -e '.hooks.PreToolUse[].hooks[] | select(.command|endswith("codex-commit-gate.sh"))' .claude/settings.json >/dev/null && echo OK`

Notes:
- `timeout` is **seconds** and must exceed a slow review — keep it above `CODEX_GATE_TIMEOUT` (default 840).
- Claude Code loads project hooks only after the user approves them. Tell the user to accept the hook (or restart the session) for it to take effect.

### 2b · git `pre-commit` hook

```bash
mkdir -p .githooks
curl -fsSL https://raw.githubusercontent.com/Ruisi-Lu/codex-cc-skill/refs/heads/main/hooks/pre-commit \
  -o .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks     # once per clone
```

**Verify:** `test "$(git config core.hooksPath)" = .githooks && echo OK`

> Switching an existing repo *from* the git hook *to* the Claude hook? Undo the git hook with `git config --unset core.hooksPath` (local, reversible — the tracked `.githooks/pre-commit` can stay, it's inert without this), then do **2a**.

---

## 3 · Report back to the user

State exactly what you installed, and pass on:

- **Bypass** (human / emergency): `git commit --no-verify`, or `CODEX_GATE_BYPASS=1 git commit …` — honored by both gates.
- **Fail-closed**: if `codex` is missing or errors, commits are blocked, never waved through.
- **Bootstrap**: if you installed **2b** and now commit these install files, that commit is itself reviewed — use `git commit --no-verify` for that first commit if you don't want to gate it.

**Do not** run a codex review just to "test" the install — a smoke test spends a real codex call. Only run one if the user asks.

---

## Uninstall

```bash
# review skill
rm -rf .claude/skills/codex-review

# 2a — remove our PreToolUse entry, then the script (keeps any other hooks intact)
tmp=$(mktemp)
jq --arg cmd '$CLAUDE_PROJECT_DIR/.claude/hooks/codex-commit-gate.sh' \
  'if .hooks.PreToolUse then .hooks.PreToolUse |= map(select(any(.hooks[]?; .command==$cmd) | not)) else . end' \
  .claude/settings.json > "$tmp" && mv "$tmp" .claude/settings.json
rm -f .claude/hooks/codex-commit-gate.sh

# 2b
git config --unset core.hooksPath
rm -f .githooks/pre-commit
```

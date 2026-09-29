---
description: Install or upgrade the Codex pre-commit review gate in the current git repository. Checks for conflicts, shows the plan, and writes nothing until the user approves. Use when the user asks to set up the codex review or commit gate, or agrees after the codex-review plugin reports the gate is not active in this repository.
allowed-tools: Bash(sh "${CLAUDE_PLUGIN_ROOT}/scripts/gate.sh" check)
---

# Initialize the Codex commit gate

Install (or upgrade) the codex-review **git pre-commit gate** in the current repository: `.githooks/pre-commit` plus `core.hooksPath=.githooks`. From then on every `git commit` in the repo is blocked unless Codex approves the staged diff, and a missing or failing `codex` blocks too (fail-closed). The review skill itself ships with this plugin — there is nothing to copy for it.

All reads and writes go through the bundled helper. It never repoints an existing `core.hooksPath`, never overwrites a pre-commit hook it did not write, and never disables hooks that are already active in `.git/hooks`.

## 1. Check (read-only)

Run from inside the repository:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/gate.sh" check
```

## 2. Act on the `state:` line

| `state:` | What to do |
|:---|:---|
| `not-git` | Tell the user this directory is not a git work tree. Stop. |
| `installed` | Tell the user the gate is already installed and current. Stop. |
| `conflict` | Explain each `conflicts:` line in plain words, then stop. Do **not** repoint `core.hooksPath`, or overwrite, move or chain hooks on your own. The user's options: wire the gate into their existing setup themselves (e.g. call a copy of `${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit` from their hook manager's pre-commit), ask you to do that as a separate, explicit task, or hide the session-start notice with `git config codex-review.skipInit true`. |
| `missing` / `differs` | Continue with step 3. |

If the `codex:` line says NOT FOUND, tell the user to install it (`npm install -g @openai/codex`, then `codex login`) and stop — without it the fail-closed gate would block every commit. If `codex auth:` starts with `NOT verified`, tell the user, and continue only if they confirm codex authenticates in a way the check doesn't recognize (e.g. a config profile); otherwise they should run `codex login` first. Any other `codex auth:` value (a codex login, an API key in the environment, or a custom `model_provider`) is fine — just mention it in the plan.

## 3. Present the plan and get approval

Show the `plan:` lines as a short table (change → create / replace / config) and say plainly what it means: every commit will run one Codex review (up to `CODEX_GATE_TIMEOUT`, default 840s) and is blocked unless Codex answers `ALLOW:`. For `differs`, first show what would change and say which way it goes — the repository's copy may be an older release, a **newer** one (a teammate on a newer plugin version; then recommend updating the plugin instead of replacing it), or a local edit the user wants to keep:

```bash
diff -u .githooks/pre-commit "${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit"
```

**Write nothing until the user explicitly approves.** If they decline, mention `git config codex-review.skipInit true` (or `--global` for every repository) to stop the session-start notice, and stop.

## 4. Install

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/gate.sh" install
```

It re-checks before writing. Exit code `2` means it refused (a conflict, or codex missing) and wrote nothing: report its message and stop — never work around the refusal.

## 5. Verify and hand off

1. Re-run the `check` command; it must print `state: installed`.
2. Tell the user to commit `.githooks/pre-commit` so it travels with clones (that first commit is itself reviewed by the gate). Each fresh clone still needs `git config core.hooksPath .githooks` once; with this plugin enabled, the session-start check offers it.
3. Human emergency bypass: `git commit --no-verify` or `CODEX_GATE_BYPASS=1 git commit …` — visible, deliberate, not for skipping fixes. A local hook is honor-limited; for a hard guarantee enforce server-side (branch protection with a required check, or a `pre-receive` hook).
4. Do **not** run a codex review or a test commit to "try" the gate — that spends a real codex call. Only do so if the user asks.

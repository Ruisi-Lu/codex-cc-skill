# codex-cc-skill

A standalone **Codex code-review skill** for [Claude Code](https://docs.claude.com/en/docs/claude-code) (and any agent that can run shell commands), plus an optional **git pre-commit review gate**. Both drive the [`codex`](https://github.com/openai/codex) CLI directly — **no Claude Code plugin, no companion runtime, just the `codex` binary**.

## What's in here

| Path | What it is |
|:---|:---|
| `skills/codex-review/SKILL.md` | A model-invocable skill: run an independent Codex review of your git changes with `codex exec review`, present the findings, never auto-fix. |
| `hooks/pre-commit` | A tiny git hook that hard-blocks a commit until Codex approves the staged diff (`ALLOW:` / `BLOCK:`). |

## Why

`codex exec review` (built into the Codex CLI) already performs a full, repo-aware code review. This project packages that as (a) a Claude Code skill the agent can invoke on its own initiative, and (b) an optional enforcement gate — with **zero extra runtime**: no plugin, no wrapper script, no path resolver.

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

## Install the commit gate (optional)

```bash
mkdir -p .githooks
cp hooks/pre-commit .githooks/pre-commit
chmod +x .githooks/pre-commit
git config core.hooksPath .githooks   # once per clone
```

Now every `git commit` reviews the staged diff and is aborted with the findings unless Codex returns `ALLOW:`.

- **Bypass** (human, emergencies): `git commit --no-verify`, or `CODEX_GATE_BYPASS=1 git commit …`
- **Fail-closed**: if `codex` is missing or errors, the commit is blocked — never waved through.
- **Skipped**: empty / message-only commits and merge/cherry-pick/revert commits.

## Credits / Derived from

The review-gate mechanism — the `ALLOW:` / `BLOCK:` stop-gate verdict contract — is derived from OpenAI's **Codex Claude Code plugin**: <https://github.com/openai/codex-plugin-cc> (Apache-2.0, © OpenAI). This project reimplements that idea against the plain `codex` CLI so it needs no plugin, and follows the same safety discipline as upstream — repository-derived values such as branch names and diffs are never passed through a shell (see upstream #447 / **v1.0.6**, which this project is tracked against).

## License

Apache-2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

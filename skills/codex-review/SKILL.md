---
name: codex-review
description: Run an independent Codex code review of local git changes via the `codex` CLI (`codex exec review`). Use when the user asks to review/check the diff or changes with Codex, wants a second opinion, or says "codex review"; and proactively after finishing a nontrivial code change, before committing, as a correctness gate. Standalone — needs only the `codex` CLI, no Claude Code plugin. Review-only: it surfaces findings and never auto-fixes.
---

# Codex Review

Get Codex to review your git changes and return its findings. Codex is a **second, independent reviewer** — a different model with fresh eyes — so it catches correctness and security bugs your own pass can miss.

This skill is **standalone**: it drives the `codex` CLI directly (`codex exec review`), so it works for anyone who has Codex installed — **no Claude Code plugin, no companion script, no wrapper.** The CLI already does a full, repo-aware review; this skill is just the instructions for when and how to invoke it and how to handle the result.

## Prerequisite

The `codex` CLI must be installed and authenticated:

```bash
npm install -g @openai/codex   # if `codex` is not already on PATH
codex login                    # one-time auth (ChatGPT sign-in or API key)
```

If `codex` is missing or unauthenticated, tell the user to run the above and stop — do not improvise a different review path.

## When to run it

- The user asks — in plain language — to review / check / get a second opinion on the diff or changes with Codex.
- **Proactively**, after you finish a nontrivial code change and before you commit — treat it as a correctness gate, especially for backend, auth/security, concurrency, data-flow, or migration changes.
- Before handing a change back to the user when you're not fully confident it's correct.

Do **not** run it for trivial one-line / rename / comment / docs-only changes, when there's nothing to review, or when you already reviewed this exact diff and nothing changed. Reviews cost time and tokens — be judicious, but when a real change is on the line, prefer running it.

## How to run it

Run from the **repo root**, and pick the scope:

```bash
# Committed branch diff vs a base branch (the PR diff):
codex exec review --base <default-branch>      # e.g. --base main  or  --base master

# Uncommitted work (staged + unstaged + untracked):
codex exec review --uncommitted

# The changes introduced by a single commit:
codex exec review --commit <sha>

# Optional focus / custom instructions (append as a prompt):
codex exec review --base main "Pay special attention to the auth and error-handling changes."
```

Run the command with a long timeout (up to ~10 minutes for a large diff). `codex exec review` runs read-only — it reviews, it does not edit — and prints its findings to stdout.

Default-scope guidance when the user is vague ("review my changes"): use `--uncommitted` if there are uncommitted changes; otherwise `--base <default-branch>` (detect it, usually `main` or `master`).

## Presenting the result — and the hard stop

- Lead with the **findings, ordered by severity**, using Codex's file paths and line numbers verbatim.
- Preserve Codex's uncertainty / inference labels and any sections it produced.
- If there are **no findings**, say so plainly and keep the residual-risk note brief.
- If `codex` fails or is unauthenticated, surface the actionable error and point the user to `codex login` — don't fabricate a review.

**CRITICAL — do not auto-fix.** After presenting the findings, STOP. Do not edit a single file. Explicitly ask the user which findings, if any, they want fixed before you touch anything. Auto-applying fixes from a review is forbidden, even when a fix looks obvious. (If the user then asks you to fix them, that is a separate, explicitly-requested editing task.)

## Optional: enforce a review at every commit

A repo can hard-require a passing review before each commit using the companion git hook shipped alongside this skill (`hooks/pre-commit`): it reviews the staged diff via `codex exec` and aborts the commit unless Codex returns `ALLOW:`. See the repo README to install it. When that gate is active, **run this skill proactively before committing** so you resolve findings first and the commit passes on the first try instead of getting bounced.

## Credits

The review-gate approach — the `ALLOW:` / `BLOCK:` verdict contract — is derived from OpenAI's Codex Claude Code plugin, <https://github.com/openai/codex-plugin-cc> (Apache-2.0). This skill reimplements it against the plain `codex` CLI so it needs no plugin.

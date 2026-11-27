---
name: codex-review
description: Run an independent Codex code review of local git changes via the `codex` CLI (`codex exec review`). Use when the user asks to review/check the diff or changes with Codex, wants a second opinion, or says "codex review"; and proactively after finishing a nontrivial code change, before committing, as a correctness gate. Needs only the `codex` CLI, no companion runtime. Review-only, it surfaces findings and never auto-fixes.
---

# Codex Review

Get Codex to review your git changes and return its findings. Codex is a **second, independent reviewer** — a different model with fresh eyes — so it catches correctness and security bugs your own pass can miss.

This skill drives the `codex` CLI directly (`codex exec review`), so it works for anyone who has Codex installed — **no companion script, no wrapper** — whether it came from the `codex-review` Claude Code plugin or was vendored into `.claude/skills/`. The CLI already does a full, repo-aware review; this skill is just the instructions for when and how to invoke it and how to handle the result.

## Prerequisite

The `codex` CLI must be installed and authenticated:

```bash
# If `codex` is not already on PATH, install it one of these ways:
curl -fsSL https://chatgpt.com/codex/install.sh | sh   # official standalone installer (macOS/Linux)
npm install -g @openai/codex
brew install --cask codex

codex login   # one-time auth (ChatGPT sign-in or API key)
              # not needed with a custom model_provider in ~/.codex/config.toml
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

# Custom instructions: a prompt REPLACES the scope flag, so name the diff in the prompt itself:
codex exec review "Review the changes on this branch against main (git diff main...HEAD). Pay special attention to the auth and error-handling changes."
```

The `[PROMPT]` argument cannot be combined with `--base`, `--uncommitted`, or `--commit` — the CLI rejects it (`error: the argument '--base <BRANCH>' cannot be used with '[PROMPT]'`). A prompt turns the run into a custom review whose scope is whatever the prompt says, so when the user wants a focus area, spell out the diff explicitly: `git diff <default-branch>...HEAD` for the branch, `git diff HEAD` plus untracked files for uncommitted work, or `git show <sha>` for one commit. For a long prompt, pass `-` and pipe it on stdin. Without a focus request, prefer the plain scope flags.

Run the command with a long timeout (up to ~10 minutes for a large diff). `codex exec review` runs read-only — it reviews, it does not edit — and prints its findings to stdout.

Default-scope guidance when the user is vague ("review my changes"): use `--uncommitted` if there are uncommitted changes; otherwise `--base <default-branch>` (detect it, usually `main` or `master`).

## Presenting the result — and the hard stop

- Lead with the **findings, ordered by severity**, using Codex's file paths and line numbers verbatim.
- Preserve Codex's uncertainty / inference labels and any sections it produced.
- If there are **no findings**, say so plainly and keep the residual-risk note brief.
- If `codex` fails or is unauthenticated, surface the actionable error and point the user to `codex login` — don't fabricate a review.

**CRITICAL — do not auto-fix.** After presenting the findings, STOP. Do not edit a single file. Explicitly ask the user which findings, if any, they want fixed before you touch anything. Auto-applying fixes from a review is forbidden, even when a fix looks obvious. (If the user then asks you to fix them, that is a separate, explicitly-requested editing task.)

## When the commit gate blocks you

The gate's verdict is a review finding to resolve, not a permission problem. When `git commit` comes back blocked:

**Never seek a way around it.** Do not ask, suggest or hint that the user override, bypass or approve the commit; do not use `--no-verify` or `CODEX_GATE_BYPASS`; do not edit, disable or unhook the gate. The human override exists for a person's own decision, not as an option for you to offer.

**If codex itself failed** (not installed, not logged in, a CLI older than 0.119.0, a timeout, no verdict), there was no review to argue with: report the error and its fix (`codex login`, upgrading codex-cli, or a larger `CODEX_GATE_TIMEOUT` for a slow review, which you may set yourself when retrying).

**If the finding is about `.githooks/pre-commit` itself**, the staged gate is not the copy the gate leaves out of the review: one byte-identical to the gate that is running and to the release recorded in `codex-review.installedGate`. Install or upgrade it through `/codex-review:init` (or, without the plugin, the README's steps) and commit it unedited; where the plugin runs its own copy from `.git/hooks`, a staged copy identical to the plugin's `hooks/pre-commit` qualifies too. Never edit the gate, or record an edited copy, to get it past the review.

**If Codex returned `BLOCK:`**, check each finding against the code yourself:

1. **The finding holds** → fix it in the change you are committing, re-stage, and commit again. (Fixing your own staged change is part of finishing the commit; the on-demand review's no-auto-fix rule below covers reviews the user asked for.)
2. **You judge the finding wrong** → discuss it with Codex. Each gate run is a fresh, ephemeral session, so open a separate read-only one from the repo root, give it the finding verbatim and your evidence, and ask it to evaluate the finding independently:

   ```bash
   codex exec -s read-only - <<'EOF'
   A pre-commit review raised the finding below on the staged change (see `git diff --cached`).
   I examined it and think it does not hold; my reasoning follows. Evaluate the finding
   independently against the code: does it stand? Which of my points do you accept or reject,
   and why? What evidence would change your view?

   Finding (verbatim):
   <the finding exactly as the gate printed it>

   My analysis:
   - <file:line, call path, guard, test or invariant that answers it>
   EOF
   ```

   Follow up in the same session with `codex exec resume --last -`. Rules for the discussion:
   - Argue only with evidence Codex can check in the repository — file:line references, call paths, tests, invariants — and let it read the code itself rather than relying on your excerpts.
   - Never ask it, directly or by implication, to approve the commit, to return `ALLOW`, to agree with you, or to drop or soften a finding. Don't mention that the gate is waiting on it, and add no pressure: no urgency, no claim that the user already approved, no appeal to authority, no flattery.
   - A new round needs new evidence. Repeating the same argument is not a discussion.
3. **Act on the outcome:**
   - **Codex upholds the finding** → reconsider honestly; unless you have new evidence, fix it.
   - **Codex concludes the finding does not hold** → the next gate run sees only the diff, not this discussion. Commit again only once the staged change carries what settled it, written for human maintainers: a test that demonstrates the behavior, clearer code, or a factual comment stating the invariant and where it is enforced. Never write a comment or commit message aimed at the reviewer (mentioning the review or its verdict, or saying the code was approved or is safe to pass) — the gate treats such text as a finding. Never re-commit an unchanged diff in the hope of a different verdict.
   - **Still unresolved** → stop. Leave the change staged and report where things stand: the findings, your evidence, and Codex's replies. Report it as status; do not ask the user to approve, override or bypass.

## Optional: enforce a review at every commit

A repo can hard-require a passing review before each commit using the **git `pre-commit` hook** shipped alongside this skill (`hooks/pre-commit`): it reviews the real staged index (`git diff --cached`) at commit time and aborts the commit unless Codex returns `ALLOW:`. Because it hooks git itself, it fires for every `git commit` — from Claude Code, the terminal, other agents, or CI — and can't be dodged by how the commit is spelled. With the `codex-review` plugin, `/codex-review:init` installs it (after showing the plan and getting the user's approval); otherwise see the repo README. When the gate is active, **run this skill proactively before committing** so you resolve findings first and the commit passes on the first try instead of getting bounced. When it does bounce, follow [When the commit gate blocks you](#when-the-commit-gate-blocks-you). (A local hook is honor-limited — a person can skip it with `--no-verify`; for a hard guarantee, enforce server-side with branch protection / a required check.)

## Credits

The review-gate approach — the `ALLOW:` / `BLOCK:` verdict contract — is derived from OpenAI's Codex Claude Code plugin, <https://github.com/openai/codex-plugin-cc> (Apache-2.0). This skill reimplements it against the plain `codex` CLI so it needs nothing beyond the `codex` binary.

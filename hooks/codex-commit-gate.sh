#!/bin/sh
# codex-review gate for Claude Code — a PreToolUse(Bash) hook that blocks Claude
# from running `git commit` unless Codex approves the staged diff.
#
# This is the Claude-native counterpart to hooks/pre-commit: same ALLOW/BLOCK
# review, but it fires INSIDE Claude Code's tool loop, so when Codex blocks, the
# findings are handed back to the model and it can fix them and re-commit without
# leaving the conversation. Use hooks/pre-commit to also gate commits made
# outside Claude Code (terminal, other agents, CI).
#
# Install (in your project):
#   mkdir -p .claude/hooks
#   cp hooks/codex-commit-gate.sh .claude/hooks/
#   chmod +x .claude/hooks/codex-commit-gate.sh
#   # then register it in .claude/settings.json (see the repo README).
#
# Contract (Claude Code PreToolUse): reads the hook JSON on stdin, lets every
# non-commit Bash command through (exit 0), and for a `git commit` runs Codex
# fully isolated from the repo. ALLOW -> exit 0 (commit proceeds). BLOCK / codex
# missing / codex error -> exit 2 with the reason on stderr, which Claude Code
# feeds back to the model as the block reason (fail-closed — never waved through).
#
# Because the hook runs BEFORE the command, the only index it can trust is a
# pre-staged one. Shapes that (re)stage in the same call are rejected outright:
# same-call staging (`git add … && git commit`), commit-time staging flags
# (`-a`/`--all`/`--include`/`--interactive`/`--patch`), and a bare commit from a
# dirty tree with an empty index. The required form is two steps: stage in one
# Bash call, plain `git commit -m …` in the next. Known residual: pathspec or
# late `-a` commits layered over an already-staged index can still under-review;
# pair with hooks/pre-commit (git-level, commit-time index) for an airtight gate.
#
# Bypass (human/emergency): `git commit --no-verify`, prefix the command with
# CODEX_GATE_BYPASS=1, or run Claude with CODEX_GATE_BYPASS=1 in its environment.

payload=$(cat)

# Fast path: if the payload never mentions "commit", it cannot be a `git commit`
# — skip parsing entirely so ordinary Bash calls pay ~nothing.
printf '%s' "$payload" | grep -q 'commit' || exit 0

# Pull the Bash command (and cwd) out of the hook JSON. Prefer jq, fall back to
# python3. If neither exists we cannot safely inspect a git command, so — being a
# fail-closed gate — block anything git-ish with an actionable message.
cmd=""
cwd=""
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
  cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null)
elif command -v python3 >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
  cwd=$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("cwd",""))' 2>/dev/null)
else
  if printf '%s' "$payload" | grep -q 'git'; then
    echo "[codex-review-gate] install 'jq' (or python3) so the commit gate can read git commits — or bypass this commit with 'git commit --no-verify'." >&2
    exit 2
  fi
  exit 0
fi
[ -n "$cmd" ] || cmd=$payload

# Is this actually a `git commit`? Match `git`, optional global flags (e.g.
# `-C <dir>`, `-c k=v`), then `commit` as the subcommand — this excludes
# `git log --grep=commit`, `git commit-tree`, `echo "git commit"`, etc.
commit_re='(^|[;&|(])[[:space:]]*(sudo[[:space:]]+)?git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)'
printf '%s' "$cmd" | grep -Eq "$commit_re" || exit 0

# Bypass: environment variable, inline `CODEX_GATE_BYPASS=1 …`, or `--no-verify`.
[ "$CODEX_GATE_BYPASS" = "1" ] && exit 0
case "$cmd" in
  *CODEX_GATE_BYPASS=1*) exit 0 ;;
  *--no-verify*)         exit 0 ;;
esac

# The hook fires before the command executes, so it can only review an index
# that already exists. A command that reshapes the index in the same call as the
# commit would commit content this review never saw — fail closed and ask for
# the two-step form instead.
staging_re='(^|[;&|(])[[:space:]]*(sudo[[:space:]]+)?git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(add|rm|mv|reset|restore|stash|apply|update-index|read-tree|checkout|cherry-pick|merge|revert|pull)([[:space:]]|$)'
if printf '%s' "$cmd" | grep -Eq "$staging_re"; then
  echo "[codex-review-gate] this command changes the git index in the same call as 'git commit', so the review cannot see what would actually be committed (the hook runs before the command executes). Run the staging step ('git add …') as its own Bash call, then a plain 'git commit -m \"…\"' as the next call." >&2
  exit 2
fi

# `git commit -a/--all/--include/--interactive/--patch` stage at commit time —
# equally invisible to a pre-command review. Scan only up to the first `-m` /
# `--message` so commit-message text cannot false-positive the long flags; the
# short `-a` cluster is only matched directly after `commit` (never `--amend`).
cmd_head=$(printf '%s' "$cmd" | sed 's/[[:space:]]-m[[:space:]].*//; s/[[:space:]]--message.*//')
if printf '%s' "$cmd_head" | grep -Eq -- 'commit[[:space:]]+-[A-Za-z]*a([A-Za-z]*)?([[:space:]]|$)|--all([[:space:]]|$)|--include([[:space:]]|$)|--interactive([[:space:]]|$)|--patch([[:space:]]|$)'; then
  echo "[codex-review-gate] 'git commit -a/--all/--include/--interactive/--patch' stages changes at commit time, which this pre-command review cannot see. Stage explicitly with 'git add …' in one Bash call, then run a plain 'git commit -m \"…\"' in the next." >&2
  exit 2
fi

# Run git in the repo Claude is working in. If cwd is missing/unusable, fall back
# to the hook's own cwd — Claude Code sets it to the project root, still the repo.
# shellcheck disable=SC2164
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd" 2>/dev/null

# Skip commits that aren't a plain edit-and-commit.
gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
if [ -e "$gitdir/MERGE_HEAD" ] || [ -e "$gitdir/CHERRY_PICK_HEAD" ] || [ -e "$gitdir/REVERT_HEAD" ]; then
  exit 0
fi

if git diff --cached --quiet 2>/dev/null; then
  # Nothing staged at hook time. Clean tree → the commit is a no-op (or
  # --allow-empty, an empty diff), so let git handle it. Dirty tree → the commit
  # could only pick up content through same-call staging, '-a', or pathspec
  # arguments, none of which this pre-command review can see. Fail closed.
  [ -z "$(git status --porcelain 2>/dev/null)" ] && exit 0
  echo "[codex-review-gate] nothing is staged but the working tree has changes — a commit from here could only include content via same-call staging, '-a', or pathspec arguments, which this review cannot see (the hook runs before the command). Stage with 'git add …' in one Bash call, then run a plain 'git commit -m \"…\"' in the next." >&2
  exit 2
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "[codex-review-gate] codex CLI not found — run 'npm i -g @openai/codex && codex login', or bypass this commit with 'git commit --no-verify'." >&2
  exit 2
fi

codex="codex"
command -v timeout >/dev/null 2>&1 && codex="timeout ${CODEX_GATE_TIMEOUT:-840} codex"

tmp=$(mktemp -d) || { echo "[codex-review-gate] mktemp failed" >&2; exit 2; }
trap 'rm -rf "$tmp"' EXIT

# Capture the staged diff while the git environment is still valid.
git diff --cached >"$tmp/staged.diff"

# Run codex with NO handle on this repo: cwd is the temp dir, and every GIT_*
# variable in the environment is unset. The diff is read from the file. This
# block MUST stay identical to hooks/pre-commit — running codex inside a
# codex-"trusted" repo otherwise performs a "curated-sync" that RESETS HEAD.
(
  for v in $(env | sed -n 's/^\(GIT_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
  $codex exec \
    "You are a mandatory pre-commit code review gate. Review ONLY the staged diff provided on stdin. Your FIRST line MUST be exactly 'ALLOW: <reason>' or 'BLOCK: <reason>'. BLOCK only for real problems introduced by this diff (correctness bugs, security/authorization holes, data loss, broken error handling, resource/lifecycle leaks, clear regressions); when you BLOCK, list each finding after the first line as 'file:line — problem — fix'. Do not block on style, nitpicks, or pre-existing issues unrelated to this diff." \
    -C "$tmp" --skip-git-repo-check -s read-only --color never -o "$tmp/verdict" <"$tmp/staged.diff" >/dev/null 2>&1
)

if head -n 1 "$tmp/verdict" 2>/dev/null | grep -q '^ALLOW:'; then
  exit 0
fi

{
  echo "[codex-review-gate] commit blocked — Codex review did not pass:"
  echo
  cat "$tmp/verdict" 2>/dev/null || echo "(no review output — codex may have failed; check 'codex login')"
  echo
  echo "Resolve the findings above, then commit again. Human override: git commit --no-verify  or  CODEX_GATE_BYPASS=1"
} >&2
exit 2

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
# pre-staged one. So the gate is deny-by-default about command shape: the call
# must consist of exactly one plain commit —
#     git [-C <dir>] commit [allowlisted flags] -m '<message>'
# (double quotes, --message=…, -F <file>, or a message-less form such as
# --amend --no-edit also work) with the message as the FINAL token. Anything
# else — same-call staging (`git add … && git commit`), assignment/wrapper
# prefixes (`VAR=x git commit`, `env git commit`), commit-time staging flags
# (-a/-i/-p/--all/--include/--interactive/--patch), pathspec arguments,
# trailing flags or commands after the message (`-m x -a`, `… && git push`),
# or a bare commit from a dirty tree with an empty index — is rejected with
# instructions to use the two-step form: stage in one Bash call, plain-commit
# in the next. Message text is never scanned, so messages may freely quote
# commands like `git add`. Residual: a wrapper the trigger regex does not
# recognize can dodge the gate entirely; pair with hooks/pre-commit
# (git-level, commit-time index) for an airtight gate.
#
# Bypass is HUMAN-ONLY by construction. This hook fires only for commits Claude
# Code itself runs, so it does NOT honor a model-issued `--no-verify` or an
# inline `CODEX_GATE_BYPASS=1 git commit …`; the model cannot wave itself past
# its own gate. The one accepted override is CODEX_GATE_BYPASS=1 in the
# environment Claude Code is launched with (a human decision made before the
# session). Humans committing outside Claude Code never reach this hook — use
# `git commit --no-verify` or the git-level hooks/pre-commit there. Note: any
# local hook is honor-limited — a shell the model controls could still edit the
# hook or use a wrapper the trigger misses; true enforcement is server-side
# (branch protection / required checks / a pre-receive hook).

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

# The ONLY override this hook honors is a HUMAN one: CODEX_GATE_BYPASS=1 set in
# the environment Claude Code was launched with. This hook fires solely for
# commits the model runs, so it must never let the model wave ITSELF through the
# review it exists to enforce. An inline `CODEX_GATE_BYPASS=1 git commit …` does
# NOT bypass — the assignment prefix is not a plain commit, so the shape check
# below rejects it — and `--no-verify` is rejected explicitly in the flag loop.
# Setting the env var is a human decision made before the session; the model
# cannot alter this hook's own environment from a later Bash call. Humans
# committing outside Claude Code never reach this hook — they use `git commit
# --no-verify` or the git-level hooks/pre-commit there.
[ "$CODEX_GATE_BYPASS" = "1" ] && exit 0

# Deny-by-default shape validation, on the command flattened to one line so
# multi-line -m bodies and newline-separated commands are analysed uniformly.
flat=$(printf '%s' "$cmd" | tr '\n\t' '  ')

# Does this command RUN `git commit` in any position? A narrow anchored regex
# fails OPEN on shell-wrapped commits (`if …; then git commit`, `` `git commit` ``,
# `$(git commit)`, `while …; do git commit`), letting an unreviewed commit
# through. Instead, split the command into candidate simple-commands at shell
# operators (; | & && || ( ) { } `) and then test each for a leading
# `git … commit` — allowing assignment/wrapper prefixes (VAR=x, env, command,
# sudo, nice, timeout, xargs, …) and shell keywords (then/do/else/…) to precede
# `git`. A commit hidden in any of those positions therefore starts a candidate
# and is DETECTED; the standalone-shape check below then rejects it. Mentions
# that stay mid-segment — `echo "git commit"`, `grep -r "git commit" .`,
# `git log --grep=commit` — are correctly NOT detected (git is not the segment's
# leading word). Residual: an unlisted wrapper (e.g. `setsid git commit`) is not
# detected here; the git-level hooks/pre-commit backstops that at commit time.
# shellcheck disable=SC2020 # each metachar is intentionally mapped to newline
segs=$(printf '%s' "$flat" | tr ';|&(){}`' '[\n*]')
seg_commit_re='^[[:space:]]*(([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|builtin|exec|sudo|nice|time|nohup|setsid|ionice|stdbuf|timeout|xargs|then|do|else|elif|while|until|if|case|not|!|-[^[:space:]]+)[[:space:]]+)*git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)'
printf '%s' "$segs" | grep -Eq "$seg_commit_re" || exit 0

# It runs a commit. From here the WHOLE command must be exactly one standalone
# plain commit; anything else fails closed.
#
# Layer 1 — nothing before the commit: the flat command must start with
# `git [-C <dir>]… commit`. Kills `git add … && git commit`, `VAR=x git commit`,
# `env git commit`, `if …; then git commit; fi`, `` `git commit` ``,
# `cd x && git commit`. Staging/setup belongs in its own earlier Bash call;
# rejecting compound commands is the contract, not collateral damage — the hook
# can only trust a pre-staged index, so the commit must arrive alone.
if ! printf '%s' "$flat" | grep -Eq '^[[:space:]]*git([[:space:]]+-C[[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'; then
  echo "[codex-review-gate] the gate accepts only a single plain commit as the whole command: git [-C <dir>] commit [flags] -m '<message>'. Run staging ('git add …') or any other command (including if/then, loops and command substitutions) as its own earlier Bash call, then commit alone." >&2
  exit 2
fi

# Layer 2 — the message must be the FINAL token: a quoted -m/--message value
# or `-F <file>` at end-of-string, or no message flag at all (--amend
# --no-edit …). Trailing flags or commands after the message (`-m x -a`,
# `-m x && git push`) are therefore structurally impossible, and message TEXT
# is never scanned — a message may freely quote commands like `git add`.
dq='"[^"]*"'
sq="'[^']*'"
msg_terminal_re="-m[[:space:]]+($dq|$sq)[[:space:]]*\$|--message=($dq|$sq)[[:space:]]*\$|-F[[:space:]]+[^-[:space:]][^[:space:]]*[[:space:]]*\$"
has_msg_flag=0
printf '%s' "$flat" | grep -Eq -- '[[:space:]](-m|--message(=|[[:space:]])|-F)' && has_msg_flag=1
if [ "$has_msg_flag" = 1 ] && ! printf '%s' "$flat" | grep -Eq -- "$msg_terminal_re"; then
  echo "[codex-review-gate] the commit message must end the command: finish with -m '<message>' (single- or double-quoted; --message=\"…\" and -F <file> also work — not '-F -'). Quotes of the other type are fine inside the message. Flags after the message or chained commands are rejected." >&2
  exit 2
fi

# Layer 3 — strip exactly the terminal message that layer 2 anchored at the
# end of the command (never "everything after the first -m": a second message
# flag could otherwise smuggle tokens between two -m values, e.g.
# `-m 'a' -a -m 'b'`), then require every remaining token after `commit` to be
# a flag on the plain-commit allowlist: no staging flags (-a/-i/-p/--all/
# --include/--interactive/--patch), no pathspecs, no bare tokens, no unknown
# options, no extra message flags. Value-taking options must use their `=`
# form (e.g. --reuse-message=HEAD); exactly one terminal message is allowed.
# Attached-value short forms (-mfeat, -F-) and unquoted -m values are rejected
# by layer 2 — use the spaced, quoted form `-m 'feat'`. This is fail-closed
# (a valid commit is blocked, never an unreviewed one waved through).
# This is NOT "truncate at the first -m": the substitution is $-anchored to
# the one terminal message layer 2 verified, and it is a single expression —
# separate expressions would run in sequence and strip a second message-ish
# token once the first removal exposes it at $. Inner/extra -m, --message or
# -F tokens survive into the token loop below and are rejected there, so
# `git commit -m a -a -m b` and `git commit -m x --all` both fail (see
# tests/gate-test.sh for the full case matrix).
body=$(printf '%s' "$flat" | sed -E "s/(-m[[:space:]]+($dq|$sq)|--message=($dq|$sq)|-F[[:space:]]+[^-[:space:]][^[:space:]]*)[[:space:]]*\$//")
middle=${body#* commit}
case "$middle" in "$body") middle="" ;; esac
set -f
for tok in $middle; do
  case "$tok" in
    --amend|--no-edit|--edit|-e|--signoff|-s|--no-signoff|--quiet|-q|--verbose|-v|\
    --allow-empty|--allow-empty-message|--no-gpg-sign|-S*|--gpg-sign|--gpg-sign=*|\
    --author=*|--date=*|--cleanup=*|--trailer=*|--reuse-message=*|--reedit-message=*|\
    --fixup=*|--squash=*|--dry-run) ;;
    --no-verify|-n)
      set +f
      echo "[codex-review-gate] '--no-verify' (a.k.a. '-n') is a human-only override and is not honored for commits run through Claude Code — the model cannot bypass its own review gate. A human may bypass by launching Claude Code with CODEX_GATE_BYPASS=1 in the environment, or by committing from a real terminal." >&2
      exit 2
      ;;
    *)
      set +f
      echo "[codex-review-gate] commit flag or argument '$tok' is not on the gate's plain-commit allowlist (staging flags, pathspecs and unknown options are rejected). Stage content with 'git add …' in a separate Bash call; value-taking options need their = form (e.g. --reuse-message=HEAD)." >&2
      exit 2
      ;;
  esac
done
set +f

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

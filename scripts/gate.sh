#!/bin/sh
# codex-review plugin helper — detect and install the git pre-commit gate.
#
#   gate.sh hook      SessionStart hook: emit a notice when the gate is not active (read-only)
#   gate.sh check     print the gate state and the install plan (read-only)
#   gate.sh install   install or upgrade the gate in the current repository (writes)
#
# Needs only git and a POSIX shell. `install` fails closed: it never repoints an
# existing core.hooksPath, never overwrites a pre-commit hook it did not write,
# and never silently disables hooks that are active in the current hooks dir.
#
# Exit codes: 0 ok, 1 error, 2 refused (conflict or missing codex; nothing written).
# Opt out of the session-start notice: git config codex-review.skipInit true

plugin_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
gate_src="$plugin_root/hooks/pre-commit"
# Second line of every released hooks/pre-commit; identifies a gate we wrote.
marker='# codex-review gate'
nl='
'

# Resolve the gate state of the repository containing the cwd. Sets: state
# (not-git|installed|differs|missing|conflict), top, codex_ok, plan,
# conflicts, and the needs_* flags. Changes the cwd to the work-tree root.
detect() {
  state='' plan='' conflicts=''
  needs_config=0 needs_file=0 needs_upgrade=0 needs_chmod=0
  codex_ok=0
  command -v codex >/dev/null 2>&1 && codex_ok=1

  top=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$top" ] || ! cd "$top" 2>/dev/null; then
    state=not-git
    return
  fi

  hooks_path=$(git config --get core.hooksPath)
  case $hooks_path in
    .githooks | .githooks/ | ./.githooks | ./.githooks/ | "$top/.githooks" | "$top/.githooks/") ;;
    '')
      needs_config=1
      plan="$plan  - set core.hooksPath=.githooks (local git config)$nl"
      # Setting core.hooksPath makes git stop running the default hooks dir.
      default_dir=$(git rev-parse --git-path hooks)
      active=''
      for f in "$default_dir"/*; do
        [ -f "$f" ] || continue
        case $f in *.sample) continue ;; esac
        active="$active ${f##*/}"
      done
      [ -n "$active" ] &&
        conflicts="$conflicts  - $default_dir has active hooks that would stop running once core.hooksPath is set:$active$nl"
      extra=''
      for f in .githooks/*; do
        [ -f "$f" ] || continue
        [ "${f##*/}" = pre-commit ] && continue
        extra="$extra ${f##*/}"
      done
      [ -n "$extra" ] &&
        plan="$plan  - note: this also activates the other hooks already in .githooks/:$extra$nl"
      ;;
    *)
      conflicts="$conflicts  - core.hooksPath is already set to '$hooks_path'; pointing it at .githooks would stop those hooks from running$nl"
      ;;
  esac

  hook=.githooks/pre-commit
  if [ -L "$hook" ]; then
    conflicts="$conflicts  - $hook is a symlink; resolve it by hand$nl"
  elif [ -e "$hook" ]; then
    if ! [ -f "$hook" ] || ! grep -q "^$marker" "$hook"; then
      conflicts="$conflicts  - $hook already exists and is not the codex-review gate$nl"
    elif ! cmp -s "$gate_src" "$hook"; then
      needs_upgrade=1
      plan="$plan  - replace $hook with the plugin's version (it differs: an older or newer release, or a local edit)$nl"
    elif ! [ -x "$hook" ]; then
      needs_chmod=1
      plan="$plan  - make $hook executable$nl"
    fi
  else
    needs_file=1
    plan="$plan  - create $hook (copy of the plugin's hooks/pre-commit)$nl"
  fi

  # Only writes are dangerous: a gate already in place behind a symlink is fine.
  if [ "$needs_file$needs_upgrade$needs_chmod" != 000 ]; then
    if [ -L .githooks ]; then
      conflicts="$conflicts  - .githooks is a symlink; writing the gate through it could modify files outside the repository$nl"
    elif [ -e .githooks ] && ! [ -d .githooks ]; then
      conflicts="$conflicts  - .githooks exists and is not a directory$nl"
    fi
  fi

  if [ -n "$conflicts" ]; then
    state=conflict
  elif [ -z "$plan" ]; then
    state=installed
  elif [ "$needs_upgrade" = 1 ]; then
    # Any replacement must go through the diff review, even when
    # core.hooksPath also needs setting (e.g. a fresh clone with a local edit).
    state=differs
  else
    state=missing
  fi
}

# Run codex outside the repository; codex inside a trusted project can touch
# the repo state (see hooks/pre-commit).
codex_isolated() {
  (cd "${TMPDIR:-/tmp}" 2>/dev/null || cd /; codex "$@")
}

# Describe how codex authenticates. `codex login status` only covers codex's
# own login (ChatGPT sign-in or a stored API key), so an API key in the
# environment and a custom top-level model_provider count as well.
codex_auth() {
  if codex_isolated login status >/dev/null 2>&1; then
    echo "logged in (codex login status)"
    return
  fi
  if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ]; then
    echo "API key from the environment"
    return
  fi
  config="${CODEX_HOME:-$HOME/.codex}/config.toml"
  # Top-level keys end at the first [table] header; \042 and \047 are quotes.
  provider=$(awk '
    /^[[:space:]]*\[/ { exit }
    /^[[:space:]]*model_provider[[:space:]]*=/ {
      sub(/^[^=]*=[[:space:]]*/, ""); sub(/[[:space:]]*#.*$/, "")
      gsub(/[\042\047[:space:]]/, ""); print; exit
    }' "$config" 2>/dev/null)
  if [ -n "$provider" ] && [ "$provider" != openai ]; then
    echo "custom model_provider in $config"
    return
  fi
  echo "NOT verified; found no codex login, API key, or custom model_provider. Run 'codex login' unless codex authenticates another way"
}

# Emit SessionStart JSON. Arguments must be static text without '"' or '\'.
emit() {
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$1" "$2"
}

run_hook() {
  cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
  [ "$(git config --bool --get codex-review.skipInit 2>/dev/null)" = true ] && exit 0
  detect
  silence="If the user is not interested, suggest 'git config codex-review.skipInit true' (or --global) to stop this notice."
  codex_note=''
  [ "$codex_ok" = 1 ] ||
    codex_note=" Note that the codex CLI is not on PATH; it must be installed and authenticated first (npm install -g @openai/codex, then codex login or an API key)."
  inactive_note=''
  [ "$needs_config" = 1 ] &&
    inactive_note=" The gate is also not activated in this clone yet (core.hooksPath is not set)."
  case $state in
    missing)
      emit "codex-review: the Codex commit gate is not active in this repository. Run /codex-review:init to set it up, or 'git config codex-review.skipInit true' to hide this notice." \
        "[codex-review plugin] This git repository does not have the Codex pre-commit review gate active (not installed, or installed but not activated in this clone). At a natural point early in the session, without derailing the user's request, mention this once and offer to set it up with the /codex-review:init skill. Install nothing unless the user explicitly agrees. $silence$codex_note"
      ;;
    differs)
      emit "codex-review: this repository's Codex commit gate differs from the plugin's version. Run /codex-review:init to compare them." \
        "[codex-review plugin] This repository's .githooks/pre-commit Codex gate differs from the version bundled with the plugin (an older or newer release, or a local edit). At a natural point early in the session, mention this once and offer to show the difference with the /codex-review:init skill; replace it only if the plugin's version is the one the user wants.$inactive_note Change nothing unless the user explicitly agrees. $silence$codex_note"
      ;;
    conflict)
      emit "codex-review: the Codex commit gate is not installed, and this repository's existing git hooks need a manual decision. Run /codex-review:init for details." \
        "[codex-review plugin] The Codex pre-commit gate is not installed in this repository, and it cannot be installed automatically because the repository already has its own git hooks setup (core.hooksPath or existing hooks). At a natural point early in the session, mention this once; the /codex-review:init skill explains the conflict. Never repoint core.hooksPath, or overwrite or move existing hooks, without the user's explicit instruction. $silence$codex_note"
      ;;
  esac
  exit 0
}

run_check() {
  detect
  echo "state: $state"
  [ "$state" = not-git ] && exit 0
  echo "repository: $top"
  if [ "$codex_ok" = 1 ]; then
    echo "codex: $(codex_isolated --version 2>/dev/null | head -n 1)"
    echo "codex auth: $(codex_auth)"
  else
    echo "codex: NOT FOUND on PATH; install with 'npm install -g @openai/codex', then run 'codex login'"
  fi
  [ -n "$plan" ] && printf 'plan:\n%s' "$plan"
  [ -n "$conflicts" ] && printf 'conflicts:\n%s' "$conflicts"
  exit 0
}

run_install() {
  detect
  case $state in
    not-git)
      echo "codex-review: not inside a git work tree; nothing installed." >&2
      exit 2
      ;;
    conflict)
      printf 'codex-review: refusing to install; nothing was written. Conflicts:\n%s' "$conflicts" >&2
      exit 2
      ;;
    installed)
      echo "codex-review: the gate is already installed and up to date in $top."
      exit 0
      ;;
  esac
  if [ "$codex_ok" != 1 ]; then
    echo "codex-review: codex CLI not found on PATH; refusing to install a fail-closed gate that would block every commit. Nothing was written." >&2
    exit 2
  fi
  if ! [ -f "$gate_src" ]; then
    echo "codex-review: bundled gate not found at $gate_src" >&2
    exit 1
  fi

  if [ "$needs_file" = 1 ] || [ "$needs_upgrade" = 1 ]; then
    # Write to a temp file and rename, so a failure never leaves a partial hook.
    tmp=".githooks/.pre-commit.tmp.$$"
    if ! { mkdir -p .githooks && cp "$gate_src" "$tmp" && chmod +x "$tmp" && mv -f "$tmp" .githooks/pre-commit; }; then
      rm -f "$tmp"
      echo "codex-review: failed to write .githooks/pre-commit" >&2
      exit 1
    fi
    echo "wrote .githooks/pre-commit"
  elif [ "$needs_chmod" = 1 ]; then
    chmod +x .githooks/pre-commit || exit 1
    echo "made .githooks/pre-commit executable"
  fi
  if [ "$needs_config" = 1 ]; then
    git config --local core.hooksPath .githooks || exit 1
    echo "set core.hooksPath=.githooks (local git config)"
  fi

  detect
  if [ "$state" != installed ]; then
    echo "codex-review: post-install check failed (state: $state)" >&2
    exit 1
  fi
  echo "codex-review: gate installed in $top."
  exit 0
}

case ${1:-} in
  hook) run_hook ;;
  check) run_check ;;
  install) run_install ;;
  *)
    echo "usage: gate.sh hook|check|install" >&2
    exit 1
    ;;
esac

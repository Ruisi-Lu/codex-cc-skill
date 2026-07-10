#!/bin/sh
# Test matrix for hooks/codex-commit-gate.sh (PreToolUse variant, v3 allowlist).
set -u
HOOK="$(cd "$(dirname "$0")/.." && pwd)/hooks/codex-commit-gate.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/codex" <<'FAKE'
#!/bin/sh
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out=$a; prev=$a; done
echo "invoked" >> "${FAKE_LOG:?}"
[ -n "$out" ] && printf '%s\n' "${FAKE_VERDICT:-ALLOW: fake ok}" > "$out"
exit 0
FAKE
chmod +x "$WORK/bin/codex"
export PATH="$WORK/bin:$PATH"
export FAKE_LOG="$WORK/codex.log"; : > "$FAKE_LOG"

mk_repo() {
  R="$WORK/$1"; mkdir -p "$R"; cd "$R" || exit 9
  git init -q -b main .; git config user.email t@t; git config user.name t
  echo base > base.txt; git add base.txt; git commit -qm base
  cd / || exit 9
}
mk_repo clean
mk_repo dirty;  echo change >> "$WORK/dirty/base.txt"
mk_repo staged; echo change >> "$WORK/staged/base.txt"; git -C "$WORK/staged" add base.txt

run_case() { # name want_exit cwd cmd [want_codex] [verdict]
  name=$1; want=$2; cwd=$3; cmd=$4; want_codex=${5:-no}; export FAKE_VERDICT="${6:-ALLOW: fake ok}"
  before=$(wc -l < "$FAKE_LOG")
  payload=$(python3 -c 'import json,sys; print(json.dumps({"tool_input":{"command":sys.argv[1]},"cwd":sys.argv[2]}))' "$cmd" "$cwd")
  err=$(printf '%s' "$payload" | "$HOOK" 2>&1 >/dev/null); got=$?
  after=$(wc -l < "$FAKE_LOG")
  codex_ran=no; [ "$after" -gt "$before" ] && codex_ran=yes
  status=PASS
  [ "$got" -eq "$want" ] || status="FAIL(exit $got want $want)"
  [ "$codex_ran" = "$want_codex" ] || status="$status FAIL(codex=$codex_ran want $want_codex)"
  printf '%-52s %s\n' "$name" "$status"
  case "$status" in *FAIL*) echo "    stderr: $err" | head -3; GLOBAL_FAIL=1;; esac
}
GLOBAL_FAIL=0
C="$WORK/clean"; D="$WORK/dirty"; S="$WORK/staged"

# 1. non-commit commands untouched
run_case "non-git cmd"                         0 "$C" "ls -la"
run_case "git add alone"                       0 "$D" "git add base.txt"
run_case "echo mentions commit"                0 "$C" "echo commit"
run_case "git log --grep=commit"               0 "$C" "git log --grep=commit"
# 2. layer 1: call must BE the commit
run_case "add && commit"                       2 "$D" "git add base.txt && git commit -m 'x'"
run_case "add && commit (staged too)"          2 "$S" "git add other && git commit -m 'x'"
run_case "rm && commit"                        2 "$D" "git rm -q base.txt && git commit -m 'x'"
run_case "semicolon add; commit"               2 "$D" "git add -A; git commit -m 'x'"
run_case "stash pop && commit"                 2 "$D" "git stash pop && git commit -m 'x'"
run_case "VAR=x prefix"                        2 "$S" "GIT_AUTHOR_NAME=x git commit -m 'x'"
run_case "env prefix"                          2 "$S" "env git commit -m 'x'"
run_case "command prefix"                      2 "$S" "command git commit -m 'x'"
run_case "sudo -n add && commit"               2 "$D" "sudo -n git add base.txt && git commit -m 'x'"
run_case "cd && commit"                        2 "$S" "cd $S && git commit -m 'x'"
# 3. layer 2: message must terminate the command
run_case "unquoted -m x"                       2 "$S" "git commit -m x"
run_case "-m 'x' -a (post-message flag)"       2 "$S" "git commit -m 'x' -a"
run_case "-m 'x' && git push"                  2 "$S" "git commit -m 'x' && git push"
run_case "pathspec after message"              2 "$D" "git commit -m 'x' base.txt"
run_case "-F - (stdin message)"                2 "$S" "git commit -F -"
# 4. layer 3: flag allowlist
run_case "commit -am"                          2 "$D" "git commit -am 'x'"
run_case "commit -a -m"                        2 "$D" "git commit -a -m 'x'"
run_case "commit -p"                           2 "$S" "git commit -p"
run_case "commit -i path"                      2 "$D" "git commit -i base.txt -m 'x'"
run_case "commit -s -p (late)"                 2 "$S" "git commit -s -p"
run_case "commit -pm"                          2 "$D" "git commit -pm 'x'"
run_case "commit --all"                        2 "$D" "git commit --all -m 'x'"
run_case "commit --patch"                      2 "$D" "git commit --patch"
run_case "pathspec before message"             2 "$D" "git commit base.txt -m 'x'"
run_case "-C HEAD space form rejected"         2 "$S" "git commit -C HEAD"
# 5. allowed shapes -> review or clean-allow
run_case "plain commit (staged) ALLOW"         0 "$S" "git commit -m 'x'" yes "ALLOW: fine"
run_case "plain commit (staged) BLOCK"         2 "$S" "git commit -m 'x'" yes "BLOCK: bad"
run_case "double-quoted msg w/ inner sq"       0 "$S" "git commit -m \"he said 'hi'\"" yes
run_case "git -C dir commit"                   0 "$S" "git -C $S commit -m 'x'" yes
run_case "--amend --no-edit (staged)"          0 "$S" "git commit --amend --no-edit" yes
run_case "-s -m (staged)"                      0 "$S" "git commit -s -m 'x'" yes
run_case "--reuse-message=HEAD (staged)"       0 "$S" "git commit --reuse-message=HEAD" yes
run_case "--fixup=HEAD (staged)"               0 "$S" "git commit --fixup=HEAD" yes
run_case "double -m paragraphs rejected"       2 "$S" "git commit -m 'a' -m 'b'"
run_case "-m 'a' -a -m 'b' smuggle rejected"   2 "$S" "git commit -m 'a' -a -m 'b'"
run_case "-F file -m 'x' extra msg rejected"   2 "$S" "git commit -F f1 -m 'x'"
run_case "msg text mentions --patch (clean)"   0 "$C" "git commit -m 'docs: describe --patch usage'"
run_case "msg text mentions --all (staged)"    0 "$S" "git commit -m 'support --all flag'" yes
run_case "--allow-empty (clean tree)"          0 "$C" "git commit --allow-empty -m 'x'"
# 6. empty-index / dirty-tree
run_case "bare commit, clean tree"             0 "$C" "git commit -m 'x'"
run_case "bare commit, dirty tree"             2 "$D" "git commit -m 'x'"
# 7. bypasses still work
run_case "bypass env inline"                   0 "$D" "CODEX_GATE_BYPASS=1 git add x && git commit -m 'x'"
run_case "bypass --no-verify"                  0 "$D" "git add x && git commit -m 'x' --no-verify"
# 8. multi-line -m message text (v1 live false positive regression)
ML_CMD='git commit -m "fix(hooks): reject commit shapes

git add X && git commit in one Bash call bypassed review because the
PreToolUse hook runs before the command and saw an empty index.
git rm / git mv combos are rejected too."'
run_case "multi-line msg text (staged)"        0 "$S" "$ML_CMD" yes
run_case "multi-line msg text (clean)"         0 "$C" "$ML_CMD"
run_case "real combo + multi-line msg"         2 "$D" "git add base.txt && $ML_CMD"
run_case "-am + multi-line msg"                2 "$D" "git commit -am \"x
git add y\""

# 10. shell-wrapped commits must fail CLOSED (2026-07-11 codex exploit class)
run_case "if;then git commit;fi"               2 "$S" "if true; then git commit -m 'x'; fi"
run_case "while;do git commit;done"            2 "$S" "while read x; do git commit -m 'y'; done"
run_case "backtick git commit"                 2 "$S" "\`git commit -m 'x'\`"
run_case "dollar-paren git commit"             2 "$S" "\$(git commit -m 'x')"
run_case "brace-group git commit"              2 "$S" "{ git commit -m 'x'; }"
run_case "pipe into git commit"                2 "$S" "true | git commit -m 'x'"
run_case "xargs git commit"                    2 "$D" "echo x | xargs -I{} git commit -m 'x'"
run_case "subshell paren git commit"           2 "$S" "(git commit -m 'x')"
run_case "else-branch git commit"              2 "$S" "if false; then true; else git commit -m 'x'; fi"
# 11. must-NOT-detect: git/commit only as data, no real commit
run_case "grep quoted git commit"              0 "$C" "grep -r \"git commit\" ."
run_case "echo unquoted git commit-tree"       0 "$C" "git commit-tree -h"
run_case "git show commit sha"                 0 "$C" "git show abc123"

echo "----"
if [ "$GLOBAL_FAIL" -eq 0 ]; then echo "ALL PASS"; else echo "FAILURES PRESENT"; exit 1; fi

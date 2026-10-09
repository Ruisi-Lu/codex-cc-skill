// Behavioral tests for hooks/pre-commit, run by real `git commit`s in throwaway
// repositories against a stubbed codex (no real codex call).
// Run with: bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GATE_SRC = join(ROOT, "hooks", "pre-commit");

// Records how it was called into $FAKE_CODEX_DIR, then acts per $FAKE_CODEX_MODE.
const STUB = `#!/bin/sh
printf '%s\\n' "$@" >"$FAKE_CODEX_DIR/args"
env >"$FAKE_CODEX_DIR/env"
cat >"$FAKE_CODEX_DIR/stdin"
out=''
while [ $# -gt 0 ]; do
  [ "$1" = -o ] && { out=$2; shift; }
  shift
done
case $FAKE_CODEX_MODE in
  allow) printf 'ALLOW: looks fine\\n' >"$out" ;;
  block) printf 'BLOCK: off-by-one\\nsrc.txt:1 — problem — fix\\n' >"$out" ;;
  allow-then-fail) printf 'ALLOW: looks fine\\n' >"$out"; echo "error: stream closed before completion" >&2; exit 1 ;;
  silent) ;;
  fail) echo "error: unexpected argument '--ephemeral' found" >&2; exit 2 ;;
  hang) echo "stream disconnected; retrying" >&2; exec sleep 5 ;;
esac
`;

// Wraps the real git; FAKE_GIT_DIFF=fail|empty breaks the hook's diff capture
// (`git diff --cached` without --quiet), FAKE_GIT_MERGE_TREE=fail fails
// `git merge-tree` like a git too old for it, and every other call is left alone.
const gitWrapper = (realGit: string) => `#!/bin/sh
if [ "$1 $2" = "diff --cached" ]; then
  case " $* " in
    *" --quiet "*) ;;
    *)
      case $FAKE_GIT_DIFF in
        fail) echo "fatal: simulated diff failure" >&2; exit 128 ;;
        empty) exit 0 ;;
      esac
      ;;
  esac
fi
if [ "$1" = merge-tree ] && [ "$FAKE_GIT_MERGE_TREE" = fail ]; then
  echo "error: unknown option \\\`write-tree'" >&2; exit 129
fi
exec "${realGit}" "$@"
`;

// The hook recomputes git's own merge/cherry-pick/revert result with
// `git merge-tree --write-tree --merge-base`, which needs git 2.40 or newer.
const [gitMajor, gitMinor] = (Bun.spawnSync(["git", "--version"]).stdout.toString().match(/(\d+)\.(\d+)/) ?? [])
  .slice(1)
  .map(Number);
const hasMergeTreeBase = gitMajor > 2 || (gitMajor === 2 && gitMinor >= 40);

let scratch: string;
let pathWithCodex: string;
let pathWithoutCodex: string;
let pathWithGitWrapper: string;
let seq = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "codex-precommit-test-"));
  const fakeBin = join(scratch, "bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "codex"), STUB);
  chmodSync(join(fakeBin, "codex"), 0o755);
  // Keep git and coreutils, drop any directory that holds a real codex.
  pathWithoutCodex = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir && !existsSync(join(dir, "codex")))
    .join(delimiter);
  pathWithCodex = [fakeBin, pathWithoutCodex].join(delimiter);
  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git not found on PATH");
  const gitBin = join(scratch, "gitbin");
  mkdirSync(gitBin);
  writeFileSync(join(gitBin, "git"), gitWrapper(realGit));
  chmodSync(join(gitBin, "git"), 0o755);
  pathWithGitWrapper = [gitBin, pathWithCodex].join(delimiter);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function env(codex: boolean, extra: Record<string, string> = {}): Record<string, string> {
  // Isolate from the developer's git and codex config.
  return {
    ...extra,
    PATH: codex ? pathWithCodex : pathWithoutCodex,
    HOME: scratch,
    TMPDIR: scratch,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: env(true) });
  return p.stdout.toString().trim();
}

function installGate(repo: string) {
  mkdirSync(join(repo, ".githooks"), { recursive: true });
  copyFileSync(GATE_SRC, join(repo, ".githooks", "pre-commit"));
  chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
  git(repo, "config", "core.hooksPath", ".githooks");
}

// A repository with the gate active and one file staged.
function stagedRepo(): string {
  const repo = join(scratch, `repo-${++seq}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  installGate(repo);
  writeFileSync(join(repo, "src.txt"), "hello\n");
  git(repo, "add", "src.txt");
  return repo;
}

// Writes and commits files; used to build history before the gate is installed.
function commitFiles(repo: string, msg: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
  git(repo, "add", ...Object.keys(files));
  git(repo, "commit", "-q", "-m", msg);
}

// A repository with the gate active on main. `feature` rewrote a.txt (which
// main also rewrote, so it conflicts) and added c.txt; `side` and `side2`
// each add one file and merge cleanly.
function branchedRepo(): string {
  const repo = join(scratch, `repo-${++seq}`);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  commitFiles(repo, "base", { "a.txt": "base\n" });
  git(repo, "checkout", "-q", "-b", "feature");
  commitFiles(repo, "feature", { "a.txt": "feature\n", "c.txt": "incoming\n" });
  git(repo, "checkout", "-q", "-b", "side", "main");
  commitFiles(repo, "side", { "s.txt": "side\n" });
  git(repo, "checkout", "-q", "-b", "side2", "main");
  commitFiles(repo, "side2", { "s2.txt": "side2\n" });
  git(repo, "checkout", "-q", "main");
  commitFiles(repo, "main", { "a.txt": "main\n" });
  installGate(repo);
  return repo;
}

// Settles the conflict in a.txt by hand.
function resolve(repo: string) {
  writeFileSync(join(repo, "a.txt"), "resolved\n");
  git(repo, "add", "a.txt");
}

type Commit = { code: number; err: string; committed: boolean; calls: string };

function commit(repo: string, opts: { codex?: boolean; extra?: Record<string, string>; args?: string[] } = {}): Commit {
  const calls = mkdtempSync(join(scratch, "calls-"));
  const p = Bun.spawnSync(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "test", ...(opts.args ?? [])],
    { cwd: repo, env: env(opts.codex ?? true, { FAKE_CODEX_DIR: calls, ...opts.extra }) },
  );
  const committed = git(repo, "rev-parse", "-q", "--verify", "HEAD") !== "";
  return { code: p.exitCode, err: p.stderr.toString(), committed, calls };
}

// Runs the hook directly rather than through `git commit`, because git puts its
// own exec-path first on a hook's PATH, which would bypass the git wrapper.
function runHookWithGitWrapper(repo: string, fakes: Record<string, string>): Commit {
  const calls = mkdtempSync(join(scratch, "calls-"));
  const p = Bun.spawnSync(["sh", join(repo, ".githooks", "pre-commit")], {
    cwd: repo,
    env: {
      ...env(true, { FAKE_CODEX_DIR: calls, FAKE_CODEX_MODE: "allow", ...fakes }),
      PATH: pathWithGitWrapper,
    },
  });
  return { code: p.exitCode, err: p.stderr.toString(), committed: false, calls };
}

const called = (c: Commit) => existsSync(join(c.calls, "args"));
const callArgs = (c: Commit) => readFileSync(join(c.calls, "args"), "utf8").split("\n");
const callStdin = (c: Commit) => readFileSync(join(c.calls, "stdin"), "utf8");

describe("verdicts", () => {
  test("ALLOW lets the commit through; codex runs isolated, read-only and ephemeral", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    expect(c.committed).toBe(true);
    const args = callArgs(c);
    expect(args.slice(0, 2)).toEqual(["exec", expect.stringContaining("pre-commit code review gate")]);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--skip-git-repo-check");
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual(["-s", "read-only"]);
    const cd = args[args.indexOf("-C") + 1];
    expect(cd.startsWith(scratch)).toBe(true);
    expect(cd.startsWith(repo)).toBe(false);
    // No git handle on the repository reaches codex.
    expect(readFileSync(join(c.calls, "env"), "utf8")).not.toMatch(/^GIT_/m);
    // The staged diff arrives on stdin.
    const stdin = readFileSync(join(c.calls, "stdin"), "utf8");
    expect(stdin).toContain("+++ b/src.txt");
    expect(stdin).toContain("+hello");
  });

  test("a textconv filter can neither hide a staged change nor rewrite what is reviewed", () => {
    const repo = join(scratch, `repo-${++seq}`);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    // Both versions of a.bin convert to the same text.
    git(repo, "config", "diff.same.textconv", "sh -c 'echo same' --");
    commitFiles(repo, "base", { ".gitattributes": "*.bin diff=same\n", "a.bin": "one\n" });
    installGate(repo);
    writeFileSync(join(repo, "a.bin"), "two\n");
    git(repo, "add", "a.bin");
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    expect(called(c)).toBe(true);
    const stdin = callStdin(c);
    expect(stdin).toContain("-one");
    expect(stdin).toContain("+two");
    expect(stdin).not.toContain("same");
  });

  test("a submodule ignore setting can't hide a staged submodule change", () => {
    const sub = join(scratch, `sub-${++seq}`);
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    git(sub, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "s1");
    const repo = join(scratch, `repo-${++seq}`);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    git(repo, "config", "-f", ".gitmodules", "submodule.sub.ignore", "all");
    git(repo, "add", ".gitmodules");
    git(repo, "commit", "-q", "-m", "add sub");
    installGate(repo);
    git(join(repo, "sub"), "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "s2");
    git(repo, "add", "--force", "sub");
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    expect(called(c)).toBe(true);
    expect(callStdin(c)).toContain("+Subproject commit");
  });

  test("the captured diff is plain, whatever diff.external and color settings say", () => {
    const repo = stagedRepo();
    git(repo, "config", "diff.external", "echo EXTERNAL-DIFF");
    git(repo, "config", "color.ui", "always");
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    const stdin = readFileSync(join(c.calls, "stdin"), "utf8");
    expect(stdin).toContain("+hello");
    expect(stdin).not.toContain("EXTERNAL-DIFF");
    expect(stdin).not.toContain("\x1b[");
  });

  test("BLOCK stops the commit and shows the findings", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "block" } });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("commit blocked");
    expect(c.err).toContain("BLOCK: off-by-one");
    expect(c.err).toContain("src.txt:1 — problem — fix");
  });
});

describe("failures fail closed and say why", () => {
  test("codex's own error is shown when it produces no verdict", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "fail" } });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("codex exited with status 2");
    expect(c.err).toContain("error: unexpected argument '--ephemeral' found");
  });

  test("an ALLOW verdict from a codex that then fails is ignored", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow-then-fail" } });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("codex exited with status 1, so any verdict it wrote is ignored");
    expect(c.err).toContain("error: stream closed before completion");
  });

  test("a codex that exits 0 without a verdict blocks", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "silent" } });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("codex wrote no review verdict");
  });

  test("a failed diff capture blocks without calling codex", () => {
    const c = runHookWithGitWrapper(stagedRepo(), { FAKE_GIT_DIFF: "fail" });
    expect(c.code).toBe(1);
    expect(c.err).toContain("could not capture the staged diff");
    expect(called(c)).toBe(false);
  });

  test("an empty diff capture blocks without calling codex", () => {
    const c = runHookWithGitWrapper(stagedRepo(), { FAKE_GIT_DIFF: "empty" });
    expect(c.code).toBe(1);
    expect(c.err).toContain("could not capture the staged diff");
    expect(called(c)).toBe(false);
  });

  test("the git wrapper leaves a healthy capture alone", () => {
    const c = runHookWithGitWrapper(stagedRepo(), {});
    expect(c.code).toBe(0);
    expect(called(c)).toBe(true);
  });

  test.skipIf(!Bun.which("timeout"))("a timeout is reported as a timeout, with codex's output so far", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "hang", CODEX_GATE_TIMEOUT: "1" } });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("codex timed out after 1s");
    expect(c.err).toContain("stream disconnected; retrying");
  });

  test("a missing codex blocks the commit", () => {
    const repo = stagedRepo();
    const c = commit(repo, { codex: false });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("codex CLI not found");
  });
});

describe("skips", () => {
  test("CODEX_GATE_BYPASS=1 commits without calling codex", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { CODEX_GATE_BYPASS: "1" } });
    expect(c.code).toBe(0);
    expect(c.committed).toBe(true);
    expect(called(c)).toBe(false);
  });

  test("nothing staged commits without calling codex", () => {
    const repo = stagedRepo();
    git(repo, "rm", "-q", "--cached", "src.txt");
    const c = commit(repo, { args: ["--allow-empty"] });
    expect(c.code).toBe(0);
    expect(c.committed).toBe(true);
    expect(called(c)).toBe(false);
  });
});

describe.skipIf(!hasMergeTreeBase)("merge, cherry-pick and revert", () => {
  const head = (repo: string) => git(repo, "rev-parse", "HEAD");
  const reviewsResolutionOnly = (c: Commit, op: string) => {
    expect(called(c)).toBe(true);
    expect(callArgs(c)[1]).toContain(`This commit concludes a ${op}.`);
    const stdin = callStdin(c);
    expect(stdin).toContain("-<<<<<<<");
    expect(stdin).toContain("+resolved");
    // What was brought in, rather than written while resolving, is not re-reviewed.
    expect(stdin).not.toContain("incoming");
  };

  test("a resolved merge conflict is reviewed, without the merged-in changes", () => {
    const repo = branchedRepo();
    git(repo, "merge", "feature");
    resolve(repo);
    const before = head(repo);
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    expect(head(repo)).not.toBe(before);
    reviewsResolutionOnly(c, "merge");
  });

  test("a BLOCK on the resolution stops the merge commit", () => {
    const repo = branchedRepo();
    git(repo, "merge", "feature");
    resolve(repo);
    const before = head(repo);
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "block" } });
    expect(c.code).not.toBe(0);
    expect(head(repo)).toBe(before);
    expect(c.err).toContain("BLOCK: off-by-one");
  });

  test("a merge identical to git's own result commits without calling codex", () => {
    const repo = branchedRepo();
    git(repo, "merge", "--no-commit", "--no-ff", "side");
    const before = head(repo);
    const c = commit(repo);
    expect(c.code).toBe(0);
    expect(head(repo)).not.toBe(before);
    expect(called(c)).toBe(false);
  });

  test("edits staged on top of a clean merge are reviewed", () => {
    const repo = branchedRepo();
    git(repo, "merge", "--no-commit", "--no-ff", "side");
    writeFileSync(join(repo, "extra.txt"), "smuggled\n");
    git(repo, "add", "extra.txt");
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    expect(called(c)).toBe(true);
    const stdin = callStdin(c);
    expect(stdin).toContain("+smuggled");
    expect(stdin).not.toContain("+side");
  });

  test("an octopus merge is reviewed in full", () => {
    const repo = branchedRepo();
    git(repo, "merge", "--no-commit", "--no-ff", "side", "side2");
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    expect(callArgs(c)[1]).toContain("Review ONLY the staged diff");
    const stdin = callStdin(c);
    expect(stdin).toContain("+side\n");
    expect(stdin).toContain("+side2\n");
  });

  test("a resolved cherry-pick conflict is reviewed, without the picked changes", () => {
    const repo = branchedRepo();
    git(repo, "cherry-pick", "feature");
    resolve(repo);
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    reviewsResolutionOnly(c, "cherry-pick");
  });

  test("a resolved revert conflict is reviewed, without the reverted changes", () => {
    const repo = branchedRepo();
    git(repo, "checkout", "-q", "feature");
    // Rewrite a.txt again so reverting `feature` conflicts; c.txt reverts cleanly.
    writeFileSync(join(repo, "a.txt"), "later\n");
    git(repo, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", "later");
    git(repo, "revert", "--no-edit", "HEAD~1");
    resolve(repo);
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "allow" } });
    expect(c.code).toBe(0);
    reviewsResolutionOnly(c, "revert");
  });

  test("when git's own result can't be recomputed, the whole staged diff is reviewed", () => {
    const repo = branchedRepo();
    git(repo, "merge", "feature");
    resolve(repo);
    const c = runHookWithGitWrapper(repo, { FAKE_GIT_MERGE_TREE: "fail" });
    expect(c.code).toBe(0);
    expect(callArgs(c)[1]).toContain("Review ONLY the staged diff");
    const stdin = callStdin(c);
    expect(stdin).toContain("+resolved");
    expect(stdin).toContain("+incoming");
  });
});

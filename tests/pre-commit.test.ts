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
  fail) echo "error: unexpected argument '--ephemeral' found" >&2; exit 2 ;;
  hang) echo "stream disconnected; retrying" >&2; exec sleep 5 ;;
esac
`;

let scratch: string;
let pathWithCodex: string;
let pathWithoutCodex: string;
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

// A repository with the gate active and one file staged.
function stagedRepo(): string {
  const repo = join(scratch, `repo-${++seq}`);
  mkdirSync(join(repo, ".githooks"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  copyFileSync(GATE_SRC, join(repo, ".githooks", "pre-commit"));
  chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
  git(repo, "config", "core.hooksPath", ".githooks");
  writeFileSync(join(repo, "src.txt"), "hello\n");
  git(repo, "add", "src.txt");
  return repo;
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

const called = (c: Commit) => existsSync(join(c.calls, "args"));
const callArgs = (c: Commit) => readFileSync(join(c.calls, "args"), "utf8").split("\n");

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

describe("codex failures fail closed and say why", () => {
  test("codex's own error is shown when it produces no verdict", () => {
    const repo = stagedRepo();
    const c = commit(repo, { extra: { FAKE_CODEX_MODE: "fail" } });
    expect(c.code).not.toBe(0);
    expect(c.committed).toBe(false);
    expect(c.err).toContain("codex exited with status 2");
    expect(c.err).toContain("error: unexpected argument '--ephemeral' found");
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

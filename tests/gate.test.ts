// Behavioral tests for scripts/gate.sh against throwaway git repositories.
// Run with: bun test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GATE = join(ROOT, "scripts", "gate.sh");
const GATE_SRC = join(ROOT, "hooks", "pre-commit");

let scratch: string;
let pathWithCodex: string;
let pathWithoutCodex: string;
let seq = 0;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "codex-gate-test-"));
  // A stub codex so no test ever reaches the real CLI.
  const fakeBin = join(scratch, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "codex"),
    '#!/bin/sh\ncase "$1" in\n  --version) echo "codex-cli 0.0.0-test" ;;\n  login) exit "${FAKE_CODEX_LOGIN:-0}" ;;\nesac\nexit 0\n',
  );
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

type Result = { code: number; out: string; err: string };

function env(cwd: string, codex: boolean, extra: Record<string, string> = {}): Record<string, string> {
  // Isolate from the developer's git and codex config and from any GIT_* variables.
  return {
    ...extra,
    PATH: codex ? pathWithCodex : pathWithoutCodex,
    HOME: scratch,
    TMPDIR: scratch,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_PROJECT_DIR: cwd,
  };
}

function gate(mode: string, cwd: string, codex = true, extra: Record<string, string> = {}): Result {
  const p = Bun.spawnSync(["sh", GATE, mode], { cwd, env: env(cwd, codex, extra) });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, env: env(cwd, true) });
  return p.stdout.toString().trim();
}

function newRepo(): string {
  const dir = join(scratch, `repo-${++seq}`);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function hookJson(res: Result) {
  expect(res.code).toBe(0);
  const parsed = JSON.parse(res.out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
  return parsed as { systemMessage: string; hookSpecificOutput: { additionalContext: string } };
}

const stateOf = (res: Result) => /^state: (\S+)/m.exec(res.out)?.[1];

describe("outside a git repository", () => {
  test("hook is silent, check reports not-git, install refuses", () => {
    const dir = join(scratch, "plain");
    mkdirSync(dir);
    expect(gate("hook", dir)).toEqual({ code: 0, out: "", err: "" });
    expect(stateOf(gate("check", dir))).toBe("not-git");
    expect(gate("install", dir).code).toBe(2);
  });
});

describe("fresh repository", () => {
  test("hook offers /codex-review:init", () => {
    const repo = newRepo();
    const out = hookJson(gate("hook", repo));
    expect(out.systemMessage).toContain("/codex-review:init");
    expect(out.hookSpecificOutput.additionalContext).toContain("explicitly agrees");
  });

  test("check shows the plan without writing", () => {
    const repo = newRepo();
    const res = gate("check", repo);
    expect(stateOf(res)).toBe("missing");
    expect(res.out).toContain("codex: codex-cli 0.0.0-test");
    expect(res.out).toContain("create .githooks/pre-commit");
    expect(res.out).toContain("set core.hooksPath=.githooks");
    expect(existsSync(join(repo, ".githooks"))).toBe(false);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
  });

  test("install writes the gate and activates it; re-running is a no-op", () => {
    const repo = newRepo();
    const res = gate("install", repo);
    expect(res.code).toBe(0);
    const hook = join(repo, ".githooks", "pre-commit");
    expect(readFileSync(hook, "utf8")).toBe(readFileSync(GATE_SRC, "utf8"));
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(git(repo, "config", "--local", "--get", "core.hooksPath")).toBe(".githooks");
    expect(stateOf(gate("check", repo))).toBe("installed");
    expect(gate("hook", repo).out).toBe("");
    expect(gate("install", repo).out).toContain("already installed");
  });

  test("works from a subdirectory", () => {
    const repo = newRepo();
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(gate("install", sub).code).toBe(0);
    expect(existsSync(join(repo, ".githooks", "pre-commit"))).toBe(true);
  });

  test("skipInit silences the hook", () => {
    const repo = newRepo();
    git(repo, "config", "codex-review.skipInit", "true");
    expect(gate("hook", repo).out).toBe("");
  });
});

describe("codex missing", () => {
  test("install refuses and writes nothing; hook mentions codex", () => {
    const repo = newRepo();
    const res = gate("install", repo, false);
    expect(res.code).toBe(2);
    expect(existsSync(join(repo, ".githooks"))).toBe(false);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
    expect(gate("check", repo, false).out).toContain("codex: NOT FOUND");
    const out = hookJson(gate("hook", repo, false));
    expect(out.hookSpecificOutput.additionalContext).toContain("codex CLI is not on PATH");
  });
});

describe("fresh clone of a repository that already ships the gate", () => {
  test("only core.hooksPath is missing", () => {
    const repo = newRepo();
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "pre-commit"), readFileSync(GATE_SRC));
    chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
    const check = gate("check", repo);
    expect(stateOf(check)).toBe("missing");
    expect(check.out).not.toContain("create .githooks/pre-commit");
    expect(gate("install", repo).code).toBe(0);
    expect(stateOf(gate("check", repo))).toBe("installed");
  });

  test("other hooks in .githooks are listed in the plan", () => {
    const repo = newRepo();
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "commit-msg"), "#!/bin/sh\nexit 0\n");
    expect(gate("check", repo).out).toContain("also activates the other hooks already in .githooks/: commit-msg");
  });
});

describe("gate that differs from the plugin copy", () => {
  test("is detected and replaced in place", () => {
    const repo = newRepo();
    expect(gate("install", repo).code).toBe(0);
    const hook = join(repo, ".githooks", "pre-commit");
    appendFileSync(hook, "# local edit\n");
    expect(stateOf(gate("check", repo))).toBe("differs");
    expect(hookJson(gate("hook", repo)).systemMessage).toContain("differs from the plugin's version");
    expect(gate("install", repo).code).toBe(0);
    expect(readFileSync(hook, "utf8")).toBe(readFileSync(GATE_SRC, "utf8"));
  });

  test("a fresh clone with a locally edited gate still goes through the diff review", () => {
    const repo = newRepo();
    mkdirSync(join(repo, ".githooks"));
    const hook = join(repo, ".githooks", "pre-commit");
    writeFileSync(hook, readFileSync(GATE_SRC, "utf8") + "# local edit\n");
    chmodSync(hook, 0o755);
    const check = gate("check", repo);
    expect(stateOf(check)).toBe("differs");
    expect(check.out).toContain("replace .githooks/pre-commit");
    expect(check.out).toContain("set core.hooksPath=.githooks");
    expect(hookJson(gate("hook", repo)).hookSpecificOutput.additionalContext).toContain(
      "not activated in this clone",
    );
    expect(gate("install", repo).code).toBe(0);
    expect(stateOf(gate("check", repo))).toBe("installed");
  });

  test("a non-executable gate is made executable", () => {
    const repo = newRepo();
    expect(gate("install", repo).code).toBe(0);
    chmodSync(join(repo, ".githooks", "pre-commit"), 0o644);
    expect(gate("check", repo).out).toContain("make .githooks/pre-commit executable");
    expect(gate("install", repo).code).toBe(0);
    expect(stateOf(gate("check", repo))).toBe("installed");
  });
});

describe("conflicts fail closed", () => {
  function expectRefused(repo: string, reason: string) {
    const check = gate("check", repo);
    expect(stateOf(check)).toBe("conflict");
    expect(check.out).toContain(reason);
    expect(hookJson(gate("hook", repo)).systemMessage).toContain("manual decision");
    const res = gate("install", repo);
    expect(res.code).toBe(2);
    expect(res.err).toContain("nothing was written");
  }

  test("core.hooksPath already points elsewhere", () => {
    const repo = newRepo();
    git(repo, "config", "core.hooksPath", ".husky/_");
    expectRefused(repo, "core.hooksPath is already set to '.husky/_'");
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe(".husky/_");
    expect(existsSync(join(repo, ".githooks"))).toBe(false);
  });

  test("a foreign .githooks/pre-commit is never overwritten", () => {
    const repo = newRepo();
    mkdirSync(join(repo, ".githooks"));
    const foreign = "#!/bin/sh\necho mine\n";
    writeFileSync(join(repo, ".githooks", "pre-commit"), foreign);
    expectRefused(repo, "already exists and is not the codex-review gate");
    expect(readFileSync(join(repo, ".githooks", "pre-commit"), "utf8")).toBe(foreign);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
  });

  test("active hooks in .git/hooks are never disabled", () => {
    const repo = newRepo();
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n");
    expectRefused(repo, "active hooks that would stop running once core.hooksPath is set: pre-push");
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
    expect(existsSync(join(repo, ".githooks"))).toBe(false);
  });

  test("a symlinked .githooks/pre-commit is left alone", () => {
    const repo = newRepo();
    mkdirSync(join(repo, ".githooks"));
    symlinkSync(GATE_SRC, join(repo, ".githooks", "pre-commit"));
    expectRefused(repo, "is a symlink");
  });

  test("a symlinked .githooks directory is never written through", () => {
    const repo = newRepo();
    const outside = join(scratch, `outside-${++seq}`);
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".githooks"));
    expectRefused(repo, ".githooks is a symlink");
    expect(readdirSync(outside)).toEqual([]);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
  });

  test("a .githooks that is not a directory", () => {
    const repo = newRepo();
    writeFileSync(join(repo, ".githooks"), "not a directory\n");
    expectRefused(repo, ".githooks exists and is not a directory");
  });
});

describe("gate already in place behind a symlinked .githooks", () => {
  test("counts as installed, since nothing needs writing", () => {
    const repo = newRepo();
    const shared = join(scratch, `shared-hooks-${++seq}`);
    mkdirSync(shared);
    writeFileSync(join(shared, "pre-commit"), readFileSync(GATE_SRC));
    chmodSync(join(shared, "pre-commit"), 0o755);
    symlinkSync(shared, join(repo, ".githooks"));
    git(repo, "config", "core.hooksPath", ".githooks");
    expect(stateOf(gate("check", repo))).toBe("installed");
    expect(gate("hook", repo).out).toBe("");
  });
});

describe("codex auth detection", () => {
  const notLoggedIn = { FAKE_CODEX_LOGIN: "1" };
  const auth = (extra: Record<string, string>) =>
    /^codex auth: (.*)$/m.exec(gate("check", newRepo(), true, extra).out)?.[1] ?? "";

  function codexHome(config: string): string {
    const dir = join(scratch, `codex-home-${++seq}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "config.toml"), config);
    return dir;
  }

  test("codex login", () => {
    expect(auth({})).toBe("logged in (codex login status)");
  });

  test("API key in the environment", () => {
    expect(auth({ ...notLoggedIn, OPENAI_API_KEY: "sk-test" })).toBe("API key from the environment");
    expect(auth({ ...notLoggedIn, CODEX_API_KEY: "sk-test" })).toBe("API key from the environment");
  });

  test("custom top-level model_provider", () => {
    const home = codexHome('model = "m"\nmodel_provider = "gateway" # via proxy\n\n[model_providers.gateway]\nbase_url = "https://example.invalid"\n');
    expect(auth({ ...notLoggedIn, CODEX_HOME: home })).toBe(`custom model_provider in ${home}/config.toml`);
  });

  test("model_provider = openai still needs a login", () => {
    const home = codexHome("model_provider = 'openai'\n");
    expect(auth({ ...notLoggedIn, CODEX_HOME: home })).toStartWith("NOT verified");
  });

  test("model_provider inside a table is not top-level", () => {
    const home = codexHome('[profiles.work]\nmodel_provider = "gateway"\n');
    expect(auth({ ...notLoggedIn, CODEX_HOME: home })).toStartWith("NOT verified");
  });

  test("nothing found is reported as not verified, never as a hard failure", () => {
    const repo = newRepo();
    const res = gate("check", repo, true, notLoggedIn);
    expect(res.code).toBe(0);
    expect(res.out).toContain("codex auth: NOT verified");
    expect(gate("install", repo, true, notLoggedIn).code).toBe(0);
  });
});

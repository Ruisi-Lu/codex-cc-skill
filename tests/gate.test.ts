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
    // The session-start check activates the plugin's own copy, never this edit.
    expect(hookJson(gate("hook", repo)).systemMessage).toContain("activated the plugin's copy");
    expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8")).toBe(readFileSync(GATE_SRC, "utf8"));
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
  function expectRefused(repo: string, reason: string, notice = true) {
    const check = gate("check", repo);
    expect(stateOf(check)).toBe("conflict");
    expect(check.out).toContain(reason);
    if (notice) expect(hookJson(gate("hook", repo)).systemMessage).toContain("manual decision");
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
    // It still signals a shipped gate, so the session-start check activates the plugin's copy.
    expectRefused(repo, "is a symlink", false);
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

// A clone of a repository whose history already carries the bundled gate.
function shippedRepo(content = readFileSync(GATE_SRC)): string {
  const repo = newRepo();
  mkdirSync(join(repo, ".githooks"));
  writeFileSync(join(repo, ".githooks", "pre-commit"), content);
  chmodSync(join(repo, ".githooks", "pre-commit"), 0o755);
  return repo;
}

function guard(cwd: string, command: string, extra: Record<string, string> = {}): Result {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
  const p = Bun.spawnSync(["sh", GATE, "guard"], { cwd, env: env(cwd, true, extra), stdin: Buffer.from(input) });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const denied = (res: Result) => {
  expect(res.code).toBe(0);
  return res.out !== "" && JSON.parse(res.out).hookSpecificOutput.permissionDecision === "deny";
};

describe("a repository that ships the gate activates it in every clone", () => {
  const localHook = (repo: string) => join(repo, ".git", "hooks", "pre-commit");

  test("hook installs the plugin's own copy in .git/hooks and says so", () => {
    const repo = shippedRepo();
    const out = hookJson(gate("hook", repo));
    expect(out.systemMessage).toContain("activated the plugin's copy");
    expect(readFileSync(localHook(repo), "utf8")).toBe(readFileSync(GATE_SRC, "utf8"));
    expect(statSync(localHook(repo)).mode & 0o111).not.toBe(0);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
    expect(gate("check", repo).out).toContain("clone: the plugin's own gate runs from");
    expect(guard(repo, "git commit -m x").out).toBe("");
    expect(gate("hook", repo).out).toBe("");
  });

  test("never runs repository content: a modified shipped gate and extra hooks stay inert", () => {
    const repo = shippedRepo(readFileSync(GATE_SRC, "utf8") + "touch pwned\n");
    writeFileSync(join(repo, ".githooks", "post-checkout"), "#!/bin/sh\ntouch pwned\n");
    hookJson(gate("hook", repo));
    expect(readFileSync(localHook(repo), "utf8")).toBe(readFileSync(GATE_SRC, "utf8"));
    expect(existsSync(join(repo, ".git", "hooks", "post-checkout"))).toBe(false);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
  });

  test("an outdated plugin-owned copy is refreshed silently", () => {
    const repo = shippedRepo();
    writeFileSync(localHook(repo), readFileSync(GATE_SRC, "utf8") + "# old release\n");
    chmodSync(localHook(repo), 0o755);
    expect(gate("hook", repo).out).toBe("");
    expect(readFileSync(localHook(repo), "utf8")).toBe(readFileSync(GATE_SRC, "utf8"));
  });

  test("other hooks in .git/hooks keep running", () => {
    const repo = shippedRepo();
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n");
    hookJson(gate("hook", repo));
    expect(existsSync(localHook(repo))).toBe(true);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe("");
  });

  test("skipInit does not opt out of a shipped gate", () => {
    const repo = shippedRepo();
    git(repo, "config", "codex-review.skipInit", "true");
    hookJson(gate("hook", repo));
    expect(existsSync(localHook(repo))).toBe(true);
  });

  test("without codex nothing is activated, the notice says why, and guard blocks", () => {
    const repo = shippedRepo();
    const out = hookJson(gate("hook", repo, false));
    expect(out.hookSpecificOutput.additionalContext).toContain("codex CLI is not on PATH");
    expect(out.hookSpecificOutput.additionalContext).toContain("blocked until the gate is active");
    expect(existsSync(localHook(repo))).toBe(false);
    expect(denied(guard(repo, "git commit -m x"))).toBe(true);
  });

  test("a foreign .git/hooks/pre-commit is never replaced", () => {
    const repo = shippedRepo();
    const foreign = "#!/bin/sh\necho mine\n";
    writeFileSync(localHook(repo), foreign);
    git(repo, "config", "codex-review.skipInit", "true");
    const out = hookJson(gate("hook", repo));
    expect(out.hookSpecificOutput.additionalContext).toContain("blocked until the gate is active");
    expect(readFileSync(localHook(repo), "utf8")).toBe(foreign);
  });

  test("another core.hooksPath is left alone", () => {
    const repo = shippedRepo();
    git(repo, "config", "core.hooksPath", ".husky/_");
    hookJson(gate("hook", repo));
    expect(existsSync(localHook(repo))).toBe(false);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe(".husky/_");
  });

  test("install over a clone-local copy points core.hooksPath at .githooks", () => {
    const repo = shippedRepo();
    hookJson(gate("hook", repo));
    expect(stateOf(gate("check", repo))).toBe("missing");
    expect(gate("install", repo).code).toBe(0);
    expect(git(repo, "config", "--get", "core.hooksPath")).toBe(".githooks");
  });
});

describe("guard blocks Claude's commits while a shipped gate is inactive", () => {
  test("denies git commit spelled in several ways", () => {
    const repo = shippedRepo(readFileSync(GATE_SRC, "utf8") + "# local edit\n");
    for (const cmd of [
      "git commit -m x",
      "git -C . commit -m x",
      "git add . && git commit -m 'a \"quoted\" msg'",
      "git add .\ngit commit -m x",
      "cd sub; git\tcommit --amend",
    ]) {
      expect(denied(guard(repo, cmd))).toBe(true);
    }
  });

  test("allows commands that are not commits", () => {
    const repo = shippedRepo(readFileSync(GATE_SRC, "utf8") + "# local edit\n");
    for (const cmd of ["git status", "ls commit", "echo digit commit", "git config core.hooksPath .githooks"]) {
      expect(guard(repo, cmd)).toEqual({ code: 0, out: "", err: "" });
    }
  });

  test("checks the repository in the hook's cwd", () => {
    const shipped = shippedRepo(readFileSync(GATE_SRC, "utf8") + "# local edit\n");
    const input = JSON.stringify({ tool_name: "Bash", cwd: shipped, tool_input: { command: "git commit -m x" } });
    const other = newRepo();
    const p = Bun.spawnSync(["sh", GATE, "guard"], { cwd: other, env: env(other, true), stdin: Buffer.from(input) });
    expect(JSON.parse(p.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("allows commits once the gate is active", () => {
    const repo = shippedRepo();
    git(repo, "config", "core.hooksPath", ".githooks");
    expect(guard(repo, "git commit -m x").out).toBe("");
  });

  test("a non-executable gate is not active", () => {
    const repo = shippedRepo();
    git(repo, "config", "core.hooksPath", ".githooks");
    chmodSync(join(repo, ".githooks", "pre-commit"), 0o644);
    expect(denied(guard(repo, "git commit -m x"))).toBe(true);
  });

  test("a gate wired in through another hook manager can be recorded", () => {
    const repo = shippedRepo();
    git(repo, "config", "core.hooksPath", ".husky/_");
    expect(denied(guard(repo, "git commit -m x"))).toBe(true);
    git(repo, "config", "codex-review.gateWired", "true");
    expect(guard(repo, "git commit -m x").out).toBe("");
  });

  // A worktree of a shipped repository; core.hooksPath is set in the config all worktrees share.
  function shippedWorktree(hooksPath: (main: string) => string): { main: string; tree: string } {
    const main = shippedRepo();
    git(main, "add", ".githooks/pre-commit");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--no-verify", "-m", "gate");
    const tree = join(scratch, `tree-${++seq}`);
    git(main, "worktree", "add", "-q", tree);
    git(main, "config", "core.hooksPath", hooksPath(main));
    return { main, tree };
  }

  test("allows commits in a worktree whose core.hooksPath is the main checkout's absolute .githooks", () => {
    const { main, tree } = shippedWorktree((main) => join(main, ".githooks"));
    expect(guard(tree, "git commit -m x").out).toBe("");
    expect(gate("hook", tree).out).toBe("");
    expect(gate("check", tree).out).toContain(`clone: a codex-review gate runs from ${join(main, ".githooks")}/pre-commit`);
  });

  test("still denies in a worktree whose core.hooksPath has no gate", () => {
    const { main, tree } = shippedWorktree((main) => join(main, ".husky"));
    mkdirSync(join(main, ".husky"));
    writeFileSync(join(main, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(main, ".husky", "pre-commit"), 0o755);
    expect(denied(guard(tree, "git commit -m x"))).toBe(true);
  });

  test("a non-executable gate behind core.hooksPath is not active", () => {
    const { main, tree } = shippedWorktree((main) => join(main, ".githooks"));
    chmodSync(join(main, ".githooks", "pre-commit"), 0o644);
    expect(denied(guard(tree, "git commit -m x"))).toBe(true);
  });

  test("stays out of repositories that do not ship the gate", () => {
    expect(guard(newRepo(), "git commit -m x").out).toBe("");
    const plain = join(scratch, `plain-${++seq}`);
    mkdirSync(plain);
    expect(guard(plain, "git commit -m x").out).toBe("");
  });
});

describe("check reports the team plugin setting", () => {
  test("enabled and not enabled", () => {
    const repo = newRepo();
    expect(gate("check", repo).out).toContain("team plugin: NOT enabled");
    mkdirSync(join(repo, ".claude"));
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "codex-review@codex-cc-skill": true } }),
    );
    expect(gate("check", repo).out).toContain("no extraKnownMarketplaces entry");
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        extraKnownMarketplaces: { "codex-cc-skill": { source: { source: "github", repo: "o/r" } } },
        enabledPlugins: { "codex-review@codex-cc-skill": true },
      }),
    );
    expect(gate("check", repo).out).toContain("team plugin: enabled in");
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "codex-review@codex-cc-skill": false } }),
    );
    expect(gate("check", repo).out).toContain("team plugin: DISABLED");
  });
});

describe("organization-distributed plugin", () => {
  test("check says the team setting is not needed", () => {
    // Mimic claude.ai's synced layout: <home>/.claude/plugins/synced/<id>/codex-review
    const root = join(scratch, `org-${++seq}`, ".claude", "plugins", "synced", "org-id", "codex-review");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "hooks"));
    writeFileSync(join(root, "scripts", "gate.sh"), readFileSync(GATE));
    writeFileSync(join(root, "hooks", "pre-commit"), readFileSync(GATE_SRC));
    const repo = newRepo();
    const p = Bun.spawnSync(["sh", join(root, "scripts", "gate.sh"), "check"], { cwd: repo, env: env(repo, true) });
    const out = p.stdout.toString();
    expect(out).toContain("team plugin: provided by your organization");
    expect(out).toContain("plan:");
  });
});

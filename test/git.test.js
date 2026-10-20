import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff } from "../src/git.js";

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "codediff-git-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git("add", "tracked.txt");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("includes tracked changes and new untracked files", async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "tracked.txt"), "two\n");
  writeFileSync(join(repo, "new file.txt"), "hello\n");

  const diff = await getDiff({ repo, base: "HEAD" });

  assert.match(diff, /^diff --git a\/tracked\.txt b\/tracked\.txt$/m);
  assert.match(diff, /^\+two$/m);
  assert.match(diff, /^diff --git a\/new file\.txt b\/new file\.txt$/m);
  assert.match(diff, /^\+hello$/m);
});

test("skips git-ignored files", async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, ".gitignore"), "secret.txt\n");
  writeFileSync(join(repo, "secret.txt"), "nope\n");

  const diff = await getDiff({ repo, base: "HEAD" });

  assert.doesNotMatch(diff, /secret\.txt b\/secret\.txt/);
});

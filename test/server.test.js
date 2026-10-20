import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { getDiff } from "../src/git.js";

const diffFor = (...paths) =>
  paths.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`).join("");

async function setup(t) {
  // The repo sits inside a scratch root so "../outside.md" points at a real file.
  const root = mkdtempSync(join(tmpdir(), "codediff-server-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "doc.md"), "# Doc\n");
  writeFileSync(join(repo, "other.md"), "not in diff\n");
  writeFileSync(join(root, "outside.md"), "secret\n");
  const session = { title: "T", summary: "", rationale: "", files: [], diff: diffFor("doc.md", "missing.md", "../outside.md") };
  const { server, url } = await startServer({ session, repo, port: 0 });
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return (path) => fetch(`${url}api/file?path=${encodeURIComponent(path)}`);
}

test("returns the content of a file named in the diff", async (t) => {
  const get = await setup(t);
  const res = await get("doc.md");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: "doc.md", content: "# Doc\n" });
});

test("refuses a path that is not in the session diff", async (t) => {
  const get = await setup(t);
  const res = await get("other.md");
  assert.equal(res.status, 403);
  assert.ok((await res.json()).error);
});

test("refuses a path that escapes the repo even if it is in the diff", async (t) => {
  const get = await setup(t);
  assert.equal((await get("../outside.md")).status, 403);
});

test("returns 404 for a diff path whose file is missing", async (t) => {
  const get = await setup(t);
  const res = await get("missing.md");
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});

// A real repo: one committed file modified, one deleted, one new untracked file.
async function setupGit(t) {
  const root = mkdtempSync(join(tmpdir(), "codediff-server-git-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "app.js"), "const a = 1;\n");
  writeFileSync(join(repo, "gone.js"), "bye\n");
  writeFileSync(join(repo, "other.js"), "not in diff\n");
  writeFileSync(join(root, "outside.js"), "secret\n");
  git("add", "app.js", "gone.js", "other.js");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "app.js"), "const a = 2;\n");
  writeFileSync(join(repo, "added.js"), "hello\n");
  rmSync(join(repo, "gone.js"));
  const diff = (await getDiff({ repo, base: "HEAD" })) + diffFor("../outside.js");
  const session = { title: "T", summary: "", rationale: "", files: [], diff };
  const { server, url } = await startServer({ session, repo, base: "HEAD", port: 0 });
  t.after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  return (path, side) => {
    const query = side === undefined ? "" : `&side=${encodeURIComponent(side)}`;
    return fetch(`${url}api/file?path=${encodeURIComponent(path)}${query}`);
  };
}

test("side=base returns the file at the session base", async (t) => {
  const get = await setupGit(t);
  const res = await get("app.js", "base");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: "app.js", content: "const a = 1;\n" });
});

test("side=current (and the default) returns the working tree file", async (t) => {
  const get = await setupGit(t);
  for (const side of ["current", undefined]) {
    const res = await get("app.js", side);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: "app.js", content: "const a = 2;\n" });
  }
});

test("a new file is empty at the base", async (t) => {
  const get = await setupGit(t);
  const base = await get("added.js", "base");
  assert.equal(base.status, 200);
  assert.deepEqual(await base.json(), { path: "added.js", content: "", exists: false });
  assert.equal((await (await get("added.js", "current")).json()).content, "hello\n");
});

test("a deleted file is empty on the current side", async (t) => {
  const get = await setupGit(t);
  const current = await get("gone.js", "current");
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), { path: "gone.js", content: "", exists: false });
  assert.equal((await (await get("gone.js", "base")).json()).content, "bye\n");
});

test("rejects an unknown side", async (t) => {
  const get = await setupGit(t);
  const res = await get("app.js", "theirs");
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test("side=base keeps the path guards", async (t) => {
  const get = await setupGit(t);
  assert.equal((await get("other.js", "base")).status, 403);
  assert.equal((await get("../outside.js", "base")).status, 403);
});

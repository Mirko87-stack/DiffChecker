import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff } from "../web/diff-parser.js";

test("parses files and hunks from a unified diff", () => {
  const diff = ["diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
  assert.deepEqual(parseUnifiedDiff(diff), [
    { path: "x.js", status: "modified", additions: 1, deletions: 1, hunks:[{ header: "@@ -1 +1 @@", lines: ["-old", "+new"] }] },
  ]);
});

test("strips CRLF line endings produced on Windows", () => {
  const diff = ["diff --git a/x.js b/x.js", "@@ -1 +1 @@", "-old", "+new", ""].join("\r\n");
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.path, "x.js");
  assert.deepEqual(file.hunks[0], { header: "@@ -1 +1 @@", lines: ["-old", "+new"] });
});

test("counts additions and deletions, ignoring the ---/+++ headers", () => {
  const diff = [
    "diff --git a/x.js b/x.js", "--- a/x.js", "+++ b/x.js",
    "@@ -1,3 +1,4 @@", " keep", "-old", "+new", "+more", "@@ -10 +11 @@", "-gone", "",
  ].join("\n");
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.status, "modified");
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
});

test("marks added files", () => {
  const byMode = parseUnifiedDiff(["diff --git a/n.js b/n.js", "new file mode 100644", "--- /dev/null", "+++ b/n.js", "@@ -0,0 +1 @@", "+hi", ""].join("\n"));
  assert.equal(byMode[0].status, "added");
  assert.equal(byMode[0].additions, 1);
  assert.equal(byMode[0].deletions, 0);
  const byNull = parseUnifiedDiff(["diff --git a/n.js b/n.js", "--- /dev/null", "+++ b/n.js", "@@ -0,0 +1 @@", "+hi", ""].join("\n"));
  assert.equal(byNull[0].status, "added");
});

test("marks deleted files", () => {
  const byMode = parseUnifiedDiff(["diff --git a/o.js b/o.js", "deleted file mode 100644", "--- a/o.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", ""].join("\n"));
  assert.equal(byMode[0].status, "deleted");
  assert.equal(byMode[0].deletions, 1);
  const byNull = parseUnifiedDiff(["diff --git a/o.js b/o.js", "--- a/o.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", ""].join("\n"));
  assert.equal(byNull[0].status, "deleted");
});

test("marks renamed files with the new path", () => {
  const diff = [
    "diff --git a/old.js b/new.js", "similarity index 90%", "rename from old.js", "rename to new.js",
    "--- a/old.js", "+++ b/new.js", "@@ -1 +1 @@", "-a", "+b", "",
  ].join("\n");
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.status, "renamed");
  assert.equal(file.path, "new.js");
});

test("a pure rename without hunks still has zero counts", () => {
  const [file] = parseUnifiedDiff(["diff --git a/a.md b/b.md", "similarity index 100%", "rename from a.md", "rename to b.md", ""].join("\n"));
  assert.deepEqual([file.path, file.status, file.additions, file.deletions], ["b.md", "renamed", 0, 0]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { hunkRanges, findHunkAt } from "../web/hunks.js";

test("falls back to the header ranges when a hunk has no lines", () => {
  assert.deepEqual(hunkRanges({ header: "@@ -10,7 +12,9 @@ fn()", lines: [] }), {
    original: { start: 10, end: 16 },
    modified: { start: 12, end: 20 },
  });
});

test("omitted counts default to one line", () => {
  assert.deepEqual(hunkRanges({ header: "@@ -3 +4 @@", lines: [] }), {
    original: { start: 3, end: 3 },
    modified: { start: 4, end: 4 },
  });
});

test("a zero count is an empty range anchored at that line", () => {
  const { original } = hunkRanges({ header: "@@ -0,0 +1,2 @@", lines: [] });
  assert.deepEqual(original, { start: 0, end: -1 });
});

test("ranges cover only the changed lines, not the surrounding context", () => {
  const hunk = {
    header: "@@ -10,6 +10,7 @@",
    lines: [" a", " b", "-old1", "-old2", "+new1", "+new2", "+new3", " c"],
  };
  assert.deepEqual(hunkRanges(hunk), {
    original: { start: 12, end: 13 },
    modified: { start: 12, end: 14 },
  });
});

test("a pure addition is anchored on the original side after the last kept line", () => {
  const hunk = { header: "@@ -5,2 +5,4 @@", lines: [" a", "+x", "+y", " b"] };
  assert.deepEqual(hunkRanges(hunk), {
    original: { start: 5, end: 4 },
    modified: { start: 6, end: 7 },
  });
});

test("a pure deletion is anchored on the modified side after the last kept line", () => {
  const hunk = { header: "@@ -5,4 +5,2 @@", lines: [" a", "-x", "-y", " b"] };
  assert.deepEqual(hunkRanges(hunk), {
    original: { start: 6, end: 7 },
    modified: { start: 5, end: 4 },
  });
});

test("a new file has an empty original range at line 0", () => {
  const hunk = { header: "@@ -0,0 +1,2 @@", lines: ["+a", "+b"] };
  assert.deepEqual(hunkRanges(hunk), {
    original: { start: 0, end: -1 },
    modified: { start: 1, end: 2 },
  });
});

test("a deleted file has an empty modified range at line 0", () => {
  const hunk = { header: "@@ -1,2 +0,0 @@", lines: ["-a", "-b"] };
  assert.deepEqual(hunkRanges(hunk), {
    original: { start: 1, end: 2 },
    modified: { start: 0, end: -1 },
  });
});

const hunks = [
  { header: "@@ -1,4 +1,4 @@", lines: [" a", "-b", "+B", " c", " d"] },
  { header: "@@ -20,3 +20,4 @@", lines: [" x", "+y", "+z", " w"] },
];

test("findHunkAt finds the hunk on the modified side", () => {
  assert.equal(findHunkAt(hunks, "modified", 2), hunks[0]);
  assert.equal(findHunkAt(hunks, "modified", 22), hunks[1]);
});

test("findHunkAt finds the hunk on the original side", () => {
  assert.equal(findHunkAt(hunks, "original", 2), hunks[0]);
});

test("findHunkAt ignores context lines and empty ranges", () => {
  assert.equal(findHunkAt(hunks, "modified", 1), null);
  assert.equal(findHunkAt(hunks, "modified", 23), null);
  assert.equal(findHunkAt(hunks, "original", 20), null);
  assert.equal(findHunkAt(hunks, "original", 21), null);
});

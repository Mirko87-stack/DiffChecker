// Line ranges of a hunk on each side, so a hovered editor line can be traced back to its hunk.
// A range with end < start is empty: the side has no changed lines, and start is the line it sits after.
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunkRanges(hunk) {
  const [, a, b = "1", c, d = "1"] = hunk.header.match(HEADER) ?? [, "0", "0", "0", "0"];
  const [oldStart, oldCount, newStart, newCount] = [a, b, c, d].map(Number);
  const original = { start: oldStart, end: oldStart + oldCount - 1 };
  const modified = { start: newStart, end: newStart + newCount - 1 };
  if (!hunk.lines.length) return { original, modified };

  // Git writes the line *before* an empty side, so a zero count starts counting one line later.
  let oldLine = oldCount === 0 ? oldStart + 1 : oldStart;
  let newLine = newCount === 0 ? newStart + 1 : newStart;
  const removed = [];
  const added = [];
  let oldAnchor = null;
  let newAnchor = null;
  for (const line of hunk.lines) {
    if (line[0] === "-") {
      newAnchor ??= newLine - 1;
      removed.push(oldLine++);
    } else if (line[0] === "+") {
      oldAnchor ??= oldLine - 1;
      added.push(newLine++);
    } else {
      oldLine++;
      newLine++;
    }
  }
  return {
    original: span(removed, oldAnchor ?? oldStart),
    modified: span(added, newAnchor ?? newStart),
  };
}

function span(lines, anchor) {
  return lines.length ? { start: lines[0], end: lines.at(-1) } : { start: anchor, end: anchor - 1 };
}

// The hunk whose changed lines on `side` ("original" | "modified") include `line`, or null.
export function findHunkAt(hunks, side, line) {
  for (const hunk of hunks) {
    const { start, end } = hunkRanges(hunk)[side];
    if (line >= start && line <= end) return hunk;
  }
  return null;
}

// Minimal unified diff parser: files -> hunks -> raw lines, plus status and +/- counts per file.
export function parseUnifiedDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;

  // Diffs of CRLF files (common on Windows) would otherwise keep a trailing "\r" on every line.
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      file = { path: line.split(" b/").pop(), status: "modified", additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = null;
    } else if (line.startsWith("@@") && file) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && /^[ +-]/.test(line)) {
      hunk.lines.push(line);
      if (line[0] === "+") file.additions++;
      else if (line[0] === "-") file.deletions++;
    } else if (file && !hunk) {
      // Extended header lines between "diff --git" and the first hunk say what kind of change this is.
      if (line.startsWith("new file mode") || line === "--- /dev/null") file.status = "added";
      else if (line.startsWith("deleted file mode") || line === "+++ /dev/null") file.status = "deleted";
      else if (line.startsWith("rename to ")) {
        file.status = "renamed";
        file.path = line.slice("rename to ".length);
      }
    }
  }
  return files;
}

// Thin wrapper around the git CLI; no git library dependency.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const OPTIONS = { maxBuffer: 64 * 1024 * 1024 };

// `git diff <base>` ignores untracked files, yet new files are often the core of an agent's task.
export async function getDiff({ repo, base }) {
  const git = (args) => run("git", args, { ...OPTIONS, cwd: repo });
  const { stdout: tracked } = await git(["diff", "--no-color", base]);
  const { stdout: list } = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = list.split("\0").filter(Boolean);
  const added = await Promise.all(untracked.map((path) => diffNewFile(git, path)));
  return [tracked, ...added].filter(Boolean).join("");
}

// Returns the file text at `base`, or null when the file does not exist there (a new file).
// Missing paths are told apart from a bad base by re-checking the base, not by parsing localized stderr.
export async function getFileAtBase({ repo, base, path }) {
  if (base.startsWith("-")) throw new Error(`Invalid base: ${base}`);
  const git = (args) => run("git", args, { ...OPTIONS, cwd: repo });
  try {
    const { stdout } = await git(["show", `${base}:${path}`]);
    return stdout;
  } catch (error) {
    await git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).catch(() => {
      throw error;
    });
    return null;
  }
}

// git maps /dev/null on Windows too; `--no-index` exits with code 1 when the files differ.
async function diffNewFile(git, path) {
  try {
    const { stdout } = await git(["diff", "--no-color", "--no-index", "--", "/dev/null", path]);
    return stdout;
  } catch (error) {
    if (error.code === 1) return error.stdout;
    throw error;
  }
}

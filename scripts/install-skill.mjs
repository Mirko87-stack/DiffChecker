// Explicit, conflict-safe skill setup shared by the public CLI and legacy installer.
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, statSync } from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const checkout = resolve(fileURLToPath(import.meta.url), "../..");

export function renderSkill(text) {
  return text.replace(/node\s+"\{\{CODEDIFF_BIN\}\}"/g, "diffchecker")
    .split("{{CODEDIFF_BIN}}").join("diffchecker");
}

export function defaultRoots(home, exists) {
  return [[".claude"], [".codex"], [".pi", "agent"]]
    .map((parts) => join(home, ...parts))
    .filter((agentDir) => exists(agentDir))
    .map((agentDir) => join(agentDir, "skills"));
}

export function parseArgs(argv) {
  const opts = { targets: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") opts.dryRun = true;
    else if (argv[i] === "--target" && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      opts.targets.push(resolve(argv[++i]));
    } else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return opts;
}

function stat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function preflight(root, skill) {
  const file = join(root, "codediff-show", "SKILL.md");
  const destination = stat(file);
  if (destination?.isSymbolicLink() || (destination && !destination.isFile())) {
    throw new Error(`Unsafe skill destination: ${file}. Choose another --target.`);
  }
  let parent = dirname(file);
  for (;;) {
    const entry = stat(parent);
    // System ancestors may legitimately be links (for example /var on macOS).
    // Never follow a link at the selected skills root or inside its destination.
    const insideTarget = parent === root || parent.startsWith(root + sep);
    if (entry && ((entry.isSymbolicLink() && insideTarget) || !statSync(parent).isDirectory())) {
      throw new Error(`Unsafe setup directory: ${parent}. Choose another --target.`);
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (destination && readFileSync(file, "utf8") !== skill) {
    throw new Error(`Skill conflict: ${file}. Back up and remove the existing skill or choose another --target; nothing was overwritten.`);
  }
  return { file, unchanged: Boolean(destination) };
}

export function installSkill(argv) {
  const { targets, dryRun } = parseArgs(argv);
  const roots = targets.length ? targets : defaultRoots(homedir(), existsSync);
  if (!roots.length) {
    throw new Error("No agent folder found (~/.claude, ~/.codex, ~/.pi/agent). Pass --target <skills-directory>.");
  }
  const skill = renderSkill(readFileSync(join(checkout, "skill", "SKILL.md"), "utf8"));
  // Validate every target before any directory or file is created.
  const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
  const uniqueRoots = [...new Map(roots.map((root) => [key(root), root])).values()];
  const plans = uniqueRoots.map((root) => preflight(root, skill));
  for (const plan of plans) {
    if (plans.some((other) => other !== plan && key(other.file).startsWith(key(plan.file) + sep))) {
      throw new Error(`Overlapping skill targets: ${plan.file} would become a directory. Choose separate --target directories.`);
    }
  }
  for (const { file, unchanged } of plans) {
    if (!unchanged && !dryRun) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, skill, { flag: "wx" });
    }
    console.log(`${unchanged ? "unchanged" : dryRun ? "would write" : "wrote"} ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { installSkill(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

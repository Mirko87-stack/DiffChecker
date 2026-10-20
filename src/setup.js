import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defaultRoots, installSkill } from "../scripts/install-skill.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export function runSetupCommand(command, args) {
  try {
    if (command === "setup") return installSkill(args);
    if (args.length) throw new Error(`Unknown argument: ${args[0]}`);
    if (command === "--version") {
      console.log(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
      return;
    }
    if (command === "--help") {
      console.log("DiffChecker\nUsage: diffchecker [open|wait|answer|refresh] [options]\n       diffchecker setup [--target <skills-directory>] [--dry-run]\n       diffchecker doctor\n       diffchecker --version\nSetup is explicit; installation never changes agent skills automatically.");
      return;
    }
    const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
    console.log(`Node.js >=20: ${nodeOk ? "OK" : "MISSING"} (${process.version})`);
    const git = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
    const gitOk = !git.error && git.status === 0;
    console.log(`Git: ${gitOk ? git.stdout.trim() : "MISSING (install Git and add it to PATH)"}`);
    let assetsOk = true;
    for (const asset of ["package.json", "bin/codediff.js", "scripts/install-skill.mjs", "skill/SKILL.md", "web/index.html", "web/app.js", "web/style.css"]) {
      const ok = existsSync(join(root, asset));
      assetsOk &&= ok;
      console.log(`Asset ${asset}: ${ok ? "OK" : "MISSING"}`);
    }
    const roots = defaultRoots(homedir(), existsSync);
    console.log(`Detected skill roots: ${roots.length ? roots.join(", ") : "none (use setup --target <skills-directory>)"}`);
    if (!nodeOk || !gitOk || !assetsOk) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

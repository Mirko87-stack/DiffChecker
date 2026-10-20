import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const bin = resolve(fileURLToPath(import.meta.url), "../../bin/codediff.js");
const run = (args, cwd, env = process.env) => spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", timeout: 5000 });

test("setup installs a portable launcher without viewer state and repeats as a no-op", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diffchecker-setup-"));
  try {
    const target = join(cwd, "skills");
    const first = run(["setup", "--target", target], cwd);
    assert.equal(first.status, 0, first.stderr);
    const file = join(target, "codediff-show", "SKILL.md");
    const skill = await readFile(file, "utf8");
    assert.match(skill, /diffchecker/);
    assert.ok(!skill.includes(bin));
    assert.ok(!skill.includes("{{CODEDIFF_BIN}}"));
    const second = run(["setup", "--target", target], cwd);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged/);
    await assert.rejects(access(join(cwd, ".codediff")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("public setup validates arguments and dry run does not create viewer state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diffchecker-args-"));
  try {
    for (const args of [["setup", "--target"], ["setup", "--target", "--dry-run"], ["setup", "--unknown"], ["doctor", "--unknown"]]) {
      const result = run(args, cwd);
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.match(result.stderr, /argument/i);
    }
    const dry = run(["setup", "--target", join(cwd, "new"), "--dry-run"], cwd);
    assert.equal(dry.status, 0, dry.stderr);
    await assert.rejects(access(join(cwd, "new")));
    await assert.rejects(access(join(cwd, ".codediff")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("doctor detects missing Git read-only, and help/version need no viewer", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diffchecker-doctor-"));
  try {
    const missingGit = run(["doctor"], cwd, { ...process.env, PATH: "", Path: "" });
    assert.equal(missingGit.status, 1, missingGit.stderr);
    assert.match(missingGit.stdout, /Git: MISSING/);
    assert.match(missingGit.stdout, /Asset web\/index.html: OK/);
    const doctor = run(["doctor"], cwd);
    assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
    for (const args of [["--help"], ["--version"]]) {
      const result = run(args, cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.trim());
    }
    await assert.rejects(access(join(cwd, ".codediff")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("setup without installed agent roots reports the explicit-target remedy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diffchecker-home-"));
  try {
    const result = run(["setup"], cwd, { ...process.env, HOME: cwd, USERPROFILE: cwd });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No agent folder found.*--target/);
    await assert.rejects(access(join(cwd, ".codediff")));
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

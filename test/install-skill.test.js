import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile, access, symlink, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderSkill, defaultRoots } from "../scripts/install-skill.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../..");
const script = join(root, "scripts", "install-skill.mjs");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const temp = () => mkdtemp(join(tmpdir(), "diffchecker-skill-"));

test("renderSkill converts legacy commands to the portable launcher", () => {
  assert.equal(renderSkill('node "{{CODEDIFF_BIN}}" a\nnode "{{CODEDIFF_BIN}}" b'), 'diffchecker a\ndiffchecker b');
  assert.equal(renderSkill("plain text"), "plain text");
});

test("defaultRoots picks only roots whose agent folder exists", () => {
  const home = join("h", "me");
  const existing = new Set([join(home, ".claude"), join(home, ".pi", "agent")]);
  assert.deepEqual(defaultRoots(home, (p) => existing.has(p)), [join(home, ".claude", "skills"), join(home, ".pi", "agent", "skills")]);
});

test("legacy installer installs portable commands and repeating preserves the file", async () => {
  const dir = await temp();
  try {
    const first = run("--target", dir);
    assert.equal(first.status, 0, first.stderr);
    const file = join(dir, "codediff-show", "SKILL.md");
    const written = await readFile(file, "utf8");
    assert.match(written, /diffchecker/);
    assert.ok(!written.includes(root));
    assert.ok(!written.includes("{{CODEDIFF_BIN}}"));
    const before = await stat(file);
    const second = run("--target", dir);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /unchanged/);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("all targets are preflighted before writing and conflicting bytes survive", async () => {
  const dir = await temp();
  try {
    const fresh = join(dir, "fresh");
    const existing = join(dir, "existing");
    const file = join(existing, "codediff-show", "SKILL.md");
    await mkdir(join(existing, "codediff-show"), { recursive: true });
    const bytes = Buffer.from([0, 255, 12, 65]);
    await writeFile(file, bytes);
    const result = run("--target", fresh, "--target", existing);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Skill conflict.*another --target/);
    assert.deepEqual(await readFile(file), bytes);
    await assert.rejects(access(fresh));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dry run reports plans without creating directories", async () => {
  const dir = await temp();
  try {
    const target = join(dir, "new");
    const result = run("--target", target, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /would write/);
    await assert.rejects(access(target));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("parent file collisions and linked destinations are refused before any writes", async () => {
  const dir = await temp();
  try {
    const fresh = join(dir, "fresh");
    const collision = join(dir, "collision");
    await writeFile(collision, "keep");
    const badParent = run("--target", fresh, "--target", collision);
    assert.equal(badParent.status, 1);
    await assert.rejects(access(fresh));
    assert.equal(await readFile(collision, "utf8"), "keep");
    const actual = join(dir, "actual");
    const link = join(dir, "link");
    await mkdir(actual);
    await symlink(actual, link, process.platform === "win32" ? "junction" : "dir");
    const linked = run("--target", fresh, "--target", link);
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /Unsafe setup directory/);
    await assert.rejects(access(fresh));
    await assert.rejects(access(join(actual, "codediff-show")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("overlapping destinations and duplicate targets cannot cause partial installs", async () => {
  const dir = await temp();
  try {
    const fresh = join(dir, "fresh");
    const nested = join(fresh, "codediff-show", "SKILL.md");
    const overlap = run("--target", fresh, "--target", nested);
    assert.equal(overlap.status, 1);
    assert.match(overlap.stderr, /Overlapping skill targets/);
    await assert.rejects(access(fresh));
    const repeated = run("--target", fresh, "--target", fresh);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout.trim().split("\n").length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

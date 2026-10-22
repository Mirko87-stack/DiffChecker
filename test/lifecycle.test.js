import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/codediff.js", import.meta.url));

// The real inbox of the session running the tests must never be reached.
const { CLAUDE_CODE_MESSAGING_SOCKET: _socket, CLAUDE_CODE_MESSAGING_TOKEN: _token, ...cleanEnv } = process.env;

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: cleanEnv, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

const answers = async (url) => {
  try {
    return (await fetch(`${url}api/status`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
};

// A repo with one commit and one change; every server it starts is killed afterwards.
function repoFixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "codediff-lifecycle-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.js"), "const a = 1;\n");
  git("add", "a.js");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.js"), "const a = 2;\n");
  const pids = [];
  t.after(async () => {
    for (const pid of pids) if (alive(pid)) process.kill(pid);
    await until(() => pids.every((pid) => !alive(pid)), 3000);
    rmSync(repo, { recursive: true, force: true });
  });
  const codediff = (name) => join(repo, ".codediff", name);
  const open = async (...flags) => {
    const opened = await cli(["open", "--detach", "--no-open", "--no-wake", "--port", "0", "--repo", repo, ...flags]);
    assert.equal(opened.code, 0, opened.stderr + opened.stdout);
    const info = JSON.parse(readFileSync(codediff("server.json"), "utf8"));
    pids.push(info.pid);
    return info;
  };
  return { repo, open, codediff };
}

test("a closed review nobody waited for leaves its result, the server exits, and wait reads it once", async (t) => {
  const { repo, open, codediff } = repoFixture(t);
  const { url, pid } = await open("--live", "--exit-after-close", "1");
  await fetch(`${url}api/review/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: "Ship it" }),
  });
  assert.ok(await until(() => !alive(pid), 6000), "the server exits after the delay");
  assert.ok(!existsSync(codediff("server.json")));
  const saved = JSON.parse(readFileSync(codediff("review-result.json"), "utf8"));
  assert.equal(saved.status, "closed");
  assert.equal(saved.feedback, "Ship it");
  assert.equal(saved.url, url);
  assert.equal(saved.pid, pid);
  assert.equal(typeof saved.closedAt, "string");

  const waited = await cli(["wait", "--repo", repo, "--timeout", "1"]);
  assert.equal(waited.code, 0, waited.stderr);
  const reply = JSON.parse(waited.stdout);
  assert.equal(reply.status, "closed");
  assert.equal(reply.feedback, "Ship it");
  assert.equal(reply.reason, "reviewer finished");
  assert.equal(reply.decision, "changes");
  assert.equal(reply.next, "The review is over. Summarise the feedback for the user and act on it.");
  assert.ok(!existsSync(codediff("review-result.json")), "the result is consumed once");

  assert.equal(JSON.parse((await cli(["wait", "--repo", repo, "--timeout", "1"])).stdout).status, "gone");
});

test("an approval nobody waited for is saved, and a later wait tells the agent to finish", async (t) => {
  const { repo, open, codediff } = repoFixture(t);
  const { url, pid } = await open("--live", "--exit-after-close", "1");
  await fetch(`${url}api/review/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.ok(await until(() => !alive(pid), 6000), "the server exits after the delay");
  const saved = JSON.parse(readFileSync(codediff("review-result.json"), "utf8"));
  assert.equal(saved.decision, "approved");
  assert.equal(saved.reason, "reviewer approved");

  const reply = JSON.parse((await cli(["wait", "--repo", repo, "--timeout", "1"])).stdout);
  assert.equal(reply.status, "closed");
  assert.equal(reply.decision, "approved");
  assert.equal(
    reply.next,
    "The reviewer approved the diff. Tell the user and finish the task; make no further changes unless asked.",
  );
});

test("open stops the previous server of the repo, and stop stops the current one", async (t) => {
  const { repo, open, codediff } = repoFixture(t);
  const first = await open("--live");
  const second = await open("--live");
  assert.notEqual(second.pid, first.pid);
  assert.equal(await answers(first.url), false, "the first server no longer answers");
  assert.ok(await until(() => !alive(first.pid), 5000));
  assert.equal(await answers(second.url), true);

  const stopped = await cli(["stop", "--repo", repo]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { ok: true });
  assert.ok(await until(() => !alive(second.pid), 5000));
  assert.equal(JSON.parse(readFileSync(codediff("review-result.json"), "utf8")).reason, "stopped");
  assert.deepEqual(JSON.parse((await cli(["stop", "--repo", repo])).stdout), { status: "not running" });
});

test("open removes a server.json whose server no longer answers", async (t) => {
  const { repo, open, codediff } = repoFixture(t);
  mkdirSync(join(repo, ".codediff"), { recursive: true });
  writeFileSync(codediff("server.json"), JSON.stringify({ url: "http://127.0.0.1:9/", pid: 999999, live: true }));
  const info = await open("--live");
  assert.notEqual(info.pid, 999999);
  assert.equal(await answers(info.url), true);
});

test("an idle timeout ends a server nobody visited", async (t) => {
  const { open, codediff } = repoFixture(t);
  const { pid } = await open("--live", "--idle-timeout", "1", "--exit-after-close", "0");
  assert.ok(await until(() => !alive(pid), 6000), "the idle server exits");
  assert.equal(JSON.parse(readFileSync(codediff("review-result.json"), "utf8")).reason, "idle");
});

test("a non-live server exits once its last tab has closed", async (t) => {
  const { open, codediff } = repoFixture(t);
  const { url, pid } = await open();
  const post = (path) => fetch(`${url}${path}`, { method: "POST", body: JSON.stringify({ tab: "t1" }) });
  await post("api/heartbeat");
  await post("api/heartbeat?closing=1");
  assert.ok(await until(() => !alive(pid), 10_000), "the server exits after the closing grace");
  assert.ok(!existsSync(codediff("review-result.json")), "no agent waits, so no result file");
});

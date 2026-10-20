import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";

const BIN = fileURLToPath(new URL("../bin/codediff.js", import.meta.url));

// The real inbox of the session running the tests must never be reached: drop it, add a fake one per call.
const { CLAUDE_CODE_MESSAGING_SOCKET: _socket, CLAUDE_CODE_MESSAGING_TOKEN: _token, ...cleanEnv } = process.env;

// Runs the CLI to completion; resolves with exit code and stdout.
function cli(args, { input = "", cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...cleanEnv, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// A stand-in for the Claude Code inbox (see test/inbox.test.js); each connection becomes its parsed lines.
async function fakeInbox(t) {
  const dir = process.platform === "win32" ? null : mkdtempSync(join(tmpdir(), "codediff-inbox-"));
  const socket = dir ? join(dir, "inbox.sock") : `\\\\.\\pipe\\codediff-test-${randomUUID()}`;
  const messages = [];
  const server = createServer((connection) => {
    let buffer = "";
    connection.on("data", (chunk) => (buffer += chunk));
    connection.on("end", () => {
      messages.push(buffer.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
      connection.end();
    });
  });
  await new Promise((r) => server.listen(socket, r));
  t.after(() => {
    server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return { socket, messages };
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
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

test("open --detach, wait, answer and close drive a live review end to end", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "codediff-cli-live-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.js"), "const a = 1;\n");
  git("add", "a.js");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.js"), "const a = 2;\n");

  let pid = null;
  t.after(async () => {
    if (pid && alive(pid)) process.kill(pid);
    await until(() => !pid || !alive(pid), 3000);
    rmSync(repo, { recursive: true, force: true });
  });

  // The detached server inherits the inbox address from the agent's command.
  const inbox = await fakeInbox(t);
  const inboxEnv = { CLAUDE_CODE_MESSAGING_SOCKET: inbox.socket, CLAUDE_CODE_MESSAGING_TOKEN: "cli-token" };
  const opened = await cli(["open", "--live", "--detach", "--no-open", "--port", "0", "--repo", repo], { env: inboxEnv });
  assert.equal(opened.code, 0, opened.stderr);
  const url = opened.stdout.match(/running at (\S+)/)?.[1];
  assert.ok(url, opened.stdout);
  // The agent is told to start waiting now, with the real paths, and not to end its turn.
  assert.ok(opened.stdout.includes(`node "${BIN}" wait --repo "${resolve(repo)}"`), opened.stdout);
  assert.match(opened.stdout, /Do not end your turn while the review is open\./);
  const info = JSON.parse(readFileSync(join(repo, ".codediff", "server.json"), "utf8"));
  pid = info.pid;
  assert.equal(info.url, url);
  assert.equal(info.live, true);

  // The browser asks.
  const asked = await fetch(`${url}api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "a.js", hunk: { header: "@@ -1 +1 @@", lines: ["-const a = 1;", "+const a = 2;"] }, question: "Why 2?" }),
  });
  assert.equal(asked.status, 202);
  const { id } = await asked.json();
  assert.ok(await until(() => inbox.messages.length === 1, 3000), "the agent's session is notified");
  assert.deepEqual(inbox.messages[0][0], { type: "auth", token: "cli-token" });
  assert.ok(inbox.messages[0][1].message.content.includes(`node "${BIN}" wait --repo "${resolve(repo)}"`));

  const waited = await cli(["wait", "--repo", repo, "--timeout", "5"]);
  assert.equal(waited.code, 0, waited.stderr);
  const question = JSON.parse(waited.stdout);
  assert.equal(question.status, "question");
  assert.equal(question.id, id);
  assert.equal(question.question, "Why 2?");
  assert.equal(
    question.next,
    `Answer this question (pipe your answer to: node "${BIN}" answer --id ${id} --repo "${resolve(repo)}"), then run wait again.`,
  );

  const again = JSON.parse((await cli(["wait", "--repo", repo, "--timeout", "0"])).stdout);
  assert.equal(again.id, id, "an unanswered question is handed out again");
  assert.equal(again.redelivered, true);

  const answer = 'Two "quoted" lines:\n- first\n- `second`';
  const answered = await cli(["answer", "--id", String(id), "--repo", repo], { input: answer });
  assert.equal(answered.code, 0, answered.stderr);
  assert.deepEqual(JSON.parse(answered.stdout), { ok: true });
  assert.deepEqual(await (await fetch(`${url}api/chat/${id}`)).json(), { answer });

  // A requested fix: the agent edits the file and reports it, so the viewer can show the new diff.
  const fix = await (await fetch(`${url}api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "a.js", hunk: { header: "@@ -1 +1 @@", lines: [] }, question: "Make it 3" }),
  })).json();
  await cli(["wait", "--repo", repo, "--timeout", "5"]);
  writeFileSync(join(repo, "a.js"), "const a = 3;\n");
  const fixed = await cli(["answer", "--id", String(fix.id), "--changed", "a.js", "--repo", repo], { input: "Changed to 3." });
  assert.equal(fixed.code, 0, fixed.stderr);
  assert.deepEqual(JSON.parse(fixed.stdout), { ok: true, revision: 1 });
  assert.deepEqual(await (await fetch(`${url}api/chat/${fix.id}`)).json(), { answer: "Changed to 3.", changed: ["a.js"] });
  assert.match((await (await fetch(`${url}api/session`)).json()).diff, /\+const a = 3;/);

  writeFileSync(join(repo, "a.js"), "const a = 4;\n");
  const refreshed = await cli(["refresh", "--repo", repo]);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.deepEqual(JSON.parse(refreshed.stdout), { ok: true, revision: 2 });
  assert.equal((await (await fetch(`${url}api/status`)).json()).revision, 2);

  const idle = JSON.parse((await cli(["wait", "--repo", repo, "--timeout", "0"])).stdout);
  assert.deepEqual(idle, { status: "idle", next: "No question yet. Run wait again now; do not end your turn." });

  await fetch(`${url}api/review/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: "Ship it" }),
  });
  const closed = JSON.parse((await cli(["wait", "--url", url, "--timeout", "5"])).stdout);
  assert.equal(closed.status, "closed");
  assert.equal(closed.feedback, "Ship it");
  assert.equal(closed.transcript[0].answer, answer);
  assert.equal(closed.next, "The review is over. Summarise the feedback for the user and act on it.");

  assert.ok(await until(() => !alive(pid), 5000), "the detached server should exit after closed is delivered");
  assert.ok(await until(() => !existsSync(join(repo, ".codediff", "server.json")), 2000), "server.json should be removed");

  const gone = await cli(["wait", "--url", url, "--timeout", "1"]);
  assert.equal(gone.code, 0);
  assert.deepEqual(JSON.parse(gone.stdout), {
    status: "gone",
    next: "The viewer is not running. Tell the user and continue in the CLI.",
  });
});

test("open --no-wake ignores the inbox address in the environment", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "codediff-cli-nowake-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init");
  let pid = null;
  t.after(async () => {
    if (pid && alive(pid)) process.kill(pid);
    await until(() => !pid || !alive(pid), 3000);
    rmSync(repo, { recursive: true, force: true });
  });
  const inbox = await fakeInbox(t);
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: inbox.socket, CLAUDE_CODE_MESSAGING_TOKEN: "cli-token" };
  const opened = await cli(["open", "--live", "--detach", "--no-open", "--no-wake", "--port", "0", "--repo", repo], { env });
  assert.equal(opened.code, 0, opened.stderr);
  const url = opened.stdout.match(/running at (\S+)/)?.[1];
  pid = JSON.parse(readFileSync(join(repo, ".codediff", "server.json"), "utf8")).pid;
  assert.deepEqual((await (await fetch(`${url}api/status`)).json()).wake, { available: false, lastNotifiedAt: null });
  await fetch(`${url}api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "a.js", hunk: { header: "@@ -1 +1 @@", lines: [] }, question: "Q?" }),
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(inbox.messages.length, 0);
});

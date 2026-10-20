import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inboxFromEnv, postToInbox } from "../src/inbox.js";
import { startServer } from "../src/server.js";

const BIN = fileURLToPath(new URL("../bin/codediff.js", import.meta.url));
const hunk = { header: "@@ -1 +1 @@", lines: ["-old", "+new"] };
const session = { title: "T", summary: "", rationale: "", files: [], diff: "" };

// A stand-in for the Claude Code inbox: never the real one. Each connection becomes a list of parsed lines.
export async function fakeInbox(t) {
  let dir = null;
  let socket;
  if (process.platform === "win32") socket = `\\\\.\\pipe\\codediff-test-${randomUUID()}`;
  else {
    dir = mkdtempSync(join(tmpdir(), "codediff-inbox-"));
    socket = join(dir, "inbox.sock");
  }
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

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !check()) await pause(20);
  return check();
}

async function liveWithWake(t, { wake, wakeReminderMs } = {}) {
  const repo = tmpdir();
  const { server, url } = await startServer({ session, live: true, port: 0, repo, wake, wakeReminderMs });
  t.after(() => server.close());
  const call = async (path, body) => {
    const res = await fetch(`${url}${path}`, body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, url, repo };
}

const noteText = (message) => message[1].message.content;

test("postToInbox sends the auth line, then the user message", async (t) => {
  const inbox = await fakeInbox(t);
  await postToInbox({ socket: inbox.socket, token: "secret-token", text: "Hello there" });
  assert.ok(await until(() => inbox.messages.length === 1));
  assert.deepEqual(inbox.messages[0], [
    { type: "auth", token: "secret-token" },
    { type: "user", message: { role: "user", content: "Hello there" } },
  ]);
});

test("postToInbox rejects when nothing listens", async () => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\codediff-missing-${randomUUID()}` : join(tmpdir(), `codediff-missing-${randomUUID()}.sock`);
  await assert.rejects(postToInbox({ socket, token: "x", text: "y", timeoutMs: 1000 }));
});

test("inboxFromEnv needs both the socket and the token", () => {
  assert.deepEqual(
    inboxFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: "/s", CLAUDE_CODE_MESSAGING_TOKEN: "k" }),
    { socket: "/s", token: "k" },
  );
  assert.equal(inboxFromEnv({ CLAUDE_CODE_MESSAGING_SOCKET: "/s" }), null);
  assert.equal(inboxFromEnv({ CLAUDE_CODE_MESSAGING_TOKEN: "k" }), null);
  assert.equal(inboxFromEnv({}), null);
});

test("a question with no agent poll sends one note naming the count and the wait command", async (t) => {
  const inbox = await fakeInbox(t);
  const { call, url, repo } = await liveWithWake(t, { wake: { socket: inbox.socket, token: "tok" } });
  assert.deepEqual((await call("api/status")).body.wake, { available: true, lastNotifiedAt: null });
  await call("api/chat", { file: "a.js", hunk, question: "Why is the secret sauce here?" });
  assert.ok(await until(() => inbox.messages.length === 1));
  const [auth] = inbox.messages[0];
  assert.deepEqual(auth, { type: "auth", token: "tok" });
  const text = noteText(inbox.messages[0]);
  assert.ok(text.startsWith("DiffChecker: 1 review question(s) waiting in the viewer at "), text);
  assert.ok(text.includes(url), text);
  assert.ok(text.includes(`node "${BIN}" wait --repo "${resolve(repo)}"`), text);
  assert.ok(!text.includes("secret sauce"), "the note never carries the question text");
  // lastNotifiedAt is set once the post has completed, a moment after the inbox read it.
  let wake;
  for (let i = 0; i < 50 && typeof wake?.lastNotifiedAt !== "number"; i++, await pause(20)) wake = (await call("api/status")).body.wake;
  assert.equal(typeof wake.lastNotifiedAt, "number");

  // While that note is unanswered by a poll, more questions do not send more notes.
  await call("api/chat", { file: "a.js", hunk, question: "And this?" });
  await pause(200);
  assert.equal(inbox.messages.length, 1);
});

test("one reminder follows if questions are still queued and the agent has not polled", async (t) => {
  const inbox = await fakeInbox(t);
  const { call } = await liveWithWake(t, { wake: { socket: inbox.socket, token: "tok" }, wakeReminderMs: 200 });
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.ok(await until(() => inbox.messages.length === 2));
  await pause(500);
  assert.equal(inbox.messages.length, 2, "only one reminder");
});

test("no note while an agent poll is pending", async (t) => {
  const inbox = await fakeInbox(t);
  const { call } = await liveWithWake(t, { wake: { socket: inbox.socket, token: "tok" } });
  const waiting = call("api/agent/next?timeout=5");
  await pause(50);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.equal((await waiting).body.status, "question");
  await pause(200);
  assert.equal(inbox.messages.length, 0);
});

test("a poll clears the outstanding note, so the next queued question notes again", async (t) => {
  const inbox = await fakeInbox(t);
  const { call } = await liveWithWake(t, { wake: { socket: inbox.socket, token: "tok" } });
  await call("api/chat", { file: "a.js", hunk, question: "First?" });
  assert.ok(await until(() => inbox.messages.length === 1));
  assert.equal((await call("api/agent/next?timeout=1")).body.status, "question");
  await call("api/chat", { file: "a.js", hunk, question: "Second?" });
  assert.ok(await until(() => inbox.messages.length === 2));
  assert.match(noteText(inbox.messages[1]), /^DiffChecker: 1 review question\(s\)/);
});

test("without a wake address nothing is attempted", async (t) => {
  const { call } = await liveWithWake(t, { wake: null });
  assert.equal((await call("api/chat", { file: "a.js", hunk, question: "Q?" })).status, 202);
  assert.deepEqual((await call("api/status")).body.wake, { available: false, lastNotifiedAt: null });
});

test("an inbox that is not listening does not break the review", async (t) => {
  const socket = process.platform === "win32" ? `\\\\.\\pipe\\codediff-missing-${randomUUID()}` : join(tmpdir(), `codediff-missing-${randomUUID()}.sock`);
  const { call } = await liveWithWake(t, { wake: { socket, token: "tok" } });
  assert.equal((await call("api/chat", { file: "a.js", hunk, question: "Q?" })).status, 202);
  await pause(200);
  const status = (await call("api/status")).body;
  assert.equal(status.queued, 1);
  assert.deepEqual(status.wake, { available: true, lastNotifiedAt: null });
});

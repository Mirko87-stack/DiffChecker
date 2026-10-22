import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

const hunk = { header: "@@ -1 +1 @@", lines: ["-old", "+new"] };
const session = {
  title: "T",
  summary: "",
  rationale: "",
  files: [{ path: "a.js", note: "Note for a.js" }],
  diff: "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n",
};

async function live(t, options = {}) {
  const delivered = [];
  const { server, url } = await startServer({
    session,
    live: true,
    port: 0,
    bridge: { heartbeatGraceMs: 200, listeningWindowMs: 300, ...options },
    onClosedDelivered: () => delivered.push(Date.now()),
  });
  t.after(() => server.close());
  const call = async (path, body) => {
    const res = await fetch(`${url}${path}`, body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, delivered, url };
}

test("a question reaches the agent and its answer reaches the browser", async (t) => {
  const { call } = await live(t);
  const asked = await call("api/chat", { file: "a.js", hunk, question: "Why?" });
  assert.equal(asked.status, 202);
  assert.equal(asked.body.id, 1);

  const next = await call("api/agent/next?timeout=1");
  assert.deepEqual(next.body, {
    status: "question",
    id: 1,
    file: "a.js",
    hunkHeader: "@@ -1 +1 @@",
    lines: ["-old", "+new"],
    question: "Why?",
    note: "Note for a.js",
  });

  assert.deepEqual((await call("api/chat/1?wait=0")).body, { pending: true, state: "delivered" });
  const waiting = call("api/chat/1?wait=5");
  assert.equal((await call("api/agent/answer", { id: 1, answer: "Because." })).status, 200);
  assert.deepEqual((await waiting).body, { answer: "Because." });
  assert.deepEqual((await call("api/chat/1")).body, { answer: "Because." });
});

test("a waiting agent poll is woken by a new question", async (t) => {
  const { call } = await live(t);
  const waiting = call("api/agent/next?timeout=5");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("api/status")).body.agentListening, true);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  const next = await waiting;
  assert.equal(next.body.status, "question");
  assert.equal(next.body.question, "Q?");
});

test("agent poll times out as idle; status reports queue and presence", async (t) => {
  const { call } = await live(t);
  assert.deepEqual((await call("api/status")).body, {
    live: true, revision: 0, agentListening: false, agentLastSeen: null, queued: 0, closed: false,
    wake: { available: false, lastNotifiedAt: null },
  });
  assert.deepEqual((await call("api/agent/next?timeout=0.1")).body, { status: "idle" });
  assert.equal((await call("api/status")).body.agentListening, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call("api/status")).body.agentListening, false);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.equal((await call("api/status")).body.queued, 1);
});

test("a question moves from queued to delivered to answered", async (t) => {
  const { call } = await live(t);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.deepEqual((await call("api/chat/1")).body, { pending: true, state: "queued" });
  await call("api/agent/next?timeout=1");
  assert.deepEqual((await call("api/chat/1")).body, { pending: true, state: "delivered" });
  await call("api/agent/answer", { id: 1, answer: "A." });
  assert.deepEqual((await call("api/chat/1")).body, { answer: "A." });
});

test("a browser waiting on a queued question learns at once when the agent takes it", async (t) => {
  const { call } = await live(t);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  const started = Date.now();
  const waiting = call("api/chat/1?wait=5&state=queued");
  await new Promise((r) => setTimeout(r, 50));
  await call("api/agent/next?timeout=1");
  assert.deepEqual((await waiting).body, { pending: true, state: "delivered" });
  assert.ok(Date.now() - started < 2000);
  // A state the browser does not know yet comes back without waiting.
  assert.deepEqual((await call("api/chat/1?wait=5&state=queued")).body, { pending: true, state: "delivered" });
});

test("an unanswered delivered question is handed out again before newer ones", async (t) => {
  const { call } = await live(t);
  await call("api/chat", { file: "a.js", hunk, question: "First?" });
  const first = await call("api/agent/next?timeout=1");
  assert.equal(first.body.id, 1);
  assert.equal(first.body.redelivered, undefined);
  await call("api/chat", { file: "a.js", hunk, question: "Second?" });
  const again = await call("api/agent/next?timeout=1");
  assert.equal(again.body.id, 1);
  assert.equal(again.body.redelivered, true);
  await call("api/agent/answer", { id: 1, answer: "A." });
  const second = await call("api/agent/next?timeout=1");
  assert.equal(second.body.id, 2);
  assert.equal(second.body.redelivered, undefined);
});

test("agentLastSeen is null before any poll, 0 during one, then grows", async (t) => {
  const { call } = await live(t);
  assert.equal((await call("api/status")).body.agentLastSeen, null);
  const waiting = call("api/agent/next?timeout=0.2");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("api/status")).body.agentLastSeen, 0);
  await waiting;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok((await call("api/status")).body.agentLastSeen > 0);
});

test("a newer agent poll replaces an older one", async (t) => {
  const { call } = await live(t);
  const older = call("api/agent/next?timeout=5");
  await new Promise((r) => setTimeout(r, 50));
  const newer = call("api/agent/next?timeout=5");
  assert.deepEqual((await older).body, { status: "idle" });
  await new Promise((r) => setTimeout(r, 50));
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.equal((await newer).body.status, "question");
});

test("closing with feedback ends the agent loop with a transcript", async (t) => {
  const { call, delivered } = await live(t);
  await call("api/chat", { file: "a.js", hunk, question: "Why?" });
  await call("api/agent/next?timeout=1");
  await call("api/agent/answer", { id: 1, answer: "Because." });
  const waiting = call("api/agent/next?timeout=5");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await call("api/review/close", { feedback: "Looks good" })).status, 200);
  assert.deepEqual((await waiting).body, {
    status: "closed",
    feedback: "Looks good",
    reason: "reviewer finished",
    transcript: [{ file: "a.js", hunkHeader: "@@ -1 +1 @@", question: "Why?", answer: "Because." }],
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(delivered.length, 1);
  assert.equal((await call("api/status")).body.closed, true);
  assert.equal((await call("api/chat", { file: "a.js", hunk, question: "Late?" })).status, 409);
});

test("a viewer that stops sending heartbeats closes the review", async (t) => {
  const { call } = await live(t);
  assert.equal((await call("api/heartbeat", {})).status, 200);
  const next = await call("api/agent/next?timeout=3");
  assert.equal(next.body.status, "closed");
  assert.equal(next.body.feedback, "");
  assert.equal(next.body.reason, "viewer closed");
});

test("a hidden tab gets the longer grace", async (t) => {
  const { call } = await live(t, { hiddenGraceMs: 5000 });
  await call("api/heartbeat", { hidden: true });
  await new Promise((r) => setTimeout(r, 350));
  assert.equal((await call("api/status")).body.closed, false);
});

// sendBeacon posts a string as text/plain; an empty body is an anonymous tab.
async function beacon(t, options) {
  const ctx = await live(t, { heartbeatGraceMs: 5000, closingGraceMs: 150, ...options });
  const { url } = ctx;
  const post = async (path, body) => (await fetch(`${url}${path}`, {
    method: "POST", headers: { "content-type": "text/plain;charset=UTF-8" }, body,
  })).status;
  const closed = async () => (await ctx.call("api/status")).body.closed;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return { ...ctx, post, closed, sleep };
}

test("a closing beacon from the only tab closes the review after the grace", async (t) => {
  const { call, post, closed, sleep } = await beacon(t);
  assert.equal(await post("api/heartbeat", JSON.stringify({ tab: "a" })), 200);
  assert.equal(await post("api/heartbeat?closing=1", JSON.stringify({ tab: "a" })), 200);
  assert.equal(await closed(), false);
  const next = await call("api/agent/next?timeout=3");
  assert.equal(next.body.status, "closed");
  assert.equal(next.body.reason, "viewer closed");
  assert.equal(next.body.feedback, "");
  assert.equal(await post("api/heartbeat?closing=1", JSON.stringify({ tab: "a" })), 200);
  assert.equal(await post("api/heartbeat", ""), 200);
  await sleep(50);
  assert.equal(await closed(), true);
});

// Closing a tab hides it first, so a hidden beat can land after the closing beacon.
test("a late heartbeat from a tab that already said it is closing does not revive it", async (t) => {
  const { post, closed, sleep } = await beacon(t);
  await post("api/heartbeat", JSON.stringify({ tab: "a" }));
  await post("api/heartbeat?closing=1", JSON.stringify({ tab: "a" }));
  await post("api/heartbeat", JSON.stringify({ tab: "a", hidden: true }));
  await sleep(300);
  assert.equal(await closed(), true);
});

test("a reload's new tab heartbeat during the grace keeps the review open", async (t) => {
  const { post, closed, sleep } = await beacon(t);
  await post("api/heartbeat", JSON.stringify({ tab: "old" }));
  await post("api/heartbeat?closing=1", JSON.stringify({ tab: "old" }));
  await sleep(30);
  await post("api/heartbeat", JSON.stringify({ tab: "new" }));
  await sleep(300);
  assert.equal(await closed(), false);
});

test("with two tabs the review ends only after the last one closes", async (t) => {
  const { post, closed, sleep } = await beacon(t);
  await post("api/heartbeat", JSON.stringify({ tab: "a" }));
  await post("api/heartbeat", JSON.stringify({ tab: "b" }));
  await post("api/heartbeat?closing=1", JSON.stringify({ tab: "a" }));
  await sleep(300);
  assert.equal(await closed(), false);
  await post("api/heartbeat?closing=1", JSON.stringify({ tab: "b" }));
  await sleep(300);
  assert.equal(await closed(), true);
});

test("an empty heartbeat body counts as an anonymous tab", async (t) => {
  const { post, closed, sleep } = await beacon(t);
  assert.equal(await post("api/heartbeat", ""), 200);
  assert.equal(await post("api/heartbeat?closing=1", ""), 200);
  await sleep(300);
  assert.equal(await closed(), true);
});

test("one tab timing out leaves the review open while another still beats", async (t) => {
  const { post, closed, sleep } = await beacon(t, { heartbeatGraceMs: 150 });
  await post("api/heartbeat", JSON.stringify({ tab: "a" }));
  await post("api/heartbeat", JSON.stringify({ tab: "b", hidden: true }));
  await sleep(300);
  assert.equal(await closed(), false);
});

test("without any heartbeat the review stays open", async (t) => {
  const { call } = await live(t);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await call("api/status")).body.closed, false);
});

test("unknown ids and double answers are refused", async (t) => {
  const { call } = await live(t);
  assert.equal((await call("api/chat/9")).status, 404);
  assert.equal((await call("api/agent/answer", { id: 9, answer: "x" })).status, 404);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.equal((await call("api/agent/answer", { id: 1, answer: "x" })).status, 200);
  assert.equal((await call("api/agent/answer", { id: 1, answer: "y" })).status, 409);
});

test("a malformed question is rejected", async (t) => {
  const { call } = await live(t);
  assert.equal((await call("api/chat", { file: "a.js", hunk, question: "" })).status, 400);
  assert.equal((await call("api/chat", { file: "a.js", question: "Q?" })).status, 400);
});

test("non-live chat still answers synchronously through the command", async (t) => {
  const command = `node -e "process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.stdout.write('cmd answer'))"`;
  const { server, url } = await startServer({ session, chat: { kind: "command", command }, port: 0 });
  t.after(() => server.close());
  const res = await fetch(`${url}api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: "a.js", hunk, question: "Q?" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { answer: "cmd answer" });
  const status = await (await fetch(`${url}api/status`)).json();
  assert.equal(status.live, false);
});

// A real repo so refresh can re-run git diff after the agent edits a file.
async function liveGit(t, extra = {}) {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { getDiff } = await import("../src/git.js");
  const repo = mkdtempSync(join(tmpdir(), "codediff-refresh-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, "a.js"), "const a = 1;\n");
  git("add", "a.js");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.js"), "const a = 2;\n");
  const gitSession = { title: "T", summary: "", rationale: "", files: [], diff: await getDiff({ repo, base: "HEAD" }) };
  const { server, url } = await startServer({ session: gitSession, live: true, repo, base: "HEAD", port: 0, ...extra });
  t.after(() => {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  });
  const call = async (path, body) => {
    const res = await fetch(`${url}${path}`, body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, edit: (text) => writeFileSync(join(repo, "a.js"), text) };
}

test("refresh reloads the diff and bumps the revision", async (t) => {
  const { call, edit } = await liveGit(t);
  assert.equal((await call("api/status")).body.revision, 0);
  assert.equal((await call("api/session")).body.revision, 0);
  edit("const a = 3;\n");
  const refreshed = await call("api/agent/refresh", {});
  assert.deepEqual(refreshed, { status: 200, body: { ok: true, revision: 1 } });
  const session = (await call("api/session")).body;
  assert.equal(session.revision, 1);
  assert.match(session.diff, /\+const a = 3;/);
  assert.equal((await call("api/status")).body.revision, 1);
});

test("an answer with changed paths refreshes the diff and carries them", async (t) => {
  const { call, edit } = await liveGit(t);
  await call("api/chat", { file: "a.js", hunk, question: "Use 4?" });
  edit("const a = 4;\n");
  const answered = await call("api/agent/answer", { id: 1, answer: "Done.", changed: ["a.js"] });
  assert.deepEqual(answered, { status: 200, body: { ok: true, revision: 1 } });
  assert.deepEqual((await call("api/chat/1")).body, { answer: "Done.", changed: ["a.js"] });
  assert.match((await call("api/session")).body.diff, /\+const a = 4;/);
});

test("changed must be a list of paths", async (t) => {
  const { call } = await liveGit(t);
  await call("api/chat", { file: "a.js", hunk, question: "Q?" });
  assert.equal((await call("api/agent/answer", { id: 1, answer: "x", changed: "a.js" })).status, 400);
});

test("a session with an inline diff cannot be refreshed", async (t) => {
  const { call } = await live(t);
  assert.equal((await call("api/agent/refresh", {})).status, 409);
  const { call: inlineCall } = await liveGit(t, { inlineDiff: true });
  assert.equal((await inlineCall("api/agent/refresh", {})).status, 409);
});

// The CLI hooks onClosed to write the result file and schedule its exit.
async function lifecycle(t, bridge = {}) {
  const closings = [];
  const shutdowns = [];
  const { server, url } = await startServer({
    session, live: true, port: 0, bridge: { heartbeatGraceMs: 200, ...bridge },
    onClosed: (payload) => closings.push(payload), onShutdown: () => shutdowns.push(Date.now()),
  });
  t.after(() => server.close());
  const call = async (path, body) => {
    const res = await fetch(`${url}${path}`, body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const closed = async () => (await call("api/status")).body.closed;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return { call, closings, shutdowns, closed, sleep };
}

test("onClosed fires once with the closed payload when the reviewer finishes", async (t) => {
  const { call, closings, sleep } = await lifecycle(t);
  await call("api/chat", { file: "a.js", hunk, question: "Why?" });
  await call("api/review/close", { feedback: "Ship it" });
  await call("api/review/close", { feedback: "Again" });
  await sleep(50);
  assert.deepEqual(closings, [{
    status: "closed",
    feedback: "Ship it",
    reason: "reviewer finished",
    transcript: [{ file: "a.js", hunkHeader: "@@ -1 +1 @@", question: "Why?", answer: null }],
  }]);
});

test("onClosed reports a viewer that stopped beating", async (t) => {
  const { call, closings, sleep } = await lifecycle(t);
  await call("api/heartbeat", { tab: "a" });
  await sleep(400);
  assert.equal(closings.length, 1);
  assert.equal(closings[0].reason, "viewer closed");
});

test("an idle timeout closes a review nobody visited or polled", async (t) => {
  const { closings, closed, sleep } = await lifecycle(t, { idleTimeoutMs: 150 });
  await sleep(400);
  assert.equal(await closed(), true);
  assert.equal(closings.length, 1);
  assert.equal(closings[0].reason, "idle");
  assert.equal(closings[0].feedback, "");
});

test("a heartbeat cancels the idle timeout", async (t) => {
  const { call, closings, closed, sleep } = await lifecycle(t, { idleTimeoutMs: 150, heartbeatGraceMs: 5000 });
  await call("api/heartbeat", { tab: "a" });
  await sleep(400);
  assert.equal(await closed(), false);
  assert.equal(closings.length, 0);
});

test("an agent poll resets the idle timeout, and a pending poll holds it off", async (t) => {
  const { call, closings, closed, sleep } = await lifecycle(t, { idleTimeoutMs: 400 });
  await sleep(250);
  assert.deepEqual((await call("api/agent/next?timeout=0")).body, { status: "idle" });
  await sleep(250);
  assert.equal(await closed(), false, "the poll restarted the idle clock");
  assert.deepEqual((await call("api/agent/next?timeout=0.6")).body, { status: "idle" }, "a pending poll is not cut short");
  assert.equal(await closed(), false);
  await sleep(700);
  assert.equal(await closed(), true);
  assert.equal(closings[0].reason, "idle");
});

test("an idle timeout of 0 never closes the review", async (t) => {
  const { closed, sleep } = await lifecycle(t, { idleTimeoutMs: 0 });
  await sleep(200);
  assert.equal(await closed(), false);
});

test("shutdown closes the review as stopped and asks the process to exit", async (t) => {
  const { call, closings, shutdowns, closed, sleep } = await lifecycle(t);
  assert.deepEqual(await call("api/shutdown", {}), { status: 200, body: { ok: true } });
  await sleep(50);
  assert.equal(await closed(), true);
  assert.equal(closings.length, 1);
  assert.equal(closings[0].reason, "stopped");
  assert.equal(shutdowns.length, 1);
});

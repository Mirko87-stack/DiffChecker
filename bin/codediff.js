#!/usr/bin/env node
// CLI entry point. `open` (the default) starts the viewer; `wait`, `answer` and `refresh` let the
// agent that opened it in live mode receive the reviewer's questions, reply, and report edited files.
// `stop` ends the repo's viewer. A viewer never outlives its review: see open() for when it exits.
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSession } from "../src/session.js";
import { startServer } from "../src/server.js";
import { openBrowser } from "../src/open-browser.js";
import { resolveChatConfig } from "../src/chat.js";
import { inboxFromEnv } from "../src/inbox.js";

import { runSetupCommand } from "../src/setup.js";

const COMMANDS = ["open", "wait", "answer", "refresh", "stop"];
const BIN = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const command = COMMANDS.includes(argv[0]) ? argv.shift() : "open";

const commonOptions = {
  repo: { type: "string", short: "r", default: process.cwd() },
  url: { type: "string" },
};

if (["setup", "doctor", "--help", "--version"].includes(argv[0])) runSetupCommand(argv.shift(), argv);
else if (command === "open") await open(argv);
else if (command === "wait") await wait(argv);
else if (command === "answer") await answer(argv);
else if (command === "stop") await stop(argv);
else await refresh(argv);

async function open(args) {
  const { values } = parseArgs({
    args,
    options: {
      ...commonOptions,
      session: { type: "string", short: "s" },
      base: { type: "string", short: "b", default: "HEAD" },
      port: { type: "string", short: "p", default: "0" },
      "no-open": { type: "boolean", default: false },
      "chat-cmd": { type: "string" },
      "chat-url": { type: "string" },
      "chat-model": { type: "string" },
      live: { type: "boolean", default: false },
      detach: { type: "boolean", default: false },
      "no-wake": { type: "boolean", default: false },
      "exit-after-close": { type: "string", default: "60" },
      "idle-timeout": { type: "string", default: "1800" },
    },
  });
  codediffDir(values.repo);
  const infoFile = serverInfoPath(values.repo);
  // One viewer per repo: a previous one would keep its port and answer a later wait.
  await stopServer({ repo: values.repo });
  if (values.detach) return detach(args, values.repo, infoFile);

  const session = await loadSession({ sessionPath: values.session, repo: values.repo, base: values.base });
  const chat = resolveChatConfig({
    flags: { chatCmd: values["chat-cmd"], chatUrl: values["chat-url"], chatModel: values["chat-model"] },
    session,
  });
  const live = values.live || session.chat?.live === true;
  const inlineDiff = values.session ? readJsonFile(values.session)?.diff !== undefined : false;

  let server;
  let url = "";
  const resultFile = resultPath(values.repo);
  const forgetServer = () => {
    // Only remove the file if it still describes this process (a newer viewer may have replaced it).
    try {
      if (JSON.parse(readFileSync(infoFile, "utf8")).pid === process.pid) rmSync(infoFile);
    } catch {}
  };
  // Once the agent has the final "closed" reply there is nobody left to serve.
  let exiting = false;
  const exit = () => {
    if (exiting) return;
    exiting = true;
    forgetServer();
    server?.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  // Live: keep the closed reply in a file so a later wait still gets it, then exit after a while
  // unless an agent poll takes the reply sooner. Non-live: nobody waits for a reply, so exit at once.
  const onClosed = (payload) => {
    if (!live) return exit();
    try {
      writeFileSync(resultFile, JSON.stringify({ ...payload, closedAt: new Date().toISOString(), url, pid: process.pid }, null, 2));
    } catch (error) {
      console.error(`Could not save the review result: ${error.message}`);
    }
    setTimeout(exit, secondsOption(values["exit-after-close"], 60));
  };
  const onClosedDelivered = () => {
    try {
      if (readJsonFile(resultFile)?.pid === process.pid) rmSync(resultFile);
    } catch {}
    exit();
  };
  const started = await startServer({
    session, chat, live, inlineDiff, repo: values.repo, base: values.base, port: Number(values.port),
    onClosed, onClosedDelivered, onShutdown: exit,
    bridge: { idleTimeoutMs: secondsOption(values["idle-timeout"], 1800) },
    wake: values["no-wake"] ? null : inboxFromEnv(),
  });
  server = started.server;
  url = started.url;
  writeServerInfo(infoFile, { url: started.url, pid: process.pid, live });
  process.on("exit", forgetServer);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));

  console.log(`DiffChecker running at ${started.url}`);
  if (!values["no-open"]) openBrowser(started.url);
}

// Starts the same command in a background process and returns once it has published its URL.
// The child inherits the environment, so it can reach the inbox of the session that ran the command.
async function detach(args, repo, infoFile) {
  rmSync(infoFile, { force: true });
  const log = openSync(join(codediffDir(repo), "server.log"), "w");
  const child = spawn(process.execPath, [BIN, "open", ...args.filter((a) => a !== "--detach")], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  closeSync(log);
  let exited = null;
  child.on("exit", (code) => (exited = code));
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && exited === null) {
    const info = readJsonFile(infoFile);
    if (info?.pid === child.pid) {
      console.log(`DiffChecker running at ${info.url}`);
      if (info.live) console.log(liveNextStep(repo));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`DiffChecker did not start; see ${join(repo, ".codediff", "server.log")}`);
  process.exit(1);
}

// Agents tend to end their turn once the viewer is up, leaving the reviewer's questions unanswered.
function liveNextStep(repo) {
  return [
    "",
    "Live review is open. Next: run",
    `  node "${BIN}" wait --repo "${resolve(repo)}"`,
    "now and keep looping (answer each question, then wait again) until wait prints closed or gone.",
    "Do not end your turn while the review is open.",
  ].join("\n");
}

// Every wait reply says what to do next, so the agent does not have to remember the loop.
function nextStep(reply, target) {
  if (reply.status === "question") {
    return `Answer this question (pipe your answer to: node "${BIN}" answer --id ${reply.id} ${target}), then run wait again.`;
  }
  if (reply.status === "idle") return "No question yet. Run wait again now; do not end your turn.";
  if (reply.status === "closed") return "The review is over. Summarise the feedback for the user and act on it.";
  return "The viewer is not running. Tell the user and continue in the CLI.";
}

// One long-poll for the next question. An unreachable server means the review is over.
async function wait(args) {
  const { values } = parseArgs({ args, options: { ...commonOptions, timeout: { type: "string", default: "540" } } });
  const base = serverUrl(values);
  const timeout = Number(values.timeout);
  let reply = { status: "gone" };
  if (base) {
    try {
      const res = await fetch(new URL(`api/agent/next?timeout=${timeout}`, base), {
        signal: AbortSignal.timeout((timeout + 15) * 1000),
      });
      if (res.ok) reply = await res.json();
    } catch {}
  }
  // The viewer exits a while after the review closes; its saved reply is handed out once.
  if (reply.status === "gone") {
    const file = resultPath(values.repo);
    const saved = readJsonFile(file);
    if (saved?.status === "closed" && (!values.url || saved.url === values.url)) {
      reply = saved;
      rmSync(file, { force: true });
    }
  }
  const target = values.url ? `--url "${values.url}"` : `--repo "${resolve(values.repo)}"`;
  console.log(JSON.stringify({ ...reply, next: nextStep(reply, target) }, null, 2));
}

async function stop(args) {
  const { values } = parseArgs({ args, options: commonOptions });
  console.log(JSON.stringify((await stopServer(values)) ? { ok: true } : { status: "not running" }));
}

// Asks the viewer to stop and waits briefly until it no longer answers. Only a server that answers
// like DiffChecker is asked; a server.json nobody answers for is stale and removed (never kill by pid).
async function stopServer({ url, repo }) {
  const infoFile = serverInfoPath(repo);
  const base = url ?? readJsonFile(infoFile)?.url;
  if (!base) return false;
  if (!(await isDiffChecker(base))) {
    if (!url) rmSync(infoFile, { force: true });
    return false;
  }
  await fetch(new URL("api/shutdown", base), { method: "POST", signal: AbortSignal.timeout(3000) }).catch(() => {});
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await isDiffChecker(base))) await new Promise((r) => setTimeout(r, 100));
  return true;
}

async function isDiffChecker(base) {
  try {
    const res = await fetch(new URL("api/status", base), { signal: AbortSignal.timeout(1500) });
    const status = await res.json();
    return typeof status.live === "boolean" && typeof status.closed === "boolean" && typeof status.revision === "number";
  } catch {
    return false;
  }
}

// The answer comes on stdin so Markdown, quotes and newlines need no shell quoting.
// --changed (repeatable) names the files edited for a requested fix; the server reloads the diff.
async function answer(args) {
  const { values } = parseArgs({
    args,
    options: { ...commonOptions, id: { type: "string" }, changed: { type: "string", multiple: true } },
  });
  const id = Number(values.id);
  if (!Number.isInteger(id)) fail("answer needs --id <n>.");
  const base = serverUrl(values);
  if (!base) fail("No running DiffChecker found; pass --repo or --url.");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const body = { id, answer: text.trim(), ...(values.changed && { changed: values.changed }) };
  console.log(JSON.stringify(await post(base, "api/agent/answer", body)));
}

// Reload the diff after editing files outside an answer.
async function refresh(args) {
  const { values } = parseArgs({ args, options: commonOptions });
  const base = serverUrl(values);
  if (!base) fail("No running DiffChecker found; pass --repo or --url.");
  console.log(JSON.stringify(await post(base, "api/agent/refresh", {})));
}

// git diff on a large repo can take a while, so the timeout leaves room for the reload.
async function post(base, path, body) {
  let res;
  try {
    res = await fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    fail(`Cannot reach ${base}: ${error.message}`);
  }
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) fail(reply.error ?? `Server replied ${res.status}`);
  return reply;
}

function serverUrl({ url, repo }) {
  return url ?? readJsonFile(serverInfoPath(repo))?.url ?? null;
}

function resultPath(repo) {
  return join(resolve(repo), ".codediff", "review-result.json");
}

// A flag in seconds as milliseconds; anything but a number >= 0 means the default.
function secondsOption(value, fallback) {
  const n = Number(value);
  return (Number.isFinite(n) && n >= 0 ? n : fallback) * 1000;
}

function serverInfoPath(repo) {
  return join(resolve(repo), ".codediff", "server.json");
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeServerInfo(file, info) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(info, null, 2));
}

// The folder ignores itself, so session, server info and log never show up in the reviewed diff.
function codediffDir(repo) {
  const dir = join(resolve(repo), ".codediff");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) writeFileSync(join(dir, ".gitignore"), "*\n");
  return dir;
}

function fail(message) {
  console.log(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

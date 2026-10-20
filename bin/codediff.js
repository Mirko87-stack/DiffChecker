#!/usr/bin/env node
// CLI entry point. `open` (the default) starts the viewer; `wait`, `answer` and `refresh` let the
// agent that opened it in live mode receive the reviewer's questions, reply, and report edited files.
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

const COMMANDS = ["open", "wait", "answer", "refresh"];
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
    },
  });
  codediffDir(values.repo);
  const infoFile = serverInfoPath(values.repo);
  if (values.detach) return detach(args, values.repo, infoFile);

  const session = await loadSession({ sessionPath: values.session, repo: values.repo, base: values.base });
  const chat = resolveChatConfig({
    flags: { chatCmd: values["chat-cmd"], chatUrl: values["chat-url"], chatModel: values["chat-model"] },
    session,
  });
  const live = values.live || session.chat?.live === true;
  const inlineDiff = values.session ? readJsonFile(values.session)?.diff !== undefined : false;

  let server;
  const forgetServer = () => {
    // Only remove the file if it still describes this process (a newer viewer may have replaced it).
    try {
      if (JSON.parse(readFileSync(infoFile, "utf8")).pid === process.pid) rmSync(infoFile);
    } catch {}
  };
  // Once the agent has the final "closed" reply there is nobody left to serve.
  const exit = () => {
    forgetServer();
    server?.close();
    setTimeout(() => process.exit(0), 200).unref();
  };
  const started = await startServer({
    session, chat, live, inlineDiff, repo: values.repo, base: values.base, port: Number(values.port), onClosedDelivered: exit,
    wake: values["no-wake"] ? null : inboxFromEnv(),
  });
  server = started.server;
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
  const target = values.url ? `--url "${values.url}"` : `--repo "${resolve(values.repo)}"`;
  console.log(JSON.stringify({ ...reply, next: nextStep(reply, target) }, null, 2));
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

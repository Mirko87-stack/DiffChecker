// Minimal HTTP server on localhost: serves the static UI, the session JSON and the chat endpoints.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { askChat, buildPrompt } from "./chat.js";
import { createBridge } from "./bridge.js";
import { parseUnifiedDiff } from "../web/diff-parser.js";
import { getDiff, getFileAtBase } from "./git.js";

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/codediff.js", import.meta.url));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const MAX_ANSWER_WAIT_S = 60;
const MAX_AGENT_WAIT_S = 600;
const DEFAULT_AGENT_WAIT_S = 540;

// live: questions go to the agent that opened the viewer (see bridge.js) instead of a chat provider.
// onClosedDelivered runs once the agent has received the "closed" reply; the CLI exits there.
// onClosed(payload) runs once when the review closes for any reason; onShutdown after POST /api/shutdown.
// inlineDiff: the session file carried its own diff, so there is no git diff to reload.
// wake: the inbox of the Claude Code session that opened the viewer (see inbox.js), live mode only.
export function startServer({
  session, chat, repo, base = "HEAD", port = 0, live = false, inlineDiff = false, bridge: bridgeOptions, onClosedDelivered,
  onClosed, onShutdown, wake = null, wakeReminderMs, binPath = BIN,
}) {
  let diffPaths;
  let deleted;
  let revision = 0;
  const indexDiff = () => {
    diffPaths = new Set(parseUnifiedDiff(session.diff ?? "").map((f) => f.path));
    deleted = deletedPaths(session.diff ?? "");
  };
  indexDiff();
  let serverUrl = "";
  // Never the question text: the note only says how many wait and the exact command to fetch them.
  const wakeMessage = (count) => {
    const target = repo ? `--repo "${resolve(repo)}"` : `--url "${serverUrl}"`;
    return `DiffChecker: ${count} review question(s) waiting in the viewer at ${serverUrl}. `
      + `Run: node "${binPath}" wait ${target} — answer each question, then run wait again until it prints closed.`;
  };
  // Only the reviewer's own closing is worth a note; the feedback itself is fetched with wait.
  const closedMessage = (reason) => {
    const target = repo ? `--repo "${resolve(repo)}"` : `--url "${serverUrl}"`;
    if (reason === "reviewer approved") {
      return `DiffChecker: the reviewer approved the review at ${serverUrl}. Run: node "${binPath}" wait ${target} to get the result.`;
    }
    if (reason !== "reviewer finished" && reason !== "viewer closed") return null;
    return `DiffChecker: the review at ${serverUrl} was closed by the reviewer. `
      + `Run: node "${binPath}" wait ${target} to get the feedback.`;
  };
  const bridge = createBridge({
    session, ...bridgeOptions, wake: live ? wake : null, wakeMessage, closedMessage, reminderMs: wakeReminderMs, onClosed,
  });

  // The agent edited files (a fix the reviewer asked for): reload the diff so the viewer is not stale.
  const refresh = async () => {
    session.diff = await getDiff({ repo, base });
    indexDiff();
    return ++revision;
  };
  const refreshRefusal = () => {
    if (inlineDiff) return "The session has an inline diff; there is nothing to reload.";
    if (!repo) return "No repository configured.";
    return null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (path === "/api/file") {
      const requested = url.searchParams.get("path") ?? "";
      const side = url.searchParams.get("side") ?? "current";
      if (side !== "current" && side !== "base") return sendJson(res, 400, { error: "side must be base or current." });
      if (!repo) return sendJson(res, 404, { error: "No repository configured." });
      const absolute = resolveRepoFile(repo, requested, diffPaths);
      if (!absolute) return sendJson(res, 403, { error: "Path is not a file of this review." });
      const missing = { path: requested, content: "", exists: false };
      try {
        if (side === "base") {
          const posix = relative(resolve(repo), absolute).split(sep).join("/");
          const content = await getFileAtBase({ repo, base, path: posix });
          return sendJson(res, 200, content === null ? missing : { path: requested, content });
        }
        return sendJson(res, 200, { path: requested, content: await readFile(absolute, "utf8") });
      } catch {
        if (side === "current" && deleted.has(requested)) return sendJson(res, 200, missing);
        return sendJson(res, 404, { error: `Cannot read ${requested}.` });
      }
    }

    if (path === "/api/session") {
      // The chat config may hold a command line; the browser does not need it.
      const { chat: _chat, ...publicSession } = session;
      return sendJson(res, 200, { ...publicSession, revision });
    }

    if (path === "/api/status") return sendJson(res, 200, { live, revision, ...bridge.status() });

    if (path === "/api/agent/refresh" && req.method === "POST") {
      await readBody(req);
      const refusal = refreshRefusal();
      if (refusal) return sendJson(res, 409, { error: refusal });
      try {
        return sendJson(res, 200, { ok: true, revision: await refresh() });
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    if (path === "/api/chat" && req.method === "POST" && live) {
      const body = await readJson(req);
      if (!isQuestion(body)) return sendJson(res, 400, { error: "Expected { file, hunk: { header, lines }, question }." });
      const id = bridge.ask(body);
      if (id === null) return sendJson(res, 409, { error: "The review is closed." });
      return sendJson(res, 202, { id });
    }

    const answerMatch = path.match(/^\/api\/chat\/(\d+)$/);
    if (answerMatch && req.method === "GET") {
      const waitMs = seconds(url.searchParams.get("wait"), 0, MAX_ANSWER_WAIT_S);
      const reply = bridge.waitAnswer(Number(answerMatch[1]), waitMs, url.searchParams.get("state"));
      if (!reply) return sendJson(res, 404, { error: "Unknown question." });
      return sendJson(res, 200, await reply);
    }

    if (path === "/api/agent/next" && req.method === "GET") {
      const { promise, cancel } = bridge.next(seconds(url.searchParams.get("timeout"), DEFAULT_AGENT_WAIT_S, MAX_AGENT_WAIT_S));
      res.on("close", () => !res.writableEnded && cancel());
      const reply = await promise;
      if (reply.status === "closed" && onClosedDelivered) res.on("finish", onClosedDelivered);
      return sendJson(res, 200, reply);
    }

    if (path === "/api/agent/answer" && req.method === "POST") {
      const body = await readJson(req);
      const { changed } = body ?? {};
      const validChanged = changed === undefined || (Array.isArray(changed) && changed.every((p) => typeof p === "string"));
      if (!Number.isInteger(body?.id) || typeof body.answer !== "string" || !validChanged) {
        return sendJson(res, 400, { error: "Expected { id, answer, changed?: [paths] }." });
      }
      const verdict = bridge.canAnswer(body.id);
      if (verdict === "unknown") return sendJson(res, 404, { error: "Unknown question." });
      if (verdict === "duplicate") return sendJson(res, 409, { error: "Already answered." });
      // One call both reloads the diff and answers, so the browser never sees the answer before the new diff.
      let reloaded;
      if (changed?.length && !refreshRefusal()) {
        try {
          reloaded = await refresh();
        } catch (error) {
          return sendJson(res, 500, { error: `Could not reload the diff: ${error.message}` });
        }
      }
      // Another answer may have landed while the diff was reloading.
      if (bridge.answer(body.id, body.answer, changed?.length ? changed : undefined) !== "ok") {
        return sendJson(res, 409, { error: "Already answered." });
      }
      return sendJson(res, 200, reloaded === undefined ? { ok: true } : { ok: true, revision: reloaded });
    }

    // No decision means "changes": that is what the Done reviewing form meant before approvals existed.
    if (path === "/api/review/close" && req.method === "POST") {
      const body = await readJson(req);
      const decision = body?.decision === undefined ? "changes" : body.decision;
      if (decision !== "approved" && decision !== "changes") {
        return sendJson(res, 400, { error: "decision must be approved or changes." });
      }
      const reason = decision === "approved" ? "reviewer approved" : "reviewer finished";
      bridge.close(typeof body?.feedback === "string" ? body.feedback : "", reason, decision);
      return sendJson(res, 200, { ok: true });
    }

    // Sent by `stop` and by a newer `open` for the same repo; the server listens on loopback only anyway.
    if (path === "/api/shutdown" && req.method === "POST") {
      await readBody(req);
      if (!isLoopback(req.socket.remoteAddress)) return sendJson(res, 403, { error: "Local requests only." });
      bridge.close("", "stopped");
      if (onShutdown) res.on("finish", onShutdown);
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/heartbeat" && req.method === "POST") {
      // sendBeacon posts text/plain, so the body is parsed whatever its content type.
      const body = await readJson(req);
      const beat = { tab: typeof body?.tab === "string" && body.tab ? body.tab : "default", hidden: body?.hidden === true };
      if (url.searchParams.get("closing") === "1") bridge.closing(beat);
      else bridge.heartbeat(beat);
      return sendJson(res, 200, { ok: true });
    }

    if (path === "/api/chat" && req.method === "POST") {
      if (!chat) {
        return sendJson(res, 501, {
          error: "No chat provider configured. Pass --chat-cmd or --chat-url, or set \"chat\" in the session file.",
        });
      }
      try {
        const { file, hunk, question } = JSON.parse(await readBody(req));
        const answer = await askChat(chat, buildPrompt({ session, file, hunk, question }));
        return sendJson(res, 200, { answer });
      } catch (error) {
        return sendJson(res, 502, { error: error.message });
      }
    }

    const file = normalize(join(WEB_ROOT, path === "/" ? "index.html" : path));
    if (!file.startsWith(normalize(WEB_ROOT))) {
      res.writeHead(403);
      return res.end();
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // Pending long-polls would keep close() waiting; end them first.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    bridge.dispose();
    return closeServer(callback);
  };

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      serverUrl = `http://127.0.0.1:${server.address().port}/`;
      resolve({ server, url: serverUrl });
    });
  });
}

// Only files named in the session diff, and only inside the repo root, may be read.
export function resolveRepoFile(repo, requested, diffPaths) {
  if (!requested || !diffPaths.has(requested)) return null;
  const root = resolve(repo);
  const absolute = resolve(root, requested);
  const rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return absolute;
}

// A deleted file is a diff entry whose new side is /dev/null; its "current" content is empty, not an error.
function deletedPaths(diff) {
  const paths = new Set();
  let current = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) current = line.split(" b/").pop();
    else if (current && line === "+++ /dev/null") paths.add(current);
  }
  return paths;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isQuestion(body) {
  return typeof body?.file === "string"
    && typeof body.question === "string" && body.question.trim() !== ""
    && typeof body.hunk?.header === "string" && Array.isArray(body.hunk.lines);
}

// A query value in seconds, clamped to [0, max]; missing or invalid means the fallback.
function seconds(value, fallback, max) {
  const n = value === null ? NaN : Number(value);
  return Math.round(Math.min(Number.isFinite(n) && n >= 0 ? n : fallback, max) * 1000);
}

async function readJson(req) {
  try {
    return JSON.parse(await readBody(req));
  } catch {
    return null;
  }
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

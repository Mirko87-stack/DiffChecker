// Wakes the Claude Code session that opened the viewer: a short note posted to that session's
// inbox starts a new turn there if it is idle, so a question does not wait for the agent to check in.
import { connect } from "node:net";

// The session exports its inbox to the commands it runs; the detached server inherits both.
export function inboxFromEnv(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  return socket && token ? { socket, token } : null;
}

// socket is a Unix socket path or a Windows named pipe path; net.connect takes both.
// The auth line is documented (cross-session messaging); the message line shape comes from an
// example inside the installed CLI and is undocumented, so it may change.
export function postToInbox({ socket, token, text, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    const timer = setTimeout(() => connection.destroy(new Error(`inbox timed out after ${timeoutMs} ms`)), timeoutMs);
    connection.on("connect", () => {
      connection.write(`${JSON.stringify({ type: "auth", token })}\n`);
      connection.end(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    connection.on("close", (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve();
    });
  });
}

// The nudge rule: one note when a question is queued and no agent poll is pending, nothing more
// while that note is unanswered by a poll, except one reminder after reminderMs if questions are
// still queued. message(count) builds the note; queued() counts the queued questions.
// closedMessage(reason) builds the note for a review that closed with no poll waiting, or null for none.
export function createNudger({ wake, message, closedMessage = () => null, queued, reminderMs = 180_000, post = postToInbox }) {
  let outstanding = false;
  let lastNotifiedAt = null;
  let reminder = null;

  function send(text = message(queued())) {
    post({ ...wake, text }).then(
      () => (lastNotifiedAt = Date.now()),
      (error) => console.error(`[wake] could not notify the agent's session: ${error.message}`),
    );
  }

  return {
    // A question was queued while no agent poll was pending.
    questionQueued() {
      if (!wake || outstanding) return;
      outstanding = true;
      send();
      reminder = setTimeout(() => outstanding && queued() > 0 && send(), reminderMs);
      reminder.unref?.();
    },

    // Any agent poll means the agent is back; the next queued question may note again.
    polled() {
      outstanding = false;
      clearTimeout(reminder);
    },

    // The review closed while the agent was not polling, so nobody would learn of it otherwise.
    reviewClosed(reason) {
      const text = wake && closedMessage(reason);
      if (text) send(text);
    },

    // lastNotifiedAt: ms since the last note was delivered, null if none was.
    status() {
      return {
        available: Boolean(wake),
        lastNotifiedAt: lastNotifiedAt === null ? null : Math.max(1, Date.now() - lastNotifiedAt),
      };
    },

    dispose() {
      clearTimeout(reminder);
    },
  };
}

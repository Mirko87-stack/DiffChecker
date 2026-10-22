// Live mode: the reviewer's questions wait in a queue until the agent that opened the viewer
// long-polls for them, answers in its own conversation, and learns when the review ends.
// A question is "queued" until a poll takes it, "delivered" until the agent answers, then "answered".
import { createNudger } from "./inbox.js";

// Browsers throttle timers in background tabs to about once a minute, so a hidden tab gets a longer grace.
// closingGraceMs: after the last tab says it is closing; a reload reconnects well within it.
// wake: the owning session's inbox ({ socket, token }) or null; wakeMessage(count) builds the note,
// closedMessage(reason) the note sent when the review closes with no poll waiting (null: no note).
// idleTimeoutMs: close as "idle" when no page ever beat and no agent polled for that long; 0 disables.
// onClosed(payload) runs once, with the reply a poll would get, whatever closed the review.
export function createBridge({
  session,
  heartbeatGraceMs = 45_000,
  hiddenGraceMs = 15 * 60_000,
  closingGraceMs = 5000,
  listeningWindowMs = 15_000,
  wake = null,
  wakeMessage = (count) => `DiffChecker: ${count} review question(s) waiting in the viewer.`,
  closedMessage = () => null,
  reminderMs,
  idleTimeoutMs = 30 * 60_000,
  onClosed,
} = {}) {
  const questions = new Map(); // id -> { id, file, hunk, question, askedAt, state, answer }
  const answerWaiters = new Map(); // id -> Set of resolve functions
  let nextId = 1;
  let agentPoll = null; // { resolve, timer }
  let lastSeen = null; // when a poll last started or ended
  let closed = null; // { feedback, reason }
  const tabs = new Map(); // tab id -> timer that drops the tab when its beats stop
  // A closing tab turns hidden first, so its last beat can arrive after the beacon; a reload gets a new id.
  const closedTabs = new Set();
  let closingTimer = null;
  let pageSeen = false; // once a page has beaten, the tab timers decide when the review ends
  let idleTimer = null;

  const inState = (state) => [...questions.values()].filter((q) => q.state === state);
  const nudger = createNudger({ wake, message: wakeMessage, closedMessage, queued: () => inState("queued").length, reminderMs });

  // A pending poll is activity too, so the clock restarts when it ends rather than cutting it short.
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (!idleTimeoutMs || pageSeen || closed) return;
    idleTimer = setTimeout(() => (agentPoll ? armIdle() : close("", "idle")), idleTimeoutMs);
    idleTimer.unref?.();
  }

  function pageArrived() {
    pageSeen = true;
    armIdle();
  }

  // The browser is long-polling for an answer; tell it the question moved on, or got its answer.
  function notify(q, reply) {
    for (const done of answerWaiters.get(q.id) ?? []) done(reply);
    answerWaiters.delete(q.id);
  }

  // A question handed out before but never answered (the agent lost it or stopped) goes out again.
  function questionPayload(q) {
    const redelivered = q.state === "delivered";
    if (!redelivered) {
      q.state = "delivered";
      notify(q, { pending: true, state: q.state });
    }
    const note = session?.files?.find((f) => f.path === q.file)?.note;
    return {
      status: "question",
      id: q.id,
      file: q.file,
      hunkHeader: q.hunk.header,
      lines: q.hunk.lines,
      question: q.question,
      ...(note && { note }),
      ...(redelivered && { redelivered: true }),
    };
  }

  function closedPayload() {
    return {
      status: "closed",
      feedback: closed.feedback,
      reason: closed.reason,
      transcript: [...questions.values()].map((q) => ({
        file: q.file,
        hunkHeader: q.hunk.header,
        question: q.question,
        answer: q.answer ?? null,
        ...(q.changed && { changed: q.changed }),
      })),
    };
  }

  const answerReply = (q) => ({ answer: q.answer, ...(q.changed && { changed: q.changed }) });

  function endPoll(reply) {
    if (!agentPoll) return;
    const { resolve, timer } = agentPoll;
    agentPoll = null;
    clearTimeout(timer);
    lastSeen = Date.now();
    resolve(reply);
    armIdle();
  }

  function stopTabTimers() {
    for (const timer of tabs.values()) clearTimeout(timer);
    tabs.clear();
    clearTimeout(closingTimer);
    closingTimer = null;
  }

  function dropTab(tab) {
    clearTimeout(tabs.get(tab));
    tabs.delete(tab);
  }

  function close(feedback = "", reason = "reviewer finished") {
    if (closed) return;
    closed = { feedback, reason };
    stopTabTimers();
    armIdle();
    nudger.dispose();
    const payload = closedPayload();
    onClosed?.(payload);
    if (agentPoll) endPoll(payload);
    else nudger.reviewClosed(reason);
  }

  armIdle();

  return {
    ask({ file, hunk, question }) {
      if (closed) return null;
      const id = nextId++;
      const entry = { id, file, hunk: { header: hunk.header, lines: hunk.lines }, question, askedAt: Date.now(), state: "queued" };
      questions.set(id, entry);
      if (agentPoll) endPoll(questionPayload(entry));
      else nudger.questionQueued();
      return id;
    },

    // Resolves { answer } as soon as there is one, else { pending: true, state } when the state differs
    // from knownState or changes, or after waitMs; null for an unknown id.
    waitAnswer(id, waitMs, knownState) {
      const q = questions.get(id);
      if (!q) return null;
      if (q.answer !== undefined) return Promise.resolve(answerReply(q));
      const pending = () => ({ pending: true, state: q.state });
      if (waitMs <= 0 || (knownState && knownState !== q.state)) return Promise.resolve(pending());
      return new Promise((resolve) => {
        const waiters = answerWaiters.get(id) ?? new Set();
        answerWaiters.set(id, waiters);
        const done = (reply) => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(reply);
        };
        const timer = setTimeout(() => done(pending()), waitMs);
        timer.unref?.();
        waiters.add(done);
      });
    },

    // One agent poll at a time: a newer poll sends the older one away idle.
    // Returns { promise, cancel }; cancel drops the poll without resolving it (client went away).
    next(timeoutMs) {
      lastSeen = Date.now();
      nudger.polled();
      armIdle();
      if (closed) return { promise: Promise.resolve(closedPayload()), cancel() {} };
      const first = inState("delivered")[0] ?? inState("queued")[0];
      if (first) return { promise: Promise.resolve(questionPayload(first)), cancel() {} };
      endPoll({ status: "idle" });
      let poll;
      const promise = new Promise((resolve) => {
        const timer = setTimeout(() => endPoll({ status: "idle" }), timeoutMs);
        timer.unref?.();
        poll = { resolve, timer };
        agentPoll = poll;
      });
      const cancel = () => {
        if (agentPoll !== poll) return;
        clearTimeout(poll.timer);
        agentPoll = null;
        lastSeen = Date.now();
        armIdle();
      };
      return { promise, cancel };
    },

    // "ok", "unknown" or "duplicate", without answering; lets the server refuse before refreshing the diff.
    canAnswer(id) {
      const q = questions.get(id);
      if (!q) return "unknown";
      return q.answer === undefined ? "ok" : "duplicate";
    },

    // changed: the paths the agent edited to fulfil a requested fix, shown under the answer.
    answer(id, text, changed) {
      const verdict = this.canAnswer(id);
      if (verdict !== "ok") return verdict;
      const q = questions.get(id);
      q.answer = text;
      if (changed) q.changed = changed;
      q.state = "answered";
      notify(q, answerReply(q));
      return "ok";
    },

    // A tab's heartbeat; once every tab that ever beat has gone silent, the viewer was closed.
    heartbeat({ tab = "default", hidden = false } = {}) {
      if (closed || closedTabs.has(tab)) return;
      pageArrived();
      clearTimeout(closingTimer);
      closingTimer = null;
      dropTab(tab);
      const timer = setTimeout(() => {
        tabs.delete(tab);
        if (tabs.size === 0 && !closingTimer) close("", "viewer closed");
      }, hidden ? hiddenGraceMs : heartbeatGraceMs);
      timer.unref?.();
      tabs.set(tab, timer);
    },

    // The tab is unloading. Closing and reloading look alike here, so wait briefly for a new beat.
    closing({ tab = "default" } = {}) {
      if (closed) return;
      pageArrived();
      dropTab(tab);
      if (tab !== "default") closedTabs.add(tab);
      if (tabs.size > 0 || closingTimer) return;
      closingTimer = setTimeout(() => {
        closingTimer = null;
        if (tabs.size === 0) close("", "viewer closed");
      }, closingGraceMs);
      closingTimer.unref?.();
    },

    close,

    // agentLastSeen: ms since a poll last started or ended, 0 while one is pending, null if never.
    status() {
      const agentLastSeen = agentPoll ? 0 : lastSeen === null ? null : Math.max(1, Date.now() - lastSeen);
      return {
        agentListening: agentLastSeen !== null && agentLastSeen < listeningWindowMs,
        agentLastSeen,
        queued: inState("queued").length,
        closed: Boolean(closed),
        wake: nudger.status(),
      };
    },

    // Ends every pending long-poll so the HTTP server can shut down.
    dispose() {
      stopTabTimers();
      clearTimeout(idleTimer);
      nudger.dispose();
      endPoll({ status: "idle" });
      for (const [id, waiters] of answerWaiters) for (const done of [...waiters]) done({ pending: true, state: questions.get(id).state });
      answerWaiters.clear();
    },
  };
}

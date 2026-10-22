// Renders the session: overview, file rail, diffs, and a chat popup anchored to each change.
// In live mode the questions go to the agent that opened the viewer, which answers when it checks in.
import { parseUnifiedDiff } from "./diff-parser.js";
import { hunkRanges } from "./hunks.js";
import { renderMarkdown } from "./markdown.js";
import { attachHunkAsk, createDiffView, disposeDiffView, loadMonaco } from "./monaco-view.js";
import { initSidebar } from "./sidebar.js";

// Before any await: the stored rail width and hidden state apply before the session renders.
initSidebar();

// One id per page load, so the server can tell a reload (a new tab beats at once) from a closed tab.
let tab = newTabId(); // replaced when the page comes back from the back/forward cache
// Status first: a live page beats before the slower session load, so a reload reconnects within the server's grace.
let review = await fetch("/api/status").then((res) => res.json()).catch(() => ({ live: false }));
if (review.live && !review.closed) beat();
let session = await (await fetch("/api/session")).json();
let revision = session.revision ?? 0; // which reload of the diff this page shows
document.getElementById("title").textContent = session.title;
document.getElementById("summary").textContent = session.summary;
document.getElementById("rationale").textContent = session.rationale;
const byline = writtenBy(session.agent);
if (byline) Object.assign(document.getElementById("byline"), { textContent: byline, hidden: false });

const STATUS = {
  added: { letter: "A", label: "Added" },
  modified: { letter: "M", label: "Modified" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
};

const nav = document.getElementById("files");
const diffRoot = document.getElementById("diff");
// Q&A per hunk, keyed by path and hunk header so it survives a reload of an unchanged hunk.
const histories = new Map();
const hunkKey = (file, hunk) => `${file.path}
${hunk.header}`;

// On narrow screens a long file list would push the account off the first screen, so it starts closed.
const filesBox = document.getElementById("files-box");
const narrow = matchMedia("(max-width: 900px)");
const syncFilesBox = () => (filesBox.open = !narrow.matches);
syncFilesBox();
narrow.addEventListener("change", syncFilesBox);
filesBox.addEventListener("toggle", () => !narrow.matches && !filesBox.open && syncFilesBox());

// Monaco is optional: without it every file keeps the unified hunk view.
const monacoReady = loadMonaco().catch(() => null);
monacoReady.then((monaco) => {
  if (monaco) return;
  const notice = document.createElement("p");
  notice.className = "notice";
  notice.textContent = "Side-by-side view unavailable (could not load the editor); showing the unified diff.";
  diffRoot.prepend(notice);
});

// Dozens of editors are heavy, so each one is created only when its file scrolls into view.
const mounts = new Map();
const editors = [];
let generation = 0; // bumped on every re-render, so a late mount of a replaced section is dropped
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer.unobserve(entry.target);
    mounts.get(entry.target)?.();
  }
}, { rootMargin: "300px 0px" });

// Scrollspy: the rail marks the first file whose section crosses the upper part of the viewport.
const railLinks = new Map();
const visible = new Set();
const spy = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) visible.add(entry.target);
    else visible.delete(entry.target);
  }
  const current = [...railLinks.keys()].find((section) => visible.has(section));
  if (!current) return;
  for (const [section, link] of railLinks) {
    if (section === current) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
  }
}, { rootMargin: "-15% 0px -60% 0px" });

let files = renderFiles();

// Rail and sections, built from the session diff; called again when the agent reloads it.
function renderFiles() {
  generation++;
  for (const observed of [observer, spy]) observed.disconnect();
  mounts.clear();
  railLinks.clear();
  visible.clear();
  editors.splice(0).forEach(disposeDiffView);
  nav.replaceChildren();
  diffRoot.querySelectorAll(":scope > .file").forEach((section) => section.remove());

  const notes = new Map(session.files.map((f) => [f.path, f.note]));
  const parsed = parseUnifiedDiff(session.diff);
  document.getElementById("files-heading").textContent = `Files (${parsed.length})`;
  for (const file of parsed) renderFile(file, notes.get(file.path));
  return parsed;
}

function renderFile(file, note) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.href = `#${encodeURIComponent(file.path)}`;
  link.append(statusMark(file), railPath(file.path), counts(file));
  item.append(link);
  nav.append(item);

  const section = document.createElement("article");
  section.className = "file";
  section.id = encodeURIComponent(file.path);
  const heading = document.createElement("h3");
  heading.append(textSpan("path", file.path), statusMark(file), counts(file));
  section.append(heading);
  if (note) section.append(textSpan("note", note, "p"));

  const pane = document.createElement("div");
  const host = document.createElement("div");
  host.className = "sbs-host";
  host.hidden = true;
  pane.append(host, renderUnified(file));
  if (/\.(md|markdown)$/i.test(file.path)) section.append(renderPreviewToggle(file, pane));
  section.append(pane);
  diffRoot.append(section);

  const mountedIn = generation;
  mounts.set(section, () => mountSideBySide(file, section, heading, host, mountedIn));
  observer.observe(section);
  railLinks.set(section, link);
  spy.observe(section);
}

// Sections are built after the page loads, so the browser missed the #file anchor.
// Editors mounting nearby change the layout, so keep the target pinned until the reader scrolls.
let hashTarget = location.hash ? document.getElementById(location.hash.slice(1)) : null;
hashTarget?.scrollIntoView();
for (const type of ["wheel", "touchstart", "keydown", "mousedown"]) {
  addEventListener(type, () => { hashTarget = null; }, { once: true, passive: true });
}

async function mountSideBySide(file, section, heading, host, mountedIn) {
  const monaco = await monacoReady;
  if (!monaco) return;
  const [before, after] = await Promise.all([fetchSide(file.path, "base"), fetchSide(file.path, "current")]);
  // Inline example diffs have no files behind them: keep the unified view.
  if (before === null && after === null) return;
  if (mountedIn !== generation) return;
  section.classList.add("sbs");
  host.hidden = false;
  const editor = createDiffView(monaco, host, file.path, before ?? "", after ?? "");
  editors.push(editor);
  if (file.hunks.length) {
    const view = attachHunkAsk(monaco, editor, file.hunks, (hunk, opener) => openAsk(file, hunk, view, opener));
    // Hover is mouse-only, so the heading offers a keyboard way in; the popup can switch hunks.
    const askAny = document.createElement("button");
    askAny.type = "button";
    askAny.className = "ask-any";
    askAny.textContent = "Ask about a change";
    askAny.addEventListener("click", () => openAsk(file, file.hunks[0], view, askAny));
    heading.append(askAny);
  }
  hashTarget?.scrollIntoView();
}

async function fetchSide(path, side) {
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}&side=${side}`);
    return res.ok ? (await res.json()).content : null;
  } catch {
    return null;
  }
}

function renderPreviewToggle(file, hunks) {
  const bar = document.createElement("div");
  bar.className = "view-toggle";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "View");
  bar.innerHTML = `<button type="button" class="active" aria-pressed="true">Diff</button><button type="button" aria-pressed="false">Preview</button>`;
  const [diffButton, previewButton] = bar.querySelectorAll("button");
  const preview = document.createElement("div");
  preview.hidden = true;
  let loaded = false;

  const show = async (wantPreview) => {
    diffButton.classList.toggle("active", !wantPreview);
    previewButton.classList.toggle("active", wantPreview);
    diffButton.setAttribute("aria-pressed", String(!wantPreview));
    previewButton.setAttribute("aria-pressed", String(wantPreview));
    hunks.hidden = wantPreview;
    preview.hidden = !wantPreview;
    if (!wantPreview || loaded) return;
    loaded = true;
    preview.textContent = "Loading…";
    preview.replaceChildren(...(await buildPreview(file)));
  };
  diffButton.addEventListener("click", () => show(false));
  previewButton.addEventListener("click", () => show(true));
  const wrap = document.createElement("div");
  wrap.append(bar, preview);
  return wrap;
}

// Prefer the whole current file; without it (inline diffs, deleted files) rebuild the new side from the hunks.
async function buildPreview(file) {
  const body = document.createElement("div");
  body.className = "markdown-body";
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`);
    if (!res.ok) throw new Error(res.statusText);
    body.innerHTML = renderMarkdown((await res.json()).content);
    return [body];
  } catch {
    const lines = file.hunks.flatMap((h) => h.lines.filter((l) => l[0] !== "-").map((l) => l.slice(1)));
    body.innerHTML = renderMarkdown(lines.join("\n"));
    const note = document.createElement("p");
    note.className = "notice";
    note.textContent = "Partial preview: built from the diff hunks.";
    return [note, body];
  }
}

// Unified fallback: one block per hunk, each with the same ask button on hover or keyboard focus.
function renderUnified(file) {
  const list = document.createElement("div");
  list.className = "hunks";
  const blocks = new Map();
  const view = {
    anchor: (hunk) => blocks.get(hunk).getBoundingClientRect(),
    pin(hunk) {
      for (const [h, block] of blocks) block.classList.toggle("asking", h === hunk);
      blocks.get(hunk).scrollIntoView({ block: "nearest" });
    },
    unpin: () => blocks.forEach((block) => block.classList.remove("asking")),
  };
  for (const hunk of file.hunks) {
    const wrap = document.createElement("div");
    wrap.className = "hunk";
    const pre = document.createElement("pre");
    pre.tabIndex = 0;
    pre.setAttribute("aria-label", `${file.path}, ${rangeLabel(hunk)}`);
    const header = textSpan("hunk-header", hunk.header + "\n");
    pre.append(header);
    for (const line of hunk.lines) {
      pre.append(textSpan({ "+": "add", "-": "del" }[line[0]] ?? "ctx", line + "\n"));
    }
    const ask = document.createElement("button");
    ask.type = "button";
    ask.className = "ask-float";
    ask.textContent = "Ask about this change";
    ask.addEventListener("click", () => openAsk(file, hunk, view, ask));
    wrap.append(pre, ask);
    blocks.set(hunk, wrap);
    list.append(wrap);
  }
  return list;
}

// "lines 10–16" on the new side; a pure deletion names the removed lines instead.
function rangeLabel(hunk) {
  const { original, modified } = hunkRanges(hunk);
  const removed = modified.end < modified.start;
  const { start, end } = removed ? original : modified;
  const lines = end > start ? `lines ${start}–${end}` : `line ${start}`;
  return removed ? `removed ${lines}` : lines;
}

// One popup for the whole page, anchored under the hunk it is about; Q&A history lives per hunk.
const ask = buildAskPopup();
let current = null; // { file, hunk, view, opener }

function buildAskPopup() {
  const popup = document.createElement("div");
  popup.className = "ask";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Ask about this change");
  popup.hidden = true;
  popup.innerHTML = `
    <div class="ask-top"><p class="ask-where"></p><button type="button" class="ask-close" aria-label="Close">×</button></div>
    <ol class="ask-log"></ol>
    <form class="ask-form"><input placeholder="Ask about this change…" aria-label="Question about this change" /><button>Ask</button></form>
    <p class="ask-by"></p>`;
  document.body.append(popup);
  const parts = {
    popup,
    where: popup.querySelector(".ask-where"),
    log: popup.querySelector(".ask-log"),
    form: popup.querySelector("form"),
    input: popup.querySelector("input"),
    submit: popup.querySelector("form button"),
  };
  parts.by = popup.querySelector(".ask-by");
  parts.by.textContent = review.live ? presence() : answeredBy(session.agent);
  popup.querySelector(".ask-close").addEventListener("click", () => closeAsk(true));
  popup.addEventListener("keydown", (event) => event.key === "Escape" && closeAsk(true));
  // A click anywhere else closes it, without pulling focus away from what was clicked.
  document.addEventListener("mousedown", (event) => {
    if (current && !popup.contains(event.target) && event.target !== current.opener) closeAsk(false);
  });
  addEventListener("resize", () => current && placeAsk());
  parts.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = parts.input.value.trim();
    if (question && current) sendQuestion(current.file, current.hunk, question);
    parts.input.value = "";
  });
  return parts;
}

function openAsk(file, hunk, view, opener) {
  if (current && current.view !== view) closeAsk(false);
  current = { file, hunk, view, opener };
  view.pin(hunk);
  view.onScroll = placeAsk;
  renderAsk();
  ask.popup.hidden = false;
  placeAsk();
  ask.input.focus();
}

function closeAsk(restoreFocus) {
  if (!current) return;
  const { view, opener } = current;
  current = null;
  view.onScroll = null;
  view.unpin();
  ask.popup.hidden = true;
  if (restoreFocus) opener.focus();
}

// Under the hunk when it fits, above it otherwise; a tall hunk with no room either side gets the popup
// over its lower part, so it never leaves the screen. Page coordinates: the editor cannot clip it.
function placeAsk() {
  const box = current.view.anchor(current.hunk);
  const { popup } = ask;
  const gap = 6;
  const height = popup.offsetHeight;
  let top = box.bottom + gap;
  if (top + height > innerHeight) {
    top = box.top - gap - height >= 0 ? box.top - gap - height : Math.max(8, innerHeight - height - 8);
  }
  const left = Math.max(8, Math.min(box.left + 24, innerWidth - popup.offsetWidth - 8));
  popup.style.top = `${top + scrollY}px`;
  popup.style.left = `${left + scrollX}px`;
}

function renderAsk() {
  const { file, hunk } = current;
  ask.where.replaceChildren(`${file.path}, `);
  if (file.hunks.length > 1) {
    const pick = document.createElement("select");
    pick.setAttribute("aria-label", "Change");
    file.hunks.forEach((h, i) => pick.append(new Option(rangeLabel(h), String(i), false, h === hunk)));
    pick.addEventListener("change", () => openAsk(file, file.hunks[Number(pick.value)], current.view, current.opener));
    ask.where.append(pick);
  } else {
    ask.where.append(rangeLabel(hunk));
  }
  const turns = histories.get(hunkKey(file, hunk)) ?? [];
  ask.log.replaceChildren(...turns.map((turn) => {
    const item = document.createElement("li");
    item.append(textSpan("ask-q", turn.question, "p"));
    if (turn.pending) item.append(textSpan("ask-a ask-pending", review.live ? pendingText(turn) : "Thinking…", "p"));
    else if (turn.error) item.append(textSpan("ask-a ask-error", turn.error, "p"));
    else item.append(answerNode(turn.answer), ...(turn.changed ? [changedNode(turn.changed)] : []));
    return item;
  }));
  ask.log.hidden = !turns.length;
  // Live questions queue up, so another one may follow while the agent is still busy.
  ask.submit.disabled = review.closed || (!review.live && turns.some((turn) => turn.pending));
  ask.input.disabled = Boolean(review.closed);
}

async function sendQuestion(file, hunk, question) {
  const turn = { question, pending: true };
  const key = hunkKey(file, hunk);
  histories.set(key, [...(histories.get(key) ?? []), turn]);
  const refresh = () => {
    if (!current || hunkKey(current.file, current.hunk) !== key) return;
    renderAsk();
    placeAsk();
  };
  refresh();
  try {
    if (review.live) await askAgent(file, hunk, question, turn, refresh);
    else await askProvider(file, hunk, question, turn);
  } catch (error) {
    turn.error = `No answer: could not reach the local server (${error.message}).`;
  }
  turn.pending = false;
  refresh();
}

async function askProvider(file, hunk, question, turn) {
  const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: file.path, hunk, question }),
    });
  const data = await res.json();
  if (data.answer) turn.answer = data.answer;
  else turn.error = `No answer: ${data.error ?? `the server replied ${res.status}`}`;
}

// The question is queued for the agent; long-poll until it answers (it may be busy for minutes).
// Passing the known state makes the server reply as soon as the agent takes the question.
async function askAgent(file, hunk, question, turn, onChange) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: file.path, hunk, question }),
  });
  const data = await res.json();
  if (!res.ok) {
    turn.error = `No answer: ${data.error ?? `the server replied ${res.status}`}`;
    return;
  }
  turn.state = "queued";
  while (!review.closed) {
    const poll = await fetch(`/api/chat/${data.id}?wait=25&state=${turn.state}`);
    const reply = await poll.json();
    if (!poll.ok) throw new Error(reply.error ?? `the server replied ${poll.status}`);
    if (reply.answer !== undefined) {
      turn.answer = reply.answer;
      turn.changed = reply.changed;
      return;
    }
    if (reply.state && reply.state !== turn.state) {
      turn.state = reply.state;
      onChange();
    }
  }
  turn.error = "No answer: the review ended before the agent replied.";
}

// The chat should be the same model that wrote the diff; say which one, or admit it is unknown.
// Models answer in Markdown; renderMarkdown escapes all text and keeps only safe links.
function answerNode(markdown) {
  const node = document.createElement("div");
  node.className = "ask-a markdown-answer";
  node.innerHTML = renderMarkdown(markdown);
  return node;
}

// The agent edited files to make a requested fix; the reviewer decides when to reload.
function changedNode(paths) {
  const line = textSpan("ask-changed", `Changed: ${paths.join(", ")}`, "p");
  line.append(" ", showUpdatedButton());
  return line;
}

function showUpdatedButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Show the updated diff";
  button.addEventListener("click", showUpdatedDiff);
  return button;
}

// Re-render from the reloaded session; Q&A stays on hunks whose header did not change.
async function showUpdatedDiff() {
  try {
    session = await (await fetch("/api/session")).json();
  } catch {
    return;
  }
  revision = session.revision ?? revision;
  closeAsk(false);
  files = renderFiles();
  const keys = new Set(files.flatMap((file) => file.hunks.map((hunk) => hunkKey(file, hunk))));
  for (const key of histories.keys()) if (!keys.has(key)) histories.delete(key);
  stale.hidden = true;
}

// The agent counts as listening while a wait is pending (0) or shortly after one ended.
// A function declaration (not a const arrow): the popup is built during module load, above this line.
function agentListening() {
  return typeof review.agentLastSeen === "number" && review.agentLastSeen < 20_000;
}

function presence() {
  if (review.closed) return "The review is closed";
  if (agentListening()) return "The agent is listening";
  if (typeof review.agentLastSeen !== "number") return "The agent has not connected yet";
  const minutes = Math.round(review.agentLastSeen / 60_000);
  return `The agent is not active (last seen ${minutes < 1 ? "less than a minute" : `${minutes} min`} ago)`;
}

// The server posted a note into the agent's Claude Code session (see src/inbox.js).
function agentNotified() {
  return review.wake?.available === true && typeof review.wake.lastNotifiedAt === "number";
}

function pendingText(turn) {
  if (turn.state === "delivered") return "The agent is preparing an answer…";
  if (agentListening()) return "Sent to the agent…";
  if (agentNotified()) return "The agent's session was notified; it will pick up your question shortly.";
  return "Queued. The agent is not active right now and will answer when it checks in. "
    + "You can ask it in its own window to answer the viewer questions.";
}

// The header line; the highlighter dot marks a live connection.
function showPresence() {
  const line = document.getElementById("presence");
  const dot = document.createElement("span");
  dot.className = "presence-dot";
  dot.setAttribute("aria-hidden", "true");
  line.replaceChildren(...(agentListening() && !review.closed ? [dot] : []), presence());
  line.hidden = !review.live;
}

function answeredBy(agent) {
  if (!agent?.model) return "Answered by the configured chat command";
  return agent.effort ? `Answered by ${agent.model} at ${agent.effort} effort` : `Answered by ${agent.model}`;
}

const stale = document.getElementById("stale");
stale.append(showUpdatedButton());
if (review.live) startLiveReview();

// Presence polling, the heartbeat that tells the server the tab is still open, and "Done reviewing".
function startLiveReview() {
  const openButton = document.getElementById("finish-open");
  const panel = document.getElementById("finish");
  const feedback = document.getElementById("feedback");
  const error = panel.querySelector(".finish-error");
  const showPanel = (open) => {
    panel.hidden = !open;
    openButton.setAttribute("aria-expanded", String(open));
    if (open) feedback.focus();
  };
  openButton.hidden = false;
  openButton.addEventListener("click", () => showPanel(panel.hidden));
  document.getElementById("finish-cancel").addEventListener("click", () => {
    showPanel(false);
    openButton.focus();
  });
  panel.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    try {
      const res = await fetch("/api/review/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: feedback.value.trim() }),
      });
      if (!res.ok) throw new Error(`the server replied ${res.status}`);
      finish("Review sent. The agent continues in its own window; you can close this tab.");
    } catch (failure) {
      error.textContent = `Could not send: ${failure.message}.`;
    }
  });

  const poll = async () => {
    try {
      review = await (await fetch("/api/status")).json();
    } catch {
      return;
    }
    if (review.revision > revision) stale.hidden = false;
    if (review.closed) return finish("This review has ended. The agent continues in its own window; you can close this tab.");
    const reach = agentReach();
    ask.by.textContent = presence();
    showPresence();
    // Pending questions say whether the agent is there or was notified; re-render only when that changes.
    if (reach !== lastReach && current) {
      renderAsk();
      placeAsk();
    }
    lastReach = reach;
  };
  const agentReach = () => (agentListening() ? "listening" : agentNotified() ? "notified" : "away");
  let lastReach = agentReach();
  showPresence();
  const timers = [setInterval(beat, 10_000), setInterval(() => !document.hidden && poll(), 5_000)];
  document.addEventListener("visibilitychange", () => {
    if (review.closed) return;
    beat();
    if (!document.hidden) poll();
  });
  // Closing, reloading and leaving for another page (even into the back/forward cache) all fire pagehide;
  // the server waits a few seconds for a new tab before ending.
  addEventListener("pagehide", () => {
    if (!review.closed) navigator.sendBeacon("/api/heartbeat?closing=1", JSON.stringify({ tab }));
  });
  // Back from the back/forward cache: the old tab id said it was closing, so come back as a new tab.
  addEventListener("pageshow", (event) => {
    if (!event.persisted || review.closed) return;
    tab = newTabId();
    beat();
  });

  function finish(message) {
    review.closed = true;
    timers.forEach(clearInterval);
    openButton.hidden = true;
    panel.hidden = true;
    Object.assign(document.getElementById("finished"), { textContent: message, hidden: false });
    ask.by.textContent = presence();
    showPresence();
    if (current) renderAsk();
  }
}

// Tells the server this tab is still open; function declarations so the module top can call them.
function beat() {
  fetch("/api/heartbeat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab, hidden: document.hidden }),
    keepalive: true,
  }).catch(() => {});
}

function newTabId() {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// "Written by Claude Code with claude-opus-5-5 at high effort", leaving out what the session does not say.
function writtenBy(agent) {
  const parts = [
    agent?.name && `by ${agent.name}`,
    agent?.model && `with ${agent.model}`,
    agent?.effort && `at ${agent.effort} effort`,
  ].filter(Boolean);
  return parts.length ? `Written ${parts.join(" ")}` : "";
}

function textSpan(className, text, tag = "span") {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}

// Paths wrap only after a "/", never at a hyphen inside a name.
function railPath(path) {
  const wrap = textSpan("path", "");
  for (const segment of path.match(/[^/]*\/|[^/]+$/g) ?? [path]) wrap.append(textSpan("segment", segment));
  return wrap;
}

function statusMark(file) {
  const { letter, label } = STATUS[file.status] ?? STATUS.modified;
  const mark = document.createElement("abbr");
  mark.className = `status status-${file.status ?? "modified"}`;
  mark.title = label;
  mark.textContent = letter;
  return mark;
}

function counts(file) {
  const wrap = textSpan("counts", "");
  wrap.append(textSpan("plus", `+${file.additions ?? 0}`), " ", textSpan("minus", `−${file.deletions ?? 0}`));
  return wrap;
}

// VS Code-style side-by-side view: loads the Monaco diff editor once from a pinned CDN.
// Only the library comes from the CDN; file contents are fetched from the local server.
import { findHunkAt, hunkRanges } from "./hunks.js";

const VS = "https://cdn.jsdelivr.net/npm/monaco-editor@0.57.0/min/vs";

const LANGUAGES = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript", json: "json", css: "css", html: "html",
  md: "markdown", markdown: "markdown", py: "python", go: "go", rs: "rust",
  java: "java", cs: "csharp", sh: "shell", ps1: "powershell",
  yml: "yaml", yaml: "yaml", xml: "xml", sql: "sql",
};

// Mirrors the page tokens in style.css: night, desk, rule, paper, muted, highlighter, added, removed.
const THEME = "codediff-night";
const MONO = '"Cascadia Code", "SF Mono", Menlo, Consolas, monospace';
const THEME_COLORS = {
  "editor.background": "#222536",
  "editor.foreground": "#E8E4D9",
  "editorGutter.background": "#222536",
  "editorLineNumber.foreground": "#9A9CB066",
  "editorLineNumber.activeForeground": "#E8E4D9",
  "editor.lineHighlightBackground": "#33374D55",
  "editor.lineHighlightBorder": "#00000000",
  "editor.selectionBackground": "#F4CF5D33",
  "editor.inactiveSelectionBackground": "#F4CF5D1F",
  "editorCursor.foreground": "#9A9CB0",
  "editorWidget.background": "#222536",
  "editorWidget.border": "#33374D",
  "diffEditor.insertedLineBackground": "#7CC49514",
  "diffEditor.removedLineBackground": "#E8837A14",
  "diffEditor.insertedTextBackground": "#7CC4952E",
  "diffEditor.removedTextBackground": "#E8837A2E",
  "diffEditorGutter.insertedLineBackground": "#7CC4951F",
  "diffEditorGutter.removedLineBackground": "#E8837A1F",
  "diffEditor.border": "#33374D",
  "diffEditor.diagonalFill": "#33374D66",
  "diffEditor.unchangedRegionBackground": "#1A1C29",
  "diffEditor.unchangedRegionForeground": "#9A9CB0",
  "scrollbar.shadow": "#00000000",
  "scrollbarSlider.background": "#9A9CB026",
  "scrollbarSlider.hoverBackground": "#9A9CB040",
  "scrollbarSlider.activeBackground": "#9A9CB059",
};

let loading = null;
let themed = false;

// Resolves to the monaco namespace, or rejects on network failure or timeout.
export function loadMonaco(timeoutMs = 10000) {
  loading ??= new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out loading Monaco.")), timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("Cannot load Monaco."));
    };
    const script = document.createElement("script");
    script.src = `${VS}/loader.js`;
    script.onerror = fail;
    script.onload = () => {
      window.require.config({ paths: { vs: VS } });
      window.require(["vs/editor/editor.main"], () => {
        clearTimeout(timer);
        resolve(window.monaco);
      }, fail);
    };
    document.head.append(script);
  });
  return loading;
}

export function languageFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  return LANGUAGES[ext] ?? "plaintext";
}

export function createDiffView(monaco, host, path, before, after) {
  const language = languageFor(path);
  if (!themed) {
    monaco.editor.defineTheme(THEME, { base: "vs-dark", inherit: true, rules: [], colors: THEME_COLORS });
    themed = true;
  }
  const editor = monaco.editor.createDiffEditor(host, {
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    theme: THEME,
    fontFamily: MONO,
    fontSize: 13,
    renderOverviewRuler: false,
    // Type tooltips would cover the "Ask about this change" button.
    hover: { enabled: false },
    // Collapse long unchanged stretches, like VS Code does.
    hideUnchangedRegions: { enabled: true },
  });
  editor.setModel({
    original: monaco.editor.createModel(before, language),
    modified: monaco.editor.createModel(after, language),
  });

  // Fit the editor to its content so the page, not the editor, does most of the scrolling.
  const fit = () => {
    const height = Math.max(
      editor.getOriginalEditor().getContentHeight(),
      editor.getModifiedEditor().getContentHeight(),
    );
    host.style.height = `${Math.min(Math.max(height, 120), window.innerHeight * 0.7)}px`;
  };
  editor.getOriginalEditor().onDidContentSizeChange(fit);
  editor.getModifiedEditor().onDidContentSizeChange(fit);
  fit();
  return editor;
}

// Models outlive their editor in Monaco, so a re-rendered page must dispose both.
export function disposeDiffView(editor) {
  const model = editor.getModel();
  editor.dispose();
  model?.original.dispose();
  model?.modified.dispose();
}

// Hovering (or tapping) a changed line washes its hunk and offers an "Ask about this change" button
// at the right end of the hunk's first line. Returns the view the ask popup anchors to.
export function attachHunkAsk(monaco, diff, hunks, onAsk) {
  const panes = { original: diff.getOriginalEditor(), modified: diff.getModifiedEditor() };
  const host = diff.getContainerDomNode();
  const wash = {
    original: panes.original.createDecorationsCollection(),
    modified: panes.modified.createDecorationsCollection(),
  };
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ask-float";
  button.textContent = "Ask about this change";
  button.hidden = true;
  host.append(button);

  let shown = null; // { hunk, side }
  let pinned = null;
  let hideTimer = 0;
  const view = { button, onScroll: null };

  const highlight = (hunk) => {
    const ranges = hunkRanges(hunk);
    for (const side of ["original", "modified"]) {
      const { start, end } = ranges[side];
      wash[side].set(end < start ? [] : [{
        range: new monaco.Range(start, 1, end, 1),
        // Above the diff editor's own insert/delete backgrounds, so the highlighter rule shows.
        options: { isWholeLine: true, className: "hunk-focus", zIndex: 10 },
      }]);
    }
  };
  // A pure addition has nothing to point at on the original side, and vice versa.
  const sideFor = (hunk, preferred) => {
    const { start, end } = hunkRanges(hunk)[preferred];
    return end < start ? (preferred === "original" ? "modified" : "original") : preferred;
  };

  // Viewport box of the hunk's changed lines in one pane, clamped to what the pane shows.
  const box = (hunk, side) => {
    const editor = panes[side];
    const { start, end } = hunkRanges(hunk)[side];
    const pane = editor.getDomNode().getBoundingClientRect();
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    const top = pane.top + editor.getTopForLineNumber(Math.max(start, 1)) - editor.getScrollTop();
    const bottom = pane.top + editor.getTopForLineNumber(Math.max(end, start, 1)) - editor.getScrollTop() + lineHeight;
    const clamp = (y) => Math.min(Math.max(y, pane.top), pane.bottom);
    return { left: pane.left, right: pane.right, top: clamp(top), bottom: clamp(bottom), width: pane.width };
  };

  const place = () => {
    if (!shown) return;
    const { hunk, side } = shown;
    const lines = box(hunk, side);
    const frame = host.getBoundingClientRect();
    const scrollbar = panes[side].getLayoutInfo().verticalScrollbarWidth;
    button.style.left = `${lines.right - frame.left - scrollbar - button.offsetWidth - 8}px`;
    button.style.top = `${Math.min(lines.top - frame.top, frame.height - button.offsetHeight - 4)}px`;
  };
  const show = (hunk, side) => {
    clearTimeout(hideTimer);
    shown = { hunk, side: sideFor(hunk, side) };
    highlight(hunk);
    button.hidden = false;
    place();
  };
  // A short grace so the pointer can travel from the line to the button.
  const scheduleHide = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (pinned || button.matches(":hover, :focus")) return;
      shown = null;
      button.hidden = true;
      wash.original.clear();
      wash.modified.clear();
    }, 350);
  };

  for (const [side, editor] of Object.entries(panes)) {
    const track = (event) => {
      if (pinned) return;
      const line = event.target.position?.lineNumber;
      const hunk = line ? findHunkAt(hunks, side, line) : null;
      if (hunk) show(hunk, side);
      else scheduleHide();
    };
    editor.onMouseMove(track);
    editor.onMouseDown(track); // touch: a tap on a changed line shows the button
    editor.onMouseLeave(scheduleHide);
    editor.onDidScrollChange(() => {
      place();
      view.onScroll?.();
    });
  }
  button.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  button.addEventListener("mouseleave", scheduleHide);
  button.addEventListener("blur", scheduleHide);
  button.addEventListener("click", () => shown && onAsk(shown.hunk, button));

  return Object.assign(view, {
    anchor: (hunk) => box(hunk, shown?.hunk === hunk ? shown.side : sideFor(hunk, "modified")),
    // While the popup is open its hunk stays washed; keyboard openings scroll the hunk into view first.
    pin(hunk) {
      pinned = hunk;
      const side = shown?.hunk === hunk ? shown.side : sideFor(hunk, "modified");
      const { start } = hunkRanges(hunk)[side];
      panes[side].revealLineInCenterIfOutsideViewport(Math.max(start, 1), monaco.editor.ScrollType.Immediate);
      show(hunk, side);
    },
    unpin() {
      pinned = null;
      scheduleHide();
    },
  });
}

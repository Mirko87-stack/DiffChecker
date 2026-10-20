// Small, dependency-free Markdown renderer; pure string in, HTML out, so it also runs under node --test.
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEP = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;

export function renderMarkdown(text) {
  // NUL is reserved for inline placeholders; tabs in indentation count as 4 spaces.
  const lines = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "�")
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, "    ")));
  return renderBlocks(lines).join("\n");
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
    } else if (FENCE.test(line)) {
      const [, indent, marker, info] = line.match(FENCE);
      const body = [];
      for (i++; i < lines.length && !isFenceEnd(lines[i], marker); i++) {
        body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
      }
      i++;
      const cls = info ? ` class="language-${escapeHtml(info)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
    } else if (HEADING.test(line)) {
      const [, hashes, content = ""] = line.match(HEADING);
      out.push(`<h${hashes.length}>${inline(content)}</h${hashes.length}>`);
      i++;
    } else if (HR.test(line)) {
      out.push("<hr>");
      i++;
    } else if (QUOTE.test(line)) {
      const inner = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) inner.push(lines[i].replace(QUOTE, ""));
      out.push(`<blockquote>${renderBlocks(inner).join("\n")}</blockquote>`);
    } else if (isTableStart(line, lines[i + 1])) {
      i = renderTable(lines, i, out);
    } else if (ITEM.test(line)) {
      i = renderList(lines, i, out);
    } else {
      const para = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]); i++) {
        para.push(lines[i].trim());
      }
      out.push(`<p>${inline(para.join("\n"))}</p>`);
    }
  }
  return out;
}

function isFenceEnd(line, marker) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
  return Boolean(m) && m[1][0] === marker[0] && m[1].length >= marker.length;
}

function startsBlock(line, next) {
  return [FENCE, HEADING, HR, QUOTE, ITEM].some((re) => re.test(line)) || isTableStart(line, next);
}

function isTableStart(line, next) {
  return line.includes("|") && next !== undefined && next.includes("-") && TABLE_SEP.test(next);
}

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function renderTable(lines, i, out) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "",
  );
  const cell = (tag, text, col) => {
    const style = align[col] ? ` style="text-align:${align[col]}"` : "";
    return `<${tag}${style}>${inline(text ?? "")}</${tag}>`;
  };
  const rows = [];
  for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) {
    const cells = splitRow(lines[i]);
    rows.push(`<tr>${head.map((_, col) => cell("td", cells[col], col)).join("")}</tr>`);
  }
  const thead = `<thead><tr>${head.map((text, col) => cell("th", text, col)).join("")}</tr></thead>`;
  out.push(`<table>${thead}${rows.length ? `<tbody>${rows.join("")}</tbody>` : ""}</table>`);
  return i;
}

function renderList(lines, i, out) {
  const [, indent, marker] = lines[i].match(ITEM);
  const base = indent.length;
  const ordered = /\d/.test(marker);
  const sameLevelItem = (line) => {
    const m = line.match(ITEM);
    return m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered;
  };
  const indentOf = (line) => line.length - line.trimStart().length;

  // Each item owns the following lines that are blank or indented deeper than the marker.
  const items = [];
  while (i < lines.length && sameLevelItem(lines[i])) {
    const content = lines[i].match(ITEM)[3] ?? "";
    const children = [];
    for (i++; i < lines.length; i++) {
      const next = lines[i].trim() ? lines[i] : lines.slice(i).find((l) => l.trim());
      if (next === undefined || indentOf(next) <= base + 1) break;
      children.push(lines[i]);
    }
    // Skip blank lines between items of the same list.
    let j = i;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j > i && j < lines.length && sameLevelItem(lines[j])) i = j;
    items.push(renderItem(content, children));
  }
  const start = ordered && parseInt(marker, 10) !== 1 ? ` start="${parseInt(marker, 10)}"` : "";
  out.push(ordered ? `<ol${start}>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
  return i;
}

function renderItem(content, children) {
  const depth = Math.min(...children.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const nested = renderBlocks(children.map((l) => l.slice(Math.min(depth, l.length)))).join("");
  const task = content.match(/^\[([ xX])\][ \t]+(.*)$/);
  if (task) {
    const checked = task[1] === " " ? "" : " checked";
    return `<li class="task"><input type="checkbox" disabled${checked}> ${inline(task[2])}${nested}</li>`;
  }
  return `<li>${inline(content)}${nested}</li>`;
}

function inline(text) {
  // Code spans and links are swapped for placeholders first, so their content is never re-interpreted.
  const stash = [];
  const put = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = text
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => put(`<code>${escapeHtml(code)}</code>`))
    .replace(/<((?:https?|mailto):[^\s<>]+)>/gi, (_, url) => put(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`))
    .replace(/(!?)\[([^\]]*)\]\(([^)]*)\)/g, (match, _bang, label, target) => {
      const href = safeHref(target.trim().replace(/^(\S+)[ \t]+"[^"]*"$/, "$1"));
      return put(href === null ? escapeHtml(match) : `<a href="${escapeHtml(href)}">${emphasis(escapeHtml(label))}</a>`);
    });
  s = emphasis(escapeHtml(s));
  // Link labels may hold code placeholders, so restore until nothing is left.
  while (s.includes("\u0000")) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[n]);
  return s;
}

function emphasis(s) {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>");
}

// Only http(s), mailto, #anchors and scheme-less relative paths may become links.
function safeHref(url) {
  if (!url || /\s/.test(url)) return null;
  const compact = url.replace(/[\u0000- \u007f]/g, "").toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:/.test(compact)) return /^(https?|mailto):/.test(compact) ? url : null;
  return url;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

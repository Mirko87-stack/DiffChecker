import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../web/markdown.js";

const md = (lines) => renderMarkdown(lines.join("\n"));

test("headings, paragraphs and horizontal rules", () => {
  assert.equal(renderMarkdown("# One"), "<h1>One</h1>");
  assert.equal(renderMarkdown("###### Six"), "<h6>Six</h6>");
  assert.equal(md(["first line", "second line", "", "next"]), "<p>first line\nsecond line</p>\n<p>next</p>");
  assert.equal(md(["a", "", "---", "", "b"]), "<p>a</p>\n<hr>\n<p>b</p>");
});

test("inline emphasis, code and links", () => {
  assert.equal(
    renderMarkdown("**bold** *it* _it2_ `a <b>` [site](https://x.dev/?a=1&b=2)"),
    '<p><strong>bold</strong> <em>it</em> <em>it2</em> <code>a &lt;b&gt;</code> <a href="https://x.dev/?a=1&amp;b=2">site</a></p>',
  );
  assert.equal(renderMarkdown("<https://x.dev>"), '<p><a href="https://x.dev">https://x.dev</a></p>');
  assert.equal(renderMarkdown("[mail](mailto:a@b.c) [top](#intro) [doc](docs/a.md)"),
    '<p><a href="mailto:a@b.c">mail</a> <a href="#intro">top</a> <a href="docs/a.md">doc</a></p>');
});

test("inline code content is not interpreted", () => {
  assert.equal(renderMarkdown("`**not bold**`"), "<p><code>**not bold**</code></p>");
});

test("fenced code blocks keep content verbatim and escaped", () => {
  assert.equal(
    md(["```js", "# not a heading", "**x** <tag>", "```"]),
    '<pre><code class="language-js"># not a heading\n**x** &lt;tag&gt;</code></pre>',
  );
  assert.equal(md(["~~~", "- not a list", "~~~"]), "<pre><code>- not a list</code></pre>");
});

test("unordered, ordered and nested lists", () => {
  assert.equal(md(["- a", "* b", "+ c"]), "<ul><li>a</li><li>b</li><li>c</li></ul>");
  assert.equal(md(["1. one", "2. two"]), "<ol><li>one</li><li>two</li></ol>");
  assert.equal(
    md(["- a", "  - a1", "    1. deep", "- b"]),
    "<ul><li>a<ul><li>a1<ol><li>deep</li></ol></li></ul></li><li>b</li></ul>",
  );
});

test("task list items render disabled checkboxes", () => {
  assert.equal(
    md(["- [ ] todo", "- [x] done"]),
    '<ul><li class="task"><input type="checkbox" disabled> todo</li>' +
      '<li class="task"><input type="checkbox" disabled checked> done</li></ul>',
  );
});

test("GFM tables with alignment", () => {
  assert.equal(
    md(["| L | C | R |", "| :-- | :-: | --: |", "| 1 | **2** | 3 |"]),
    '<table><thead><tr><th style="text-align:left">L</th><th style="text-align:center">C</th>' +
      '<th style="text-align:right">R</th></tr></thead><tbody><tr><td style="text-align:left">1</td>' +
      '<td style="text-align:center"><strong>2</strong></td><td style="text-align:right">3</td></tr></tbody></table>',
  );
  assert.equal(md(["a | b", "---|---", "c | d"]),
    "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>c</td><td>d</td></tr></tbody></table>");
});

test("blockquotes may contain other blocks", () => {
  assert.equal(md(["> # Title", "> - item", ">", "> text"]),
    "<blockquote><h1>Title</h1>\n<ul><li>item</li></ul>\n<p>text</p></blockquote>");
});

test("images render as links, without loading", () => {
  assert.equal(renderMarkdown("![logo](img/logo.png)"), '<p><a href="img/logo.png">logo</a></p>');
});

test("raw HTML is escaped, never passed through", () => {
  const out = md(["<script>alert(1)</script>", "", '<img src=x onerror="alert(1)">']);
  assert.ok(!out.includes("<script"), out);
  assert.ok(!out.includes("<img"), out);
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), out);
  assert.ok(out.includes("&quot;alert(1)&quot;"), out);
  assert.equal(renderMarkdown("it's"), "<p>it&#39;s</p>");
});

test("dangerous link schemes render as plain text", () => {
  for (const href of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x"]) {
    const out = renderMarkdown(`[x](${href})`);
    assert.ok(!out.includes("<a"), `${href} -> ${out}`);
  }
  assert.ok(!renderMarkdown("<javascript:alert(1)>").includes("<a"));
});

test("link attributes cannot be broken out of", () => {
  const out = renderMarkdown('[x](https://a.dev/"onmouseover="alert(1))');
  assert.ok(!out.includes('"onmouseover'), out);
});

test("CRLF input renders like LF", () => {
  const crlf = "# T\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n";
  assert.equal(renderMarkdown(crlf), renderMarkdown(crlf.replace(/\r\n/g, "\n")));
  assert.ok(!renderMarkdown(crlf).includes("\r"));
});

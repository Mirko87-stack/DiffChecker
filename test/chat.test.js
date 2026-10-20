import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChatConfig, buildPrompt, askChat } from "../src/chat.js";

test("flags override the session chat config", () => {
  const session = { chat: { command: "from-session" } };
  assert.deepEqual(resolveChatConfig({ flags: { chatUrl: "http://x/v1/chat/completions", chatModel: "m" }, session }), {
    kind: "http",
    url: "http://x/v1/chat/completions",
    model: "m",
    apiKeyEnv: "CODEDIFF_CHAT_API_KEY",
  });
});

test("session chat config is used when no flag is given", () => {
  assert.deepEqual(resolveChatConfig({ flags: {}, session: { chat: { command: "claude -p" } } }), {
    kind: "command",
    command: "claude -p",
  });
});

test("no provider configured returns null", () => {
  assert.equal(resolveChatConfig({ flags: {}, session: {} }), null);
});

test("prompt carries task context, file note, hunk and question", () => {
  const prompt = buildPrompt({
    session: { title: "T", summary: "S", rationale: "R", files: [{ path: "a.js", note: "N" }] },
    file: "a.js",
    hunk: { header: "@@ -1 +1 @@", lines: ["-old", "+new"] },
    question: "Why?",
  });
  for (const part of ["T", "S", "R", "a.js", "N", "@@ -1 +1 @@", "-old", "+new", "Why?"]) {
    assert.ok(prompt.includes(part), `missing ${part}`);
  }
});

test("command provider receives the prompt on stdin and returns stdout", async () => {
  const command = `node -e "process.stdin.pipe(process.stdout)"`;
  const answer = await askChat({ kind: "command", command }, "hello hunk");
  assert.equal(answer.trim(), "hello hunk");
});

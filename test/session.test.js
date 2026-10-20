import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSession } from "../src/session.js";

test("loadSession keeps the agent model and effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codediff-session-"));
  try {
    const sessionPath = join(dir, "session.json");
    const agent = { name: "Claude Code", model: "claude-opus-5-5", effort: "high" };
    await writeFile(sessionPath, JSON.stringify({ title: "T", diff: "", agent }));
    const session = await loadSession({ sessionPath });
    assert.deepEqual(session.agent, agent);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

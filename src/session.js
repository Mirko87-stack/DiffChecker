// A session is what the agent hands over: summary, rationale, per-file notes, plus the git diff.
import { readFile } from "node:fs/promises";
import { getDiff } from "./git.js";

export async function loadSession({ sessionPath, repo, base }) {
  const meta = sessionPath ? JSON.parse(await readFile(sessionPath, "utf8")) : {};
  const diff = meta.diff ?? (await getDiff({ repo, base }));
  return {
    title: meta.title ?? "Untitled task",
    summary: meta.summary ?? "",
    rationale: meta.rationale ?? "",
    files: meta.files ?? [],
    // Which model and effort wrote the diff; the UI shows it so the reviewer knows who answers.
    agent: meta.agent,
    chat: meta.chat,
    diff,
  };
}

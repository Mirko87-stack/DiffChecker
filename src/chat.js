// Per-hunk chat. The invoker picks the provider: a CLI command or an OpenAI-compatible endpoint.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 120_000;

// CLI flags win over the session file, so one invocation can override what the agent wrote.
export function resolveChatConfig({ flags, session }) {
  const source = flags.chatCmd || flags.chatUrl
    ? { command: flags.chatCmd, url: flags.chatUrl, model: flags.chatModel }
    : (session.chat ?? {});
  if (source.command) return { kind: "command", command: source.command };
  if (source.url) {
    return {
      kind: "http",
      url: source.url,
      model: source.model,
      apiKeyEnv: source.apiKeyEnv ?? "CODEDIFF_CHAT_API_KEY",
    };
  }
  return null;
}

export function buildPrompt({ session, file, hunk, question }) {
  const note = session.files?.find((f) => f.path === file)?.note ?? "";
  return [
    "You are explaining a code change made by an AI agent to the developer reviewing it.",
    `Task: ${session.title}`,
    `What was done: ${session.summary}`,
    `Why: ${session.rationale}`,
    `File: ${file}`,
    note && `File note: ${note}`,
    "Hunk:",
    hunk.header,
    ...hunk.lines,
    "",
    `Question: ${question}`,
  ]
    .filter((line) => line !== false && line !== undefined)
    .join("\n");
}

export function askChat(config, prompt) {
  return config.kind === "command" ? askCommand(config, prompt) : askHttp(config, prompt);
}

function askCommand({ command }, prompt) {
  return new Promise((resolve, reject) => {
    // The command comes from the invoker (trusted); the prompt goes through stdin, never the shell.
    const child = spawn(command, { shell: true, timeout: TIMEOUT_MS });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `Chat command exited with code ${code}`)),
    );
    child.stdin.end(prompt);
  });
}

async function askHttp({ url, model, apiKeyEnv }, prompt) {
  const apiKey = process.env[apiKeyEnv];
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey && { authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Chat endpoint returned ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

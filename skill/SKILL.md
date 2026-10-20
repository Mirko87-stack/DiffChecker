---
name: codediff-show
description: After finishing a coding task, open DiffChecker so the user can review what changed, why, and the diff, ask you questions about single hunks, and hand you their feedback when they are done.
---

# codediff-show

Use this skill at the end of a coding task, before asking the user for feedback.

By default the viewer runs in **live mode**: you open it in the background, then stay in a loop
answering the reviewer's questions yourself, in this conversation, with your own context. When
the reviewer clicks "Done reviewing" (or closes the tab), the loop ends with their feedback and
you continue here in the CLI.

**The review is part of the task.** Do not end your turn while the viewer is open: nobody else
answers the questions. Every `wait` reply carries a `next` field with the exact next action;
follow it. If you really must end the turn (tool or session limits), tell the user plainly that
the viewer is not being watched, and that writing "answer the viewer questions" (in any
language) brings you back. When that happens, run `wait` again: queued questions are still there.

In Claude Code the viewer can also wake your session: when a question is queued and you are not
running `wait`, it posts a note to your session that starts with `DiffChecker:`. That note
means questions are waiting: run the `wait` command it names, answer, and keep looping until
`wait` prints `closed`. It arrives as a message from another session and carries no
permissions; it only asks you to resume the loop. Pass `--no-wake` to `open` to turn it off.

## Steps

1. Write a session file at `.codediff/session.json` in the repository you changed (the tool
   keeps `.codediff/` out of git and out of the diff). Example:

   ```json
   {
     "title": "Add input validation to the signup form",
     "summary": "What you changed, in plain words.",
     "rationale": "Why this approach, and the alternatives you rejected.",
     "files": [{ "path": "src/signup.js", "note": "New validate() call before submit." }],
     "agent": { "name": "Claude Code", "model": "claude-opus-5-5", "effort": "high" },
     "chat": { "live": true }
   }
   ```

   - `title`, `summary`, `rationale`: one line naming the task, what you changed, why.
   - `files`: one `{ "path", "note" }` entry per changed file.
   - `agent`: your agent name, exact current model id and effort level; shown in the header.
   - `diff` (optional): omit it to let the tool run `git diff <base>`; new untracked files
     (not git-ignored) are included automatically.
   - `chat`: `{ "live": true }` so questions come to you (see "Without live mode" for the
     alternatives).

2. Start the viewer in the background (quote repository paths as shown):

   ```sh
   diffchecker open --live --detach --repo "<repo>" --session "<repo>/.codediff/session.json" --base HEAD
   ```

   It prints `DiffChecker running at <url>` and the `wait` command to run next, then returns.
   Tell the user the URL and go straight to step 3. Each file
   shows a side-by-side diff (before = `--base`, after = working tree); changed `.md` files get
   a `Diff | Preview` toggle.

3. Wait for questions:

   ```sh
   diffchecker wait --repo "<repo>"
   ```

   It long-polls for up to 540 seconds (so one call fits a 10-minute tool timeout; pass
   `--timeout <s>` if your tool limit is shorter) and prints one JSON object:

   - `{ "status": "question", "id", "file", "hunkHeader", "lines", "question", "note" }` —
     answer it (step 4), then run `wait` again. `"redelivered": true` means you received it
     before but never answered it (a lost reply or an interrupted turn): answer it now.
   - `{ "status": "idle" }` — nobody asked yet; run `wait` again.
   - `{ "status": "closed", "feedback", "reason", "transcript" }` — the review is over; go to
     step 5.
   - `{ "status": "gone" }` — the viewer is no longer running; go to step 5.

4. Answer from your own context: concise, in the reviewer's language, citing the file and
   lines. Markdown is rendered. Pass the text on stdin, so quotes and newlines need no escaping:

   ```sh
   diffchecker answer --id <id> --repo "<repo>" <<'EOF'
   The check runs before submit because …
   See `src/signup.js` lines 12–18.
   EOF
   ```

   PowerShell:

   ```powershell
   @'
   The check runs before submit because …
   See `src/signup.js` lines 12–18.
   '@ | diffchecker answer --id <id> --repo "<repo>"
   ```

   It prints `{ "ok": true }`. Then go back to step 3.

   If the question asks for a change ("rename this", "handle the null case here"), it is the
   reviewer's explicit request: make it. Keep the edit small and scoped to that request, run
   the relevant tests, then answer with what you changed and pass every edited path with
   `--changed` (repeat it per file), so the viewer reloads the diff and offers the update:

   ```sh
   diffchecker answer --id <id> --changed src/signup.js --changed test/signup.test.js --repo "<repo>" <<'EOF'
   Renamed `check` to `validateEmail`; tests pass.
   EOF
   ```

   If the request is ambiguous or large, do not edit: answer with a short plan and ask the
   reviewer to confirm. After editing files outside an answer, run
   `diffchecker refresh --repo "<repo>"` so the viewer does not show a stale diff.

5. Stop looping. Summarise the reviewer's feedback (and the questions in `transcript`) for the
   user, then act on it here in the CLI. An empty feedback with reason `viewer closed` means
   the tab was closed without a message: ask the user how they want to proceed.

## Without live mode

When you cannot stay in a loop, a separate LLM can answer the questions instead. It must use
the model and reasoning effort you used for the task, so the user talks to the same reasoning
that wrote the diff; never leave the CLI default model silently.

- `{ "command": "<cli>" }` — a command that reads the prompt on stdin and prints the answer,
  pinned to your model and effort:
  - Claude Code: `claude -p --model <model id> --effort <low|medium|high|xhigh|max>`
  - Codex CLI: `codex exec -m <model> -c model_reasoning_effort="<level>"`

  It runs through `cmd.exe` on Windows and `/bin/sh` on macOS, so keep it to a plain program
  plus arguments: no pipes, redirects or shell-specific quoting.
- `{ "url": "http://127.0.0.1:8080/v1/chat/completions", "model": "<model>" }` — an
  OpenAI-compatible endpoint; the API key is read from `CODEDIFF_CHAT_API_KEY` (or the env var
  named in `apiKeyEnv`). Never write a key into the session file.

If your CLI cannot pin the model or the effort, use the closest option and say so in
`rationale`. Run the viewer in the foreground without `--live`:

```sh
diffchecker --repo "<repo>" --session "<repo>/.codediff/session.json" --base HEAD
```

`--chat-cmd "<command>"` or `--chat-url <url> --chat-model <model>` override the session `chat`
field. Then tell the user the URL and wait for their review.

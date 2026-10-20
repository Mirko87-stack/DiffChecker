# DiffChecker

**English** | [日本語](README.ja.md)

Review an AI coding task before accepting it: understand what changed and why,
inspect a VS Code-style diff, and ask the originating agent about individual hunks.
A dependency-free Node.js CLI with a local browser UI, not a hosted service.

## Features

- Task summary, rationale and per-file notes written by your agent.
- Side-by-side Monaco diff, with unified-diff fallback when unavailable.
- Per-hunk questions answered by the same agent in live mode.
- Markdown preview and refreshed diffs after requested changes.
- Feedback returned to the agent when you finish or close the viewer.

## Requirements and platform status

Node.js **20+**, Git and a modern browser. Install prerequisites separately;
setup never downloads software, requests elevation or implicitly changes agent skills.

| Platform | Browser launcher | Verification |
| --- | --- | --- |
| Windows | Default browser via `start` | Local tests and isolated npm package smoke checks |
| macOS | `open` | Intended support; native verification pending |
| Linux desktop | `xdg-open` | Intended support; native verification pending |

Use `--no-open` on headless systems. The server binds only to `127.0.0.1`;
the printed URL must be opened in an environment that can reach that loopback address.

## Install from GitHub

With Node.js and Git installed, run:

```sh
npm install --global git+https://github.com/Mirko87-stack/DiffChecker.git
diffchecker doctor
diffchecker setup --dry-run
diffchecker setup
```

This installs the current `main` branch directly from GitHub, not a tagged stable release.
It does not link the command to a source checkout. `codediff` is a compatibility alias.
The package is named `@mirko87-stack/diffchecker`; no npm registry publication is required.
For permission errors, use a user-writable npm prefix or Node version manager, not automatic
elevation. If the command is missing, check the npm global bin PATH and restart your agent/terminal.

## Configure your agent

Setup detects existing Claude Code (`~/.claude`), Codex (`~/.codex`) and Pi (`~/.pi/agent`)
directories and installs `skills/codediff-show/SKILL.md` below them. Reload/restart the agent
if needed. You can select a skills directory explicitly; quote paths containing spaces:

```sh
diffchecker setup --target "/path/to/agent/skills" --dry-run
diffchecker setup --target "/path/to/agent/skills"
```

Repeat `--target` for multiple directories. All targets are preflighted before writing;
identical files are skipped, differing files and linked destinations are refused.
Inspect and back up conflicting skills before removing them yourself or choosing another target.
There is no `--force`. Unexpected filesystem failures can still interrupt installation;
this is not a filesystem transaction. Installed skills use `diffchecker`, not a checkout path.

Tell your agent: **“Use the codediff-show skill to review this task.”** Live review requires
the originating agent to keep receiving and answering questions. No AI model is bundled;
optional Claude session wake support is best effort.

## Usage

From a Git repository with changes:

```sh
diffchecker open --repo . --base HEAD
```

Add `--session <file>` for the task explanation; see [sample JSON](examples/session.example.json).
Options include `--port`, `--no-open`, `--live`, `--detach` and `--no-wake`; `--base` defaults to `HEAD`.
For manual live mode, start `diffchecker open --live --detach --repo .`, then receive questions with
`diffchecker wait --repo .` and pipe answers into `diffchecker answer --id <id> --repo .`.
Keep waiting/answering until `closed` or `gone`. After edits, use `diffchecker refresh --repo .`
or `answer --changed <file>`. Full instructions: [codediff-show](skill/SKILL.md).

Without live mode, configure your own provider:

| Provider | Configuration |
| --- | --- |
| CLI reading stdin | `--chat-cmd "<command>"` or session `chat.command` |
| OpenAI-compatible endpoint | `--chat-url <url> --chat-model <model>` or session `chat.url` / `chat.model` |

CLI flags override session settings. Keys come from `CODEDIFF_CHAT_API_KEY` or the environment
variable named by `chat.apiKeyEnv`. Never put credentials in sessions. No provider means no standalone chat.

## Privacy and offline behavior

State, answers and logs live in the reviewed repository's self-ignored `.codediff/` directory.
Live questions go to your agent, whose provider policy applies. Configured external chat
endpoints/CLIs receive relevant task and diff context: do not assume source always stays on-device.
Monaco loads pinned jsDelivr assets; offline the viewer falls back to unified diff.
Local rendering is not a fully offline editor bundle.

## Update and uninstall

To update, rerun the GitHub installation command. For local builds, pack the new version
and install its tarball globally again. Run
`diffchecker doctor` and `diffchecker setup --dry-run` before setup; changed skills need
explicit conflict resolution as described above. No background updater is installed.

```sh
npm uninstall --global @mirko87-stack/diffchecker
```

Uninstall removes npm launchers, not agent skills or review data. Inspect and remove only
the `codediff-show` skill you installed in each selected directory, backing up personal edits.
Existing `.codediff/` sessions remain yours to retain or remove.

## Development

```sh
npm test
node bin/codediff.js doctor
npm start
```

No npm dependencies or build step. Development notes, task plans and local agent instructions
are intentionally excluded from the public snapshot and npm artifact.

To install a local checkout without a source-directory link, run `npm pack` and then
`npm install --global ./mirko87-stack-diffchecker-0.1.0.tgz` from its directory.
Use the filename printed by `npm pack` if the version changes.

## License and release status

Licensed under the [MIT License](LICENSE), matching the license already selected in the public
GitHub repository. Installation uses the source repository rather than an npm registry release.
Native macOS/Linux acceptance is pending.

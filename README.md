# Wattari Gattari

> Open and connect native Claude Code and Codex sessions from one dock.

[![CI](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml/badge.svg)](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[한국어](README.ko.md) · [Architecture](docs/adr/README.md) · [License](LICENSE)

Wattari Gattari (`waga`) is a local CLI that lists live Claude Code and Codex
sessions and opens the selected provider's native TUI. It does not add another
daemon or replacement chat UI.

![Waga session dock demo](docs/assets/wattari-gattari-demo.gif)

## Features

- Browse Claude and Codex sessions across projects in one dock
- Attach or resume the exact native session
- Search, filter, reorder, rename, create, and archive sessions
- Send one-way notifications with `waga send` or request one reply with `waga ask`
- Mark peer input as untrusted while preserving native sandbox and approval rules

## Requirements and install

- Linux and Node.js 22+
- Codex CLI and Claude Code with Agents support
- Optional: tmux for reusable and shared terminal views

Compatibility was verified with Codex CLI 0.152.1 and Claude Code 2.1.259. Run
`waga doctor` after provider upgrades.

```bash
git clone git@github.com:dkwlsdl3/wattari-gattari.git
cd wattari-gattari
npm install
npm link
waga doctor
```

The project is not published to npm.

## Quick start

```bash
waga                            # global session dock
waga --cwd ~/work/my-app        # limit the dock to one project
waga --backend direct           # run without tmux
waga --backend tmux             # require the tmux backend
waga list --provider claude
waga list --json

waga send codex:<thread-id> "Inspect the ADR"
waga ask claude:<session-id> "Review the current API contract"
waga open codex --cwd ~/work/my-app
```

`waga agents` aliases `waga list`. Provider-prefixed targets such as
`claude:<id>` and `codex:<id>` are recommended.

## Dock keys

| Key | Action |
|---|---|
| `↑` / `↓` | Move |
| `Shift+↑` / `Shift+↓` | Reorder sessions |
| `←` / `→` / `Enter` | Collapse or expand a project |
| `Enter` on a session | Open its native TUI |
| `/` / `Tab` | Search / filter providers |
| `F2` | Rename the selected session |
| `Alt+N` / `Alt+R` | New session / refresh |
| `Alt+X` twice | Archive a session |
| `Alt+Q` | Exit Waga |

Archiving removes a session from the active list without deleting its log.
Codex moves it to archived sessions; Claude preserves the transcript while
cleaning up the background job and managed worktree.

The default `auto` backend uses tmux when available and falls back to `direct`.
With tmux, use prefix then `0` to return to the dock; Waga's isolated server also
supports `Alt+G`. In direct mode, leave the native view with `Ctrl+Z` in Claude
or `Ctrl+D` in Codex.

## Peer messages

`send` is a one-way notification and confirms only submission. `ask` waits for
the target to become idle, writes one turn to its real transcript, and waits for
one reply. There is no automatic relay. Every peer message is untrusted input,
not a user instruction or approval.

For unattended Claude replies, allow inbound messages in the target session:

```bash
claude agents --settings '{"crossSessionInbound":"accept"}'
```

## Demo and development

```bash
npm run demo          # exercise messaging with fake providers
npm run demo:dock     # open the dock with fake sessions
npm run demo:record   # regenerate the GIF with VHS
npm run check
npm pack --dry-run
```

GIF generation requires [VHS](https://github.com/charmbracelet/vhs), `ttyd`,
`ffmpeg`, and the `Noto Sans Mono CJK KR` font. See the
[architecture decision](docs/adr/README.md) for design and verification boundaries.

## License

[MIT](LICENSE)

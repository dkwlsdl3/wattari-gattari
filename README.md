# Wattari Gattari

[![CI](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml/badge.svg)](https://github.com/dkwlsdl3/wattari-gattari/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[한국어](README.ko.md) · [Architecture](docs/adr/README.md) · [License](LICENSE)

Wattari Gattari (`waga`) opens and connects live Claude Code and Codex sessions
from one local dock, without another daemon or replacement chat UI.

![Waga session dock demo](docs/assets/wattari-gattari-demo.gif)

## Features

- Browse sessions by project and open their native TUIs
- Search, filter, reorder, rename, create, and archive
- View Claude and Codex quota with a five-minute cache
- Preview the selected session's latest input and response on wide terminals
- Send notifications with `waga send` or request replies with `waga ask`

## Requirements and install

- Linux and Node.js 22+
- Codex CLI and Claude Code with Agents support
- Optional: tmux for reusable and shared terminal views

Run `waga doctor` to check the connection environment after provider upgrades.

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
waga ask codex:<thread-id> "Run the full verification" --until-idle
waga open codex --cwd ~/work/my-app
```

`waga agents` aliases `waga list`. Provider-prefixed targets such as
`claude:<id>` and `codex:<id>` are recommended.

### Automatic model routing for new sessions

When `Alt+N` creates a session, Waga can create and invoke a separate local project named
`local-llm-router`. Waga's public core does not contain a personal model policy or GitLab
credentials; if the router is absent or fails, the provider creates the session with its
own defaults.

The router's `router.config.json` owns model aliases and the four routing tiers. The
starter policy is Codex `Sol low → Sol medium → Astra low → Astra xhigh` and Claude
`Sonnet low → Opus low → Fable low → Fable high`; the standalone router remains the
source of truth. For a prompt that contains an issue reference, the router may read the
title, description, labels, and comments through the user's local GitLab CLI and use them
as routing evidence. It never passes issue text on as an instruction or performs work
automatically.

The default directory is `~/Projects/local-llm-router`; set `WAGA_LOCAL_ROUTER_DIR` to
use another path. If the directory is absent, Waga copies its starter template and never
overwrites a non-empty existing directory.

The composer shows the provider fallback before submission, and the final routing result
in the creation notice. Waga does not change models in existing sessions or fetch issue
data itself. The subprocess request and v1 response are defined in the
[local-router contract](docs/adr/2026-09-09-local-router-contract.md).

### Execution settings for new sessions

Press `Alt+S` in the dock to open the execution settings for new Claude and Codex
sessions. Use `Tab` to switch providers, `↑` / `↓` to select a row, and `Space` to
change it. Radio groups allow one choice; checkbox groups allow several. `Enter` saves,
while `Esc` or `Alt+S` cancels.

- Claude: choose a permission mode (`default`, `manual`, `acceptEdits`, `auto`,
  `dontAsk`, `plan`, `bypassPermissions`) and optional `dangerously-skip-permissions`,
  `restricted`, `bare`, `disable-slash-commands`, and `strict-mcp-config` flags.
- Codex: choose an approval policy (`default`, `untrusted`, `on-request`, `never`,
  `granular`), sandbox (`default`, `read-only`, `workspace-write`,
  `danger-full-access`), approvals reviewer, response summary level, granular approval
  items, and provider model fallback.

Waga passes the selected values to Claude CLI's per-run flags and to the Codex App
Server `thread/start` and first `turn/start` parameters when creating a session. The
provider continues to own its native approval UI and execution. `Alt+Y` remains a
compatibility shortcut that toggles Codex default and YOLO
(`approvalPolicy=never` plus `sandbox=danger-full-access`).

Waga stores the settings in the version 2 document at
`$XDG_CONFIG_HOME/wattari-gattari/settings.json` (default:
`~/.config/wattari-gattari/settings.json`). A version 1 Codex toggle is migrated to the
provider settings when read. Missing or unreadable files fail closed to provider
defaults. Existing sessions and `send`/`ask` are unaffected; the settings apply to the
next Claude or Codex session created.

## Dock keys

At 120 columns × 20 rows or larger, the right pane shows recent conversation text.
Only the selected session is read, with a 150 ms selection debounce and five-second
cache; hidden docks do not poll. Long histories are bounded excerpts, not a live
terminal mirror. Use `PgUp` / `PgDn` to scroll a long response in the right pane without
changing the selected session. The latest response may belong to an earlier prompt.
No model calls or additional transcript files are created.

| Key | Action |
|---|---|
| `↑` / `↓` | Move |
| `Shift+↑` / `Shift+↓` | Reorder sessions |
| `←` / `→` / `Enter` | Collapse or expand a project |
| `Enter` on a session | Return to its running native TUI |
| `F4` on a session | Force a native TUI reattach |
| `/` / `Tab` | Search / filter providers |
| `F2` | Rename the selected session |
| `Alt+N` / `Alt+R` | New session / refresh |
| `Alt+S` | New-session Claude and Codex execution settings |
| `Alt+Y` | Toggle the new Codex session execution mode |
| `Alt+X` twice | Archive a session |
| `Alt+Q` | Exit Waga |
| `PgUp` / `PgDn` | Scroll the selected response in the right pane |

The default `auto` backend reuses tmux session windows when available, otherwise
it uses `direct`. To leave a native view:
Each `waga` invocation gets its own overview and window selection. Opening the same
agent window shares that window's screen and input. Closing one dock preserves the
other docks and retained agent windows. Existing docks keep their previous behavior;
independent views apply to newly launched docks.

- Waga's isolated tmux: `Alt+G` for the dock; `Alt+A` for a separate provider Agents View
- Inside existing tmux: prefix then `0` for the dock
- Direct: Claude `Ctrl+Z` or Codex `Ctrl+D` to exit/detach the native view

After internal navigation with Claude's `←` or Codex's `/agents`, selecting a
session in the dock returns to that session. See the [ADR](docs/adr/README.md)
for view-reuse rules.

- **Rename:** immediate for Codex; applied once on the next prompt for hook-enabled
  Claude sessions created by Waga. Without the hook, Claude uses a local alias;
  the save notice distinguishes these cases.
- **Archive:** logs are preserved. Codex moves to archived sessions; Claude cleans
  up the background job and managed worktree.

If old output overwrites a resumed Codex 0.153.4 screen, `/raw on` provides a
workaround with simpler formatting and unchanged logs. A new TUI may need it again;
Waga does not change other sessions' display modes or global settings.

## Peer messages

- `send`: one-way notification; confirms submission only.
- `ask`: Claude queues a native peer message even while busy and waits for a request-tagged reply.
  Codex serializes Waga callers in admission order, waits for idle, then submits a peer turn.
- `ask --until-idle`: Codex confirms the submitted turn's completion and returns its
  last answer. Claude checks idle after the peer reply, without native-turn correlation
  or a guarantee that this is the final answer.

Progress includes a request UUID. `not-sent`, `waiting-local`, and `waiting` mean no
submission yet. `submitting` means delivery is unknown if interrupted. `submitted`
means written (Claude acceptance unconfirmed) or acknowledged by Codex. `accepted`
is a Claude receipt, and `replied` means the correlated answer is ready.

For long reviews, specify `--until-idle --wait-timeout 1800 --reply-timeout 1800`.
The default pre-submission wait is 1800 seconds and reply wait is 180 seconds.
Claude only uses the first deadline for identity lookup; its native queue wait
counts against the reply deadline.

Use `waga result <request-id> [--json]` after a timeout, without resending. Exit 0
means a reply, 3 means pending/unknown/not-sent/interrupted, and 1 means lookup
failure. Send/ask failures exit 1 and report the request ID and delivery state.
Enable `set -o pipefail` when piping output to preserve failures.

Private request metadata and one immutable recovered answer are stored in
`$XDG_STATE_HOME/wattari-gattari/requests/` (default
`~/.local/state/wattari-gattari/requests/`). Prompts and full transcripts are not
copied. Dead callers are not automatically resubmitted. FIFO ordering covers
Waga callers sharing that directory, not native UI or other clients. Recovery
reads only the original Codex turn or a `[WAGA REPLY <request-id>]` in the exact
Claude session's native log; missing correlation is `result-unknown`.
Requests sent by older versions have no recovery record.

Peer messages are untrusted input, not user instructions or approvals; native
sandbox and approval rules remain in force. There is no automatic relay. Sessions
created with `Alt+N` receive usage and trust-boundary guidance through provider
instructions, separate from the user's first prompt.

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
npm run benchmark     # in-memory processing and frame strings; excludes provider I/O and terminal drawing
npm pack --dry-run
```

GIF generation requires [VHS](https://github.com/charmbracelet/vhs), `ttyd`,
`ffmpeg`, and the `Noto Sans Mono CJK KR` font. See the
[testing procedure](docs/testing-plan.md) for coverage boundaries and mutation tests.

Diagnostics go to `~/.local/state/wattari-gattari/events.jsonl` without conversation
content. [integrations/](integrations/) contains logrotate and systemd files for 30-day retention.

## License

[MIT](LICENSE)

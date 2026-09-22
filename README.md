# evot-herdr

A small, independent session-hook adapter that connects [evot](https://github.com/sundy-li/evot) with [Herdr](https://github.com/sundy-li/herdr).

`evot-herdr` is a single executable with two roles. Run it directly and it starts evot as a transparent wrapper; when evot launches it as `EVOT_SESSION_HOOK`, it consumes evot's generic NDJSON stream and translates lifecycle events into Herdr pane commands. evot remains independent of Herdr.

## Features

- Runs as a transparent wrapper around `evot` and preserves its exit status.
- Detects hook mode from three signals (self-referenced `EVOT_SESSION_HOOK`, no arguments, piped stdin) instead of stdin TTY state alone.
- Reports `working`, `blocked`, and `idle` lifecycle states to Herdr.
- Propagates evot's `session_id` as the Herdr agent session reference.
- Releases the Herdr agent on `session_ended`, stdin EOF, `SIGINT`, or `SIGTERM`.
- Times out stuck Herdr commands and terminates their process trees.
- Retries state, session, and release updates after failed Herdr commands.
- Deduplicates only successfully reported state notifications.
- Validates the versioned hook protocol and ignores malformed or unsupported events.
- Generates monotonic, cross-process sequence values within Herdr's signed 64-bit range.

## Requirements

- [Bun](https://bun.sh/) 1.x
- An installed `evot` executable, unless `EVOT_BIN_PATH` is set.
- A Herdr installation available as `herdr`, or an explicit `HERDR_BIN_PATH`.
- A Herdr-managed pane. The wrapper and directly launched hook can discover the current pane when `HERDR_PANE_ID` is absent.

## Usage

### Recommended: wrapper mode

```bash
chmod +x "$PWD/bin/evot-herdr"
"$PWD/bin/evot-herdr"
```

`evot-herdr` runs in wrapper mode unless all hook-mode conditions below hold. It:

1. Discovers the current Herdr pane when necessary.
2. Sets `EVOT_SESSION_HOOK` to itself unless a custom hook is already configured.
3. Starts evot with inherited stdin, stdout, and stderr.
4. Exits with evot's exit status. A spawn failure is printed to stderr and returns `127`.

Arguments are forwarded unchanged:

```bash
"$PWD/bin/evot-herdr" --help
```

Override the evot executable when developing against a local build:

```bash
EVOT_BIN_PATH=/path/to/evot "$PWD/bin/evot-herdr"
```

If evot was already running before the hook was installed or changed, restart it so the new environment is applied.

### Hook mode with a plain `evot`

Export the hook once and run `evot` directly; this is the typical shell setup:

```bash
# ~/.zshrc
export EVOT_SESSION_HOOK="$HOME/work/evot-herdr/bin/evot-herdr"
```

evot launches the hook with no arguments and a piped stdin. The executable enters hook mode only when **all** of the following are true:

1. `EVOT_SESSION_HOOK` resolves to this executable (absolute or relative path, a `PATH` command name, or a symlink to it).
2. No command-line arguments were given.
3. stdin is not a TTY.

Otherwise it runs as the wrapper, so `evot-herdr --help </dev/null` and interactive `evot-herdr` still start evot. Recursion is impossible: hook mode never spawns evot, and evot only launches this executable when the hook variable points at it. The one ambiguous case is running the *wrapper* with a self-referenced hook, no arguments, and piped stdin; pass any argument (for example `-p`) in that situation.

Feeding an event stream by hand uses the same conditions:

```bash
EVOT_SESSION_HOOK="$PWD/bin/evot-herdr" \
HERDR_PANE_ID=w1:p1 \
HERDR_BIN_PATH=/path/to/herdr \
"$PWD/bin/evot-herdr" < events.ndjson
```

Running outside a Herdr pane is harmless: pane discovery fails and the hook stays inert (it still reserves a sequence generation in the state file described below).

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HERDR_PANE_ID` | No | Current Herdr pane | Explicit pane identifier. |
| `HERDR_BIN_PATH` | No | `herdr` | Herdr executable path or command name. |
| `HERDR_COMMAND_TIMEOUT_MS` | No | `2000` | Positive integer timeout for pane discovery and each Herdr update. Timed-out process trees are terminated. |
| `EVOT_HERDR_SEQUENCE_STATE_PATH` | No | User state directory | Persistent fencing-sequence file. Override mainly for tests or portable installations. |
| `EVOT_BIN_PATH` | No | `evot` | evot executable path or command name. |
| `EVOT_SESSION_HOOK` | No | `bin/evot-herdr` | Hook passed to evot by the wrapper. Custom values are preserved. |

## Event protocol

The hook accepts one JSON object per line. An event must:

- have `version: 1`;
- use a supported event name;
- use `working`, `blocked`, or `idle` for `state_changed.state`;
- use strings for optional textual fields such as `session_id`, `run_id`, and `message`.

Malformed, unsupported, and semantically invalid lines are ignored without terminating the reader. A single NDJSON record is limited to 1 MiB; an oversized record is discarded incrementally, and parsing resumes at the next newline.

Example stream:

```ndjson
{"version":1,"event":"session_started","session_id":"sid-1","cwd":"/workspace/demo"}
{"version":1,"event":"run_started","session_id":"sid-1","run_id":"run-1"}
{"version":1,"event":"state_changed","session_id":"sid-1","state":"blocked","message":"Approve the command"}
{"version":1,"event":"run_finished","session_id":"sid-1","run_id":"run-1"}
{"version":1,"event":"session_ended","session_id":"sid-1","reason":"completed"}
```

Supported events are `session_started`, `state_changed`, `run_started`, `run_finished`, `run_failed`, and `session_ended`.

## Herdr mapping

| evot event | Herdr action |
| --- | --- |
| `session_started` | Report `idle` and register `session_id` when present. |
| `run_started` | Report `working`. |
| `state_changed` | Report the supplied state and message. |
| `run_finished` | Report `idle`. |
| `run_failed` | Report `idle`, including the failure message when supplied. |
| `session_ended` | Release the agent and clear local session state. |
| EOF / `SIGINT` / `SIGTERM` | Best-effort release when the hook has handled lifecycle activity. |

Every command includes source `custom:evot`, agent `evot`, and a monotonic `--seq` value. Each hook reserves a persistent sequence block when it starts, fencing late updates from older overlapping hooks. This prevents an old hook's delayed `release-agent` from clearing a newer session. The generation is stored under `$XDG_STATE_HOME/evot-herdr/sequence` (normally `~/.local/state/evot-herdr/sequence`) on POSIX systems and under `%LOCALAPPDATA%\evot-herdr\sequence` on Windows. If this state cannot be safely persisted, Herdr reporting is disabled for that hook rather than risking stale updates or affecting evot.

Repeated state reports are suppressed only after the preceding Herdr command succeeds. Failed state and session commands remain eligible for retry on the next event; failed explicit releases are retried during shutdown.

Herdr calls are best effort and do not terminate evot. Each call has a bounded timeout. On POSIX systems, the hook starts each Herdr command in a separate process group and terminates the full group on timeout; Windows uses `taskkill /T /F` for process-tree cleanup.

## Development

```bash
bun install
bun run typecheck
bun test
```

Tests use injected runners and temporary executables; a live Herdr installation is not required. The suite covers lifecycle mapping, failure retries, EOF and signal cleanup, process-tree timeouts, protocol validation, wrapper exit status, wrapper/hook mode selection, and non-TTY wrapper execution.

Main files:

- [`src/index.ts`](src/index.ts): adapter, protocol validation, command execution, and wrapper logic.
- [`bin/evot-herdr`](bin/evot-herdr): single entry point; selects wrapper or hook mode.
- [`tests/adapter.test.ts`](tests/adapter.test.ts): unit and process-level regression tests.

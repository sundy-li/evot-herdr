# evot-herdr

A small, independent session-hook adapter that connects [evot](https://github.com/sundy-li/evot) with [Herdr](https://github.com/sundy-li/herdr).

`evot-herdr` consumes evot's generic `EVOT_SESSION_HOOK` NDJSON stream and translates session lifecycle events into Herdr pane commands. The integration stays outside evot: evot only emits its generic hook events and does not need to know about Herdr.

## Features

- Runs as a transparent wrapper around `evot`.
- Translates evot session, run, and state events into Herdr agent updates.
- Reports `working`, `blocked`, and `idle` states.
- Propagates the evot `session_id` as Herdr's native agent session reference.
- Releases the Herdr agent when an evot session ends.
- Deduplicates repeated state notifications while preserving changed blocked messages.
- Treats malformed input and unavailable Herdr commands as non-fatal.
- Provides a small TypeScript API that can be tested without starting Herdr.

## Requirements

- [Bun](https://bun.sh/) 1.x
- An installed `evot` executable, unless `EVOT_BIN_PATH` is set.
- A Herdr installation available as `herdr`, or an explicit `HERDR_BIN_PATH`.
- A Herdr-managed pane that provides `HERDR_PANE_ID` when the adapter is enabled.

## Usage

### Recommended: run the wrapper in a Herdr pane

Make the wrapper executable and run it directly:

```bash
chmod +x "$PWD/bin/evot-herdr"
"$PWD/bin/evot-herdr"
```

The wrapper starts `evot`, automatically sets `EVOT_SESSION_HOOK` to the adapter, discovers the current Herdr pane when `HERDR_PANE_ID` is not already set, and forwards command-line arguments, standard input, standard output, and standard error. For example:

```bash
"$PWD/bin/evot-herdr" --help
```

Override the evot executable when developing against a local build:

```bash
EVOT_BIN_PATH=/path/to/evot "$PWD/bin/evot-herdr"
```

If evot was already running before the hook was installed or changed, restart it so that the new hook environment is applied. A source-built evot can be installed with:

```bash
cd /path/to/evot
make install
```

### Manual adapter mode

The executable reads generic NDJSON from standard input when its standard input is not a TTY:

```bash
EVOT_SESSION_HOOK="$PWD/bin/evot-herdr" evot
```

Herdr normally supplies the adapter environment. To run it manually, set at least a pane ID:

```bash
HERDR_PANE_ID=w1:p1 \
HERDR_BIN_PATH=/path/to/herdr \
"$PWD/bin/evot-herdr" < events.ndjson
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `HERDR_PANE_ID` | No in wrapper mode; yes for manual adapter mode | Auto-detected in wrapper mode | Herdr pane identifier. The wrapper discovers the current pane when this is absent. |
| `HERDR_BIN_PATH` | No | `herdr` | Path or command name used to invoke Herdr. |
| `EVOT_BIN_PATH` | No | `evot` | Path or command name used by the wrapper to start evot. |
| `EVOT_SESSION_HOOK` | No | Adapter path in wrapper mode | Hook executable consumed by evot. Existing values are preserved by the wrapper. |

## Event protocol

The adapter accepts one JSON object per line. Events must have `version: 1` and a string `event` field; unknown or malformed lines are ignored.

Example stream:

```ndjson
{"version":1,"event":"session_started","session_id":"sid-1","cwd":"/workspace/demo"}
{"version":1,"event":"run_started","session_id":"sid-1","run_id":"run-1"}
{"version":1,"event":"state_changed","session_id":"sid-1","state":"blocked","message":"Approve the command"}
{"version":1,"event":"run_finished","session_id":"sid-1","run_id":"run-1"}
{"version":1,"event":"session_ended","session_id":"sid-1","reason":"completed"}
```

Supported event names are `session_started`, `state_changed`, `run_started`, `run_finished`, `run_failed`, and `session_ended`. Supported states are `working`, `blocked`, and `idle`.

## Herdr mapping

| evot event | Herdr action |
| --- | --- |
| `session_started` | Report `idle` and register the evot `session_id` when present. |
| `run_started` | Report `working`. |
| `state_changed` | Report the supplied state and blocked message, if any. |
| `run_finished` | Report `idle`. |
| `run_failed` | Report `idle`, including the failure message when supplied. |
| `session_ended` | Invoke `release-agent` and clear the adapter session state. |

Every report includes the source `custom:evot`, agent name `evot`, and an increasing `--seq` value. Repeated reports with the same state, message, and session are suppressed.

All Herdr calls are best effort. If Herdr is unavailable, a failed command does not terminate the NDJSON reader or affect evot's main process.

## Development

Install dependencies and run the test suite:

```bash
bun install
bun test
```

The project uses strict TypeScript settings and Bun's native test runner. Tests inject a fake Herdr runner, so they do not require a live Herdr installation.

The main implementation is in [`src/index.ts`](src/index.ts), the executable wrapper is [`bin/evot-herdr`](bin/evot-herdr), and tests are in [`tests/adapter.test.ts`](tests/adapter.test.ts).

## Project status

This project is an integration adapter rather than a replacement for evot or Herdr. It intentionally keeps the protocol boundary small and relies on each host application for process lifecycle and environment setup.

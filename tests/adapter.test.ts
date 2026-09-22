import { chmod, mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  EvotHerdrAdapter,
  parseSessionHookEvent,
  readBoundedLines,
  runAdapter,
  runEvot,
  type HerdrRunner,
} from '../src/index.js'

const sequenceDirectory = await mkdtemp(join(tmpdir(), 'evot-herdr-sequence-'))
const previousSequenceStatePath = process.env.EVOT_HERDR_SEQUENCE_STATE_PATH
process.env.EVOT_HERDR_SEQUENCE_STATE_PATH = join(sequenceDirectory, 'sequence')
afterAll(async () => {
  if (previousSequenceStatePath === undefined) delete process.env.EVOT_HERDR_SEQUENCE_STATE_PATH
  else process.env.EVOT_HERDR_SEQUENCE_STATE_PATH = previousSequenceStatePath
  await rm(sequenceDirectory, { recursive: true, force: true })
})

async function writeExecutable(path: string, content: string): Promise<void> {
  await Bun.write(path, content)
  await chmod(path, 0o755)
}

function successfulRecorder(commands: string[][]): HerdrRunner {
  return async argv => {
    commands.push(argv)
    return true
  }
}

async function* lines(...values: string[]): AsyncIterable<string> {
  yield* values
}

async function waitForFileText(
  path: string,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await Bun.file(path).exists() ? await Bun.file(path).text() : ''
    if (predicate(text)) return text
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function commandName(command: string[]): string | undefined {
  return command[2]
}

describe('EvotHerdrAdapter', () => {
  test('maps lifecycle events to ordered Herdr commands', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/bin/herdr' },
      run: successfulRecorder(commands),
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1', cwd: '/repo' })
    await adapter.handle({ version: 1, event: 'run_started', session_id: 'sid-1', run_id: 'run-1' })
    await adapter.handle({ version: 1, event: 'state_changed', session_id: 'sid-1', state: 'blocked', message: 'approve' })
    await adapter.handle({ version: 1, event: 'run_finished', session_id: 'sid-1', run_id: 'run-1' })
    await adapter.handle({ version: 1, event: 'session_ended', session_id: 'sid-1', reason: 'completed' })

    expect(commands.map(command => command.slice(1, 4))).toEqual([
      ['pane', 'report-agent', 'w1:p1'],
      ['pane', 'report-agent-session', 'w1:p1'],
      ['pane', 'report-agent', 'w1:p1'],
      ['pane', 'report-agent', 'w1:p1'],
      ['pane', 'report-agent', 'w1:p1'],
      ['pane', 'release-agent', 'w1:p1'],
    ])
    expect(commands[0]).toContain('sid-1')
    expect(commands[1]).toContain('sid-1')
    expect(commands[3]).toContain('blocked')
    expect(commands[3]).toContain('--message')
    expect(commands[3]).toContain('approve')
  })

  test('emits strictly increasing safe i64 sequence numbers', async () => {
    const commands: string[][] = []
    const run = successfulRecorder(commands)
    const first = new EvotHerdrAdapter({ env: { HERDR_PANE_ID: 'w1:p1' }, run })
    const second = new EvotHerdrAdapter({ env: { HERDR_PANE_ID: 'w1:p1' }, run })

    await first.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await first.handle({ version: 1, event: 'session_ended', session_id: 'sid-1' })
    await second.handle({ version: 1, event: 'session_started', session_id: 'sid-2' })

    const sequences = commands.map(command => BigInt(command[command.indexOf('--seq') + 1]!))
    expect(sequences).toHaveLength(5)
    for (let index = 1; index < sequences.length; index++) {
      expect(sequences[index]! > sequences[index - 1]!).toBe(true)
    }
    expect(sequences.every(sequence => sequence <= 9_223_372_036_854_775_807n)).toBe(true)
  })

  test('fences a late release from an older adapter generation', async () => {
    const olderCommands: string[][] = []
    const newerCommands: string[][] = []
    const older = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(olderCommands),
    })
    await older.handle({ version: 1, event: 'session_started' })

    const newer = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(newerCommands),
    })
    await newer.handle({ version: 1, event: 'session_started' })
    await older.handle({ version: 1, event: 'session_ended' })

    const newerReport = BigInt(newerCommands[0]![newerCommands[0]!.indexOf('--seq') + 1]!)
    const olderRelease = olderCommands.find(command => commandName(command) === 'release-agent')!
    const olderReleaseSequence = BigInt(olderRelease[olderRelease.indexOf('--seq') + 1]!)
    expect(olderReleaseSequence < newerReport).toBe(true)
  })

  test('keeps Promise<void> runners backward compatible', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => {
        commands.push(argv)
      },
    })

    await adapter.handle({ version: 1, event: 'session_started' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })

    expect(commands.filter(command => command.includes('working'))).toHaveLength(1)
  })

  test('deduplicates successful repeated states and changed messages', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(commands),
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'blocked', message: 'first' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'blocked', message: 'second' })

    expect(commands).toHaveLength(5)
    expect(commands[4]).toContain('second')
  })

  test('retries state and session reports after failed Herdr commands', async () => {
    const commands: string[][] = []
    let failedWorking = false
    let failedSession = false
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => {
        commands.push(argv)
        if (argv.includes('working') && !failedWorking) {
          failedWorking = true
          return false
        }
        if (commandName(argv) === 'report-agent-session' && !failedSession) {
          failedSession = true
          return false
        }
        return true
      },
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })

    expect(commands.filter(command => command.includes('working'))).toHaveLength(2)
    expect(commands.filter(command => commandName(command) === 'report-agent-session')).toHaveLength(2)
  })

  test('includes run failure messages on idle reports', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(commands),
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await adapter.handle({ version: 1, event: 'run_started' })
    await adapter.handle({ version: 1, event: 'run_failed', message: 'provider exploded' })

    expect(commands.at(-1)).toContain('--message')
    expect(commands.at(-1)).toContain('provider exploded')
  })

  test('reports a newly assigned session identity even when state stays idle', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(commands),
    })

    await adapter.handle({ version: 1, event: 'session_started' })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })

    expect(commands).toHaveLength(3)
    expect(commands[0]).not.toContain('--agent-session-id')
    expect(commands[1]).toContain('sid-1')
    expect(commands[2]).toContain('report-agent-session')
  })

  test('adopts the session identity from a mid-session event after a hook restart', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(commands),
    })

    // No session_started: evot respawned the hook mid-session.
    await adapter.handle({ version: 1, event: 'run_started', session_id: 'sid-live', run_id: 'run-7' })

    expect(commands.map(commandName)).toEqual(['report-agent', 'report-agent-session'])
    expect(commands[0]).toContain('working')
    expect(commands[0]).toContain('sid-live')
    expect(commands[1]).toContain('sid-live')
  })

  test('releases once on EOF when a session did not end explicitly', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(commands),
    })

    await runAdapter(lines(
      JSON.stringify({ version: 1, event: 'session_started', session_id: 'sid-1' }),
      JSON.stringify({ version: 1, event: 'run_started' }),
    ), adapter)

    expect(commands.filter(command => commandName(command) === 'release-agent')).toHaveLength(1)
  })

  test('does not release twice after session_ended and EOF', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: successfulRecorder(commands),
    })

    await runAdapter(lines(
      JSON.stringify({ version: 1, event: 'session_started', session_id: 'sid-1' }),
      JSON.stringify({ version: 1, event: 'session_ended', session_id: 'sid-1' }),
    ), adapter)

    expect(commands.filter(command => commandName(command) === 'release-agent')).toHaveLength(1)
  })

  test('retries a failed explicit release when EOF closes the hook', async () => {
    const commands: string[][] = []
    let releaseAttempts = 0
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => {
        commands.push(argv)
        if (commandName(argv) === 'release-agent') return ++releaseAttempts > 1
        return true
      },
    })

    await runAdapter(lines(
      JSON.stringify({ version: 1, event: 'session_started', session_id: 'sid-1' }),
      JSON.stringify({ version: 1, event: 'session_ended', session_id: 'sid-1' }),
    ), adapter)

    expect(commands.filter(command => commandName(command) === 'release-agent')).toHaveLength(2)
  })

  test('continues after a custom runner throws', async () => {
    const commands: string[][] = []
    let calls = 0
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => {
        calls++
        if (calls === 1) throw new Error('synthetic failure')
        commands.push(argv)
        return true
      },
    })

    await runAdapter(lines(
      JSON.stringify({ version: 1, event: 'session_started' }),
      JSON.stringify({ version: 1, event: 'run_started' }),
    ), adapter)

    expect(commands.some(command => command.includes('working'))).toBe(true)
  })

  test('discovers the current Herdr pane when the wrapper environment omits it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    const evot = join(directory, 'evot')
    const calls = join(directory, 'calls')
    const previous = { ...process.env }

    await writeExecutable(herdr, `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "current" ]; then
  printf '%s\\n' '{"result":{"pane":{"pane_id":"w9:p9"}}}'
  exit 0
fi
printf '%s\\n' "$*" >> "$CAPTURE"
`)
    await writeExecutable(evot, `#!/bin/sh
printf '%s\\n' "$EVOT_SESSION_HOOK" > "$HOOK_CAPTURE"
printf '%s\\n' '{"version":1,"event":"session_started","session_id":"sid-discovered"}' | "$EVOT_SESSION_HOOK"
`)

    try {
      process.env.EVOT_BIN_PATH = evot
      delete process.env.EVOT_SESSION_HOOK
      process.env.HERDR_BIN_PATH = herdr
      delete process.env.HERDR_PANE_ID
      process.env.CAPTURE = calls
      process.env.HOOK_CAPTURE = join(directory, 'hook')

      expect(await runEvot([])).toBe(0)

      const output = await Bun.file(calls).text()
      expect(output).toContain('pane report-agent w9:p9')
      expect(output).toContain('pane report-agent-session w9:p9')
      expect(output).toContain('pane release-agent w9:p9')
      expect((await Bun.file(process.env.HOOK_CAPTURE).text()).trim()).toEndWith('/bin/evot-herdr')
    } finally {
      process.env = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('discovers the current pane for a directly launched hook', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    await writeExecutable(herdr, `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "current" ]; then
  printf '%s\\n' '{"result":{"pane":{"pane_id":"w8:p1"}}}'
fi
`)

    try {
      const commands: string[][] = []
      const adapter = new EvotHerdrAdapter({
        env: { HERDR_BIN_PATH: herdr },
        discoverPane: true,
        run: successfulRecorder(commands),
      })
      await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-direct' })
      expect(adapter.enabled).toBe(true)
      expect(commands[0]).toContain('w8:p1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('cleans up the pane discovery process tree after a timeout', async () => {
    if (process.platform === 'win32') return

    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    const pids = join(directory, 'pids')
    await writeExecutable(herdr, `#!/bin/sh
printf '%s\\n' "$$" >> "$PID_CAPTURE"
sleep 30 &
printf '%s\\n' "$!" >> "$PID_CAPTURE"
wait
`)

    try {
      const adapter = new EvotHerdrAdapter({
        env: {
          HERDR_BIN_PATH: herdr,
          HERDR_COMMAND_TIMEOUT_MS: '50',
          PID_CAPTURE: pids,
        },
        discoverPane: true,
      })
      expect(adapter.enabled).toBe(false)

      await Bun.sleep(50)
      const spawnedPids = (await Bun.file(pids).text()).trim().split('\n').map(Number)
      expect(spawnedPids).toHaveLength(2)
      for (const pid of spawnedPids) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('is inert without a pane id', async () => {
    let called = false
    const adapter = new EvotHerdrAdapter({
      env: {},
      run: async () => {
        called = true
        return true
      },
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await adapter.close()
    expect(adapter.enabled).toBe(false)
    expect(called).toBe(false)
  })

  test('is inert when sequence state cannot be persisted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const parentFile = join(directory, 'not-a-directory')
    await Bun.write(parentFile, 'file')
    let called = false

    try {
      const adapter = new EvotHerdrAdapter({
        env: {
          HERDR_PANE_ID: 'w1:p1',
          EVOT_HERDR_SEQUENCE_STATE_PATH: join(parentFile, 'sequence'),
        },
        run: async () => {
          called = true
          return true
        },
      })

      await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
      await adapter.close()
      expect(adapter.enabled).toBe(false)
      expect(called).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fails closed without overwriting malformed sequence state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const statePath = join(directory, 'sequence')
    await Bun.write(statePath, 'not-a-generation\n')
    let called = false

    try {
      const adapter = new EvotHerdrAdapter({
        env: {
          HERDR_PANE_ID: 'w1:p1',
          EVOT_HERDR_SEQUENCE_STATE_PATH: statePath,
        },
        run: async () => {
          called = true
          return true
        },
      })

      expect(adapter.enabled).toBe(false)
      await adapter.handle({ version: 1, event: 'session_started' })
      expect(called).toBe(false)
      expect(await Bun.file(statePath).text()).toBe('not-a-generation\n')
      expect(await Bun.file(`${statePath}.lock`).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('recovers a stale sequence lock owned by a dead process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const statePath = join(directory, 'sequence')
    const lockPath = `${statePath}.lock`
    await Bun.write(statePath, '1\n')
    await Bun.write(lockPath, '2147483647\n')
    const stale = new Date(Date.now() - 2_000)
    await utimes(lockPath, stale, stale)

    try {
      const adapter = new EvotHerdrAdapter({
        env: {
          HERDR_PANE_ID: 'w1:p1',
          EVOT_HERDR_SEQUENCE_STATE_PATH: statePath,
        },
        run: async () => true,
      })

      expect(adapter.enabled).toBe(true)
      expect(await Bun.file(lockPath).exists()).toBe(false)
      expect(BigInt((await Bun.file(statePath).text()).trim()) > 1n).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('parseSessionHookEvent', () => {
  test('accepts valid events', () => {
    expect(parseSessionHookEvent('{"version":1,"event":"run_started"}')?.event).toBe('run_started')
    expect(parseSessionHookEvent('{"version":1,"event":"state_changed","state":"blocked"}')?.state).toBe('blocked')
  })

  test('rejects malformed and semantically invalid events', () => {
    for (const value of [
      'null',
      '[]',
      '42',
      '{',
      '{"version":2,"event":"run_started"}',
      '{"version":1,"event":"unknown"}',
      '{"version":1,"event":"state_changed"}',
      '{"version":1,"event":"state_changed","state":"invalid"}',
      '{"version":1,"event":"session_started","session_id":42}',
    ]) expect(parseSessionHookEvent(value)).toBeUndefined()
  })
})

describe('readBoundedLines', () => {
  test('reassembles records split across byte and UTF-8 boundaries', async () => {
    const bytes = Buffer.from('first\n你好\nlast')
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield bytes.subarray(0, 8)
      yield bytes.subarray(8, 9)
      yield bytes.subarray(9, 11)
      yield bytes.subarray(11)
    }

    const values: string[] = []
    for await (const line of readBoundedLines(chunks(), 64)) values.push(line)
    expect(values).toEqual(['first', '你好', 'last'])
  })

  test('discards an oversized record and resumes at the next newline', async () => {
    async function* chunks(): AsyncIterable<string> {
      yield '12345'
      yield '67890\nvalid'
      yield '\nunterminated'
    }

    const values: string[] = []
    for await (const line of readBoundedLines(chunks(), 8)) values.push(line)
    expect(values).toEqual(['valid'])
  })
})

describe('process execution', () => {
  test('propagates the evot exit code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const evot = join(directory, 'evot')
    const previousBin = process.env.EVOT_BIN_PATH
    const previousHook = process.env.EVOT_SESSION_HOOK
    await writeExecutable(evot, '#!/bin/sh\nexit 42\n')
    try {
      process.env.EVOT_BIN_PATH = evot
      delete process.env.EVOT_SESSION_HOOK
      expect(await runEvot([])).toBe(42)
    } finally {
      if (previousBin === undefined) delete process.env.EVOT_BIN_PATH
      else process.env.EVOT_BIN_PATH = previousBin
      if (previousHook === undefined) delete process.env.EVOT_SESSION_HOOK
      else process.env.EVOT_SESSION_HOOK = previousHook
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('returns 127 when evot cannot be started', async () => {
    const previousBin = process.env.EVOT_BIN_PATH
    const previousHook = process.env.EVOT_SESSION_HOOK
    try {
      process.env.EVOT_BIN_PATH = '/definitely/missing/evot'
      delete process.env.EVOT_SESSION_HOOK
      expect(await runEvot([])).toBe(127)
    } finally {
      if (previousBin === undefined) delete process.env.EVOT_BIN_PATH
      else process.env.EVOT_BIN_PATH = previousBin
      if (previousHook === undefined) delete process.env.EVOT_SESSION_HOOK
      else process.env.EVOT_SESSION_HOOK = previousHook
    }
  })

  test('times out a stuck Herdr process tree and continues reading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    const capture = join(directory, 'calls')
    const pids = join(directory, 'pids')
    await writeExecutable(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$CAPTURE"
printf '%s\\n' "$$" >> "$PID_CAPTURE"
sleep 30 &
printf '%s\\n' "$!" >> "$PID_CAPTURE"
wait
`)

    const started = Date.now()
    const adapter = new EvotHerdrAdapter({
      env: {
        HERDR_PANE_ID: 'w1:p1',
        HERDR_BIN_PATH: herdr,
        HERDR_COMMAND_TIMEOUT_MS: '50',
        CAPTURE: capture,
        PID_CAPTURE: pids,
      },
    })
    try {
      await runAdapter(lines(
        JSON.stringify({ version: 1, event: 'session_started' }),
        JSON.stringify({ version: 1, event: 'run_started' }),
      ), adapter)
      expect(Date.now() - started).toBeLessThan(2_000)
      expect((await Bun.file(capture).text()).trim().split('\n')).toHaveLength(3)

      await Bun.sleep(50)
      const spawnedPids = (await Bun.file(pids).text()).trim().split('\n').map(Number)
      expect(spawnedPids).toHaveLength(6)
      for (const pid of spawnedPids) {
        expect(() => process.kill(pid, 0)).toThrow()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 5_000)

  test('wrapper mode does not depend on stdin being a TTY', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const evot = join(directory, 'evot')
    const capture = join(directory, 'args')
    await writeExecutable(evot, `#!/bin/sh
printf '%s\\n' "$*" > "$CAPTURE"
exit 23
`)
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, EVOT_BIN_PATH: evot, CAPTURE: capture }
      delete env.EVOT_SESSION_HOOK
      const child = Bun.spawn([join(import.meta.dir, '../bin/evot-herdr'), '--help'], {
        env,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      child.stdin.end()
      expect(await child.exited).toBe(23)
      expect((await Bun.file(capture).text()).trim()).toBe('--help')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('selects hook mode only when self-referenced with piped stdin and no args', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const evot = join(directory, 'evot')
    const herdr = join(directory, 'herdr')
    const evotCapture = join(directory, 'evot-args')
    const herdrCapture = join(directory, 'herdr-calls')
    const wrapper = join(import.meta.dir, '../bin/evot-herdr')
    await writeExecutable(evot, `#!/bin/sh
printf '%s|%s\\n' "$*" "$EVOT_SESSION_HOOK" >> "$EVOT_CAPTURE"
`)
    await writeExecutable(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_CAPTURE"
`)
    const baseEnv = {
      ...process.env,
      EVOT_BIN_PATH: evot,
      HERDR_BIN_PATH: herdr,
      HERDR_PANE_ID: 'w1:p1',
      EVOT_CAPTURE: evotCapture,
      HERDR_CAPTURE: herdrCapture,
    }
    const spawn = (args: string[], env: NodeJS.ProcessEnv) => {
      const child = Bun.spawn([wrapper, ...args], { env, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
      child.stdin.write(`${JSON.stringify({ version: 1, event: 'session_started' })}\n`)
      child.stdin.end()
      return child.exited
    }

    try {
      // Hook mode: self-referenced by absolute path, no args, piped stdin.
      expect(await spawn([], { ...baseEnv, EVOT_SESSION_HOOK: wrapper })).toBe(0)
      expect(await Bun.file(herdrCapture).text()).toContain('pane report-agent w1:p1')
      expect(await Bun.file(evotCapture).exists()).toBe(false)

      // Hook mode: self-referenced by command name through PATH.
      await rm(herdrCapture, { force: true })
      expect(await spawn([], {
        ...baseEnv,
        PATH: `${join(import.meta.dir, '../bin')}:${process.env.PATH ?? ''}`,
        EVOT_SESSION_HOOK: 'evot-herdr',
      })).toBe(0)
      expect(await Bun.file(herdrCapture).text()).toContain('pane report-agent w1:p1')
      expect(await Bun.file(evotCapture).exists()).toBe(false)

      // Wrapper mode: same env but arguments were given.
      expect(await spawn(['--help'], { ...baseEnv, EVOT_SESSION_HOOK: wrapper })).toBe(0)
      expect((await Bun.file(evotCapture).text()).trim()).toBe(`--help|${wrapper}`)

      // Wrapper mode: a custom hook is preserved and never treated as self.
      await rm(evotCapture, { force: true })
      const customHook = join(directory, 'custom-hook')
      expect(await spawn([], { ...baseEnv, EVOT_SESSION_HOOK: customHook })).toBe(0)
      expect((await Bun.file(evotCapture).text()).trim()).toBe(`|${customHook}`)

      // Wrapper mode: unset hook defaults to this executable.
      await rm(evotCapture, { force: true })
      const unset: NodeJS.ProcessEnv = { ...baseEnv }
      delete unset.EVOT_SESSION_HOOK
      expect(await spawn(['-p', 'x'], unset)).toBe(0)
      expect((await Bun.file(evotCapture).text()).trim()).toBe(`-p x|${wrapper}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('fences a late release across overlapping hook processes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    const capture = join(directory, 'calls')
    const sequenceState = join(directory, 'sequence')
    await writeExecutable(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$CAPTURE"
`)

    const hook = join(import.meta.dir, '../bin/evot-herdr')
    const env = {
      ...process.env,
      EVOT_SESSION_HOOK: hook,
      HERDR_BIN_PATH: herdr,
      HERDR_PANE_ID: 'w1:p1',
      EVOT_HERDR_SEQUENCE_STATE_PATH: sequenceState,
      CAPTURE: capture,
    }
    const older = Bun.spawn([hook], {
      env,
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      older.stdin.write(`${JSON.stringify({ version: 1, event: 'session_started', session_id: 'older' })}\n`)
      await waitForFileText(capture, text => text.includes('older'))

      const newer = Bun.spawn([hook], {
        env,
        stdin: 'pipe',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      try {
        newer.stdin.write(`${JSON.stringify({ version: 1, event: 'session_started', session_id: 'newer' })}\n`)
        await waitForFileText(capture, text => text.includes('newer'))

        older.stdin.write(`${JSON.stringify({ version: 1, event: 'session_ended', session_id: 'older' })}\n`)
        const output = await waitForFileText(
          capture,
          text => text.trim().split('\n').filter(line => line.includes('release-agent')).length >= 1,
        )
        const commands = output.trim().split('\n')
        const newerReport = commands.find(line => line.includes('report-agent') && line.includes('newer'))!
        const lateOlderRelease = commands.find(line => line.includes('release-agent'))!
        const sequenceOf = (line: string) => BigInt(line.match(/--seq (\d+)/)![1]!)
        expect(sequenceOf(lateOlderRelease) < sequenceOf(newerReport)).toBe(true)
      } finally {
        newer.stdin.end()
        await newer.exited
      }
    } finally {
      older.stdin.end()
      await older.exited
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('releases the agent before exiting on SIGTERM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    const capture = join(directory, 'calls')
    await writeExecutable(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> "$CAPTURE"
`)
    const hook = join(import.meta.dir, '../bin/evot-herdr')
    const child = Bun.spawn([hook], {
      env: {
        ...process.env,
        EVOT_SESSION_HOOK: hook,
        HERDR_BIN_PATH: herdr,
        HERDR_PANE_ID: 'w1:p1',
        CAPTURE: capture,
      },
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      child.stdin.write(`${JSON.stringify({ version: 1, event: 'session_started' })}\n`)
      await waitForFileText(capture, text => text.includes('report-agent'))
      child.kill('SIGTERM')
      expect(await child.exited).toBe(143)
      const output = await waitForFileText(capture, text => text.includes('release-agent'))
      expect(output).toContain('pane release-agent w1:p1')
    } finally {
      child.kill('SIGKILL')
      await rm(directory, { recursive: true, force: true })
    }
  })
})

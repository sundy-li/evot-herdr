import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { EvotHerdrAdapter, runEvot } from '../src/index.js'

async function writeExecutable(path: string, content: string): Promise<void> {
  await Bun.write(path, content)
  const result = Bun.spawnSync(['chmod', '+x', path])
  expect(result.exitCode).toBe(0)
}

describe('EvotHerdrAdapter', () => {
  test('maps lifecycle events to ordered Herdr commands', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1', HERDR_BIN_PATH: '/bin/herdr' },
      run: async argv => { commands.push(argv) },
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
    expect(commands[0]).toContain('--agent-session-id')
    expect(commands[0]).toContain('sid-1')
    expect(commands[1]).toContain('--agent-session-id')
    expect(commands[1]).toContain('sid-1')
    expect(commands[3]).toContain('--state')
    expect(commands[3]).toContain('blocked')
    expect(commands[3]).toContain('--message')
    expect(commands[3]).toContain('approve')
  })

  test('keeps sequence numbers newer across adapter instances', async () => {
    const commands: string[][] = []
    const run = async (argv: string[]) => { commands.push(argv) }
    const first = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run,
    })
    const second = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run,
    })

    await first.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await first.handle({ version: 1, event: 'session_ended', session_id: 'sid-1' })
    await second.handle({ version: 1, event: 'session_started', session_id: 'sid-2' })

    const sequences = commands.map(command => Number(command[command.indexOf('--seq') + 1]))
    expect(sequences).toHaveLength(5)
    expect(sequences.slice(1)).toEqual([...sequences.slice(1)].sort((a, b) => a - b))
    expect(sequences[2]).toBeGreaterThan(sequences[1]!)
  })

  test('deduplicates repeated state events', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => { commands.push(argv) },
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'working' })

    expect(commands).toHaveLength(3)
  })

  test('reports changed blocked messages even when state is unchanged', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => { commands.push(argv) },
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'blocked', message: 'first' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'blocked', message: 'second' })

    expect(commands).toHaveLength(4)
    expect(commands[3]).toContain('second')
  })

  test('reports a newly assigned session identity even when state stays idle', async () => {
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { HERDR_PANE_ID: 'w1:p1' },
      run: async argv => { commands.push(argv) },
    })

    await adapter.handle({ version: 1, event: 'session_started' })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })

    expect(commands).toHaveLength(3)
    expect(commands[0]).not.toContain('--agent-session-id')
    expect(commands[1]).toContain('--agent-session-id')
    expect(commands[1]).toContain('sid-1')
    expect(commands[2]).toContain('report-agent-session')
    expect(commands[2]).toContain('sid-1')
  })

  test('discovers the current Herdr pane when the wrapper environment omits it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-'))
    const herdr = join(directory, 'herdr')
    const evot = join(directory, 'evot')
    const calls = join(directory, 'calls')
    const previous = {
      EVOT_BIN_PATH: process.env.EVOT_BIN_PATH,
      EVOT_SESSION_HOOK: process.env.EVOT_SESSION_HOOK,
      HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
      HERDR_PANE_ID: process.env.HERDR_PANE_ID,
      CAPTURE: process.env.CAPTURE,
    }

    await writeExecutable(herdr, `#!/bin/sh
if [ "$1" = "pane" ] && [ "$2" = "current" ]; then
  printf '%s\\n' '{"result":{"pane":{"pane_id":"w9:p9"}}}'
  exit 0
fi
printf '%s\\n' "$*" >> "$CAPTURE"
`)
    await writeExecutable(evot, `#!/bin/sh
printf '%s\\n' '{"version":1,"event":"session_started","session_id":"sid-discovered"}' | "$EVOT_SESSION_HOOK"
`)

    try {
      process.env.EVOT_BIN_PATH = evot
      delete process.env.EVOT_SESSION_HOOK
      process.env.HERDR_BIN_PATH = herdr
      delete process.env.HERDR_PANE_ID
      process.env.CAPTURE = calls

      await runEvot([])

      const output = await Bun.file(calls).text()
      expect(output).toContain('pane report-agent w9:p9')
      expect(output).toContain('pane report-agent-session w9:p9')
      expect(output).toContain('sid-discovered')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
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
        run: async argv => { commands.push(argv) },
      })

      await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-direct' })

      expect(adapter.enabled).toBe(true)
      expect(commands[0]).toContain('w8:p1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('is inert without a pane id', async () => {
    let called = false
    const adapter = new EvotHerdrAdapter({
      env: {},
      run: async () => { called = true },
    })

    await adapter.handle({ version: 1, event: 'session_started', session_id: 'sid-1' })
    expect(adapter.enabled).toBe(false)
    expect(called).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { EvotHerdrAdapter } from '../src/index.js'

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

import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { buildResumeArgv, envFileFromArgs, EvotHerdrAdapter, runAdapter, runEvot } from '../src/index.js'
import { queryCommand, terminateProcessTree } from '../src/process.js'

const directory = await mkdtemp(join(tmpdir(), 'evot-herdr-resume-'))
const env = { ...process.env, HERDR_PANE_ID: 'w1:p1', EVOT_HERDR_SEQUENCE_STATE_PATH: join(directory, 'sequence') }
afterAll(() => rm(directory, { recursive: true, force: true }))

function recorder(supportsResume = true, extraEnv: NodeJS.ProcessEnv = {}) {
  const commands: string[][] = []
  let probes = 0
  const adapter = new EvotHerdrAdapter({
    env: { ...env, ...extraEnv },
    supportsResume: () => { probes++; return supportsResume },
    run: async argv => { commands.push(argv); return true },
  })
  return { adapter, commands, probes: () => probes }
}
const registrations = (commands: string[][]) => commands.filter(argv => argv[2] === 'report-agent-session')
const resume = (argv: string[]) => argv.slice(argv.indexOf('--') + 1)

async function executable(name: string, text: string) {
  const path = join(directory, name)
  await writeFile(path, '#!/bin/sh\n' + text)
  await chmod(path, 0o755)
  return path
}

describe('Herdr conversation restore', () => {
  test('registers a portable wrapper resume argv after claiming the pane', async () => {
    const { adapter, commands, probes } = recorder()
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'session-1' })
    await adapter.handle({ version: 1, event: 'state_changed', session_id: 'session-1', state: 'working' })
    expect(commands[0]?.[2]).toBe('report-agent')
    expect(resume(registrations(commands)[0]!)).toEqual(['evot-herdr', '--resume', 'session-1'])
    expect(registrations(commands)).toHaveLength(1)
    expect(probes()).toBe(1)
  })

  test('replaces the resume target without releasing ownership during session changes', async () => {
    const { adapter, commands, probes } = recorder()
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'old' })
    await adapter.handle({ version: 1, event: 'session_ended', session_id: 'old', reason: 'session_changed' })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'new' })
    expect(commands.some(argv => argv[2] === 'release-agent')).toBe(false)
    expect(registrations(commands).map(resume)).toEqual([
      ['evot-herdr', '--resume', 'old'], ['evot-herdr', '--resume', 'new'],
    ])
    expect(probes()).toBe(1)
    await adapter.close()
    expect(commands.at(-1)?.[2]).toBe('release-agent')
  })

  test('keeps pre-0.9.2 state and identity reporting without unsupported CLI arguments', async () => {
    const { adapter, commands } = recorder(false)
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'legacy' })
    const [registration] = registrations(commands)
    expect(registration).toContain('legacy')
    expect(registration).not.toContain('--')
    await adapter.close()
    expect(commands.at(-1)?.[2]).toBe('release-agent')
  })

  test('discovers real CLI capability once from help, not a hard-coded version', async () => {
    const calls = join(directory, 'probe-calls')
    const herdr = await executable('herdr-with-resume', `
if [ "$3" = "--help" ]; then
  echo help >> "$PROBE_CAPTURE"
  echo 'Arguments: [RESUME_ARG]...'
  exit 0
fi
`)
    const commands: string[][] = []
    const adapter = new EvotHerdrAdapter({
      env: { ...env, HERDR_BIN_PATH: herdr, PROBE_CAPTURE: calls },
      run: async argv => { commands.push(argv) },
    })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'one' })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'two' })
    expect(registrations(commands).map(resume)).toEqual([
      ['evot-herdr', '--resume', 'one'], ['evot-herdr', '--resume', 'two'],
    ])
    expect(await readFile(calls, 'utf8')).toBe('help\n')
  })

  test('failed or legacy capability probes never break lifecycle reporting', async () => {
    const legacy = await executable('herdr-legacy', "echo 'Arguments: <PANE_ID>'\n")
    for (const bin of [legacy, join(directory, 'missing-herdr')]) {
      const commands: string[][] = []
      const adapter = new EvotHerdrAdapter({ env: { ...env, HERDR_BIN_PATH: bin }, run: async argv => { commands.push(argv) } })
      await adapter.handle({ version: 1, event: 'session_started', session_id: 'one' })
      expect(registrations(commands)[0]).not.toContain('--')
      await adapter.close()
      expect(commands.at(-1)?.[2]).toBe('release-agent')
    }
  })

  test('retries a failed resume registration and does not register before ownership succeeds', async () => {
    const commands: string[][] = []
    let ownership = false
    let registered = false
    const adapter = new EvotHerdrAdapter({
      env, supportsResume: () => true,
      run: async argv => {
        commands.push(argv)
        if (argv[2] === 'report-agent' && !ownership) { ownership = true; return false }
        if (argv[2] === 'report-agent-session' && !registered) { registered = true; return false }
        return true
      },
    })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'one' })
    expect(registrations(commands)).toHaveLength(0)
    await adapter.handle({ version: 1, event: 'state_changed', state: 'idle' })
    await adapter.handle({ version: 1, event: 'state_changed', state: 'idle' })
    expect(registrations(commands).map(resume)).toEqual([
      ['evot-herdr', '--resume', 'one'], ['evot-herdr', '--resume', 'one'],
    ])
  })

  test('explicit exits release once, while a shutdown snapshot keeps its registered argv', async () => {
    // Model Herdr's documented shutdown boundary: snapshot first, then reject
    // late hook reports. The adapter must still release on ordinary exits.
    let stopping = false
    let live: string[] | undefined
    const adapter = new EvotHerdrAdapter({
      env, supportsResume: () => true,
      run: async argv => {
        if (stopping) return false
        if (argv[2] === 'report-agent-session') live = resume(argv)
        if (argv[2] === 'release-agent') live = undefined
        return true
      },
    })
    await adapter.handle({ version: 1, event: 'session_started', session_id: 'saved' })
    const snapshot = structuredClone(live)
    stopping = true
    await adapter.close()
    expect(snapshot).toEqual(['evot-herdr', '--resume', 'saved'])
    const { adapter: normal, commands } = recorder()
    async function* events() {
      yield JSON.stringify({ version: 1, event: 'session_started', session_id: 'quit' })
      yield JSON.stringify({ version: 1, event: 'session_ended', reason: 'process_exit' })
    }
    await runAdapter(events(), normal)
    expect(commands.filter(argv => argv[2] === 'release-agent')).toHaveLength(1)
  })

  test('preserves custom env-file from wrapper startup without saving prompt text or secrets', async () => {
    const capture = join(directory, 'captured-env')
    const evot = await executable('capture-evot', 'printf "%s" "$EVOT_HERDR_ENV_FILE" > "$CAPTURE"\n')
    const previous = { ...process.env }
    try {
      process.env.EVOT_BIN_PATH = evot
      process.env.CAPTURE = capture
      expect(await runEvot(['--env-file', 'custom config.env', '-p', 'private prompt'])).toBe(0)
      const envFile = await readFile(capture, 'utf8')
      expect(envFile.endsWith('/custom config.env')).toBe(true)
      expect(buildResumeArgv('saved', { EVOT_HERDR_ENV_FILE: envFile })).toEqual([
        'evot-herdr', '--resume', 'saved', '--env-file', envFile,
      ])
    } finally { process.env = previous }
  })

  test('does not mistake prompt or option contents for startup config', () => {
    for (const option of ['-p', '--prompt', '--model', '-f', '--append-system-prompt']) {
      expect(envFileFromArgs([option, '--env-file', 'private prompt'])).toBeUndefined()
    }
    expect(envFileFromArgs(['--env-file', 'first.env', '--prompt', '--env-file', '--env-file', 'last.env']))
      .toBe(join(process.cwd(), 'last.env'))
  })

  test('validates portable argv without handing arbitrary shell text to Herdr', () => {
    expect(buildResumeArgv('one', { EVOT_HERDR_RESUME_COMMAND: 'evot' })).toEqual(['evot', '--resume', 'one'])
    for (const command of ['/path/to/evot', '-evot', 'evot;exit', "ev'ot"]) {
      expect(buildResumeArgv('one', { EVOT_HERDR_RESUME_COMMAND: command })).toBeUndefined()
    }
    expect(buildResumeArgv("can't-quote", {})).toBeUndefined()
    expect(buildResumeArgv('bad\nvalue', {})).toBeUndefined()
    expect(buildResumeArgv('one', { EVOT_HERDR_ENV_FILE: "can't-quote.env" })).toBeUndefined()
    expect(buildResumeArgv('one', { EVOT_HERDR_ENV_FILE: '中'.repeat(3000) })).toBeUndefined()
  })

  test('failed command lookup never signals the caller process group', () => {
    terminateProcessTree(0, 'SIGKILL')
    terminateProcessTree(-1, 'SIGKILL')
    expect(queryCommand([join(directory, 'missing')], env, 100)).toBeUndefined()
  })
})

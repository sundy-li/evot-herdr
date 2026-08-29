import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

export type SessionHookState = 'working' | 'blocked' | 'idle'

export interface SessionHookEvent {
  version: 1
  event:
    | 'session_started'
    | 'state_changed'
    | 'run_started'
    | 'run_finished'
    | 'run_failed'
    | 'session_ended'
  session_id?: string
  run_id?: string
  state?: SessionHookState
  message?: string
  reason?: string
  cwd?: string
  source?: string
}

export interface HerdrRunner {
  (argv: string[]): Promise<void>
}

export interface AdapterOptions {
  env?: NodeJS.ProcessEnv
  run?: HerdrRunner
}

const SOURCE = 'custom:evot'
const AGENT = 'evot'

// Herdr de-duplicates stale updates by source and sequence number. The hook
// adapter is usually a short-lived process, so an in-memory counter starting
// at 1 would make every later evot launch look stale. Use a microsecond-scale
// wall-clock sequence and keep it monotonic within this process as well.
let reportSequence = Date.now() * 1_000

function nextReportSequence(): number {
  reportSequence = Math.max(reportSequence + 1, Date.now() * 1_000)
  return reportSequence
}

function defaultRun(argv: string[]): Promise<void> {
  try {
    const child = Bun.spawn(argv, { stdout: 'ignore', stderr: 'ignore' })
    return child.exited.then(() => undefined).catch(() => undefined)
  } catch {
    return Promise.resolve()
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

interface CurrentPaneResponse {
  result?: {
    pane?: {
      pane_id?: string
    }
  }
}

function currentPaneId(env: NodeJS.ProcessEnv): string | undefined {
  const herdrBin = clean(env.HERDR_BIN_PATH) ?? 'herdr'
  try {
    const result = Bun.spawnSync([herdrBin, 'pane', 'current'], {
      stdout: 'pipe',
      stderr: 'ignore',
      env,
    })
    if (result.exitCode !== 0) return undefined
    const response = JSON.parse(new TextDecoder().decode(result.stdout)) as CurrentPaneResponse
    return clean(response.result?.pane?.pane_id)
  } catch {
    return undefined
  }
}

export class EvotHerdrAdapter {
  private readonly paneId: string | null
  private readonly herdrBin: string
  private readonly run: HerdrRunner
  private sessionId: string | undefined
  private lastState: SessionHookState | undefined
  private lastMessage: string | undefined
  private lastReportedSessionId: string | undefined

  constructor(options: AdapterOptions = {}) {
    const env = options.env ?? process.env
    this.paneId = clean(env.HERDR_PANE_ID) ?? null
    this.herdrBin = clean(env.HERDR_BIN_PATH) ?? 'herdr'
    this.run = options.run ?? defaultRun
  }

  get enabled(): boolean {
    return this.paneId !== null
  }

  async handle(event: SessionHookEvent): Promise<void> {
    if (!this.enabled) return

    switch (event.event) {
      case 'session_started':
        this.sessionId = clean(event.session_id)
        this.lastState = undefined
        this.lastMessage = undefined
        this.lastReportedSessionId = undefined
        await this.report('idle')
        if (this.sessionId) await this.reportSession()
        return
      case 'run_started':
        await this.report('working', event.message)
        return
      case 'run_finished':
        await this.report('idle')
        return
      case 'run_failed':
        await this.report('idle', event.message)
        return
      case 'state_changed':
        if (event.state) await this.report(event.state, event.message)
        return
      case 'session_ended':
        await this.release()
        this.sessionId = undefined
        this.lastState = undefined
        this.lastMessage = undefined
        this.lastReportedSessionId = undefined
        return
    }
  }

  private async report(state: SessionHookState, message?: string): Promise<void> {
    const normalizedMessage = state === 'blocked' ? clean(message) : undefined
    if (
      !this.paneId
      || this.lastState === state
      && this.lastMessage === normalizedMessage
      && this.lastReportedSessionId === this.sessionId
    ) return
    this.lastState = state
    this.lastMessage = normalizedMessage
    this.lastReportedSessionId = this.sessionId
    const argv = [
      this.herdrBin,
      'pane',
      'report-agent',
      this.paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT,
      '--state',
      state,
      '--seq',
      String(nextReportSequence()),
    ]
    if (this.sessionId) argv.push('--agent-session-id', this.sessionId)
    if (state === 'blocked' && clean(message)) argv.push('--message', clean(message)!)
    await this.run(argv)
  }

  private async reportSession(): Promise<void> {
    if (!this.paneId || !this.sessionId) return
    this.lastReportedSessionId = this.sessionId
    await this.run([
      this.herdrBin,
      'pane',
      'report-agent-session',
      this.paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT,
      '--agent-session-id',
      this.sessionId,
      '--seq',
      String(nextReportSequence()),
    ])
  }

  private async release(): Promise<void> {
    if (!this.paneId) return
    await this.run([
      this.herdrBin,
      'pane',
      'release-agent',
      this.paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT,
      '--seq',
      String(nextReportSequence()),
    ])
  }
}

export async function runAdapter(
  input: AsyncIterable<string>,
  adapter = new EvotHerdrAdapter(),
): Promise<void> {
  for await (const line of input) {
    const text = line.trim()
    if (!text) continue
    try {
      const event = JSON.parse(text) as SessionHookEvent
      if (event.version !== 1 || typeof event.event !== 'string') continue
      await adapter.handle(event)
    } catch {
      // Malformed hook input or a failed Herdr call must not kill the reader.
    }
  }
}

export async function runEvot(args: string[] = []): Promise<void> {
  const env = { ...process.env }
  if (!clean(env.EVOT_SESSION_HOOK)) {
    env.EVOT_SESSION_HOOK = resolve(import.meta.dir, '../bin/evot-herdr')
  }
  if (!clean(env.HERDR_PANE_ID)) {
    const paneId = currentPaneId(env)
    if (paneId) env.HERDR_PANE_ID = paneId
  }
  const evotBin = clean(env.EVOT_BIN_PATH) ?? 'evot'
  try {
    const child = Bun.spawn([evotBin, ...args], {
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await child.exited
  } catch {
    // Keep the wrapper compatible with shell startup and unavailable evot
    // installations; the child reports its own errors when it starts.
  }
}

export async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  await runAdapter(lines)
}

if (import.meta.main) await main()

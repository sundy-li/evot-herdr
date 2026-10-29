import {
  accessSync,
  constants,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { queryCommand, spawnCommand, terminateProcessTree } from './process.js'

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
  // Returning false marks the command as failed. Existing runners that return
  // void remain compatible and are treated as successful.
  (argv: string[]): Promise<boolean | void>
}

export interface AdapterOptions {
  env?: NodeJS.ProcessEnv
  run?: HerdrRunner
  discoverPane?: boolean
  /** Inject capability detection for tests/embedded callers. Queried once. */
  supportsResume?: () => boolean
}

const SOURCE = 'custom:evot'
const AGENT = 'evot'
const DEFAULT_HERDR_TIMEOUT_MS = 2_000
const MAX_HOOK_LINE_BYTES = 1_048_576
const SUPPORTED_EVENTS = new Set<SessionHookEvent['event']>([
  'session_started',
  'state_changed',
  'run_started',
  'run_finished',
  'run_failed',
  'session_ended',
])
const SUPPORTED_STATES = new Set<SessionHookState>(['working', 'blocked', 'idle'])

// Each hook owns one fixed sequence block. A newer hook atomically reserves a
// higher block, so a late release from an older hook remains stale even when it
// is emitted after the replacement starts. The future offset fences adapters
// from the legacy event-time sequence scheme during rolling upgrades.
const SEQUENCE_BLOCK_SIZE = 1_000_000n
const LEGACY_SEQUENCE_FENCE_MS = 10n * 365n * 24n * 60n * 60n * 1_000n
const MAX_I64 = 9_223_372_036_854_775_807n
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function sequenceStatePath(env: NodeJS.ProcessEnv): string {
  const configured = clean(env.EVOT_HERDR_SEQUENCE_STATE_PATH)
  if (configured) {
    const statePath = resolve(configured)
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    return statePath
  }

  const stateRoot = process.platform === 'win32'
    ? clean(env.LOCALAPPDATA) ?? join(homedir(), 'AppData', 'Local')
    : clean(env.XDG_STATE_HOME) ?? join(homedir(), '.local', 'state')
  const directory = join(stateRoot, 'evot-herdr')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return join(directory, 'sequence')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function recoverStaleSequenceLock(lockPath: string): void {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age < 1_000) return

    const owner = Number(readFileSync(lockPath, 'utf8').trim())
    if (Number.isSafeInteger(owner) && owner > 0) {
      if (!processIsAlive(owner)) unlinkSync(lockPath)
      return
    }

    // An owner can be preempted between creating the lock and writing its PID.
    // Only recover an incomplete lock after a much longer grace period.
    if (age >= 10_000) unlinkSync(lockPath)
  } catch {
    // Another allocator may have released or recovered the lock.
  }
}

function reserveSequenceBlock(env: NodeJS.ProcessEnv): bigint {
  const statePath = sequenceStatePath(env)
  const lockPath = `${statePath}.lock`
  const deadline = Date.now() + DEFAULT_HERDR_TIMEOUT_MS

  while (true) {
    try {
      const lock = openSync(lockPath, 'wx', 0o600)
      let writeError: unknown
      try {
        writeFileSync(lock, `${process.pid}\n`)
      } catch (error) {
        writeError = error
      } finally {
        closeSync(lock)
      }
      if (writeError) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Preserve the original lock-write error.
        }
        throw writeError
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      recoverStaleSequenceLock(lockPath)
      if (Date.now() >= deadline) throw new Error('timed out reserving Herdr sequence block')
      sleepSync(5)
    }
  }

  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomUUID()}`
  try {
    let previous = 0n
    try {
      const stored = readFileSync(statePath, 'utf8').trim()
      if (!/^\d+$/.test(stored)) throw new Error('invalid Herdr sequence state')
      previous = BigInt(stored)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The first hook creates the state file.
    }

    const fencedNow = BigInt(Date.now()) + LEGACY_SEQUENCE_FENCE_MS
    const generation = fencedNow > previous ? fencedNow : previous + 1n
    const blockBase = generation * SEQUENCE_BLOCK_SIZE
    if (blockBase + SEQUENCE_BLOCK_SIZE - 1n > MAX_I64) {
      throw new Error('Herdr sequence space exhausted')
    }
    const temporary = openSync(temporaryPath, 'wx', 0o600)
    try {
      writeFileSync(temporary, `${generation}\n`)
      fsyncSync(temporary)
    } finally {
      closeSync(temporary)
    }
    renameSync(temporaryPath, statePath)
    return blockBase
  } finally {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // A successful rename already removed the temporary path.
    }
    try {
      unlinkSync(lockPath)
    } catch {
      // The lock may already have been recovered after a crash.
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function defaultRun(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const timeout = positiveInteger(env.HERDR_COMMAND_TIMEOUT_MS, DEFAULT_HERDR_TIMEOUT_MS)
    const { child, exited } = spawnCommand(argv, {
      env,
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    })
    let timedOut = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutReached = new Promise<undefined>(resolveTimeout => {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        terminateProcessTree(child.pid, 'SIGTERM')
        resolveTimeout(undefined)
      }, timeout)
    })

    let exitCode: number | undefined
    try {
      exitCode = await Promise.race([exited, timeoutReached])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
    if (!timedOut) return exitCode === 0

    // Give well-behaved processes a short grace period, then make sure no
    // descendant survives after the process-group leader exits.
    await Promise.race([exited, delay(100)])
    terminateProcessTree(child.pid, 'SIGKILL')
    await exited.catch(() => undefined)
    return false
  } catch {
    return false
  }
}

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
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
  const timeout = positiveInteger(env.HERDR_COMMAND_TIMEOUT_MS, DEFAULT_HERDR_TIMEOUT_MS)
  try {
    const output = queryCommand([herdrBin, 'pane', 'current'], env, timeout)
    if (!output) return undefined
    const response = JSON.parse(output) as CurrentPaneResponse
    return clean(response.result?.pane?.pane_id)
  } catch {
    return undefined
  }
}

function optionalStringFieldsAreValid(value: Record<string, unknown>): boolean {
  for (const field of ['session_id', 'run_id', 'message', 'reason', 'cwd', 'source']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false
  }
  return true
}

export function parseSessionHookEvent(text: string): SessionHookEvent | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.event !== 'string') return undefined
  if (!SUPPORTED_EVENTS.has(record.event as SessionHookEvent['event'])) return undefined
  if (!optionalStringFieldsAreValid(record)) return undefined
  if (
    record.event === 'state_changed'
    && (typeof record.state !== 'string' || !SUPPORTED_STATES.has(record.state as SessionHookState))
  ) return undefined
  if (
    record.state !== undefined
    && (typeof record.state !== 'string' || !SUPPORTED_STATES.has(record.state as SessionHookState))
  ) return undefined

  return record as unknown as SessionHookEvent
}

export class EvotHerdrAdapter {
  private readonly paneId: string | null
  private readonly herdrBin: string
  private readonly run: HerdrRunner
  private readonly sequenceBlockBase: bigint | null
  private sequenceOffset = 0n
  private sessionId: string | undefined
  private lastState: SessionHookState | undefined
  private lastMessage: string | undefined
  private lastReportedSessionId: string | undefined
  private lastRegisteredSessionId: string | undefined
  private releaseNeeded = false
  private readonly env: NodeJS.ProcessEnv
  private readonly detectResume: () => boolean
  private resumeSupported: boolean | undefined

  constructor(options: AdapterOptions = {}) {
    const env = options.env ?? process.env
    this.env = env
    this.detectResume = options.supportsResume ?? (() => {
      const help = queryCommand(
        [this.herdrBin, 'pane', 'report-agent-session', '--help'], env,
        positiveInteger(env.HERDR_COMMAND_TIMEOUT_MS, DEFAULT_HERDR_TIMEOUT_MS),
      )
      return /resume[_-]arg/i.test(help ?? '')
    })
    // Reserve before pane discovery so construction order, not the completion
    // time of external work, determines which hook owns the newer generation.
    // If persistence is unavailable, disable this best-effort integration
    // instead of crashing the hook process or interfering with evot.
    try {
      this.sequenceBlockBase = reserveSequenceBlock({ ...process.env, ...env })
    } catch {
      this.sequenceBlockBase = null
    }
    this.herdrBin = clean(env.HERDR_BIN_PATH) ?? 'herdr'
    // A hook launched directly by evot only inherits EVOT_SESSION_HOOK. In
    // that mode, discover the pane instead of silently disabling the adapter.
    // Tests and library callers that provide an explicit env remain fully
    // deterministic unless they opt into discovery.
    const discoverPane = options.discoverPane ?? options.env === undefined
    this.paneId = this.sequenceBlockBase === null
      ? null
      : clean(env.HERDR_PANE_ID)
        ?? (discoverPane ? currentPaneId(env) : undefined)
        ?? null
    this.run = options.run ?? (argv => defaultRun(argv, env))
  }

  get enabled(): boolean {
    return this.paneId !== null && this.sequenceBlockBase !== null
  }

  private nextSequence(): string {
    if (this.sequenceBlockBase === null) throw new Error('Herdr sequence state unavailable')
    this.sequenceOffset++
    if (this.sequenceOffset >= SEQUENCE_BLOCK_SIZE) {
      throw new Error('Herdr sequence block exhausted')
    }
    return (this.sequenceBlockBase + this.sequenceOffset).toString()
  }

  private async runCommand(argv: string[]): Promise<boolean> {
    return await this.run(argv) !== false
  }

  async handle(event: SessionHookEvent): Promise<void> {
    if (!this.enabled) return

    // evot respawns the hook lazily after it exits, so a replacement hook may
    // first see a mid-session event. Adopt the session identity it carries.
    const incomingSessionId = clean(event.session_id)
    if (
      event.event !== 'session_started'
      && event.event !== 'session_ended'
      && incomingSessionId
      && incomingSessionId !== this.sessionId
    ) {
      this.sessionId = incomingSessionId
      this.lastRegisteredSessionId = undefined
    }

    switch (event.event) {
      case 'session_started':
        this.sessionId = clean(event.session_id)
        this.resetReportedState()
        this.lastRegisteredSessionId = undefined
        this.releaseNeeded = true
        await this.reportAndRegister('idle')
        return
      case 'run_started':
        await this.reportAndRegister('working', event.message)
        return
      case 'run_finished':
        await this.reportAndRegister('idle')
        return
      case 'run_failed':
        await this.reportAndRegister('idle', event.message)
        return
      case 'state_changed':
        if (event.state) await this.reportAndRegister(event.state, event.message)
        return
      case 'session_ended':
        // A replacement follows immediately. Keep ownership until its new
        // identity/resume command is registered instead of releasing the pane.
        if (event.reason === 'session_changed') return
        await this.release()
        this.clearSession()
        return
    }
  }

  async close(): Promise<void> {
    await this.release()
    this.clearSession()
  }

  private resetReportedState(): void {
    this.lastState = undefined
    this.lastMessage = undefined
    this.lastReportedSessionId = undefined
  }

  private clearSession(): void {
    this.sessionId = undefined
    this.lastRegisteredSessionId = undefined
    this.resetReportedState()
  }

  private async reportAndRegister(state: SessionHookState, message?: string): Promise<void> {
    this.releaseNeeded = true
    await this.report(state, message)
    await this.reportSession()
  }

  private async report(state: SessionHookState, message?: string): Promise<void> {
    const normalizedMessage = clean(message)
    if (
      !this.paneId
      || this.lastState === state
      && this.lastMessage === normalizedMessage
      && this.lastReportedSessionId === this.sessionId
    ) return

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
      this.nextSequence(),
    ]
    if (this.sessionId) argv.push('--agent-session-id', this.sessionId)
    if (normalizedMessage) argv.push('--message', normalizedMessage)

    if (await this.runCommand(argv)) {
      this.lastState = state
      this.lastMessage = normalizedMessage
      this.lastReportedSessionId = this.sessionId
    }
  }

  private async reportSession(): Promise<void> {
    if (
      !this.paneId
      || !this.sessionId
      || this.lastRegisteredSessionId === this.sessionId
    ) return
    // Only an accepted state report establishes pane ownership. Never mark a
    // session registered after a failed ownership claim.
    if (this.lastReportedSessionId !== this.sessionId) return
    const argv = [
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
      this.nextSequence(),
    ]
    this.resumeSupported ??= this.detectResume()
    const resume = buildResumeArgv(this.sessionId, this.env)
    if (this.resumeSupported && resume) argv.push('--', ...resume)
    if (await this.runCommand(argv)) this.lastRegisteredSessionId = this.sessionId
  }

  private async release(): Promise<void> {
    if (!this.paneId || !this.releaseNeeded) return
    if (await this.runCommand([
      this.herdrBin,
      'pane',
      'release-agent',
      this.paneId,
      '--source',
      SOURCE,
      '--agent',
      AGENT,
      '--seq',
      this.nextSequence(),
    ])) this.releaseNeeded = false
  }
}

export async function runAdapter(
  input: AsyncIterable<string>,
  adapter = new EvotHerdrAdapter(),
): Promise<void> {
  try {
    for await (const line of input) {
      const text = line.trim()
      if (!text) continue
      const event = parseSessionHookEvent(text)
      if (!event) continue
      try {
        await adapter.handle(event)
      } catch {
        // A custom runner must not kill the NDJSON reader.
      }
    }
  } finally {
    try {
      await adapter.close()
    } catch {
      // Releasing after EOF is best effort.
    }
  }
}

export async function* readBoundedLines(
  input: AsyncIterable<Uint8Array | string>,
  maxLineBytes = MAX_HOOK_LINE_BYTES,
): AsyncIterable<string> {
  let parts: Buffer[] = []
  let length = 0
  let discarding = false

  for await (const chunk of input) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start)
      const end = newline === -1 ? bytes.length : newline
      const part = bytes.subarray(start, end)

      if (!discarding) {
        if (length + part.length <= maxLineBytes) {
          if (part.length > 0) parts.push(Buffer.from(part))
          length += part.length
        } else {
          parts = []
          length = 0
          discarding = true
        }
      }

      if (newline === -1) break
      if (!discarding) yield Buffer.concat(parts, length).toString('utf8')
      parts = []
      length = 0
      discarding = false
      start = newline + 1
    }
  }

  if (!discarding && length > 0) yield Buffer.concat(parts, length).toString('utf8')
}

function sameExecutable(
  left: string,
  right: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const resolvedLeft = executableOnPath(left, env) ?? resolve(left)
  const resolvedRight = executableOnPath(right, env) ?? resolve(right)
  try {
    return realpathSync(resolvedLeft) === realpathSync(resolvedRight)
  } catch {
    return resolvedLeft === resolvedRight
  }
}

function executableOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes('/') || command.includes('\\')) return undefined
  const extensions = process.platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
    : ['']
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, command + extension)
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch { /* keep searching */ }
    }
  }
  return undefined
}

const EXECUTABLE_PATH = fileURLToPath(new URL('../bin/evot-herdr', import.meta.url))

/** Match Herdr's portable restore quoting restrictions. Never construct shell
 * text, and never let an unsupported resume argv break ordinary state reports.
 */
export function buildResumeArgv(sessionId: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const command = clean(env.EVOT_HERDR_RESUME_COMMAND) ?? 'evot-herdr'
  const argv = [command, '--resume', sessionId]
  const envFile = clean(env.EVOT_HERDR_ENV_FILE)
  if (envFile) argv.push('--env-file', resolve(envFile))
  if (!/^[a-z0-9_.][a-z0-9_.-]*$/i.test(command)) return undefined
  if (argv.some(arg => /['\p{Cc}]/u.test(arg))) return undefined
  if (argv.reduce((bytes, arg) => bytes + Buffer.byteLength(arg), 0) > 8192) return undefined
  return argv
}

/**
 * `bin/evot-herdr` is both the wrapper and the hook. evot launches the hook
 * with no arguments and a piped stdin, and it only launches this executable
 * when EVOT_SESSION_HOOK points at it. All three signals must agree before we
 * treat an invocation as the hook, so `evot-herdr --help </dev/null` and a
 * plain interactive `evot-herdr` still run evot.
 */
export function isHookInvocation(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  stdinIsTTY: boolean = process.stdin.isTTY === true,
): boolean {
  if (args.length > 0 || stdinIsTTY) return false
  const configuredHook = clean(env.EVOT_SESSION_HOOK)
  return configuredHook !== undefined && sameExecutable(configuredHook, EXECUTABLE_PATH, env)
}

const VALUE_OPTIONS = new Set([
  '-p', '--prompt', '-f', '--file', '--model', '--port', '-r', '--resume',
  '--output-format', '--max-turns', '--max-tokens', '--max-duration',
  '--append-system-prompt', '--skills', '--skill', '--tools', '--permission',
])

/** Read only the startup config flag, never a prompt/attachment/option value
 * that happens to contain the text "--env-file".
 */
export function envFileFromArgs(args: string[]): string | undefined {
  let envFile: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--env-file' && args[index + 1]) envFile = resolve(args[++index]!)
    else if (VALUE_OPTIONS.has(arg) && args[index + 1]) index++
    else if (arg === '--fork' && args[index + 1] && !args[index + 1]!.startsWith('-')) index++
  }
  return envFile
}

export async function runEvot(args: string[] = []): Promise<number> {
  const env = { ...process.env }
  if (!clean(env.EVOT_SESSION_HOOK)) env.EVOT_SESSION_HOOK = EXECUTABLE_PATH
  if (!clean(env.HERDR_PANE_ID)) {
    const paneId = currentPaneId(env)
    if (paneId) env.HERDR_PANE_ID = paneId
  }
  // Preserve custom config across a server restart without persisting secrets
  // or replaying one-shot prompts. Model selection comes from session metadata.
  const envFile = envFileFromArgs(args)
  if (envFile) env.EVOT_HERDR_ENV_FILE = envFile
  const evotBin = clean(env.EVOT_BIN_PATH) ?? 'evot'
  try {
    const { child, exited } = spawnCommand([evotBin, ...args], { env, stdio: 'inherit' })
    const onInterrupt = () => { child.kill('SIGINT') }
    const onTerminate = () => { child.kill('SIGTERM') }
    const onHangup = () => { child.kill('SIGHUP') }
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)
    process.on('SIGHUP', onHangup)
    try {
      return await exited
    } finally {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', onTerminate)
      process.off('SIGHUP', onHangup)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`evot-herdr: failed to start ${evotBin}: ${detail}`)
    return 127
  }
}

export async function main(): Promise<void> {
  let signalExitCode: number | undefined
  const stopOnSignal = (exitCode: number) => {
    signalExitCode ??= exitCode
    process.stdin.destroy()
  }
  const onSigint = () => stopOnSignal(130)
  const onSigterm = () => stopOnSignal(143)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    await runAdapter(readBoundedLines(process.stdin))
  } catch (error) {
    if (signalExitCode === undefined) throw error
    // Destroying stdin to stop the async iterator may reject the stream. The
    // signal is already represented by the conventional exit status below.
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (signalExitCode !== undefined) process.exitCode = signalExitCode
  }
}

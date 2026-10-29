import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { constants } from 'node:os'

export function spawnCommand(argv: string[], options: SpawnOptions = {}) {
  const [command, ...args] = argv
  if (!command) throw new Error('empty command')
  const child = spawn(command, args, options)
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1))
    })
  })
  return { child, exited }
}

export function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  // Failed spawns may report pid=0; signalling -0 would kill our own group.
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal)
    else spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', timeout: 1_000,
    })
  } catch {
    // The process or process group has already exited.
  }
}

/** Small, bounded local CLI queries. Kill the full group even if the group
 * leader exits on timeout, since descendants may have inherited stdout.
 */
export function queryCommand(argv: string[], env: NodeJS.ProcessEnv, timeout: number): string | undefined {
  const [command, ...args] = argv
  if (!command) return undefined
  try {
    // Node uses the shared spawn argument normalizer for spawnSync too;
    // @types/node omits its detached option from the synchronous overload.
    const options = {
      env, encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
      timeout, killSignal: 'SIGKILL' as const, maxBuffer: 1_048_576,
      detached: process.platform !== 'win32',
    }
    const result = spawnSync(command, args, options)
    if (result.error) terminateProcessTree(result.pid, 'SIGKILL')
    return !result.error && result.status === 0 ? result.stdout : undefined
  } catch {
    return undefined
  }
}

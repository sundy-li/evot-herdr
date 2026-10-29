import { access, readFile } from 'node:fs/promises'
import { spawnCommand } from '../src/process.js'

export function file(path: string) {
  return {
    text: () => readFile(path, 'utf8'),
    async exists() {
      try { await access(path); return true } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
  }
}

export function spawnTest(argv: string[], options: {
  env: NodeJS.ProcessEnv; stdin: 'pipe'; stdout: 'ignore'; stderr: 'ignore'
}) {
  const { child, exited } = spawnCommand(argv, { env: options.env, stdio: ['pipe', 'ignore', 'ignore'] })
  if (!child.stdin) throw new Error('test child requires stdin')
  return { stdin: child.stdin, exited, kill: (signal: NodeJS.Signals) => child.kill(signal) }
}

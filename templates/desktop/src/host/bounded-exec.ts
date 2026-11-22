import { execFile } from 'node:child_process'

export interface CapturedCommand {
  readonly stdout: string
  readonly timedOut: boolean
}

export function captureBounded(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxBuffer = 1024 * 1024,
): Promise<CapturedCommand> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (stdout: string, timedOut: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, timedOut })
    }
    const child = execFile(command, [...args], { windowsHide: true, maxBuffer }, (error, stdout) => {
      finish(error ? '' : stdout, false)
    })
    const timer = setTimeout(() => {
      const pid = child.pid
      if (pid !== undefined) {
        try { child.kill('SIGKILL') } catch { /* gone */ }
      }
      finish('', true)
    }, timeoutMs)
  })
}

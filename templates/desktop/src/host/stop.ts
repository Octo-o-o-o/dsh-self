import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const HOST_STOP_GRACE_MS = 10_000

export function windowsTreeKillArgs(pid: number): readonly string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to kill invalid pid ${pid}`)
  return ['/PID', String(pid), '/T', '/F']
}

function readProcessGroupId(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  if (process.platform === 'linux') {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const end = text.lastIndexOf(')')
      if (end < 0) return undefined
      const pgrp = Number(text.slice(end + 2).split(' ')[2])
      return Number.isInteger(pgrp) && pgrp > 0 ? pgrp : undefined
    } catch { return undefined }
  }
  if (process.platform === 'darwin') {
    try {
      const stdout = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', windowsHide: true })
      const pgid = Number(stdout.trim())
      return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined
    } catch { return undefined }
  }
  return undefined
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  const pgid = readProcessGroupId(pid)
  const leader = pgid !== undefined && pgid === pid
  try {
    process.kill(leader ? -pid : pid, signal)
  } catch {
    if (!leader) return
    try { process.kill(pid, signal) } catch { /* gone */ }
  }
}

export async function forceKillTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const args = windowsTreeKillArgs(pid)
    await new Promise<void>((resolve) => {
      execFile('taskkill', [...args], { windowsHide: true }, () => { resolve() })
    })
    return
  }
  signalGroup(pid, 'SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  signalGroup(pid, 'SIGKILL')
}

export interface StopSequence {
  requestShutdown(): void
  waitForExit(timeoutMs: number): Promise<boolean>
  forceKillTree(): Promise<void>
}

export async function runStopSequence(sequence: StopSequence, timeoutMs = HOST_STOP_GRACE_MS): Promise<'graceful' | 'forced'> {
  sequence.requestShutdown()
  const exited = await sequence.waitForExit(timeoutMs)
  if (exited) return 'graceful'
  await sequence.forceKillTree()
  return 'forced'
}

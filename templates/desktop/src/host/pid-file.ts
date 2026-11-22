import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { enforcePosixFileMode } from './posix-perms.js'

export interface HostRecord {
  readonly pid: number
  readonly createdAtMs: number
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function readDocument(file: string): HostRecord[] {
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown }
    if (!Array.isArray(parsed.hosts)) return []
    const out: HostRecord[] = []
    for (const item of parsed.hosts) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as { pid?: unknown; createdAtMs?: unknown }
      if (!isPid(rec.pid)) continue
      const createdAtMs = typeof rec.createdAtMs === 'number' && Number.isFinite(rec.createdAtMs) ? rec.createdAtMs : 0
      out.push({ pid: rec.pid, createdAtMs })
    }
    return out
  } catch {
    return []
  }
}

function writeDocument(file: string, hosts: readonly HostRecord[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ pids: hosts.map((h) => h.pid), hosts }, undefined, 2)}\n`)
  try {
    renameSync(tmp, file)
    enforcePosixFileMode(file, 0o600)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function withLock(file: string, fn: () => void): void {
  const lockDir = `${file}.lock`
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let age = 0
      try { age = Date.now() - statSync(lockDir).mtimeMs } catch { age = 0 }
      if (age > 10_000) {
        rmSync(lockDir, { recursive: true, force: true })
        continue
      }
      if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for pid lock ${file}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { fn() } finally { rmSync(lockDir, { recursive: true, force: true }) }
}

export function readHostRecords(file: string): HostRecord[] {
  return readDocument(file)
}

export function rememberHost(file: string, record: HostRecord): void {
  withLock(file, () => {
    const hosts = readDocument(file).filter((h) => h.pid !== record.pid)
    hosts.push(record)
    writeDocument(file, hosts)
  })
}

export function forgetHostPid(file: string, pid: number): void {
  withLock(file, () => {
    writeDocument(file, readDocument(file).filter((h) => h.pid !== pid))
  })
}

export function clearHostRecords(file: string): void {
  withLock(file, () => {
    writeDocument(file, [])
  })
}

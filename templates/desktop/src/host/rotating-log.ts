import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import { LOG_KEEP, LOG_MAX_BYTES } from '../identity.js'
import { enforcePosixDirMode, enforcePosixFileMode } from './posix-perms.js'

export interface RotatingLog {
  write(chunk: string): void
  close(): void
}

export function createRotatingLog(
  file: string,
  options: { readonly maxBytes?: number; readonly keep?: number } = {},
): RotatingLog {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const keep = options.keep ?? LOG_KEEP
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  enforcePosixDirMode(dir, 0o700)
  let fd = openSync(file, 'a')
  enforcePosixFileMode(file, 0o600)
  let size = statSync(file).size
  let closed = false

  function rotate(): void {
    closeSync(fd)
    rmSync(`${file}.${keep - 1}`, { force: true })
    for (let i = keep - 2; i >= 1; i -= 1) {
      try { renameSync(`${file}.${i}`, `${file}.${i + 1}`) } catch { /* absent */ }
    }
    try { renameSync(file, `${file}.1`) } catch { /* absent */ }
    fd = openSync(file, 'a')
    enforcePosixFileMode(file, 0o600)
    size = 0
  }

  return {
    write(chunk: string) {
      if (closed || chunk.length === 0) return
      const buf = Buffer.from(chunk)
      if (size > 0 && size + buf.length > maxBytes) rotate()
      writeSync(fd, buf)
      size += buf.length
    },
    close() {
      if (closed) return
      closed = true
      closeSync(fd)
    },
  }
}

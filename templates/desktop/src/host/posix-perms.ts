import { chmodSync, existsSync } from 'node:fs'

/** Enforce strict POSIX permissions (0600 files, 0700 dirs); no-op on Windows. */
export function enforcePosixFileMode(filePath: string, mode = 0o600): void {
  if (process.platform === 'win32' || !existsSync(filePath)) return
  try {
    chmodSync(filePath, mode)
  } catch {
    // Best-effort on filesystems without POSIX mode bits.
  }
}

export function enforcePosixDirMode(dirPath: string, mode = 0o700): void {
  if (process.platform === 'win32' || !existsSync(dirPath)) return
  try {
    chmodSync(dirPath, mode)
  } catch {
    // Best-effort.
  }
}

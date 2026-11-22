import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  StateVersionSchema,
  checkStateDowngrade,
  type DowngradeCheckResult,
  type StateVersion,
} from '@dsh-self/product-spec'

const STATE_VERSION_FILENAME = 'state-version.json'

export function stateVersionPath(userDataDir: string): string {
  return path.join(userDataDir, STATE_VERSION_FILENAME)
}

export function readStateVersion(userDataDir: string): StateVersion | null {
  const file = stateVersionPath(userDataDir)
  if (!existsSync(file)) return null
  try {
    return StateVersionSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function checkUserDataDowngrade(
  userDataDir: string,
  current: { readonly dataFormatVersion: number; readonly dshSessionFormatVersion: number },
): DowngradeCheckResult {
  return checkStateDowngrade(readStateVersion(userDataDir), current)
}

export function recordStateVersion(
  userDataDir: string,
  current: {
    readonly dataFormatVersion: number
    readonly dshSessionFormatVersion: number
    readonly appVersion: string
  },
): StateVersion {
  const existing = readStateVersion(userDataDir)
  const next: StateVersion = {
    dataFormatVersion: Math.max(existing?.dataFormatVersion ?? 0, current.dataFormatVersion),
    dshSessionFormatVersion: Math.max(existing?.dshSessionFormatVersion ?? 0, current.dshSessionFormatVersion),
    lastAppVersion: current.appVersion,
    updatedAt: new Date().toISOString(),
  }
  const file = stateVersionPath(userDataDir)
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, undefined, 2)}\n`)
  try {
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
  return next
}

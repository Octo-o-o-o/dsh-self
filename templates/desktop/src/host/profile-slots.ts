import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import {
  ActiveProfileSchema,
  type ActiveProfileState,
  type SeedManifest,
} from '@dsh-self/product-spec'
import { enforcePosixFileMode } from './posix-perms.js'
import { extractSafeTarGz } from './safe-tar.js'

const ACTIVE_PROFILE_FILENAME = 'active-profile.json'

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, undefined, 2)}\n`)
  try {
    renameSync(tmp, filePath)
    enforcePosixFileMode(filePath, 0o600)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export function activeProfilePath(userDataDir: string): string {
  return path.join(userDataDir, ACTIVE_PROFILE_FILENAME)
}

export function readActiveProfile(userDataDir: string): ActiveProfileState | null {
  const file = activeProfilePath(userDataDir)
  if (!existsSync(file)) return null
  try {
    return ActiveProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function slotNameForSeedHash(seedHash: string): string {
  const short = seedHash.toLowerCase().slice(0, 12)
  // Always prefixed `p-`, never `'desktop'` (which triggers upstream desktop telemetry rows).
  return `p-${short}`
}

/**
 * Key-level deep merge of Cordis patch arrays when upgrading between profile slots:
 * preserves user-edited keys inside `ui-settings-general` (and other user-configured rows)
 * while applying the new seed's defaults (`welcomeNoticeVersion`, `session-log-deepseek: false`).
 */
export function mergeCordisPatchYaml(oldPatchText: string, newSeedPatchText: string): string {
  const parseList = (text: string): Record<string, unknown>[] => {
    try {
      const parsed = parse(text)
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []
    } catch {
      return []
    }
  }
  const oldRows = parseList(oldPatchText)
  const newRows = parseList(newSeedPatchText)
  const merged = [...newRows]

  for (const oldRow of oldRows) {
    const id = typeof oldRow.id === 'string' ? oldRow.id : undefined
    if (id === undefined) continue
    const idx = merged.findIndex((r) => r.id === id)
    if (idx === -1) {
      merged.push(oldRow)
      continue
    }
    const seedRow = merged[idx]!
    if (
      typeof oldRow.config === 'object' && oldRow.config !== null && !Array.isArray(oldRow.config) &&
      typeof seedRow.config === 'object' && seedRow.config !== null && !Array.isArray(seedRow.config)
    ) {
      // Preserve user keys in ui-settings-general etc., while ensuring seed's welcomeNoticeVersion stays current
      merged[idx] = {
        ...oldRow,
        ...seedRow,
        config: {
          ...(oldRow.config as Record<string, unknown>),
          ...(seedRow.config as Record<string, unknown>),
        },
      }
    }
  }
  return stringify(merged)
}

/** Detect user-installed extension packages outside managedBundles for non-blocking restore prompt. */
export function findUserInstalledExtensions(
  oldSlotDir: string,
  managedBundles: readonly string[],
): string[] {
  const pkgPath = path.join(oldSlotDir, 'package.json')
  if (!existsSync(pkgPath)) return []
  try {
    const manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> }
    const deps = Object.keys(manifest.dependencies ?? {})
    const managed = new Set(managedBundles)
    return deps.filter((name) => !managed.has(name)).sort()
  } catch {
    return []
  }
}

export interface PrepareSlotResult {
  readonly state: ActiveProfileState
  readonly profileDir: string
  readonly upgraded: boolean
  readonly userExtensionsToRestore: readonly string[]
}

/**
 * Ensure the active profile slot under `<dshHome>/profiles/p-<shortHash>` matches `seedManifest.seedHash`.
 * Triggered strictly by `seedHash` (not only `appVersion`), atomic unpack + rename, zero EBUSY on old slot.
 */
export function ensureDualSlotProfile(options: {
  readonly userDataDir: string
  readonly dshHome: string
  readonly seedArchivePath: string
  readonly seedManifest: SeedManifest
}): PrepareSlotResult {
  const profilesRoot = path.join(options.dshHome, 'profiles')
  mkdirSync(profilesRoot, { recursive: true })
  const current = readActiveProfile(options.userDataDir)
  const desiredSlot = slotNameForSeedHash(options.seedManifest.seedHash)
  const desiredDir = path.join(profilesRoot, desiredSlot)

  // Already on this exact seedHash (or explicitly rolled back from a failed slot of this hash)
  if (current !== null) {
    if (
      current.state === 'rolled_back' &&
      current.failedSlotHash === options.seedManifest.seedHash &&
      existsSync(path.join(profilesRoot, current.active))
    ) {
      return {
        state: current,
        profileDir: path.join(profilesRoot, current.active),
        upgraded: false,
        userExtensionsToRestore: [],
      }
    }
    if (current.activeSeedHash === options.seedManifest.seedHash && existsSync(desiredDir)) {
      return {
        state: current,
        profileDir: desiredDir,
        upgraded: false,
        userExtensionsToRestore: [],
      }
    }
  }

  // Extract new seed archive into temp sibling dir, verify SHA-256, merge old user patch, atomic rename
  const archiveBuffer = readFileSync(options.seedArchivePath)
  const tmpDir = path.join(profilesRoot, `.tmp-${desiredSlot}-${process.pid}-${randomBytes(4).toString('hex')}`)
  let userExtensionsToRestore: string[] = []
  try {
    extractSafeTarGz({
      archiveBuffer,
      destDir: tmpDir,
      expectedSha256: options.seedManifest.seedHash,
    })

    if (current !== null) {
      const oldSlotDir = path.join(profilesRoot, current.active)
      if (existsSync(oldSlotDir)) {
        const oldPatch = path.join(oldSlotDir, 'cordis.patch.yml')
        const newPatch = path.join(tmpDir, 'cordis.patch.yml')
        if (existsSync(oldPatch) && existsSync(newPatch)) {
          const merged = mergeCordisPatchYaml(readFileSync(oldPatch, 'utf8'), readFileSync(newPatch, 'utf8'))
          writeFileSync(newPatch, merged)
        }
        const oldCompat = path.join(oldSlotDir, 'compatibility.json')
        if (existsSync(oldCompat)) {
          copyFileSync(oldCompat, path.join(tmpDir, 'compatibility.json'))
        }
        userExtensionsToRestore = findUserInstalledExtensions(oldSlotDir, options.seedManifest.managedBundles)
      }
    }

    if (existsSync(desiredDir)) {
      rmSync(desiredDir, { recursive: true, force: true })
    }
    renameSync(tmpDir, desiredDir)
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }

  const nextState: ActiveProfileState = {
    active: desiredSlot,
    previous: current !== null && current.active !== desiredSlot ? current.active : (current?.previous ?? null),
    state: 'pending_verification',
    bootAttempts: 0,
    dshRuntimeVersion: options.seedManifest.dshRuntimeVersion,
    previousDshRuntimeVersion: current !== null && current.active !== desiredSlot
      ? current.dshRuntimeVersion
      : (current?.previousDshRuntimeVersion ?? null),
    activeSeedHash: options.seedManifest.seedHash,
    previousSeedHash: current !== null && current.active !== desiredSlot
      ? current.activeSeedHash
      : (current?.previousSeedHash ?? null),
    failedSlotHash: null,
    updatedAt: new Date().toISOString(),
  }
  atomicWriteJson(activeProfilePath(options.userDataDir), nextState)
  return { state: nextState, profileDir: desiredDir, upgraded: current !== null, userExtensionsToRestore }
}

/** Increment boot attempt counter atomically before spawning Host. */
export function recordSlotBootAttempt(userDataDir: string): ActiveProfileState | null {
  const current = readActiveProfile(userDataDir)
  if (current === null) return null
  const updated: ActiveProfileState = {
    ...current,
    bootAttempts: current.bootAttempts + 1,
    updatedAt: new Date().toISOString(),
  }
  atomicWriteJson(activeProfilePath(userDataDir), updated)
  return updated
}

/**
 * Mark active slot healthy after composite health probe passes (Host ready + /api/product-spec 200
 * + core bundles active + main window loaded), and prune any slots older than `active` and `previous`.
 */
export function markSlotVerified(userDataDir: string, dshHome: string): ActiveProfileState | null {
  const current = readActiveProfile(userDataDir)
  if (current === null) return null
  const updated: ActiveProfileState = {
    ...current,
    state: current.state === 'rolled_back' ? 'rolled_back' : 'verified',
    bootAttempts: 0,
    updatedAt: new Date().toISOString(),
  }
  atomicWriteJson(activeProfilePath(userDataDir), updated)

  const profilesRoot = path.join(dshHome, 'profiles')
  if (existsSync(profilesRoot)) {
    const keep = new Set([updated.active, ...(updated.previous ? [updated.previous] : [])])
    for (const entry of readdirSync(profilesRoot)) {
      if (entry.startsWith('p-') && !keep.has(entry)) {
        rmSync(path.join(profilesRoot, entry), { recursive: true, force: true })
      }
    }
  }
  return updated
}

/**
 * Handle cold-boot failure on the active slot:
 * After 2 consecutive failures, automatically roll back to `previous` ONLY when
 * `previousDshRuntimeVersion === currentDshRuntimeVersion`; otherwise drop into `safe_mode`.
 */
export function handleSlotBootFailure(
  userDataDir: string,
  dshHome: string,
  currentDshRuntimeVersion: string,
): { readonly action: 'retry' | 'rolled_back' | 'safe_mode'; readonly state: ActiveProfileState | null } {
  const current = readActiveProfile(userDataDir)
  if (current === null) return { action: 'safe_mode', state: null }
  if (current.bootAttempts < 2) {
    return { action: 'retry', state: current }
  }
  const profilesRoot = path.join(dshHome, 'profiles')
  const canRollback =
    current.previous !== null &&
    current.previousSeedHash !== null &&
    current.previousDshRuntimeVersion === currentDshRuntimeVersion &&
    existsSync(path.join(profilesRoot, current.previous))

  if (canRollback) {
    const rolled: ActiveProfileState = {
      active: current.previous!,
      previous: current.active,
      state: 'rolled_back',
      bootAttempts: 0,
      dshRuntimeVersion: current.previousDshRuntimeVersion!,
      previousDshRuntimeVersion: current.dshRuntimeVersion,
      activeSeedHash: current.previousSeedHash!,
      previousSeedHash: current.activeSeedHash,
      failedSlotHash: current.activeSeedHash,
      updatedAt: new Date().toISOString(),
    }
    atomicWriteJson(activeProfilePath(userDataDir), rolled)
    return { action: 'rolled_back', state: rolled }
  }

  const safe: ActiveProfileState = {
    ...current,
    state: 'safe_mode',
    failedSlotHash: current.activeSeedHash,
    updatedAt: new Date().toISOString(),
  }
  atomicWriteJson(activeProfilePath(userDataDir), safe)
  return { action: 'safe_mode', state: safe }
}

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { redactSecrets } from './redact.js'

const FORBIDDEN_FILENAMES = new Set([
  '.credentials.yaml',
  '.env',
  '.env.local',
  '.env.production',
])

function isSafeRegularFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    const stat = lstatSync(filePath)
    return !stat.isSymbolicLink() && stat.isFile()
  } catch {
    return false
  }
}

export interface DiagnosticExportOptions {
  readonly productDir: string
  readonly userDataDir: string
  readonly outputZipPath: string
}

export interface DiagnosticExportResult {
  readonly outputZipPath: string
  readonly includedEntries: readonly string[]
  readonly skippedSymlinks: readonly string[]
  readonly bytes: number
}

/**
 * One-click redacted diagnostic bundle exporter:
 * - Strict file whitelist ONLY (identity.json, product.json, locks, seed-manifest.json,
 *   active-profile.json, state-version.json, redacted logs/*.log)
 * - `lstatSync` rejects symlinks & non-regular files to prevent out-of-tree exfiltration
 * - Physically excludes `.credentials.yaml`, `.env*`, sessions/, browser storage, crashDumps, workspace originals
 */
export function exportRedactedDiagnosticBundle(options: DiagnosticExportOptions): DiagnosticExportResult {
  const entries: Record<string, Uint8Array> = {}
  const includedEntries: string[] = []
  const skippedSymlinks: string[] = []

  const tryAddFile = (diskPath: string, zipName: string, redact: boolean): void => {
    const base = path.basename(diskPath).toLowerCase()
    if (FORBIDDEN_FILENAMES.has(base) || base.startsWith('.env')) return
    if (!existsSync(diskPath)) return
    const stat = lstatSync(diskPath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      skippedSymlinks.push(diskPath)
      return
    }
    const raw = readFileSync(diskPath, 'utf8')
    const content = redact ? redactSecrets(raw) : raw
    entries[zipName] = strToU8(content)
    includedEntries.push(zipName)
  }

  // Product metadata whitelist
  tryAddFile(path.join(options.productDir, 'identity.json'), 'product/identity.json', false)
  tryAddFile(path.join(options.productDir, 'product.json'), 'product/product.json', false)
  tryAddFile(path.join(options.productDir, 'seed-manifest.json'), 'product/seed-manifest.json', false)
  if (existsSync(options.productDir)) {
    for (const file of readdirSync(options.productDir).sort()) {
      if (/^plugins(?:\.[a-z0-9-]+)?\.lock\.json$/i.test(file)) {
        tryAddFile(path.join(options.productDir, file), `product/${file}`, false)
      }
    }
  }

  // Runtime state whitelist (strictly NO sessions, NO credentials, NO crashDumps)
  tryAddFile(path.join(options.userDataDir, 'active-profile.json'), 'state/active-profile.json', false)
  tryAddFile(path.join(options.userDataDir, 'state-version.json'), 'state/state-version.json', false)

  const logsDir = path.join(options.userDataDir, 'logs')
  if (existsSync(logsDir) && !lstatSync(logsDir).isSymbolicLink()) {
    for (const file of readdirSync(logsDir).sort()) {
      if (/\.log(?:\.\d+)?$/i.test(file)) {
        const full = path.join(logsDir, file)
        if (!isSafeRegularFile(full)) {
          skippedSymlinks.push(full)
          continue
        }
        tryAddFile(full, `logs/${file}`, true)
      }
    }
  }

  const zipBytes = zipSync(entries, { level: 6 })
  mkdirSync(path.dirname(options.outputZipPath), { recursive: true })
  writeFileSync(options.outputZipPath, zipBytes)
  return {
    outputZipPath: options.outputZipPath,
    includedEntries,
    skippedSymlinks,
    bytes: zipBytes.byteLength,
  }
}

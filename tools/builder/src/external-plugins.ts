import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import semver from 'semver'
import { parseDocument } from 'yaml'
import { inspectPatchYamlSafety } from '@dsh-self/catalog'
import {
  isWindowsReservedName,
  type LockedPluginEntry,
  type PlatformLock,
} from '@dsh-self/product-spec'

export const MAX_SEED_REL_PATH_BUDGET = 130
export const MAX_TARBALL_EXTRACT_BYTES = 180 * 1024 * 1024
export const MAX_TARBALL_ENTRIES = 15_000
export const MAX_TARBALL_DEPTH = 20

export interface TransitivePackageRecord {
  readonly packageName: string
  readonly version: string
  readonly integritySha512: string
  readonly installRelDir: string
  readonly fileCount: number
}

export interface StagedExternalPayloadManifest {
  readonly schemaVersion: 1
  readonly packageName: string
  readonly version: string
  readonly sourceKind: 'npm' | 'git' | 'local-installed'
  readonly sourceRef: string
  readonly integritySha512: string
  readonly resolvedFrom: 'npm-registry' | 'local-dir' | 'local-dsh-profile'
  readonly transitiveDeps: readonly TransitivePackageRecord[]
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxRelPath: number
  readonly stagedAt: string
}

export interface MaterializedExternalPlugin {
  readonly entry: LockedPluginEntry
  readonly stageDir: string
  readonly manifest: StagedExternalPayloadManifest
}

export interface ExternalPluginMaterializeOptions {
  readonly pluginCacheDir?: string
  /**
   * Optional local package directories keyed by package name (e.g. for offline tests or local dev).
   * When provided for a package, its files are staged directly without hitting npm.
   */
  readonly localPackageDirs?: Readonly<Record<string, string>>
  /** Optional custom npm registry base URL (defaults to https://registry.npmjs.org). */
  readonly registryUrl?: string
  /** Optional custom fetch implementation (for tests). */
  readonly fetchFn?: typeof fetch
}

export function defaultPluginCacheDir(): string {
  return process.env.DSH_SELF_PLUGIN_CACHE || path.join(os.homedir(), '.dsh-self-studio', 'plugin-cache')
}

export function computeIntegritySha512(buffer: Buffer): string {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}

export function isHostRuntimeSharedPackage(packageName: string): boolean {
  return (
    packageName === '@deepseek-ai/dsh' ||
    packageName.startsWith('@deepseek-ai/dsh-') ||
    packageName === '@deepseek-ai/cordis' ||
    packageName.startsWith('@deepseek-ai/cordis-')
  )
}

function safeCacheKey(packageName: string, version: string, integritySha512: string): string {
  const pkgSlug = packageName.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]+/g, '_')
  const verSlug = version.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const hashSlug = createHash('sha256').update(integritySha512).digest('hex').slice(0, 12)
  return `${pkgSlug}@${verSlug}-${hashSlug}`
}

export function stagedPayloadDirFor(
  plugin: Pick<LockedPluginEntry, 'packageName' | 'version' | 'integritySha512'>,
  pluginCacheDir = defaultPluginCacheDir(),
): string {
  return path.join(
    path.resolve(pluginCacheDir),
    'staged',
    safeCacheKey(plugin.packageName, plugin.version, plugin.integritySha512),
  )
}

function validateSafeRelPath(rawPath: string): string {
  if (!rawPath) throw new Error('Empty archive path')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(rawPath)) {
    throw new Error(`Control character rejected in path: ${JSON.stringify(rawPath)}`)
  }
  if (rawPath.includes('\\') || rawPath.startsWith('/') || /^[a-zA-Z]:/.test(rawPath)) {
    throw new Error(`Unsafe archive path rejected: ${rawPath}`)
  }
  const segments = rawPath.replace(/\/+$/, '').split('/').filter((s) => s !== '.' && s.length > 0)
  if (segments.length === 0) throw new Error(`Empty normalized archive path: ${rawPath}`)
  if (segments.length > MAX_TARBALL_DEPTH) {
    throw new Error(`Archive path depth exceeds ${MAX_TARBALL_DEPTH}: ${rawPath}`)
  }
  for (const seg of segments) {
    if (seg === '..' || seg === '.') throw new Error(`Path traversal rejected: ${rawPath}`)
    if (seg.includes(':')) throw new Error(`NTFS ADS colon rejected: ${rawPath}`)
    if (/[. ]$/.test(seg)) throw new Error(`Trailing dot/space rejected: ${rawPath}`)
    if (/[*?"<>|]/.test(seg)) throw new Error(`Illegal Windows filename char rejected: ${rawPath}`)
    if (isWindowsReservedName(seg)) throw new Error(`Windows reserved name rejected: ${rawPath}`)
  }
  return segments.join('/')
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {}
  const text = data.toString('utf8')
  let pos = 0
  while (pos < text.length) {
    const space = text.indexOf(' ', pos)
    if (space === -1) break
    const len = Number.parseInt(text.slice(pos, space), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const record = text.slice(space + 1, pos + len).replace(/\n$/, '')
    const eq = record.indexOf('=')
    if (eq > 0) result[record.slice(0, eq)] = record.slice(eq + 1)
    pos += len
  }
  return result
}

function parseOctalOrBase256(buf: Buffer): number {
  if ((buf[0]! & 0x80) !== 0) {
    let val = 0
    for (let i = 1; i < buf.length; i += 1) val = val * 256 + buf[i]!
    return val
  }
  const str = buf.toString('ascii').replace(/\0.*$/, '').trim()
  return str.length === 0 ? 0 : Number.parseInt(str, 8)
}

function readCString(buf: Buffer): string {
  const idx = buf.indexOf(0)
  return buf.subarray(0, idx === -1 ? buf.length : idx).toString('utf8')
}

/**
 * Safely extract a verified npm `.tgz` tarball into `destDir` (stripping the leading
 * `package/` segment), forbidding symlinks, hardlinks, traversal, reserved names,
 * case collisions, and gzip/tar bombs.
 */
export function extractVerifiedNpmTarball(tgzBuffer: Buffer, destDir: string): {
  readonly fileCount: number
  readonly totalBytes: number
} {
  const tarBuf = gunzipSync(tgzBuffer, { maxOutputLength: MAX_TARBALL_EXTRACT_BYTES + 32 * 1024 * 1024 })
  mkdirSync(destDir, { recursive: true })
  const resolvedDest = path.resolve(destDir)
  const seenLower = new Set<string>()
  let offset = 0
  let entries = 0
  let fileCount = 0
  let totalBytes = 0
  let nextPax: Record<string, string> | null = null
  let nextGnuLongName: string | null = null

  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512)
    offset += 512
    if (header.every((b) => b === 0)) break

    const rawName = readCString(header.subarray(0, 100))
    const rawPrefix = readCString(header.subarray(345, 500))
    const sizeField = parseOctalOrBase256(header.subarray(124, 136))
    const typeChar = header[156] === 0 ? '0' : String.fromCharCode(header[156]!)
    const dataSize = nextPax?.size !== undefined ? Number.parseInt(nextPax.size, 10) : sizeField
    if (!Number.isFinite(dataSize) || dataSize < 0) {
      throw new Error('Malformed npm tarball entry size')
    }
    const padded = Math.ceil(dataSize / 512) * 512
    if (offset + dataSize > tarBuf.length) {
      throw new Error('Truncated npm tarball payload')
    }
    const payload = tarBuf.subarray(offset, offset + dataSize)
    offset += padded

    if (typeChar === 'x') {
      nextPax = parsePaxRecords(payload)
      continue
    }
    if (typeChar === 'g') continue
    if (typeChar === 'L') {
      nextGnuLongName = readCString(payload)
      continue
    }

    const effectiveRaw = nextPax?.path ?? nextGnuLongName ?? (rawPrefix ? `${rawPrefix}/${rawName}` : rawName)
    nextPax = null
    nextGnuLongName = null

    if (typeChar !== '0' && typeChar !== '5') {
      throw new Error(`Rejected non-regular npm tarball entry type '${typeChar}' for "${effectiveRaw}"`)
    }

    entries += 1
    if (entries > MAX_TARBALL_ENTRIES) {
      throw new Error(`npm tarball entry count exceeded ${MAX_TARBALL_ENTRIES}`)
    }

    const stripped = effectiveRaw.replace(/^\.\//, '').replace(/^package(?:\/|$)/, '')
    if (!stripped) continue
    const safeRel = validateSafeRelPath(stripped)
    const lowerKey = safeRel.toLowerCase()
    if (seenLower.has(lowerKey)) {
      throw new Error(`Case-insensitive path collision inside npm tarball: ${safeRel}`)
    }
    seenLower.add(lowerKey)

    const targetPath = path.resolve(resolvedDest, safeRel)
    if (targetPath !== resolvedDest && !targetPath.startsWith(`${resolvedDest}${path.sep}`)) {
      throw new Error(`Archive entry escapes destination: ${safeRel}`)
    }

    if (typeChar === '5') {
      mkdirSync(targetPath, { recursive: true })
    } else {
      totalBytes += dataSize
      if (totalBytes > MAX_TARBALL_EXTRACT_BYTES) {
        throw new Error(`npm tarball extracted size exceeded ${MAX_TARBALL_EXTRACT_BYTES} bytes`)
      }
      mkdirSync(path.dirname(targetPath), { recursive: true })
      writeFileSync(targetPath, payload)
      fileCount += 1
    }
  }
  return { fileCount, totalBytes }
}

function copyCleanLocalPackageDir(srcDir: string, destDir: string): { readonly fileCount: number; readonly totalBytes: number } {
  let fileCount = 0
  let totalBytes = 0
  mkdirSync(destDir, { recursive: true })

  const walk = (curSrc: string, curRel: string): void => {
    const names = readdirSync(curSrc).sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      if (curRel === '' && (name === '.git' || name === 'node_modules' || name === '.dev')) continue
      const fullSrc = path.join(curSrc, name)
      const st = lstatSync(fullSrc)
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to stage symlink from local package: ${fullSrc}`)
      }
      const rel = curRel ? `${curRel}/${name}` : name
      const safeRel = validateSafeRelPath(rel)
      const fullDst = path.join(destDir, ...safeRel.split('/'))
      if (st.isDirectory()) {
        mkdirSync(fullDst, { recursive: true })
        walk(fullSrc, safeRel)
      } else if (st.isFile()) {
        const data = readFileSync(fullSrc)
        mkdirSync(path.dirname(fullDst), { recursive: true })
        writeFileSync(fullDst, data)
        fileCount += 1
        totalBytes += data.length
      }
    }
  }

  walk(path.resolve(srcDir), '')
  return { fileCount, totalBytes }
}

/** Scrub any `@deepseek-ai/dsh*` or `@deepseek-ai/cordis*` shadow packages under `nodeModulesDir`. */
export function scrubShadowHostPackages(nodeModulesDir: string): readonly string[] {
  const removed: string[] = []
  if (!existsSync(nodeModulesDir)) return removed

  const scanNodeModules = (nmDir: string): void => {
    if (!existsSync(nmDir)) return
    for (const entry of readdirSync(nmDir, { withFileTypes: true })) {
      const full = path.join(nmDir, entry.name)
      if (entry.name.startsWith('@') && entry.isDirectory()) {
        for (const sub of readdirSync(full, { withFileTypes: true })) {
          const pkgName = `${entry.name}/${sub.name}`
          const subPath = path.join(full, sub.name)
          if (isHostRuntimeSharedPackage(pkgName)) {
            rmSync(subPath, { recursive: true, force: true })
            removed.push(pkgName)
          } else if (sub.isDirectory()) {
            scanNodeModules(path.join(subPath, 'node_modules'))
          }
        }
        if (existsSync(full) && readdirSync(full).length === 0) {
          rmSync(full, { recursive: true, force: true })
        }
      } else if (entry.isDirectory()) {
        scanNodeModules(path.join(full, 'node_modules'))
      }
    }
  }

  scanNodeModules(nodeModulesDir)
  return removed
}

function auditStagedNodeModules(nodeModulesDir: string): {
  readonly fileCount: number
  readonly totalBytes: number
  readonly maxRelPath: number
} {
  let fileCount = 0
  let totalBytes = 0
  let maxRelPath = 0
  const seenLower = new Set<string>()

  const walk = (dir: string, relBase: string): void => {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      const full = path.join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink forbidden in staged external plugin payload: ${relBase}/${name}`)
      }
      const rel = `${relBase}/${name}`
      const safeRel = validateSafeRelPath(rel)
      const lower = safeRel.toLowerCase()
      if (seenLower.has(lower)) {
        throw new Error(`Case-insensitive path collision in staged external plugin payload: ${safeRel}`)
      }
      seenLower.add(lower)
      if (safeRel.length > maxRelPath) maxRelPath = safeRel.length
      if (safeRel.length > MAX_SEED_REL_PATH_BUDGET) {
        throw new Error(
          `Staged plugin path "${safeRel}" length (${safeRel.length}) exceeds MAX_PATH budget (${MAX_SEED_REL_PATH_BUDGET})`,
        )
      }
      if (st.isDirectory()) {
        walk(full, safeRel)
      } else if (st.isFile()) {
        fileCount += 1
        totalBytes += st.size
      }
    }
  }

  if (existsSync(nodeModulesDir)) walk(nodeModulesDir, 'node_modules')
  return { fileCount, totalBytes, maxRelPath }
}

interface NpmRegistryVersionDoc {
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, string>>
  readonly dist?: {
    readonly tarball?: string
    readonly integrity?: string
  }
}

interface NpmRegistryPackument {
  readonly versions?: Readonly<Record<string, NpmRegistryVersionDoc>>
}

function assertSafeInstallScripts(pkgName: string, version: string, scripts: Readonly<Record<string, string>> | undefined): void {
  if (!scripts) return
  for (const hook of ['preinstall', 'install', 'postinstall'] as const) {
    if (scripts[hook]) {
      throw new Error(
        `Refusing external dependency ${pkgName}@${version} with lifecycle script "${hook}" under --ignore-scripts policy`,
      )
    }
  }
}

async function fetchVerifiedTarball(options: {
  readonly url: string
  readonly expectedIntegritySha512: string
  readonly tarballCacheDir: string
  readonly cacheFileName: string
  readonly fetchFn: typeof fetch
}): Promise<Buffer> {
  mkdirSync(options.tarballCacheDir, { recursive: true })
  const cachedPath = path.join(options.tarballCacheDir, options.cacheFileName)
  if (existsSync(cachedPath)) {
    const cached = readFileSync(cachedPath)
    if (computeIntegritySha512(cached) === options.expectedIntegritySha512) {
      return cached
    }
    rmSync(cachedPath, { force: true })
  }

  const res = await options.fetchFn(options.url, {
    headers: { Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch tarball ${options.url}: HTTP ${res.status}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const actualIntegrity = computeIntegritySha512(buf)
  if (actualIntegrity !== options.expectedIntegritySha512) {
    throw new Error(
      `SHA-512 integrity mismatch for ${options.url}: expected ${options.expectedIntegritySha512}, got ${actualIntegrity}`,
    )
  }
  const tmpPath = `${cachedPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmpPath, buf)
  renameSync(tmpPath, cachedPath)
  return buf
}

async function resolveNpmPackument(
  packageName: string,
  registryUrl: string,
  fetchFn: typeof fetch,
  memo: Map<string, NpmRegistryPackument>,
): Promise<NpmRegistryPackument> {
  const existing = memo.get(packageName)
  if (existing) return existing
  const encoded = packageName.startsWith('@')
    ? `@${encodeURIComponent(packageName.slice(1))}`
    : encodeURIComponent(packageName)
  const url = `${registryUrl.replace(/\/+$/, '')}/${encoded}`
  const res = await fetchFn(url, {
    headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
    signal: AbortSignal.timeout(45_000),
  })
  if (!res.ok) {
    throw new Error(`Failed to fetch npm metadata for ${packageName} (${url}): HTTP ${res.status}`)
  }
  const doc = (await res.json()) as NpmRegistryPackument
  memo.set(packageName, doc)
  return doc
}

async function resolveRootTarballUrl(
  plugin: LockedPluginEntry,
  registryUrl: string,
  fetchFn: typeof fetch,
  packumentMemo: Map<string, NpmRegistryPackument>,
): Promise<string> {
  if (plugin.sourceRef.endsWith('.tgz') && /^https:\/\//i.test(plugin.sourceRef)) {
    return plugin.sourceRef
  }
  if (plugin.sourceKind === 'npm') {
    const doc = await resolveNpmPackument(plugin.packageName, registryUrl, fetchFn, packumentMemo)
    const verDoc = doc.versions?.[plugin.version]
    if (!verDoc?.dist?.tarball) {
      throw new Error(`npm registry missing tarball for ${plugin.packageName}@${plugin.version}`)
    }
    if (verDoc.dist.integrity && verDoc.dist.integrity !== plugin.integritySha512) {
      throw new Error(
        `Lockfile integritySha512 for ${plugin.packageName}@${plugin.version} does not match npm registry (${verDoc.dist.integrity})`,
      )
    }
    return verDoc.dist.tarball
  }
  throw new Error(
    `Unsupported external plugin sourceRef for ${plugin.packageName}@${plugin.version}: ${plugin.sourceRef}`,
  )
}

/**
 * Compute a deterministic SHA-512 content digest over an entire staged `node_modules` tree.
 * Locale-independent ordering; rejects any symlink inside the staged tree.
 */
export function computeDirectoryTreeIntegritySha512(nodeModulesDir: string): string {
  const hash = createHash('sha512')
  const walk = (dir: string, relBase: string): void => {
    const names = readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
      const full = path.join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        throw new Error(`Symlink forbidden when hashing staged payload: ${relBase}/${name}`)
      }
      const rel = `${relBase}/${name}`
      if (st.isDirectory()) {
        walk(full, rel)
      } else if (st.isFile()) {
        const content = readFileSync(full)
        hash.update(`${rel}\0${content.length}\0`)
        hash.update(content)
      }
    }
  }
  if (existsSync(nodeModulesDir)) walk(nodeModulesDir, 'node_modules')
  return `sha512-${hash.digest('base64')}`
}

function copyDereferencedLocalPackageDir(
  srcDir: string,
  destDir: string,
  budget: { fileCount: number; totalBytes: number },
): { readonly fileCount: number; readonly totalBytes: number } {
  const rootReal = realpathSync(srcDir)
  const activeRealDirs = new Set<string>([rootReal])
  const seenLower = new Set<string>()
  let localFiles = 0
  let localBytes = 0
  mkdirSync(destDir, { recursive: true })

  const walk = (curSrc: string, curRel: string): void => {
    const names = readdirSync(curSrc).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    for (const name of names) {
      if (curRel === '' && (name === '.git' || name === 'node_modules' || name === '.dev')) continue
      if (name === '.DS_Store' || name === 'Thumbs.db') continue
      const fullSrc = path.join(curSrc, name)
      let st
      try {
        st = statSync(fullSrc)
      } catch {
        throw new Error(`Broken symlink or unreadable file inside local installed plugin: ${fullSrc}`)
      }
      const rel = curRel ? `${curRel}/${name}` : name
      const safeRel = validateSafeRelPath(rel)
      const lower = safeRel.toLowerCase()
      if (seenLower.has(lower)) {
        throw new Error(`Case-insensitive path collision inside local installed plugin: ${safeRel}`)
      }
      seenLower.add(lower)
      const fullDst = path.join(destDir, ...safeRel.split('/'))
      if (st.isDirectory()) {
        const childReal = realpathSync(fullSrc)
        if (activeRealDirs.has(childReal)) {
          throw new Error(`Symlink directory cycle rejected in local installed plugin: ${fullSrc}`)
        }
        activeRealDirs.add(childReal)
        mkdirSync(fullDst, { recursive: true })
        try {
          walk(fullSrc, safeRel)
        } finally {
          activeRealDirs.delete(childReal)
        }
      } else if (st.isFile()) {
        budget.fileCount += 1
        if (budget.fileCount > MAX_TARBALL_ENTRIES) {
          throw new Error(`Local installed plugin file count exceeded ${MAX_TARBALL_ENTRIES}`)
        }
        const data = readFileSync(fullSrc)
        budget.totalBytes += data.length
        if (budget.totalBytes > MAX_TARBALL_EXTRACT_BYTES) {
          throw new Error(`Local installed plugin extracted size exceeded ${MAX_TARBALL_EXTRACT_BYTES} bytes`)
        }
        mkdirSync(path.dirname(fullDst), { recursive: true })
        writeFileSync(fullDst, data)
        localFiles += 1
        localBytes += data.length
      }
    }
  }

  walk(rootReal, '')
  return { fileCount: localFiles, totalBytes: localBytes }
}

function findInstalledDependencyDir(
  depName: string,
  fromRealDir: string,
  extraSearchNmDirs: readonly string[],
): string | null {
  const segs = depName.split('/')
  let cur = path.resolve(fromRealDir)
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = path.join(cur, 'node_modules', ...segs)
    if (existsSync(path.join(candidate, 'package.json'))) {
      return realpathSync(candidate)
    }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const nmDir of extraSearchNmDirs) {
    const candidate = path.join(path.resolve(nmDir), ...segs)
    if (existsSync(path.join(candidate, 'package.json'))) {
      return realpathSync(candidate)
    }
  }
  return null
}

/**
 * Inspect `cordis.patch.yml` file(s) declared in `package.json#dsh.bundle.patch` for safety
 * (plain YAML Core Schema, zero `!!js` tags, zero path traversal) and extract entry/panel IDs.
 */
export function inspectLocalPluginPatchFiles(
  pkgDir: string,
  patchDecl: unknown,
): {
  readonly valid: boolean
  readonly usesJsTag: boolean
  readonly errors: readonly string[]
  readonly patchYamlConcat: string
  readonly entryIds: readonly string[]
} {
  const patchPaths = typeof patchDecl === 'string'
    ? (patchDecl.trim() ? [patchDecl.trim()] : [])
    : Array.isArray(patchDecl)
      ? patchDecl.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map((p) => p.trim())
      : []
  if (patchPaths.length === 0) {
    return {
      valid: false,
      usesJsTag: false,
      errors: ['Missing dsh.bundle.patch declaration'],
      patchYamlConcat: '',
      entryIds: [],
    }
  }
  const resolvedRoot = realpathSync(pkgDir)
  const errors: string[] = []
  let usesJsTag = false
  const chunks: string[] = []
  const entryIds = new Set<string>()

  const collectIds = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collectIds(item)
      return
    }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>
      if (typeof rec.id === 'string' && rec.id.trim()) entryIds.add(rec.id.trim())
      if (rec.insert) collectIds(rec.insert)
      if (rec.children) collectIds(rec.children)
    }
  }

  for (const relPatch of patchPaths) {
    const resolvedPatch = path.resolve(resolvedRoot, relPatch)
    const relCheck = path.relative(resolvedRoot, resolvedPatch)
    if (path.isAbsolute(relCheck) || relCheck.startsWith('..')) {
      errors.push(`Patch path escapes package directory: ${relPatch}`)
      continue
    }
    if (!existsSync(resolvedPatch)) {
      errors.push(`Missing patch file: ${relPatch}`)
      continue
    }
    const text = readFileSync(resolvedPatch, 'utf8')
    chunks.push(text)
    const check = inspectPatchYamlSafety(text)
    if (check.usesJsTag) usesJsTag = true
    if (!check.validPlainYaml) {
      errors.push(...(check.usesJsTag ? ['cordis.patch.yml contains forbidden !!js tag'] : check.errors))
    } else {
      try {
        const doc = parseDocument(text, { schema: 'core', customTags: [] })
        collectIds(doc.toJS({ maxAliasCount: 0 }))
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
    }
  }

  return {
    valid: errors.length === 0 && !usesJsTag,
    usesJsTag,
    errors,
    patchYamlConcat: chunks.join('\n'),
    entryIds: [...entryIds],
  }
}

export interface StageLocalInstalledPluginOptions {
  readonly packageName: string
  readonly packageDir: string
  readonly profileName: string
  readonly searchNodeModulesDirs?: readonly string[]
  readonly pluginCacheDir?: string
}

export interface StagedLocalInstalledPluginResult {
  readonly packageName: string
  readonly version: string
  readonly runtimeKind: 'client-only' | 'host-and-client' | 'host-only'
  readonly stageDir: string
  readonly manifest: StagedExternalPayloadManifest
  readonly entryIds: readonly string[]
}

/**
 * Stage a locally installed DSH plugin (and its production dependency closure from the live DSH
 * profile's `node_modules`) into `pluginCacheDir` with symlink dereferencing, shadow-package
 * scrubbing, plain-YAML `!!js` verification, 130-char Windows MAX_PATH enforcement, and a
 * deterministic content SHA-512 integrity hash.
 */
export function stageLocalInstalledPluginPayload(
  options: StageLocalInstalledPluginOptions,
): StagedLocalInstalledPluginResult {
  const realRootDir = realpathSync(options.packageDir)
  const pkgJsonPath = path.join(realRootDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`本机插件缺少 package.json：${options.packageName}`)
  }
  const rootPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    name?: string
    version?: string
    main?: string
    exports?: unknown
    scripts?: Record<string, string>
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
    dsh?: { bundle?: { patch?: unknown }; client?: unknown }
  }
  const pkgName = typeof rootPkg.name === 'string' && rootPkg.name ? rootPkg.name : options.packageName
  if (pkgName !== options.packageName) {
    throw new Error(`本机插件包名不一致：期望 ${options.packageName}，实际为 ${pkgName}`)
  }
  const version = typeof rootPkg.version === 'string' && rootPkg.version ? rootPkg.version : '0.0.0'
  assertSafeInstallScripts(pkgName, version, rootPkg.scripts)

  const patchCheck = inspectLocalPluginPatchFiles(realRootDir, rootPkg.dsh?.bundle?.patch)
  if (!patchCheck.valid) {
    throw new Error(`插件 ${pkgName}@${version} 未通过补丁安全校验：${patchCheck.errors.join('；')}`)
  }

  const hasClient = Boolean(rootPkg.dsh?.client)
  const hasHost = Boolean(
    rootPkg.main ||
    (rootPkg.exports &&
      (typeof rootPkg.exports === 'string' ||
        (typeof rootPkg.exports === 'object' && rootPkg.exports !== null && '.' in (rootPkg.exports as Record<string, unknown>)))),
  )
  const runtimeKind: 'client-only' | 'host-and-client' | 'host-only' =
    hasClient && hasHost ? 'host-and-client' : hasClient ? 'client-only' : 'host-only'

  const pluginCacheDir = path.resolve(options.pluginCacheDir ?? defaultPluginCacheDir())
  const stagedRootParent = path.join(pluginCacheDir, 'staged')
  mkdirSync(stagedRootParent, { recursive: true })
  const tmpStageDir = path.join(stagedRootParent, `local-tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  const nmDir = path.join(tmpStageDir, 'node_modules')
  mkdirSync(nmDir, { recursive: true })

  try {
    const budget = { fileCount: 0, totalBytes: 0 }
    const rootStageDir = path.join(nmDir, ...pkgName.split('/'))
    copyDereferencedLocalPackageDir(realRootDir, rootStageDir, budget)

    const hoistedVersions = new Map<string, string>([[pkgName, version]])
    const transitiveDeps: TransitivePackageRecord[] = []
    const visited = new Set<string>()
    const extraSearchNm = options.searchNodeModulesDirs ?? []
    const queue: { readonly srcRealDir: string; readonly parentRelDir: string }[] = [
      { srcRealDir: realRootDir, parentRelDir: `node_modules/${pkgName}` },
    ]

    while (queue.length > 0) {
      const current = queue.shift()!
      const curPkgPath = path.join(current.srcRealDir, 'package.json')
      if (!existsSync(curPkgPath)) continue
      const curPkg = JSON.parse(readFileSync(curPkgPath, 'utf8')) as {
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
      const requiredDepEntries = Object.entries(curPkg.dependencies ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([depName, depRange]) => ({ depName, depRange, optional: false }))
      const optionalDepEntries = Object.entries(curPkg.optionalDependencies ?? {})
        .filter(([depName]) => !(depName in (curPkg.dependencies ?? {})))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([depName, depRange]) => ({ depName, depRange, optional: true }))

      for (const { depName, depRange, optional } of [...requiredDepEntries, ...optionalDepEntries]) {
        if (isHostRuntimeSharedPackage(depName)) continue
        const visitKey = `${current.parentRelDir}->${depName}@${depRange}`
        if (visited.has(visitKey)) continue
        visited.add(visitKey)

        const depRealDir = findInstalledDependencyDir(depName, current.srcRealDir, extraSearchNm)
        if (!depRealDir) {
          if (optional) continue
          throw new Error(
            `本机插件 ${pkgName}@${version} 缺少运行时依赖 ${depName}（要求 ${depRange}），请先在当前 DSH 中确认该插件完整安装`,
          )
        }
        const depPkg = JSON.parse(readFileSync(path.join(depRealDir, 'package.json'), 'utf8')) as {
          version?: string
        }
        const resolvedVer = typeof depPkg.version === 'string' && depPkg.version ? depPkg.version : '0.0.0'
        const existingHoisted = hoistedVersions.get(depName)
        if (
          existingHoisted &&
          (existingHoisted === resolvedVer || semver.satisfies(existingHoisted, depRange, { includePrerelease: true }))
        ) {
          continue
        }

        const installRelDir = existingHoisted
          ? `${current.parentRelDir}/node_modules/${depName}`
          : `node_modules/${depName}`
        const depDestDir = path.join(tmpStageDir, ...installRelDir.split('/'))
        const copied = copyDereferencedLocalPackageDir(depRealDir, depDestDir, budget)
        if (!existingHoisted) hoistedVersions.set(depName, resolvedVer)
        transitiveDeps.push({
          packageName: depName,
          version: resolvedVer,
          integritySha512: computeDirectoryTreeIntegritySha512(depDestDir),
          installRelDir,
          fileCount: copied.fileCount,
        })
        queue.push({ srcRealDir: depRealDir, parentRelDir: installRelDir })
      }
    }

    scrubShadowHostPackages(nmDir)
    const audit = auditStagedNodeModules(nmDir)
    const integritySha512 = computeDirectoryTreeIntegritySha512(nmDir)
    const cleanProfile = options.profileName.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'active'
    const sourceRef = `local-dsh:${cleanProfile}/${pkgName}@${version}`

    const manifest: StagedExternalPayloadManifest = {
      schemaVersion: 1,
      packageName: pkgName,
      version,
      sourceKind: 'local-installed',
      sourceRef,
      integritySha512,
      resolvedFrom: 'local-dsh-profile',
      transitiveDeps,
      fileCount: audit.fileCount,
      totalBytes: audit.totalBytes,
      maxRelPath: audit.maxRelPath,
      stagedAt: new Date().toISOString(),
    }
    writeFileSync(path.join(tmpStageDir, 'payload-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

    const finalStageDir = stagedPayloadDirFor({ packageName: pkgName, version, integritySha512 }, pluginCacheDir)
    if (
      existsSync(path.join(finalStageDir, 'payload-manifest.json')) &&
      computeDirectoryTreeIntegritySha512(path.join(finalStageDir, 'node_modules')) === integritySha512
    ) {
      rmSync(tmpStageDir, { recursive: true, force: true })
    } else {
      rmSync(finalStageDir, { recursive: true, force: true })
      renameSync(tmpStageDir, finalStageDir)
    }

    return {
      packageName: pkgName,
      version,
      runtimeKind,
      stageDir: finalStageDir,
      manifest,
      entryIds: patchCheck.entryIds,
    }
  } catch (error) {
    rmSync(tmpStageDir, { recursive: true, force: true })
    throw error
  }
}

function readExistingVerifiedManifest(
  stageDir: string,
  plugin: LockedPluginEntry,
): StagedExternalPayloadManifest | null {
  const manifestPath = path.join(stageDir, 'payload-manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as StagedExternalPayloadManifest
    if (
      parsed.schemaVersion !== 1 ||
      parsed.packageName !== plugin.packageName ||
      parsed.version !== plugin.version ||
      parsed.integritySha512 !== plugin.integritySha512
    ) {
      return null
    }
    const nmDir = path.join(stageDir, 'node_modules')
    const pkgDir = path.join(nmDir, ...plugin.packageName.split('/'))
    if (!existsSync(path.join(pkgDir, 'package.json'))) return null
    for (const dep of parsed.transitiveDeps) {
      const depPkgJson = path.join(stageDir, ...dep.installRelDir.split('/'), 'package.json')
      if (!existsSync(depPkgJson)) return null
    }
    if (plugin.sourceKind === 'local-installed') {
      if (parsed.sourceKind !== 'local-installed') return null
      if (computeDirectoryTreeIntegritySha512(nmDir) !== plugin.integritySha512) return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Materialize and SHA-512-verify every non-builtin plugin in `lock.plugins` (along with its
 * production transitive dependency closure, strictly under `--ignore-scripts` and zero symlinks)
 * into `pluginCacheDir`. Safe to run repeatedly; verified cache hits are 100% offline.
 */
export async function ensureExternalPluginPayloads(
  lock: PlatformLock,
  options: ExternalPluginMaterializeOptions = {},
): Promise<readonly MaterializedExternalPlugin[]> {
  const externalPlugins = lock.plugins.filter((p) => p.sourceKind !== 'builtin')
  if (externalPlugins.length === 0) return []

  const pluginCacheDir = path.resolve(options.pluginCacheDir ?? defaultPluginCacheDir())
  const tarballCacheDir = path.join(pluginCacheDir, 'tarballs')
  const registryUrl = options.registryUrl ?? 'https://registry.npmjs.org'
  const fetchFn = options.fetchFn ?? fetch
  const packumentMemo = new Map<string, NpmRegistryPackument>()
  const results: MaterializedExternalPlugin[] = []

  for (const plugin of externalPlugins) {
    const stageDir = stagedPayloadDirFor(plugin, pluginCacheDir)
    if (plugin.sourceKind === 'local-installed') {
      const verifiedLocal = readExistingVerifiedManifest(stageDir, plugin)
      if (verifiedLocal === null) {
        throw new Error(
          `Missing or tampered staged payload for locally installed plugin ${plugin.packageName}@${plugin.version}. ` +
          `Re-select it in Studio Step 3 to re-stage (cache: ${pluginCacheDir}).`,
        )
      }
      results.push({ entry: plugin, stageDir, manifest: verifiedLocal })
      continue
    }
    const cached = !options.localPackageDirs?.[plugin.packageName]
      ? readExistingVerifiedManifest(stageDir, plugin)
      : null
    if (cached !== null) {
      results.push({ entry: plugin, stageDir, manifest: cached })
      continue
    }

    mkdirSync(path.dirname(stageDir), { recursive: true })
    const tmpStageDir = `${stageDir}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    const nmDir = path.join(tmpStageDir, 'node_modules')
    mkdirSync(nmDir, { recursive: true })

    try {
      const rootPkgDir = path.join(nmDir, ...plugin.packageName.split('/'))
      let resolvedFrom: 'npm-registry' | 'local-dir' = 'npm-registry'

      const localRootDir = options.localPackageDirs?.[plugin.packageName]
      if (localRootDir) {
        if (!existsSync(path.join(localRootDir, 'package.json'))) {
          throw new Error(`Local plugin directory missing package.json: ${localRootDir}`)
        }
        const localPkg = JSON.parse(readFileSync(path.join(localRootDir, 'package.json'), 'utf8')) as {
          name?: string
          version?: string
          scripts?: Record<string, string>
        }
        if (localPkg.name !== plugin.packageName || localPkg.version !== plugin.version) {
          throw new Error(
            `Local plugin manifest mismatch: expected ${plugin.packageName}@${plugin.version}, got ${String(localPkg.name)}@${String(localPkg.version)}`,
          )
        }
        assertSafeInstallScripts(plugin.packageName, plugin.version, localPkg.scripts)
        copyCleanLocalPackageDir(localRootDir, rootPkgDir)
        resolvedFrom = 'local-dir'
      } else {
        const tarballUrl = await resolveRootTarballUrl(plugin, registryUrl, fetchFn, packumentMemo)
        const tgzBuf = await fetchVerifiedTarball({
          url: tarballUrl,
          expectedIntegritySha512: plugin.integritySha512,
          tarballCacheDir,
          cacheFileName: `${safeCacheKey(plugin.packageName, plugin.version, plugin.integritySha512)}.tgz`,
          fetchFn,
        })
        extractVerifiedNpmTarball(tgzBuf, rootPkgDir)
        const extractedPkg = JSON.parse(readFileSync(path.join(rootPkgDir, 'package.json'), 'utf8')) as {
          name?: string
          version?: string
          scripts?: Record<string, string>
        }
        if (extractedPkg.name !== plugin.packageName || extractedPkg.version !== plugin.version) {
          throw new Error(
            `Extracted tarball manifest mismatch: expected ${plugin.packageName}@${plugin.version}, got ${String(extractedPkg.name)}@${String(extractedPkg.version)}`,
          )
        }
        assertSafeInstallScripts(plugin.packageName, plugin.version, extractedPkg.scripts)
      }

      // BFS resolve production dependencies ONLY (never devDependencies / peerDependencies)
      const hoistedVersions = new Map<string, string>()
      hoistedVersions.set(plugin.packageName, plugin.version)
      const transitiveDeps: TransitivePackageRecord[] = []
      const visited = new Set<string>()
      const queue: { readonly pkgDir: string; readonly parentRelDir: string }[] = [
        { pkgDir: rootPkgDir, parentRelDir: `node_modules/${plugin.packageName}` },
      ]

      while (queue.length > 0) {
        const current = queue.shift()!
        const pkgJsonPath = path.join(current.pkgDir, 'package.json')
        if (!existsSync(pkgJsonPath)) continue
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
          dependencies?: Record<string, string>
        }
        const deps = pkgJson.dependencies ?? {}
        for (const [depName, depRange] of Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))) {
          if (isHostRuntimeSharedPackage(depName)) continue
          const visitKey = `${current.parentRelDir}->${depName}@${depRange}`
          if (visited.has(visitKey)) continue
          visited.add(visitKey)

          const existingHoisted = hoistedVersions.get(depName)
          if (existingHoisted && semver.satisfies(existingHoisted, depRange, { includePrerelease: true })) {
            continue
          }

          let resolvedVer: string
          let resolvedIntegrity: string
          let depDir: string
          let installRelDir: string
          let depFiles: number

          const localDepDir = options.localPackageDirs?.[depName]
          if (localDepDir) {
            const localDepPkg = JSON.parse(readFileSync(path.join(localDepDir, 'package.json'), 'utf8')) as {
              name?: string
              version?: string
              scripts?: Record<string, string>
            }
            if (!localDepPkg.version || !semver.satisfies(localDepPkg.version, depRange, { includePrerelease: true })) {
              throw new Error(
                `Local dependency ${depName}@${String(localDepPkg.version)} does not satisfy "${depRange}"`,
              )
            }
            assertSafeInstallScripts(depName, localDepPkg.version, localDepPkg.scripts)
            resolvedVer = localDepPkg.version
            resolvedIntegrity = `sha512-${createHash('sha512').update(`${depName}@${resolvedVer}:local`).digest('base64')}`
            installRelDir = existingHoisted
              ? `${current.parentRelDir}/node_modules/${depName}`
              : `node_modules/${depName}`
            depDir = path.join(tmpStageDir, ...installRelDir.split('/'))
            const copied = copyCleanLocalPackageDir(localDepDir, depDir)
            depFiles = copied.fileCount
          } else {
            const packument = await resolveNpmPackument(depName, registryUrl, fetchFn, packumentMemo)
            const allVersions = Object.keys(packument.versions ?? {})
            const best = semver.maxSatisfying(allVersions, depRange, { includePrerelease: false }) ??
              semver.maxSatisfying(allVersions, depRange, { includePrerelease: true })
            if (!best) {
              throw new Error(`No npm version of ${depName} satisfies "${depRange}"`)
            }
            const verDoc = packument.versions![best]!
            assertSafeInstallScripts(depName, best, verDoc.scripts)
            if (!verDoc.dist?.tarball || !verDoc.dist?.integrity || !verDoc.dist.integrity.startsWith('sha512-')) {
              throw new Error(`npm registry missing sha512 integrity or tarball for ${depName}@${best}`)
            }
            resolvedVer = best
            resolvedIntegrity = verDoc.dist.integrity
            installRelDir = existingHoisted
              ? `${current.parentRelDir}/node_modules/${depName}`
              : `node_modules/${depName}`
            depDir = path.join(tmpStageDir, ...installRelDir.split('/'))
            const depBuf = await fetchVerifiedTarball({
              url: verDoc.dist.tarball,
              expectedIntegritySha512: resolvedIntegrity,
              tarballCacheDir,
              cacheFileName: `${safeCacheKey(depName, resolvedVer, resolvedIntegrity)}.tgz`,
              fetchFn,
            })
            const extracted = extractVerifiedNpmTarball(depBuf, depDir)
            depFiles = extracted.fileCount
          }

          if (!existingHoisted) hoistedVersions.set(depName, resolvedVer)
          transitiveDeps.push({
            packageName: depName,
            version: resolvedVer,
            integritySha512: resolvedIntegrity,
            installRelDir,
            fileCount: depFiles,
          })
          queue.push({ pkgDir: depDir, parentRelDir: installRelDir })
        }
      }

      // Scrub any shadow host runtime packages and validate full staged tree
      scrubShadowHostPackages(nmDir)
      const audit = auditStagedNodeModules(nmDir)

      const manifest: StagedExternalPayloadManifest = {
        schemaVersion: 1,
        packageName: plugin.packageName,
        version: plugin.version,
        sourceKind: plugin.sourceKind === 'git' ? 'git' : 'npm',
        sourceRef: plugin.sourceRef,
        integritySha512: plugin.integritySha512,
        resolvedFrom,
        transitiveDeps,
        fileCount: audit.fileCount,
        totalBytes: audit.totalBytes,
        maxRelPath: audit.maxRelPath,
        stagedAt: new Date().toISOString(),
      }
      writeFileSync(path.join(tmpStageDir, 'payload-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)

      rmSync(stageDir, { recursive: true, force: true })
      renameSync(tmpStageDir, stageDir)
      results.push({ entry: plugin, stageDir, manifest })
    } catch (error) {
      rmSync(tmpStageDir, { recursive: true, force: true })
      throw error
    }
  }

  return results
}

/**
 * Synchronously locate and verify staged external plugin payloads for `buildProfileSeed`.
 * Throws if ANY non-builtin plugin in `lock.plugins` has not been materialized and verified.
 */
export function readStagedExternalPluginPayloadsSync(
  lock: PlatformLock,
  options: { readonly pluginCacheDir?: string } = {},
): readonly MaterializedExternalPlugin[] {
  const externalPlugins = lock.plugins.filter((p) => p.sourceKind !== 'builtin')
  if (externalPlugins.length === 0) return []

  const pluginCacheDir = path.resolve(options.pluginCacheDir ?? defaultPluginCacheDir())
  const results: MaterializedExternalPlugin[] = []
  for (const plugin of externalPlugins) {
    const stageDir = stagedPayloadDirFor(plugin, pluginCacheDir)
    const manifest = readExistingVerifiedManifest(stageDir, plugin)
    if (manifest === null) {
      throw new Error(
        `Missing verified staged payload for external plugin ${plugin.packageName}@${plugin.version}. ` +
        `Run ensureExternalPluginPayloads() before buildProfileSeed() (cache: ${pluginCacheDir}).`,
      )
    }
    results.push({ entry: plugin, stageDir, manifest })
  }
  return results
}

/** Collect all regular files under `stageDir/node_modules` as sorted relative entries for seed packing. */
export function collectStagedNodeModulesFiles(
  stageDir: string,
): readonly { readonly name: string; readonly content: Buffer }[] {
  const nmDir = path.join(stageDir, 'node_modules')
  if (!existsSync(nmDir)) return []
  const files: { readonly name: string; readonly content: Buffer }[] = []

  const walk = (dir: string, relBase: string): void => {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
      const full = path.join(dir, name)
      const st = lstatSync(full)
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to pack symlink from staged external plugin: ${relBase}/${name}`)
      }
      const rel = `${relBase}/${name}`
      const safeRel = validateSafeRelPath(rel)
      if (safeRel.length > MAX_SEED_REL_PATH_BUDGET) {
        throw new Error(
          `Seed entry "${safeRel}" length (${safeRel.length}) exceeds MAX_PATH budget (${MAX_SEED_REL_PATH_BUDGET})`,
        )
      }
      if (st.isDirectory()) {
        walk(full, safeRel)
      } else if (st.isFile() && statSync(full).isFile()) {
        files.push({ name: safeRel, content: readFileSync(full) })
      }
    }
  }

  walk(nmDir, 'node_modules')
  return files
}

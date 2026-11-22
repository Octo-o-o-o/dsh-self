import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { stringify } from 'yaml'
import {
  PINNED_DSH_RUNTIME_VERSION,
  SeedManifestSchema,
  type PlatformLock,
  type ProductSpec,
  type SeedManifest,
} from '@dsh-self/product-spec'
import {
  MAX_SEED_REL_PATH_BUDGET,
  collectStagedNodeModulesFiles,
  isHostRuntimeSharedPackage,
  readStagedExternalPluginPayloadsSync,
} from './external-plugins.js'

export const WELCOME_NOTICE_VERSION = '2026-09-28.1'
export const MAX_SEED_ARCHIVE_BYTES = 80 * 1024 * 1024

interface TarFileEntry {
  readonly name: string
  readonly content: Buffer
  readonly mode?: number
}

function buildPaxHeaderRecord(key: string, value: string): Buffer {
  const payload = ` ${key}=${value}\n`
  let len = Buffer.byteLength(payload, 'utf8') + 2
  while (true) {
    const line = `${len}${payload}`
    const actual = Buffer.byteLength(line, 'utf8')
    if (actual === len) return Buffer.from(line, 'utf8')
    len = actual
  }
}

function buildUstarHeader(options: {
  readonly name: string
  readonly size: number
  readonly mode: number
  readonly typeflag: '0' | 'x'
}): Buffer {
  const header = Buffer.alloc(512, 0)
  const nameBytes = Buffer.from(options.name, 'utf8')
  nameBytes.subarray(0, Math.min(100, nameBytes.length)).copy(header, 0)
  header.write(`${options.mode.toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${options.size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.fill(0x20, 148, 156)
  header.write(options.typeflag, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += header[i]!
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function pad512(buf: Buffer): Buffer {
  const rem = buf.length % 512
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem, 0)])
}

/**
 * Deterministic PAX/ustar `.tar.gz` packer (sorted paths, zero mtime, zero gzip mtime,
 * automatic PAX headers for paths > 100 bytes within the 130-char Windows MAX_PATH budget).
 */
export function packDeterministicTarGz(files: readonly TarFileEntry[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const seenLower = new Set<string>()
  const blocks: Buffer[] = []
  for (const file of sorted) {
    const cleanName = file.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (cleanName.length === 0 || cleanName.includes('..') || cleanName.length > MAX_SEED_REL_PATH_BUDGET) {
      throw new Error(`Invalid tar entry name (length ${cleanName.length}, max ${MAX_SEED_REL_PATH_BUDGET}): ${cleanName}`)
    }
    const lower = cleanName.toLowerCase()
    if (seenLower.has(lower)) {
      throw new Error(`Case-insensitive duplicate tar entry rejected: ${cleanName}`)
    }
    seenLower.add(lower)

    if (Buffer.byteLength(cleanName, 'utf8') > 100) {
      const paxData = buildPaxHeaderRecord('path', cleanName)
      blocks.push(buildUstarHeader({ name: 'PaxHeader', size: paxData.length, mode: 0o644, typeflag: 'x' }))
      blocks.push(pad512(paxData))
    }
    blocks.push(buildUstarHeader({ name: cleanName, size: file.content.length, mode: file.mode ?? 0o644, typeflag: '0' }))
    blocks.push(pad512(file.content))
  }
  blocks.push(Buffer.alloc(1024, 0))
  const gz = gzipSync(Buffer.concat(blocks), { level: 6 })
  // Zero gzip header mtime bytes [4..7] and OS byte [9] for 100% deterministic SHA-256 across runs
  if (gz.length >= 10) {
    gz.writeUInt32LE(0, 4)
    gz[9] = 0xff
  }
  return gz
}

/**
 * Build deterministic `profile-seed.tar.gz` and `seed-manifest.json`.
 *
 * Key upstream contracts respected here:
 * - Sets `session-log-deepseek.enabled: false` and `ui-settings-general.welcomeNoticeVersion: '2026-09-28.1'`
 *   inside the seed's `cordis.patch.yml` (NOT in `--patch`, because `config-editor` rejects edits
 *   to entries overridden by `--patch`!).
 * - Zero `!!js` custom YAML tags, zero `workspace:*` references.
 * - Materializes verified external DSH plugins (from `ensureExternalPluginPayloads`) into
 *   `node_modules/` with `dsh.profile.bundles`, `dependencies`, `.npmrc` (`ignore-scripts=true`),
 *   and zero `@deepseek-ai/dsh*` / `@deepseek-ai/cordis*` shadow copies.
 */
export function buildProfileSeed(options: {
  readonly spec: ProductSpec
  readonly lock: PlatformLock
  readonly outDir: string
  readonly extraSeedSalt?: string
  readonly pluginCacheDir?: string
}): {
  readonly archivePath: string
  readonly manifestPath: string
  readonly manifest: SeedManifest
} {
  mkdirSync(options.outDir, { recursive: true })

  const stagedExternal = readStagedExternalPluginPayloadsSync(options.lock, {
    pluginCacheDir: options.pluginCacheDir,
  })
  const orderedExternal = [...stagedExternal].sort((a, b) => a.entry.enableOrder - b.entry.enableOrder)

  // Seed cordis.patch.yml — plain YAML, editable by user settings UI
  const patchRows: Record<string, unknown>[] = [
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'ui-settings-general', config: { welcomeNoticeVersion: WELCOME_NOTICE_VERSION } },
    {
      id: 'ui-branding',
      config: {
        appName: options.spec.brand.displayName.zh,
        productSlug: options.spec.identity.internalSlug,
      },
    },
  ]
  const patchYaml = `# Seed profile patch for ${options.spec.identity.internalSlug} v${options.spec.appVersion}\n${stringify(patchRows)}`
  if (/!!js\b/.test(patchYaml)) {
    throw new Error('Seed cordis.patch.yml must never contain !!js tags')
  }

  const managedBundles = [
    'dsh-theme-product',
    'dsh-shell-product',
    ...options.lock.plugins.map((p) => p.packageName),
  ]

  const externalBundleNames = orderedExternal.map((item) => item.entry.packageName)
  const externalDependencies: Record<string, string> = {}
  for (const item of orderedExternal) {
    externalDependencies[item.entry.packageName] = item.entry.version
  }

  const profilePkg = {
    name: `dsh-profile-${options.spec.identity.internalSlug}`,
    version: options.spec.appVersion,
    private: true,
    description: `Isolated dsh profile seed for ${options.spec.brand.displayName.en}`,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...externalBundleNames],
      },
    },
    dshSelfSeed: {
      productId: options.spec.identity.productId,
      revision: options.spec.revision,
      target: options.lock.target,
      ...(options.extraSeedSalt ? { salt: options.extraSeedSalt } : {}),
    },
    dependencies: externalDependencies,
  }
  const profilePkgJson = `${JSON.stringify(profilePkg, undefined, 2)}\n`
  if (profilePkgJson.includes('workspace:')) {
    throw new Error('Seed profile package.json must not contain workspace:*')
  }

  const cordisYml = '[]\n'
  const pnpmWorkspaceYml = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  const compatibilityJson = `${JSON.stringify({ schemaVersion: 1, exemptions: {} }, undefined, 2)}\n`

  const tarEntries: TarFileEntry[] = [
    { name: 'product-plugins.lock.json', content: Buffer.from(JSON.stringify(options.lock), 'utf8') },
    { name: 'package.json', content: Buffer.from(profilePkgJson, 'utf8') },
    { name: 'cordis.yml', content: Buffer.from(cordisYml, 'utf8') },
    { name: 'cordis.patch.yml', content: Buffer.from(patchYaml, 'utf8') },
    { name: 'pnpm-workspace.yaml', content: Buffer.from(pnpmWorkspaceYml, 'utf8') },
    { name: 'compatibility.json', content: Buffer.from(compatibilityJson, 'utf8') },
  ]

  if (orderedExternal.length > 0) {
    tarEntries.push({ name: '.npmrc', content: Buffer.from('ignore-scripts=true\n', 'utf8') })
    tarEntries.push({
      name: 'external-payloads.json',
      content: Buffer.from(
        `${JSON.stringify({
          schemaVersion: 1,
          plugins: orderedExternal.map((item) => ({
            packageName: item.manifest.packageName,
            version: item.manifest.version,
            integritySha512: item.manifest.integritySha512,
            resolvedFrom: item.manifest.resolvedFrom,
            transitiveDeps: item.manifest.transitiveDeps,
          })),
        }, undefined, 2)}\n`,
        'utf8',
      ),
    })

    // Collect & deduplicate all node_modules files across external & local-installed plugins.
    // Identical hoisted deps (e.g. shared playwright-core) are deduplicated; differing transitive
    // versions are automatically nested under `node_modules/<plugin>/node_modules/<dep>`.
    const nodeModulesByPath = new Map<string, Buffer>()
    const claimedTopPkgFiles = new Map<string, Map<string, Buffer>>()
    for (const item of orderedExternal) {
      const files = collectStagedNodeModulesFiles(item.stageDir)
      const groupedByTopPkg = new Map<string, { readonly name: string; readonly content: Buffer }[]>()
      for (const file of files) {
        const segs = file.name.split('/')
        const topPkg = segs[1]?.startsWith('@') ? `${segs[1]}/${segs[2] ?? ''}` : (segs[1] ?? '')
        if (!topPkg || isHostRuntimeSharedPackage(topPkg)) continue
        const bucket = groupedByTopPkg.get(topPkg) ?? []
        bucket.push(file)
        groupedByTopPkg.set(topPkg, bucket)
      }

      for (const [topPkg, pkgFiles] of groupedByTopPkg.entries()) {
        const existingPkgMap = claimedTopPkgFiles.get(topPkg)
        if (!existingPkgMap) {
          const newMap = new Map<string, Buffer>()
          for (const file of pkgFiles) {
            nodeModulesByPath.set(file.name, file.content)
            newMap.set(file.name, file.content)
          }
          claimedTopPkgFiles.set(topPkg, newMap)
          continue
        }

        const isIdentical =
          existingPkgMap.size === pkgFiles.length &&
          pkgFiles.every((file) => {
            const prev = existingPkgMap.get(file.name)
            return prev !== undefined && prev.equals(file.content)
          })
        if (isIdentical) continue

        if (topPkg === item.entry.packageName) {
          throw new Error(
            `Conflicting root package files across external plugins for ${topPkg}`,
          )
        }

        // Nest conflicting transitive dependency privately under the owning external plugin
        for (const file of pkgFiles) {
          const suffix = file.name.slice('node_modules/'.length)
          const nestedName = `node_modules/${item.entry.packageName}/node_modules/${suffix}`
          if (nestedName.length > MAX_SEED_REL_PATH_BUDGET) {
            throw new Error(
              `Nested conflicting dependency path "${nestedName}" (${nestedName.length}) exceeds MAX_PATH budget (${MAX_SEED_REL_PATH_BUDGET})`,
            )
          }
          const prevNested = nodeModulesByPath.get(nestedName)
          if (prevNested && !prevNested.equals(file.content)) {
            throw new Error(`Conflicting nested dependency file: ${nestedName}`)
          }
          nodeModulesByPath.set(nestedName, file.content)
        }
      }
    }
    for (const [name, content] of nodeModulesByPath.entries()) {
      tarEntries.push({ name, content })
    }
  }

  const archiveBuffer = packDeterministicTarGz(tarEntries)
  if (archiveBuffer.byteLength > MAX_SEED_ARCHIVE_BYTES) {
    throw new Error(
      `profile-seed.tar.gz (${(archiveBuffer.byteLength / 1048576).toFixed(1)} MiB) exceeds ${MAX_SEED_ARCHIVE_BYTES / 1048576} MiB SLO budget`,
    )
  }
  const maxEntryRelPath = Math.max(...tarEntries.map((e) => e.name.length))

  const seedHash = createHash('sha256').update(archiveBuffer).digest('hex')
  const archivePath = path.join(options.outDir, 'profile-seed.tar.gz')
  writeFileSync(archivePath, archiveBuffer)

  const manifest: SeedManifest = SeedManifestSchema.parse({
    schemaVersion: 1,
    target: options.lock.target,
    dshRuntimeVersion: options.lock.dshRuntimeVersion || PINNED_DSH_RUNTIME_VERSION,
    seedHash,
    seedBytes: archiveBuffer.byteLength,
    maxEntryRelPath,
    managedBundles,
    builtAt: new Date().toISOString(),
  })
  const manifestPath = path.join(options.outDir, 'seed-manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  return { archivePath, manifestPath, manifest }
}

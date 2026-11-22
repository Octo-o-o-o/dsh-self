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

export const WELCOME_NOTICE_VERSION = '2026-09-28.1'

interface TarFileEntry {
  readonly name: string
  readonly content: Buffer
  readonly mode?: number
}

/** Deterministic POSIX ustar `.tar.gz` packer (sorted paths, zero mtime, safe relative names). */
export function packDeterministicTarGz(files: readonly TarFileEntry[]): Buffer {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name))
  const blocks: Buffer[] = []
  for (const file of sorted) {
    const cleanName = file.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (cleanName.includes('..') || Buffer.byteLength(cleanName) > 100) {
      throw new Error(`Invalid tar entry name: ${cleanName}`)
    }
    const header = Buffer.alloc(512, 0)
    header.write(cleanName, 0, 100, 'utf8')
    header.write(`${(file.mode ?? 0o644).toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${file.content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.fill(0x20, 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let sum = 0
    for (let i = 0; i < 512; i += 1) sum += header[i]!
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, file.content)
    const rem = file.content.length % 512
    if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0))
  }
  blocks.push(Buffer.alloc(1024, 0))
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 })
  // Zero gzip header mtime bytes [4..7] for 100% deterministic SHA-256 across runs
  gz.writeUInt32LE(0, 4)
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
 */
export function buildProfileSeed(options: {
  readonly spec: ProductSpec
  readonly lock: PlatformLock
  readonly outDir: string
  readonly extraSeedSalt?: string
}): {
  readonly archivePath: string
  readonly manifestPath: string
  readonly manifest: SeedManifest
} {
  mkdirSync(options.outDir, { recursive: true })

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

  const profilePkg = {
    name: `dsh-profile-${options.spec.identity.internalSlug}`,
    version: options.spec.appVersion,
    private: true,
    description: `Isolated dsh profile seed for ${options.spec.brand.displayName.en}`,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      },
    },
    dshSelfSeed: {
      productId: options.spec.identity.productId,
      revision: options.spec.revision,
      target: options.lock.target,
      ...(options.extraSeedSalt ? { salt: options.extraSeedSalt } : {}),
    },
    dependencies: {},
  }
  const profilePkgJson = `${JSON.stringify(profilePkg, undefined, 2)}\n`
  if (profilePkgJson.includes('workspace:')) {
    throw new Error('Seed profile package.json must not contain workspace:*')
  }

  const cordisYml = '[]\n'
  const pnpmWorkspaceYml = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'
  const compatibilityJson = `${JSON.stringify({ schemaVersion: 1, exemptions: {} }, undefined, 2)}\n`

  const tarEntries = [
    { name: 'package.json', content: Buffer.from(profilePkgJson, 'utf8') },
    { name: 'cordis.yml', content: Buffer.from(cordisYml, 'utf8') },
    { name: 'cordis.patch.yml', content: Buffer.from(patchYaml, 'utf8') },
    { name: 'pnpm-workspace.yaml', content: Buffer.from(pnpmWorkspaceYml, 'utf8') },
    { name: 'compatibility.json', content: Buffer.from(compatibilityJson, 'utf8') },
  ]
  const archiveBuffer = packDeterministicTarGz(tarEntries)
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

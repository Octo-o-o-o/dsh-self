import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PINNED_TEMPLATE_COMMIT,
  BuildReceiptSchema,
  type BuildReceipt,
  type ProductSpec,
} from '@dsh-self/product-spec'
import { generateProductIcons } from '../icon-gen.js'
import { ensureExternalPluginPayloads } from '../external-plugins.js'
import { buildProfileSeed } from '../seed-builder.js'
import { sha256File, type ValidatedBuildSnapshot } from '../validate-and-snapshot.js'

export interface LinuxStagedPlan {
  readonly installPrefix: string
  readonly desktopEntryPath: string
  readonly desktopEntryContent: string
  readonly desktopName: string
  readonly packageName: string
  readonly iconName: string
  readonly permissions: Readonly<Record<string, string>>
  readonly debConfig: Readonly<Record<string, unknown>>
}

/**
 * Generate FreeDesktop `.desktop` entry and `/opt/<internalSlug>` Linux `.deb` staging metadata.
 * Uses strictly ASCII `desktopName = internalSlug` and `packageName = internalSlug` so multiple
 * same-name clients never overwrite each other's `/usr/share/applications/*.desktop` or `/opt/*`.
 */
export function buildLinuxDesktopEntry(spec: ProductSpec): string {
  const slug = spec.identity.internalSlug
  const nameEn = spec.brand.displayName.en.replace(/[\r\n]/g, ' ')
  const nameZh = spec.brand.displayName.zh.replace(/[\r\n]/g, ' ')
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${nameEn}`,
    `Name[zh_CN]=${nameZh}`,
    `Comment=${nameEn} standalone workspace`,
    `Exec=/opt/${slug}/${slug} %U`,
    `Icon=${slug}`,
    'Terminal=false',
    'Categories=Office;Utility;',
    `StartupWMClass=${slug}`,
    '',
  ].join('\n')
}

export async function stageLinuxDebPackage(options: {
  readonly snapshot: ValidatedBuildSnapshot
  readonly outDir: string
  readonly jobId: string
  readonly baseShellDir?: string
  readonly pluginCacheDir?: string
}): Promise<{ readonly plan: LinuxStagedPlan; readonly receipt: BuildReceipt }> {
  const { spec, lock, identity } = options.snapshot
  const slug = spec.identity.internalSlug
  const outDir = path.resolve(options.outDir)
  const stageRoot = path.join(outDir, 'linux-stage')
  const optDir = path.join(stageRoot, 'opt', slug)
  const productDir = path.join(optDir, 'resources', 'product')
  const appsDir = path.join(stageRoot, 'usr', 'share', 'applications')

  mkdirSync(productDir, { recursive: true })
  mkdirSync(appsDir, { recursive: true })

  const icons = await generateProductIcons({
    spec,
    outDir: path.join(stageRoot, 'icons-out'),
    iconSourcePath: options.snapshot.iconSourcePath,
  })
  cpSync(icons.png256Path, path.join(productDir, 'icon.png'))
  writeFileSync(path.join(productDir, 'product.json'), `${JSON.stringify(spec, undefined, 2)}\n`)
  writeFileSync(path.join(productDir, 'identity.json'), `${JSON.stringify(identity, undefined, 2)}\n`)
  writeFileSync(path.join(productDir, 'plugins.linux-x64.lock.json'), `${JSON.stringify(lock, undefined, 2)}\n`)

  await ensureExternalPluginPayloads(lock, { pluginCacheDir: options.pluginCacheDir })
  const seed = buildProfileSeed({ spec, lock, outDir: productDir, pluginCacheDir: options.pluginCacheDir })

  if (options.baseShellDir && existsSync(options.baseShellDir)) {
    cpSync(options.baseShellDir, optDir, { recursive: true })
  }

  const desktopEntryContent = buildLinuxDesktopEntry(spec)
  const desktopEntryPath = path.join(appsDir, `${slug}.desktop`)
  writeFileSync(desktopEntryPath, desktopEntryContent, 'utf8')

  const debConfig = {
    appId: spec.identity.appId,
    productName: spec.brand.displayName.en,
    linux: {
      target: ['deb'],
      executableName: slug,
      desktop: {
        Name: spec.brand.displayName.en,
        'Name[zh_CN]': spec.brand.displayName.zh,
        StartupWMClass: slug,
      },
      icon: icons.linuxIconsDir,
      category: 'Office',
    },
    deb: {
      packageName: slug,
      desktopName: slug,
      afterInstall: undefined,
    },
  }

  const plan: LinuxStagedPlan = {
    installPrefix: `/opt/${slug}`,
    desktopEntryPath,
    desktopEntryContent,
    desktopName: slug,
    packageName: slug,
    iconName: slug,
    permissions: {
      [`/opt/${slug}/${slug}`]: '0755',
      [`/opt/${slug}/chrome-sandbox`]: '4755',
      [`/usr/share/applications/${slug}.desktop`]: '0644',
    },
    debConfig,
  }

  const manifestArtifact = path.join(outDir, `${slug}-${spec.appVersion}-linux-x64-stage.json`)
  writeFileSync(manifestArtifact, `${JSON.stringify(plan, undefined, 2)}\n`)

  const receipt: BuildReceipt = BuildReceiptSchema.parse({
    schemaVersion: 1,
    jobId: options.jobId,
    dedupKey: options.snapshot.dedupKey,
    productId: spec.identity.productId,
    revision: spec.revision,
    appVersion: spec.appVersion,
    target: 'linux-x64',
    productDigest: options.snapshot.productDigest,
    lockDigest: options.snapshot.lockDigest,
    seedHash: seed.manifest.seedHash,
    templateCommit: PINNED_TEMPLATE_COMMIT,
    toolchainVersion: '0.1.0',
    distributionStatus: 'unsigned-local-test',
    artifactPath: manifestArtifact,
    artifactSha256: sha256File(manifestArtifact),
    artifactBytes: Buffer.byteLength(JSON.stringify(plan, undefined, 2) + '\n', 'utf8'),
    builtAt: new Date().toISOString(),
  })
  writeFileSync(path.join(outDir, 'build-receipt.json'), `${JSON.stringify(receipt, undefined, 2)}\n`)

  return { plan, receipt }
}

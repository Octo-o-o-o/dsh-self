import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PINNED_TEMPLATE_COMMIT,
  BuildReceiptSchema,
  type BuildReceipt,
  type ProductSpec,
  type SupportedTarget,
} from '@dsh-self/product-spec'
import { generateProductIcons } from '../icon-gen.js'
import { buildProfileSeed } from '../seed-builder.js'
import { sha256File, type ValidatedBuildSnapshot } from '../validate-and-snapshot.js'

export interface DarwinStagedPlan {
  readonly appBundleName: string
  readonly bundleId: string
  readonly executableName: string
  readonly helperNames: readonly string[]
  readonly localizationFiles: readonly string[]
  readonly codesignOrder: readonly string[]
  readonly adHocSignCommandTemplate: string
}

function escapePlistXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeStringsValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
}

export function buildDarwinInfoPlist(spec: ProductSpec): string {
  const slug = spec.identity.internalSlug
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${escapePlistXml(spec.identity.appId)}</string>
  <key>CFBundleName</key>
  <string>${escapePlistXml(slug)}</string>
  <key>CFBundleDisplayName</key>
  <string>${escapePlistXml(spec.brand.displayName.en)}</string>
  <key>CFBundleExecutable</key>
  <string>${escapePlistXml(slug)}</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapePlistXml(spec.appVersion)}</string>
  <key>CFBundleVersion</key>
  <string>${escapePlistXml(spec.appVersion)}</string>
  <key>LSHasLocalizedDisplayName</key>
  <true/>
</dict>
</plist>
`
}

/**
 * Compute deterministic inside-out macOS ad-hoc signing order (Frameworks & 4 Helpers BEFORE outer `.app`).
 */
export function buildDarwinInsideOutCodesignOrder(internalSlug: string): readonly string[] {
  const app = `${internalSlug}.app`
  return [
    `${app}/Contents/Frameworks/Electron Framework.framework`,
    `${app}/Contents/Frameworks/${internalSlug} Helper (GPU).app`,
    `${app}/Contents/Frameworks/${internalSlug} Helper (Plugin).app`,
    `${app}/Contents/Frameworks/${internalSlug} Helper (Renderer).app`,
    `${app}/Contents/Frameworks/${internalSlug} Helper.app`,
    `${app}/Contents/Resources/runtime/node/bin/node`,
    app,
  ]
}

/**
 * Stage macOS ASCII `<internalSlug>.app` bundle structure with `.localized` / `zh_CN.lproj` / `en.lproj`
 * `InfoPlist.strings`, 4 Helpers, `icon.icns`, and strict inside-out `codesign --force --sign -` plan.
 */
export async function stageDarwinAppBundle(options: {
  readonly snapshot: ValidatedBuildSnapshot
  readonly target: Extract<SupportedTarget, 'darwin-arm64' | 'darwin-x64'>
  readonly outDir: string
  readonly jobId: string
}): Promise<{ readonly plan: DarwinStagedPlan; readonly receipt: BuildReceipt }> {
  const { spec, lock, identity } = options.snapshot
  const slug = spec.identity.internalSlug
  const outDir = path.resolve(options.outDir)
  const appDir = path.join(outDir, 'darwin-stage', `${slug}.app`)
  const contentsDir = path.join(appDir, 'Contents')
  const resourcesDir = path.join(contentsDir, 'Resources')
  const productDir = path.join(resourcesDir, 'product')
  const frameworksDir = path.join(contentsDir, 'Frameworks')

  mkdirSync(productDir, { recursive: true })
  mkdirSync(frameworksDir, { recursive: true })
  mkdirSync(path.join(resourcesDir, 'zh_CN.lproj'), { recursive: true })
  mkdirSync(path.join(resourcesDir, 'en.lproj'), { recursive: true })

  // Localized display names so Finder shows Chinese/English brand name while disk bundle stays pure ASCII
  const zhStringsPath = path.join(resourcesDir, 'zh_CN.lproj', 'InfoPlist.strings')
  const enStringsPath = path.join(resourcesDir, 'en.lproj', 'InfoPlist.strings')
  writeFileSync(zhStringsPath, `"CFBundleDisplayName" = "${escapeStringsValue(spec.brand.displayName.zh)}";\n`, 'utf8')
  writeFileSync(enStringsPath, `"CFBundleDisplayName" = "${escapeStringsValue(spec.brand.displayName.en)}";\n`, 'utf8')
  writeFileSync(path.join(appDir, '.localized'), '', 'utf8')
  writeFileSync(path.join(contentsDir, 'Info.plist'), buildDarwinInfoPlist(spec), 'utf8')

  const icons = await generateProductIcons({
    spec,
    outDir: path.join(outDir, 'darwin-stage', 'icons-out'),
    iconSourcePath: options.snapshot.iconSourcePath,
  })
  cpSync(icons.icnsPath, path.join(resourcesDir, 'icon.icns'))
  cpSync(icons.png256Path, path.join(productDir, 'icon.png'))
  writeFileSync(path.join(productDir, 'product.json'), `${JSON.stringify(spec, undefined, 2)}\n`)
  writeFileSync(path.join(productDir, 'identity.json'), `${JSON.stringify(identity, undefined, 2)}\n`)
  writeFileSync(path.join(productDir, `plugins.${options.target}.lock.json`), `${JSON.stringify(lock, undefined, 2)}\n`)

  const seed = buildProfileSeed({ spec, lock, outDir: productDir })

  const helperNames = [
    `${slug} Helper.app`,
    `${slug} Helper (GPU).app`,
    `${slug} Helper (Plugin).app`,
    `${slug} Helper (Renderer).app`,
  ] as const
  for (const helper of helperNames) {
    mkdirSync(path.join(frameworksDir, helper, 'Contents'), { recursive: true })
  }

  const codesignOrder = buildDarwinInsideOutCodesignOrder(slug)
  const plan: DarwinStagedPlan = {
    appBundleName: `${slug}.app`,
    bundleId: spec.identity.appId,
    executableName: slug,
    helperNames,
    localizationFiles: ['Resources/zh_CN.lproj/InfoPlist.strings', 'Resources/en.lproj/InfoPlist.strings'],
    codesignOrder,
    adHocSignCommandTemplate: codesignOrder.map((p) => `codesign --force --sign - "${p}"`).join(' && '),
  }

  const stageArtifact = path.join(outDir, `${slug}-${spec.appVersion}-${options.target}-stage.json`)
  writeFileSync(stageArtifact, `${JSON.stringify(plan, undefined, 2)}\n`)

  const receipt: BuildReceipt = BuildReceiptSchema.parse({
    schemaVersion: 1,
    jobId: options.jobId,
    dedupKey: options.snapshot.dedupKey,
    productId: spec.identity.productId,
    revision: spec.revision,
    appVersion: spec.appVersion,
    target: options.target,
    productDigest: options.snapshot.productDigest,
    lockDigest: options.snapshot.lockDigest,
    seedHash: seed.manifest.seedHash,
    templateCommit: PINNED_TEMPLATE_COMMIT,
    toolchainVersion: '0.1.0',
    distributionStatus: 'unsigned-local-test',
    artifactPath: stageArtifact,
    artifactSha256: sha256File(stageArtifact),
    artifactBytes: Buffer.byteLength(JSON.stringify(plan, undefined, 2) + '\n', 'utf8'),
    builtAt: new Date().toISOString(),
  })
  writeFileSync(path.join(outDir, 'build-receipt.json'), `${JSON.stringify(receipt, undefined, 2)}\n`)

  return { plan, receipt }
}

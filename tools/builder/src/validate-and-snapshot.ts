import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  PINNED_TEMPLATE_COMMIT,
  PlatformLockSchema,
  ProductSpecSchema,
  computeSpecDigest,
  desktopCapabilities,
  PINNED_DSH_RUNTIME_VERSION,
  PINNED_NODE_VERSION,
  projectRuntimeIdentity,
  type PlatformLock,
  type ProductSpec,
  type RuntimeIdentityProjection,
  type SupportedTarget,
} from '@dsh-self/product-spec'

export interface ValidatedBuildSnapshot {
  readonly snapshotDir: string
  readonly spec: ProductSpec
  readonly lock: PlatformLock
  readonly identity: RuntimeIdentityProjection
  readonly target: SupportedTarget
  readonly productDigest: string
  readonly lockDigest: string
  readonly dedupKey: string
  readonly iconSourcePath?: string
}

/**
 * Independent trust-root validator & immutable input snapshotter.
 * Studio/UI output is treated as untrusted input and re-validated here from scratch.
 */
export function validateAndSnapshotInputs(options: {
  readonly productPath: string
  readonly lockPath: string
  readonly target: SupportedTarget
  readonly snapshotDir: string
  readonly iconSourcePath?: string
}): ValidatedBuildSnapshot {
  if (!existsSync(options.productPath)) {
    throw new Error(`Missing product.json: ${options.productPath}`)
  }
  if (!existsSync(options.lockPath)) {
    throw new Error(`Missing platform lockfile: ${options.lockPath}`)
  }

  const rawProductText = readFileSync(options.productPath, 'utf8')
  const rawLockText = readFileSync(options.lockPath, 'utf8')

  if (rawLockText.includes('workspace:')) {
    throw new Error('Platform lockfile must not contain unresolved workspace:* specifiers')
  }

  const spec = ProductSpecSchema.parse(JSON.parse(rawProductText))
  const lock = PlatformLockSchema.parse(JSON.parse(rawLockText))

  if (lock.target !== options.target) {
    throw new Error(`Lockfile target "${lock.target}" does not match requested target "${options.target}"`)
  }

  if (lock.dshRuntimeVersion !== PINNED_DSH_RUNTIME_VERSION || lock.nodeVersion !== PINNED_NODE_VERSION ||
      lock.templateCommit !== PINNED_TEMPLATE_COMMIT || lock.transitiveLockDigest !== computeSpecDigest(lock.plugins)) {
    throw new Error('运行时基线或插件锁摘要不匹配 / Inconsistent platform lock')
  }
  if (options.target === 'win32-x64') {
    const capabilities = desktopCapabilities(spec, lock)
    if (capabilities.missing.length || capabilities.unavailablePackages.length) {
      throw new Error(`此构建缺少动作或插件物料 / Unavailable: ${[...capabilities.missing, ...capabilities.unavailablePackages].join(', ')}`)
    }
  }

  const identity = projectRuntimeIdentity(spec)
  const productDigest = computeSpecDigest(spec)
  const lockDigest = computeSpecDigest(lock)
  const dedupKey = computeSpecDigest({
    productId: spec.identity.productId,
    revision: spec.revision,
    target: options.target,
    productDigest,
    lockDigest,
    templateCommit: PINNED_TEMPLATE_COMMIT,
  })

  mkdirSync(options.snapshotDir, { recursive: true })
  writeFileSync(path.join(options.snapshotDir, 'product.json'), `${JSON.stringify(spec, undefined, 2)}\n`)
  writeFileSync(path.join(options.snapshotDir, 'identity.json'), `${JSON.stringify(identity, undefined, 2)}\n`)
  writeFileSync(path.join(options.snapshotDir, `plugins.${options.target}.lock.json`), `${JSON.stringify(lock, undefined, 2)}\n`)

  let copiedIcon: string | undefined
  if (options.iconSourcePath && existsSync(options.iconSourcePath)) {
    const ext = path.extname(options.iconSourcePath) || '.png'
    copiedIcon = path.join(options.snapshotDir, `icon-source${ext}`)
    copyFileSync(options.iconSourcePath, copiedIcon)
  }

  return {
    snapshotDir: options.snapshotDir,
    spec,
    lock,
    identity,
    target: options.target,
    productDigest,
    lockDigest,
    dedupKey,
    iconSourcePath: copiedIcon,
  }
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { BuildReceipt, SupportedTarget } from '@dsh-self/product-spec'
import { validateAndSnapshotInputs } from './validate-and-snapshot.js'
import { buildWin32Installer } from './stagers/win32.js'
import { stageLinuxDebPackage } from './stagers/linux.js'
import { stageDarwinAppBundle } from './stagers/darwin.js'

export * from './validate-and-snapshot.js'
export * from './icon-gen.js'
export * from './external-plugins.js'
export * from './seed-builder.js'
export * from './nsis-generator.js'
export * from './base-shell.js'
export * from './creator-gate.js'
export * from './stagers/win32.js'
export * from './stagers/linux.js'
export * from './stagers/darwin.js'

export interface RunClientBuildOptions {
  readonly productPath: string
  readonly lockPath: string
  readonly target: SupportedTarget
  readonly outDir: string
  readonly baseShellDir?: string
  readonly jobId?: string
  readonly iconSourcePath?: string
  readonly extraSeedSalt?: string
  readonly pluginCacheDir?: string
}

/**
 * Unified independent builder entrypoint:
 * Re-validates inputs via Zod, freezes an immutable snapshot, and executes the target stager/packager.
 */
export async function runClientBuild(options: RunClientBuildOptions): Promise<BuildReceipt> {
  const jobId = options.jobId ?? `job-${randomUUID().slice(0, 8)}`
  const snapshotDir = path.join(path.resolve(options.outDir), 'snapshot')
  const snapshot = validateAndSnapshotInputs({
    productPath: options.productPath,
    lockPath: options.lockPath,
    target: options.target,
    snapshotDir,
    iconSourcePath: options.iconSourcePath,
  })

  if (options.target === 'win32-x64') {
    const baseShellDir = options.baseShellDir ?? process.env.DSH_SELF_BASE_SHELL_DIR
    if (!baseShellDir) {
      throw new Error('win32-x64 build requires --base-shell <dir> or DSH_SELF_BASE_SHELL_DIR')
    }
    return await buildWin32Installer({
      snapshot,
      baseShellDir,
      outDir: options.outDir,
      jobId,
      extraSeedSalt: options.extraSeedSalt,
      pluginCacheDir: options.pluginCacheDir,
    })
  }

  if (options.target === 'linux-x64') {
    const { receipt } = await stageLinuxDebPackage({
      snapshot,
      outDir: options.outDir,
      jobId,
      baseShellDir: options.baseShellDir,
      pluginCacheDir: options.pluginCacheDir,
    })
    return receipt
  }

  const { receipt } = await stageDarwinAppBundle({
    snapshot,
    target: options.target,
    outDir: options.outDir,
    jobId,
    pluginCacheDir: options.pluginCacheDir,
  })
  return receipt
}

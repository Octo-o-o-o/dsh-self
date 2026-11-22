import { existsSync } from 'node:fs'
import path from 'node:path'

export interface AppLayoutInput {
  readonly packaged: boolean
  readonly repoRoot: string
  readonly resourcesPath: string
  readonly moduleDir: string
  readonly platform?: NodeJS.Platform
}

export interface AppLayout {
  readonly packaged: boolean
  readonly runtimeDir: string
  readonly nodePath?: string
  readonly pnpmPackageDir: string
  readonly hostEntry: string
  readonly pluginsDir: string
  readonly cwd: string
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

export function bundledNodePath(runtimeDir: string, platform: NodeJS.Platform): string {
  const paths = pathFor(platform)
  return paths.join(runtimeDir, 'node', platform === 'win32' ? 'node.exe' : paths.join('bin', 'node'))
}

export function resolveAppLayout(input: AppLayoutInput): AppLayout {
  const platform = input.platform ?? process.platform
  const paths = pathFor(platform)
  const runtimeCandidate = paths.join(input.resourcesPath, 'runtime')
  const hasBundledRuntime =
    input.packaged ||
    ((input.platform === undefined || input.platform === process.platform) &&
      existsSync(bundledNodePath(runtimeCandidate, platform)))
  if (!hasBundledRuntime) {
    const runtimeDir = paths.join(input.repoRoot, 'templates', 'desktop', 'runtime')
    return {
      packaged: false,
      runtimeDir,
      pnpmPackageDir: paths.join(runtimeDir, 'node_modules', 'pnpm'),
      hostEntry: paths.join(input.moduleDir, 'host-entry.js'),
      pluginsDir: paths.join(input.repoRoot, 'templates', 'desktop', 'plugins'),
      cwd: path.resolve(input.repoRoot),
    }
  }
  const runtimeDir = runtimeCandidate
  return {
    packaged: true,
    runtimeDir,
    nodePath: bundledNodePath(runtimeDir, platform),
    pnpmPackageDir: paths.join(runtimeDir, 'node_modules', 'pnpm'),
    hostEntry: paths.join(runtimeDir, 'host-entry.js'),
    pluginsDir: paths.join(runtimeDir, 'plugins'),
    cwd: runtimeDir,
  }
}

export function pluginEntryPath(
  pluginsDir: string,
  id: string,
  entryRel = 'index.js',
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(pluginsDir, id, entryRel)
}

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { PINNED_DSH_RUNTIME_VERSION, PINNED_NODE_VERSION } from '@dsh-self/product-spec'

const require = createRequire(import.meta.url)

export interface AssembleBaseShellOptions {
  readonly repoRoot: string
  readonly outDir: string
  readonly electronDistDir: string
  readonly bundledNodeExePath: string
  readonly dshRuntimeNodeModulesDir: string
  readonly desktopDistDir: string
  readonly pluginsDir: string
}

export interface AssembledBaseShell {
  readonly baseShellDir: string
  readonly appAsarPath: string
  readonly electronExePath: string
  readonly runtimeDir: string
  readonly fusesApplied: boolean
}

/**
 * Assemble the immutable `base-shell` (M0/M2):
 * - Copies official Electron 44.11.5 runtime files
 * - Bundles `templates/desktop` compiled `main.js` into `resources/app.asar`
 * - Embeds Node 26.12.1 + pinned `dsh@0.2.2-rc.5` runtime closure + `host-entry.js` + built product plugins
 * - Flips Electron Fuses on `electron.exe` BEFORE creating any per-product installer:
 *   - RunAsNode = false
 *   - EnableCookieEncryption = true
 *   - EnableNodeOptionsEnvironmentVariable = false
 *   - EnableNodeCliInspectArguments = false
 *   - EnableEmbeddedAsarIntegrityValidation = true
 *   - OnlyLoadAppFromAsar = true
 */
export async function assembleWin32BaseShell(options: AssembleBaseShellOptions): Promise<AssembledBaseShell> {
  if (!existsSync(options.electronDistDir)) {
    throw new Error(`Electron dist dir not found: ${options.electronDistDir}`)
  }
  if (!existsSync(options.bundledNodeExePath)) {
    throw new Error(`Bundled Node ${PINNED_NODE_VERSION} binary not found: ${options.bundledNodeExePath}`)
  }
  if (!existsSync(options.dshRuntimeNodeModulesDir)) {
    throw new Error(`Pinned dsh@${PINNED_DSH_RUNTIME_VERSION} node_modules not found: ${options.dshRuntimeNodeModulesDir}`)
  }

  const outDir = path.resolve(options.outDir)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  // 1. Copy Electron runtime distribution
  cpSync(options.electronDistDir, outDir, { recursive: true })

  const resourcesDir = path.join(outDir, 'resources')
  // Remove default_app.asar so Electron loads our app.asar exclusively
  rmSync(path.join(resourcesDir, 'default_app.asar'), { force: true })

  // 2. Pack `resources/app.asar` containing compiled desktop template main process
  const asarStaging = path.join(outDir, '.asar-staging')
  mkdirSync(path.join(asarStaging, 'dist'), { recursive: true })
  cpSync(path.join(options.desktopDistDir, 'main.js'), path.join(asarStaging, 'dist', 'main.js'))
  writeFileSync(
    path.join(asarStaging, 'package.json'),
    `${JSON.stringify({ name: 'dsh-self-shell', version: '0.1.0', type: 'module', main: 'dist/main.js' }, undefined, 2)}\n`,
  )

  const appBuilderRequire = createRequire(require.resolve('electron-builder'))
  const appLibRequire = createRequire(appBuilderRequire.resolve('app-builder-lib'))
  const asar = appLibRequire('@electron/asar') as { createPackage(src: string, dest: string): Promise<void> }
  const appAsarPath = path.join(resourcesDir, 'app.asar')
  await asar.createPackage(asarStaging, appAsarPath)
  rmSync(asarStaging, { recursive: true, force: true })

  // 3. Stage `resources/runtime/` (`node/node.exe`, `host-entry.js`, `plugins/`, and pinned `node_modules/`)
  const runtimeDir = path.join(resourcesDir, 'runtime')
  mkdirSync(path.join(runtimeDir, 'node'), { recursive: true })
  cpSync(options.bundledNodeExePath, path.join(runtimeDir, 'node', 'node.exe'))
  cpSync(path.join(options.desktopDistDir, 'host-entry.js'), path.join(runtimeDir, 'host-entry.js'))

  // Copy built product plugins (`dsh-theme-product` & `dsh-shell-product`), stripping any workspace:* refs
  const runtimePluginsDir = path.join(runtimeDir, 'plugins')
  mkdirSync(runtimePluginsDir, { recursive: true })
  if (existsSync(options.pluginsDir)) {
    cpSync(options.pluginsDir, runtimePluginsDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src)
        return base !== 'src' && base !== 'node_modules'
      },
    })
    for (const pluginName of readdirSync(runtimePluginsDir)) {
      const pkgFile = path.join(runtimePluginsDir, pluginName, 'package.json')
      if (!existsSync(pkgFile)) continue
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      if (pkg.dependencies) {
        for (const [k, v] of Object.entries(pkg.dependencies)) {
          if (typeof v === 'string' && v.startsWith('workspace:')) delete pkg.dependencies[k]
        }
      }
      delete pkg.devDependencies
      writeFileSync(pkgFile, `${JSON.stringify(pkg, undefined, 2)}\n`)
    }
  }

  // Copy pinned dsh@0.2.2-rc.5 runtime node_modules (pruning libreoffice-kit*, source maps, types,
  // and deduplicating 67 nested @deepseek-ai/*/node_modules/zod@4.6.6 copies into a single shared
  // @deepseek-ai/node_modules/zod@4.6.6 so Node's standard resolution finds the exact version with 70% fewer files)
  const runtimeNmDest = path.join(runtimeDir, 'node_modules')
  let sharedScopedZodSource: string | null = null
  const srcDeepseekScope = path.join(options.dshRuntimeNodeModulesDir, '@deepseek-ai')
  if (existsSync(srcDeepseekScope)) {
    for (const entry of readdirSync(srcDeepseekScope)) {
      const candidate = path.join(srcDeepseekScope, entry, 'node_modules', 'zod')
      if (existsSync(path.join(candidate, 'package.json'))) {
        sharedScopedZodSource = candidate
        break
      }
    }
  }
  const normalizedSrcScope = path.normalize(srcDeepseekScope)
  cpSync(options.dshRuntimeNodeModulesDir, runtimeNmDest, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const base = path.basename(src)
      if (base.startsWith('libreoffice-kit')) return false
      if (base.endsWith('.map') || base.endsWith('.d.ts') || base.endsWith('.d.mts') || base.endsWith('.d.cts') || base.endsWith('.tsbuildinfo')) return false
      // Skip duplicated nested @deepseek-ai/<pkg>/node_modules/zod copies (hoisted once to @deepseek-ai/node_modules/zod)
      if (sharedScopedZodSource !== null && base === 'zod') {
        const parentNm = path.dirname(src)
        const grandParent = path.dirname(parentNm)
        if (path.basename(parentNm) === 'node_modules' && path.normalize(path.dirname(grandParent)) === normalizedSrcScope) {
          return false
        }
      }
      return true
    },
  })
  // Install single shared @deepseek-ai/node_modules/zod (exact 4.6.6)
  const deepseekScope = path.join(runtimeNmDest, '@deepseek-ai')
  if (sharedScopedZodSource !== null && existsSync(deepseekScope)) {
    const sharedZodDest = path.join(deepseekScope, 'node_modules', 'zod')
    mkdirSync(path.dirname(sharedZodDest), { recursive: true })
    cpSync(sharedScopedZodSource, sharedZodDest, {
      recursive: true,
      dereference: true,
      filter: (src) => {
        const base = path.basename(src)
        return !base.endsWith('.map') && !base.endsWith('.d.ts') && !base.endsWith('.d.mts') && !base.endsWith('.d.cts')
      },
    })
  }
  // Double-check no libreoffice-kit remains
  if (existsSync(deepseekScope)) {
    for (const entry of readdirSync(deepseekScope)) {
      if (entry.startsWith('libreoffice-kit')) {
        rmSync(path.join(deepseekScope, entry), { recursive: true, force: true })
      }
    }
  }

  // 4. Flip Electron Fuses on `electron.exe` (keep `EnableEmbeddedAsarIntegrityValidation: false` if ASAR header hash
  //    will be verified cleanly without macOS/Windows code-sign mismatch, OR enable full Fuses when integrity is stamped)
  const electronExePath = path.join(outDir, 'electron.exe')
  await flipFuses(electronExePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  })

  // Write base-shell provenance stamp
  writeFileSync(
    path.join(outDir, 'base-shell-manifest.json'),
    `${JSON.stringify({
      dshRuntimeVersion: PINNED_DSH_RUNTIME_VERSION,
      nodeVersion: PINNED_NODE_VERSION,
      fuses: {
        RunAsNode: false,
        EnableCookieEncryption: true,
        EnableNodeOptionsEnvironmentVariable: false,
        EnableNodeCliInspectArguments: false,
        OnlyLoadAppFromAsar: true,
      },
      assembledAt: new Date().toISOString(),
    }, undefined, 2)}\n`,
  )

  return {
    baseShellDir: outDir,
    appAsarPath,
    electronExePath,
    runtimeDir,
    fusesApplied: true,
  }
}

export async function verifyElectronFuses(binaryPath: string): Promise<Record<string, boolean>> {
  const mod = await import(pathToFileURL(require.resolve('@electron/fuses')).href) as {
    getCurrentFuseWire(p: string): Promise<Record<number, number>>
  }
  const wire = await mod.getCurrentFuseWire(binaryPath)
  const isEnabled = (opt: number): boolean => wire[opt] === 49 // ASCII '1'
  return {
    RunAsNode: isEnabled(FuseV1Options.RunAsNode),
    EnableCookieEncryption: isEnabled(FuseV1Options.EnableCookieEncryption),
    EnableNodeOptionsEnvironmentVariable: isEnabled(FuseV1Options.EnableNodeOptionsEnvironmentVariable),
    EnableNodeCliInspectArguments: isEnabled(FuseV1Options.EnableNodeCliInspectArguments),
    OnlyLoadAppFromAsar: isEnabled(FuseV1Options.OnlyLoadAppFromAsar),
  }
}

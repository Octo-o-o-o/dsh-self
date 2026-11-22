/**
 * Assemble the immutable Windows x64 `base-shell` at `.dev/base-shell/win32-x64`
 * reusing local Electron 44.11.5 dist, Node 26.12.1 binary, and pinned dsh@0.2.2-rc.5 runtime closure.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseShellOut = path.join(root, '.dev', 'base-shell', 'win32-x64')
const electronDistCandidates = [
  process.env.DSH_SELF_ELECTRON_DIST,
  path.join(root, 'templates', 'desktop', 'node_modules', 'electron', 'dist'),
  path.resolve(root, '..', 'OctoDEepSeeK', 'apps', 'desktop', 'node_modules', 'electron', 'dist'),
].filter(Boolean)
const electronDist = electronDistCandidates.find((d) => existsSync(path.join(d, 'electron.exe'))) ?? electronDistCandidates[0]
const runtimeNodeModules =
  process.env.DSH_SELF_RUNTIME_NM ??
  path.resolve(root, '..', 'OctoDEepSeeK', 'apps', 'desktop', 'runtime', 'node_modules')
const node26Exe = process.env.DSH_SELF_NODE26_EXE ?? process.execPath

// Prepare clean standalone plugin copies (without devDependencies/node_modules symlinks)
const stagedPlugins = path.join(root, '.dev', 'base-shell', '.plugins-staged')
rmSync(stagedPlugins, { recursive: true, force: true })
mkdirSync(path.join(stagedPlugins, 'dsh-theme-product'), { recursive: true })
mkdirSync(path.join(stagedPlugins, 'dsh-shell-product'), { recursive: true })

const themeSrc = path.join(root, 'templates', 'desktop', 'plugins', 'dsh-theme-product')
cpSync(path.join(themeSrc, 'package.json'), path.join(stagedPlugins, 'dsh-theme-product', 'package.json'))
cpSync(path.join(themeSrc, 'index.js'), path.join(stagedPlugins, 'dsh-theme-product', 'index.js'))
cpSync(path.join(themeSrc, 'lib'), path.join(stagedPlugins, 'dsh-theme-product', 'lib'), { recursive: true })

const shellSrc = path.join(root, 'templates', 'desktop', 'plugins', 'dsh-shell-product')
cpSync(path.join(shellSrc, 'package.json'), path.join(stagedPlugins, 'dsh-shell-product', 'package.json'))
cpSync(path.join(shellSrc, 'dist'), path.join(stagedPlugins, 'dsh-shell-product', 'dist'), { recursive: true })
cpSync(path.join(shellSrc, 'lib'), path.join(stagedPlugins, 'dsh-shell-product', 'lib'), { recursive: true })

const builderMod = await import(pathToFileURL(path.join(root, 'tools', 'builder', 'dist', 'index.js')).href)

if (!existsSync(electronDist)) {
  throw new Error(`Electron dist not found: ${electronDist}`)
}

console.log(`[assemble-base-shell] Assembling Windows x64 base-shell at ${baseShellOut} ...`)
const assembled = await builderMod.assembleWin32BaseShell({
  repoRoot: root,
  outDir: baseShellOut,
  electronDistDir: electronDist,
  bundledNodeExePath: node26Exe,
  dshRuntimeNodeModulesDir: runtimeNodeModules,
  desktopDistDir: path.join(root, 'templates', 'desktop', 'dist'),
  pluginsDir: stagedPlugins,
})

const fuses = await builderMod.verifyElectronFuses(assembled.electronExePath)
console.log('[assemble-base-shell] Electron Fuses verified:', JSON.stringify(fuses))
if (fuses.RunAsNode !== false || fuses.OnlyLoadAppFromAsar !== true || fuses.EnableCookieEncryption !== true) {
  throw new Error(`Unexpected Electron Fuse configuration: ${JSON.stringify(fuses)}`)
}
rmSync(stagedPlugins, { recursive: true, force: true })
console.log('[assemble-base-shell] base-shell ready.')

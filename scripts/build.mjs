/**
 * Full workspace build script:
 * 1. Compiles workspace libraries (`product-spec`, `catalog`, `adapters`)
 * 2. Compiles `tools/dsh-client-build`
 * 3. Compiles `templates/desktop` (`dist/main.js`, `dist/host-entry.js`) and its plugins
 *    (`dsh-theme-product` + `dsh-shell-product` including lazy async chunk `lib/client.docx-viewer.js`)
 * 4. Compiles `tools/builder` (`dist/index.js`, `dist/cli.js`)
 * 5. Packs self-contained official `dsh@0.2.2-rc.5` `dsh-self-studio` bundle + `.tgz`
 */
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { packSelfContainedStudioBundle } from './pack-studio-bundle.mjs'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function main() {
  console.log('[build] 1/5 Building self-contained dsh-self-studio + core libraries...')
  await packSelfContainedStudioBundle()

  const clientBuilderMod = await import(
    pathToFileURL(path.join(root, 'tools', 'dsh-client-build', 'dist', 'index.js')).href
  )

  console.log('[build] 2/5 Building templates/desktop main.js & host-entry.js...')
  const desktopDist = path.join(root, 'templates', 'desktop', 'dist')
  mkdirSync(desktopDist, { recursive: true })
  const esmRequireBanner = {
    js: "import { createRequire as __dshSelfCreateRequire } from 'node:module'; const require = __dshSelfCreateRequire(import.meta.url);",
  }
  await esbuild.build({
    entryPoints: [path.join(root, 'templates', 'desktop', 'src', 'main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: path.join(desktopDist, 'main.js'),
    external: ['electron'],
    banner: esmRequireBanner,
    logLevel: 'silent',
  })
  await esbuild.build({
    entryPoints: [path.join(root, 'templates', 'desktop', 'src', 'host', 'entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: path.join(desktopDist, 'host-entry.js'),
    banner: esmRequireBanner,
    logLevel: 'silent',
  })

  console.log('[build] 3/5 Building desktop template plugins (dsh-theme-product & dsh-shell-product)...')
  const themeDir = path.join(root, 'templates', 'desktop', 'plugins', 'dsh-theme-product')
  const shellDir = path.join(root, 'templates', 'desktop', 'plugins', 'dsh-shell-product')
  await clientBuilderMod.buildClientPackage(themeDir)
  const shellBuild = await clientBuilderMod.buildClientPackage(shellDir)
  console.log(`[build]     dsh-shell-product chunks: ${[shellBuild.entryOutfile, ...shellBuild.chunkOutfiles].map((o) => path.basename(o)).join(', ')}`)

  mkdirSync(path.join(shellDir, 'dist'), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(shellDir, 'src', 'host.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: path.join(shellDir, 'dist', 'host.js'),
    external: ['@deepseek-ai/cordis', 'sharp'],
    banner: esmRequireBanner,
    logLevel: 'silent',
  })

  console.log('[build] 4/5 Building tools/builder (index.js & cli.js)...')
  const builderDist = path.join(root, 'tools', 'builder', 'dist')
  mkdirSync(builderDist, { recursive: true })
  const builderExternal = ['electron-builder', '@electron/fuses', '@electron/asar', 'resedit', 'sharp', 'yaml', 'zod', 'semver']
  for (const entry of ['index', 'cli']) {
    await esbuild.build({
      entryPoints: [path.join(root, 'tools', 'builder', 'src', `${entry}.ts`)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: path.join(builderDist, `${entry}.js`),
      external: builderExternal,
      logLevel: 'silent',
    })
  }

  console.log('[build] 5/5 Verifying built artifacts...')
  const expected = [
    path.join(desktopDist, 'main.js'),
    path.join(desktopDist, 'host-entry.js'),
    path.join(themeDir, 'lib', 'client.js'),
    path.join(shellDir, 'lib', 'client.js'),
    path.join(shellDir, 'lib', 'client.docx-viewer.js'),
    path.join(shellDir, 'dist', 'host.js'),
    path.join(builderDist, 'index.js'),
    path.join(builderDist, 'cli.js'),
    path.join(root, '.dev', 'studio-bundle', 'dsh-self-studio', 'package.json'),
    path.join(root, '.dev', 'studio-bundle', 'dsh-self-studio-0.1.0.tgz'),
  ]
  for (const f of expected) {
    if (!existsSync(f)) throw new Error(`Missing expected build output: ${f}`)
  }
  console.log('[build] All workspace artifacts built cleanly.')
}

await main()

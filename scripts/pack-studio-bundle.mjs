/**
 * Build & pack `dsh-self-studio` into a 100% self-contained official `dsh@0.2.2-rc.5` bundle:
 * - Zero `workspace:*` dependencies in output `package.json`
 * - Declares `engines.dsh: ">=0.2.2-rc.1 <0.3.0"` & `engines.node: ">=24.9"`
 * - Zero OctoDeEpSeeK private APIs; preview/fetch/build run via bundled independent child workers
 * - Validates output manifest against official `@deepseek-ai/dsh-app-boot` `evaluatePluginCompatibility`
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { parseDocument } from 'yaml'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const studioSrcRoot = path.join(root, 'packages', 'dsh-self-studio')
const bundleOutDir = path.join(root, '.dev', 'studio-bundle', 'dsh-self-studio')

async function buildClientTool() {
  const toolOut = path.join(root, 'tools', 'dsh-client-build', 'dist', 'index.js')
  mkdirSync(path.dirname(toolOut), { recursive: true })
  await esbuild.build({
    entryPoints: [path.join(root, 'tools', 'dsh-client-build', 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: toolOut,
    external: ['esbuild'],
    logLevel: 'silent',
  })
  return await import(pathToFileURL(toolOut).href)
}

async function buildWorkspaceLibraries() {
  const libs = [
    { pkg: 'packages/product-spec', entries: ['index', 'schema', 'theme', 'identity', 'catalog-contract'] },
    { pkg: 'packages/catalog', entries: ['index'] },
    { pkg: 'packages/adapters', entries: ['index', 'bid-docx/index', 'design-canvas/index'] },
  ]
  for (const lib of libs) {
    for (const entry of lib.entries) {
      const entryPoint = path.join(root, lib.pkg, 'src', `${entry}.ts`)
      const outfile = path.join(root, lib.pkg, 'dist', `${entry}.js`)
      mkdirSync(path.dirname(outfile), { recursive: true })
      await esbuild.build({
        entryPoints: [entryPoint],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile,
        external: ['sharp', 'fflate', 'zod', 'yaml', 'semver', 'dompurify', 'ipaddr.js', '@dsh-self/*'],
        logLevel: 'silent',
      })
    }
  }
}

function createNpmTarball(srcDir, tgzPath) {
  const blocks = []
  const walk = (dir, relBase) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile()) {
        const content = readFileSync(full)
        const st = statSync(full)
        const tarName = `package/${rel}`
        if (Buffer.byteLength(tarName) > 100) {
          throw new Error(`Tar entry name exceeds 100 bytes: ${tarName}`)
        }
        const header = Buffer.alloc(512, 0)
        header.write(tarName, 0, 100, 'utf8')
        header.write('0000644\0', 100, 8, 'ascii')
        header.write('0000000\0', 108, 8, 'ascii')
        header.write('0000000\0', 116, 8, 'ascii')
        header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
        header.write(`${Math.floor(st.mtimeMs / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii')
        header.fill(0x20, 148, 156)
        header.write('0', 156, 1, 'ascii')
        header.write('ustar\0', 257, 6, 'ascii')
        header.write('00', 263, 2, 'ascii')
        let sum = 0
        for (let i = 0; i < 512; i++) sum += header[i]
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
        blocks.push(header)
        blocks.push(content)
        const rem = content.length % 512
        if (rem !== 0) blocks.push(Buffer.alloc(512 - rem, 0))
      }
    }
  }
  walk(srcDir, '')
  blocks.push(Buffer.alloc(1024, 0))
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 })
  writeFileSync(tgzPath, gz)
}

export async function packSelfContainedStudioBundle(outDir = bundleOutDir) {
  await buildWorkspaceLibraries()
  const clientBuilder = await buildClientTool()

  // 1. Build React 18 client bundle (`lib/client.js`)
  await clientBuilder.buildClientPackage(studioSrcRoot)

  // 2. Clean target standalone bundle dir
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(path.join(outDir, 'dist', 'workers'), { recursive: true })
  mkdirSync(path.join(outDir, 'lib'), { recursive: true })

  // 3. Bundle Host + independent child workers with ALL workspace/pure-JS deps inlined!
  // Only Node builtins & optional `sharp` / `@deepseek-ai/cordis` remain external.
  const hostTargets = [
    { in: 'src/host/index.ts', out: 'dist/index.js' },
    { in: 'src/workers/fetch-worker.ts', out: 'dist/workers/fetch-worker.js' },
    { in: 'src/workers/preview-worker.ts', out: 'dist/workers/preview-worker.js' },
  ]
  for (const t of hostTargets) {
    await esbuild.build({
      entryPoints: [path.join(studioSrcRoot, t.in)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      outfile: path.join(outDir, t.out),
      // Inline ALL internal packages + zod/yaml/semver/ipaddr.js/fflate; keep only optional sharp & cordis external
      external: ['sharp', '@deepseek-ai/cordis'],
      banner: {
        js: "import { createRequire as __dshSelfCreateRequire } from 'node:module'; const require = __dshSelfCreateRequire(import.meta.url);",
      },
      logLevel: 'silent',
    })
  }

  // Also copy built Host into packages/dsh-self-studio/dist for local dev
  cpSync(path.join(outDir, 'dist'), path.join(studioSrcRoot, 'dist'), { recursive: true })

  // 4. Copy client bundle, cordis.patch.yml, skills
  cpSync(path.join(studioSrcRoot, 'lib'), path.join(outDir, 'lib'), { recursive: true })
  cpSync(path.join(studioSrcRoot, 'cordis.patch.yml'), path.join(outDir, 'cordis.patch.yml'))
  cpSync(path.join(studioSrcRoot, 'skills'), path.join(outDir, 'skills'), { recursive: true })

  // 5. Verify cordis.patch.yml is plain YAML (zero !!js custom tags)
  const patchText = readFileSync(path.join(outDir, 'cordis.patch.yml'), 'utf8')
  const patchDoc = parseDocument(patchText, { schema: 'core', customTags: [] })
  if (patchDoc.errors.length > 0 || /!!js\b/.test(patchText)) {
    throw new Error('dsh-self-studio cordis.patch.yml must be plain YAML without !!js')
  }

  // 6. Emit clean standalone package.json (ZERO workspace:*, explicit engines.dsh!)
  const srcManifest = JSON.parse(readFileSync(path.join(studioSrcRoot, 'package.json'), 'utf8'))
  const standaloneManifest = {
    name: srcManifest.name,
    version: srcManifest.version,
    type: 'module',
    description: srcManifest.description,
    license: 'SEE LICENSE IN LICENSE',
    engines: srcManifest.engines,
    main: './dist/index.js',
    exports: srcManifest.exports,
    dsh: srcManifest.dsh,
    peerDependencies: srcManifest.peerDependencies,
    dependencies: {},
  }
  const manifestJson = `${JSON.stringify(standaloneManifest, undefined, 2)}\n`
  if (manifestJson.includes('workspace:')) {
    throw new Error('Standalone bundle package.json must not contain workspace:*')
  }
  writeFileSync(path.join(outDir, 'package.json'), manifestJson)

  // 7. Verify against official dsh evaluatePluginCompatibility if available locally
  const appBootPath =
    process.env.DSH_APP_BOOT_PATH ??
    path.resolve(root, '..', 'OctoDEepSeeK', 'apps', 'desktop', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
  if (existsSync(appBootPath)) {
    const boot = await import(pathToFileURL(appBootPath).href)
    const runtimeVersion = boot.getDshRuntimeVersion()
    for (const checkVer of [runtimeVersion, '0.2.2-rc.1']) {
      const compat = boot.evaluatePluginCompatibility(standaloneManifest, {}, checkVer)
      if (compat !== undefined) {
        throw new Error(`Official dsh@${checkVer} compatibility check failed: ${JSON.stringify(compat)}`)
      }
    }
    console.log(`[pack-studio-bundle] Verified against official dsh@${runtimeVersion} & dsh@0.2.2-rc.1: COMPATIBLE (0 unmet requirements)`)
  }

  // 8. Pack standard npm-installable tarball (`dsh-self-studio-<version>.tgz`)
  const tgzPath = path.join(path.dirname(outDir), `${standaloneManifest.name}-${standaloneManifest.version}.tgz`)
  createNpmTarball(outDir, tgzPath)

  console.log(`[pack-studio-bundle] Self-contained bundle ready at: ${outDir}`)
  console.log(`[pack-studio-bundle] Installable tarball ready at:   ${tgzPath}`)
  return { outDir, tgzPath, manifest: standaloneManifest }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await packSelfContainedStudioBundle()
}

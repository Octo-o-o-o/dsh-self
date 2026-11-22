import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import esbuild from 'esbuild'
import { PLATFORM_MODULES, wrapClientFactory } from './wrap.js'

interface PackageManifest {
  name?: string
  dsh?: {
    client?: {
      external?: unknown
    }
  }
}

export interface BuildClientResult {
  readonly entryOutfile: string
  readonly chunkOutfiles: readonly string[]
  readonly validatedExternals: readonly string[]
}

const CHUNK_ENTRY_RE = /^client\.([a-z0-9-]+)\.(?:ts|tsx)$/i

function clientEntry(packageDir: string): string {
  for (const name of ['src/client.tsx', 'src/client.ts']) {
    const candidate = path.join(packageDir, name)
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`no src/client.ts(x) entry in ${packageDir}`)
}

function discoverChunkEntries(packageDir: string): { readonly name: string; readonly source: string; readonly chunkFile: string }[] {
  const srcDir = path.join(packageDir, 'src')
  if (!existsSync(srcDir)) return []
  const chunks: { readonly name: string; readonly source: string; readonly chunkFile: string }[] = []
  for (const file of readdirSync(srcDir).sort()) {
    const match = CHUNK_ENTRY_RE.exec(file)
    if (match === null || match[1] === undefined) continue
    chunks.push({
      name: match[1],
      source: path.join(srcDir, file),
      chunkFile: `client.${match[1]}.js`,
    })
  }
  return chunks
}

/**
 * Validate `package.json#dsh.client.external` against PLATFORM_MODULES.
 * Any undeclared non-platform external would fail at browser load time in dsh@0.2.2-rc.5.
 */
export function validateClientExternals(manifest: PackageManifest, packageDir: string): readonly string[] {
  const raw = manifest.dsh?.client?.external
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${packageDir}: dsh.client.external must be an array of module specifiers`)
  }
  const allowed = new Set<string>(PLATFORM_MODULES)
  const unknown = raw.filter((mod) => !allowed.has(mod) && !mod.startsWith('@deepseek-ai/dsh-client-'))
  if (unknown.length > 0) {
    throw new Error(
      `${packageDir}: dsh.client.external contains modules unavailable in dsh platform preload: ${unknown.join(', ')}`,
    )
  }
  return raw
}

async function bundleSingleEntry(options: {
  readonly root: string
  readonly packageName: string
  readonly entryPoint: string
  readonly outfile: string
  readonly externals: readonly string[]
  readonly chunkName?: string
}): Promise<string> {
  const result = await esbuild.build({
    absWorkingDir: options.root,
    entryPoints: [options.entryPoint],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'automatic',
    write: false,
    outfile: options.outfile,
    external: [...options.externals],
    loader: {
      '.module.css': 'local-css',
      '.css': 'css',
    },
    logLevel: 'silent',
  })
  const javascript = result.outputFiles.find((file) => file.path.endsWith('.js'))
  if (javascript === undefined) {
    throw new Error(`esbuild produced no JavaScript for ${options.packageName} (${options.entryPoint})`)
  }
  const stylesheet = result.outputFiles.find((file) => file.path.endsWith('.css'))
  const stylesheets: Record<string, string> = {}
  const cssKey = options.chunkName ?? 'client.css'
  if (stylesheet !== undefined && stylesheet.text.trim().length > 0) {
    stylesheets[cssKey.replace(/\.js$/, '.css')] = stylesheet.text
  }
  mkdirSync(path.dirname(options.outfile), { recursive: true })
  writeFileSync(
    options.outfile,
    wrapClientFactory(options.packageName, javascript.text, stylesheets, options.chunkName),
  )
  return options.outfile
}

/**
 * Bundle one plugin's browser entry to `lib/client.js` and each `src/client.<name>.ts(x)`
 * to an independent self-contained chunk `lib/client.<name>.js` for `require.async`.
 */
export async function buildClientPackage(packageDir: string): Promise<BuildClientResult> {
  const root = path.resolve(packageDir)
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as PackageManifest
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error(`${root} package.json has no name`)
  }
  const validatedExternals = validateClientExternals(manifest, root)
  const chunks = discoverChunkEntries(root)
  const chunkSpecifiers = chunks.map((chunk) => `./${chunk.chunkFile}`)
  const baseExternals = [...new Set([...PLATFORM_MODULES, ...validatedExternals])]

  const entryOutfile = await bundleSingleEntry({
    root,
    packageName: manifest.name,
    entryPoint: clientEntry(root),
    outfile: path.join(root, 'lib', 'client.js'),
    externals: [...baseExternals, ...chunkSpecifiers],
  })

  const chunkOutfiles: string[] = []
  for (const chunk of chunks) {
    const out = await bundleSingleEntry({
      root,
      packageName: manifest.name,
      entryPoint: chunk.source,
      outfile: path.join(root, 'lib', chunk.chunkFile),
      externals: baseExternals,
      chunkName: chunk.chunkFile,
    })
    chunkOutfiles.push(out)
  }

  return { entryOutfile, chunkOutfiles, validatedExternals }
}

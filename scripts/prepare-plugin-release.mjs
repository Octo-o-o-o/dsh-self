#!/usr/bin/env node
/**
 * DSH Plugin Release Preparation & 10-Gate Verifier for `dsh-self-studio`.
 *
 * Usage:
 *   node scripts/prepare-plugin-release.mjs --pack
 *   node scripts/prepare-plugin-release.mjs --check
 *   node scripts/prepare-plugin-release.mjs --sync-dist <target-dir>
 *
 * Produces a 100% publish-ready standalone DSH plugin directory and npm tarball under
 * `.dev/plugin-release/`, plus `SHA256SUMS.txt` and `release-report.json`, verified
 * against official `dsh@0.2.2-rc.5` compatibility, Track A Creator Gate, lazy-CJS
 * client factory structure, host smoke loading, tarball hygiene, and custom index schema.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { parseDocument } from 'yaml'
import { packSelfContainedStudioBundle } from './pack-studio-bundle.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const studioSrcRoot = path.join(root, 'packages', 'dsh-self-studio')
const releaseRoot = path.join(root, '.dev', 'plugin-release')
const stagedPkgDir = path.join(releaseRoot, 'dsh-self-studio')
const marketIndexPath = path.join(root, 'website', 'src', 'dsh', 'index.json')
const appBootPath =
  process.env.DSH_APP_BOOT_PATH ??
  path.resolve(root, '..', 'OctoDEepSeeK', 'apps', 'desktop', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')

const OWNER = 'Octo-o-o-o'
const MONOREPO = 'dsh-self'
const DIST_REPO = 'dsh-self-studio'
const WEBSITE_URL = 'https://dsh-self.octoooo.com/'

const FORBIDDEN_PATTERNS = [
  { re: /(^|\/)\.env(\.|$)/i, reason: '.env*' },
  { re: /(^|\/)\.npmrc$/i, reason: '.npmrc' },
  { re: /\.(pem|key|p12|pfx)$/i, reason: '*.pem/*.key' },
  { re: /(^|\/)node_modules(\/|$)/i, reason: 'node_modules/' },
  { re: /(^|\/)\.git(\/|$)/i, reason: '.git/' },
  { re: /(^|\/)\.dev(\/|$)/i, reason: '.dev/' },
  { re: /(^|\/)src(\/|$)/i, reason: 'src/ (source files should not leak into bundle)' },
  { re: /\.test\.[cm]?[jt]sx?$/i, reason: 'test files' },
]

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function buildPublishManifest(srcManifest, { forDistRepo = false } = {}) {
  const repoObj = forDistRepo
    ? { type: 'git', url: `git+https://github.com/${OWNER}/${DIST_REPO}.git` }
    : { type: 'git', url: `git+https://github.com/${OWNER}/${MONOREPO}.git`, directory: 'packages/dsh-self-studio' }
  const bugsUrl = forDistRepo
    ? `https://github.com/${OWNER}/${DIST_REPO}/issues`
    : `https://github.com/${OWNER}/${MONOREPO}/issues`

  return {
    name: srcManifest.name,
    version: srcManifest.version,
    private: false,
    type: 'module',
    description:
      'DSH 插件（制作我的客户端）：在官方 dsh@0.2.2-rc.5 中将工作流打包为带独立图标、数据目录与锁定插件的专属桌面客户端。Self-contained dsh@0.2.2-rc.5 studio plugin for generating isolated standalone desktop clients.',
    icon: './icon.svg',
    keywords: [
      'deepseek-harness',
      'dsh',
      'dsh-plugin',
      'cordis',
      'desktop-client',
      'electron',
      'studio',
      'workbench',
    ],
    author: OWNER,
    license: 'SEE LICENSE IN LICENSE',
    homepage: WEBSITE_URL,
    repository: repoObj,
    bugs: { url: bugsUrl },
    publishConfig: { access: 'public' },
    engines: srcManifest.engines,
    main: './dist/index.js',
    exports: {
      '.': './dist/index.js',
      './client': './lib/client.js',
      './cordis.patch.yml': './cordis.patch.yml',
      './locale/*.json': './locale/*.json',
      './icon': './icon.svg',
      './package.json': './package.json',
    },
    files: [
      'dist',
      'lib',
      'locale/*.json',
      'skills',
      'icon.svg',
      'cordis.patch.yml',
      'README.md',
      'README.en.md',
      'LICENSE',
      'COMMERCIAL-LICENSE.md',
      'THIRD_PARTY_NOTICES.md',
    ],
    dsh: {
      manifestVersion: 1,
      ...srcManifest.dsh,
    },
    peerDependencies: srcManifest.peerDependencies,
    dependencies: {},
  }
}

function listTarEntries(tgzPath) {
  const tarBuf = gunzipSync(readFileSync(tgzPath))
  const entries = []
  let offset = 0
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefix ? `${prefix}/${rawName}` : rawName
    const sizeOctal = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0
    const typeFlag = String.fromCharCode(header[156])
    if (fullName && typeFlag !== 'x' && typeFlag !== 'g') {
      entries.push({ path: fullName.replace(/^package\//, ''), size })
    }
    const blocks = Math.ceil(size / 512)
    offset += 512 + blocks * 512
  }
  return entries
}

function runNpmPack(pkgDir, outDir) {
  const npmCliJs = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const useNodeCli = existsSync(npmCliJs)
  const cmd = useNodeCli ? process.execPath : (process.platform === 'win32' ? 'cmd.exe' : 'npm')
  const args = useNodeCli
    ? [npmCliJs, 'pack', '--json', '--pack-destination', outDir]
    : process.platform === 'win32'
      ? ['/d', '/s', '/c', `npm.cmd pack --json --pack-destination "${outDir}"`]
      : ['pack', '--json', '--pack-destination', outDir]
  const res = spawnSync(cmd, args, {
    cwd: pkgDir,
    shell: false,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (res.error) throw new Error(`npm pack failed to launch: ${res.error.message}`)
  if (res.status !== 0) {
    throw new Error(`npm pack exited ${res.status}:\n${(res.stderr || res.stdout || '').trim()}`)
  }
  const trimmed = (res.stdout || '').trim()
  const jsonStart = trimmed.indexOf('[')
  const jsonEnd = trimmed.lastIndexOf(']')
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error(`Unable to parse npm pack --json output:\n${trimmed}`)
  }
  const arr = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1))
  const item = arr[0]
  if (!item?.filename) throw new Error('npm pack --json missing filename')
  return {
    tgzPath: path.join(outDir, item.filename),
    filename: item.filename,
    size: item.size,
    unpackedSize: item.unpackedSize,
    entryCount: item.entryCount,
    integrity: item.integrity,
    shasum: item.shasum,
    files: item.files ?? [],
  }
}

function validateMarketIndex(indexPath) {
  if (!existsSync(indexPath)) {
    return { ok: false, detail: `Missing custom plugin index: ${path.relative(root, indexPath)}` }
  }
  const raw = JSON.parse(readFileSync(indexPath, 'utf8'))
  const issues = []
  if (raw.format !== 1) issues.push(`format must be 1 (got ${String(raw.format)})`)
  if (!raw.title || (typeof raw.title !== 'string' && typeof raw.title?.en !== 'string')) {
    issues.push('title must be string or LocalizedText with "en"')
  }
  if (!Array.isArray(raw.plugins) || raw.plugins.length === 0) {
    issues.push('plugins must be a non-empty array')
  } else {
    const names = new Set()
    for (const plugin of raw.plugins) {
      if (typeof plugin.name !== 'string' || !plugin.name) issues.push('plugin missing name')
      if (names.has(plugin.name)) issues.push(`duplicate plugin name: ${plugin.name}`)
      names.add(plugin.name)
      if (plugin.title && typeof plugin.title === 'object' && typeof plugin.title.en !== 'string') {
        issues.push(`${plugin.name}: LocalizedText title missing "en"`)
      }
      if (plugin.description && typeof plugin.description === 'object' && typeof plugin.description.en !== 'string') {
        issues.push(`${plugin.name}: LocalizedText description missing "en"`)
      }
      if (typeof plugin.icon === 'string' && !plugin.icon.startsWith('data:') && !/^https?:\/\//.test(plugin.icon)) {
        const relIcon = path.resolve(path.dirname(indexPath), plugin.icon)
        if (!existsSync(relIcon)) issues.push(`${plugin.name}: relative icon missing (${plugin.icon})`)
        else if (statSync(relIcon).size > 32 * 1024) issues.push(`${plugin.name}: icon exceeds 32 KiB`)
      }
      if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
        issues.push(`${plugin.name}: versions must be non-empty array`)
      } else {
        for (const v of plugin.versions) {
          if (typeof v.version !== 'string' || !/^\d+\.\d+\.\d+/.test(v.version)) {
            issues.push(`${plugin.name}: invalid semver ${String(v.version)}`)
          }
          if (!Number.isInteger(v.publishTimestamp) || v.publishTimestamp <= 0) {
            issues.push(`${plugin.name}@${v.version}: publishTimestamp must be positive unix seconds`)
          }
          if (!v.source || !['npm', 'git'].includes(v.source.type)) {
            issues.push(`${plugin.name}@${v.version}: source.type must be npm or git`)
          }
          if (v.source?.type === 'git') {
            if (!/^https:\/\//.test(v.source.url ?? '')) issues.push(`${plugin.name}@${v.version}: git url must be https`)
            if (!/^[a-f0-9]{40}$/i.test(v.source.commit ?? '')) issues.push(`${plugin.name}@${v.version}: git commit must be 40-char SHA`)
          }
        }
      }
    }
  }
  return {
    ok: issues.length === 0,
    detail: issues.length === 0 ? `Valid format:1 DSH custom index (${raw.plugins.length} plugins)` : issues.join('; '),
  }
}

async function stageReleaseBundle() {
  const { outDir } = await packSelfContainedStudioBundle()
  mkdirSync(releaseRoot, { recursive: true })
  rmSync(stagedPkgDir, { recursive: true, force: true })
  cpSync(outDir, stagedPkgDir, { recursive: true })

  // Copy publish assets: icon.svg, locale/, bilingual READMEs, LICENSE & licensing notices
  const requiredCopies = [
    [path.join(studioSrcRoot, 'icon.svg'), path.join(stagedPkgDir, 'icon.svg')],
    [path.join(studioSrcRoot, 'locale'), path.join(stagedPkgDir, 'locale')],
    [path.join(studioSrcRoot, 'README.md'), path.join(stagedPkgDir, 'README.md')],
    [path.join(studioSrcRoot, 'README.en.md'), path.join(stagedPkgDir, 'README.en.md')],
    [path.join(root, 'LICENSE'), path.join(stagedPkgDir, 'LICENSE')],
    [path.join(root, 'COMMERCIAL-LICENSE.md'), path.join(stagedPkgDir, 'COMMERCIAL-LICENSE.md')],
    [path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(stagedPkgDir, 'THIRD_PARTY_NOTICES.md')],
  ]
  for (const [src, dst] of requiredCopies) {
    if (!existsSync(src)) {
      throw new Error(`Missing required publish asset: ${path.relative(root, src)}`)
    }
    cpSync(src, dst, { recursive: true })
  }

  const srcManifest = JSON.parse(readFileSync(path.join(studioSrcRoot, 'package.json'), 'utf8'))
  const publishManifest = buildPublishManifest(srcManifest, { forDistRepo: false })
  writeFileSync(path.join(stagedPkgDir, 'package.json'), `${JSON.stringify(publishManifest, undefined, 2)}\n`)

  // Remove stale .tgz files before packing
  for (const name of readdirSync(releaseRoot)) {
    if (name.endsWith('.tgz')) rmSync(path.join(releaseRoot, name), { force: true })
  }
  const packInfo = runNpmPack(stagedPkgDir, releaseRoot)
  const tgzSha256 = sha256File(packInfo.tgzPath)
  writeFileSync(
    path.join(releaseRoot, 'SHA256SUMS.txt'),
    `${tgzSha256}  ${packInfo.filename}\n`,
  )
  return { publishManifest, packInfo, tgzSha256 }
}

async function runTenGates(pkgDir, tgzPath) {
  const checks = []
  const pushCheck = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail })

  const pkgPath = path.join(pkgDir, 'package.json')
  if (!existsSync(pkgPath)) {
    pushCheck('stage-exists', false, `Missing ${pkgPath}; run with --pack first`)
    return { passed: false, checks }
  }
  const pkgRaw = readFileSync(pkgPath, 'utf8')
  const pkg = JSON.parse(pkgRaw)

  // Gate 1: dsh-compat
  {
    const issues = []
    if (!pkg.engines?.dsh) issues.push('missing engines.dsh')
    if (!pkg.engines?.node) issues.push('missing engines.node')
    if (!pkg.peerDependencies?.['@deepseek-ai/cordis']) issues.push('missing @deepseek-ai/cordis peer')
    if (!pkg.peerDependencies?.react) issues.push('missing react peer')
    let runtimeDetail = 'manifest checks ok (official app-boot not present locally)'
    if (existsSync(appBootPath)) {
      const boot = await import(pathToFileURL(appBootPath).href)
      const rv = boot.getDshRuntimeVersion()
      for (const checkVer of [rv, '0.2.2-rc.1']) {
        const res = boot.evaluatePluginCompatibility(pkg, {}, checkVer)
        if (res !== undefined) issues.push(`evaluatePluginCompatibility(${checkVer}) failed: ${JSON.stringify(res)}`)
      }
      if (issues.length === 0) {
        runtimeDetail = `official dsh@${rv} & 0.2.2-rc.1 evaluatePluginCompatibility -> COMPATIBLE (0 unmet)`
      }
    }
    pushCheck('1. dsh-compat', issues.length === 0, issues.length === 0 ? runtimeDetail : issues.join('; '))
  }

  // Gate 2: track-a-creator-gate
  {
    const hostCode = existsSync(path.join(pkgDir, 'dist', 'index.js'))
      ? readFileSync(path.join(pkgDir, 'dist', 'index.js'), 'utf8')
      : ''
    const hasWorkspace = pkgRaw.includes('workspace:')
    const hasOctoPrivate = /OCTO_HOST|octo-desktop|registerHooks/.test(hostCode)
    const workersOk =
      existsSync(path.join(pkgDir, 'dist', 'workers', 'fetch-worker.js')) &&
      existsSync(path.join(pkgDir, 'dist', 'workers', 'preview-worker.js'))
    const ok = !hasWorkspace && !hasOctoPrivate && workersOk
    pushCheck(
      '2. track-a-creator-gate',
      ok,
      ok
        ? '0 workspace:*, 0 Octo private APIs, independent fetch/preview workers present'
        : `workspace=${hasWorkspace}, octoPrivate=${hasOctoPrivate}, workers=${workersOk}`,
    )
  }

  // Gate 3: cordis-patch-yaml
  {
    const patchRel = pkg.dsh?.bundle?.patch
    const patchPath = patchRel ? path.resolve(pkgDir, patchRel) : ''
    if (!patchPath || !existsSync(patchPath)) {
      pushCheck('3. cordis-patch-yaml', false, `Missing patch file: ${String(patchRel)}`)
    } else {
      const text = readFileSync(patchPath, 'utf8')
      const doc = parseDocument(text, { schema: 'core', customTags: [], maxAliasCount: 0 })
      const ok = doc.errors.length === 0 && !/!!js\b/.test(text)
      pushCheck('3. cordis-patch-yaml', ok, ok ? 'Plain YAML Core Schema, zero !!js tags' : doc.errors.map(String).join('; '))
    }
  }

  // Gate 4: client-bundle-factory
  {
    const clientPath = path.join(pkgDir, 'lib', 'client.js')
    if (!existsSync(clientPath)) {
      pushCheck('4. client-bundle-factory', false, 'Missing lib/client.js')
    } else {
      const src = readFileSync(clientPath, 'utf8')
      const reasons = []
      if (!src.includes('window.__ModuleLoader__.load')) reasons.push('missing window.__ModuleLoader__.load')
      if (!new RegExp(`id\\s*:\\s*["']${pkg.name}["']`).test(src)) reasons.push(`factory id !== ${pkg.name}`)
      if (!/(?:^|[^\w$])(?:var|let|const)\s+module\s*=/.test(src)) reasons.push('missing var module = { exports: {} } intro')
      if (/(?:from|require\s*\()\s*["']@dsh-self\//.test(src)) reasons.push('contains unresolved @dsh-self/* import')
      pushCheck(
        '4. client-bundle-factory',
        reasons.length === 0,
        reasons.length === 0 ? `Valid 3-part lazy-CJS factory (${(Buffer.byteLength(src) / 1024).toFixed(1)} KiB)` : reasons.join('; '),
      )
    }
  }

  // Gate 5: host-and-workers-syntax
  {
    const jsTargets = [
      'dist/index.js',
      'dist/workers/fetch-worker.js',
      'dist/workers/preview-worker.js',
    ]
    const failures = []
    for (const rel of jsTargets) {
      const abs = path.join(pkgDir, rel)
      if (!existsSync(abs)) {
        failures.push(`missing ${rel}`)
        continue
      }
      const check = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
      if (check.status !== 0) failures.push(`${rel}: ${(check.stderr || '').trim()}`)
      const content = readFileSync(abs, 'utf8')
      if (/(?:from|require\s*\()\s*["']@dsh-self\//.test(content)) {
        failures.push(`${rel} contains unresolved @dsh-self/* import`)
      }
    }
    pushCheck(
      '5. host-and-workers-syntax',
      failures.length === 0,
      failures.length === 0 ? 'node --check passed on host + 2 workers' : failures.join('; '),
    )
  }

  // Gate 6: manifest-publish-metadata
  {
    const issues = []
    if (pkg.private !== false) issues.push('private must be false')
    if (!pkg.icon) issues.push('missing icon')
    if (!pkg.license) issues.push('missing license')
    if (!pkg.homepage || !pkg.homepage.startsWith('https://')) issues.push('invalid homepage')
    if (!pkg.repository?.url) issues.push('missing repository.url')
    if (!pkg.bugs?.url) issues.push('missing bugs.url')
    if (!Array.isArray(pkg.files) || pkg.files.length === 0) issues.push('missing files whitelist')
    const kws = new Set(Array.isArray(pkg.keywords) ? pkg.keywords : [])
    for (const reqKw of ['deepseek-harness', 'dsh', 'dsh-plugin']) {
      if (!kws.has(reqKw)) issues.push(`missing keyword "${reqKw}"`)
    }
    for (const expKey of ['.', './client', './cordis.patch.yml', './locale/*.json', './icon', './package.json']) {
      if (!pkg.exports?.[expKey]) issues.push(`missing export "${expKey}"`)
    }
    if (pkg.dsh?.manifestVersion !== 1) issues.push('dsh.manifestVersion should be 1')
    pushCheck(
      '6. manifest-publish-metadata',
      issues.length === 0,
      issues.length === 0 ? `Complete publish metadata (${pkg.name}@${pkg.version})` : issues.join('; '),
    )
  }

  // Gate 7: assets-and-docs
  {
    const issues = []
    const iconFile = path.join(pkgDir, 'icon.svg')
    if (!existsSync(iconFile)) issues.push('missing icon.svg')
    else {
      const iconText = readFileSync(iconFile, 'utf8')
      const iconSize = statSync(iconFile).size
      if (!iconText.includes('<svg') || !iconText.includes('</svg>')) issues.push('invalid icon.svg')
      if (iconSize > 32 * 1024) issues.push(`icon.svg too large (${iconSize} bytes > 32 KiB)`)
    }
    for (const loc of ['locale/zh.json', 'locale/en.json']) {
      const abs = path.join(pkgDir, loc)
      if (!existsSync(abs)) issues.push(`missing ${loc}`)
      else {
        const parsed = JSON.parse(readFileSync(abs, 'utf8'))
        if (!parsed.meta?.title || !parsed.meta?.description) issues.push(`${loc} missing meta.title/description`)
      }
    }
    for (const rel of ['skills/client-maker/SKILL.md', 'README.md', 'README.en.md', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
      if (!existsSync(path.join(pkgDir, rel))) issues.push(`missing ${rel}`)
    }
    if (existsSync(path.join(pkgDir, 'LICENSE'))) {
      const licText = readFileSync(path.join(pkgDir, 'LICENSE'), 'utf8')
      if (!licText.includes('PolyForm Noncommercial License 1.0.0')) {
        issues.push('LICENSE missing PolyForm Noncommercial License 1.0.0')
      }
    }
    pushCheck(
      '7. assets-and-docs',
      issues.length === 0,
      issues.length === 0 ? 'icon.svg, locale/{zh,en}.json, SKILL.md, bilingual READMEs & dual-license notices verified' : issues.join('; '),
    )
  }

  // Gate 8: tarball-clean-audit
  {
    if (!tgzPath || !existsSync(tgzPath)) {
      pushCheck('8. tarball-clean-audit', false, 'Missing .tgz tarball')
    } else {
      const entries = listTarEntries(tgzPath)
      const violations = []
      for (const e of entries) {
        if (Buffer.byteLength(`package/${e.path}`) > 100) {
          violations.push(`path > 100 bytes: ${e.path}`)
        }
        for (const rule of FORBIDDEN_PATTERNS) {
          if (rule.re.test(e.path)) violations.push(`${e.path} (${rule.reason})`)
        }
      }
      const entryPaths = new Set(entries.map((e) => e.path))
      for (const mustHave of ['package.json', 'cordis.patch.yml', 'icon.svg', 'dist/index.js', 'lib/client.js', 'README.md', 'README.en.md', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
        if (!entryPaths.has(mustHave)) violations.push(`tarball missing ${mustHave}`)
      }
      pushCheck(
        '8. tarball-clean-audit',
        violations.length === 0,
        violations.length === 0
          ? `${entries.length} clean files in ${path.basename(tgzPath)} (${(statSync(tgzPath).size / 1024).toFixed(1)} KiB)`
          : violations.join('; '),
      )
    }
  }

  // Gate 9: host-apply-smoke
  {
    try {
      const modUrl = `${pathToFileURL(path.join(pkgDir, 'dist', 'index.js')).href}?t=${Date.now()}`
      const hostMod = await import(modUrl)
      const registeredPaths = []
      const disposers = []
      const mockCtx = {
        get(key) {
          if (key === 'connection') {
            return {
              fetch: {
                register(route) {
                  registeredPaths.push(route.path)
                  return async () => {}
                },
              },
            }
          }
          return undefined
        },
        effect(fn) {
          const cleanup = fn()
          if (typeof cleanup === 'function') disposers.push(cleanup)
        },
      }
      const issues = []
      if (hostMod.name !== 'dsh-self-studio') issues.push(`unexpected export name: ${String(hostMod.name)}`)
      if (!Array.isArray(hostMod.inject) || !hostMod.inject.includes('connection')) {
        issues.push(`inject must include 'connection' (got ${JSON.stringify(hostMod.inject)})`)
      }
      if (typeof hostMod.apply !== 'function') {
        issues.push('missing apply() export')
      } else {
        hostMod.apply(mockCtx)
        if (!registeredPaths.includes('/api/dshSelfStudio')) issues.push('did not register /api/dshSelfStudio')
        if (!registeredPaths.includes('/api/dsh-self-studio.export-spec')) issues.push('did not register export-spec')
        for (const d of disposers) d()
      }
      pushCheck(
        '9. host-apply-smoke',
        issues.length === 0,
        issues.length === 0 ? `Imported & registered ${registeredPaths.length} routes cleanly` : issues.join('; '),
      )
    } catch (error) {
      pushCheck('9. host-apply-smoke', false, error instanceof Error ? error.message : String(error))
    }
  }

  // Gate 10: market-index-valid
  {
    const res = validateMarketIndex(marketIndexPath)
    pushCheck('10. market-index-valid', res.ok, res.detail)
  }

  return { passed: checks.every((c) => c.ok), checks }
}

function syncDistRepo(destDir) {
  const absDest = path.resolve(root, destDir)
  if (!existsSync(stagedPkgDir)) {
    throw new Error('Staged plugin bundle not found; run with --pack first')
  }
  mkdirSync(absDest, { recursive: true })
  const managedEntries = [
    'dist',
    'lib',
    'locale',
    'skills',
    'icon.svg',
    'cordis.patch.yml',
    'README.md',
    'README.en.md',
    'LICENSE',
    'COMMERCIAL-LICENSE.md',
    'THIRD_PARTY_NOTICES.md',
    'package.json',
    'SYNC.md',
    '.gitignore',
  ]
  for (const name of managedEntries) {
    rmSync(path.join(absDest, name), { recursive: true, force: true })
  }
  for (const name of ['dist', 'lib', 'locale', 'skills', 'icon.svg', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(path.join(stagedPkgDir, name), path.join(absDest, name), { recursive: true })
  }
  const srcManifest = JSON.parse(readFileSync(path.join(studioSrcRoot, 'package.json'), 'utf8'))
  const distManifest = buildPublishManifest(srcManifest, { forDistRepo: true })
  writeFileSync(path.join(absDest, 'package.json'), `${JSON.stringify(distManifest, undefined, 2)}\n`)
  writeFileSync(path.join(absDest, '.gitignore'), 'node_modules/\n.DS_Store\n')
  writeFileSync(
    path.join(absDest, 'SYNC.md'),
    `# Generated DSH Plugin Distribution Repository\n\n` +
      `This repository is the public distribution of \`${distManifest.name}\` (\`${distManifest.version}\`).\n\n` +
      `- Source of truth: \`${OWNER}/${MONOREPO}\` (\`packages/dsh-self-studio\`)\n` +
      `- Website: ${WEBSITE_URL}\n` +
      `- Generated by: \`node scripts/prepare-plugin-release.mjs --sync-dist\`\n\n` +
      `Do not edit generated \`dist/\`, \`lib/\`, \`locale/\`, \`icon.svg\`, or \`package.json\` files directly here.\n`,
  )
  console.log(`[prepare-plugin-release] Synced standalone distribution repo to: ${absDest}`)
}

async function main() {
  const argv = process.argv.slice(2)
  const isCheckOnly = argv.includes('--check')
  const syncIdx = argv.indexOf('--sync-dist')
  const syncTarget = syncIdx >= 0 ? argv[syncIdx + 1] : null
  if (syncIdx >= 0 && !syncTarget) {
    throw new Error('--sync-dist requires a target directory path')
  }

  let packResult = null
  if (!isCheckOnly) {
    packResult = await stageReleaseBundle()
  }

  const srcManifest = JSON.parse(readFileSync(path.join(studioSrcRoot, 'package.json'), 'utf8'))
  const expectedTgz =
    packResult?.packInfo.tgzPath ??
    path.join(releaseRoot, `${srcManifest.name}-${srcManifest.version}.tgz`)

  const gateResult = await runTenGates(stagedPkgDir, expectedTgz)

  console.log('\n=== dsh-self-studio DSH Plugin Release Readiness (10 Gates) ===')
  for (const c of gateResult.checks) {
    console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.id}: ${c.detail}`)
  }

  const report = {
    plugin: srcManifest.name,
    version: srcManifest.version,
    checkedAt: new Date().toISOString(),
    passed: gateResult.passed,
    stagedDir: stagedPkgDir,
    tarball: existsSync(expectedTgz) ? expectedTgz : null,
    tarballSha256: existsSync(expectedTgz) ? sha256File(expectedTgz) : null,
    npmPack: packResult?.packInfo ?? null,
    checks: gateResult.checks,
  }
  mkdirSync(releaseRoot, { recursive: true })
  writeFileSync(path.join(releaseRoot, 'release-report.json'), `${JSON.stringify(report, undefined, 2)}\n`)

  if (!gateResult.passed) {
    console.error('\n[prepare-plugin-release] FAILED: one or more release gates did not pass.')
    process.exit(1)
  }

  if (syncTarget) {
    syncDistRepo(syncTarget)
  }

  console.log(`\n[prepare-plugin-release] ALL 10 GATES PASSED.`)
  console.log(`  Staged package : ${stagedPkgDir}`)
  console.log(`  Installable tgz: ${expectedTgz}`)
  console.log(`  SHA-256        : ${report.tarballSha256}`)
  console.log(`  Report         : ${path.join(releaseRoot, 'release-report.json')}`)
}

await main()

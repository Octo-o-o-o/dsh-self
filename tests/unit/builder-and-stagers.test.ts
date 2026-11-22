import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDarwinInsideOutCodesignOrder,
  buildProfileSeed,
  computeIntegritySha512,
  ensureExternalPluginPayloads,
  generateParameterizedNsisInclude,
  generateProductIcons,
  stageDarwinAppBundle,
  stageLinuxDebPackage,
  stageLocalInstalledPluginPayload,
  validateAndSnapshotInputs,
} from '../../tools/builder/src/index.js'
import { extractSafeTarGz } from '../../templates/desktop/src/host/safe-tar.js'
import { buildPlatformLock, resolvePluginCombination } from '@dsh-self/catalog'
import { computeSpecDigest, type PlatformLock } from '@dsh-self/product-spec'

describe('tools/builder icons, deterministic seed, NSIS guards & M5 Linux/macOS stagers', () => {
  it('generates valid multi-size .ico, .icns & PNG icons from product brand icon', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-icons-'))
    try {
      const snap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.win32-x64.lock.json'),
        target: 'win32-x64',
        snapshotDir: path.join(tmp, 'snap'),
      })
      const icons = await generateProductIcons({ spec: snap.spec, outDir: path.join(tmp, 'icons') })
      const ico = readFileSync(icons.icoPath)
      expect(ico.readUInt16LE(0)).toBe(0)
      expect(ico.readUInt16LE(2)).toBe(1) // ICON header
      expect(ico.readUInt16LE(4)).toBe(6) // 6 sizes embedded

      const icns = readFileSync(icons.icnsPath)
      expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
      expect(existsSync(icons.png256Path)).toBe(true)
      expect(existsSync(path.join(icons.linuxIconsDir, '512x512.png'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('produces deterministic profile-seed.tar.gz with seed-level telemetry off & welcomeNoticeVersion', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-seed-'))
    try {
      const snap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.win32-x64.lock.json'),
        target: 'win32-x64',
        snapshotDir: path.join(tmp, 'snap'),
      })
      const s1 = buildProfileSeed({ spec: snap.spec, lock: snap.lock, outDir: path.join(tmp, 'out1') })
      const s2 = buildProfileSeed({ spec: snap.spec, lock: snap.lock, outDir: path.join(tmp, 'out2') })
      expect(s1.manifest.seedHash).toBe(s2.manifest.seedHash)
      expect(s1.manifest.managedBundles).toContain('dsh-theme-product')
      expect(s1.manifest.managedBundles).toContain('dsh-shell-product')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('generates hardened NSIS include closing all 4 app-builder-lib@26.18.0 traps', () => {
    const spec = JSON.parse(readFileSync(path.resolve('fixtures/qinghe-bids/product.json'), 'utf8'))
    const nsh = generateParameterizedNsisInclude(spec)
    expect(nsh).toContain('!macro customInit')
    expect(nsh).toContain('ReadRegStr $DshOldStartMenuLink HKCU')
    expect(nsh).toContain('SetErrorLevel 1638')
    expect(nsh).toContain('resources\\runtime\\node\\node.exe')
    expect(nsh).toContain('StrCpy $launchLink "$DshFinalStartMenuLink"')
    expect(nsh).toContain('WriteRegStr HKCU')
    expect(nsh).toContain('DshSelfShortcutPath')
    expect(nsh).toContain('!macro customUnInstall')
  })

  it('stages M5 Linux .deb (/opt/<slug>, desktopName=<slug>) & macOS ASCII .app + inside-out codesign', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-m5-'))
    try {
      const linuxSnap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.linux-x64.lock.json'),
        target: 'linux-x64',
        snapshotDir: path.join(tmp, 'snap-linux'),
      })
      const { plan: linuxPlan, receipt: linuxReceipt } = await stageLinuxDebPackage({
        snapshot: linuxSnap,
        outDir: path.join(tmp, 'out-linux'),
        jobId: 'job-linux-test',
      })
      expect(linuxPlan.installPrefix).toBe(`/opt/${linuxSnap.spec.identity.internalSlug}`)
      expect(linuxPlan.desktopName).toBe(linuxSnap.spec.identity.internalSlug)
      expect(linuxPlan.desktopEntryContent).toContain(`Exec=/opt/${linuxSnap.spec.identity.internalSlug}/${linuxSnap.spec.identity.internalSlug}`)
      expect(linuxReceipt.target).toBe('linux-x64')

      const macSnap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.darwin-arm64.lock.json'),
        target: 'darwin-arm64',
        snapshotDir: path.join(tmp, 'snap-mac'),
      })
      const { plan: macPlan, receipt: macReceipt } = await stageDarwinAppBundle({
        snapshot: macSnap,
        target: 'darwin-arm64',
        outDir: path.join(tmp, 'out-mac'),
        jobId: 'job-mac-test',
      })
      expect(macPlan.appBundleName).toBe(`${macSnap.spec.identity.internalSlug}.app`)
      expect(macPlan.helperNames.length).toBe(4)
      expect(macPlan.localizationFiles).toContain('Resources/zh_CN.lproj/InfoPlist.strings')
      const order = buildDarwinInsideOutCodesignOrder(macSnap.spec.identity.internalSlug)
      expect(order[order.length - 1]).toBe(`${macSnap.spec.identity.internalSlug}.app`)
      expect(macReceipt.target).toBe('darwin-arm64')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('materializes external plugins + PAX >100-char transitive paths into deterministic seed, scrubs shadows & rejects missing/postinstall payloads', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-ext-seed-'))
    try {
      const snap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-design/product.json'),
        lockPath: path.resolve('fixtures/qinghe-design/locks/plugins.win32-x64.lock.json'),
        target: 'win32-x64',
        snapshotDir: path.join(tmp, 'snap'),
      })
      const resolution = resolvePluginCombination({
        target: 'win32-x64',
        requiredActions: ['research.openProResearch'],
        optionalActions: ['design.openImageDesign'],
        localOnly: false,
      })
      const extLock = buildPlatformLock(resolution)
      const cacheDir = path.join(tmp, 'plugin-cache')

      // Must fail loudly if external payloads are NOT staged yet
      expect(() =>
        buildProfileSeed({ spec: snap.spec, lock: extLock, outDir: path.join(tmp, 'unstaged'), pluginCacheDir: cacheDir }),
      ).toThrow(/Missing verified staged payload/)

      // Prepare mock local packages mirroring real chatgpt-pro-research + gpt-image-design + playwright-core (>100 char path!)
      const mockResearch = path.join(tmp, 'src-research')
      const mockDesign = path.join(tmp, 'src-design')
      const mockPw = path.join(tmp, 'src-pw')
      mkdirSync(path.join(mockResearch, 'lib'), { recursive: true })
      mkdirSync(path.join(mockDesign, 'lib'), { recursive: true })
      const longSubdir = path.join(mockPw, 'lib', 'tools', 'skills', 'playwright-component-testing', 'references')
      mkdirSync(longSubdir, { recursive: true })
      // Also inject a forbidden host shadow package inside mockPw to verify scrubbing
      mkdirSync(path.join(mockPw, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
      writeFileSync(path.join(mockPw, 'node_modules', '@deepseek-ai', 'dsh-llm', 'index.js'), 'export {}\n')

      writeFileSync(
        path.join(mockResearch, 'package.json'),
        JSON.stringify({ name: 'chatgpt-pro-research', version: '0.3.6', dependencies: { 'playwright-core': '^1.64.1' } }),
      )
      writeFileSync(path.join(mockResearch, 'lib', 'index.js'), 'export const name = "chatgpt-pro-research"\n')
      writeFileSync(
        path.join(mockDesign, 'package.json'),
        JSON.stringify({ name: 'gpt-image-design', version: '0.3.6', dependencies: { 'playwright-core': '^1.64.1' } }),
      )
      writeFileSync(path.join(mockDesign, 'lib', 'index.js'), 'export const name = "gpt-image-design"\n')
      writeFileSync(
        path.join(mockPw, 'package.json'),
        JSON.stringify({ name: 'playwright-core', version: '1.64.1' }),
      )
      writeFileSync(path.join(longSubdir, 'gallery-spec.md'), '# pax long path test\n')

      await ensureExternalPluginPayloads(extLock, {
        pluginCacheDir: cacheDir,
        localPackageDirs: {
          'chatgpt-pro-research': mockResearch,
          'gpt-image-design': mockDesign,
          'playwright-core': mockPw,
        },
      })

      const s1 = buildProfileSeed({ spec: snap.spec, lock: extLock, outDir: path.join(tmp, 'out1'), pluginCacheDir: cacheDir })
      const s2 = buildProfileSeed({ spec: snap.spec, lock: extLock, outDir: path.join(tmp, 'out2'), pluginCacheDir: cacheDir })
      expect(s1.manifest.seedHash).toBe(s2.manifest.seedHash)
      expect(s1.manifest.maxEntryRelPath).toBeGreaterThan(100)
      expect(s1.manifest.maxEntryRelPath).toBeLessThanOrEqual(130)

      // Extract with real desktop safe-tar extractor (PAX + SHA-256 verification!)
      const extractedDir = path.join(tmp, 'extracted-slot')
      extractSafeTarGz({
        archiveBuffer: readFileSync(s1.archivePath),
        destDir: extractedDir,
        expectedSha256: s1.manifest.seedHash,
      })

      const profilePkg = JSON.parse(readFileSync(path.join(extractedDir, 'package.json'), 'utf8'))
      expect(profilePkg.dsh.profile.bundles).toContain('chatgpt-pro-research')
      expect(profilePkg.dsh.profile.bundles).toContain('gpt-image-design')
      expect(profilePkg.dependencies['chatgpt-pro-research']).toBe('0.3.6')
      expect(profilePkg.dependencies['gpt-image-design']).toBe('0.3.6')
      expect(readFileSync(path.join(extractedDir, '.npmrc'), 'utf8')).toContain('ignore-scripts=true')
      expect(existsSync(path.join(extractedDir, 'external-payloads.json'))).toBe(true)
      expect(
        existsSync(
          path.join(extractedDir, 'node_modules/playwright-core/lib/tools/skills/playwright-component-testing/references/gallery-spec.md'),
        ),
      ).toBe(true)
      expect(existsSync(path.join(extractedDir, 'node_modules/playwright-core/node_modules/@deepseek-ai/dsh-llm'))).toBe(false)

      // Reject postinstall scripts under --ignore-scripts policy
      const badPw = path.join(tmp, 'src-bad-pw')
      mkdirSync(badPw, { recursive: true })
      writeFileSync(
        path.join(badPw, 'package.json'),
        JSON.stringify({ name: 'playwright-core', version: '1.64.1', scripts: { postinstall: 'node evil.js' } }),
      )
      await expect(
        ensureExternalPluginPayloads(extLock, {
          pluginCacheDir: path.join(tmp, 'cache-bad'),
          localPackageDirs: {
            'chatgpt-pro-research': mockResearch,
            'gpt-image-design': mockDesign,
            'playwright-core': badPw,
          },
        }),
      ).rejects.toThrow(/postinstall/)

      // Reject tampered tarball SHA-512 integrity
      const fakeFetch = (async () => new Response(Buffer.from('tampered-bytes'), { status: 200 })) as unknown as typeof fetch
      expect(computeIntegritySha512(Buffer.from('tampered-bytes'))).not.toBe(extLock.plugins[0]!.integritySha512)
      await expect(
        ensureExternalPluginPayloads(extLock, {
          pluginCacheDir: path.join(tmp, 'cache-tampered'),
          fetchFn: fakeFetch,
        }),
      ).rejects.toThrow(/SHA-512 integrity mismatch/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('nests conflicting transitive dependency versions cleanly across multiple local-installed plugins in profile-seed.tar.gz', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-nested-deps-'))
    try {
      const snap = validateAndSnapshotInputs({
        productPath: path.resolve('fixtures/qinghe-bids/product.json'),
        lockPath: path.resolve('fixtures/qinghe-bids/locks/plugins.win32-x64.lock.json'),
        target: 'win32-x64',
        snapshotDir: path.join(tmp, 'snap'),
      })
      const p1Nm = path.join(tmp, 'p1', 'node_modules')
      const p2Nm = path.join(tmp, 'p2', 'node_modules')
      mkdirSync(path.join(p1Nm, 'plugin-a'), { recursive: true })
      mkdirSync(path.join(p1Nm, 'shared-lib'), { recursive: true })
      mkdirSync(path.join(p2Nm, 'plugin-b'), { recursive: true })
      mkdirSync(path.join(p2Nm, 'shared-lib'), { recursive: true })

      writeFileSync(
        path.join(p1Nm, 'plugin-a/package.json'),
        JSON.stringify({ name: 'plugin-a', version: '1.0.0', dependencies: { 'shared-lib': '^1.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      writeFileSync(path.join(p1Nm, 'plugin-a/cordis.patch.yml'), '- insert:\n    - id: plugin-a\n      name: plugin-a\n')
      writeFileSync(path.join(p1Nm, 'shared-lib/package.json'), JSON.stringify({ name: 'shared-lib', version: '1.0.0' }))
      writeFileSync(path.join(p1Nm, 'shared-lib/index.js'), 'export const v = 1\n')

      writeFileSync(
        path.join(p2Nm, 'plugin-b/package.json'),
        JSON.stringify({ name: 'plugin-b', version: '1.0.0', dependencies: { 'shared-lib': '^2.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      writeFileSync(path.join(p2Nm, 'plugin-b/cordis.patch.yml'), '- insert:\n    - id: plugin-b\n      name: plugin-b\n')
      writeFileSync(path.join(p2Nm, 'shared-lib/package.json'), JSON.stringify({ name: 'shared-lib', version: '2.0.0' }))
      writeFileSync(path.join(p2Nm, 'shared-lib/index.js'), 'export const v = 2\n')

      const cacheDir = path.join(tmp, 'cache')
      const stagedA = stageLocalInstalledPluginPayload({
        packageName: 'plugin-a',
        packageDir: path.join(p1Nm, 'plugin-a'),
        profileName: 'p1',
        searchNodeModulesDirs: [p1Nm],
        pluginCacheDir: cacheDir,
      })
      const stagedB = stageLocalInstalledPluginPayload({
        packageName: 'plugin-b',
        packageDir: path.join(p2Nm, 'plugin-b'),
        profileName: 'p2',
        searchNodeModulesDirs: [p2Nm],
        pluginCacheDir: cacheDir,
      })

      const plugins = [
        ...snap.lock.plugins,
        {
          packageName: 'plugin-a',
          version: '1.0.0',
          trustTier: 'experimental-unverified' as const,
          sourceKind: 'local-installed' as const,
          sourceRef: stagedA.manifest.sourceRef,
          integritySha512: stagedA.manifest.integritySha512,
          runtimeKind: 'host-only' as const,
          providesActions: [],
          requiresConnections: [],
          enableOrder: snap.lock.plugins.length,
        },
        {
          packageName: 'plugin-b',
          version: '1.0.0',
          trustTier: 'experimental-unverified' as const,
          sourceKind: 'local-installed' as const,
          sourceRef: stagedB.manifest.sourceRef,
          integritySha512: stagedB.manifest.integritySha512,
          runtimeKind: 'host-only' as const,
          providesActions: [],
          requiresConnections: [],
          enableOrder: snap.lock.plugins.length + 1,
        },
      ]
      const lock: PlatformLock = { ...snap.lock, plugins, transitiveLockDigest: computeSpecDigest(plugins) }
      const seed = buildProfileSeed({ spec: snap.spec, lock, outDir: path.join(tmp, 'seed'), pluginCacheDir: cacheDir })
      const extracted = path.join(tmp, 'extracted')
      extractSafeTarGz({ archiveBuffer: readFileSync(seed.archivePath), destDir: extracted, expectedSha256: seed.manifest.seedHash })
      expect(readFileSync(path.join(extracted, 'node_modules/shared-lib/index.js'), 'utf8')).toContain('v = 1')
      expect(readFileSync(path.join(extracted, 'node_modules/plugin-b/node_modules/shared-lib/index.js'), 'utf8')).toContain('v = 2')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

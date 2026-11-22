import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  StudioService,
  checkIpSafety,
  safeFetchReferenceUrl,
} from '../../packages/dsh-self-studio/src/host/index.js'
import { desktopCapabilities } from '@dsh-self/product-spec'
import { detectHostPlatformTarget } from '../../packages/dsh-self-studio/src/host/studio-service.js'
import { verifyTrackAOfficialStudioBundle } from '../../tools/builder/src/creator-gate.js'
import {
  buildProfileSeed,
  ensureExternalPluginPayloads,
  stagedPayloadDirFor,
} from '../../tools/builder/src/index.js'
import { extractSafeTarGz } from '../../templates/desktop/src/host/safe-tar.js'

describe('dsh-self-studio SSRF defense, 6-step workflow, release management & Track A bundle gate', () => {
  it('blocks loopback, RFC1918, link-local metadata, CGNAT, NAT64, non-80/443 ports & non-http protocols', async () => {
    expect(checkIpSafety('127.0.0.1').allowed).toBe(false)
    expect(checkIpSafety('10.0.0.1').allowed).toBe(false)
    expect(checkIpSafety('169.254.169.254').allowed).toBe(false)
    expect(checkIpSafety('100.100.100.200').allowed).toBe(false)
    expect(checkIpSafety('::1').allowed).toBe(false)
    expect(checkIpSafety('::ffff:127.0.0.1').allowed).toBe(false)
    expect(checkIpSafety('64:ff9b::127.0.0.1').allowed).toBe(false)
    expect(checkIpSafety('93.184.216.34').allowed).toBe(true)

    await expect(safeFetchReferenceUrl('http://127.0.0.1:14567/')).rejects.toThrow(/port|loopback|blocked|private/i)
    await expect(safeFetchReferenceUrl('file:///C:/Windows/win.ini')).rejects.toThrow(/protocol|http/i)
    await expect(safeFetchReferenceUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked|private|link-local/i)
  })

  it('executes full 6-step StudioService lifecycle including expandBrief, blueprints, NL refinement & release versioning', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-studio-unit-'))
    const workerDir = path.resolve('.dev/studio-bundle/dsh-self-studio/dist/workers')
    const svc = new StudioService({ dataDir: tmp, workerDir })
    try {
      // Step 1: Expand short brief
      const draft = await svc.expandBriefWithModel('帮我做一个青禾投标客户端，导入招标 DOCX 导出响应表')
      expect(draft.expandedPrompt.length).toBeGreaterThan(30)
      expect(draft.suggestedNameZh).toContain('青禾投标')

      // Step 2: Generate 3 blueprints
      const { blueprints } = svc.generateBlueprintOptions({ prompt: draft.expandedPrompt })
      expect(blueprints.length).toBe(3)
      expect(blueprints.map((b) => b.id)).toEqual(['lite', 'standard', 'pro'])

      // Step 2 -> 3: Create project from chosen blueprint
      const created = await svc.createOrSaveBrief({
        prompt: draft.expandedPrompt,
        target: 'win32-x64',
        blueprintOverride: blueprints[1],
      })
      expect(created.spec.revision).toBe(1)
      expect(created.spec.brand.iconDataUrl).toContain('data:image/svg+xml;base64,')

      // Step 4: Manual add/remove module + brand icon preset change
      const withAdded = svc.updateProjectSpec({
        projectId: created.projectId,
        expectedRevision: 1,
        sections: [...created.spec.home.sections, 'recent-sessions'],
        iconPreset: 'workbench-grid',
      })
      expect(withAdded.spec.home.sections).toContain('recent-sessions')
      expect(withAdded.spec.brand.iconPreset).toBe('workbench-grid')

      // Step 5: Preview worker serves HTML and allows official dsh Desktop (`dsh-app:`) framing
      const preview = await svc.startOrRefreshPreview(created.projectId, 'win32-x64')
      expect(preview.running).toBe(true)
      const previewRes = await fetch(preview.url)
      expect(previewRes.status).toBe(200)
      const csp = previewRes.headers.get('content-security-policy') ?? ''
      expect(csp).toContain('frame-ancestors')
      expect(csp).toContain("'self'")
      expect(csp).toContain('dsh-app:')
      expect(csp).toContain('http://127.0.0.1:*')
      expect(csp).toContain('http://localhost:*')
      const previewHtml = await previewRes.text()
      expect(previewHtml).toContain('青禾投标')
      expect(svc.getPreviewState(created.projectId)?.running).toBe(true)

      // Step 5: Natural-language continuous refinement
      const refined = await svc.refineByInstruction(created.projectId, '改名叫「星辰投标」并把主题改成深海蓝')
      expect(refined.changed).toBe(true)
      expect(refined.project.spec.brand.displayName.zh).toBe('星辰投标')
      expect(refined.project.spec.theme.seeds.light.accent).toBe('#2563eb')
      const refreshedRes = await fetch(preview.url)
      expect(await refreshedRes.text()).toContain('星辰投标')
      await svc.stopPreview(created.projectId)
      expect(svc.getPreviewState(created.projectId)).toBeNull()

      // Step 6: Multi-target build + persisted release version management
      const native = detectHostPlatformTarget()
      const other = native === 'darwin-arm64' ? 'win32-x64' : 'darwin-arm64'
      const multi = svc.startMultiTargetBuild({
        projectId: created.projectId,
        targets: [native, other],
        crossPlatformStrategy: 'github-actions',
        appVersion: '0.1.1',
        releaseNotes: '首个多平台内测',
      })
      expect(multi.jobs.length).toBe(2)
      expect(multi.jobs[0]).toMatchObject({ target: native, status: 'failed' })
      expect(multi.project.releases).toHaveLength(1)
      expect(svc.startBuildJob(created.projectId, native).jobId).not.toBe(multi.jobs[0]!.jobId)
      expect(multi.project.releases?.some((r) => r.target === other && r.strategy === 'github-actions')).toBe(true)

      // Restore & delete release
      const relId = multi.project.releases![0]!.releaseId
      const afterDel = svc.deleteRelease(created.projectId, relId)
      expect(afterDel.releases).toHaveLength(0)

      // Delete project
      await svc.deleteProject(created.projectId)
      expect(svc.listProjects().length).toBe(0)
    } finally {
      await svc.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('propagates ELECTRON_RUN_AS_NODE=1 for child workers when hosted under Electron Desktop', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-worker-rt-'))
    const prevRunAsNode = process.env.ELECTRON_RUN_AS_NODE
    try {
      process.env.ELECTRON_RUN_AS_NODE = '1'
      const svcDefault = new StudioService({ dataDir: tmp, workerDir: tmp })
      const rtElectron = svcDefault.resolveWorkerNodeRuntime()
      expect(rtElectron.execPath).toBe(process.execPath)
      expect(rtElectron.runAsNodeEnv.ELECTRON_RUN_AS_NODE).toBe('1')

      // Explicit real nodePath overrides Electron executable without setting ELECTRON_RUN_AS_NODE
      const svcExplicit = new StudioService({ dataDir: tmp, workerDir: tmp, nodePath: process.execPath })
      expect(svcExplicit.resolveWorkerNodeRuntime().execPath).toBe(process.execPath)
    } finally {
      if (prevRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = prevRunAsNode
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('passes Track A Creator Gate for the self-contained official dsh studio bundle', () => {
    const bundleDir = path.resolve('.dev/studio-bundle/dsh-self-studio')
    const gate = verifyTrackAOfficialStudioBundle(bundleDir)
    expect(gate.passed).toBe(true)
    for (const check of gate.checks) {
      expect(check.ok, `Check "${check.name}" failed: ${check.detail}`).toBe(true)
    }
  })

  it('plans deliverable Pro Research & AI Image Design Studio projects with zero unavailable packages', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-pro-studio-'))
    const svc = new StudioService({ dataDir: tmp, workerDir: tmp })
    try {
      const researchBlueprints = svc.generateBlueprintOptions({
        prompt: '帮我做一个深度调研工作台，使用 ChatGPT 做多轮竞品调研与技术选型',
      })
      expect(researchBlueprints.blueprints.length).toBe(3)
      const proResearchRec = await svc.createOrSaveBrief({
        prompt: '帮我做一个深度调研工作台，使用 ChatGPT 做多轮竞品调研与技术选型',
        target: 'win32-x64',
        blueprintOverride: researchBlueprints.blueprints[2],
      })
      const researchCaps = desktopCapabilities(proResearchRec.spec, proResearchRec.locks['win32-x64']!)
      expect(researchCaps.missing).toEqual([])
      expect(researchCaps.unavailablePackages).toEqual([])
      expect(researchCaps.actions).toContain('research.openProResearch')
      expect(researchCaps.actions).toContain('design.openImageDesign')

      const aiDesignBlueprints = svc.generateBlueprintOptions({
        prompt: '做一个支持 AI 生图出 HTML demo 和三栏画布批注的设计工作台',
      })
      const aiDesignRec = await svc.createOrSaveBrief({
        prompt: '做一个支持 AI 生图出 HTML demo 和三栏画布批注的设计工作台',
        target: 'win32-x64',
        blueprintOverride: aiDesignBlueprints.blueprints[1],
      })
      const designCaps = desktopCapabilities(aiDesignRec.spec, aiDesignRec.locks['win32-x64']!)
      expect(designCaps.missing).toEqual([])
      expect(designCaps.unavailablePackages).toEqual([])
      expect(designCaps.actions).toContain('design.openImageDesign')
      expect(designCaps.actions).toContain('design.exportAnnotatedPng')
    } finally {
      await svc.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('supports composite custom templates selecting all 5 deliverable plugins and fixes localOnly when adding external capabilities in Step 3', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-custom-tpl-'))
    const svc = new StudioService({ dataDir: tmp, workerDir: tmp, pluginCacheDir: path.join(tmp, 'cache') })
    try {
      // 1. Multi-domain composite custom prompt must NOT drop secondary domains
      const comboPrompt = '做一个全能自定义工作台：既处理招标 DOCX 导出响应表，又支持三栏图片批注导出 PNG、AI 生图出 HTML Demo 和 ChatGPT Pro 多轮竞品调研'
      const { blueprints } = svc.generateBlueprintOptions({ prompt: comboPrompt })
      expect(blueprints.length).toBe(3)
      const allInOne = await svc.createOrSaveBrief({
        prompt: comboPrompt,
        target: 'win32-x64',
        blueprintOverride: blueprints[2], // Pro all-in-one deliverable workbench
      })
      const allLock = allInOne.locks['win32-x64']!
      expect(allLock.plugins.map((p) => p.packageName).sort()).toEqual([
        '@dsh-self/adapter-bid-docx',
        '@dsh-self/adapter-design-canvas',
        '@dsh-self/adapter-local-calendar',
        'chatgpt-pro-research',
        'gpt-image-design',
      ])
      const allCaps = desktopCapabilities(allInOne.spec, allLock)
      expect(allCaps.missing).toEqual([])
      expect(allCaps.unavailablePackages).toEqual([])

      // 2. Starting from an offline-only Bid template, adding external capabilities in Step 3 flips localOnly and locks them!
      const bidOnly = await svc.createOrSaveBrief({
        prompt: '处理已有招标 DOCX 并导出响应表',
        target: 'win32-x64',
      })
      expect(bidOnly.spec.shell.localOnlyToolWebDisabled).toBe(true)
      const expanded = svc.updateProjectSpec({
        projectId: bidOnly.projectId,
        expectedRevision: bidOnly.spec.revision,
        target: 'win32-x64',
        optionalActions: [...bidOnly.spec.optionalActions, 'design.openImageDesign', 'research.openProResearch'],
        summary: '自定义模板追加 AI 生图与多轮调研',
      })
      expect(expanded.spec.shell.localOnlyToolWebDisabled).toBe(false)
      expect(expanded.brief.localOnly).toBe(false)
      const expLock = expanded.locks['win32-x64']!
      expect(expLock.plugins.some((p) => p.packageName === 'gpt-image-design')).toBe(true)
      expect(expLock.plugins.some((p) => p.packageName === 'chatgpt-pro-research')).toBe(true)
      expect(desktopCapabilities(expanded.spec, expLock).unavailablePackages).toEqual([])

      // 3. Step 5 natural-language refinement can also toggle AI image design & Pro research
      const refined = await svc.refineByInstruction(bidOnly.projectId, '去掉 AI 生图')
      expect(refined.changed).toBe(true)
      expect(refined.project.spec.optionalActions).not.toContain('design.openImageDesign')
    } finally {
      await svc.dispose()
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('discovers installed local DSH plugins, enforces safety gates, stages SHA-512 payloads, packs seeds & replaces unavailable catalog placeholders', async () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-local-extra-'))
    const fakeDshHome = path.join(tmp, 'dsh-home')
    const profileNm = path.join(fakeDshHome, 'profiles', 'web', 'node_modules')
    const cacheDir = path.join(tmp, 'plugin-cache')
    const prevDshHome = process.env.DSH_HOME

    try {
      // Create isolated fake DSH_HOME with: valid custom plugin + dep + shadow, evil !!js plugin, local kanban, studio/host internals
      const customPkgDir = path.join(profileNm, 'my-custom-dsh-plugin')
      const depDir = path.join(profileNm, 'my-helper-dep')
      const shadowDir = path.join(depDir, 'node_modules', '@deepseek-ai', 'dsh-llm')
      const evilPkgDir = path.join(profileNm, 'evil-js-plugin')
      const kanbanDir = path.join(profileNm, '@alpacachen', 'dsh-kanban')
      const studioDir = path.join(profileNm, 'dsh-self-studio')
      const hostBaseDir = path.join(profileNm, '@deepseek-ai', 'dsh-base')
      for (const d of [customPkgDir, depDir, shadowDir, evilPkgDir, kanbanDir, studioDir, hostBaseDir]) {
        mkdirSync(d, { recursive: true })
      }

      writeFileSync(
        path.join(customPkgDir, 'package.json'),
        JSON.stringify({
          name: 'my-custom-dsh-plugin',
          version: '1.2.3',
          description: '自定义本机业务插件',
          main: './index.js',
          engines: { dsh: '>=0.2.2-rc.1 <0.3.0' },
          dependencies: { 'my-helper-dep': '^2.0.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
        }),
      )
      writeFileSync(path.join(customPkgDir, 'cordis.patch.yml'), '- insert:\n    - id: my-custom-plugin\n      name: my-custom-dsh-plugin\n')
      writeFileSync(path.join(customPkgDir, 'index.js'), 'export const name = "my-custom-dsh-plugin"\n')

      writeFileSync(path.join(depDir, 'package.json'), JSON.stringify({ name: 'my-helper-dep', version: '2.0.1' }))
      writeFileSync(path.join(depDir, 'index.js'), 'export const helper = true\n')
      writeFileSync(path.join(shadowDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.2.2-rc.5' }))

      writeFileSync(
        path.join(evilPkgDir, 'package.json'),
        JSON.stringify({
          name: 'evil-js-plugin',
          version: '0.1.0',
          engines: { dsh: '>=0.2.2-rc.1 <0.3.0' },
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
      )
      writeFileSync(path.join(evilPkgDir, 'cordis.patch.yml'), '- id: evil\n  fn: !!js/function "() => 1"\n')

      writeFileSync(
        path.join(kanbanDir, 'package.json'),
        JSON.stringify({
          name: '@alpacachen/dsh-kanban',
          version: '1.13.1',
          main: './index.js',
          engines: { dsh: '0.2.2-rc.5' },
          dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
        }),
      )
      writeFileSync(path.join(kanbanDir, 'cordis.patch.yml'), '- insert:\n    - id: kanban\n      name: "@alpacachen/dsh-kanban"\n')
      writeFileSync(path.join(kanbanDir, 'index.js'), 'export const name = "kanban"\n')

      writeFileSync(
        path.join(studioDir, 'package.json'),
        JSON.stringify({ name: 'dsh-self-studio', version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )
      writeFileSync(
        path.join(hostBaseDir, 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-rc.5', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
      )

      process.env.DSH_HOME = fakeDshHome
      const svc = new StudioService({ dataDir: path.join(tmp, 'data'), workerDir: path.join(tmp, 'data'), pluginCacheDir: cacheDir })
      try {
        const env = svc.getEnvironmentInfo()
        expect(env.catalogCapabilities.filter((c) => c.deliverable).length).toBe(5)
        expect(env.installedPlugins['my-custom-dsh-plugin']?.selectableAsExtra).toBe(true)
        expect(env.installedPlugins['my-custom-dsh-plugin']?.compatibility).toBe('compatible')
        expect(JSON.stringify(env.installedPlugins)).not.toContain(tmp) // Zero host path leakage
        expect(env.installedPlugins['evil-js-plugin']?.selectableAsExtra).toBe(false)
        expect(env.installedPlugins['evil-js-plugin']?.usesJsYamlTag).toBe(true)
        expect(env.installedPlugins['dsh-self-studio']?.selectableAsExtra).toBe(false)
        expect(env.installedPlugins['@deepseek-ai/dsh-base']?.selectableAsExtra).toBe(false)

        // Create Bid Pro project (has unavailable kanban + scratchpad)
        const { blueprints } = svc.generateBlueprintOptions({ prompt: '处理已有招标 DOCX 并导出响应表' })
        const proBid = await svc.createOrSaveBrief({
          prompt: '处理已有招标 DOCX 并导出响应表',
          target: 'win32-x64',
          blueprintOverride: blueprints[2],
        })
        expect(desktopCapabilities(proBid.spec, proBid.locks['win32-x64']!).unavailablePackages).toContain('@alpacachen/dsh-kanban')

        // Reject evil !!js plugin if forced
        expect(() =>
          svc.updateProjectSpec({
            projectId: proBid.projectId,
            expectedRevision: proBid.spec.revision,
            target: 'win32-x64',
            extraInstalledPlugins: ['evil-js-plugin'],
          }),
        ).toThrow(/无法手动加入打包|!!js/)

        // Attach BOTH my-custom-dsh-plugin AND local @alpacachen/dsh-kanban (and drop unavailable scratchpad)
        const withExtras = svc.updateProjectSpec({
          projectId: proBid.projectId,
          expectedRevision: proBid.spec.revision,
          target: 'win32-x64',
          optionalActions: ['calendar.addDeadline', 'tasks.openKanban'],
          extraInstalledPlugins: ['my-custom-dsh-plugin', '@alpacachen/dsh-kanban'],
        })
        const lock = withExtras.locks['win32-x64']!
        // Kanban must be replaced in-place (zero duplicates!) and become deliverable
        expect(lock.plugins.filter((p) => p.packageName === '@alpacachen/dsh-kanban')).toHaveLength(1)
        expect(lock.plugins.find((p) => p.packageName === '@alpacachen/dsh-kanban')?.sourceKind).toBe('local-installed')
        expect(lock.plugins.find((p) => p.packageName === 'my-custom-dsh-plugin')?.sourceKind).toBe('local-installed')
        expect(lock.plugins.find((p) => p.packageName === 'my-custom-dsh-plugin')?.sourceRef).toBe('local-dsh:web/my-custom-dsh-plugin@1.2.3')
        expect(JSON.stringify(lock)).not.toContain(tmp) // Zero host absolute paths in lockfile

        const caps = desktopCapabilities(withExtras.spec, lock)
        expect(caps.missing).toEqual([])
        expect(caps.unavailablePackages).toEqual([])
        expect(caps.actions).toContain('tasks.openKanban')
        expect(caps.extraInstalledPackages).toEqual(['@alpacachen/dsh-kanban', 'my-custom-dsh-plugin'])

        // Verify ensureExternalPluginPayloads + deterministic buildProfileSeed + safe extraction + shadow scrubbing
        await ensureExternalPluginPayloads(lock, { pluginCacheDir: cacheDir })
        const seed1 = buildProfileSeed({ spec: withExtras.spec, lock, outDir: path.join(tmp, 'seed1'), pluginCacheDir: cacheDir })
        const seed2 = buildProfileSeed({ spec: withExtras.spec, lock, outDir: path.join(tmp, 'seed2'), pluginCacheDir: cacheDir })
        expect(seed1.manifest.seedHash).toBe(seed2.manifest.seedHash)

        const extracted = path.join(tmp, 'extracted')
        extractSafeTarGz({ archiveBuffer: readFileSync(seed1.archivePath), destDir: extracted, expectedSha256: seed1.manifest.seedHash })
        const seedPkg = JSON.parse(readFileSync(path.join(extracted, 'package.json'), 'utf8'))
        expect(seedPkg.dsh.profile.bundles).toContain('my-custom-dsh-plugin')
        expect(seedPkg.dsh.profile.bundles).toContain('@alpacachen/dsh-kanban')
        expect(existsSync(path.join(extracted, 'node_modules/my-custom-dsh-plugin/index.js'))).toBe(true)
        expect(existsSync(path.join(extracted, 'node_modules/my-helper-dep/index.js'))).toBe(true)
        expect(existsSync(path.join(extracted, 'node_modules/my-helper-dep/node_modules/@deepseek-ai/dsh-llm'))).toBe(false)

        // Tampering staged payload MUST fail SHA-512 verification loudly
        const customLocked = lock.plugins.find((p) => p.packageName === 'my-custom-dsh-plugin')!
        const customStageDir = stagedPayloadDirFor(customLocked, cacheDir)
        writeFileSync(path.join(customStageDir, 'node_modules/my-custom-dsh-plugin/index.js'), 'export const hacked = true\n')
        await expect(ensureExternalPluginPayloads(lock, { pluginCacheDir: cacheDir })).rejects.toThrow(/Missing or tampered/)
      } finally {
        await svc.dispose()
      }
    } finally {
      if (prevDshHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevDshHome
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

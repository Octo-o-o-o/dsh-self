import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  StudioService,
  checkIpSafety,
  safeFetchReferenceUrl,
} from '../../packages/dsh-self-studio/src/host/index.js'
import { verifyTrackAOfficialStudioBundle } from '../../tools/builder/src/creator-gate.js'

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

      // Step 5: Natural-language continuous refinement
      const refined = await svc.refineByInstruction(created.projectId, '改名叫「星辰投标」并把主题改成深海蓝')
      expect(refined.changed).toBe(true)
      expect(refined.project.spec.brand.displayName.zh).toBe('星辰投标')
      expect(refined.project.spec.theme.seeds.light.accent).toBe('#2563eb')

      // Step 6: Multi-target build + persisted release version management
      const multi = svc.startMultiTargetBuild({
        projectId: created.projectId,
        targets: ['win32-x64', 'darwin-arm64'],
        crossPlatformStrategy: 'github-actions',
        appVersion: '0.1.1',
        releaseNotes: '首个多平台内测',
      })
      expect(multi.jobs.length).toBe(2)
      expect(multi.project.releases?.length).toBe(2)
      expect(multi.project.releases?.some((r) => r.target === 'darwin-arm64' && r.strategy === 'github-actions')).toBe(true)

      // Restore & delete release
      const relId = multi.project.releases![0]!.releaseId
      const afterDel = svc.deleteRelease(created.projectId, relId)
      expect(afterDel.releases?.length).toBe(1)

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
})

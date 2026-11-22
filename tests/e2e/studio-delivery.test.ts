import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StudioService, detectHostPlatformTarget } from '../../packages/dsh-self-studio/src/host/studio-service.js'
import { verifyWindowsInstaller } from '../../packages/dsh-self-studio/src/host/verify-installer.js'
import { computeSpecDigest, desktopCapabilities, PINNED_TEMPLATE_COMMIT } from '../../packages/product-spec/src/index.js'
import { buildProfileSeed } from '../../tools/builder/src/seed-builder.js'

const bidPrompt = '导入已有招标 DOCX，检查评分和截止日，导出投标响应表'
let dir: string
let studio: StudioService
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'studio-delivery-'))
  studio = new StudioService({ dataDir: dir, workerDir: dir })
})
afterEach(async () => {
  await studio.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('Studio project to desktop delivery', () => {
  it('distinguishes supported work, unavailable external search and unmatched requests', async () => {
    for (const prompt of ['管理仓库库存，每日盘点', '律师工作台，标注合同里的风险条款']) {
      await expect(studio.suggestBlueprints({ prompt })).rejects.toThrow(/没有匹配/)
    }
    const prompt = '查公开标讯并处理招标 DOCX'
    const { blueprints } = await studio.suggestBlueprints({ prompt })
    for (const choice of blueprints) expect(choice.requiredActions).toContain('tender.searchNotices')
    const rec = await studio.createOrSaveBrief({ prompt, blueprintOverride: blueprints[1], target: 'win32-x64' })
    expect(rec.spec.shell.localOnlyToolWebDisabled).toBe(false)
    expect(desktopCapabilities(rec.spec, rec.locks['win32-x64']!).missing).toContain('tender.searchNotices')
  })

  it('keeps original artwork, uses decoded reference colors and preserves assets on ordinary edits', async () => {
    const fromColor = (background: string) => sharp({ create: { width: 32, height: 32, channels: 3, background } }).png().toBuffer()
    const [red, blue] = await Promise.all([fromColor('#ba2424'), fromColor('#1348ba')])
    const suggest = (img: Buffer) => studio.suggestBlueprints({ prompt: bidPrompt, referenceImageBase64: img.toString('base64') })
    const [a, b] = await Promise.all([suggest(red), suggest(blue)])
    expect(a.blueprints[1]!.accentHex).not.toEqual(b.blueprints[1]!.accentHex)
    const webpageMeta = { title: '参考工作台', headings: ['截止日期', '待办资料'], themeColorHex: '#087ba1' }
    const byPage = await studio.suggestBlueprints({ prompt: bidPrompt, webpageMeta })
    const withPage = await studio.createOrSaveBrief({ prompt: bidPrompt, webpageMeta, blueprintOverride: byPage.blueprints[1] })
    expect(withPage.spec.theme.seeds.light.accent).toBe('#087ba1')
    expect(withPage.extraction?.taintedDisplay.suggestedNameZh).toBe(webpageMeta.title)
    const first = await studio.createOrSaveBrief({ prompt: bidPrompt, target: 'win32-x64', blueprintOverride: a.blueprints[1],
      referenceImageBase64: red.toString('base64'), referenceImageName: '我的参考.png' })
    expect(first.spec.theme.seeds.light.accent).toBe(a.blueprints[1]!.accentHex)
    const hash = createHash('sha256').update(red).digest('hex')
    expect(readFileSync(path.join(dir, first.projectId, 'assets/originals', hash))).toEqual(red)
    const edited = await studio.createOrSaveBrief({ projectId: first.projectId, expectedRevision: 1, prompt: bidPrompt })
    expect(edited.brief.assets).toEqual(first.brief.assets)
    expect(edited.spec.theme.seeds).toEqual(first.spec.theme.seeds)
  })

  it('retains frozen product and lock across edits and lets a failed native job retry', async () => {
    const host = detectHostPlatformTarget()
    const first = await studio.createOrSaveBrief({ prompt: bidPrompt, target: host })
    const started = studio.startBuildJob(first.projectId, host, { expectedRevision: 1 })
    expect(started.status).toBe('failed')
    const snapshot = path.join(dir, first.projectId, 'builds', started.jobId, 'inputs')
    const lock = first.locks[host]!
    const trial = { productDigest: computeSpecDigest(first.spec), lockDigest: computeSpecDigest(lock) }
    const updated = studio.updateProjectSpec({ projectId: first.projectId, expectedRevision: 1, target: host,
      displayName: { zh: '新的投标工作台', en: 'Updated bids' }, optionalActions: [] })
    expect(JSON.parse(readFileSync(path.join(snapshot, 'product.json'), 'utf8'))).toEqual(first.spec)
    expect(JSON.parse(readFileSync(path.join(snapshot, 'plugins.' + host + '.lock.json'), 'utf8'))).toEqual(lock)
    expect(() => studio.startBuildJob(first.projectId, host, { expectedRevision: 2, trial })).toThrow(/较早/)
    const second = studio.startBuildJob(first.projectId, host)
    expect(second.jobId).not.toBe(started.jobId)
    expect(second.status).toBe('failed')
    expect(studio.getProject(first.projectId).releases ?? []).toHaveLength(0)
    const nextLock = updated.locks[host]!
    expect(desktopCapabilities(first.spec, lock).actions).toContain('calendar.addDeadline')
    expect(desktopCapabilities(updated.spec, nextLock).actions).not.toContain('calendar.addDeadline')
    const before = buildProfileSeed({ spec: first.spec, lock, outDir: path.join(dir, 'seed-before') })
    const after = buildProfileSeed({ spec: first.spec, lock: nextLock, outDir: path.join(dir, 'seed-after') })
    expect(before.manifest.seedHash).not.toBe(after.manifest.seedHash)
  })

  it('re-imports a saved project without losing its files or releases and rebuilds a deleted release', async () => {
    const host = detectHostPlatformTarget()
    const other = host === 'darwin-arm64' ? 'win32-x64' : 'darwin-arm64'
    const image = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#09ad5b' } }).png().toBuffer()
    const first = await studio.createOrSaveBrief({ prompt: bidPrompt, target: host, referenceImageBase64: image.toString('base64') })
    const firstRecipe = studio.startBuildJob(first.projectId, other)
    const portable = JSON.parse(readFileSync(firstRecipe.artifactPath!, 'utf8'))
    const restored = studio.importProductSpec(portable, other)
    expect(restored.spec.revision).toBe(2)
    expect(restored.history.map(h => h.revision)).toEqual([1, 2])
    expect(restored.brief.assets).toEqual(first.brief.assets)
    expect(restored.locks[other]).toEqual(portable.platformLock)
    expect(restored.releases?.[0]?.jobId).toBe(firstRecipe.jobId)
    const secondRecipe = studio.startBuildJob(first.projectId, other)
    const release = studio.getProject(first.projectId).releases!.find(item => item.jobId === secondRecipe.jobId)!
    studio.deleteRelease(first.projectId, release.releaseId)
    const rebuilt = studio.startBuildJob(first.projectId, other)
    expect(rebuilt.jobId).not.toBe(secondRecipe.jobId)
    expect(JSON.parse(readFileSync(rebuilt.artifactPath!, 'utf8')).platformLock).toEqual(portable.platformLock)
  })

  it('rejects a configuration file as a Windows installer even if the receipt matches its name, bytes and SHA', async () => {
    const { spec, locks } = await studio.createOrSaveBrief({ prompt: bidPrompt, target: 'win32-x64' })
    const lock = locks['win32-x64']!
    const expected = { productId: spec.identity.productId, revision: 1, target: 'win32-x64',
      productDigest: computeSpecDigest(spec), lockDigest: computeSpecDigest(lock), templateCommit: PINNED_TEMPLATE_COMMIT }
    const artifactPath = path.join(dir, spec.identity.internalSlug + '-' + spec.appVersion + '-win32-x64-setup.exe')
    const bytes = Buffer.from(JSON.stringify(spec))
    writeFileSync(artifactPath, bytes)
    writeFileSync(path.join(dir, 'build-receipt.json'), JSON.stringify({ ...expected, schemaVersion: 1, jobId: 'job-12345678',
      dedupKey: computeSpecDigest(expected), appVersion: spec.appVersion, seedHash: 'a'.repeat(64), toolchainVersion: '0.1.0',
      distributionStatus: 'unsigned-local-test', artifactPath, artifactBytes: bytes.length,
      artifactSha256: createHash('sha256').update(bytes).digest('hex'), builtAt: new Date().toISOString() }))
    await expect(verifyWindowsInstaller(dir, 'job-12345678', spec, lock)).rejects.toThrow(/Invalid installer format/)
  })
})

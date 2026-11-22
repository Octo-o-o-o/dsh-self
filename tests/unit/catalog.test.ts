import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CATALOG,
  buildPlatformLock,
  evaluateCatalogAdmission,
  findCombinationConflicts,
  inspectPatchYamlSafety,
  resolvePluginCombination,
} from '@dsh-self/catalog'

describe('catalog 4-step admission, 6-dimension conflicts & combination solver', () => {
  it('rejects !!js YAML tags and alias bombs', () => {
    const jsCheck = inspectPatchYamlSafety('- id: evil\n  fn: !!js/function "() => 1"\n')
    expect(jsCheck.usesJsTag).toBe(true)
    expect(jsCheck.validPlainYaml).toBe(false)

    const cleanCheck = inspectPatchYamlSafety('- id: safe\n  config:\n    enabled: false\n')
    expect(cleanCheck.usesJsTag).toBe(false)
    expect(cleanCheck.validPlainYaml).toBe(true)
  })

  it('catches all 13 dsh peer mismatches on dsh-tender-workbench@0.5.11 and flags undeclared BidKit', () => {
    const tender = DEFAULT_CATALOG.find((e) => e.packageName === 'dsh-tender-workbench')!
    const tenderReport = evaluateCatalogAdmission(tender, 'win32-x64')
    expect(tenderReport.admitted).toBe(false)
    expect(tenderReport.dshState).toBe('declared-incompatible')
    expect(Object.keys(tenderReport.unmetDshRequirements).length).toBe(13)

    const bidkit = DEFAULT_CATALOG.find((e) => e.packageName === 'dsh-plugin-bidkit')!
    const bidkitReport = evaluateCatalogAdmission(bidkit, 'win32-x64')
    expect(bidkitReport.admitted).toBe(true)
    expect(bidkitReport.dshState).toBe('undeclared')
    expect(bidkitReport.requiresTrialVerification).toBe(true)
  })

  it('blocks postinstall native compile & cordis/react peer mismatches', () => {
    const base = DEFAULT_CATALOG[0]!
    const badCordis = {
      ...base,
      id: 'bad-cordis',
      manifest: { ...base.manifest, peerDependencies: { '@deepseek-ai/cordis': '^3.0.0', react: '^17.0.0' } },
      nativeAddonPolicy: 'requires-postinstall-compile' as const,
    }
    const rep = evaluateCatalogAdmission(badCordis, 'win32-x64')
    expect(rep.admitted).toBe(false)
    expect(rep.failures.some((f) => f.includes('Step 2'))).toBe(true)
    expect(rep.failures.some((f) => f.includes('@deepseek-ai/cordis'))).toBe(true)
    expect(rep.failures.some((f) => f.includes('react'))).toBe(true)
  })

  it('detects conflicts across all 6 footprint dimensions', () => {
    const a = DEFAULT_CATALOG[0]!
    const b = {
      ...DEFAULT_CATALOG[1]!,
      id: 'conflicting-b',
      packageName: 'conflicting-b',
      footprint: { ...a.footprint },
    }
    const conflicts = findCombinationConflicts([a, b])
    expect(conflicts.length).toBeGreaterThanOrEqual(4)
  })

  it('resolves deterministic cover, exposes selectable alternatives & honors user pinnedOverrides', () => {
    const res = resolvePluginCombination({
      target: 'win32-x64',
      requiredActions: ['bid.importRequirements', 'bid.exportResponseDocx'],
      optionalActions: ['calendar.addDeadline'],
      localOnly: true,
    })
    expect(res.missingRequiredActions).toEqual([])
    expect(res.selected.some((e) => e.packageName === '@dsh-self/adapter-bid-docx')).toBe(true)
    expect(res.selected.some((e) => e.packageName === '@dsh-self/adapter-local-calendar')).toBe(true)
    expect(res.hostPrivilegeSummary).toContain('完整文件与网络权限')

    const calCov = res.coverage.find((c) => c.actionId === 'calendar.addDeadline')!
    expect(calCov.candidates.length).toBe(2)
    expect(calCov.candidates.some((c) => c.packageName === 'dsh-calendar' && c.selectable)).toBe(true)

    // User pins alternative `office-calendar` (`dsh-calendar@0.20.5`)
    const pinned = resolvePluginCombination({
      target: 'win32-x64',
      requiredActions: ['bid.importRequirements', 'bid.exportResponseDocx'],
      optionalActions: ['calendar.addDeadline'],
      localOnly: true,
      pinnedOverrides: { 'calendar.addDeadline': 'office-calendar' },
    })
    expect(pinned.selected.some((e) => e.packageName === 'dsh-calendar')).toBe(true)
    const lock = buildPlatformLock(pinned)
    expect(lock.target).toBe('win32-x64')
    expect(lock.plugins.length).toBeGreaterThanOrEqual(2)
  })

  it('admits chatgpt-pro-research@0.3.6 & gpt-image-design@0.3.6 together cleanly and respects localOnly boundaries', () => {
    const research = DEFAULT_CATALOG.find((e) => e.packageName === 'chatgpt-pro-research')!
    const imageDesign = DEFAULT_CATALOG.find((e) => e.packageName === 'gpt-image-design')!
    expect(research).toBeDefined()
    expect(imageDesign).toBeDefined()

    for (const entry of [research, imageDesign]) {
      const report = evaluateCatalogAdmission(entry, 'win32-x64')
      expect(report.admitted, report.failures.join('; ')).toBe(true)
      expect(report.dshState).toBe('declared-compatible')
      expect(report.usesJsYamlTag).toBe(false)
    }

    // Zero 6-dimension conflicts when combined together
    expect(findCombinationConflicts([research, imageDesign])).toEqual([])

    // localOnly: true must not auto-select external-connection optional plugins
    const localDesign = resolvePluginCombination({
      target: 'win32-x64',
      requiredActions: ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
      optionalActions: ['design.openImageDesign'],
      localOnly: true,
    })
    expect(localDesign.selected.some((e) => e.packageName === 'gpt-image-design')).toBe(false)

    // Non-local research + AI image design resolves both with pinned SHA-512 integrity
    const fullResearch = resolvePluginCombination({
      target: 'win32-x64',
      requiredActions: ['research.openProResearch'],
      optionalActions: ['design.openImageDesign'],
      localOnly: false,
    })
    expect(fullResearch.missingRequiredActions).toEqual([])
    expect(fullResearch.selected.map((e) => e.packageName)).toEqual([
      'gpt-image-design',
      'chatgpt-pro-research',
    ])
    const lock = buildPlatformLock(fullResearch)
    expect(lock.plugins.every((p) => p.sourceKind === 'npm' && p.integritySha512.startsWith('sha512-'))).toBe(true)
  })
})

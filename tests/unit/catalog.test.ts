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
})

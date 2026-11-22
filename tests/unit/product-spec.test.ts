import { describe, expect, it } from 'vitest'
import {
  ProductSpecSchema,
  assertIdentityImmutable,
  buildPresetBrandIcon,
  checkStateDowngrade,
  deriveProductIdentity,
  deriveThemeSeedsFromDominantColor,
  deriveThemeTokens,
  migrateProductSpec,
  sanitizeDisplayName,
  sanitizeWindowsShortcutName,
} from '@dsh-self/product-spec'

function contrastRatioHex(fgHex: string, bgHex: string): number {
  const lum = (hex: string): number => {
    const clean = hex.replace('#', '')
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(clean.slice(i, i + 2), 16) / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const l1 = lum(fgHex)
  const l2 = lum(bgHex)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

describe('product-spec identity, theme, schema & migration', () => {
  it('derives frozen identity & blocks mutation', () => {
    const id1 = deriveProductIdentity({
      productId: '11111111-1111-4111-8111-111111111111',
      shortHint: '青禾投标!!! Qinghe Bids',
    })
    expect(id1.internalSlug).toBe('qinghe-bids-11111111')
    expect(id1.appId).toBe('app.dshself.u11111111')
    expect(id1.appUserModelId).toBe(id1.appId)
    expect(id1.nsisGuid).toBe('11111111-1111-4111-8111-111111111111')
    expect(id1.executableName).toBe(id1.internalSlug)

    const id2 = deriveProductIdentity({
      productId: '22222222-2222-4222-8222-222222222222',
      shortHint: 'qinghe-bids',
    })
    expect(() => assertIdentityImmutable(id1, id2)).toThrow(/immutable/i)
  })

  it('sanitizes displayName & Windows shortcut names safely', () => {
    expect(sanitizeDisplayName('  青禾\u0000投标\r\nPro  ')).toBe('青禾投标Pro')
    expect(sanitizeWindowsShortcutName('CON', 'fallback-slug')).toBe('fallback-slug')
    expect(sanitizeWindowsShortcutName('foo:bar*baz?<>|', 'safe-slug')).not.toMatch(/[:*?<>|\\/]/)
  })

  it('clamps extreme theme seeds to WCAG >= 4.5:1 and emits full --dsw-* tokens', () => {
    const seeds = deriveThemeSeedsFromDominantColor('#ffff99')
    // Deliberately feed low-contrast ink on light canvas
    const derived = deriveThemeTokens({
      light: { ...seeds.light, canvas: '#ffffff', ink: '#dddddd' },
      dark: { ...seeds.dark, canvas: '#0f172a', ink: '#1e293b' },
    })
    expect(contrastRatioHex(derived.clampedSeeds.light.ink, derived.clampedSeeds.light.canvas)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatioHex(derived.clampedSeeds.dark.ink, derived.clampedSeeds.dark.canvas)).toBeGreaterThanOrEqual(4.5)
    expect(Object.keys(derived.tokens).length).toBeGreaterThanOrEqual(100)
    expect(derived.tokens['--dsw-alias-bg-base']?.light).toBeTruthy()
    expect(derived.tokens['--dsw-alias-bg-base']?.dark).toBeTruthy()
  })

  it('enforces closed-set layout/widget compatibility & migrates legacy singular target', () => {
    const id = deriveProductIdentity({ productId: '11111111-1111-4111-8111-111111111111', shortHint: 'test' })
    const icon = buildPresetBrandIcon({ preset: 'bid-shield', accentHex: '#0f766e', label: '测' })
    const base = {
      schemaVersion: 1,
      revision: 1,
      appVersion: '0.1.0',
      target: 'win32-x64', // legacy field to be migrated
      identity: id,
      brand: {
        displayName: { zh: '测试客户端', en: 'Test Client' },
        iconSha256: icon.sha256,
        iconPreset: icon.preset,
        iconDataUrl: icon.dataUrl,
      },
      theme: { seeds: deriveThemeSeedsFromDominantColor('#0f766e') },
      shell: { defaultPanel: 'home', navOrder: ['home'], showReadinessBar: true, localOnlyToolWebDisabled: true },
      home: { layout: 'list-detail', sections: ['deadlines', 'bid-preview'], primaryAction: 'bid.importRequirements' },
      requiredActions: ['bid.importRequirements'],
      optionalActions: [],
      acceptance: { fixtures: ['valid.docx'], expectedOutputs: ['response.docx'] },
    }
    const migrated = migrateProductSpec(base)
    expect(migrated.supportedTargets).toEqual(['win32-x64'])
    expect('target' in (migrated as Record<string, unknown>)).toBe(false)

    // Invalid widget-layout combination (`design-canvas` is disallowed in `list-detail`)
    expect(() =>
      ProductSpecSchema.parse({
        ...migrated,
        home: { layout: 'list-detail', sections: ['design-canvas'], primaryAction: 'design.importImage' },
      }),
    ).toThrow(/not allowed in layout/i)
  })

  it('blocks data/session format downgrade while permitting same-or-newer versions', () => {
    const stored = {
      dataFormatVersion: 2,
      dshSessionFormatVersion: 3,
      lastAppVersion: '0.2.0',
      updatedAt: new Date().toISOString(),
    }
    expect(checkStateDowngrade(stored, { dataFormatVersion: 1, dshSessionFormatVersion: 3 }).blocked).toBe(true)
    expect(checkStateDowngrade(stored, { dataFormatVersion: 2, dshSessionFormatVersion: 2 }).blocked).toBe(true)
    expect(checkStateDowngrade(stored, { dataFormatVersion: 2, dshSessionFormatVersion: 3 }).blocked).toBe(false)
    expect(checkStateDowngrade(stored, { dataFormatVersion: 3, dshSessionFormatVersion: 3 }).blocked).toBe(false)
  })
})

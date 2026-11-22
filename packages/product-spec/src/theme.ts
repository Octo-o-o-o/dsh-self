export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export interface SemanticSeedPalette {
  readonly canvas: string
  readonly surface: string
  readonly ink: string
  readonly mutedInk: string
  readonly accent: string
  readonly border: string
  readonly danger: string
  readonly ok: string
}

export interface ThemeSeeds {
  readonly light: SemanticSeedPalette
  readonly dark: SemanticSeedPalette
}

export interface ThemeModes {
  readonly light: string
  readonly dark: string
}

export interface WindowChromeColors {
  readonly light: {
    readonly backgroundColor: string
    readonly titleBarColor: string
    readonly symbolColor: string
  }
  readonly dark: {
    readonly backgroundColor: string
    readonly titleBarColor: string
    readonly symbolColor: string
  }
}

export interface DerivedTheme {
  readonly tokens: Readonly<Record<string, ThemeModes>>
  readonly chrome: WindowChromeColors
  readonly clampedSeeds: ThemeSeeds
}

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export function normalizeHex(hex: string): string {
  if (!HEX_COLOR_RE.test(hex)) {
    throw new Error(`Invalid #RRGGBB color: ${JSON.stringify(hex)}`)
  }
  return hex.toLowerCase()
}

export function hexToRgb(hex: string): Rgb {
  const clean = normalizeHex(hex).slice(1)
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  }
}

export function rgbToHex(rgb: Rgb): string {
  const clamp = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${clamp(rgb.r)}${clamp(rgb.g)}${clamp(rgb.b)}`
}

export function mixHex(baseHex: string, targetHex: string, weightTarget: number): string {
  const a = hexToRgb(baseHex)
  const b = hexToRgb(targetHex)
  const w = Math.max(0, Math.min(1, weightTarget))
  return rgbToHex({
    r: a.r * (1 - w) + b.r * w,
    g: a.g * (1 - w) + b.g * w,
    b: a.b * (1 - w) + b.b * w,
  })
}

export function hexWithAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(2)})`
}

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** WCAG 2.1 contrast ratio in [1, 21]. */
export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA)
  const l2 = relativeLuminance(hexB)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * Deterministically clamp `fgHex` toward pure black or pure white so its WCAG
 * contrast ratio against `bgHex` is at least `minRatio` (default 4.5:1).
 */
export function clampContrast(fgHex: string, bgHex: string, minRatio = 4.5): string {
  const fg = normalizeHex(fgHex)
  const bg = normalizeHex(bgHex)
  if (contrastRatio(fg, bg) >= minRatio) return fg
  const bgLum = relativeLuminance(bg)
  const target = contrastRatio('#000000', bg) >= contrastRatio('#ffffff', bg) ? '#000000' : '#ffffff'
  // If bg is dark, prefer white; if light, prefer black (fallback to higher contrast pole).
  const preferredTarget = bgLum < 0.18 ? '#ffffff' : '#000000'
  const pole = contrastRatio(preferredTarget, bg) >= minRatio ? preferredTarget : target
  let lo = 0
  let hi = 1
  let best = pole
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2
    const candidate = mixHex(fg, pole, mid)
    if (contrastRatio(candidate, bg) >= minRatio) {
      best = candidate
      hi = mid
    } else {
      lo = mid
    }
  }
  return best
}

function clampPalette(palette: SemanticSeedPalette, isDark: boolean): SemanticSeedPalette {
  const canvas = normalizeHex(palette.canvas)
  const surface = normalizeHex(palette.surface)
  const inkOnCanvas = clampContrast(palette.ink, canvas, 4.5)
  const ink = contrastRatio(inkOnCanvas, surface) >= 4.5
    ? inkOnCanvas
    : clampContrast(inkOnCanvas, surface, 4.5)
  const mutedOnCanvas = clampContrast(palette.mutedInk, canvas, 4.5)
  const mutedInk = contrastRatio(mutedOnCanvas, surface) >= 4.5
    ? mutedOnCanvas
    : clampContrast(mutedOnCanvas, surface, 4.5)
  const accent = normalizeHex(palette.accent)
  const border = normalizeHex(palette.border)
  const danger = clampContrast(palette.danger, isDark ? surface : canvas, 4.5)
  const ok = clampContrast(palette.ok, isDark ? surface : canvas, 4.5)
  return { canvas, surface, ink, mutedInk, accent, border, danger, ok }
}

function pair(light: string, dark: string): ThemeModes {
  return { light, dark }
}

/**
 * Pure deterministic theme derivation from 8 light/dark semantic seed colors.
 * Single source of truth for all 110+ `--dsw-*` tokens AND Electron native chrome colors.
 */
export function deriveThemeTokens(seeds: ThemeSeeds): DerivedTheme {
  const l = clampPalette(seeds.light, false)
  const d = clampPalette(seeds.dark, true)

  const inputL = mixHex(l.canvas, l.border, 0.22)
  const inputD = mixHex(d.surface, d.border, 0.25)
  const tertiaryL = mixHex(l.mutedInk, l.canvas, 0.25)
  const tertiaryD = mixHex(d.mutedInk, d.canvas, 0.22)
  const lineWeakL = mixHex(l.border, l.canvas, 0.45)
  const lineWeakD = mixHex(d.border, d.canvas, 0.45)
  const lineStrongL = mixHex(l.border, l.ink, 0.30)
  const lineStrongD = mixHex(d.border, d.ink, 0.30)
  const actionHoverL = mixHex(l.accent, '#000000', 0.14)
  const actionHoverD = mixHex(d.accent, '#ffffff', 0.12)
  const actionSoftL = mixHex(l.accent, l.canvas, 0.55)
  const actionSoftD = mixHex(d.accent, d.canvas, 0.45)
  const linkL = clampContrast(l.accent, l.canvas, 4.5)
  const linkD = clampContrast(d.accent, d.canvas, 4.5)
  const onActionL = contrastRatio('#ffffff', l.accent) >= contrastRatio('#000000', l.accent) ? '#ffffff' : '#000000'
  const onActionD = contrastRatio('#ffffff', d.accent) >= contrastRatio('#000000', d.accent) ? '#ffffff' : '#000000'
  const selectedL = mixHex(l.accent, l.canvas, 0.86)
  const selectedD = mixHex(d.accent, d.canvas, 0.78)
  const selectedStrongL = mixHex(l.accent, l.canvas, 0.76)
  const selectedStrongD = mixHex(d.accent, d.canvas, 0.68)
  const dangerSoftL = mixHex(l.danger, l.canvas, 0.88)
  const dangerSoftD = mixHex(d.danger, d.canvas, 0.76)
  const warnL = clampContrast('#8f5e14', l.canvas, 4.5)
  const warnD = clampContrast('#f4b96b', d.canvas, 4.5)
  const warnSoftL = mixHex(warnL, l.canvas, 0.88)
  const warnSoftD = mixHex(warnD, d.canvas, 0.78)
  const okSoftL = mixHex(l.ok, l.canvas, 0.88)
  const okSoftD = mixHex(d.ok, d.canvas, 0.78)

  const canvas = pair(l.canvas, d.canvas)
  const card = pair(l.surface, d.surface)
  const input = pair(inputL, inputD)
  const ink = pair(l.ink, d.ink)
  const secondary = pair(l.mutedInk, d.mutedInk)
  const tertiary = pair(tertiaryL, tertiaryD)
  const line = pair(l.border, d.border)
  const lineWeak = pair(lineWeakL, lineWeakD)
  const lineStrong = pair(lineStrongL, lineStrongD)
  const action = pair(l.accent, d.accent)
  const actionHover = pair(actionHoverL, actionHoverD)
  const actionSoft = pair(actionSoftL, actionSoftD)
  const link = pair(linkL, linkD)
  const selected = pair(selectedL, selectedD)
  const selectedStrong = pair(selectedStrongL, selectedStrongD)
  const danger = pair(l.danger, d.danger)
  const dangerSoft = pair(dangerSoftL, dangerSoftD)
  const warn = pair(warnL, warnD)
  const warnSoft = pair(warnSoftL, warnSoftD)
  const ok = pair(l.ok, d.ok)
  const okSoft = pair(okSoftL, okSoftD)
  const onAction = pair(onActionL, onActionD)
  const tooltipBg = pair(d.surface, inputD)
  const tooltipFg = pair(d.ink, d.ink)
  const scrim = pair(hexWithAlpha(l.ink, 0.45), hexWithAlpha('#000000', 0.76))
  const clear = pair('transparent', 'transparent')
  const none = pair('none', 'none')
  const shadow1 = pair('0 1px 2px rgba(20, 22, 40, 0.04)', '0 1px 2px rgba(0, 0, 0, 0.24)')
  const shadow2 = pair(
    '0 1px 2px rgba(20, 22, 40, 0.03), 0 4px 12px rgba(20, 22, 40, 0.05)',
    '0 1px 3px rgba(0, 0, 0, 0.16), 0 4px 12px rgba(0, 0, 0, 0.20)',
  )
  const shadow3 = pair(
    '0 2px 8px rgba(20, 22, 40, 0.05), 0 16px 40px rgba(20, 22, 40, 0.07)',
    `0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px ${hexWithAlpha(d.border, 0.45)}`,
  )

  const tokens: Record<string, ThemeModes> = {
    '--dsw-alias-bg-base': canvas,
    '--dsw-alias-bg-module-platform': canvas,
    '--dsw-specific-guide-hero': canvas,
    '--dsw-specific-sidebar-fill': canvas,
    '--dsw-specific-sidebar-tint': canvas,
    '--dsw-specific-sidebar-glass-fill': canvas,
    '--dsw-specific-sidebar-glass-collapsed-fill': canvas,
    '--dsw-specific-sidebar-wash-top': clear,
    '--dsw-specific-sidebar-wash-top-clear': clear,
    '--dsw-specific-sidebar-wash-bottom': clear,
    '--dsw-specific-sidebar-wash-bottom-clear': clear,
    '--dsw-alias-bg-layer-1': card,
    '--dsw-alias-bg-overlay': card,
    '--dsw-alias-card-fill': card,
    '--dsw-alias-card-tile-fill': card,
    '--dsw-alias-settings-card-fill': card,
    '--dsw-alias-onboarding-card-fill': card,
    '--dsw-alias-hovercard-bg': card,
    '--dsw-alias-toast-bg': card,
    '--dsw-specific-menu': card,
    '--dsw-menu-surface-fill': card,
    '--dsw-specific-tip': card,
    '--dsw-alias-bg-layer-2': input,
    '--dsw-alias-bg-layer-3': input,
    '--dsw-specific-input-major': input,
    '--dsw-specific-login-input': input,
    '--dsw-specific-selector': input,
    '--dsw-alias-onboarding-secondary-fill': input,
    '--dsw-specific-sidebar-glass-hover': input,
    '--dsw-specific-sidebar-glass-collapsed-hover': input,
    '--dsw-alias-menu-group-header-fill': input,
    '--dsw-alias-label-primary': ink,
    '--dsw-alias-label-primary-foreground': ink,
    '--dsw-alias-toast-label': ink,
    '--dsw-alias-hovercard-label-primary': ink,
    '--dsw-alias-label-secondary': secondary,
    '--dsw-alias-label-primary-dimmed': secondary,
    '--dsw-alias-hovercard-label-secondary': secondary,
    '--dsw-alias-menu-icon': secondary,
    '--dsw-alias-label-tertiary': tertiary,
    '--dsw-alias-label-caption': tertiary,
    '--dsw-alias-label-dimmed': tertiary,
    '--dsw-alias-hovercard-label-tertiary': tertiary,
    '--dsw-alias-state-idle-primary': tertiary,
    '--dsw-alias-label-on-color': onAction,
    '--dsw-alias-label-primary-inverted': pair(d.ink, l.ink),
    '--dsw-alias-tooltip-bg': tooltipBg,
    '--dsw-alias-tooltip-key-bg': input,
    '--dsw-alias-tooltip-label': tooltipFg,
    '--dsw-alias-border-l1': lineWeak,
    '--dsw-alias-border-l2': line,
    '--dsw-alias-border-l3': line,
    '--dsw-alias-border-l2-darkmode-thin': lineWeak,
    '--dsw-alias-border-l4': lineStrong,
    '--dsw-alias-settings-card-stroke': lineWeak,
    '--dsw-alias-onboarding-checkbox-border': line,
    '--dsw-alias-border-selected': link,
    '--dsw-alias-button-primary-fill': action,
    '--dsw-alias-button-primary-hover': actionHover,
    '--dsw-alias-button-primary-dimmed': actionSoft,
    '--dsw-alias-button-info-fill': action,
    '--dsw-alias-button-info-hover': actionHover,
    '--dsw-alias-button-contrast-fill': ink,
    '--dsw-alias-button-elevated-fill': card,
    '--dsw-alias-button-floating-fill': card,
    '--dsw-alias-button-floating-hover': input,
    '--dsw-alias-button-ghost-active-fill': selected,
    '--dsw-alias-button-ghost-active-hover': input,
    '--dsw-alias-button-ghost-active-border': link,
    '--dsw-alias-brand-primary': pair(l.accent, linkD),
    '--dsw-alias-brand-primary-invert': pair(onActionL, d.canvas),
    '--dsw-alias-brand-text': link,
    '--dsw-alias-link': link,
    '--dsw-alias-markdown-citation': link,
    '--dsw-alias-interactive-bg-hover': input,
    '--dsw-alias-interactive-bg-active': selected,
    '--dsw-alias-interactive-bg-hover-accent': selected,
    '--dsw-alias-interactive-bg-hover-solid': actionHover,
    '--dsw-alias-interactive-bg-hover-danger': dangerSoft,
    '--dsw-alias-card-fill-hover': selected,
    '--dsw-specific-sidebar-nav-item-active': selected,
    '--dsw-specific-sidebar-nav-item-active-accent': action,
    '--dsw-specific-bubble': selected,
    '--dsw-specific-bubble-highlight': selectedStrong,
    '--dsw-focus-ring-color': link,
    '--dsw-alias-state-business-primary': pair(l.accent, linkD),
    '--dsw-alias-state-business-tertiary': selected,
    '--dsw-alias-state-error-primary': danger,
    '--dsw-alias-state-error-secondary': dangerSoft,
    '--dsw-alias-hovercard-state-error': danger,
    '--dsw-alias-state-warn-primary': warn,
    '--dsw-alias-state-warn-secondary': warnSoft,
    '--dsw-alias-state-warn-tertiary': warnSoft,
    '--dsw-alias-state-warn-label': warn,
    '--dsw-alias-state-success-primary': ok,
    '--dsw-alias-state-success-secondary': okSoft,
    '--dsw-alias-state-success-tertiary': okSoft,
    '--dsw-alias-state-done-primary': ok,
    '--dsw-alias-hovercard-state-done': ok,
    '--dsw-alias-bg-mask-drop': scrim,
    '--dsw-menu-backdrop-filter': none,
    '--dsw-radius-xs': pair('4px', '4px'),
    '--dsw-radius-sm': pair('8px', '8px'),
    '--dsw-radius-md': pair('14px', '14px'),
    '--dsw-radius-lg': pair('18px', '18px'),
    '--dsw-radius-xl': pair('24px', '24px'),
    '--dsw-radius-panel': pair('24px', '24px'),
    '--dsw-shadow-lv1': shadow1,
    '--dsw-shadow-lv2': shadow2,
    '--dsw-shadow-lv3': shadow3,
  }

  return {
    tokens,
    chrome: {
      light: { backgroundColor: l.canvas, titleBarColor: l.canvas, symbolColor: l.ink },
      dark: { backgroundColor: d.canvas, titleBarColor: d.canvas, symbolColor: d.ink },
    },
    clampedSeeds: { light: l, dark: d },
  }
}

/** Deterministic local fallback when the active model does not declare `image` input modality. */
export function deriveThemeSeedsFromDominantColor(dominantHex: string): ThemeSeeds {
  const accentLight = clampContrast(normalizeHex(dominantHex), '#f8fafc', 4.5)
  const accentDark = clampContrast(mixHex(normalizeHex(dominantHex), '#ffffff', 0.35), '#0f172a', 4.5)
  return {
    light: {
      canvas: mixHex('#f8fafc', accentLight, 0.04),
      surface: '#ffffff',
      ink: '#0f172a',
      mutedInk: '#475569',
      accent: accentLight,
      border: '#cbd5e1',
      danger: '#dc2626',
      ok: '#15803d',
    },
    dark: {
      canvas: mixHex('#0f172a', accentDark, 0.06),
      surface: mixHex('#1e293b', accentDark, 0.06),
      ink: '#f8fafc',
      mutedInk: '#94a3b8',
      accent: accentDark,
      border: '#334155',
      danger: '#f87171',
      ok: '#4ade80',
    },
  }
}

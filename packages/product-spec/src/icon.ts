import { createHash } from 'node:crypto'
import { escapeHtml } from './identity.js'
import { HEX_COLOR_RE } from './theme.js'

export const BRAND_ICON_PRESETS = [
  'monogram',
  'bid-shield',
  'design-pen',
  'workbench-grid',
  'custom',
] as const

export type BrandIconPreset = (typeof BRAND_ICON_PRESETS)[number]

export const MAX_ICON_DATA_URL_LENGTH = 700_000

function safeHex(hex: string | undefined, fallback: string): string {
  return hex && HEX_COLOR_RE.test(hex) ? hex : fallback
}

function darkenHex(hex: string, factor = 0.72): string {
  const clean = safeHex(hex, '#0f766e').slice(1)
  const r = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(0, 2), 16) * factor)))
  const g = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(2, 4), 16) * factor)))
  const b = Math.max(0, Math.min(255, Math.round(parseInt(clean.slice(4, 6), 16) * factor)))
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

/**
 * Generate a crisp, font-light 256x256 SVG app icon for one of the 4 built-in presets.
 * Safe for both browser previews and `sharp` rasterization into Windows `.ico` / macOS `.icns` / Linux PNG.
 */
export function renderBrandIconSvg(options: {
  readonly preset: Exclude<BrandIconPreset, 'custom'>
  readonly accentHex: string
  readonly label?: string
}): string {
  const primary = safeHex(options.accentHex, '#0f766e')
  const deeper = darkenHex(primary, 0.68)
  const glyph = escapeHtml((options.label?.trim() || 'D').slice(0, 1))

  let motif: string
  switch (options.preset) {
    case 'bid-shield':
      motif = [
        '<path d="M128 46L194 74V132C194 174 166 205 128 218C90 205 62 174 62 132V74L128 46Z" fill="rgba(255,255,255,0.16)" stroke="#ffffff" stroke-width="10" stroke-linejoin="round"/>',
        '<path d="M98 131L119 152L162 106" fill="none" stroke="#ffffff" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>',
      ].join('')
      break
    case 'design-pen':
      motif = [
        '<rect x="52" y="52" width="152" height="152" rx="28" fill="rgba(255,255,255,0.12)" stroke="#ffffff" stroke-width="8" stroke-dasharray="18 12"/>',
        '<path d="M174 82L126 178L114 142L78 130L174 82Z" fill="#ffffff" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"/>',
        '<circle cx="174" cy="82" r="10" fill="#ffffff"/>',
      ].join('')
      break
    case 'workbench-grid':
      motif = [
        '<rect x="54" y="54" width="66" height="66" rx="16" fill="#ffffff"/>',
        '<rect x="136" y="54" width="66" height="66" rx="16" fill="rgba(255,255,255,0.72)"/>',
        '<rect x="54" y="136" width="66" height="66" rx="16" fill="rgba(255,255,255,0.72)"/>',
        '<rect x="136" y="136" width="66" height="66" rx="16" fill="rgba(255,255,255,0.35)" stroke="#ffffff" stroke-width="8"/>',
      ].join('')
      break
    case 'monogram':
    default:
      motif = [
        '<rect x="34" y="34" width="188" height="188" rx="44" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.28)" stroke-width="6"/>',
        `<text x="128" y="160" text-anchor="middle" font-family="Segoe UI, PingFang SC, Microsoft YaHei, sans-serif" font-size="112" font-weight="700" fill="#ffffff">${glyph}</text>`,
      ].join('')
      break
  }

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">',
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0%" stop-color="${primary}"/>`,
    `<stop offset="100%" stop-color="${deeper}"/>`,
    '</linearGradient></defs>',
    '<rect x="8" y="8" width="240" height="240" rx="56" fill="url(#bg)"/>',
    motif,
    '</svg>',
  ].join('')
}

/** Build both the base64 SVG data URL and exact SHA-256 hex for a preset brand icon. */
export function buildPresetBrandIcon(options: {
  readonly preset: Exclude<BrandIconPreset, 'custom'>
  readonly accentHex: string
  readonly label?: string
}): {
  readonly preset: Exclude<BrandIconPreset, 'custom'>
  readonly svg: string
  readonly dataUrl: string
  readonly sha256: string
} {
  const svg = renderBrandIconSvg(options)
  const buf = Buffer.from(svg, 'utf8')
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const dataUrl = `data:image/svg+xml;base64,${buf.toString('base64')}`
  return { preset: options.preset, svg, dataUrl, sha256 }
}

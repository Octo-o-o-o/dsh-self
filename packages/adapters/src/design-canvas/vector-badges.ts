/**
 * Font-free pure-geometry `<path>` SVG numbered badge renderer.
 * Zero `<text>` nodes, zero system font / fontconfig dependency across Win/macOS/Linux.
 * Rendered as small individual SVG tiles (never a full-canvas SVG) to stay far below
 * Cairo/librsvg's hard 32,767 px surface limit on ultra-long images.
 */

// 7-segment-inspired clean vector digit paths on a 10x16 coordinate grid
const DIGIT_PATHS: Readonly<Record<string, string>> = {
  '0': 'M2 3 C2 1.5 3.5 1 5 1 C6.5 1 8 1.5 8 3 L8 13 C8 14.5 6.5 15 5 15 C3.5 15 2 14.5 2 13 Z',
  '1': 'M3 4 L5.5 1.5 L5.5 15 M3 15 L8 15',
  '2': 'M2 4 C2 2 3.5 1 5 1 C7 1 8 2.2 8 4 C8 6.5 5 8.5 2 14.5 L8.5 14.5',
  '3': 'M2 3 C2.5 1.5 4 1 5.5 1 C7.2 1 8 2.2 8 3.8 C8 5.5 6.8 6.8 4.8 7.5 C7 8 8.3 9.5 8.3 11.5 C8.3 13.8 6.8 15 5 15 C3.2 15 2 14 1.8 12.8',
  '4': 'M7 15 L7 1.5 L1.8 10.5 L8.8 10.5',
  '5': 'M8 1.5 L2.5 1.5 L2.2 7.2 C3.2 6.4 4.4 6 5.5 6 C7.4 6 8.4 7.5 8.4 10.5 C8.4 13.5 7 15 4.8 15 C3 15 2 14 1.8 12.8',
  '6': 'M7.8 2.8 C7 1.5 5.8 1 4.5 1 C2.6 1 1.8 3.5 1.8 8 C1.8 12.8 3 15 5.2 15 C7.2 15 8.4 13.4 8.4 11 C8.4 8.6 7.1 7.2 5.2 7.2 C3.4 7.2 2.2 8.2 1.9 9.5',
  '7': 'M1.8 1.5 L8.5 1.5 L4 15',
  '8': 'M5 7.5 C3 7.5 2 6 2 4.2 C2 2.2 3.3 1 5 1 C6.7 1 8 2.2 8 4.2 C8 6 7 7.5 5 7.5 Z M5 7.5 C2.8 7.5 1.7 9 1.7 11.3 C1.7 13.7 3.1 15 5 15 C6.9 15 8.3 13.7 8.3 11.3 C8.3 9 7.2 7.5 5 7.5 Z',
  '9': 'M8.2 7 C7.6 8.2 6.4 9 4.8 9 C2.8 9 1.7 7.5 1.7 5 C1.7 2.5 3 1 5 1 C7.2 1 8.3 3.2 8.3 7.8 C8.3 12.6 6.8 15 4.6 15 C3.2 15 2.3 14.3 1.9 13.2',
}

export function renderGeometryBadgeSvg(index: number, diameterPx: number, accentHex = '#dc2626'): Buffer {
  const safeIndex = Math.max(1, Math.min(999, Math.floor(index)))
  const size = Math.max(24, Math.min(256, Math.round(diameterPx)))
  const safeAccent = /^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : '#dc2626'
  const r = size / 2
  const strokeW = Math.max(2, Math.round(size * 0.08))
  const digits = String(safeIndex).split('')
  const digitW = 10
  const gap = 2.5
  const totalW = digits.length * digitW + (digits.length - 1) * gap
  const scale = (size * 0.56) / Math.max(16, totalW)
  const startX = r - (totalW * scale) / 2
  const startY = r - (16 * scale) / 2

  const digitPaths = digits
    .map((ch, idx) => {
      const d = DIGIT_PATHS[ch] ?? DIGIT_PATHS['0']!
      const tx = startX + idx * (digitW + gap) * scale
      return `<path d="${d}" transform="translate(${tx.toFixed(2)},${startY.toFixed(2)}) scale(${scale.toFixed(4)})" fill="none" stroke="#ffffff" stroke-width="${(2.2).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`
    })
    .join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<circle cx="${r}" cy="${r}" r="${(r - strokeW / 2 - 1).toFixed(2)}" fill="${safeAccent}" stroke="#ffffff" stroke-width="${strokeW}"/>
${digitPaths}
</svg>`
  return Buffer.from(svg, 'utf8')
}

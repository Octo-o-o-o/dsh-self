import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  exportAnnotatedPng,
  generatePreviewProxy,
  inspectRasterImage,
  renderGeometryBadgeSvg,
} from '@dsh-self/adapters/design-canvas'

const IMG_FIXTURES = path.resolve('fixtures/images')

describe('design-canvas adapter EXIF rotation, ultra-long 2000x40000 & tiled vector badges', () => {
  it('rejects SVG inputs by magic bytes and swaps EXIF Orientation 6 dimensions', async () => {
    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    await expect(inspectRasterImage(svgBuf)).rejects.toThrow(/raster|SVG|magic|format/i)

    const info = await inspectRasterImage(path.join(IMG_FIXTURES, 'exif-rotated-6.jpg'))
    expect(info.exifOrientation).toBe(6)
    expect(info.rawWidth).toBe(400)
    expect(info.rawHeight).toBe(200)
    expect(info.effectiveWidth).toBe(200)
    expect(info.effectiveHeight).toBe(400)
  })

  it('produces font-free pure-geometry SVG badges (zero <text> elements)', () => {
    const badge = renderGeometryBadgeSvg(12, 48, '#dc2626').toString('utf8')
    expect(badge).toContain('<svg')
    expect(badge).toContain('<path')
    expect(badge).not.toContain('<text')
  })

  it('creates bounded <= 4096 px preview proxy and exports tiled annotated PNG on 2000x40000 ultra-long image', async () => {
    const longPath = path.join(IMG_FIXTURES, 'ultra-long-2000x40000.png')
    const proxy = await generatePreviewProxy(longPath, 4096)
    expect(Math.max(proxy.width, proxy.height)).toBeLessThanOrEqual(4096)
    expect(proxy.scale).toBeLessThan(0.15)

    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dsh-self-design-test-'))
    try {
      const outPath = path.join(tmpDir, 'annotated-long.png')
      const exported = await exportAnnotatedPng({
        input: longPath,
        annotations: [
          { id: 'a1', index: 1, x: 0.0, y: 0.0, note: 'Top-left corner clamp check', color: '#dc2626' },
          { id: 'a2', index: 2, x: 1.0, y: 1.0, note: 'Bottom-right beyond 32767px', color: '#0f766e' },
        ],
        outputPath: outPath,
      })
      expect(exported.width).toBe(2000)
      expect(exported.height).toBe(40000)
      // Clamped inside [0, W - size] & [0, H - size]
      expect(exported.badges[0]!.left).toBe(0)
      expect(exported.badges[0]!.top).toBe(0)
      expect(exported.badges[1]!.top).toBeGreaterThan(39_000)
      expect(exported.badges[1]!.top + exported.badges[1]!.size).toBeLessThanOrEqual(40000)

      const outMeta = await sharp(outPath, { limitInputPixels: 300_000_000 }).metadata()
      expect(outMeta.width).toBe(2000)
      expect(outMeta.height).toBe(40000)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 30_000)
})

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { renderBrandIconSvg, type BrandIconPreset, type ProductSpec } from '@dsh-self/product-spec'

export interface GeneratedIconSet {
  readonly png256Path: string
  readonly png512Path: string
  readonly icoPath: string
  readonly icnsPath: string
  readonly linuxIconsDir: string
}

/** Encode multiple PNG buffers into a valid Windows `.ico` container (Vista+ PNG-in-ICO format). */
export function encodePngFramesToIco(frames: readonly { readonly size: number; readonly png: Buffer }[]): Buffer {
  const count = frames.length
  const headerSize = 6
  const dirEntrySize = 16
  let offset = headerSize + count * dirEntrySize

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)     // reserved
  header.writeUInt16LE(1, 2)     // type = 1 (ICON)
  header.writeUInt16LE(count, 4) // image count

  const entries: Buffer[] = []
  const bodies: Buffer[] = []
  for (const frame of frames) {
    const entry = Buffer.alloc(dirEntrySize)
    const dim = frame.size >= 256 ? 0 : frame.size
    entry.writeUInt8(dim, 0)                   // width
    entry.writeUInt8(dim, 1)                   // height
    entry.writeUInt8(0, 2)                     // color palette
    entry.writeUInt8(0, 3)                     // reserved
    entry.writeUInt16LE(1, 4)                  // color planes
    entry.writeUInt16LE(32, 6)                 // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8)   // image size
    entry.writeUInt32LE(offset, 12)            // image offset
    entries.push(entry)
    bodies.push(frame.png)
    offset += frame.png.length
  }
  return Buffer.concat([header, ...entries, ...bodies])
}

/** Encode multiple PNG buffers into a valid Apple `.icns` container. */
export function encodePngFramesToIcns(frames: readonly { readonly type: string; readonly png: Buffer }[]): Buffer {
  const chunks: Buffer[] = []
  let totalSize = 8
  for (const frame of frames) {
    const chunkHeader = Buffer.alloc(8)
    chunkHeader.write(frame.type, 0, 4, 'ascii')
    chunkHeader.writeUInt32BE(8 + frame.png.length, 4)
    chunks.push(chunkHeader, frame.png)
    totalSize += 8 + frame.png.length
  }
  const fileHeader = Buffer.alloc(8)
  fileHeader.write('icns', 0, 4, 'ascii')
  fileHeader.writeUInt32BE(totalSize, 4)
  return Buffer.concat([fileHeader, ...chunks])
}

function resolveSourceIconBuffer(spec: ProductSpec, explicitPath?: string): Buffer {
  if (explicitPath && existsSync(explicitPath)) {
    return readFileSync(explicitPath)
  }
  const dataUrl = spec.brand.iconDataUrl
  if (dataUrl) {
    const comma = dataUrl.indexOf(',')
    if (comma >= 0) {
      return Buffer.from(dataUrl.slice(comma + 1), 'base64')
    }
  }
  const preset = (spec.brand.iconPreset && spec.brand.iconPreset !== 'custom'
    ? spec.brand.iconPreset
    : 'monogram') as Exclude<BrandIconPreset, 'custom'>
  const svg = renderBrandIconSvg({
    preset,
    accentHex: spec.theme.seeds.light.accent,
    label: spec.brand.displayName.zh,
  })
  return Buffer.from(svg, 'utf8')
}

/**
 * Rasterize the product brand icon into cross-platform assets (`.ico`, `.icns`, `256/512 PNG`, Linux icons)
 * purely via `sharp` + pure-JS container encoders (zero native OS icon utilities required).
 */
export async function generateProductIcons(options: {
  readonly spec: ProductSpec
  readonly outDir: string
  readonly iconSourcePath?: string
}): Promise<GeneratedIconSet> {
  mkdirSync(options.outDir, { recursive: true })
  const linuxIconsDir = path.join(options.outDir, 'linux-icons')
  mkdirSync(linuxIconsDir, { recursive: true })

  const srcBuf = resolveSourceIconBuffer(options.spec, options.iconSourcePath)
  const renderPng = async (size: number): Promise<Buffer> =>
    await sharp(srcBuf, { density: 288 })
      .resize(size, size, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toBuffer()

  const sizes = [16, 32, 48, 64, 128, 256, 512] as const
  const pngBySize = new Map<number, Buffer>()
  for (const s of sizes) {
    const buf = await renderPng(s)
    pngBySize.set(s, buf)
    writeFileSync(path.join(linuxIconsDir, `${s}x${s}.png`), buf)
  }

  const png256Path = path.join(options.outDir, 'icon.png')
  const png512Path = path.join(options.outDir, 'icon-512.png')
  writeFileSync(png256Path, pngBySize.get(256)!)
  writeFileSync(png512Path, pngBySize.get(512)!)

  const icoBuf = encodePngFramesToIco([
    { size: 16, png: pngBySize.get(16)! },
    { size: 32, png: pngBySize.get(32)! },
    { size: 48, png: pngBySize.get(48)! },
    { size: 64, png: pngBySize.get(64)! },
    { size: 128, png: pngBySize.get(128)! },
    { size: 256, png: pngBySize.get(256)! },
  ])
  const icoPath = path.join(options.outDir, 'icon.ico')
  writeFileSync(icoPath, icoBuf)

  const icnsBuf = encodePngFramesToIcns([
    { type: 'icp4', png: pngBySize.get(16)! },
    { type: 'icp5', png: pngBySize.get(32)! },
    { type: 'icp6', png: pngBySize.get(64)! },
    { type: 'ic07', png: pngBySize.get(128)! },
    { type: 'ic08', png: pngBySize.get(256)! },
    { type: 'ic09', png: pngBySize.get(512)! },
  ])
  const icnsPath = path.join(options.outDir, 'icon.icns')
  writeFileSync(icnsPath, icnsBuf)

  return { png256Path, png512Path, icoPath, icnsPath, linuxIconsDir }
}

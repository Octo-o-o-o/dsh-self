import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import { z } from 'zod'
import { renderGeometryBadgeSvg } from './vector-badges.js'

export const MAX_IMAGE_FILE_BYTES = 100 * 1024 * 1024
export const LIMIT_INPUT_PIXELS = 300_000_000
export const MAX_ANNOTATIONS = 200
export const DEFAULT_PREVIEW_MAX_EDGE = 4096

export const AnnotationPointSchema = z.object({
  id: z.string().min(1).max(64),
  index: z.number().int().min(1).max(999),
  /** Normalized [0, 1] horizontal coordinate relative to EXIF-oriented image width. */
  x: z.number().finite().min(0).max(1),
  /** Normalized [0, 1] vertical coordinate relative to EXIF-oriented image height. */
  y: z.number().finite().min(0).max(1),
  note: z.string().max(1000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#dc2626'),
}).strict()

export type AnnotationPoint = z.infer<typeof AnnotationPointSchema>

export const AnnotationsFileSchema = z.object({
  schemaVersion: z.literal(1),
  imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  originalFileName: z.string().min(1).max(128),
  effectiveWidth: z.number().int().min(1),
  effectiveHeight: z.number().int().min(1),
  exifOrientation: z.number().int().min(1).max(8).optional(),
  annotations: z.array(AnnotationPointSchema).max(MAX_ANNOTATIONS),
}).strict()

export type AnnotationsFile = z.infer<typeof AnnotationsFileSchema>

export interface InspectedRasterImage {
  readonly format: 'png' | 'jpeg' | 'webp'
  readonly rawWidth: number
  readonly rawHeight: number
  readonly effectiveWidth: number
  readonly effectiveHeight: number
  readonly exifOrientation?: number
  readonly sha256: string
  readonly bytes: number
}

/** Verify strictly raster bitmap magic bytes (PNG/JPEG/WebP); rejects untrusted SVG/XML inputs. */
export function detectAllowedRasterFormat(buf: Uint8Array): 'png' | 'jpeg' | 'webp' {
  if (buf.byteLength < 12) {
    throw new Error('Image buffer is too small to identify raster format')
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png'
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpeg'
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'webp'
  }
  throw new Error('Only PNG, JPEG, and WebP raster bitmaps are accepted (external SVG/XML inputs are blocked)')
}

function readInputBuffer(input: string | Buffer): Buffer {
  if (typeof input === 'string') {
    const stat = statSync(input)
    if (stat.size > MAX_IMAGE_FILE_BYTES) {
      throw new Error(`Image file exceeds ${MAX_IMAGE_FILE_BYTES} byte limit`)
    }
    return readFileSync(input)
  }
  if (input.byteLength > MAX_IMAGE_FILE_BYTES) {
    throw new Error(`Image buffer exceeds ${MAX_IMAGE_FILE_BYTES} byte limit`)
  }
  return input
}

/** Inspect raster metadata and compute true post-EXIF-rotation effective dimensions (swapping for 5–8). */
export async function inspectRasterImage(input: string | Buffer): Promise<InspectedRasterImage> {
  const buf = readInputBuffer(input)
  const format = detectAllowedRasterFormat(buf)
  const meta = await sharp(buf, {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    sequentialRead: true,
  }).metadata()
  if (meta.width === undefined || meta.height === undefined) {
    throw new Error('Unable to read image dimensions')
  }
  const orientation = meta.orientation
  const swapped = orientation !== undefined && orientation >= 5 && orientation <= 8
  const effectiveWidth = swapped ? meta.height : meta.width
  const effectiveHeight = swapped ? meta.width : meta.height
  if (effectiveWidth * effectiveHeight > LIMIT_INPUT_PIXELS) {
    throw new Error(`Image pixel count ${effectiveWidth * effectiveHeight} exceeds limit ${LIMIT_INPUT_PIXELS}`)
  }
  return {
    format,
    rawWidth: meta.width,
    rawHeight: meta.height,
    effectiveWidth,
    effectiveHeight,
    exifOrientation: orientation,
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.byteLength,
  }
}

/**
 * Generate a bounded-edge preview proxy so Chromium `<canvas>` never exceeds its
 * 16,384 px GPU texture limit on ultra-long screenshots (e.g. 2000x40000).
 */
export async function generatePreviewProxy(
  input: string | Buffer,
  maxEdge = DEFAULT_PREVIEW_MAX_EDGE,
): Promise<{ readonly buffer: Buffer; readonly width: number; readonly height: number; readonly scale: number }> {
  const buf = readInputBuffer(input)
  const info = await inspectRasterImage(buf)
  const longest = Math.max(info.effectiveWidth, info.effectiveHeight)
  const safeMaxEdge = Math.min(maxEdge, 8192)
  const scale = longest > safeMaxEdge ? safeMaxEdge / longest : 1
  const targetWidth = Math.max(1, Math.round(info.effectiveWidth * scale))
  const targetHeight = Math.max(1, Math.round(info.effectiveHeight * scale))
  const out = await sharp(buf, {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .resize({ width: targetWidth, height: targetHeight, fit: 'inside', withoutEnlargement: true })
    .toColorspace('srgb')
    .png()
    .toBuffer({ resolveWithObject: true })
  return {
    buffer: out.data,
    width: out.info.width,
    height: out.info.height,
    scale,
  }
}

export interface PlacedBadgeCoord {
  readonly index: number
  readonly left: number
  readonly top: number
  readonly size: number
}

export interface ExportAnnotatedPngResult {
  readonly outputPath: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly sha256: string
  readonly badges: readonly PlacedBadgeCoord[]
  readonly elapsedMs: number
}

/**
 * Offscreen EXIF-normalized PNG export with per-annotation tiled pure-geometry SVG badges.
 * Completely bypasses Cairo's 32,767 px surface limit by compositing tiny badge tiles in libvips.
 */
export async function exportAnnotatedPng(options: {
  readonly input: string | Buffer
  readonly annotations: readonly AnnotationPoint[]
  readonly outputPath: string
}): Promise<ExportAnnotatedPngResult> {
  const started = Date.now()
  if (options.annotations.length > MAX_ANNOTATIONS) {
    throw new Error(`Annotation count ${options.annotations.length} exceeds limit ${MAX_ANNOTATIONS}`)
  }
  const validatedAnnotations = options.annotations.map((a) => AnnotationPointSchema.parse(a))
  const buf = readInputBuffer(options.input)
  const info = await inspectRasterImage(buf)
  const W = info.effectiveWidth
  const H = info.effectiveHeight
  const shortEdge = Math.min(W, H)
  const badgeSize = Math.max(24, Math.min(shortEdge, Math.min(160, Math.round(shortEdge * 0.045))))

  const placed: PlacedBadgeCoord[] = []
  const overlays: OverlayOptions[] = validatedAnnotations.map((ann) => {
    const rawLeft = Math.round(ann.x * W - badgeSize / 2)
    const rawTop = Math.round(ann.y * H - badgeSize / 2)
    const left = Math.max(0, Math.min(W - badgeSize, rawLeft))
    const top = Math.max(0, Math.min(H - badgeSize, rawTop))
    placed.push({ index: ann.index, left, top, size: badgeSize })
    return {
      input: renderGeometryBadgeSvg(ann.index, badgeSize, ann.color),
      left,
      top,
    }
  })

  // Step 1: Rotate & convert to sRGB cleanly first so composite coordinates match post-EXIF dims
  const normalizedBase = await sharp(buf, {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .toColorspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })

  const outPng = await sharp(normalizedBase.data, {
    raw: {
      width: normalizedBase.info.width,
      height: normalizedBase.info.height,
      channels: normalizedBase.info.channels,
    },
    limitInputPixels: LIMIT_INPUT_PIXELS,
  })
    .composite(overlays)
    .png({ compressionLevel: 6 })
    .toBuffer({ resolveWithObject: true })

  mkdirSync(path.dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, outPng.data)

  return {
    outputPath: options.outputPath,
    width: outPng.info.width,
    height: outPng.info.height,
    bytes: outPng.data.byteLength,
    sha256: createHash('sha256').update(outPng.data).digest('hex'),
    badges: placed,
    elapsedMs: Date.now() - started,
  }
}

/** Extract dominant color locally via sharp (1x1 average) when model lacks `image` modality. */
export async function extractDominantColorHex(input: string | Buffer): Promise<string> {
  const buf = readInputBuffer(input)
  detectAllowedRasterFormat(buf)
  const { data } = await sharp(buf, {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .resize(1, 1, { fit: 'cover' })
    .toColorspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const r = (data[0] ?? 15).toString(16).padStart(2, '0')
  const g = (data[1] ?? 118).toString(16).padStart(2, '0')
  const b = (data[2] ?? 110).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

import { createHash } from 'node:crypto'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'

export interface ZipBombQuotas {
  readonly maxEntries: number
  readonly maxSingleFileBytes: number
  readonly maxTotalBytes: number
  readonly maxCompressionRatio: number
}

export const DEFAULT_ZIP_QUOTAS: ZipBombQuotas = {
  maxEntries: 1000,
  maxSingleFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxCompressionRatio: 100,
}

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export class DocxBlockedError extends Error {
  readonly code:
    | 'LEGACY_DOC_FORMAT'
    | 'ENCRYPTED_DOCX'
    | 'INVALID_ZIP'
    | 'ZIP_BOMB_QUOTA'
    | 'XXE_FORBIDDEN'
    | 'SCANNED_OR_EMPTY_DOCX'

  constructor(code: DocxBlockedError['code'], message: string) {
    super(message)
    this.name = 'DocxBlockedError'
    this.code = code
  }
}

export interface OoxmlBlockAnchor {
  readonly docSha256: string
  readonly blockPath: string
  readonly excerptHash: string
  readonly bookmarkName: string
  readonly paraId?: string
  readonly text: string
  readonly sourcePart: string
}

export interface ParsedOoxmlDocument {
  readonly docSha256: string
  readonly blocks: readonly OoxmlBlockAnchor[]
  readonly sanitizedPreviewDocx: Uint8Array
  readonly strippedExternalRels: number
  readonly strippedAltChunks: number
  readonly strippedDangerousFields: number
  readonly ignoredDeletedRuns: number
  readonly embeddedDrawingCount: number
  readonly mixedImageScoreTableWarning: string | null
}

/**
 * Inspect ZIP Central Directory headers BEFORE inflating anything so a ZIP bomb
 * cannot OOM the Host process before quotas are checked.
 */
export function precheckZipCentralDirectory(buf: Uint8Array, quotas: ZipBombQuotas = DEFAULT_ZIP_QUOTAS): void {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from tail
  const minPos = Math.max(0, buf.byteLength - 65557)
  let eocdOffset = -1
  for (let i = buf.byteLength - 22; i >= minPos; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset === -1) {
    throw new DocxBlockedError('INVALID_ZIP', 'File is not a valid ZIP/OOXML container (missing EOCD)')
  }
  const totalEntries = view.getUint16(eocdOffset + 10, true)
  if (totalEntries > quotas.maxEntries) {
    throw new DocxBlockedError('ZIP_BOMB_QUOTA', `ZIP entry count ${totalEntries} exceeds quota ${quotas.maxEntries}`)
  }
  const cdSize = view.getUint32(eocdOffset + 12, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  if (cdOffset + cdSize > buf.byteLength) {
    throw new DocxBlockedError('INVALID_ZIP', 'Corrupt ZIP central directory bounds')
  }
  let pos = cdOffset
  let totalUncompressed = 0
  let seen = 0
  while (pos < cdOffset + cdSize && seen < totalEntries) {
    if (pos + 46 > buf.byteLength || view.getUint32(pos, true) !== 0x02014b50) {
      throw new DocxBlockedError('INVALID_ZIP', 'Corrupt ZIP central directory header')
    }
    const compSize = view.getUint32(pos + 20, true)
    const uncompSize = view.getUint32(pos + 24, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const nameBytes = buf.subarray(pos + 46, pos + 46 + nameLen)
    const name = strFromU8(nameBytes)
    if (name.startsWith('/') || name.startsWith('\\') || name.includes('..')) {
      throw new DocxBlockedError('INVALID_ZIP', `Unsafe ZIP entry path rejected: ${name}`)
    }
    if (uncompSize > quotas.maxSingleFileBytes) {
      throw new DocxBlockedError(
        'ZIP_BOMB_QUOTA',
        `ZIP entry "${name}" uncompressed size ${uncompSize} exceeds limit ${quotas.maxSingleFileBytes}`,
      )
    }
    if (compSize > 0 && uncompSize / compSize > quotas.maxCompressionRatio && uncompSize > 1024 * 1024) {
      throw new DocxBlockedError(
        'ZIP_BOMB_QUOTA',
        `ZIP entry "${name}" compression ratio ${(uncompSize / compSize).toFixed(1)}x exceeds limit ${quotas.maxCompressionRatio}x`,
      )
    }
    totalUncompressed += uncompSize
    if (totalUncompressed > quotas.maxTotalBytes) {
      throw new DocxBlockedError(
        'ZIP_BOMB_QUOTA',
        `Total uncompressed size ${totalUncompressed} exceeds quota ${quotas.maxTotalBytes}`,
      )
    }
    pos += 46 + nameLen + extraLen + commentLen
    seen += 1
  }
}

export function isDangerousUri(uri: string): boolean {
  const trimmed = uri.trim()
  if (/^(?:javascript|vbscript|file|data):/i.test(trimmed)) return true
  // Windows UNC paths (\\server\share or //server/share) leak SMB/NTLM credentials
  if (/^(?:\\\\|\/\/)/.test(trimmed)) return true
  return false
}

function assertNoXxe(xml: string, partName: string): void {
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new DocxBlockedError('XXE_FORBIDDEN', `XML DTD/ENTITY declarations are forbidden in ${partName}`)
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'')
    .replaceAll('&amp;', '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
}

function sanitizeRelsXml(xml: string): { readonly xml: string; readonly stripped: number } {
  let stripped = 0
  const cleaned = xml.replace(/<Relationship\b[^>]*\/?>/gi, (tag) => {
    const isExternal = /\bTargetMode\s*=\s*["']External["']/i.test(tag)
    const targetMatch = /\bTarget\s*=\s*["']([^"']*)["']/i.exec(tag)
    const target = targetMatch?.[1] ?? ''
    if (isExternal || isDangerousUri(target)) {
      stripped += 1
      return ''
    }
    return tag
  })
  return { xml: cleaned, stripped }
}

function sanitizePartXml(xml: string): {
  readonly xml: string
  readonly strippedAltChunks: number
  readonly strippedDangerousFields: number
  readonly ignoredDeletedRuns: number
} {
  let strippedAltChunks = 0
  let strippedDangerousFields = 0
  let ignoredDeletedRuns = 0

  // Strip w:altChunk (embedded HTML/external doc XSS & SSRF vector)
  let out = xml.replace(/<w:altChunk\b[^>]*(?:\/>|>[\s\S]*?<\/w:altChunk>)/gi, () => {
    strippedAltChunks += 1
    return ''
  })

  // Strip dangerous Word fields: INCLUDETEXT, INCLUDEPICTURE, LINK, or HYPERLINK to unsafe URI/UNC
  out = out.replace(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/gi, (full, body: string) => {
    if (/\b(?:INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK|DDE|DDEAUTO)\b/i.test(body)) {
      strippedDangerousFields += 1
      return ''
    }
    const hyperlink = /\bHYPERLINK\s+["']?([^\s"']+)/i.exec(body)
    if (hyperlink?.[1] && isDangerousUri(hyperlink[1])) {
      strippedDangerousFields += 1
      return ''
    }
    return full
  })
  out = out.replace(/<w:fldSimple\b([^>]*)>([\s\S]*?)<\/w:fldSimple>/gi, (full, attrs: string) => {
    const instrMatch = /\bw:instr\s*=\s*["']([^"']*)["']/i.exec(attrs)
    const instr = instrMatch?.[1] ?? ''
    if (/\b(?:INCLUDETEXT|INCLUDEPICTURE|IMPORT|LINK|DDE|DDEAUTO)\b/i.test(instr)) {
      strippedDangerousFields += 1
      return ''
    }
    const hyperlink = /\bHYPERLINK\s+["']?([^\s"']+)/i.exec(instr)
    if (hyperlink?.[1] && isDangerousUri(hyperlink[1])) {
      strippedDangerousFields += 1
      return ''
    }
    return full
  })

  // Count w:del blocks (we preserve sanitized XML structure or strip deletions during text extraction)
  out.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gi, () => {
    ignoredDeletedRuns += 1
    return ''
  })

  return { xml: out, strippedAltChunks, strippedDangerousFields, ignoredDeletedRuns }
}

/** Extract visible text from a `<w:p>` fragment, strictly ignoring `<w:del>` tracked deletions. */
function extractParagraphText(pXml: string): string {
  const withoutDel = pXml
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gi, '')
    .replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/gi, '')
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi, '')
  const pieces: string[] = []
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(withoutDel)) !== null) {
    if (match[1] !== undefined) {
      pieces.push(decodeXmlEntities(match[1]))
    } else if (match[0].toLowerCase().startsWith('<w:tab')) {
      pieces.push('\t')
    } else {
      pieces.push('\n')
    }
  }
  return pieces.join('').replace(/\s+/g, ' ').trim()
}

interface RawExtractedParagraph {
  readonly blockPath: string
  readonly text: string
  readonly paraId?: string
  readonly sourcePart: string
  /** Byte offset in the part XML right after `<w:p...>` opening tag for deterministic bookmark injection. */
  readonly insertOffset: number
}

/**
 * Lightweight deterministic OOXML recursive walker covering:
 * - body/p[i]
 * - body/tbl[i]/tr[j]/tc[k]/p[m] (and nested tables & merged cells)
 * - body/sdt[i]/... (content controls)
 * - headerN/p[i], footerN/p[i]
 */
function walkOoxmlContainer(
  xml: string,
  rootPrefix: string,
  sourcePart: string,
): RawExtractedParagraph[] {
  const results: RawExtractedParagraph[] = []
  const tagRe = /<(\/?)w:(body|p|tbl|tr|tc|sdt|sdtContent|txbxContent)\b([^>]*)(\/?)>/g

  interface Frame {
    readonly tag: string
    readonly pathSegment: string | null
    readonly counts: Record<string, number>
    readonly startOffset: number
    readonly openEndOffset: number
    readonly attrs: string
  }

  const stack: Frame[] = []
  let insideBodyOrRoot = rootPrefix !== 'body'
  let match: RegExpExecArray | null

  const currentPrefix = (): string => {
    const segs = [rootPrefix]
    for (const f of stack) {
      if (f.pathSegment !== null) segs.push(f.pathSegment)
    }
    return segs.join('/')
  }

  const rootCounts: Record<string, number> = {}

  while ((match = tagRe.exec(xml)) !== null) {
    const isClose = match[1] === '/'
    const tag = match[2]!
    const attrs = match[3] ?? ''
    const isSelfClosing = match[4] === '/'
    const matchStart = match.index
    const matchEnd = tagRe.lastIndex

    if (tag === 'body') {
      if (!isClose && !isSelfClosing) insideBodyOrRoot = true
      else if (isClose) insideBodyOrRoot = false
      continue
    }
    if (!insideBodyOrRoot) continue

    if (!isClose) {
      const parentCounts = stack.length > 0 ? stack[stack.length - 1]!.counts : rootCounts
      let seg: string | null = null
      if (tag === 'p' || tag === 'tbl' || tag === 'tr' || tag === 'tc' || tag === 'sdt') {
        const idx = parentCounts[tag] ?? 0
        parentCounts[tag] = idx + 1
        seg = `${tag}[${idx}]`
      } else if (tag === 'txbxContent') {
        const idx = parentCounts[tag] ?? 0
        parentCounts[tag] = idx + 1
        seg = `sdt[${idx}]`
      }
      if (!isSelfClosing) {
        stack.push({
          tag,
          pathSegment: seg,
          counts: {},
          startOffset: matchStart,
          openEndOffset: matchEnd,
          attrs,
        })
      }
    } else {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i]!.tag === tag) {
          const popped = stack.splice(i)[0]!
          if (popped.tag === 'p') {
            const pXml = xml.slice(popped.startOffset, matchEnd)
            const text = extractParagraphText(pXml)
            if (text.length > 0) {
              const paraIdMatch = /\bw14:paraId\s*=\s*["']([0-9A-Fa-f]{1,8})["']/.exec(popped.attrs)
              const prefix = currentPrefix()
              const blockPath = popped.pathSegment ? `${prefix}/${popped.pathSegment}` : prefix
              results.push({
                blockPath,
                text,
                paraId: paraIdMatch?.[1],
                sourcePart,
                insertOffset: popped.openEndOffset,
              })
            }
          }
          break
        }
      }
    }
  }
  return results
}

function injectDeterministicBookmarks(
  xml: string,
  paragraphs: readonly { readonly insertOffset: number; readonly bookmarkId: number; readonly bookmarkName: string }[],
): string {
  if (paragraphs.length === 0) return xml
  const sorted = [...paragraphs].sort((a, b) => b.insertOffset - a.insertOffset)
  let out = xml
  for (const p of sorted) {
    const marker = `<w:bookmarkStart w:id="${p.bookmarkId}" w:name="${p.bookmarkName}"/><w:bookmarkEnd w:id="${p.bookmarkId}"/>`
    out = out.slice(0, p.insertOffset) + marker + out.slice(p.insertOffset)
  }
  return out
}

/**
 * Parse, sanitize, verify, and anchor an untrusted `.docx` buffer.
 * Blocks legacy `.doc`, encrypted OOXML, ZIP bombs, XXE, and scanned/textless DOCX.
 */
export function parseAndSanitizeDocx(
  input: Buffer | Uint8Array,
  quotas: ZipBombQuotas = DEFAULT_ZIP_QUOTAS,
): ParsedOoxmlDocument {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < 8) {
    throw new DocxBlockedError('INVALID_ZIP', 'File is too small to be a valid DOCX document')
  }
  if (Buffer.from(bytes.subarray(0, 8)).equals(OLE2_MAGIC)) {
    throw new DocxBlockedError(
      'LEGACY_DOC_FORMAT',
      '检测到旧版二进制 .doc 或受密码加密的 Office 文件，请先在 Word 中另存为未加密的 .docx 后再导入。',
    )
  }
  if (!Buffer.from(bytes.subarray(0, 4)).equals(ZIP_MAGIC)) {
    throw new DocxBlockedError('INVALID_ZIP', '文件不是有效的 .docx（缺少 ZIP 魔数头）。')
  }

  precheckZipCentralDirectory(bytes, quotas)
  const docSha256 = createHash('sha256').update(bytes).digest('hex')

  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    throw new DocxBlockedError('INVALID_ZIP', `Failed to unzip DOCX: ${error instanceof Error ? error.message : String(error)}`)
  }

  if ('EncryptionInfo' in entries || 'EncryptedPackage' in entries) {
    throw new DocxBlockedError('ENCRYPTED_DOCX', '检测到加密的 .docx 文件，请先解除文档密码保护后再导入。')
  }
  if (!('word/document.xml' in entries)) {
    throw new DocxBlockedError('INVALID_ZIP', 'ZIP 归档缺少 word/document.xml，不是有效的 Word 文档。')
  }

  // Post-inflation byte guard
  let totalBytes = 0
  for (const [name, content] of Object.entries(entries)) {
    if (content.byteLength > quotas.maxSingleFileBytes) {
      throw new DocxBlockedError('ZIP_BOMB_QUOTA', `Inflated entry ${name} exceeds maxSingleFileBytes`)
    }
    totalBytes += content.byteLength
    if (totalBytes > quotas.maxTotalBytes) {
      throw new DocxBlockedError('ZIP_BOMB_QUOTA', `Total inflated bytes exceed maxTotalBytes`)
    }
  }

  let strippedExternalRels = 0
  let strippedAltChunks = 0
  let strippedDangerousFields = 0
  let ignoredDeletedRuns = 0
  let embeddedDrawingCount = 0

  const sanitizedEntries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(entries)) {
    // Strip embedded OLE, ActiveX, VBA macros
    if (/^word\/(?:vbaProject\.bin|embeddings\/|activeX\/)/i.test(name)) {
      strippedAltChunks += 1
      continue
    }
    if (name.endsWith('.rels')) {
      const xml = strFromU8(content)
      assertNoXxe(xml, name)
      const res = sanitizeRelsXml(xml)
      strippedExternalRels += res.stripped
      sanitizedEntries[name] = strToU8(res.xml)
      continue
    }
    if (name.endsWith('.xml')) {
      const xml = strFromU8(content)
      assertNoXxe(xml, name)
      if (name === 'word/document.xml' || /^word\/(?:header|footer)\d*\.xml$/i.test(name)) {
        const res = sanitizePartXml(xml)
        strippedAltChunks += res.strippedAltChunks
        strippedDangerousFields += res.strippedDangerousFields
        ignoredDeletedRuns += res.ignoredDeletedRuns
        const drawingMatches = res.xml.match(/<w:drawing\b|<v:imagedata\b|<w:pict\b/gi)
        embeddedDrawingCount += drawingMatches?.length ?? 0
        sanitizedEntries[name] = strToU8(res.xml)
      } else {
        sanitizedEntries[name] = content
      }
      continue
    }
    sanitizedEntries[name] = content
  }

  const allBlocks: OoxmlBlockAnchor[] = []
  let bookmarkSeq = 1000

  const partsToIndex: { readonly part: string; readonly prefix: string }[] = [
    { part: 'word/document.xml', prefix: 'body' },
  ]
  const extraParts = Object.keys(sanitizedEntries)
    .filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name))
    .sort()
  for (const part of extraParts) {
    const base = part.replace(/^word\//, '').replace(/\.xml$/i, '').toLowerCase()
    partsToIndex.push({ part, prefix: base })
  }

  for (const { part, prefix } of partsToIndex) {
    const partBytes = sanitizedEntries[part]
    if (!partBytes) continue
    const xml = strFromU8(partBytes)
    const rawParagraphs = walkOoxmlContainer(xml, prefix, part)
    const bookmarkJobs: { insertOffset: number; bookmarkId: number; bookmarkName: string }[] = []

    for (const p of rawParagraphs) {
      const bookmarkId = bookmarkSeq
      bookmarkSeq += 1
      const bookmarkName = `dsh-blk-${bookmarkId}`
      const excerptHash = createHash('sha256').update(p.text).digest('hex').slice(0, 12)
      allBlocks.push({
        docSha256,
        blockPath: p.blockPath,
        excerptHash,
        bookmarkName,
        paraId: p.paraId,
        text: p.text,
        sourcePart: p.sourcePart,
      })
      bookmarkJobs.push({ insertOffset: p.insertOffset, bookmarkId, bookmarkName })
    }

    sanitizedEntries[part] = strToU8(injectDeterministicBookmarks(xml, bookmarkJobs))
  }

  const totalTextChars = allBlocks.reduce((sum, b) => sum + b.text.replace(/\s+/g, '').length, 0)
  if (totalTextChars < 5) {
    throw new DocxBlockedError(
      'SCANNED_OR_EMPTY_DOCX',
      '检测到扫描型或无文本层的 .docx 文档（可提取文本不足），已阻断解析并拒绝生成空响应表。请先完成 OCR 识别后再导入。',
    )
  }

  let mixedImageScoreTableWarning: string | null = null
  const mentionsScore = allBlocks.some((b) => /评分|分值|scoring|evaluation/i.test(b.text))
  const hasTableBlocks = allBlocks.some((b) => b.blockPath.includes('/tbl['))
  if (embeddedDrawingCount > 0 && mentionsScore && !hasTableBlocks) {
    mixedImageScoreTableWarning =
      `文档包含 ${embeddedDrawingCount} 处内嵌图片且提及评分项，但未检测到结构化文字评分表，关键评分表可能为贴图，请人工核对原件。`
  }

  const sanitizedPreviewDocx = zipSync(sanitizedEntries, { level: 6 })
  return {
    docSha256,
    blocks: allBlocks,
    sanitizedPreviewDocx,
    strippedExternalRels,
    strippedAltChunks,
    strippedDangerousFields,
    ignoredDeletedRuns,
    embeddedDrawingCount,
    mixedImageScoreTableWarning,
  }
}

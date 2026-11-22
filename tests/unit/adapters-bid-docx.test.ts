import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import {
  analyzeBidDocument,
  buildBidResponseDocx,
  buildOpaqueDocxSandbox,
  parseAndSanitizeDocx,
  sanitizePreviewCss,
  verifyExportedDocx,
} from '@dsh-self/adapters/bid-docx'

const FIXTURES = path.resolve('fixtures/docx')

describe('bid-docx adapter security, parsing, sandbox viewer & round-trip export', () => {
  it('parses valid bid DOCX, ignores <w:del>, extracts anchors, and exports verified reopenable DOCX', () => {
    const bytes = new Uint8Array(readFileSync(path.join(FIXTURES, 'valid-bid.docx')))
    const parsed = parseAndSanitizeDocx(bytes)
    expect(parsed.blocks.some((b) => b.text.includes('2025-01-01'))).toBe(false) // <w:del> ignored!
    expect(parsed.blocks.some((b) => b.text.includes('2026-12-20 14:30'))).toBe(true)

    const analysis = analyzeBidDocument(parsed, { projectId: 'p1', fileName: 'valid-bid.docx' })
    expect(analysis.deadlines.length).toBe(1)
    expect(analysis.scoringItems.length).toBe(1)
    expect(analysis.missingMaterials.length).toBe(1)

    const outBytes = buildBidResponseDocx(analysis)
    const verified = verifyExportedDocx(outBytes, ['2026-12-20', 'ISO 27001', '40分'])
    expect(verified.ok).toBe(true)
    expect(verified.missingSnippets).toEqual([])
    expect(verified.documentXmlBytes).toBeGreaterThan(200)
  })

  it('blocks legacy .doc, encrypted DOCX, scanned DOCX, and ZIP-bombs before full extraction', () => {
    const legacy = new Uint8Array(readFileSync(path.join(FIXTURES, 'legacy.doc')))
    expect(() => parseAndSanitizeDocx(legacy)).toThrow(/\.doc|OLE2|另存为/i)

    const encrypted = new Uint8Array(readFileSync(path.join(FIXTURES, 'encrypted.docx')))
    expect(() => parseAndSanitizeDocx(encrypted)).toThrow(/加密|encrypted/i)

    const scanned = new Uint8Array(readFileSync(path.join(FIXTURES, 'scanned-bid.docx')))
    expect(() => parseAndSanitizeDocx(scanned)).toThrow(/扫描|OCR|纯图片/i)

    // Construct a high compression-ratio ZIP bomb (>100x ratio, 25 MB zeros compressed to ~25 KB)
    const bombBytes = zipSync({ 'word/document.xml': new Uint8Array(25 * 1024 * 1024) }, { level: 9 })
    expect(() => parseAndSanitizeDocx(bombBytes)).toThrow(/bomb|压缩比|ratio|size/i)
  })

  it('emits mixed text+image score-table warning and strips external rels / altChunk / UNC paths', () => {
    const mixed = new Uint8Array(readFileSync(path.join(FIXTURES, 'mixed-score-table.docx')))
    const parsedMixed = parseAndSanitizeDocx(mixed)
    expect(parsedMixed.mixedImageScoreTableWarning).toBeTruthy()

    const malicious = new Uint8Array(readFileSync(path.join(FIXTURES, 'xss-external.docx')))
    const parsedMal = parseAndSanitizeDocx(malicious)
    expect(parsedMal.strippedAltChunks).toBeGreaterThanOrEqual(1)
    expect(parsedMal.strippedExternalRels).toBeGreaterThanOrEqual(1)
  })

  it('builds Option B opaque-origin srcdoc iframe with random nonce CSP & CSS sanitization', () => {
    const safeCss = sanitizePreviewCss('.t{color:#0f766e} @import url(https://evil.test/a.css); body{background:url(https://evil.test/bg.png)}')
    expect(safeCss).toContain('.t{color:#0f766e}')
    expect(safeCss).not.toContain('evil.test')

    const doc = buildOpaqueDocxSandbox({
      sanitizedHtml: '<p class="t" id="dsh-blk-1">安全正文</p>',
      sanitizedCss: safeCss,
    })
    expect(doc.sandboxAttr).toBe('allow-scripts')
    expect(doc.csp).toContain(`script-src 'nonce-${doc.nonce}'`)
    expect(doc.csp).toContain("default-src 'none'")
    expect(doc.csp).toContain("connect-src 'none'")
    expect(doc.srcdoc).toContain('.t{color:#0f766e}')
    expect(doc.srcdoc).not.toContain('allow-same-origin')
  })
})

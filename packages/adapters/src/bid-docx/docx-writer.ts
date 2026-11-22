import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import type { BidProjectAnalysis } from './bid-analyzer.js'

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;')
}

function paragraphXml(text: string, bold = false): string {
  const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : ''
  return `<w:p><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

function tableRowXml(cells: readonly string[], isHeader = false): string {
  const cellXml = cells
    .map((cell) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${paragraphXml(cell, isHeader)}</w:tc>`)
    .join('')
  return `<w:tr>${cellXml}</w:tr>`
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOC_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`

/** Build a clean, valid, reopenable `.docx` response table from a BidProjectAnalysis. */
export function buildBidResponseDocx(analysis: BidProjectAnalysis): Uint8Array {
  const rows: string[] = [
    tableRowXml(['编号', '招标要求/评分项', '原文定位锚点', '逐条响应草稿'], true),
  ]
  for (const item of analysis.scoringItems) {
    rows.push(
      tableRowXml([
        item.id,
        item.title,
        `${item.anchor.blockPath} (${item.anchor.excerptHash})`,
        item.responseDraft,
      ]),
    )
  }
  for (const mat of analysis.missingMaterials) {
    rows.push(
      tableRowXml([
        mat.id,
        mat.requirement,
        `${mat.anchor.blockPath} (${mat.anchor.excerptHash})`,
        mat.status === 'missing' ? '【待补齐资质】请上传对应有效扫描件。' : '已齐备。',
      ]),
    )
  }

  const deadlineLines = analysis.deadlines.map(
    (d) => paragraphXml(`截止日期：${d.dateText} — ${d.summary} [${d.anchor.blockPath}]`),
  )

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphXml(`投标逐条响应草稿 — ${analysis.fileName}`, true)}
    ${paragraphXml(`源文件摘要：${analysis.docSha256}`)}
    ${deadlineLines.join('\n    ')}
    <w:tbl>
      <w:tblPr><w:tblW w:w="9000" w:type="dxa"/></w:tblPr>
      ${rows.join('\n      ')}
    </w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>`

  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_XML),
    '_rels/.rels': strToU8(ROOT_RELS_XML),
    'word/document.xml': strToU8(documentXml),
    'word/_rels/document.xml.rels': strToU8(DOC_RELS_XML),
    'word/styles.xml': strToU8(STYLES_XML),
  }, { level: 6 })
}

/** Independently unzip and re-read `word/document.xml` to verify exported DOCX integrity. */
export function verifyExportedDocx(
  docxBytes: Uint8Array,
  expectedSnippets: readonly string[],
): { readonly ok: boolean; readonly missingSnippets: readonly string[]; readonly documentXmlBytes: number } {
  const unpacked = unzipSync(docxBytes)
  const docEntry = unpacked['word/document.xml']
  if (!docEntry) {
    return { ok: false, missingSnippets: [...expectedSnippets], documentXmlBytes: 0 }
  }
  const xml = strFromU8(docEntry)
  const missing = expectedSnippets.filter((snippet) => !xml.includes(escapeXml(snippet)))
  return {
    ok: missing.length === 0,
    missingSnippets: missing,
    documentXmlBytes: docEntry.byteLength,
  }
}

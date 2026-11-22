import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { analyzeBidDocument, type BidProjectAnalysis } from './bid-analyzer.js'
import { buildBidResponseDocx, verifyExportedDocx } from './docx-writer.js'
import { parseAndSanitizeDocx, type ParsedOoxmlDocument } from './ooxml-safe.js'

export * from './ooxml-safe.js'
export * from './bid-analyzer.js'
export * from './docx-writer.js'
export * from './sandbox-viewer.js'

export const BID_PROJECTS_DIRNAME = '.dsh-bid-projects'

export interface ImportedBidProject {
  readonly analysis: BidProjectAnalysis
  readonly parsed: ParsedOoxmlDocument
  readonly projectDir: string
  readonly sanitizedPreviewPath: string
  readonly metadataPath: string
}

export function importBidDocxIntoWorkspace(options: {
  readonly workspaceDir: string
  readonly fileName: string
  readonly docxBuffer: Buffer | Uint8Array
  readonly projectId?: string
}): ImportedBidProject {
  const parsed: ParsedOoxmlDocument = parseAndSanitizeDocx(options.docxBuffer)
  const projectId = options.projectId ?? randomUUID()
  const safeBase = path.basename(options.fileName).replace(/[\\/:*?"<>|]/g, '_')
  const analysis = analyzeBidDocument(parsed, { projectId, fileName: safeBase })

  const projectDir = path.join(options.workspaceDir, BID_PROJECTS_DIRNAME, projectId)
  mkdirSync(projectDir, { recursive: true })
  const sanitizedPreviewPath = path.join(projectDir, 'preview-sanitized.docx')
  const metadataPath = path.join(projectDir, 'project.json')
  writeFileSync(sanitizedPreviewPath, parsed.sanitizedPreviewDocx)
  writeFileSync(metadataPath, `${JSON.stringify({ analysis, blocks: parsed.blocks }, undefined, 2)}\n`)

  return { analysis, parsed, projectDir, sanitizedPreviewPath, metadataPath }
}

export function exportBidResponseToWorkspace(options: {
  readonly workspaceDir: string
  readonly projectId: string
  readonly outputRelPath?: string
}): { readonly outputPath: string; readonly bytes: number; readonly verified: boolean } {
  const metadataPath = path.join(options.workspaceDir, BID_PROJECTS_DIRNAME, options.projectId, 'project.json')
  if (!existsSync(metadataPath)) {
    throw new Error(`Bid project not found: ${options.projectId}`)
  }
  const stored = JSON.parse(readFileSync(metadataPath, 'utf8')) as { analysis: BidProjectAnalysis }
  const docxBytes = buildBidResponseDocx(stored.analysis)
  const expectedSnippets = [
    stored.analysis.fileName,
    ...stored.analysis.scoringItems.map((s) => s.id),
    ...stored.analysis.missingMaterials.map((m) => m.id),
  ]
  const verification = verifyExportedDocx(docxBytes, expectedSnippets)
  if (!verification.ok) {
    throw new Error(`Exported DOCX failed round-trip verification; missing: ${verification.missingSnippets.join(', ')}`)
  }
  const rel = options.outputRelPath ?? path.join('responses', `${stored.analysis.projectId}-response.docx`)
  const outputPath = path.resolve(options.workspaceDir, rel)
  const resolvedRoot = path.resolve(options.workspaceDir)
  if (!outputPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Output path escapes workspace directory')
  }
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, docxBytes)
  return { outputPath, bytes: docxBytes.byteLength, verified: true }
}

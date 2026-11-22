import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  AnnotationsFileSchema,
  exportAnnotatedPng,
  generatePreviewProxy,
  inspectRasterImage,
  type AnnotationPoint,
  type AnnotationsFile,
  type ExportAnnotatedPngResult,
} from './image-processor.js'

export * from './vector-badges.js'
export * from './image-processor.js'

export const DESIGN_PROJECTS_DIRNAME = '.dsh-design-projects'

export interface ImportedDesignProject {
  readonly projectId: string
  readonly projectDir: string
  readonly originalPath: string
  readonly proxyPath: string
  readonly annotationsPath: string
  readonly annotationsFile: AnnotationsFile
  readonly proxyDims: { readonly width: number; readonly height: number; readonly scale: number }
}

/** Import artwork read-only into workspace, generate bounded preview proxy, init `.annotations.json`. */
export async function importDesignArtwork(options: {
  readonly workspaceDir: string
  readonly sourceImagePath: string
  readonly projectId?: string
}): Promise<ImportedDesignProject> {
  const info = await inspectRasterImage(options.sourceImagePath)
  const projectId = options.projectId ?? randomUUID()
  const projectDir = path.join(options.workspaceDir, DESIGN_PROJECTS_DIRNAME, projectId)
  mkdirSync(projectDir, { recursive: true })

  const ext = info.format === 'jpeg' ? '.jpg' : `.${info.format}`
  const originalFileName = path.basename(options.sourceImagePath).replace(/[\\/:*?"<>|]/g, '_')
  const originalPath = path.join(projectDir, `original${ext}`)
  copyFileSync(options.sourceImagePath, originalPath)

  const proxy = await generatePreviewProxy(originalPath)
  const proxyPath = path.join(projectDir, 'preview-proxy.png')
  writeFileSync(proxyPath, proxy.buffer)

  const annotationsFile: AnnotationsFile = {
    schemaVersion: 1,
    imageSha256: info.sha256,
    originalFileName,
    effectiveWidth: info.effectiveWidth,
    effectiveHeight: info.effectiveHeight,
    exifOrientation: info.exifOrientation,
    annotations: [],
  }
  const annotationsPath = path.join(projectDir, '.annotations.json')
  writeFileSync(annotationsPath, `${JSON.stringify(annotationsFile, undefined, 2)}\n`)

  return {
    projectId,
    projectDir,
    originalPath,
    proxyPath,
    annotationsPath,
    annotationsFile,
    proxyDims: { width: proxy.width, height: proxy.height, scale: proxy.scale },
  }
}

export function saveDesignAnnotations(options: {
  readonly workspaceDir: string
  readonly projectId: string
  readonly annotations: readonly AnnotationPoint[]
}): AnnotationsFile {
  const annotationsPath = path.join(
    options.workspaceDir,
    DESIGN_PROJECTS_DIRNAME,
    options.projectId,
    '.annotations.json',
  )
  if (!existsSync(annotationsPath)) {
    throw new Error(`Design project not found: ${options.projectId}`)
  }
  const current = AnnotationsFileSchema.parse(JSON.parse(readFileSync(annotationsPath, 'utf8')))
  const updated = AnnotationsFileSchema.parse({
    ...current,
    annotations: options.annotations,
  })
  writeFileSync(annotationsPath, `${JSON.stringify(updated, undefined, 2)}\n`)
  return updated
}

export async function exportDesignProjectPng(options: {
  readonly workspaceDir: string
  readonly projectId: string
  readonly outputRelPath?: string
}): Promise<ExportAnnotatedPngResult> {
  const projectDir = path.join(options.workspaceDir, DESIGN_PROJECTS_DIRNAME, options.projectId)
  const annotationsPath = path.join(projectDir, '.annotations.json')
  if (!existsSync(annotationsPath)) {
    throw new Error(`Design project not found: ${options.projectId}`)
  }
  const stored = AnnotationsFileSchema.parse(JSON.parse(readFileSync(annotationsPath, 'utf8')))
  const originalCandidates = ['original.png', 'original.jpg', 'original.webp']
    .map((f) => path.join(projectDir, f))
  const originalPath = originalCandidates.find((p) => existsSync(p))
  if (!originalPath) {
    throw new Error(`Original artwork missing for project ${options.projectId}`)
  }
  const rel = options.outputRelPath ?? path.join('exports', `${options.projectId}-annotated.png`)
  const outputPath = path.resolve(options.workspaceDir, rel)
  const resolvedRoot = path.resolve(options.workspaceDir)
  if (!outputPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Export path escapes workspace directory')
  }
  return exportAnnotatedPng({
    input: originalPath,
    annotations: stored.annotations,
    outputPath,
  })
}

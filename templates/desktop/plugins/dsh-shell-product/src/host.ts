/**
 * `dsh-shell-product` Host plugin:
 * - Serves `/api/product-spec` (live `product.json` from `DSH_SELF_PRODUCT_DIR`)
 * - Creates default isolated workspace `~/Workspaces/<internalSlug>` via `ctx.workspaceRegistry`
 * - Exposes authenticated Host routes for Bid DOCX (`/api/dsh-self/bid/*`) and Design Canvas (`/api/dsh-self/design/*`)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { desktopCapabilities, PlatformLockSchema, ProductSpecSchema, UUID_V4_RE, type ProductSpec } from '@dsh-self/product-spec'
import {
  BID_PROJECTS_DIRNAME, buildBidResponseDocx, exportBidResponseToWorkspace, importBidDocxIntoWorkspace,
  type BidProjectAnalysis,
} from '@dsh-self/adapters/bid-docx'
import {
  DESIGN_PROJECTS_DIRNAME, exportAnnotatedPng, exportDesignProjectPng, importDesignArtwork, saveDesignAnnotations,
  type AnnotationsFile,
} from '@dsh-self/adapters/design-canvas'

interface OfficialHostConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

interface WorkspaceRegistryLike {
  list?: () => Promise<readonly { path?: string; name?: string }[]>
  create?: (dirPath: string, name?: string) => Promise<unknown>
}

export const name = 'dsh-shell-product'
export const inject = ['connection']

function loadSpecFromEnv(): ProductSpec | null {
  const dir = process.env.DSH_SELF_PRODUCT_DIR
  if (!dir) return null
  const file = path.join(dir, 'product.json')
  if (!existsSync(file)) return null
  return ProductSpecSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
}

export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as OfficialHostConnection | undefined
  if (!connection) return

  const initialSpec = loadSpecFromEnv()
  const workspacesRoot = process.env.DSH_SELF_WORKSPACES_ROOT || path.join(os.homedir(), 'Workspaces')
  const workspaceDir = initialSpec
    ? path.join(workspacesRoot, initialSpec.identity.internalSlug)
    : path.join(workspacesRoot, 'dsh-self-default')
  mkdirSync(workspaceDir, { recursive: true })

  // Register default product workspace via official workspaceRegistry if mounted
  const wsRegistry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (wsRegistry && typeof wsRegistry.create === 'function' && initialSpec) {
    void Promise.resolve(wsRegistry.list?.() ?? [])
      .then((list) => {
        const exists = list.some((w) => w.path && path.resolve(w.path) === path.resolve(workspaceDir))
        if (!exists) {
          return wsRegistry.create!(workspaceDir, initialSpec.brand.displayName.zh)
        }
        return undefined
      })
      .catch(() => {})
  }

  const disposers: (() => Promise<void>)[] = []

  // 1. Serve active product.json spec
  disposers.push(connection.fetch.register({
    path: '/api/product-spec',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const spec = loadSpecFromEnv()
      if (!spec) return Response.json({ error: 'product.json unavailable' }, { status: 404 })
      return Response.json(spec, { headers: { 'Cache-Control': 'no-store' } })
    },
  }))

  const target = process.platform === 'win32' ? 'win32-x64' : `${process.platform}-${process.arch}`
  const lockName = `plugins.${target}.lock.json`
  const root = process.env.DSH_SELF_PRODUCT_DIR ?? ''
  const lockPath = [path.join(root, lockName), path.join(root, 'locks', lockName)].find(file => existsSync(file))
  const parsedLock = lockPath ? PlatformLockSchema.parse(JSON.parse(readFileSync(lockPath, 'utf8'))) : null
  const activeProfileDir = (() => {
    const dshHome = process.env.DSH_HOME
    if (!dshHome) return null
    const userDataDir = process.env.DSH_SELF_USER_DATA_DIR
    if (userDataDir) {
      const activeFile = path.join(userDataDir, 'active-profile.json')
      if (existsSync(activeFile)) {
        try {
          const parsed = JSON.parse(readFileSync(activeFile, 'utf8')) as { active?: string }
          if (parsed.active) return path.join(dshHome, 'profiles', parsed.active)
        } catch { /* ignore */ }
      }
    }
    const profilesDir = path.join(dshHome, 'profiles')
    if (!existsSync(profilesDir)) return null
    const slots = readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory())
    return slots.length === 1 ? path.join(profilesDir, slots[0]!.name) : null
  })()
  const resolvedCaps = initialSpec && parsedLock ? desktopCapabilities(initialSpec, parsedLock) : null
  const installedExternalBundles: string[] = []
  const extraBundles: { readonly packageName: string; readonly version: string; readonly sourceKind: string; readonly description?: string }[] = []
  const actions = new Set(resolvedCaps ? resolvedCaps.actions : [])
  if (parsedLock && activeProfileDir) {
    for (const plugin of parsedLock.plugins) {
      if (plugin.sourceKind === 'builtin') continue
      const pkgManifest = path.join(activeProfileDir, 'node_modules', ...plugin.packageName.split('/'), 'package.json')
      if (existsSync(pkgManifest)) {
        installedExternalBundles.push(plugin.packageName)
        let description: string | undefined
        try {
          const parsedPkg = JSON.parse(readFileSync(pkgManifest, 'utf8')) as { description?: string }
          if (typeof parsedPkg.description === 'string' && parsedPkg.description.trim()) {
            description = parsedPkg.description.trim().slice(0, 220)
          }
        } catch { /* ignore */ }
        extraBundles.push({
          packageName: plugin.packageName,
          version: plugin.version,
          sourceKind: plugin.sourceKind,
          ...(description ? { description } : {}),
        })
      } else {
        for (const act of plugin.providesActions) actions.delete(act)
      }
    }
  }
  function register(route: string, method: 'GET' | 'POST', handle: (req: Request) => unknown | Promise<unknown>) {
    disposers.push(connection!.fetch.register({
      path: '/api/dsh-self/' + route, methods: [method], requestBody: 'buffered',
      fetch: async req => {
        try { return Response.json(await handle(req), { headers: { 'Cache-Control': 'no-store' } }) }
        catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 }) }
      },
    }))
  }
  function projectFile(folder: string, id: string, name: string) {
    if (!UUID_V4_RE.test(id)) throw new Error('Invalid project ID')
    return path.join(workspaceDir, folder, id, name)
  }
  function listed<T>(folder: string, name: string, summarize: (data: T, id: string) => { id: string; name: string }) {
    const dir = path.join(workspaceDir, folder)
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).filter(entry =>
      entry.isDirectory() && UUID_V4_RE.test(entry.name) && existsSync(projectFile(folder, entry.name, name))
    ).map(entry => summarize(JSON.parse(readFileSync(projectFile(folder, entry.name, name), 'utf8')), entry.name))
  }
  const bidDir = BID_PROJECTS_DIRNAME
  const designDir = DESIGN_PROJECTS_DIRNAME
  const legacyBid = path.join(workspaceDir, bidDir, 'latest-analysis.json')
  const readBid = (id: string): { analysis: BidProjectAnalysis; blocks?: { text: string }[] } => id === 'legacy'
    ? { analysis: JSON.parse(readFileSync(legacyBid, 'utf8')) }
    : JSON.parse(readFileSync(projectFile(bidDir, id, 'project.json'), 'utf8'))
  register('capabilities', 'GET', () => ({ actions: [...actions], externalBundles: installedExternalBundles, extraBundles }))
  if (actions.has('bid.importRequirements')) {
    register('bid/projects', 'GET', req => {
      const id = new URL(req.url).searchParams.get('id')
      if (id) return readBid(id)
      const projects = listed<{ analysis: BidProjectAnalysis }>(bidDir, 'project.json', (data, id) => ({ id, name: data.analysis.fileName }))
      if (existsSync(legacyBid)) projects.push({ id: 'legacy', name: readBid('legacy').analysis.fileName })
      return { projects }
    })
    register('bid/import', 'POST', async req => {
      const body = await req.json() as { fileName?: string; base64: string; summaryOnly?: boolean }
      const imported = importBidDocxIntoWorkspace({ workspaceDir, fileName: body.fileName || 'tender.docx',
        docxBuffer: Buffer.from(body.base64, 'base64') })
      return { ok: true, projectId: imported.analysis.projectId, fileName: imported.analysis.fileName,
        analysis: imported.analysis, ...(body.summaryOnly ? {} : { parsed: imported.parsed }) }
    })
  }
  if (actions.has('bid.exportResponseDocx')) register('bid/export', 'POST', async req => {
    const body = await req.json() as { projectId?: string; analysis?: BidProjectAnalysis }
    if (body.projectId && body.projectId !== 'legacy') {
      projectFile(bidDir, body.projectId, 'project.json')
      const output = exportBidResponseToWorkspace({ workspaceDir, projectId: body.projectId })
      return { ok: true, ...output, base64: readFileSync(output.outputPath).toString('base64') }
    }
    const analysis = body.projectId === 'legacy' ? readBid('legacy').analysis : body.analysis
    if (!analysis) throw new Error('Select a bid document')
    const outputPath = path.join(workspaceDir, bidDir, 'response.docx')
    const bytes = Buffer.from(buildBidResponseDocx(analysis))
    mkdirSync(path.dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, bytes)
    return { ok: true, outputPath, bytes: bytes.length, base64: bytes.toString('base64') }
  })
  if (actions.has('calendar.addDeadline')) register('bid/calendar', 'POST', async req => {
    const body = await req.json() as { projectId: string; deadlineId: string }
    const analysis = readBid(body.projectId).analysis
    const deadline = analysis.deadlines.find(d => d.id === body.deadlineId)
    const date = deadline?.dateText.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
    if (!deadline || !date) throw new Error('Select a dated deadline')
    const day = date[1]! + date[2]!.padStart(2, '0') + date[3]!.padStart(2, '0')
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const summary = deadline.summary.replace(/\\/g, '\\\\').replace(/[\r\n]+/g, ' ').replace(/[,;]/g, char => '\\' + char)
    const calendar = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//dsh-self//Bids//EN', 'BEGIN:VEVENT',
      `UID:${analysis.projectId}-${deadline.id}@dsh-self`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day}`,
      `SUMMARY:${summary}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
    return { base64: Buffer.from(calendar).toString('base64') }
  })
  if (actions.has('design.importImage')) {
    register('design/projects', 'GET', req => {
      const id = new URL(req.url).searchParams.get('id')
      if (!id) return { projects: listed<AnnotationsFile>(designDir, '.annotations.json', (data, id) => ({ id, name: data.originalFileName })) }
      return { annotationsFile: JSON.parse(readFileSync(projectFile(designDir, id, '.annotations.json'), 'utf8')),
        proxy: readFileSync(projectFile(designDir, id, 'preview-proxy.png')).toString('base64') }
    })
    register('design/import', 'POST', async req => {
      const body = await req.json() as { fileName?: string; base64: string }
      const imported = await importDesignArtwork({ workspaceDir, fileName: body.fileName || 'artwork.png', imageBytes: Buffer.from(body.base64, 'base64') })
      return { ok: true, projectId: imported.projectId, srcPath: imported.originalPath, info: imported.info,
        proxyWidth: imported.proxyDims.width, proxyHeight: imported.proxyDims.height, scale: imported.proxyDims.scale }
    })
  }
  if (actions.has('design.saveAnnotations')) register('design/annotations', 'POST', async req => {
    const body = await req.json() as { projectId: string; annotations: AnnotationsFile['annotations'] }
    projectFile(designDir, body.projectId, '.annotations.json')
    return saveDesignAnnotations({ workspaceDir, projectId: body.projectId, annotations: body.annotations })
  })
  if (actions.has('design.exportAnnotatedPng')) register('design/export', 'POST', async req => {
    const body = await req.json() as { projectId?: string; srcPath?: string; annotations?: AnnotationsFile['annotations'] }
    const legacyDir = path.join(workspaceDir, designDir)
    if (!body.projectId && body.srcPath && path.dirname(path.resolve(body.srcPath)) === legacyDir) {
      const output = await exportAnnotatedPng({ input: body.srcPath, annotations: body.annotations ?? [],
        outputPath: path.join(legacyDir, 'annotated-export.png') })
      return { ok: true, ...output, base64: readFileSync(output.outputPath).toString('base64') }
    }
    const id = body.projectId ?? path.basename(path.dirname(body.srcPath ?? ''))
    projectFile(designDir, id, '.annotations.json')
    if (body.annotations) saveDesignAnnotations({ workspaceDir, projectId: id, annotations: body.annotations })
    const output = await exportDesignProjectPng({ workspaceDir, projectId: id })
    return { ok: true, ...output, base64: readFileSync(output.outputPath).toString('base64') }
  })

  ctx.effect(() => () => {
    for (const d of disposers) void d()
  }, 'dsh-shell-product: dispose routes')
}

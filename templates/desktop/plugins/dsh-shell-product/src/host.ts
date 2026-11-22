/**
 * `dsh-shell-product` Host plugin:
 * - Serves `/api/product-spec` (live `product.json` from `DSH_SELF_PRODUCT_DIR`)
 * - Creates default isolated workspace `~/Workspaces/<internalSlug>` via `ctx.workspaceRegistry`
 * - Exposes authenticated Host routes for Bid DOCX (`/api/dsh-self/bid/*`) and Design Canvas (`/api/dsh-self/design/*`)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ProductSpecSchema, type ProductSpec } from '@dsh-self/product-spec'
import {
  analyzeBidDocument,
  buildBidResponseDocx,
  parseAndSanitizeDocx,
  verifyExportedDocx,
} from '@dsh-self/adapters/bid-docx'
import {
  exportAnnotatedPng,
  generatePreviewProxy,
  inspectRasterImage,
  type AnnotationPoint,
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
  const workspaceDir = initialSpec
    ? path.join(os.homedir(), 'Workspaces', initialSpec.identity.internalSlug)
    : path.join(os.homedir(), 'Workspaces', 'dsh-self-default')
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

  // 2. Bid DOCX import + analysis
  disposers.push(connection.fetch.register({
    path: '/api/dsh-self/bid/import',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = (await request.json()) as { fileName?: string; base64?: string }
        if (!body.base64) return Response.json({ error: 'base64 DOCX payload required' }, { status: 400 })
        const bytes = new Uint8Array(Buffer.from(body.base64, 'base64'))
        const parsed = parseAndSanitizeDocx(bytes)
        const analysis = analyzeBidDocument(parsed, {
          projectId: initialSpec?.identity.productId ?? 'default',
          fileName: body.fileName ?? 'tender.docx',
        })
        const projDir = path.join(workspaceDir, '.dsh-bid-projects')
        mkdirSync(projDir, { recursive: true })
        writeFileSync(path.join(projDir, 'latest-analysis.json'), `${JSON.stringify(analysis, undefined, 2)}\n`)
        return Response.json({ ok: true, fileName: body.fileName ?? 'tender.docx', parsed, analysis })
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 422 })
      }
    },
  }))

  // 3. Bid DOCX response export
  disposers.push(connection.fetch.register({
    path: '/api/dsh-self/bid/export',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = (await request.json()) as { analysis: any }
        const outBytes = buildBidResponseDocx(body.analysis)
        const verified = verifyExportedDocx(outBytes, [body.analysis?.fileName ?? ''])
        const outPath = path.join(workspaceDir, '.dsh-bid-projects', 'response.docx')
        mkdirSync(path.dirname(outPath), { recursive: true })
        writeFileSync(outPath, outBytes)
        return Response.json({
          ok: true,
          outputPath: outPath,
          bytes: outBytes.byteLength,
          verified,
          base64: Buffer.from(outBytes).toString('base64'),
        })
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 422 })
      }
    },
  }))

  // 4. Design bitmap import + proxy creation
  disposers.push(connection.fetch.register({
    path: '/api/dsh-self/design/import',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = (await request.json()) as { fileName?: string; base64?: string }
        if (!body.base64) return Response.json({ error: 'base64 image payload required' }, { status: 400 })
        const buf = Buffer.from(body.base64, 'base64')
        const projDir = path.join(workspaceDir, '.dsh-design-projects')
        mkdirSync(projDir, { recursive: true })
        const srcPath = path.join(projDir, body.fileName?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'artwork.png')
        writeFileSync(srcPath, buf)
        const info = await inspectRasterImage(buf)
        const proxy = await generatePreviewProxy(buf)
        return Response.json({ ok: true, srcPath, info, proxyWidth: proxy.width, proxyHeight: proxy.height, scale: proxy.scale })
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 422 })
      }
    },
  }))

  // 5. Design bitmap export annotated PNG
  disposers.push(connection.fetch.register({
    path: '/api/dsh-self/design/export',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = (await request.json()) as { srcPath: string; annotations: AnnotationPoint[] }
        const outPath = path.join(workspaceDir, '.dsh-design-projects', 'annotated-export.png')
        const result = await exportAnnotatedPng({
          input: readFileSync(body.srcPath),
          annotations: body.annotations ?? [],
          outputPath: outPath,
        })
        return Response.json({ ok: true, ...result })
      } catch (error) {
        return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 422 })
      }
    },
  }))

  ctx.effect(() => () => {
    for (const d of disposers) void d()
  }, 'dsh-shell-product: dispose routes')
}

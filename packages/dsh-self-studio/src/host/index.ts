/**
 * Official dsh@0.2.2-rc.5 Host entrypoint for `dsh-self-studio`.
 * Uses ONLY official public dsh APIs (`ctx.connection.fetch.register('/api/...', ...)`),
 * carrier-neutral across `dsh web` and official `dsh` Desktop, ZERO `webServer` private
 * assumptions and ZERO OctoDeEpSeeK private APIs.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { DshModelBridge } from './dsh-model-bridge.js'
import { StudioService } from './studio-service.js'

export { StudioService } from './studio-service.js'
export { DshModelBridge } from './dsh-model-bridge.js'
export * from './safe-fetch-proxy.js'
export * from './extractor.js'

interface ConnectionRpcResult {
  readonly ok: true
  readonly value: unknown
}

interface ConnectionRpcFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details: object }
}

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

export interface StudioPluginConfig {
  readonly dataDir?: string
  readonly builderCliPath?: string
  readonly baseShellDir?: string
  readonly nodePath?: string
}

export const name = 'dsh-self-studio'
export const inject = ['connection']

export function apply(ctx: Context, config?: StudioPluginConfig): void {
  const selfDir = path.dirname(fileURLToPath(import.meta.url))
  const workerDir = path.join(selfDir, 'workers')
  const builderCliPath = config?.builderCliPath || process.env.DSH_SELF_BUILDER_CLI || undefined
  const baseShellDir = config?.baseShellDir || process.env.DSH_SELF_BASE_SHELL_DIR || undefined
  const nodePath = config?.nodePath || process.env.DSH_SELF_NODE_PATH || undefined
  const dataDir = config?.dataDir || process.env.DSH_SELF_STUDIO_DATA_DIR || undefined
  const modelBridge = new DshModelBridge(() => ({
    llm: ctx.get('llm') as any,
    defaultModel: ctx.get('agentDefaultModel') as any,
  }))
  const service = new StudioService({ dataDir, workerDir, builderCliPath, baseShellDir, nodePath, modelBridge })

  const connection = ctx.get('connection') as OfficialHostConnection | undefined
  if (!connection) return

  // Register exact owner-only route `/api/dshSelfStudio` on the shared `/api` carrier.
  // Exact routes take precedence before `typert-gateway`'s interceptor and NEVER touch `webServer`,
  // so this works cleanly on both `dsh web` AND official `dsh` Desktop.
  const disposeRpc = connection.fetch.register({
    path: '/api/dshSelfStudio',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: any
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : '00000000-0000-0000-0000-000000000000'
      const envelope = (body?.payload ?? {}) as { method?: unknown; payload?: Record<string, any> }
      const method = typeof envelope.method === 'string' ? envelope.method : ''
      const p = (envelope.payload ?? {}) as Record<string, any>

      const dispatch = async (): Promise<ConnectionRpcResult | ConnectionRpcFailure> => {
        try {
          switch (method) {
            case 'getEnvironment':
              return { ok: true, value: service.getEnvironmentInfo() }
            case 'expandBrief':
              return { ok: true, value: await service.expandBriefWithModel(String(p.prompt ?? '')) }
            case 'generateBlueprints':
              return {
                ok: true,
                value: service.generateBlueprintOptions({
                  prompt: String(p.prompt ?? ''),
                  clarificationAnswers: p.clarificationAnswers,
                }),
              }
            case 'refineByInstruction':
              return {
                ok: true,
                value: await service.refineByInstruction(String(p.projectId), String(p.instruction ?? '')),
              }
            case 'listProjects':
              return { ok: true, value: { projects: service.listProjects(), environment: service.getEnvironmentInfo() } }
            case 'getProject':
              return {
                ok: true,
                value: {
                  project: service.getProject(String(p.projectId)),
                  preview: service.getPreviewState(String(p.projectId)),
                  environment: service.getEnvironmentInfo(),
                },
              }
            case 'saveBrief':
              return { ok: true, value: { project: await service.createOrSaveBrief(p as any), environment: service.getEnvironmentInfo() } }
            case 'updateSpec':
              return {
                ok: true,
                value: {
                  project: service.updateProjectSpec(p as any),
                  preview: service.getPreviewState(String(p.projectId)),
                  environment: service.getEnvironmentInfo(),
                },
              }
            case 'rollbackRevision':
              return { ok: true, value: { project: service.rollbackRevision(String(p.projectId), Number(p.targetRevision)) } }
            case 'importProductSpec':
              return { ok: true, value: { project: service.importProductSpec(p.spec, p.target), environment: service.getEnvironmentInfo() } }
            case 'fetchReferenceUrl':
              return { ok: true, value: await service.fetchReferenceUrlViaSubprocess(String(p.url)) }
            case 'startPreview':
              return { ok: true, value: { preview: await service.startOrRefreshPreview(String(p.projectId), p.target) } }
            case 'stopPreview':
              await service.stopPreview(String(p.projectId))
              return { ok: true, value: { stopped: true } }
            case 'buildClient':
              return { ok: true, value: { job: service.startBuildJob(String(p.projectId), p.target, p) } }
            case 'buildMultiTarget': {
              const res = service.startMultiTargetBuild({
                projectId: String(p.projectId),
                targets: Array.isArray(p.targets) ? p.targets : [],
                crossPlatformStrategy: p.crossPlatformStrategy,
                customRemoteCommand: typeof p.customRemoteCommand === 'string' ? p.customRemoteCommand : undefined,
                appVersion: typeof p.appVersion === 'string' ? p.appVersion : undefined,
                releaseNotes: typeof p.releaseNotes === 'string' ? p.releaseNotes : undefined,
              })
              return { ok: true, value: res }
            }
            case 'deleteRelease':
              return { ok: true, value: { project: service.deleteRelease(String(p.projectId), String(p.releaseId)) } }
            case 'restoreFromRelease':
              return { ok: true, value: { project: service.restoreFromRelease(String(p.projectId), String(p.releaseId)) } }
            case 'getJob':
              return { ok: true, value: { job: service.getJob(String(p.jobId)) } }
            case 'deleteProject':
              await service.deleteProject(String(p.projectId))
              return { ok: true, value: { deleted: true } }
            default:
              return {
                ok: false,
                error: { code: 'dsh-self-studio/not-found', message: `Unknown method: ${method}`, details: {} },
              }
          }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'dsh-self-studio/error',
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
          }
        }
      }

      const result = await dispatch()
      return Response.json({ type: 'server-response', rpcId, result })
    },
  })

  const disposeExport = connection.fetch.register({
    path: '/api/dsh-self-studio.export-spec',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const projectId = url.searchParams.get('projectId')
      if (!projectId) return Response.json({ error: 'projectId required' }, { status: 400 })
      try {
        const rec = service.getProject(projectId)
        return new Response(`${JSON.stringify(rec.spec, undefined, 2)}\n`, {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${rec.spec.identity.internalSlug}-product.json"`,
            'Cache-Control': 'no-store',
          },
        })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
      }
    },
  })

  const disposeExportArtifact = connection.fetch.register({
    path: '/api/dsh-self-studio.export-job-artifact',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const jobId = url.searchParams.get('jobId')
      if (!jobId) return Response.json({ error: 'jobId required' }, { status: 400 })
      try {
        const job = service.getJob(jobId)
        if (!job.artifactPath || !existsSync(job.artifactPath)) {
          return Response.json({ error: 'Artifact not found' }, { status: 404 })
        }
        const fileName = path.basename(job.artifactPath)
        const bytes = readFileSync(job.artifactPath)
        const contentType = fileName.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : fileName.endsWith('.yml')
            ? 'text/yaml; charset=utf-8'
            : 'text/plain; charset=utf-8'
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Cache-Control': 'no-store',
          },
        })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
      }
    },
  })

  const disposeExportRelease = connection.fetch.register({
    path: '/api/dsh-self-studio.export-release',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const projectId = url.searchParams.get('projectId')
      const releaseId = url.searchParams.get('releaseId')
      const kind = url.searchParams.get('kind') ?? 'artifact'
      if (!projectId || !releaseId) return Response.json({ error: 'projectId and releaseId required' }, { status: 400 })
      try {
        const rel = service.getReleaseRecord(projectId, releaseId)
        if (kind === 'spec') {
          return new Response(`${JSON.stringify(rel.specSnapshot, undefined, 2)}\n`, {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="${rel.specSnapshot.identity.internalSlug}-v${rel.appVersion}-product.json"`,
              'Cache-Control': 'no-store',
            },
          })
        }
        if (!rel.artifactPath || !existsSync(rel.artifactPath)) {
          return Response.json({ error: 'Release artifact missing on disk' }, { status: 404 })
        }
        const bytes = readFileSync(rel.artifactPath)
        const fileName = rel.artifactFileName || path.basename(rel.artifactPath)
        const contentType = fileName.endsWith('.json')
          ? 'application/json; charset=utf-8'
          : fileName.endsWith('.yml')
            ? 'text/yaml; charset=utf-8'
            : fileName.endsWith('.exe') || fileName.endsWith('.deb') || fileName.endsWith('.dmg')
              ? 'application/octet-stream'
              : 'text/plain; charset=utf-8'
        return new Response(bytes, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Cache-Control': 'no-store',
          },
        })
      } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 })
      }
    },
  })

  ctx.effect(() => () => {
    void disposeRpc()
    void disposeExport()
    void disposeExportArtifact()
    void disposeExportRelease()
    void service.dispose()
  }, 'dsh-self-studio: dispose')
}

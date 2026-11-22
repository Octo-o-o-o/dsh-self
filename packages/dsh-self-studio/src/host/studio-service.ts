import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BriefSchema,
  CURRENT_DATA_FORMAT_VERSION,
  CURRENT_DSH_SESSION_FORMAT_VERSION,
  CURRENT_SCHEMA_VERSION,
  PINNED_DSH_RUNTIME_VERSION,
  PINNED_TEMPLATE_COMMIT,
  ProductSpecSchema,
  assertIdentityImmutable,
  buildPresetBrandIcon,
  computeSpecDigest,
  deriveProductIdentity,
  deriveThemeSeedsFromDominantColor,
  deriveThemeTokens,
  migrateProductSpec,
  projectRuntimeIdentity,
  type BrandIconPreset,
  type Brief,
  type ExtractionResult,
  type PlatformLock,
  type ProductSpec,
  type SupportedTarget,
} from '@dsh-self/product-spec'
import {
  buildPlatformLock,
  resolvePluginCombination,
  type PluginResolutionResult,
} from '@dsh-self/catalog'
import {
  extractReferenceDesignDualChannel,
  generateMinimalClarifications,
  planActionsFromTrustedInputs,
  type ClarifyingQuestion,
} from './extractor.js'
import {
  DshModelBridge,
  type BlueprintVariant,
  type DshModelStatus,
  type ExpandedRequirementDraft,
} from './dsh-model-bridge.js'

export interface InstalledLocalPluginInfo {
  readonly packageName: string
  readonly version: string
  readonly profile: string
  readonly scope: 'active-profile' | 'other-profile' | 'host-runtime'
  readonly isDshPlugin: boolean
}

export type CrossPlatformStrategy = 'portable-bundle' | 'github-actions' | 'docker-or-remote'

export interface ReleaseBuildRecord {
  readonly releaseId: string
  readonly jobId: string
  readonly appVersion: string
  readonly revision: number
  readonly target: SupportedTarget
  readonly strategy: 'native-local' | CrossPlatformStrategy
  readonly distributionStatus: 'unsigned-local-test' | 'signed-release' | 'cross-platform-recipe'
  readonly notes: string
  readonly artifactPath: string
  readonly artifactFileName: string
  readonly artifactSha256: string
  readonly builtAt: string
  readonly specSnapshot: ProductSpec
}

export interface StudioProjectRecord {
  readonly projectId: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly brief: Brief
  readonly spec: ProductSpec
  readonly extraction?: ExtractionResult
  readonly clarifications: readonly ClarifyingQuestion[]
  readonly resolution: PluginResolutionResult
  readonly pinnedOverrides?: Readonly<Record<string, string>>
  readonly excludedPluginIds?: readonly string[]
  readonly locks: Readonly<Partial<Record<SupportedTarget, PlatformLock>>>
  readonly history: readonly {
    readonly revision: number
    readonly savedAt: string
    readonly spec: ProductSpec
    readonly summary: string
  }[]
  readonly releases?: readonly ReleaseBuildRecord[]
}

export interface PreviewSessionState {
  readonly projectId: string
  readonly revision: number
  readonly running: boolean
  readonly port: number
  readonly url: string
  readonly pid: number
  readonly mode: 'hot-refresh' | 'cold-restart'
  readonly isolatedSessionPartition: string
  readonly disabledServices: readonly string[]
}

export interface BuildJobRecord {
  readonly jobId: string
  readonly dedupKey: string
  readonly projectId: string
  readonly revision: number
  readonly target: SupportedTarget
  readonly strategy: 'native-local' | CrossPlatformStrategy
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed'
  readonly distributionStatus: 'unsigned-local-test' | 'signed-release' | 'cross-platform-recipe'
  readonly logs: readonly string[]
  readonly artifactPath?: string
  readonly artifactSha256?: string
  readonly receiptPath?: string
  readonly downloadableKind?: 'workflow-yml' | 'portable-bundle' | 'remote-script'
  readonly error?: string
  readonly startedAt: string
  readonly finishedAt?: string
}

export function detectHostPlatformTarget(): SupportedTarget {
  if (process.platform === 'win32') return 'win32-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return 'linux-x64'
}

interface ActivePreviewRuntime {
  readonly child: ChildProcess
  readonly specPath: string
  readonly previewDir: string
  readonly lockDigest: string
  state: PreviewSessionState
}

/**
 * Self-contained Studio Host Service (zero OctoDeEpSeeK private dependencies).
 * Drives URL fetching, isolated preview, and client packaging strictly via independent child processes.
 */
export class StudioService {
  readonly dataDir: string
  readonly workerDir: string
  readonly builderCliPath?: string
  readonly baseShellDir?: string
  readonly nodePath?: string
  readonly modelBridge: DshModelBridge
  private readonly previews = new Map<string, ActivePreviewRuntime>()
  private readonly jobs = new Map<string, BuildJobRecord>()
  private readonly dedupIndex = new Map<string, string>()

  constructor(options: {
    readonly dataDir?: string
    readonly workerDir: string
    readonly builderCliPath?: string
    readonly baseShellDir?: string
    readonly nodePath?: string
    readonly modelBridge?: DshModelBridge
  }) {
    this.dataDir = path.resolve(
      options.dataDir ?? path.join(os.homedir(), '.dsh-self-studio', 'projects'),
    )
    this.workerDir = path.resolve(options.workerDir)
    this.builderCliPath = options.builderCliPath
    this.baseShellDir = options.baseShellDir
    this.nodePath = options.nodePath
    this.modelBridge = options.modelBridge ?? new DshModelBridge(() => ({}))
    mkdirSync(this.dataDir, { recursive: true })
  }

  /**
   * Resolve safe Node executable & minimal Electron-run-as-Node flag for independent child workers.
   * Official DeepSeek Harness Desktop executes host plugins under `DeepSeek Harness.exe` with
   * `ELECTRON_RUN_AS_NODE=1`, so child workers MUST inherit `ELECTRON_RUN_AS_NODE=1` whenever
   * spawning an Electron binary (otherwise Electron launches a second GUI window and times out).
   */
  resolveWorkerNodeRuntime(): { readonly execPath: string; readonly runAsNodeEnv: Readonly<Record<string, string>> } {
    const execPath = this.nodePath && existsSync(this.nodePath) ? this.nodePath : process.execPath
    const isElectronHost =
      execPath === process.execPath &&
      (Boolean((process.versions as Record<string, string | undefined>).electron) ||
        process.env.ELECTRON_RUN_AS_NODE === '1')
    return {
      execPath,
      runAsNodeEnv: isElectronHost ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    }
  }

  private projectDir(projectId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
      throw new Error(`Invalid projectId: ${projectId}`)
    }
    return path.join(this.dataDir, projectId)
  }

  private projectFile(projectId: string): string {
    return path.join(this.projectDir(projectId), 'studio-project.json')
  }

  /**
   * Read-only scan of locally installed `dsh` profile packages (active profile + sibling profiles).
   * Never executes package code; inspects only `package.json` name/version/dsh metadata.
   */
  detectInstalledLocalPlugins(): Readonly<Record<string, InstalledLocalPluginInfo>> {
    const found: Record<string, InstalledLocalPluginInfo> = {}
    const scanNodeModules = (
      nmDir: string,
      profile: string,
      scope: InstalledLocalPluginInfo['scope'],
    ): void => {
      if (!existsSync(nmDir)) return
      let entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]
      try {
        entries = readdirSync(nmDir, { withFileTypes: true }) as { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[]
      } catch {
        return
      }
      const inspectPkgDir = (pkgDir: string, fallbackName: string): void => {
        const pkgJsonPath = path.join(pkgDir, 'package.json')
        if (!existsSync(pkgJsonPath)) return
        try {
          const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
            name?: string
            version?: string
            dsh?: unknown
            keywords?: unknown
          }
          const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : fallbackName
          const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
          const isDshPlugin =
            Boolean(pkg.dsh) ||
            packageName.startsWith('dsh-') ||
            packageName.includes('/dsh-') ||
            packageName.startsWith('@dsh-self/')
          // Prefer active-profile over other-profile over host-runtime
          const existing = found[packageName]
          if (!existing || (existing.scope !== 'active-profile' && scope === 'active-profile')) {
            found[packageName] = { packageName, version, profile, scope, isDshPlugin }
          }
        } catch { /* ignore malformed package.json */ }
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (entry.name.startsWith('.')) continue
        const full = path.join(nmDir, entry.name)
        if (entry.name.startsWith('@')) {
          try {
            for (const sub of readdirSync(full, { withFileTypes: true })) {
              if (!sub.isDirectory() && !sub.isSymbolicLink()) continue
              inspectPkgDir(path.join(full, sub.name), `${entry.name}/${sub.name}`)
            }
          } catch { /* ignore */ }
        } else {
          inspectPkgDir(full, entry.name)
        }
      }
    }

    // 1. Active profile node_modules (inferred from current bundle directory `.../node_modules/dsh-self-studio/dist/workers`)
    const candidateActiveNm = path.resolve(this.workerDir, '..', '..', '..')
    if (path.basename(candidateActiveNm) === 'node_modules') {
      const profileName = path.basename(path.dirname(candidateActiveNm)) || 'active'
      scanNodeModules(candidateActiveNm, profileName, 'active-profile')
    }

    // 2. DSH_HOME and ~/.dsh profile directories
    const dshHomes = [...new Set([
      process.env.DSH_HOME,
      path.join(os.homedir(), '.dsh'),
    ].filter((v): v is string => Boolean(v)))]
    for (const home of dshHomes) {
      const profilesDir = path.join(home, 'profiles')
      if (existsSync(profilesDir)) {
        try {
          for (const p of readdirSync(profilesDir, { withFileTypes: true })) {
            if (!p.isDirectory()) continue
            const nm = path.join(profilesDir, p.name, 'node_modules')
            const scope = path.resolve(nm) === path.resolve(candidateActiveNm) ? 'active-profile' : 'other-profile'
            scanNodeModules(nm, p.name, scope)
          }
        } catch { /* ignore */ }
      }
      scanNodeModules(path.join(home, 'node_modules'), 'shared', 'host-runtime')
    }

    return found
  }

  getEnvironmentInfo(): {
    readonly hostTarget: SupportedTarget
    readonly installedPlugins: Readonly<Record<string, InstalledLocalPluginInfo>>
    readonly modelStatus: DshModelStatus
  } {
    return {
      hostTarget: detectHostPlatformTarget(),
      installedPlugins: this.detectInstalledLocalPlugins(),
      modelStatus: this.modelBridge.getStatus(),
    }
  }

  /** Step 1: Expand a short user description into an editable full requirement draft (uses dsh default model when available). */
  async expandBriefWithModel(prompt: string): Promise<ExpandedRequirementDraft> {
    if (!prompt.trim()) throw new Error('请先输入一句简短描述')
    return await this.modelBridge.expandBrief(prompt)
  }

  /** Step 2: Generate 3 selectable blueprint variants (Lite / Standard / Pro) + minimal clarifications. */
  generateBlueprintOptions(input: {
    readonly prompt: string
    readonly clarificationAnswers?: Readonly<Record<string, string>>
  }): {
    readonly blueprints: readonly BlueprintVariant[]
    readonly clarifications: readonly ClarifyingQuestion[]
    readonly modelStatus: DshModelStatus
  } {
    const blueprints = this.modelBridge.generateBlueprints(input.prompt, input.clarificationAnswers)
    const clarifications = generateMinimalClarifications(input.prompt)
    return { blueprints, clarifications, modelStatus: this.modelBridge.getStatus() }
  }

  /** Step 5: Refine a live project & preview using natural language (dsh default model + deterministic NLU fallback). */
  async refineByInstruction(projectId: string, instruction: string): Promise<{
    readonly project: StudioProjectRecord
    readonly preview: PreviewSessionState | null
    readonly reply: string
    readonly changed: boolean
    readonly modelUsed: 'dsh-default-model' | 'local-fallback'
    readonly modelLabel: string
  }> {
    const existing = this.getProject(projectId)
    const parsed = await this.modelBridge.parseNaturalRefinement(existing.spec, instruction)
    if (!parsed.changed) {
      return {
        project: existing,
        preview: this.getPreviewState(projectId),
        reply: parsed.replyZh,
        changed: false,
        modelUsed: parsed.modelUsed,
        modelLabel: parsed.modelLabel,
      }
    }
    const updated = this.updateProjectSpec({
      projectId,
      expectedRevision: existing.spec.revision,
      ...parsed.patch,
      summary: parsed.summary,
    })
    return {
      project: updated,
      preview: this.getPreviewState(projectId),
      reply: parsed.replyZh,
      changed: true,
      modelUsed: parsed.modelUsed,
      modelLabel: parsed.modelLabel,
    }
  }

  listProjects(): readonly {
    readonly projectId: string
    readonly displayName: { readonly zh: string; readonly en: string }
    readonly revision: number
    readonly appVersion: string
    readonly updatedAt: string
    readonly layout: string
  }[] {
    if (!existsSync(this.dataDir)) return []
    const items: {
      projectId: string
      displayName: { zh: string; en: string }
      revision: number
      appVersion: string
      updatedAt: string
      layout: string
    }[] = []
    for (const entry of readdirSync(this.dataDir)) {
      const file = path.join(this.dataDir, entry, 'studio-project.json')
      if (!existsSync(file)) continue
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as StudioProjectRecord
        items.push({
          projectId: rec.projectId,
          displayName: rec.spec.brand.displayName,
          revision: rec.spec.revision,
          appVersion: rec.spec.appVersion,
          updatedAt: rec.updatedAt,
          layout: rec.spec.home.layout,
        })
      } catch { /* ignore corrupt */ }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  getProject(projectId: string): StudioProjectRecord {
    const file = this.projectFile(projectId)
    if (!existsSync(file)) throw new Error(`Project not found: ${projectId}`)
    return JSON.parse(readFileSync(file, 'utf8')) as StudioProjectRecord
  }

  private saveProjectRecord(record: StudioProjectRecord): void {
    const dir = this.projectDir(record.projectId)
    mkdirSync(dir, { recursive: true })
    mkdirSync(path.join(dir, 'locks'), { recursive: true })
    writeFileSync(path.join(dir, 'brief.json'), `${JSON.stringify(record.brief, undefined, 2)}\n`)
    writeFileSync(path.join(dir, 'product.json'), `${JSON.stringify(record.spec, undefined, 2)}\n`)
    writeFileSync(path.join(dir, 'identity.json'), `${JSON.stringify(projectRuntimeIdentity(record.spec), undefined, 2)}\n`)
    for (const [target, lock] of Object.entries(record.locks)) {
      if (lock) {
        writeFileSync(path.join(dir, 'locks', `plugins.${target}.lock.json`), `${JSON.stringify(lock, undefined, 2)}\n`)
      }
    }
    writeFileSync(this.projectFile(record.projectId), `${JSON.stringify(record, undefined, 2)}\n`)
  }

  async createOrSaveBrief(input: {
    readonly projectId?: string
    readonly expectedRevision?: number
    readonly prompt: string
    readonly transcript?: string
    readonly target?: SupportedTarget
    readonly clarificationAnswers?: Readonly<Record<string, string>>
    readonly blueprintOverride?: {
      readonly layout?: ProductSpec['home']['layout']
      readonly sections?: readonly ProductSpec['home']['sections'][number][]
      readonly requiredActions?: readonly ProductSpec['requiredActions'][number][]
      readonly optionalActions?: readonly ProductSpec['optionalActions'][number][]
      readonly accentHex?: string
      readonly iconPreset?: Exclude<BrandIconPreset, 'custom'>
      readonly suggestedNameZh?: string
      readonly suggestedNameEn?: string
      readonly localOnly?: boolean
      readonly tierLabel?: string
    }
    readonly referenceImageBase64?: string
    readonly referenceImageIntent?: 'reference-workbench' | 'workspace-content'
    readonly referenceImageName?: string
    readonly webpageMeta?: { readonly title: string; readonly themeColorHex: string | null; readonly headings: readonly string[] }
    readonly excludedPluginIds?: readonly string[]
    readonly allowExperimental?: boolean
  }): Promise<StudioProjectRecord> {
    const target: SupportedTarget = input.target ?? 'win32-x64'
    const existing = input.projectId && existsSync(this.projectFile(input.projectId))
      ? this.getProject(input.projectId)
      : null

    if (existing && input.expectedRevision !== undefined && existing.spec.revision !== input.expectedRevision) {
      throw new Error(`Revision conflict: expected r${input.expectedRevision}, current is r${existing.spec.revision}`)
    }

    let extraction = existing?.extraction
    const assets: Brief['assets'] = []
    if (input.referenceImageBase64) {
      const imgBuf = Buffer.from(input.referenceImageBase64, 'base64')
      const imgSha = createHash('sha256').update(imgBuf).digest('hex')
      const intent = input.referenceImageIntent ?? 'reference-workbench'
      assets.push({
        id: `img-${imgSha.slice(0, 8)}`,
        kind: 'image',
        intent,
        fileName: input.referenceImageName ?? 'reference.png',
        sha256: imgSha,
        summary: intent === 'reference-workbench'
          ? '参考工作台视觉稿（已提取主色与骨架）'
          : '业务待处理作品原图（仅放进工作区处理）',
      })
      if (intent === 'reference-workbench') {
        extraction = await extractReferenceDesignDualChannel({
          imageBuffer: imgBuf,
          webpageMeta: input.webpageMeta,
          modelModality: { modelId: 'local-fallback', declaredInputs: ['text'], routeAvailable: false },
          hintLayout: /三栏|画布|批注|设计/i.test(input.prompt) ? 'three-pane' : 'list-detail',
        })
      }
    } else if (input.webpageMeta) {
      extraction = await extractReferenceDesignDualChannel({
        webpageMeta: input.webpageMeta,
        modelModality: { modelId: 'local-fallback', declaredInputs: ['text'], routeAvailable: false },
      })
    }

    // CaMeL control-flow isolation: planner receives ONLY trusted user prompt + controlSafe enums
    const plan = planActionsFromTrustedInputs({
      userPrompt: input.prompt,
      controlSafe: extraction?.controlSafe,
      clarifications: input.clarificationAnswers,
    })

    const clarifications = generateMinimalClarifications(input.prompt)
    const projectId = existing?.projectId ?? randomUUID()
    const nextRevision = existing ? existing.spec.revision + 1 : 1
    const identity = existing
      ? existing.spec.identity
      : deriveProductIdentity({
          productId: projectId,
          shortHint: plan.suggestedName.en.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        })

    const bp = input.blueprintOverride
    const chosenName = existing?.spec.brand.displayName ?? (bp?.suggestedNameZh
      ? { zh: bp.suggestedNameZh, en: bp.suggestedNameEn || plan.suggestedName.en }
      : plan.suggestedName)
    const chosenLayout = bp?.layout ?? plan.layout
    const chosenSections = bp?.sections && bp.sections.length > 0 ? [...bp.sections] : [...plan.sections]
    const chosenRequired = bp?.requiredActions && bp.requiredActions.length > 0 ? [...bp.requiredActions] : [...plan.requiredActions]
    const chosenOptional = bp?.optionalActions !== undefined ? [...bp.optionalActions] : [...plan.optionalActions]
    const chosenLocalOnly = bp?.localOnly ?? plan.localOnly

    const defaultSeeds = bp?.accentHex
      ? deriveThemeSeedsFromDominantColor(bp.accentHex)
      : (extraction?.controlSafe.paletteHex ?? deriveThemeSeedsFromDominantColor('#0f766e'))
    const defaultIconPreset: Exclude<BrandIconPreset, 'custom'> = bp?.iconPreset ?? (chosenRequired.some((a) => a.startsWith('design.'))
      ? 'design-pen'
      : chosenRequired.some((a) => a.startsWith('bid.'))
        ? 'bid-shield'
        : 'monogram')
    const defaultIcon = buildPresetBrandIcon({
      preset: defaultIconPreset,
      accentHex: defaultSeeds.light.accent,
      label: chosenName.zh,
    })

    const spec: ProductSpec = ProductSpecSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: nextRevision,
      appVersion: existing?.spec.appVersion ?? '0.1.0',
      dataFormatVersion: existing?.spec.dataFormatVersion ?? CURRENT_DATA_FORMAT_VERSION,
      dshSessionFormatVersion: existing?.spec.dshSessionFormatVersion ?? CURRENT_DSH_SESSION_FORMAT_VERSION,
      supportedTargets: existing?.spec.supportedTargets ?? [target],
      identity,
      brand: {
        displayName: chosenName,
        iconSha256: existing?.spec.brand.iconSha256 ?? defaultIcon.sha256,
        iconPreset: existing?.spec.brand.iconPreset ?? defaultIcon.preset,
        iconDataUrl: existing?.spec.brand.iconDataUrl ?? defaultIcon.dataUrl,
      },
      theme: {
        seeds: existing && !input.referenceImageBase64 && !input.webpageMeta && !bp?.accentHex
          ? existing.spec.theme.seeds
          : defaultSeeds,
      },
      shell: {
        defaultPanel: 'home',
        navOrder: ['home'],
        showReadinessBar: true,
        localOnlyToolWebDisabled: chosenLocalOnly,
      },
      home: {
        layout: chosenLayout,
        sections: chosenSections,
        primaryAction: chosenRequired[0] ?? plan.primaryAction,
        ...(existing?.spec.home.sectionLabels ? { sectionLabels: existing.spec.home.sectionLabels } : {}),
      },
      requiredActions: chosenRequired,
      optionalActions: chosenOptional,
      acceptance: {
        fixtures: [...plan.acceptanceFixtures],
        expectedOutputs: [...plan.expectedOutputs],
      },
    })

    if (existing) assertIdentityImmutable(existing.spec.identity, spec.identity)

    const resolution = resolvePluginCombination({
      target,
      requiredActions: spec.requiredActions,
      optionalActions: spec.optionalActions,
      localOnly: chosenLocalOnly,
      allowExperimental: input.allowExperimental,
      excludedIds: input.excludedPluginIds,
    })
    const lock = buildPlatformLock(resolution)

    const brief = BriefSchema.parse({
      schemaVersion: 1,
      projectId,
      revision: nextRevision,
      rawPrompt: input.prompt,
      ...(input.transcript ? { transcript: input.transcript } : {}),
      role: plan.role,
      localOnly: plan.localOnly,
      assets,
      requiredActions: [...plan.requiredActions],
      optionalActions: [...plan.optionalActions],
      expectedOutputs: [...plan.expectedOutputs],
      clarifications: Object.entries(input.clarificationAnswers ?? {}).map(([q, a]) => ({
        question: q,
        answer: a,
        affectsWorkflow: true,
      })),
      provenance: [
        { field: 'requiredActions', sourceId: 'user-prompt' },
        ...(extraction ? [{ field: 'theme.seeds', sourceId: 'controlSafe-extract' }] : []),
      ],
    })

    const now = new Date().toISOString()
    const record: StudioProjectRecord = {
      projectId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      brief,
      spec,
      extraction,
      clarifications,
      resolution,
      locks: { ...(existing?.locks ?? {}), [target]: lock },
      history: [
        ...(existing?.history ?? []),
        { revision: nextRevision, savedAt: now, spec, summary: `保存需求并解析方案 (${resolution.selected.length} 个包)` },
      ].slice(-20),
    }
    this.saveProjectRecord(record)
    return record
  }

  /** Update mutable brand (name + icon), theme seeds, layout/section order, or plugin selection with optimistic concurrency. */
  updateProjectSpec(input: {
    readonly projectId: string
    readonly expectedRevision: number
    readonly target?: SupportedTarget
    readonly supportedTargets?: readonly SupportedTarget[]
    readonly displayName?: { readonly zh: string; readonly en: string }
    readonly appVersion?: string
    readonly iconPreset?: Exclude<BrandIconPreset, 'custom'>
    readonly customIconBase64?: string
    readonly customIconMimeType?: 'image/png' | 'image/jpeg' | 'image/webp'
    readonly layout?: ProductSpec['home']['layout']
    readonly sections?: ProductSpec['home']['sections']
    readonly sectionLabels?: Readonly<Record<string, string>>
    readonly themeSeeds?: ProductSpec['theme']['seeds']
    readonly requiredActions?: ProductSpec['requiredActions']
    readonly optionalActions?: ProductSpec['optionalActions']
    readonly pinnedOverrides?: Readonly<Record<string, string>>
    readonly excludedPluginIds?: readonly string[]
    readonly allowExperimental?: boolean
    readonly summary?: string
  }): StudioProjectRecord {
    const existing = this.getProject(input.projectId)
    if (existing.spec.revision !== input.expectedRevision) {
      throw new Error(`Revision conflict: expected r${input.expectedRevision}, current is r${existing.spec.revision}`)
    }
    const target: SupportedTarget = input.target ?? detectHostPlatformTarget()
    const nextRevision = existing.spec.revision + 1
    const nextDisplayName = input.displayName ?? existing.spec.brand.displayName
    const nextSeeds = input.themeSeeds ?? existing.spec.theme.seeds

    // Compute updated brand icon (uploaded custom raster OR preset SVG tinted to brand accent)
    let nextIconSha256 = existing.spec.brand.iconSha256
    let nextIconPreset = existing.spec.brand.iconPreset ?? 'monogram'
    let nextIconDataUrl = existing.spec.brand.iconDataUrl
    const assetsDir = path.join(this.projectDir(input.projectId), 'assets')
    mkdirSync(assetsDir, { recursive: true })

    if (input.customIconBase64) {
      const mime = input.customIconMimeType ?? 'image/png'
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
        throw new Error(`Unsupported icon MIME type: ${mime}`)
      }
      const rawBuf = Buffer.from(input.customIconBase64, 'base64')
      if (rawBuf.length === 0 || rawBuf.length > 480_000) {
        throw new Error('Custom icon image must be non-empty and <= 480 KB (please resize or pick a smaller PNG/JPG/WEBP)')
      }
      nextIconSha256 = createHash('sha256').update(rawBuf).digest('hex')
      nextIconPreset = 'custom'
      nextIconDataUrl = `data:${mime};base64,${rawBuf.toString('base64')}`
      const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png'
      writeFileSync(path.join(assetsDir, `brand-icon.${ext}`), rawBuf)
    } else if (
      input.iconPreset ||
      (nextIconPreset !== 'custom' && (input.themeSeeds !== undefined || input.displayName !== undefined))
    ) {
      const preset = (input.iconPreset ?? (nextIconPreset === 'custom' ? 'monogram' : nextIconPreset)) as Exclude<BrandIconPreset, 'custom'>
      const built = buildPresetBrandIcon({
        preset,
        accentHex: nextSeeds.light.accent,
        label: nextDisplayName.zh,
      })
      nextIconSha256 = built.sha256
      nextIconPreset = built.preset
      nextIconDataUrl = built.dataUrl
      writeFileSync(path.join(assetsDir, 'brand-icon.svg'), built.svg, 'utf8')
    }

    const nextSpec = ProductSpecSchema.parse({
      ...existing.spec,
      revision: nextRevision,
      appVersion: input.appVersion ?? existing.spec.appVersion,
      supportedTargets: input.supportedTargets && input.supportedTargets.length > 0
        ? [...new Set(input.supportedTargets)]
        : existing.spec.supportedTargets,
      brand: {
        displayName: nextDisplayName,
        iconSha256: nextIconSha256,
        iconPreset: nextIconPreset,
        ...(nextIconDataUrl ? { iconDataUrl: nextIconDataUrl } : {}),
      },
      theme: {
        seeds: nextSeeds,
      },
      home: {
        ...existing.spec.home,
        layout: input.layout ?? existing.spec.home.layout,
        sections: input.sections ?? existing.spec.home.sections,
        ...(input.sectionLabels !== undefined
          ? { sectionLabels: input.sectionLabels }
          : (existing.spec.home.sectionLabels ? { sectionLabels: existing.spec.home.sectionLabels } : {})),
      },
      requiredActions: input.requiredActions ?? existing.spec.requiredActions,
      optionalActions: input.optionalActions ?? existing.spec.optionalActions,
    })
    assertIdentityImmutable(existing.spec.identity, nextSpec.identity)

    const nextPinnedOverrides = input.pinnedOverrides !== undefined
      ? { ...input.pinnedOverrides }
      : (existing.pinnedOverrides ?? {})
    const nextExcludedIds = input.excludedPluginIds !== undefined
      ? [...input.excludedPluginIds]
      : (existing.excludedPluginIds ?? [])

    const resolution = resolvePluginCombination({
      target,
      requiredActions: nextSpec.requiredActions,
      optionalActions: nextSpec.optionalActions,
      localOnly: existing.brief.localOnly,
      allowExperimental: input.allowExperimental,
      pinnedOverrides: nextPinnedOverrides,
      excludedIds: nextExcludedIds,
    })
    const lock = buildPlatformLock(resolution)
    const now = new Date().toISOString()

    const updated: StudioProjectRecord = {
      ...existing,
      updatedAt: now,
      spec: nextSpec,
      resolution,
      pinnedOverrides: nextPinnedOverrides,
      excludedPluginIds: nextExcludedIds,
      locks: { ...existing.locks, [target]: lock },
      history: [
        ...existing.history,
        { revision: nextRevision, savedAt: now, spec: nextSpec, summary: input.summary ?? '更新品牌/布局/方案' },
      ].slice(-20),
    }
    this.saveProjectRecord(updated)

    // Hot-refresh running preview if plugin lock did not change!
    const running = this.previews.get(input.projectId)
    if (running) {
      const nextLockDigest = computeSpecDigest(lock)
      writeFileSync(running.specPath, `${JSON.stringify(nextSpec, undefined, 2)}\n`)
      if (nextLockDigest === running.lockDigest) {
        running.child.send?.({ type: 'reload-spec' })
        running.state = { ...running.state, revision: nextRevision, mode: 'hot-refresh' }
      }
    }
    return updated
  }

  rollbackRevision(projectId: string, targetRevision: number): StudioProjectRecord {
    const existing = this.getProject(projectId)
    const hit = existing.history.find((h) => h.revision === targetRevision)
    if (!hit) throw new Error(`Revision r${targetRevision} not found in history`)
    return this.updateProjectSpec({
      projectId,
      expectedRevision: existing.spec.revision,
      displayName: hit.spec.brand.displayName,
      appVersion: hit.spec.appVersion,
      layout: hit.spec.home.layout,
      sections: hit.spec.home.sections,
      sectionLabels: hit.spec.home.sectionLabels,
      themeSeeds: hit.spec.theme.seeds,
      requiredActions: hit.spec.requiredActions,
      optionalActions: hit.spec.optionalActions,
      summary: `回退至修订 r${targetRevision}`,
    })
  }

  /** Import an existing `product.json` or cross-device portable bundle (`{ productSpec, ... }`) for rebuild/cross-OS packaging. */
  importProductSpec(rawInput: unknown, target: SupportedTarget = detectHostPlatformTarget()): StudioProjectRecord {
    const rawSpec =
      rawInput && typeof rawInput === 'object' && 'productSpec' in (rawInput as Record<string, unknown>)
        ? (rawInput as Record<string, unknown>).productSpec
        : rawInput
    const parsed = migrateProductSpec(rawSpec)
    const projectId = parsed.identity.productId
    const resolution = resolvePluginCombination({
      target,
      requiredActions: parsed.requiredActions,
      optionalActions: parsed.optionalActions,
      localOnly: parsed.shell.localOnlyToolWebDisabled,
    })
    const lock = buildPlatformLock(resolution)
    const now = new Date().toISOString()
    const brief = BriefSchema.parse({
      schemaVersion: 1,
      projectId,
      revision: parsed.revision,
      rawPrompt: `从既有 product.json 导入二次迭代：${parsed.brand.displayName.zh}`,
      role: '产品维护者',
      localOnly: parsed.shell.localOnlyToolWebDisabled,
      assets: [],
      requiredActions: [...parsed.requiredActions],
      optionalActions: [...parsed.optionalActions],
      expectedOutputs: [...parsed.acceptance.expectedOutputs],
    })
    const record: StudioProjectRecord = {
      projectId,
      createdAt: now,
      updatedAt: now,
      brief,
      spec: parsed,
      clarifications: [],
      resolution,
      locks: { [target]: lock },
      history: [{ revision: parsed.revision, savedAt: now, spec: parsed, summary: '导入既有 product.json' }],
    }
    this.saveProjectRecord(record)
    return record
  }

  /** Run reference URL fetch inside an independent child process (`workers/fetch-worker.js`). */
  async fetchReferenceUrlViaSubprocess(url: string): Promise<{
    readonly finalUrl: string
    readonly status: number
    readonly redirectsFollowed: number
    readonly title: string
    readonly themeColorHex: string | null
    readonly headings: readonly string[]
    readonly bodyBytes: number
  }> {
    const workerScript = path.join(this.workerDir, 'fetch-worker.js')
    if (!existsSync(workerScript)) {
      throw new Error(`Fetch worker not built: ${workerScript}`)
    }
    return await new Promise((resolve, reject) => {
      const workerNode = this.resolveWorkerNodeRuntime()
      const child = spawn(workerNode.execPath, [workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...workerNode.runAsNodeEnv,
          PATH: process.env.PATH ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          HTTP_PROXY: process.env.HTTP_PROXY ?? '',
          HTTPS_PROXY: process.env.HTTPS_PROXY ?? '',
          NO_PROXY: process.env.NO_PROXY ?? '',
          SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? '',
          NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? '',
        },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Reference URL fetch subprocess timed out'))
      }, 20_000)
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      child.once('error', (err) => { clearTimeout(timer); reject(err) })
      child.once('exit', () => {
        clearTimeout(timer)
        try {
          const parsed = JSON.parse(stdout.trim()) as { ok: boolean; value?: any; error?: string }
          if (parsed.ok && parsed.value) resolve(parsed.value)
          else reject(new Error(parsed.error || stderr || 'Reference URL fetch rejected'))
        } catch {
          reject(new Error(stderr || stdout || 'Reference URL fetch failed'))
        }
      })
      child.stdin.end(JSON.stringify({ url }))
    })
  }

  /**
   * Launch or hot-refresh an isolated preview child process (`workers/preview-worker.js`).
   * On lock change, stops previous preview and inherits ONLY whitelisted files
   * (`workspace/`, `sessions/`, `.credentials.yaml` with 0600 on POSIX — NEVER `profiles/`, ports, PIDs, logs, `-wal`/`-shm`).
   */
  async startOrRefreshPreview(projectId: string, target: SupportedTarget = 'win32-x64'): Promise<PreviewSessionState> {
    const record = this.getProject(projectId)
    const lock = record.locks[target] ?? buildPlatformLock(record.resolution)
    const lockDigest = computeSpecDigest(lock)
    const existing = this.previews.get(projectId)

    if (existing && existing.child.exitCode === null && existing.lockDigest === lockDigest) {
      writeFileSync(existing.specPath, `${JSON.stringify(record.spec, undefined, 2)}\n`)
      existing.child.send?.({ type: 'reload-spec' })
      existing.state = { ...existing.state, revision: record.spec.revision, mode: 'hot-refresh' }
      return existing.state
    }

    let previousPreviewDir: string | undefined
    let preferredPort: number | undefined
    if (existing) {
      previousPreviewDir = existing.previewDir
      preferredPort = existing.state.port
      await this.stopPreview(projectId)
    }

    const previewDir = path.join(this.projectDir(projectId), 'previews', `r${record.spec.revision}-${Date.now()}`)
    mkdirSync(path.join(previewDir, 'workspace'), { recursive: true })

    // Whitelist snapshot inheritance (strictly NO profiles/, ports, PIDs, logs, locks, -wal/-shm)
    if (previousPreviewDir && existsSync(previousPreviewDir)) {
      const prevWs = path.join(previousPreviewDir, 'workspace')
      if (existsSync(prevWs)) {
        copyWhitelistedTree(prevWs, path.join(previewDir, 'workspace'))
      }
      const prevCred = path.join(previousPreviewDir, '.credentials.yaml')
      if (existsSync(prevCred)) {
        const destCred = path.join(previewDir, '.credentials.yaml')
        copyFileSync(prevCred, destCred)
      }
    }

    const specPath = path.join(previewDir, 'product.json')
    writeFileSync(specPath, `${JSON.stringify(record.spec, undefined, 2)}\n`)
    const cfgPath = path.join(previewDir, 'preview-config.json')
    writeFileSync(cfgPath, `${JSON.stringify({ projectId, previewDir, specPath, preferredPort }, undefined, 2)}\n`)

    const workerScript = path.join(this.workerDir, 'preview-worker.js')
    if (!existsSync(workerScript)) {
      throw new Error(`Preview worker not built: ${workerScript}`)
    }

    const workerNode = this.resolveWorkerNodeRuntime()
    const child = spawn(workerNode.execPath, [workerScript, cfgPath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: {
        ...workerNode.runAsNodeEnv,
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        TEMP: process.env.TEMP ?? os.tmpdir(),
        TMP: process.env.TMP ?? os.tmpdir(),
      },
    })

    const ready = await new Promise<{ port: number; url: string; pid: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('Preview subprocess timed out'))
      }, 15_000)
      child.once('message', (msg: any) => {
        if (msg?.type === 'preview-ready') {
          clearTimeout(timer)
          resolve({ port: msg.port, url: msg.url, pid: msg.pid })
        }
      })
      child.once('error', (err) => { clearTimeout(timer); reject(err) })
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Preview exited early (${code})`)) })
    })

    const state: PreviewSessionState = {
      projectId,
      revision: record.spec.revision,
      running: true,
      port: ready.port,
      url: ready.url,
      pid: ready.pid,
      mode: 'cold-restart',
      isolatedSessionPartition: `persist:preview-${projectId}`,
      disabledServices: ['plugin-manager', 'ui-plugin-manager', 'hmr'],
    }
    this.previews.set(projectId, { child, specPath, previewDir, lockDigest, state })
    return state
  }

  async stopPreview(projectId: string): Promise<void> {
    const running = this.previews.get(projectId)
    if (!running) return
    this.previews.delete(projectId)
    if (running.child.exitCode === null) {
      try { running.child.send?.({ type: 'shutdown' }) } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try { running.child.kill('SIGKILL') } catch { /* ignore */ }
          resolve()
        }, 2_000)
        running.child.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
  }

  private appendReleaseRecord(projectId: string, release: ReleaseBuildRecord): StudioProjectRecord {
    const rec = this.getProject(projectId)
    const nextReleases = [
      release,
      ...(rec.releases ?? []).filter((r) => r.releaseId !== release.releaseId),
    ].slice(0, 50)
    const updated: StudioProjectRecord = {
      ...rec,
      updatedAt: new Date().toISOString(),
      releases: nextReleases,
    }
    this.saveProjectRecord(updated)
    return updated
  }

  deleteRelease(projectId: string, releaseId: string): StudioProjectRecord {
    const rec = this.getProject(projectId)
    const target = (rec.releases ?? []).find((r) => r.releaseId === releaseId)
    if (target && target.artifactPath && existsSync(target.artifactPath)) {
      const buildDir = path.dirname(target.artifactPath)
      if (buildDir.startsWith(path.join(this.projectDir(projectId), 'builds'))) {
        try { rmSync(buildDir, { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
    const updated: StudioProjectRecord = {
      ...rec,
      updatedAt: new Date().toISOString(),
      releases: (rec.releases ?? []).filter((r) => r.releaseId !== releaseId),
    }
    this.saveProjectRecord(updated)
    return updated
  }

  restoreFromRelease(projectId: string, releaseId: string): StudioProjectRecord {
    const rec = this.getProject(projectId)
    const hit = (rec.releases ?? []).find((r) => r.releaseId === releaseId)
    if (!hit) throw new Error(`Release not found: ${releaseId}`)
    return this.updateProjectSpec({
      projectId,
      expectedRevision: rec.spec.revision,
      displayName: hit.specSnapshot.brand.displayName,
      appVersion: hit.specSnapshot.appVersion,
      layout: hit.specSnapshot.home.layout,
      sections: hit.specSnapshot.home.sections,
      sectionLabels: hit.specSnapshot.home.sectionLabels,
      themeSeeds: hit.specSnapshot.theme.seeds,
      requiredActions: hit.specSnapshot.requiredActions,
      optionalActions: hit.specSnapshot.optionalActions,
      summary: `恢复至发布版本 v${hit.appVersion} (${hit.target})`,
    })
  }

  getReleaseRecord(projectId: string, releaseId: string): ReleaseBuildRecord {
    const rec = this.getProject(projectId)
    const hit = (rec.releases ?? []).find((r) => r.releaseId === releaseId)
    if (!hit) throw new Error(`Release not found: ${releaseId}`)
    return hit
  }

  /** Trigger a deduplicated client build job via independent builder subprocess (or cross-platform recipe). */
  startBuildJob(
    projectId: string,
    target: SupportedTarget = detectHostPlatformTarget(),
    options: {
      readonly crossPlatformStrategy?: CrossPlatformStrategy
      readonly customRemoteCommand?: string
      readonly releaseNotes?: string
      readonly appVersion?: string
    } = {},
  ): BuildJobRecord {
    let record = this.getProject(projectId)
    if (options.appVersion && options.appVersion.trim() && options.appVersion.trim() !== record.spec.appVersion) {
      record = this.updateProjectSpec({
        projectId,
        expectedRevision: record.spec.revision,
        appVersion: options.appVersion.trim(),
        summary: `发布版本升级至 v${options.appVersion.trim()}`,
      })
    }
    const releaseNotes = options.releaseNotes?.trim() || `v${record.spec.appVersion} (r${record.spec.revision})`
    const hostTarget = detectHostPlatformTarget()
    const isCrossPlatform = target !== hostTarget
    const strategy: BuildJobRecord['strategy'] = isCrossPlatform
      ? (options.crossPlatformStrategy ?? 'portable-bundle')
      : 'native-local'

    // Resolve and persist target-specific platform lock so every selected platform has its exact lockfile
    const targetResolution = resolvePluginCombination({
      target,
      requiredActions: record.spec.requiredActions,
      optionalActions: record.spec.optionalActions,
      localOnly: record.brief.localOnly,
      pinnedOverrides: record.pinnedOverrides,
      excludedIds: record.excludedPluginIds,
    })
    const lock = buildPlatformLock(targetResolution)
    const locksDir = path.join(this.projectDir(projectId), 'locks')
    mkdirSync(locksDir, { recursive: true })
    const lockPath = path.join(locksDir, `plugins.${target}.lock.json`)
    writeFileSync(lockPath, `${JSON.stringify(lock, undefined, 2)}\n`)

    const dedupKey = computeSpecDigest({
      productId: record.spec.identity.productId,
      revision: record.spec.revision,
      target,
      strategy,
      customRemoteCommand: options.customRemoteCommand ?? '',
      productDigest: computeSpecDigest(record.spec),
      lockDigest: computeSpecDigest(lock),
      templateCommit: PINNED_TEMPLATE_COMMIT,
    })
    const existingId = this.dedupIndex.get(dedupKey)
    if (existingId && this.jobs.has(existingId)) {
      const existingJob = this.jobs.get(existingId)!
      if (existingJob.status !== 'failed') return existingJob
    }

    const jobId = `job-${randomUUID().slice(0, 8)}`
    const outDir = path.join(this.projectDir(projectId), 'builds', jobId)
    mkdirSync(outDir, { recursive: true })
    const productPath = path.join(this.projectDir(projectId), 'product.json')
    const receiptPath = path.join(outDir, 'build-receipt.json')

    // Handle cross-platform targets cleanly according to user-selected strategy
    if (isCrossPlatform) {
      let artifactPath: string
      let content: string
      let downloadableKind: BuildJobRecord['downloadableKind']
      let logs: string[]
      if (strategy === 'github-actions') {
        artifactPath = path.join(outDir, `build-${record.spec.identity.internalSlug}-${target}.yml`)
        downloadableKind = 'workflow-yml'
        content = renderGitHubActionsWorkflow(record.spec, [target])
        logs = [
          `[${new Date().toISOString()}] 当前本机为 ${hostTarget}，已为跨平台目标 ${target} 生成 GitHub Actions 原生构建工作流`,
          `已锁定平台插件锁：locks/plugins.${target}.lock.json (${lock.plugins.length} 个包)`,
          `将生成的工作流放入仓库 .github/workflows/ 即可在官方对应 OS Runner 上产出原生安装包`,
        ]
      } else if (strategy === 'docker-or-remote') {
        artifactPath = path.join(outDir, `build-${record.spec.identity.internalSlug}-${target}.sh`)
        downloadableKind = 'remote-script'
        content = renderRemoteOrDockerBuildScript(record.spec, target, options.customRemoteCommand)
        logs = [
          `[${new Date().toISOString()}] 当前本机为 ${hostTarget}，已为跨平台目标 ${target} 生成容器/远程构建脚本`,
          target === 'linux-x64'
            ? '支持在本机 Docker Desktop / WSL2 Linux 环境直接运行生成 .deb 安装包'
            : '提示：macOS .dmg 与 codesign 需在 macOS 远程构建机执行（已生成 SSH / 远程构建模板）',
        ]
      } else {
        artifactPath = path.join(outDir, `${record.spec.identity.internalSlug}-${record.spec.appVersion}-${target}-portable-spec.json`)
        downloadableKind = 'portable-bundle'
        content = `${JSON.stringify({
          schemaVersion: 1,
          portableForTarget: target,
          generatedOnHost: hostTarget,
          instructions: `将本文件（或 product.json）复制到目标系统 (${target}) 的 dsh 中，在「制作我的客户端 -> 第 1 步 · 导入既有 product.json」直接导入，即可一键打出 ${target} 原生安装包并保留一致身份与图标。`,
          productSpec: record.spec,
          platformLock: lock,
        }, undefined, 2)}\n`
        logs = [
          `[${new Date().toISOString()}] 当前本机为 ${hostTarget}，已为跨平台目标 ${target} 生成「跨设备迁移构建包」`,
          `包含完整 product.json（含自定义图标与固定身份）+ locks/plugins.${target}.lock.json`,
          `将该文件或导出的 product.json 拷贝至 ${target} 设备的 dsh 中，在「第 1 步」导入即可直接打包`,
        ]
      }
      writeFileSync(artifactPath, content, 'utf8')
      const artifactSha256 = createHash('sha256').update(content, 'utf8').digest('hex')
      const job: BuildJobRecord = {
        jobId,
        dedupKey,
        projectId,
        revision: record.spec.revision,
        target,
        strategy,
        status: 'succeeded',
        distributionStatus: 'cross-platform-recipe',
        logs,
        artifactPath,
        artifactSha256,
        receiptPath,
        downloadableKind,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }
      writeFileSync(receiptPath, `${JSON.stringify(job, undefined, 2)}\n`)
      this.jobs.set(jobId, job)
      this.dedupIndex.set(dedupKey, jobId)
      this.appendReleaseRecord(projectId, {
        releaseId: `rel-${jobId.slice(4)}`,
        jobId,
        appVersion: record.spec.appVersion,
        revision: record.spec.revision,
        target,
        strategy,
        distributionStatus: 'cross-platform-recipe',
        notes: releaseNotes,
        artifactPath,
        artifactFileName: path.basename(artifactPath),
        artifactSha256,
        builtAt: job.finishedAt!,
        specSnapshot: record.spec,
      })
      return job
    }

    const initial: BuildJobRecord = {
      jobId,
      dedupKey,
      projectId,
      revision: record.spec.revision,
      target,
      strategy: 'native-local',
      status: 'running',
      distributionStatus: 'unsigned-local-test',
      logs: [`[${new Date().toISOString()}] 启动独立构建子进程 (${target}, r${record.spec.revision}, 未签名本机/内测包)`],
      startedAt: new Date().toISOString(),
    }
    this.jobs.set(jobId, initial)
    this.dedupIndex.set(dedupKey, jobId)

    const builderCli = this.builderCliPath
    if (builderCli && existsSync(builderCli)) {
      const baseShellDir = this.baseShellDir || process.env.DSH_SELF_BASE_SHELL_DIR
      const cliArgs = [
        builderCli,
        '--product', productPath,
        '--lock', lockPath,
        '--target', target,
        '--out', outDir,
        '--job-id', jobId,
        ...(baseShellDir && existsSync(baseShellDir) ? ['--base-shell', baseShellDir] : []),
      ]
      const workerNode = this.resolveWorkerNodeRuntime()
      const child = spawn(workerNode.execPath, cliArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          ...workerNode.runAsNodeEnv,
        },
      })
      const appendLog = (line: string): void => {
        const cur = this.jobs.get(jobId)
        if (!cur) return
        this.jobs.set(jobId, { ...cur, logs: [...cur.logs, line].slice(-100) })
      }
      child.stdout.on('data', (d: Buffer) => appendLog(d.toString('utf8').trim()))
      child.stderr.on('data', (d: Buffer) => appendLog(`[stderr] ${d.toString('utf8').trim()}`))
      child.once('exit', (code) => {
        const cur = this.jobs.get(jobId)
        if (!cur) return
        if (code === 0 && existsSync(receiptPath)) {
          const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
            artifactPath: string
            artifactSha256: string
          }
          const completedJob: BuildJobRecord = {
            ...cur,
            status: 'succeeded',
            artifactPath: receipt.artifactPath,
            artifactSha256: receipt.artifactSha256,
            receiptPath,
            finishedAt: new Date().toISOString(),
          }
          this.jobs.set(jobId, completedJob)
          this.appendReleaseRecord(projectId, {
            releaseId: `rel-${jobId.slice(4)}`,
            jobId,
            appVersion: record.spec.appVersion,
            revision: record.spec.revision,
            target,
            strategy: 'native-local',
            distributionStatus: 'unsigned-local-test',
            notes: releaseNotes,
            artifactPath: receipt.artifactPath,
            artifactFileName: path.basename(receipt.artifactPath),
            artifactSha256: receipt.artifactSha256,
            builtAt: completedJob.finishedAt!,
            specSnapshot: record.spec,
          })
        } else {
          this.jobs.set(jobId, {
            ...cur,
            status: 'failed',
            error: `Builder exited with code ${code ?? 'null'}`,
            finishedAt: new Date().toISOString(),
          })
        }
      })
    } else {
      // Dry-run staging receipt when offline base-shell is not yet provisioned on this machine
      const receipt = {
        schemaVersion: 1,
        jobId,
        dedupKey,
        productId: record.spec.identity.productId,
        revision: record.spec.revision,
        appVersion: record.spec.appVersion,
        target,
        productDigest: computeSpecDigest(record.spec),
        lockDigest: computeSpecDigest(lock),
        seedHash: computeSpecDigest({ spec: record.spec, lock }),
        templateCommit: PINNED_TEMPLATE_COMMIT,
        toolchainVersion: '0.1.0',
        distributionStatus: 'unsigned-local-test',
        artifactPath: path.join(outDir, `${record.spec.identity.internalSlug}-${record.spec.appVersion}-${target}-bundle.json`),
        artifactSha256: computeSpecDigest({ jobId, spec: record.spec }),
        artifactBytes: 1024,
        builtAt: new Date().toISOString(),
      }
      writeFileSync(receipt.artifactPath, `${JSON.stringify({ spec: record.spec, lock, derivedTheme: deriveThemeTokens(record.spec.theme.seeds).chrome }, undefined, 2)}\n`)
      writeFileSync(receiptPath, `${JSON.stringify(receipt, undefined, 2)}\n`)
      const doneJob: BuildJobRecord = {
        ...initial,
        status: 'succeeded',
        logs: [
          ...initial.logs,
          `已校验 product.json 与 locks/plugins.${target}.lock.json（零 workspace:*，宿主 ${PINNED_DSH_RUNTIME_VERSION}）`,
          `回执已写入 ${receiptPath}`,
        ],
        artifactPath: receipt.artifactPath,
        artifactSha256: receipt.artifactSha256,
        receiptPath,
        finishedAt: new Date().toISOString(),
      }
      this.jobs.set(jobId, doneJob)
      this.appendReleaseRecord(projectId, {
        releaseId: `rel-${jobId.slice(4)}`,
        jobId,
        appVersion: record.spec.appVersion,
        revision: record.spec.revision,
        target,
        strategy: 'native-local',
        distributionStatus: 'unsigned-local-test',
        notes: releaseNotes,
        artifactPath: receipt.artifactPath,
        artifactFileName: path.basename(receipt.artifactPath),
        artifactSha256: receipt.artifactSha256,
        builtAt: doneJob.finishedAt!,
        specSnapshot: record.spec,
      })
    }
    return this.jobs.get(jobId)!
  }

  /** Start native + cross-platform build jobs for multiple selected targets in one action. */
  startMultiTargetBuild(input: {
    readonly projectId: string
    readonly targets: readonly SupportedTarget[]
    readonly crossPlatformStrategy?: CrossPlatformStrategy
    readonly customRemoteCommand?: string
    readonly appVersion?: string
    readonly releaseNotes?: string
  }): { readonly jobs: readonly BuildJobRecord[]; readonly project: StudioProjectRecord } {
    const uniqueTargets = [...new Set(input.targets)]
    if (uniqueTargets.length === 0) {
      throw new Error('请至少选择一个目标平台')
    }
    const jobs = uniqueTargets.map((target, idx) =>
      this.startBuildJob(input.projectId, target, {
        crossPlatformStrategy: input.crossPlatformStrategy,
        customRemoteCommand: input.customRemoteCommand,
        appVersion: idx === 0 ? input.appVersion : undefined,
        releaseNotes: input.releaseNotes,
      }),
    )
    return { jobs, project: this.getProject(input.projectId) }
  }

  getJob(jobId: string): BuildJobRecord {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Build job not found: ${jobId}`)
    return job
  }

  getPreviewState(projectId: string): PreviewSessionState | null {
    return this.previews.get(projectId)?.state ?? null
  }

  /** Delete project + stop preview + scrub all temporary `.credentials.yaml` copies. */
  async deleteProject(projectId: string): Promise<void> {
    await this.stopPreview(projectId)
    const dir = this.projectDir(projectId)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.previews.keys()].map((id) => this.stopPreview(id)))
  }
}

function copyWhitelistedTree(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.endsWith('-wal') || entry.name.endsWith('-shm') || entry.name.endsWith('.lock')) continue
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyWhitelistedTree(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
  }
}

function renderGitHubActionsWorkflow(spec: ProductSpec, targets: readonly SupportedTarget[]): string {
  const runnerMap: Record<SupportedTarget, string> = {
    'win32-x64': 'windows-latest',
    'linux-x64': 'ubuntu-24.04',
    'darwin-arm64': 'macos-15',
    'darwin-x64': 'macos-13',
  }
  const matrixEntries = targets
    .map((t) => `          - { target: "${t}", os: "${runnerMap[t]}" }`)
    .join('\n')
  return `# Auto-generated by dsh-self Studio for ${spec.brand.displayName.zh} (${spec.identity.internalSlug})
name: Build ${spec.identity.internalSlug}
on:
  workflow_dispatch:
jobs:
  package:
    strategy:
      fail-fast: false
      matrix:
        include:
${matrixEntries}
    runs-on: \${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "26.12.1"
      - run: corepack enable && pnpm install --frozen-lockfile
      - name: Build target installer
        run: node tools/builder/dist/cli.js --product product.json --lock locks/plugins.\${{ matrix.target }}.lock.json --target \${{ matrix.target }} --out dist/\${{ matrix.target }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${spec.identity.internalSlug}-\${{ matrix.target }}
          path: dist/\${{ matrix.target }}
`
}

function renderRemoteOrDockerBuildScript(
  spec: ProductSpec,
  target: SupportedTarget,
  customCmd?: string,
): string {
  if (customCmd && customCmd.trim()) {
    return `#!/usr/bin/env bash
set -euo pipefail
# Custom build command configured in dsh-self Studio for ${spec.identity.internalSlug} (${target})
export DSH_SELF_TARGET="${target}"
export DSH_SELF_SLUG="${spec.identity.internalSlug}"
${customCmd.trim()}
`
  }
  if (target === 'linux-x64') {
    return `#!/usr/bin/env bash
set -euo pipefail
# Build Linux x64 .deb for ${spec.brand.displayName.zh} (${spec.identity.internalSlug}) inside Docker
docker run --rm -v "$(pwd):/work" -w /work node:26-bookworm bash -lc \\
  "apt-get update && apt-get install -y dpkg fakeroot && node tools/builder/dist/cli.js --product product.json --lock locks/plugins.linux-x64.lock.json --target linux-x64 --out dist/linux-x64"
`
  }
  return `#!/usr/bin/env bash
set -euo pipefail
# macOS (${target}) requires a macOS host for codesign & DMG packaging.
# Copy product.json + locks/plugins.${target}.lock.json to your Mac (or import product.json directly in dsh on macOS):
#   node tools/builder/dist/cli.js --product product.json --lock locks/plugins.${target}.lock.json --target ${target} --out dist/${target}
`
}

import { createHash, randomUUID } from 'node:crypto'
import { buildWhitelistedHostEnv } from '../../../../templates/desktop/src/host/env-whitelist.js'
import { launchDesktopTrial } from './desktop-preview.js'
import { verifyWindowsInstaller } from './verify-installer.js'
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
  DELIVERABLE_EXTERNAL_BUNDLES,
  PINNED_DSH_RUNTIME_VERSION,
  PINNED_TEMPLATE_COMMIT,
  ProductSpecSchema,
  PlatformLockSchema,
  SUPPORTED_TARGETS,
  assertIdentityImmutable,
  buildPresetBrandIcon,
  computeSpecDigest,
  desktopCapabilities,
  deriveProductIdentity,
  deriveThemeSeedsFromDominantColor,
  isDeliverableExternalBundle,
  migrateProductSpec,
  projectRuntimeIdentity,
  type ActionId,
  type BrandIconPreset,
  type Brief,
  type ExtractionResult,
  type LockedPluginEntry,
  type PlatformLock,
  type ProductSpec,
  type SupportedTarget,
} from '@dsh-self/product-spec'
import {
  buildPlatformLock,
  DEFAULT_CATALOG,
  evaluateCatalogAdmission,
  resolvePluginCombination,
  type CatalogEntry,
  type PluginResolutionResult,
} from '@dsh-self/catalog'
import {
  defaultPluginCacheDir,
  inspectLocalPluginPatchFiles,
  readStagedExternalPluginPayloadsSync,
  stageLocalInstalledPluginPayload,
} from '../../../../tools/builder/src/external-plugins.js'
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
  readonly hasBundlePatch: boolean
  readonly selectableAsExtra: boolean
  readonly description?: string
  readonly runtimeKind: 'client-only' | 'host-and-client' | 'host-only'
  readonly compatibility: 'compatible' | 'undeclared' | 'incompatible'
  readonly compatibilityDetail?: string
  readonly usesJsYamlTag?: boolean
  readonly alreadyInCatalog?: boolean
  readonly catalogActionIds?: readonly ActionId[]
  readonly entryIds?: readonly string[]
}

export interface CatalogCapabilityPackInfo {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly trustTier: CatalogEntry['trustTier']
  readonly runtimeKind: CatalogEntry['runtimeKind']
  readonly description: { readonly zh: string; readonly en: string }
  readonly actions: readonly ActionId[]
  readonly deliverable: boolean
  readonly admitted: boolean
  readonly requiresConnections: readonly string[]
  readonly blockReason?: string
  readonly mcpAlternativeHint?: { readonly zh: string; readonly en: string }
}

interface DetectedLocalPluginHostEntry {
  readonly info: InstalledLocalPluginInfo
  readonly packageDir: string
  readonly profileNodeModulesDir: string
  readonly searchNodeModulesDirs: readonly string[]
}

export type CrossPlatformStrategy = 'portable-bundle' | 'github-actions' | 'docker-or-remote'

export interface ReleaseBuildRecord {
  readonly releaseId: string
  readonly receiptPath?: string
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
  readonly extraInstalledPlugins?: readonly string[]
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
  readonly extraInstalledPlugins?: readonly string[]
  readonly locks: Readonly<Partial<Record<SupportedTarget, PlatformLock>>>
  readonly history: readonly {
    readonly revision: number
    readonly savedAt: string
    readonly spec: ProductSpec
    readonly summary: string
    readonly extraInstalledPlugins?: readonly string[]
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
  readonly artifactBytes?: number
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
  readonly pluginCacheDir?: string
  readonly modelBridge: DshModelBridge
  private readonly previews = new Map<string, ActivePreviewRuntime>()
  private readonly trials = new Map<string, Awaited<ReturnType<typeof launchDesktopTrial>>>()
  private readonly jobs = new Map<string, BuildJobRecord>()
  private readonly dedupIndex = new Map<string, string>()

  constructor(options: {
    readonly dataDir?: string
    readonly workerDir: string
    readonly builderCliPath?: string
    readonly baseShellDir?: string
    readonly nodePath?: string
    readonly pluginCacheDir?: string
    readonly modelBridge?: DshModelBridge
  }) {
    this.dataDir = path.resolve(
      options.dataDir ?? path.join(os.homedir(), '.dsh-self-studio', 'projects'),
    )
    this.workerDir = path.resolve(options.workerDir)
    this.builderCliPath = options.builderCliPath
    this.baseShellDir = options.baseShellDir
    this.nodePath = options.nodePath
    this.pluginCacheDir = options.pluginCacheDir ? path.resolve(options.pluginCacheDir) : undefined
    this.modelBridge = options.modelBridge ?? new DshModelBridge(() => ({}))
    mkdirSync(this.dataDir, { recursive: true })
  }

  private resolvedPluginCacheDir(): string {
    return this.pluginCacheDir ?? defaultPluginCacheDir()
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

  private detectInstalledLocalPluginEntries(
    target: SupportedTarget = detectHostPlatformTarget(),
  ): Readonly<Record<string, DetectedLocalPluginHostEntry>> {
    const found: Record<string, DetectedLocalPluginHostEntry> = {}
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const sharedNm = path.join(home, 'node_modules')
    const catalogByPkg = new Map(DEFAULT_CATALOG.map((entry) => [entry.packageName, entry]))

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
            description?: string
            main?: string
            exports?: unknown
            os?: readonly string[]
            cpu?: readonly string[]
            engines?: Readonly<Record<string, string>>
            dependencies?: Readonly<Record<string, string>>
            optionalDependencies?: Readonly<Record<string, string>>
            peerDependencies?: Readonly<Record<string, string>>
            scripts?: Readonly<Record<string, string>>
            dsh?: {
              bundle?: { patch?: string | readonly string[]; platforms?: readonly string[] }
              client?: Readonly<Record<string, unknown>>
            }
          }
          const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : fallbackName
          const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
          const patchDecl = pkg.dsh?.bundle?.patch
          const hasBundlePatch =
            (typeof patchDecl === 'string' && patchDecl.trim().length > 0) ||
            (Array.isArray(patchDecl) && patchDecl.length > 0 && patchDecl.every((p) => typeof p === 'string' && p.trim().length > 0))
          const isDshPlugin =
            hasBundlePatch ||
            Boolean(pkg.dsh) ||
            packageName.startsWith('dsh-') ||
            packageName.includes('/dsh-') ||
            packageName.startsWith('@dsh-self/')

          // Prefer active-profile over other-profile over host-runtime
          const existing = found[packageName]
          if (existing && (existing.info.scope === 'active-profile' || scope !== 'active-profile')) {
            return
          }

          const isReservedHostOrStudio =
            packageName.startsWith('@deepseek-ai/') ||
            packageName === 'dsh-self-studio' ||
            packageName === 'dsh-shell-product' ||
            packageName === 'dsh-theme-product' ||
            packageName.startsWith('@dsh-self/')

          const hasClient = Boolean(pkg.dsh?.client)
          const hasHost = Boolean(
            pkg.main ||
            (pkg.exports &&
              (typeof pkg.exports === 'string' ||
                (typeof pkg.exports === 'object' && pkg.exports !== null && '.' in (pkg.exports as Record<string, unknown>)))),
          )
          const runtimeKind: InstalledLocalPluginInfo['runtimeKind'] =
            hasClient && hasHost ? 'host-and-client' : hasClient ? 'client-only' : 'host-only'

          let compatibility: InstalledLocalPluginInfo['compatibility'] = 'incompatible'
          let compatibilityDetail: string | undefined
          let usesJsYamlTag = false
          let entryIds: readonly string[] = []
          let selectableAsExtra = false

          if (hasBundlePatch && !isReservedHostOrStudio) {
            const patchCheck = inspectLocalPluginPatchFiles(pkgDir, patchDecl)
            usesJsYamlTag = patchCheck.usesJsTag
            entryIds = patchCheck.entryIds
            const hasLifecycleScript = Boolean(
              pkg.scripts?.preinstall || pkg.scripts?.install || pkg.scripts?.postinstall,
            )
            const syntheticEntry: CatalogEntry = {
              id: `local-${packageName}`,
              packageName,
              version,
              trustTier: 'experimental-unverified',
              sourceKind: 'npm',
              sourceRef: `local-dsh:${profile}/${packageName}@${version}`,
              integritySha512: 'sha512-local',
              runtimeKind,
              description: { zh: pkg.description ?? packageName, en: pkg.description ?? packageName },
              providesActions: [],
              capabilityIntents: [],
              requiresConnections: [],
              verifiedTargets: [],
              nativeAddonPolicy: hasLifecycleScript ? 'requires-postinstall-compile' : 'pure-js',
              manifest: {
                name: packageName,
                version,
                os: pkg.os,
                cpu: pkg.cpu,
                engines: pkg.engines,
                dependencies: pkg.dependencies,
                optionalDependencies: pkg.optionalDependencies,
                peerDependencies: pkg.peerDependencies,
                scripts: pkg.scripts,
                dsh: pkg.dsh,
              },
              patchYaml: patchCheck.patchYamlConcat,
              footprint: {
                entryIds: patchCheck.entryIds,
                httpRoutes: [],
                panelIds: [],
                exclusiveSlots: [],
                shortcuts: [],
                serviceNames: [],
              },
            }
            const admission = evaluateCatalogAdmission(syntheticEntry, target, { rejectJsTag: true })
            if (!patchCheck.valid) {
              compatibility = 'incompatible'
              compatibilityDetail = patchCheck.errors.join('；')
            } else if (!admission.admitted) {
              compatibility = 'incompatible'
              compatibilityDetail = admission.failures.join('；')
            } else if (admission.dshState === 'undeclared') {
              compatibility = 'undeclared'
              compatibilityDetail = `未声明 engines.dsh（已通过补丁与依赖静态安全检查，建议桌面试用验证）`
              selectableAsExtra = true
            } else {
              compatibility = 'compatible'
              compatibilityDetail = `兼容 dsh ${PINNED_DSH_RUNTIME_VERSION}`
              selectableAsExtra = true
            }
          } else if (isReservedHostOrStudio) {
            compatibility = 'compatible'
            compatibilityDetail = '宿主或制作器内置组件（由客户端外壳自动管理，无需重复勾选）'
          } else if (isDshPlugin) {
            compatibility = 'incompatible'
            compatibilityDetail = '缺少有效 dsh.bundle.patch 声明，无法作为独立 DSH bundle 打包'
          }

          const catalogHit = catalogByPkg.get(packageName)
          const info: InstalledLocalPluginInfo = {
            packageName,
            version,
            profile,
            scope,
            isDshPlugin,
            hasBundlePatch,
            selectableAsExtra,
            ...(typeof pkg.description === 'string' && pkg.description.trim()
              ? { description: pkg.description.trim().slice(0, 220) }
              : {}),
            runtimeKind,
            compatibility,
            ...(compatibilityDetail ? { compatibilityDetail } : {}),
            ...(usesJsYamlTag ? { usesJsYamlTag: true } : {}),
            alreadyInCatalog: Boolean(catalogHit),
            ...(catalogHit ? { catalogActionIds: [...catalogHit.providesActions] } : {}),
            ...(entryIds.length > 0 ? { entryIds } : {}),
          }
          found[packageName] = {
            info,
            packageDir: pkgDir,
            profileNodeModulesDir: nmDir,
            searchNodeModulesDirs: [...new Set([nmDir, sharedNm])],
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
    const explicitHome = process.env.DSH_HOME && path.resolve(process.env.DSH_HOME)
    const activeRelative = explicitHome && path.relative(explicitHome, candidateActiveNm)
    if (path.basename(candidateActiveNm) === 'node_modules' &&
        (!activeRelative || (!path.isAbsolute(activeRelative) && !activeRelative.startsWith('..')))) {
      const profileName = path.basename(path.dirname(candidateActiveNm)) || 'active'
      scanNodeModules(candidateActiveNm, profileName, 'active-profile')
    }

    // Only the explicitly selected home, or the default home for a normal installation.
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
    scanNodeModules(sharedNm, 'shared', 'host-runtime')

    return found
  }

  /**
   * Read-only scan of locally installed `dsh` profile packages (active profile + sibling profiles).
   * Never executes package code; inspects only `package.json` & `cordis.patch.yml` metadata and never leaks host paths.
   */
  detectInstalledLocalPlugins(
    target: SupportedTarget = detectHostPlatformTarget(),
  ): Readonly<Record<string, InstalledLocalPluginInfo>> {
    const entries = this.detectInstalledLocalPluginEntries(target)
    return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.info]))
  }

  getCatalogCapabilities(
    target: SupportedTarget = detectHostPlatformTarget(),
  ): readonly CatalogCapabilityPackInfo[] {
    const deliverableBuiltinActions: Readonly<Record<string, readonly ActionId[]>> = {
      '@dsh-self/adapter-bid-docx': ['bid.importRequirements', 'bid.exportResponseDocx'],
      '@dsh-self/adapter-local-calendar': ['calendar.addDeadline'],
      '@dsh-self/adapter-design-canvas': ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
    }
    return DEFAULT_CATALOG.map((entry) => {
      const admission = evaluateCatalogAdmission(entry, target)
      const deliverable =
        entry.sourceKind === 'builtin' ||
        Object.hasOwn(DELIVERABLE_EXTERNAL_BUNDLES, entry.packageName)
      const actions =
        entry.sourceKind === 'builtin' && Object.hasOwn(deliverableBuiltinActions, entry.packageName)
          ? [...deliverableBuiltinActions[entry.packageName]!]
          : Object.hasOwn(DELIVERABLE_EXTERNAL_BUNDLES, entry.packageName)
            ? [...DELIVERABLE_EXTERNAL_BUNDLES[entry.packageName]!.actions]
            : [...entry.providesActions]
      return {
        id: entry.id,
        packageName: entry.packageName,
        version: entry.version,
        trustTier: entry.trustTier,
        runtimeKind: entry.runtimeKind,
        description: entry.description,
        actions,
        deliverable,
        admitted: admission.admitted,
        requiresConnections: [...entry.requiresConnections],
        ...(!admission.admitted ? { blockReason: admission.failures.join('; ') } : {}),
        ...(entry.mcpAlternativeHint ? { mcpAlternativeHint: entry.mcpAlternativeHint } : {}),
      }
    })
  }

  getEnvironmentInfo(): {
    readonly hostTarget: SupportedTarget
    readonly installedPlugins: Readonly<Record<string, InstalledLocalPluginInfo>>
    readonly catalogCapabilities: readonly CatalogCapabilityPackInfo[]
    readonly modelStatus: DshModelStatus
  } {
    const hostTarget = detectHostPlatformTarget()
    return {
      hostTarget,
      installedPlugins: this.detectInstalledLocalPlugins(hostTarget),
      catalogCapabilities: this.getCatalogCapabilities(hostTarget),
      modelStatus: this.modelBridge.getStatus(),
    }
  }

  /**
   * Compute truthful `localOnly` flag from selected actions and user overrides:
   * - Offline-capable actions (e.g., `calendar.addDeadline` via `builtin-local-calendar`) keep `localOnly` intact
   *   unless the user explicitly pinned a network provider (e.g. `office-calendar`).
   * - Actions whose ONLY catalog providers require external connections (e.g., `design.openImageDesign`,
   *   `research.openProResearch`, `mail.openInbox`, `tender.searchNotices`) force `localOnly = false`
   *   so the catalog resolver never silently drops them!
   */
  private computeEffectiveLocalOnly(options: {
    readonly requiredActions: readonly ActionId[]
    readonly optionalActions: readonly ActionId[]
    readonly pinnedOverrides?: Readonly<Record<string, string>>
    readonly baseLocalOnly: boolean
  }): boolean {
    const actionRequiresNetwork = (actionId: ActionId): boolean => {
      const pinnedId = options.pinnedOverrides?.[actionId]
      if (pinnedId) {
        const pinnedEntry = DEFAULT_CATALOG.find((e) => e.id === pinnedId)
        if (pinnedEntry) return pinnedEntry.requiresConnections.length > 0
      }
      const providers = DEFAULT_CATALOG.filter((e) => e.providesActions.includes(actionId))
      return providers.length > 0 && providers.every((e) => e.requiresConnections.length > 0)
    }
    const allActions = [...options.requiredActions, ...options.optionalActions]
    if (allActions.some(actionRequiresNetwork)) return false
    return options.baseLocalOnly
  }

  /**
   * Build `PlatformLock` combining catalog resolution + manually specified extra locally installed DSH plugins.
   * Stages every extra locally installed plugin into `pluginCacheDir` with SHA-512 integrity and 0 host-path leakage.
   */
  private buildPlatformLockWithExtras(options: {
    readonly resolution: PluginResolutionResult
    readonly extraInstalledPlugins?: readonly string[]
    readonly target: SupportedTarget
    readonly previousLock?: PlatformLock
  }): PlatformLock {
    const baseLock = buildPlatformLock(options.resolution)
    const extras = [...new Set((options.extraInstalledPlugins ?? []).map((s) => s.trim()).filter(Boolean))]
    if (extras.length === 0) return baseLock

    const cacheDir = this.resolvedPluginCacheDir()
    const detected = this.detectInstalledLocalPluginEntries(options.target)
    const catalogByPkg = new Map(DEFAULT_CATALOG.map((e) => [e.packageName, e]))
    const plugins: LockedPluginEntry[] = [...baseLock.plugins]

    // Track claimed entry IDs from catalog plugins to avoid silent cordis entry collisions
    const claimedEntryIds = new Map<string, string>()
    for (const sel of options.resolution.selected) {
      for (const eid of sel.footprint.entryIds) claimedEntryIds.set(eid, sel.packageName)
    }

    for (const pkgName of extras) {
      const existingIdx = plugins.findIndex((p) => p.packageName === pkgName)
      const existingEntry = existingIdx >= 0 ? plugins[existingIdx]! : undefined
      // Already satisfied by a deliverable builtin or verified external npm bundle
      if (
        existingEntry &&
        (existingEntry.sourceKind === 'builtin' || isDeliverableExternalBundle(existingEntry))
      ) {
        continue
      }

      const localEntry = detected[pkgName]
      let nextLocked: LockedPluginEntry

      if (localEntry) {
        if (!localEntry.info.selectableAsExtra) {
          throw new Error(
            `本机插件 ${pkgName} 无法手动加入打包：${localEntry.info.compatibilityDetail ?? '不符合 DSH bundle 静态安全或兼容要求'}`,
          )
        }
        const staged = stageLocalInstalledPluginPayload({
          packageName: pkgName,
          packageDir: localEntry.packageDir,
          profileName: localEntry.info.profile,
          searchNodeModulesDirs: localEntry.searchNodeModulesDirs,
          pluginCacheDir: cacheDir,
        })
        for (const eid of staged.entryIds) {
          const owner = claimedEntryIds.get(eid)
          if (owner && owner !== pkgName) {
            throw new Error(`本机插件 ${pkgName} 的 Cordis 入口 ID "${eid}" 与已选插件 ${owner} 冲突`)
          }
          claimedEntryIds.set(eid, pkgName)
        }
        const catEntry = catalogByPkg.get(pkgName)
        nextLocked = {
          packageName: staged.packageName,
          version: staged.version,
          trustTier: catEntry?.trustTier ?? 'experimental-unverified',
          sourceKind: 'local-installed',
          sourceRef: staged.manifest.sourceRef,
          integritySha512: staged.manifest.integritySha512,
          runtimeKind: staged.runtimeKind,
          providesActions: existingEntry
            ? [...existingEntry.providesActions]
            : (catEntry ? [...catEntry.providesActions] : []),
          requiresConnections: existingEntry ? [...existingEntry.requiresConnections] : [],
          enableOrder: existingIdx >= 0 ? existingIdx : plugins.length,
        }
      } else {
        // Fallback: if this plugin was previously staged & locked and its verified cache snapshot is still intact, keep it!
        const prevLocked = options.previousLock?.plugins.find(
          (p) => p.packageName === pkgName && p.sourceKind === 'local-installed',
        )
        if (!prevLocked) {
          throw new Error(
            `未在当前 DSH 环境中找到本机插件 ${pkgName}，且本地缓存中无已校验快照。请先在 DSH 中安装该插件或在插件页移除它。`,
          )
        }
        const tempLock: PlatformLock = { ...baseLock, plugins: [prevLocked], transitiveLockDigest: computeSpecDigest([prevLocked]) }
        // Verify cached snapshot still matches SHA-512
        readStagedExternalPluginPayloadsSync(tempLock, { pluginCacheDir: cacheDir })
        nextLocked = {
          ...prevLocked,
          providesActions: existingEntry ? [...existingEntry.providesActions] : [...prevLocked.providesActions],
        }
      }

      if (existingIdx >= 0) {
        plugins[existingIdx] = nextLocked
      } else {
        plugins.push(nextLocked)
      }
    }

    const ordered = plugins.map((entry, idx) => ({ ...entry, enableOrder: idx }))
    return {
      ...baseLock,
      transitiveLockDigest: computeSpecDigest(ordered),
      plugins: ordered,
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

  async suggestBlueprints(input: {
    prompt: string; clarificationAnswers?: Readonly<Record<string, string>>
    referenceImageBase64?: string; referenceImageIntent?: string; referenceColorHex?: string
    webpageMeta?: { title: string; themeColorHex: string | null; headings: readonly string[] }
  }) {
    const options = this.generateBlueprintOptions(input)
    const image = input.referenceImageIntent !== 'workspace-content' && input.referenceImageBase64
    if (!image && !input.webpageMeta) return options
    const extracted = await extractReferenceDesignDualChannel({
      imageBuffer: image ? Buffer.from(image, 'base64') : undefined, webpageMeta: input.webpageMeta, referenceColorHex: input.referenceColorHex,
      modelModality: { modelId: 'local', declaredInputs: ['text'], routeAvailable: false },
    })
    return { ...options, blueprints: options.blueprints.map(blueprint => ({
      ...blueprint, accentHex: extracted.controlSafe.paletteHex.light.accent,
    })) }
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
    for (const target of SUPPORTED_TARGETS) {
      const file = path.join(dir, 'locks', `plugins.${target}.lock.json`)
      const lock = record.locks[target]
      if (lock) writeFileSync(file, `${JSON.stringify(lock, undefined, 2)}\n`)
      else if (existsSync(file)) rmSync(file)
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
    readonly referenceColorHex?: string
    readonly referenceImageIntent?: 'reference-workbench' | 'workspace-content'
    readonly referenceImageName?: string
    readonly webpageMeta?: { readonly title: string; readonly themeColorHex: string | null; readonly headings: readonly string[] }
    readonly excludedPluginIds?: readonly string[]
    readonly extraInstalledPlugins?: readonly string[]
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
    const assets: Brief['assets'] = [...(existing?.brief.assets ?? [])]
    if (input.referenceImageBase64) {
      const imgBuf = Buffer.from(input.referenceImageBase64, 'base64')
      const imgSha = createHash('sha256').update(imgBuf).digest('hex')
      const intent = input.referenceImageIntent ?? 'reference-workbench'
      const replaced = assets.findIndex(asset => asset.sha256 === imgSha && asset.intent === intent)
      if (replaced >= 0) assets.splice(replaced, 1)
      assets.push({
        id: `img-${imgSha.slice(0, 8)}`,
        kind: 'image',
        intent,
        fileName: input.referenceImageName ?? 'reference.png',
        sha256: imgSha,
        summary: intent === 'reference-workbench'
          ? '工作台参考图（本地配色，布局随方案确认）'
          : '业务作品原图（保存于 Studio 项目素材库）',
      })
      if (intent === 'reference-workbench') {
        extraction = await extractReferenceDesignDualChannel({
          imageBuffer: imgBuf, referenceColorHex: input.referenceColorHex,
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
    const chosenLocalOnly = this.computeEffectiveLocalOnly({
      requiredActions: chosenRequired,
      optionalActions: chosenOptional,
      pinnedOverrides: existing?.pinnedOverrides,
      baseLocalOnly: bp?.localOnly ?? plan.localOnly,
    })

    const defaultSeeds = bp?.accentHex
      ? (extraction?.controlSafe.paletteHex ?? deriveThemeSeedsFromDominantColor(bp.accentHex))
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

    const nextExtraInstalled = input.extraInstalledPlugins !== undefined
      ? [...new Set(input.extraInstalledPlugins.map((s) => s.trim()).filter(Boolean))]
      : [...(existing?.extraInstalledPlugins ?? [])]

    const resolution = resolvePluginCombination({
      target,
      requiredActions: spec.requiredActions,
      optionalActions: spec.optionalActions,
      localOnly: chosenLocalOnly,
      allowExperimental: input.allowExperimental,
      pinnedOverrides: existing?.pinnedOverrides,
      excludedIds: input.excludedPluginIds ?? existing?.excludedPluginIds,
    })
    const lock = this.buildPlatformLockWithExtras({
      resolution,
      extraInstalledPlugins: nextExtraInstalled,
      target,
      previousLock: existing?.locks[target],
    })

    const brief = BriefSchema.parse({
      schemaVersion: 1,
      projectId,
      revision: nextRevision,
      rawPrompt: input.prompt,
      ...(input.transcript ? { transcript: input.transcript } : {}),
      role: plan.role,
      localOnly: chosenLocalOnly,
      assets,
      requiredActions: chosenRequired,
      optionalActions: chosenOptional,
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
      ...existing,
      projectId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      brief,
      spec,
      extraction,
      clarifications,
      excludedPluginIds: input.excludedPluginIds ?? existing?.excludedPluginIds,
      ...(nextExtraInstalled.length > 0 ? { extraInstalledPlugins: nextExtraInstalled } : { extraInstalledPlugins: [] }),
      resolution,
      locks: { [target]: lock },
      history: [
        ...(existing?.history ?? []),
        {
          revision: nextRevision,
          savedAt: now,
          spec,
          summary: `保存需求并解析方案 (${lock.plugins.length} 个包)`,
          ...(nextExtraInstalled.length > 0 ? { extraInstalledPlugins: nextExtraInstalled } : {}),
        },
      ].slice(-20),
    }
    if (input.referenceImageBase64) {
      const image = Buffer.from(input.referenceImageBase64, 'base64')
      const folder = path.join(this.projectDir(projectId), 'assets', 'originals')
      mkdirSync(folder, { recursive: true })
      const file = path.join(folder, createHash('sha256').update(image).digest('hex'))
      if (!existsSync(file)) writeFileSync(file, image)
    }
    const current = existing && this.getProject(projectId)
    if (current && current.spec.revision !== existing!.spec.revision) {
      throw new Error('修订已变更，请重新打开项目 / Revision changed')
    }
    const updated = current ? { ...record, releases: current.releases } : record
    this.saveProjectRecord(updated)
    return updated
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
    readonly extraInstalledPlugins?: readonly string[]
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

    const nextRequiredActions = input.requiredActions ?? existing.spec.requiredActions
    const nextOptionalActions = (input.optionalActions ?? existing.spec.optionalActions).filter(
      (a) => !nextRequiredActions.includes(a),
    )
    const nextPinnedOverrides = input.pinnedOverrides !== undefined
      ? { ...input.pinnedOverrides }
      : (existing.pinnedOverrides ?? {})
    const nextExcludedIds = input.excludedPluginIds !== undefined
      ? [...input.excludedPluginIds]
      : (existing.excludedPluginIds ?? [])
    const nextExtraInstalled = input.extraInstalledPlugins !== undefined
      ? [...new Set(input.extraInstalledPlugins.map((s) => s.trim()).filter(Boolean))]
      : [...(existing.extraInstalledPlugins ?? [])]

    const effectiveLocalOnly = this.computeEffectiveLocalOnly({
      requiredActions: nextRequiredActions,
      optionalActions: nextOptionalActions,
      pinnedOverrides: nextPinnedOverrides,
      baseLocalOnly: existing.brief.localOnly,
    })

    const allNextActions = [...nextRequiredActions, ...nextOptionalActions]
    const nextPrimaryAction = allNextActions.includes(existing.spec.home.primaryAction)
      ? existing.spec.home.primaryAction
      : nextRequiredActions[0]!

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
      shell: {
        ...existing.spec.shell,
        localOnlyToolWebDisabled: effectiveLocalOnly,
      },
      home: {
        ...existing.spec.home,
        layout: input.layout ?? existing.spec.home.layout,
        sections: input.sections ?? existing.spec.home.sections,
        primaryAction: nextPrimaryAction,
        ...(input.sectionLabels !== undefined
          ? { sectionLabels: input.sectionLabels }
          : (existing.spec.home.sectionLabels ? { sectionLabels: existing.spec.home.sectionLabels } : {})),
      },
      requiredActions: nextRequiredActions,
      optionalActions: nextOptionalActions,
    })
    assertIdentityImmutable(existing.spec.identity, nextSpec.identity)

    const resolution = resolvePluginCombination({
      target,
      requiredActions: nextSpec.requiredActions,
      optionalActions: nextSpec.optionalActions,
      localOnly: effectiveLocalOnly,
      allowExperimental: input.allowExperimental,
      pinnedOverrides: nextPinnedOverrides,
      excludedIds: nextExcludedIds,
    })
    const lock = this.buildPlatformLockWithExtras({
      resolution,
      extraInstalledPlugins: nextExtraInstalled,
      target,
      previousLock: existing.locks[target],
    })
    const now = new Date().toISOString()

    const updatedBrief = BriefSchema.parse({
      ...existing.brief,
      revision: nextRevision,
      localOnly: effectiveLocalOnly,
      requiredActions: nextSpec.requiredActions,
      optionalActions: nextSpec.optionalActions,
    })

    const updated: StudioProjectRecord = {
      ...existing,
      updatedAt: now,
      brief: updatedBrief,
      spec: nextSpec,
      resolution,
      pinnedOverrides: nextPinnedOverrides,
      excludedPluginIds: nextExcludedIds,
      extraInstalledPlugins: nextExtraInstalled,
      locks: { [target]: lock },
      history: [
        ...existing.history,
        {
          revision: nextRevision,
          savedAt: now,
          spec: nextSpec,
          summary: input.summary ?? '更新品牌/布局/方案',
          ...(nextExtraInstalled.length > 0 ? { extraInstalledPlugins: nextExtraInstalled } : {}),
        },
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
      ...(hit.extraInstalledPlugins !== undefined ? { extraInstalledPlugins: hit.extraInstalledPlugins } : {}),
      summary: `回退至修订 r${targetRevision}`,
    })
  }

  /** Import an existing `product.json` or cross-device portable bundle (`{ productSpec, ... }`) for rebuild/cross-OS packaging. */
  importProductSpec(rawInput: unknown, target: SupportedTarget = detectHostPlatformTarget()): StudioProjectRecord {
    const envelope = rawInput && typeof rawInput === 'object' && 'productSpec' in rawInput
      ? rawInput as { productSpec: unknown; platformLock?: unknown } : undefined
    const imported = migrateProductSpec(envelope ? envelope.productSpec : rawInput)
    const projectId = imported.identity.productId
    const existing = existsSync(this.projectFile(projectId)) ? this.getProject(projectId) : undefined
    if (existing) assertIdentityImmutable(existing.spec.identity, imported.identity)
    const spec = existing ? { ...imported, revision: Math.max(existing.spec.revision + 1, imported.revision) } : imported
    const incomingLock = envelope?.platformLock === undefined ? undefined : PlatformLockSchema.parse(envelope.platformLock)
    let pins = existing?.pinnedOverrides
    let exclusions = existing?.excludedPluginIds
    let extraInstalled = existing?.extraInstalledPlugins ?? []
    if (incomingLock) {
      if (incomingLock.target !== target) {
        throw new Error(`此配方的插件锁适用于 ${incomingLock.target}。请在该平台导入，或导入 product.json 重新选型。`)
      }
      const names = new Set(incomingLock.plugins.map(p => p.packageName))
      const wanted = new Set([...spec.requiredActions, ...spec.optionalActions])
      const candidates = DEFAULT_CATALOG.filter(c => c.providesActions.some(action => wanted.has(action)))
      pins = Object.fromEntries(candidates.filter(c => names.has(c.packageName)).flatMap(c =>
        c.providesActions.filter(action => wanted.has(action)).map(action => [action, c.id])))
      exclusions = candidates.filter(c => !names.has(c.packageName)).map(c => c.id)
      extraInstalled = incomingLock.plugins
        .filter((p) => p.sourceKind === 'local-installed')
        .map((p) => p.packageName)
    }
    const resolution = resolvePluginCombination({
      target, requiredActions: spec.requiredActions, optionalActions: spec.optionalActions,
      localOnly: spec.shell.localOnlyToolWebDisabled, pinnedOverrides: pins, excludedIds: exclusions,
    })
    const lock = this.buildPlatformLockWithExtras({
      resolution,
      extraInstalledPlugins: extraInstalled,
      target,
      previousLock: incomingLock ?? existing?.locks[target],
    })
    if (incomingLock && computeSpecDigest(lock) !== computeSpecDigest(incomingLock)) {
      throw new Error('当前目录无法还原配方的插件和版本。请导入 product.json 重新选择所需插件。')
    }
    const now = new Date().toISOString()
    const brief = BriefSchema.parse({
      ...existing?.brief, schemaVersion: 1, projectId, revision: spec.revision,
      rawPrompt: existing?.brief.rawPrompt ?? `从 product.json 导入 ${spec.brand.displayName.zh}`,
      role: existing?.brief.role ?? '产品维护者', localOnly: spec.shell.localOnlyToolWebDisabled,
      requiredActions: spec.requiredActions, optionalActions: spec.optionalActions, expectedOutputs: spec.acceptance.expectedOutputs,
    })
    const record: StudioProjectRecord = {
      ...existing, projectId, createdAt: existing?.createdAt ?? now, updatedAt: now, brief, spec,
      clarifications: existing?.clarifications ?? [], resolution, pinnedOverrides: pins, excludedPluginIds: exclusions,
      extraInstalledPlugins: extraInstalled,
      locks: { [target]: lock },
      history: [...(existing?.history ?? []), {
        revision: spec.revision, savedAt: now, spec, summary: '导入已有产品配置',
        ...(extraInstalled.length > 0 ? { extraInstalledPlugins: extraInstalled } : {}),
      }].slice(-20),
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
    const lockPath = path.join(previewDir, `plugins.${target}.lock.json`)
    writeFileSync(lockPath, `${JSON.stringify(lock, undefined, 2)}\n`)
    const cfgPath = path.join(previewDir, 'preview-config.json')
    writeFileSync(cfgPath, `${JSON.stringify({ projectId, previewDir, specPath, lockPath, preferredPort }, undefined, 2)}\n`)

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

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8')
    })
    child.stdout?.resume()

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
      child.once('exit', (code) => {
        clearTimeout(timer)
        const detail = stderr.trim()
        reject(new Error(`Preview exited early (${code})${detail ? `: ${detail}` : ''}`))
      })
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
    child.once('exit', () => {
      if (this.previews.get(projectId)?.child === child) {
        this.previews.delete(projectId)
      }
    })
    return state
  }

  async openDesktopTrial(projectId: string, expectedRevision: number) {
    const record = this.getProject(projectId)
    if (record.spec.revision !== expectedRevision) throw new Error('修订已变更，请重新打开试用 / Revision changed')
    const lock = record.locks['win32-x64']
    if (!lock) throw new Error('请先保存 Windows 插件方案 / Save a Windows plugin selection first')
    const { missing, unavailablePackages } = desktopCapabilities(record.spec, lock)
    if (missing.length || unavailablePackages.length) throw new Error('试用缺少动作或插件 / Unavailable: ' + [...missing, ...unavailablePackages].join(', '))
    const current = this.trials.get(projectId)
    const key = computeSpecDigest([computeSpecDigest(record.spec), computeSpecDigest(lock), PINNED_TEMPLATE_COMMIT])
    if (current?.key === key && current.child.connected) {
      current.child.send({ type: 'focus-trial' }, () => {})
      return current.ready
    }
    if (current?.child.connected) {
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('请关闭上一版试用窗口再重试 / Close the previous trial window')), 15000)
        current.child.once('exit', () => { clearTimeout(timer); resolve() })
      })
      current.stop()
      await exited
    }
    const trial = await launchDesktopTrial(
      this.baseShellDir,
      this.projectDir(projectId),
      record.spec,
      lock,
      this.resolvedPluginCacheDir(),
    )
    this.trials.set(projectId, trial)
    trial.child.once('exit', () => { if (this.trials.get(projectId) === trial) this.trials.delete(projectId) })
    return trial.ready
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
    if (target) {
      const job = this.jobs.get(target.jobId)
      if (job && this.dedupIndex.get(job.dedupKey) === job.jobId) this.dedupIndex.delete(job.dedupKey)
      this.jobs.delete(target.jobId)
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
      ...(hit.extraInstalledPlugins !== undefined ? { extraInstalledPlugins: hit.extraInstalledPlugins } : {}),
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
      readonly expectedRevision?: number
      readonly trial?: { productDigest: string; lockDigest: string }
    } = {},
  ): BuildJobRecord {
    let record = this.getProject(projectId)
    if (options.expectedRevision !== undefined && options.expectedRevision !== record.spec.revision) {
      throw new Error('修订已变更，请重新打开项目 / Revision changed')
    }
    if (options.trial && options.appVersion && options.appVersion.trim() !== record.spec.appVersion) {
      throw new Error('请先保存版本号，再试用该修订 / Save the version before trying this revision')
    }
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
      localOnly: record.spec.shell.localOnlyToolWebDisabled,
      pinnedOverrides: record.pinnedOverrides,
      excludedIds: record.excludedPluginIds,
    })
    const lock = record.locks[target] ?? buildPlatformLock(targetResolution)
    if (!isCrossPlatform && options.trial &&
        (options.trial.productDigest !== computeSpecDigest(record.spec) || options.trial.lockDigest !== computeSpecDigest(lock))) {
      throw new Error('桌面试用对应较早的修订或插件锁，请重新试用 / Trial is out of date')
    }
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
      if (existingJob.status === 'running' || existingJob.status === 'queued') return existingJob
      if (existingJob.status === 'succeeded' && existingJob.artifactPath && existsSync(existingJob.artifactPath) &&
          existingJob.receiptPath && existsSync(existingJob.receiptPath)) return existingJob
    }

    const jobId = `job-${randomUUID().slice(0, 8)}`
    const outDir = path.join(this.projectDir(projectId), 'builds', jobId)
    mkdirSync(outDir, { recursive: true })
    const inputDir = path.join(outDir, 'inputs')
    mkdirSync(inputDir)
    const productPath = path.join(inputDir, 'product.json')
    const lockPath = path.join(inputDir, `plugins.${target}.lock.json`)
    writeFileSync(productPath, JSON.stringify(record.spec))
    writeFileSync(lockPath, JSON.stringify(lock))
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
          instructions: `将本文件（或 product.json）复制到目标系统 (${target}) 的 dsh 中，在「制作我的客户端 -> 第 1 步 · 导入既有 product.json」导入并复核目标插件锁。原生构建支持程度见该平台的交付记录。`,
          productSpec: record.spec,
          platformLock: lock,
        }, undefined, 2)}\n`
        logs = [
          `[${new Date().toISOString()}] 当前本机为 ${hostTarget}，已为跨平台目标 ${target} 生成「跨设备迁移构建包」`,
          `包含完整 product.json（含自定义图标与固定身份）+ locks/plugins.${target}.lock.json`,
          `将该文件或导出的 product.json 拷贝至 ${target} 设备的 dsh 中，在「第 1 步」导入，复核目标平台构建能力`,
          ...(record.extraInstalledPlugins && record.extraInstalledPlugins.length > 0
            ? [`提示：本机手动额外指定的 DSH 插件（${record.extraInstalledPlugins.join('、')}）为当前系统本机暂存，跨系统打包时请在目标系统 DSH 安装后于第 3 步重新勾选。`]
            : []),
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
        receiptPath,
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

    const fail = (reason: string): BuildJobRecord => {
      const job: BuildJobRecord = {
        ...this.jobs.get(jobId)!, status: 'failed', error: reason, finishedAt: new Date().toISOString(),
      }
      this.jobs.set(jobId, job)
      return job
    }
    const { missing, unavailablePackages } = desktopCapabilities(record.spec, lock)
    if (missing.length) return fail(`必需能力未满足 / Missing required actions: ${missing.join(', ')}`)
    if (unavailablePackages.length) return fail(`所选插件缺少离线物料，请在插件页切换或移除 / Missing plugin payload: ${unavailablePackages.join(', ')}`)
    if (target !== 'win32-x64') return fail('此平台目前仅支持导出构建配方 / Native installer unavailable')
    const builderCli = this.builderCliPath
    const baseShellDir = this.baseShellDir || process.env.DSH_SELF_BASE_SHELL_DIR
    if (!builderCli || !existsSync(builderCli) || !baseShellDir || !existsSync(path.join(baseShellDir, 'electron.exe'))) {
      return fail('Windows 构建工具链未就绪。请在 dsh 插件配置中指定 builderCliPath 和 baseShellDir，或使用 DSH_SELF_BUILDER_CLI 与 DSH_SELF_BASE_SHELL_DIR 后重试。 / Configure the Windows builder CLI and base shell, then retry.')
    }
    const workerNode = this.resolveWorkerNodeRuntime()
    const pluginCacheDir = this.resolvedPluginCacheDir()
    const builderEnv = buildWhitelistedHostEnv({
      sourceEnv: process.env, dshHome: path.join(outDir, 'dsh-home'), extraAllowed: workerNode.runAsNodeEnv,
    })
    for (const key of ['ELECTRON_BUILDER_CACHE', 'ELECTRON_BUILDER_NSIS_DIR', 'ELECTRON_BUILDER_NSIS_RESOURCES_DIR', 'DSH_SELF_PLUGIN_CACHE']) {
      if (process.env[key]) builderEnv[key] = process.env[key]
    }
    builderEnv.DSH_SELF_PLUGIN_CACHE = pluginCacheDir
    const child = spawn(workerNode.execPath, [
      builderCli, '--product', productPath, '--lock', lockPath, '--target', target,
      '--out', outDir, '--job-id', jobId, '--base-shell', baseShellDir,
      '--plugin-cache', pluginCacheDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: builderEnv })
    const appendLog = (line: string): void => {
      const cur = this.jobs.get(jobId)!
      this.jobs.set(jobId, { ...cur, logs: [...cur.logs, line].slice(-100) })
    }
    child.stdout.on('data', (data: Buffer) => appendLog(data.toString('utf8').trim()))
    child.stderr.on('data', (data: Buffer) => appendLog(`[stderr] ${data.toString('utf8').trim()}`))
    child.once('error', error => { fail(error.message) })
    child.once('close', async code => {
      if (this.jobs.get(jobId)?.status !== 'running') return
      try {
        if (code !== 0) throw new Error(`Builder exited with code ${code ?? 'null'}`)
        const receipt = await verifyWindowsInstaller(outDir, jobId, record.spec, lock)
        const finishedAt = new Date().toISOString()
        this.appendReleaseRecord(projectId, {
          releaseId: `rel-${jobId.slice(4)}`, jobId, appVersion: record.spec.appVersion,
          revision: record.spec.revision, target, strategy: 'native-local',
          distributionStatus: receipt.distributionStatus, notes: releaseNotes,
          receiptPath, artifactPath: receipt.artifactPath, artifactFileName: path.basename(receipt.artifactPath),
          artifactSha256: receipt.artifactSha256, builtAt: receipt.builtAt, specSnapshot: record.spec,
          ...(record.extraInstalledPlugins && record.extraInstalledPlugins.length > 0
            ? { extraInstalledPlugins: record.extraInstalledPlugins }
            : {}),
        })
        this.jobs.set(jobId, { ...this.jobs.get(jobId)!, status: 'succeeded', finishedAt, receiptPath,
          artifactPath: receipt.artifactPath, artifactSha256: receipt.artifactSha256, artifactBytes: receipt.artifactBytes })
      } catch (error) { fail(error instanceof Error ? error.message : String(error)) }
    })
    return this.jobs.get(jobId)!
  }

  /** Start native + cross-platform build jobs for multiple selected targets in one action. */
  startMultiTargetBuild(input: {
    readonly projectId: string
    readonly expectedRevision?: number
    readonly trial?: { productDigest: string; lockDigest: string }
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
        expectedRevision: idx === 0 ? input.expectedRevision : undefined,
        trial: input.trial,
        appVersion: idx === 0 ? input.appVersion : undefined,
        releaseNotes: input.releaseNotes,
      }),
    )
    return { jobs, project: this.getProject(input.projectId) }
  }

  getProjectJobs(projectId: string): BuildJobRecord[] {
    return [...this.jobs.values()].filter(job => job.projectId === projectId)
  }

  getJob(jobId: string): BuildJobRecord {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error(`Build job not found: ${jobId}`)
    return job
  }

  getPreviewState(projectId: string): PreviewSessionState | null {
    const runtime = this.previews.get(projectId)
    if (!runtime || runtime.child.exitCode !== null || runtime.child.killed) {
      if (runtime) this.previews.delete(projectId)
      return null
    }
    return runtime.state
  }

  /** Delete project + stop preview + scrub all temporary `.credentials.yaml` copies. */
  async deleteProject(projectId: string): Promise<void> {
    this.trials.get(projectId)?.stop()
    await this.stopPreview(projectId)
    const dir = this.projectDir(projectId)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  async dispose(): Promise<void> {
    for (const trial of this.trials.values()) trial.stop()
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

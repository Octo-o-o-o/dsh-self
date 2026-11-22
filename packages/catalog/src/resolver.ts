import {
  PINNED_DSH_RUNTIME_VERSION,
  PINNED_NODE_VERSION,
  PINNED_TEMPLATE_COMMIT,
  computeSpecDigest,
  type ActionId,
  type PlatformLock,
  type SupportedTarget,
} from '@dsh-self/product-spec'
import { evaluateCatalogAdmission, type UpstreamEvaluateFn } from './admission.js'
import { findCombinationConflicts } from './conflicts.js'
import { DEFAULT_CATALOG } from './registry.js'
import type {
  ActionCandidateOption,
  ActionCoverageRecord,
  AdmissionReport,
  CatalogEntry,
  PluginResolutionRequest,
  PluginResolutionResult,
  TrustTier,
} from './types.js'

const TRUST_RANK: Record<TrustTier, number> = {
  builtin: 3,
  'verified-community': 2,
  'experimental-unverified': 1,
}

function privilegeDisclosureFor(entry: CatalogEntry): string {
  if (entry.runtimeKind === 'client-only') {
    return '纯前端视图包（共享已认证本机 Host 同源上下文，无独立 Host 代码）'
  }
  return '本机 Host 插件（运行于宿主 Node 进程内，拥有当前系统用户完整文件与网络权限，无插件级 OS 沙箱）'
}

interface CandidateEvaluation {
  readonly entry: CatalogEntry
  readonly admission: AdmissionReport
  readonly catalogIndex: number
}

function scoreCombination(
  combo: readonly CandidateEvaluation[],
  target: SupportedTarget,
  localOnly: boolean,
): readonly number[] {
  // Higher is better across lexicographical tuple:
  // 1) Verified on target count / avg trust rank
  // 2) Matches localOnly (0 extra external services preferred)
  // 3) Fewer required connections
  // 4) Fewer plugins overall
  // 5) Earlier catalog index (deterministic tie-breaker)
  const verifiedScore = combo.reduce(
    (sum, c) => sum + TRUST_RANK[c.entry.trustTier] * 10 + (c.entry.verifiedTargets.includes(target) ? 5 : 0),
    0,
  )
  const totalConnections = new Set(combo.flatMap((c) => c.entry.requiresConnections)).size
  const localPenalty = localOnly ? -totalConnections * 100 : 0
  const indexPenalty = -combo.reduce((sum, c) => sum + c.catalogIndex, 0)
  return [verifiedScore, localPenalty, -totalConnections, -combo.length, indexPenalty]
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!
  }
  return 0
}

/**
 * Deterministic minimum-cover combination solver over the curated catalog:
 * - Runs 4-step static admission on every candidate
 * - Blocks `experimental-unverified` unless explicitly allowed
 * - Enumerates conflict-free combinations (6 dimensions) covering maximal required actions
 * - Ranks deterministically by trust tier + platform verification > local constraint > fewer services > fewer plugins > catalog order
 */
export function resolvePluginCombination(
  request: PluginResolutionRequest,
  options: {
    readonly catalog?: readonly CatalogEntry[]
    readonly upstreamEvaluate?: UpstreamEvaluateFn
  } = {},
): PluginResolutionResult {
  const catalog = options.catalog ?? DEFAULT_CATALOG
  const excluded = new Set(request.excludedIds ?? [])
  const localOnly = request.localOnly ?? false
  const allowExperimental = request.allowExperimental ?? false

  const evaluated: CandidateEvaluation[] = catalog.map((entry, catalogIndex) => ({
    entry,
    admission: evaluateCatalogAdmission(entry, request.target, {
      upstreamEvaluate: options.upstreamEvaluate,
    }),
    catalogIndex,
  }))

  const admissibleByAction = new Map<ActionId, CandidateEvaluation[]>()
  const rejectedByAction = new Map<ActionId, { id: string; packageName: string; reason: string }[]>()
  const mcpHintsByAction = new Map<ActionId, { readonly zh: string; readonly en: string }>()

  const allWantedActions = [...new Set([...request.requiredActions, ...(request.optionalActions ?? [])])]
  for (const actionId of allWantedActions) {
    admissibleByAction.set(actionId, [])
    rejectedByAction.set(actionId, [])
  }

  for (const cand of evaluated) {
    for (const actionId of cand.entry.providesActions) {
      if (!admissibleByAction.has(actionId)) continue
      if (cand.entry.mcpAlternativeHint && !mcpHintsByAction.has(actionId)) {
        mcpHintsByAction.set(actionId, cand.entry.mcpAlternativeHint)
      }
      if (excluded.has(cand.entry.id) || excluded.has(cand.entry.packageName)) {
        rejectedByAction.get(actionId)!.push({
          id: cand.entry.id,
          packageName: cand.entry.packageName,
          reason: 'Excluded by user override',
        })
        continue
      }
      if (!cand.admission.admitted) {
        rejectedByAction.get(actionId)!.push({
          id: cand.entry.id,
          packageName: cand.entry.packageName,
          reason: cand.admission.failures.join('; '),
        })
        continue
      }
      if (cand.entry.trustTier === 'experimental-unverified' && !allowExperimental) {
        const pinned = request.pinnedOverrides?.[actionId] === cand.entry.id
        if (!pinned) {
          rejectedByAction.get(actionId)!.push({
            id: cand.entry.id,
            packageName: cand.entry.packageName,
            reason: 'experimental-unverified tier is not auto-selected without explicit user confirmation',
          })
          continue
        }
      }
      admissibleByAction.get(actionId)!.push(cand)
    }
  }

  // Filter required actions that have at least one admissible candidate
  const coverableRequired = request.requiredActions.filter(
    (actionId) => (admissibleByAction.get(actionId)?.length ?? 0) > 0,
  )

  // Enumerate all conflict-free assignments for coverableRequired (catalog is small & bounded)
  let bestCombo: CandidateEvaluation[] = []
  let bestScore: readonly number[] | null = null

  const assignRequired = (idx: number, chosenMap: Map<string, CandidateEvaluation>): void => {
    if (idx === coverableRequired.length) {
      const combo = [...chosenMap.values()]
      if (findCombinationConflicts(combo.map((c) => c.entry)).length > 0) return
      const score = scoreCombination(combo, request.target, localOnly)
      if (bestScore === null || compareScores(score, bestScore) > 0) {
        bestScore = score
        bestCombo = combo
      }
      return
    }
    const actionId = coverableRequired[idx]!
    const pinned = request.pinnedOverrides?.[actionId]
    // Already covered by an earlier chosen plugin (unless user explicitly pinned a different provider)?
    for (const existing of chosenMap.values()) {
      if (existing.entry.providesActions.includes(actionId) && (!pinned || existing.entry.id === pinned)) {
        assignRequired(idx + 1, chosenMap)
        return
      }
    }
    const pool = admissibleByAction.get(actionId) ?? []
    const orderedPool = pinned
      ? [...pool].sort((a, b) => (a.entry.id === pinned ? -1 : b.entry.id === pinned ? 1 : 0))
      : pool
    for (const cand of orderedPool) {
      if (pinned && cand.entry.id !== pinned) continue
      const nextMap = new Map(chosenMap)
      nextMap.set(cand.entry.id, cand)
      if (findCombinationConflicts([...nextMap.values()].map((c) => c.entry)).length > 0) continue
      assignRequired(idx + 1, nextMap)
    }
  }

  assignRequired(0, new Map())

  // Greedily add optional actions if conflict-free and respecting localOnly (or honoring explicit user pin)
  const finalMap = new Map(bestCombo.map((c) => [c.entry.id, c]))
  for (const optAction of request.optionalActions ?? []) {
    const pinned = request.pinnedOverrides?.[optAction]
    if ([...finalMap.values()].some((c) => c.entry.providesActions.includes(optAction) && (!pinned || c.entry.id === pinned))) {
      continue
    }
    const pool = admissibleByAction.get(optAction) ?? []
    const ranked = pinned
      ? pool.filter((c) => c.entry.id === pinned)
      : [...pool].sort((a, b) =>
          compareScores(
            scoreCombination([b], request.target, localOnly),
            scoreCombination([a], request.target, localOnly),
          ),
        )
    for (const cand of ranked) {
      if (!pinned && localOnly && cand.entry.requiresConnections.length > 0) continue
      const trial = [...finalMap.values(), cand]
      if (findCombinationConflicts(trial.map((c) => c.entry)).length === 0) {
        finalMap.set(cand.entry.id, cand)
        break
      }
    }
  }

  const selectedEvaluations = [...finalMap.values()].sort((a, b) => a.catalogIndex - b.catalogIndex)
  const selected = selectedEvaluations.map((c) => c.entry)
  const warnings: string[] = []
  for (const c of selectedEvaluations) {
    for (const w of c.admission.warnings) {
      warnings.push(`${c.entry.packageName}@${c.entry.version}: ${w}`)
    }
  }

  const coverage: ActionCoverageRecord[] = allWantedActions.map((actionId) => {
    const pinnedId = request.pinnedOverrides?.[actionId]
    const provider =
      (pinnedId ? selectedEvaluations.find((c) => c.entry.id === pinnedId && c.entry.providesActions.includes(actionId)) : undefined) ??
      selectedEvaluations.find((c) => c.entry.providesActions.includes(actionId))
    const rejected = [...(rejectedByAction.get(actionId) ?? [])]
    for (const other of admissibleByAction.get(actionId) ?? []) {
      if (provider && other.entry.id === provider.entry.id) continue
      if (provider) {
        rejected.push({
          id: other.entry.id,
          packageName: other.entry.packageName,
          reason: `Outranked by ${provider.entry.packageName}@${provider.entry.version} (${provider.entry.trustTier})`,
        })
      }
    }

    // Build complete user-facing candidate list (selected + compatible alternatives + trial alternatives + blocked)
    const candidates: ActionCandidateOption[] = evaluated
      .filter((cand) => cand.entry.providesActions.includes(actionId))
      .map((cand) => {
        const isSelected = provider?.entry.id === cand.entry.id
        const isExcluded = excluded.has(cand.entry.id) || excluded.has(cand.entry.packageName)
        const requiresTrial = cand.entry.trustTier === 'experimental-unverified' || cand.admission.requiresTrialVerification
        const selectable = cand.admission.admitted && !isExcluded
        let blockReason: string | undefined
        if (!cand.admission.admitted) {
          blockReason = cand.admission.failures.join('; ')
        } else if (isExcluded) {
          blockReason = '已被手动排除'
        }
        return {
          id: cand.entry.id,
          packageName: cand.entry.packageName,
          version: cand.entry.version,
          trustTier: cand.entry.trustTier,
          runtimeKind: cand.entry.runtimeKind,
          description: cand.entry.description,
          admitted: cand.admission.admitted,
          selectable,
          selected: isSelected,
          pinnedByUser: isSelected && pinnedId === cand.entry.id,
          requiresTrialConfirmation: requiresTrial,
          ...(blockReason ? { blockReason } : {}),
          ...(cand.entry.mcpAlternativeHint ? { mcpAlternativeHint: cand.entry.mcpAlternativeHint } : {}),
        }
      })

    if (!provider) {
      return {
        actionId,
        selectedPluginId: null,
        selectedPackageName: null,
        trustTier: null,
        runtimeKind: null,
        pinnedByUser: false,
        reason: rejected.length > 0
          ? `No admissible conflict-free candidate (${rejected.map((r) => `${r.packageName}: ${r.reason}`).join(' | ')})`
          : 'No catalog entry provides this action yet',
        privilegeDisclosure: '未选中插件',
        candidates,
        rejectedCandidates: rejected,
        mcpAlternativeHint: mcpHintsByAction.get(actionId),
      }
    }
    return {
      actionId,
      selectedPluginId: provider.entry.id,
      selectedPackageName: provider.entry.packageName,
      trustTier: provider.entry.trustTier,
      runtimeKind: provider.entry.runtimeKind,
      pinnedByUser: pinnedId === provider.entry.id,
      reason: `Selected ${provider.entry.packageName}@${provider.entry.version} (tier=${provider.entry.trustTier}, dsh=${provider.admission.dshState})`,
      privilegeDisclosure: privilegeDisclosureFor(provider.entry),
      candidates,
      rejectedCandidates: rejected,
      mcpAlternativeHint: provider.entry.mcpAlternativeHint,
    }
  })

  const missingRequiredActions = request.requiredActions.filter(
    (actionId) => !selected.some((entry) => entry.providesActions.includes(actionId)),
  )

  const hostPlugins = selected.filter((e) => e.runtimeKind !== 'client-only')
  const hostPrivilegeSummary = hostPlugins.length === 0
    ? '当前方案仅含纯前端视图包（共享已认证本机 Host 同源上下文）。'
    : `以下 ${hostPlugins.length} 个 Host 包运行在宿主进程内，拥有当前系统用户完整文件与网络权限（dsh ${PINNED_DSH_RUNTIME_VERSION} 无插件级 OS 沙箱）：${hostPlugins.map((e) => `${e.packageName}@${e.version}`).join('、')}。`

  return {
    target: request.target,
    selected,
    coverage,
    missingRequiredActions,
    warnings,
    hostPrivilegeSummary,
  }
}

/** Generate a platform-specific lockfile (`locks/plugins.<platform>-<arch>.lock.json`). */
export function buildPlatformLock(
  resolution: PluginResolutionResult,
  options: {
    readonly dshRuntimeVersion?: string
    readonly templateCommit?: string
    readonly nodeVersion?: string
  } = {},
): PlatformLock {
  const plugins = resolution.selected.map((entry, idx) => ({
    packageName: entry.packageName,
    version: entry.version,
    trustTier: entry.trustTier,
    sourceKind: entry.sourceKind,
    sourceRef: entry.sourceRef,
    integritySha512: entry.integritySha512,
    runtimeKind: entry.runtimeKind,
    providesActions: [...entry.providesActions],
    requiresConnections: [...entry.requiresConnections],
    enableOrder: idx,
  }))
  return {
    schemaVersion: 1,
    target: resolution.target,
    dshRuntimeVersion: options.dshRuntimeVersion ?? PINNED_DSH_RUNTIME_VERSION,
    templateCommit: options.templateCommit ?? PINNED_TEMPLATE_COMMIT,
    nodeVersion: options.nodeVersion ?? PINNED_NODE_VERSION,
    transitiveLockDigest: computeSpecDigest(plugins),
    plugins,
  }
}

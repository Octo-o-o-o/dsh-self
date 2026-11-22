import semver from 'semver'
import { parseDocument } from 'yaml'
import { PINNED_DSH_RUNTIME_VERSION, PINNED_NODE_VERSION, type SupportedTarget } from '@dsh-self/product-spec'
import type { AdmissionReport, CatalogEntry, DshCompatibilityState, PackageManifestSnapshot } from './types.js'

const CORDIS_RUNTIME_VERSION = '4.1.0'
const REACT_RUNTIME_VERSION = '18.3.1'

export type UpstreamEvaluateFn = (
  manifest: object,
  exemptions?: Readonly<Record<string, readonly string[]>>,
  runtimeVersion?: string,
) => { requirements: Record<string, string>; exempted: boolean } | undefined

function splitTarget(target: SupportedTarget): { readonly os: string; readonly cpu: string } {
  const [os, cpu] = target.split('-') as [string, string]
  return { os, cpu }
}

/**
 * Pure reference implementation matching `deepseek-harness@dsh-v0.2.2-rc.5`
 * `packages/boot/app-boot/src/plugin-compatibility.ts` (for environments where
 * runtime app-boot is not dynamically passed in).
 */
export function fallbackEvaluateDshCompatibility(
  manifest: PackageManifestSnapshot,
  runtimeVersion = PINNED_DSH_RUNTIME_VERSION,
): Record<string, string> {
  const satisfies = (range: string): boolean =>
    range.trim() !== '' && semver.satisfies(runtimeVersion, range, { includePrerelease: true })

  if (manifest.engines && Object.hasOwn(manifest.engines, 'dsh')) {
    const range = manifest.engines.dsh ?? ''
    return satisfies(range) ? {} : { 'engines.dsh': range }
  }
  const peers = manifest.peerDependencies ?? {}
  const unmet: Record<string, string> = {}
  for (const [name, range] of Object.entries(peers)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const req = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    if (!satisfies(req)) unmet[name] = range
  }
  return unmet
}

/** Scan YAML text for executable `!!js` custom tags or alias bombs. */
export function inspectPatchYamlSafety(yamlText: string): {
  readonly validPlainYaml: boolean
  readonly usesJsTag: boolean
  readonly errors: readonly string[]
} {
  const usesJsTag = /!!js\b/.test(yamlText)
  const doc = parseDocument(yamlText, { schema: 'core', customTags: [] })
  const errors: string[] = []
  for (const err of doc.errors) errors.push(err.message)
  if (errors.length === 0) {
    try {
      doc.toJS({ maxAliasCount: 0 })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return {
    validPlainYaml: !usesJsTag && errors.length === 0,
    usesJsTag,
    errors,
  }
}

/**
 * Four-step static admission matching implementation-plan §4.2:
 * 1) Valid `dsh.bundle.patch` + `!!js` YAML scan
 * 2) Platform (`dsh.bundle.platforms`, `os`, `cpu`, `engines.node`) + `--ignore-scripts` native addon gate
 * 3) Explicit `@deepseek-ai/cordis` (~4.1.0) & `react` (18.x) peer check
 * 4) Raw-field tri-state pre-check BEFORE `evaluatePluginCompatibility` (zero auto allow-version)
 */
export function evaluateCatalogAdmission(
  entry: CatalogEntry,
  target: SupportedTarget,
  options: {
    readonly dshRuntimeVersion?: string
    readonly nodeVersion?: string
    readonly upstreamEvaluate?: UpstreamEvaluateFn
    readonly rejectJsTag?: boolean
  } = {},
): AdmissionReport {
  const dshVersion = options.dshRuntimeVersion ?? PINNED_DSH_RUNTIME_VERSION
  const nodeVersion = options.nodeVersion ?? PINNED_NODE_VERSION
  const { os, cpu } = splitTarget(target)
  const manifest = entry.manifest
  const failures: string[] = []
  const warnings: string[] = []

  // Step 1: Valid dsh.bundle.patch + !!js scan
  const patch = manifest.dsh?.bundle?.patch
  const hasValidPatch =
    (typeof patch === 'string' && patch.trim().length > 0) ||
    (Array.isArray(patch) && patch.length > 0 && patch.every((p) => typeof p === 'string' && p.trim().length > 0))
  if (!hasValidPatch) {
    failures.push('Step 1 failed: missing valid dsh.bundle.patch declaration')
  }

  let usesJsTag = false
  if (entry.patchYaml !== undefined) {
    const yamlCheck = inspectPatchYamlSafety(entry.patchYaml)
    usesJsTag = yamlCheck.usesJsTag
    if (usesJsTag) {
      if (options.rejectJsTag) {
        failures.push('Step 1 failed: cordis.patch.yml uses forbidden !!js custom tag')
      } else if (entry.trustTier !== 'builtin') {
        warnings.push('cordis.patch.yml contains !!js tag — elevated manual audit required')
      }
    } else if (!yamlCheck.validPlainYaml) {
      failures.push(`Step 1 failed: invalid YAML patch (${yamlCheck.errors.join('; ')})`)
    }
  }

  // Step 2: Target platform, os, cpu, engines.node, and --ignore-scripts native addon gate
  const bundlePlatforms = manifest.dsh?.bundle?.platforms
  if (Array.isArray(bundlePlatforms) && bundlePlatforms.length > 0) {
    if (!bundlePlatforms.includes(target) && !bundlePlatforms.includes(os)) {
      failures.push(`Step 2 failed: dsh.bundle.platforms [${bundlePlatforms.join(', ')}] does not include ${target}`)
    }
  }
  if (Array.isArray(manifest.os) && manifest.os.length > 0 && !manifest.os.includes(os)) {
    failures.push(`Step 2 failed: manifest os [${manifest.os.join(', ')}] does not include ${os}`)
  }
  if (Array.isArray(manifest.cpu) && manifest.cpu.length > 0 && !manifest.cpu.includes(cpu)) {
    failures.push(`Step 2 failed: manifest cpu [${manifest.cpu.join(', ')}] does not include ${cpu}`)
  }
  const nodeRange = manifest.engines?.node
  if (nodeRange !== undefined && !semver.satisfies(nodeVersion, nodeRange, { includePrerelease: true })) {
    failures.push(`Step 2 failed: engines.node "${nodeRange}" incompatible with pinned Node ${nodeVersion}`)
  }
  if (entry.nativeAddonPolicy === 'requires-postinstall-compile') {
    failures.push('Step 2 failed: requires postinstall native compilation (incompatible with --ignore-scripts)')
  }
  const scripts = manifest.scripts ?? {}
  if (
    entry.nativeAddonPolicy !== 'pure-js' &&
    entry.nativeAddonPolicy !== 'prebuilt-napi-optional' &&
    (scripts.postinstall || scripts.install)
  ) {
    failures.push('Step 2 failed: unapproved install lifecycle script under --ignore-scripts policy')
  }

  // Step 3: Explicit @deepseek-ai/cordis & react peer checks (closing upstream engines.dsh blind spot)
  const peers = manifest.peerDependencies ?? {}
  const cordisRange = peers['@deepseek-ai/cordis']
  if (cordisRange !== undefined && !['workspace:*', 'workspace:^', 'workspace:~'].includes(cordisRange)) {
    if (!semver.satisfies(CORDIS_RUNTIME_VERSION, cordisRange, { includePrerelease: true })) {
      failures.push(`Step 3 failed: peer @deepseek-ai/cordis "${cordisRange}" incompatible with ${CORDIS_RUNTIME_VERSION}`)
    }
  }
  const reactRange = peers.react
  if (reactRange !== undefined) {
    if (!semver.satisfies(REACT_RUNTIME_VERSION, reactRange, { includePrerelease: true })) {
      failures.push(`Step 3 failed: peer react "${reactRange}" incompatible with ${REACT_RUNTIME_VERSION}`)
    }
  }

  // Step 4: Tri-state raw-field pre-check BEFORE evaluatePluginCompatibility (zero auto allow-version)
  const hasEnginesDsh = manifest.engines !== undefined && Object.hasOwn(manifest.engines, 'dsh')
  const hasDshPeers = Object.keys(peers).some(
    (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
  let unmetDshRequirements: Record<string, string> = {}
  let dshState: DshCompatibilityState
  if (!hasEnginesDsh && !hasDshPeers) {
    dshState = 'undeclared'
    warnings.push('No engines.dsh or @deepseek-ai/dsh* peer declared; requires cold-start & fixture trial before locking')
  } else {
    if (options.upstreamEvaluate) {
      const result = options.upstreamEvaluate(manifest, {}, dshVersion)
      unmetDshRequirements = result?.requirements ?? {}
    } else {
      unmetDshRequirements = fallbackEvaluateDshCompatibility(manifest, dshVersion)
    }
    if (Object.keys(unmetDshRequirements).length === 0) {
      dshState = 'declared-compatible'
    } else {
      dshState = 'declared-incompatible'
      failures.push(
        `Step 4 failed: ${Object.keys(unmetDshRequirements).length} dsh requirement mismatch(es): ${Object.entries(unmetDshRequirements).map(([k, v]) => `${k}@${v}`).join(', ')}`,
      )
    }
  }

  const verifiedOnTarget = entry.verifiedTargets.includes(target)
  const requiresTrialVerification = dshState === 'undeclared' && !verifiedOnTarget
  return {
    packageName: entry.packageName,
    version: entry.version,
    admitted: failures.length === 0,
    dshState,
    requiresTrialVerification,
    usesJsYamlTag: usesJsTag,
    failures,
    warnings,
    unmetDshRequirements,
  }
}

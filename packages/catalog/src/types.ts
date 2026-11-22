import type { ActionId, CapabilityIntent, SupportedTarget } from '@dsh-self/product-spec'

export type TrustTier = 'builtin' | 'verified-community' | 'experimental-unverified'
export type RuntimeKind = 'client-only' | 'host-and-client' | 'host-only'
export type DshCompatibilityState = 'declared-compatible' | 'undeclared' | 'declared-incompatible'

export interface PackageManifestSnapshot {
  readonly name: string
  readonly version: string
  readonly os?: readonly string[]
  readonly cpu?: readonly string[]
  readonly engines?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, string>>
  readonly dsh?: {
    readonly bundle?: {
      readonly patch?: string | readonly string[]
      readonly platforms?: readonly string[]
    }
    readonly client?: Readonly<Record<string, unknown>>
  }
}

export interface ConflictFootprint {
  readonly entryIds: readonly string[]
  readonly httpRoutes: readonly string[]
  readonly panelIds: readonly string[]
  readonly exclusiveSlots: readonly string[]
  readonly shortcuts: readonly string[]
  readonly serviceNames: readonly string[]
}

export interface CatalogEntry {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly trustTier: TrustTier
  readonly sourceKind: 'builtin' | 'npm' | 'git'
  readonly sourceRef: string
  readonly integritySha512: string
  readonly runtimeKind: RuntimeKind
  readonly description: { readonly zh: string; readonly en: string }
  readonly providesActions: readonly ActionId[]
  readonly capabilityIntents: readonly CapabilityIntent[]
  readonly requiresConnections: readonly string[]
  readonly verifiedTargets: readonly SupportedTarget[]
  readonly manifest: PackageManifestSnapshot
  /** Raw cordis.patch.yml text for static !!js / schema verification. */
  readonly patchYaml?: string
  /** Whether the package uses native bindings via prebuilt optionalDependencies (allowed) vs node-gyp postinstall (rejected). */
  readonly nativeAddonPolicy: 'pure-js' | 'prebuilt-napi-optional' | 'requires-postinstall-compile'
  readonly footprint: ConflictFootprint
  /** Shared workspace project dir convention if coexisting with shell Home panel. */
  readonly sharedWorkspaceDir?: string
  /** Optional guidance if incompatible / unavailable. */
  readonly mcpAlternativeHint?: { readonly zh: string; readonly en: string }
}

export interface AdmissionReport {
  readonly packageName: string
  readonly version: string
  readonly admitted: boolean
  readonly dshState: DshCompatibilityState
  readonly requiresTrialVerification: boolean
  readonly usesJsYamlTag: boolean
  readonly failures: readonly string[]
  readonly warnings: readonly string[]
  readonly unmetDshRequirements: Readonly<Record<string, string>>
}

export interface ConflictDetail {
  readonly dimension: keyof ConflictFootprint
  readonly value: string
  readonly pluginA: string
  readonly pluginB: string
}

export interface PluginResolutionRequest {
  readonly target: SupportedTarget
  readonly requiredActions: readonly ActionId[]
  readonly optionalActions?: readonly ActionId[]
  readonly localOnly?: boolean
  readonly allowExperimental?: boolean
  readonly pinnedOverrides?: Readonly<Record<string, string>>
  readonly excludedIds?: readonly string[]
}

export interface ActionCandidateOption {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly trustTier: TrustTier
  readonly runtimeKind: RuntimeKind
  readonly description: { readonly zh: string; readonly en: string }
  readonly admitted: boolean
  readonly selectable: boolean
  readonly selected: boolean
  readonly pinnedByUser: boolean
  readonly requiresTrialConfirmation: boolean
  readonly blockReason?: string
  readonly mcpAlternativeHint?: { readonly zh: string; readonly en: string }
}

export interface ActionCoverageRecord {
  readonly actionId: ActionId
  readonly selectedPluginId: string | null
  readonly selectedPackageName: string | null
  readonly trustTier: TrustTier | null
  readonly runtimeKind: RuntimeKind | null
  readonly pinnedByUser: boolean
  readonly reason: string
  readonly privilegeDisclosure: string
  readonly candidates: readonly ActionCandidateOption[]
  readonly rejectedCandidates: readonly {
    readonly id: string
    readonly packageName: string
    readonly reason: string
  }[]
  readonly mcpAlternativeHint?: { readonly zh: string; readonly en: string }
}

export interface PluginResolutionResult {
  readonly target: SupportedTarget
  readonly selected: readonly CatalogEntry[]
  readonly coverage: readonly ActionCoverageRecord[]
  readonly missingRequiredActions: readonly ActionId[]
  readonly warnings: readonly string[]
  readonly hostPrivilegeSummary: string
}

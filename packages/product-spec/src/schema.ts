import { createHash } from 'node:crypto'
import semver from 'semver'
import { z } from 'zod'
import {
  ACTION_IDS,
  CAPABILITY_INTENTS,
  LAYOUT_PRESETS,
  WIDGET_CATALOG,
  WIDGET_IDS,
  type ActionId,
  type LayoutPreset,
  type WidgetId,
} from './catalog-contract.js'
import {
  APP_ID_RE,
  INTERNAL_SLUG_RE,
  MAX_DISPLAY_NAME_LENGTH,
  UUID_V4_RE,
  sanitizeDisplayName,
  type RuntimeIdentityProjection,
} from './identity.js'
import { HEX_COLOR_RE, deriveThemeTokens } from './theme.js'
import { BRAND_ICON_PRESETS, MAX_ICON_DATA_URL_LENGTH } from './icon.js'

export const CURRENT_SCHEMA_VERSION = 1
export const CURRENT_DATA_FORMAT_VERSION = 1
export const CURRENT_DSH_SESSION_FORMAT_VERSION = 3
export const PINNED_DSH_RUNTIME_VERSION = '0.2.2-rc.5'
export const PINNED_NODE_VERSION = '26.12.1'
export const PINNED_TEMPLATE_COMMIT = '48f3f01961d34509bc85245dadc6dfdaede9b65b'

export const SUPPORTED_TARGETS = [
  'win32-x64',
  'linux-x64',
  'darwin-arm64',
  'darwin-x64',
] as const

export type SupportedTarget = (typeof SUPPORTED_TARGETS)[number]

const HexColorSchema = z.string().regex(HEX_COLOR_RE, 'Color must be #RRGGBB')
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/i, 'Expected 64-char SHA-256 hex')
const DisplayTextSchema = z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH).transform(sanitizeDisplayName)

export const SemanticSeedPaletteSchema = z.object({
  canvas: HexColorSchema,
  surface: HexColorSchema,
  ink: HexColorSchema,
  mutedInk: HexColorSchema,
  accent: HexColorSchema,
  border: HexColorSchema,
  danger: HexColorSchema,
  ok: HexColorSchema,
}).strict()

export const ProductIdentitySchema = z.object({
  productId: z.string().regex(UUID_V4_RE),
  internalSlug: z.string().regex(INTERNAL_SLUG_RE),
  appId: z.string().regex(APP_ID_RE),
  appUserModelId: z.string().regex(APP_ID_RE),
  nsisGuid: z.string().regex(UUID_V4_RE),
  executableName: z.string().regex(INTERNAL_SLUG_RE),
  userDataDirName: z.string().regex(INTERNAL_SLUG_RE),
}).strict().superRefine((val, ctx) => {
  const shortId = val.productId.toLowerCase().slice(0, 8)
  if (!val.internalSlug.endsWith(`-${shortId}`)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'internalSlug suffix must match productId shortId' })
  }
  if (val.nsisGuid.toLowerCase() !== val.productId.toLowerCase()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'nsisGuid must equal productId' })
  }
  if (val.appUserModelId !== val.appId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'appUserModelId must equal appId' })
  }
  if (val.executableName !== val.internalSlug || val.userDataDirName !== val.internalSlug) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'executableName and userDataDirName must match internalSlug' })
  }
})

const WidgetIdSchema = z.enum(WIDGET_IDS as [WidgetId, ...WidgetId[]])
const ActionIdSchema = z.enum(ACTION_IDS as [ActionId, ...ActionId[]])
const LayoutPresetSchema = z.enum(LAYOUT_PRESETS as unknown as [LayoutPreset, ...LayoutPreset[]])

export const ProductSpecSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  revision: z.number().int().min(1),
  appVersion: z.string().refine((v) => semver.valid(v) !== null, 'Invalid semver appVersion'),
  dataFormatVersion: z.number().int().min(1).default(CURRENT_DATA_FORMAT_VERSION),
  dshSessionFormatVersion: z.number().int().min(1).default(CURRENT_DSH_SESSION_FORMAT_VERSION),
  supportedTargets: z.array(z.enum(SUPPORTED_TARGETS)).min(1).default(['win32-x64']),
  identity: ProductIdentitySchema,
  brand: z.object({
    displayName: z.object({
      zh: DisplayTextSchema,
      en: DisplayTextSchema,
    }).strict(),
    iconSha256: Sha256HexSchema,
    iconPreset: z.enum(BRAND_ICON_PRESETS).optional(),
    iconDataUrl: z.string().max(MAX_ICON_DATA_URL_LENGTH).refine(
      (s) =>
        s.startsWith('data:image/png;base64,') ||
        s.startsWith('data:image/jpeg;base64,') ||
        s.startsWith('data:image/webp;base64,') ||
        s.startsWith('data:image/svg+xml;base64,'),
      'iconDataUrl must be a base64 PNG/JPEG/WEBP/SVG data URL',
    ).optional(),
  }).strict(),
  theme: z.object({
    seeds: z.object({
      light: SemanticSeedPaletteSchema,
      dark: SemanticSeedPaletteSchema,
    }).strict(),
  }).strict(),
  shell: z.object({
    defaultPanel: z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i),
    navOrder: z.array(z.string().min(1).max(64).regex(/^[a-z0-9._-]+$/i)).min(1),
    showReadinessBar: z.boolean().default(true),
    localOnlyToolWebDisabled: z.boolean().default(true),
  }).strict(),
  home: z.object({
    layout: LayoutPresetSchema,
    sections: z.array(WidgetIdSchema).min(1).max(8),
    primaryAction: ActionIdSchema,
    sectionLabels: z.record(z.string(), DisplayTextSchema).optional(),
  }).strict(),
  requiredActions: z.array(ActionIdSchema).min(1),
  optionalActions: z.array(ActionIdSchema).default([]),
  acceptance: z.object({
    fixtures: z.array(z.string().min(1).max(128)).min(1),
    expectedOutputs: z.array(z.string().min(1).max(128)).min(1),
  }).strict(),
}).strict().superRefine((spec, ctx) => {
  for (const sectionId of spec.home.sections) {
    const widget = WIDGET_CATALOG[sectionId]
    if (!(widget.allowedLayouts as readonly LayoutPreset[]).includes(spec.home.layout)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['home', 'sections'],
        message: `Widget "${sectionId}" is not allowed in layout "${spec.home.layout}"`,
      })
    }
  }
})

export type ProductSpec = z.infer<typeof ProductSpecSchema>

export const BriefAssetSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['image', 'url', 'audio-transcript', 'document']),
  intent: z.enum(['reference-workbench', 'workspace-content']),
  fileName: z.string().max(128).optional(),
  url: z.string().url().optional(),
  sha256: Sha256HexSchema.optional(),
  summary: z.string().max(500),
}).strict()

export const BriefSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().regex(UUID_V4_RE),
  revision: z.number().int().min(1),
  rawPrompt: z.string().min(1).max(8000),
  transcript: z.string().max(8000).optional(),
  role: z.string().min(1).max(128),
  localOnly: z.boolean().default(true),
  assets: z.array(BriefAssetSchema).default([]),
  requiredActions: z.array(ActionIdSchema).min(1),
  optionalActions: z.array(ActionIdSchema).default([]),
  expectedOutputs: z.array(z.string().min(1).max(128)).default([]),
  clarifications: z.array(z.object({
    question: z.string().min(1).max(256),
    answer: z.string().min(1).max(512),
    affectsWorkflow: z.boolean(),
  }).strict()).default([]),
  provenance: z.array(z.object({
    field: z.string().min(1).max(128),
    sourceId: z.string().min(1).max(128),
  }).strict()).default([]),
}).strict()

export type Brief = z.infer<typeof BriefSchema>

/** CaMeL dual-channel output of tool-free visual/web extraction. */
export const ExtractionResultSchema = z.object({
  /** Safe closed-set values that may enter the planning LLM control flow. */
  controlSafe: z.object({
    layoutPreset: LayoutPresetSchema,
    sectionIds: z.array(WidgetIdSchema).min(1).max(8),
    capabilityIntents: z.array(z.enum(CAPABILITY_INTENTS)).min(1),
    paletteHex: z.object({
      light: SemanticSeedPaletteSchema,
      dark: SemanticSeedPaletteSchema,
    }).strict(),
    modalityUsed: z.enum(['vision-model', 'local-dominant-color-fallback']),
  }).strict(),
  /**
   * Untrusted extracted labels from external images/webpages.
   * MUST NEVER be interpolated into the planning LLM prompt; only displayed in
   * Studio UI for explicit human review/declassification.
   */
  taintedDisplay: z.object({
    provenance: z.literal('untrusted-extract'),
    suggestedNameZh: z.string().max(MAX_DISPLAY_NAME_LENGTH).optional(),
    suggestedNameEn: z.string().max(MAX_DISPLAY_NAME_LENGTH).optional(),
    sectionTitles: z.record(z.string(), z.string().max(48)).default({}),
  }).strict(),
}).strict()

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>

export const LockedPluginEntrySchema = z.object({
  packageName: z.string().min(1),
  version: z.string().min(1),
  trustTier: z.enum(['builtin', 'verified-community', 'experimental-unverified']),
  sourceKind: z.enum(['builtin', 'npm', 'git']),
  sourceRef: z.string().min(1),
  integritySha512: z.string().regex(/^sha512-[A-Za-z0-9+/=]+$/),
  runtimeKind: z.enum(['client-only', 'host-and-client', 'host-only']),
  providesActions: z.array(ActionIdSchema),
  requiresConnections: z.array(z.string()).default([]),
  enableOrder: z.number().int().min(0),
}).strict()

export type LockedPluginEntry = z.infer<typeof LockedPluginEntrySchema>

export const PlatformLockSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.enum(SUPPORTED_TARGETS),
  dshRuntimeVersion: z.string().min(1),
  templateCommit: z.string().min(7),
  nodeVersion: z.string().min(1),
  transitiveLockDigest: Sha256HexSchema,
  plugins: z.array(LockedPluginEntrySchema),
}).strict()

export type PlatformLock = z.infer<typeof PlatformLockSchema>

export const SeedManifestSchema = z.object({
  schemaVersion: z.literal(1),
  target: z.enum(SUPPORTED_TARGETS),
  dshRuntimeVersion: z.string().min(1),
  seedHash: Sha256HexSchema,
  seedBytes: z.number().int().min(1),
  maxEntryRelPath: z.number().int().min(1).max(130),
  managedBundles: z.array(z.string().min(1)),
  builtAt: z.string().datetime(),
}).strict()

export type SeedManifest = z.infer<typeof SeedManifestSchema>

export const StateVersionSchema = z.object({
  dataFormatVersion: z.number().int().min(1),
  dshSessionFormatVersion: z.number().int().min(1),
  lastAppVersion: z.string().refine((v) => semver.valid(v) !== null),
  updatedAt: z.string().datetime(),
}).strict()

export type StateVersion = z.infer<typeof StateVersionSchema>

export const ActiveProfileSchema = z.object({
  active: z.string().regex(/^p-[a-f0-9]{8,16}$/),
  previous: z.string().regex(/^p-[a-f0-9]{8,16}$/).nullable(),
  state: z.enum(['pending_verification', 'verified', 'rolled_back', 'safe_mode']),
  bootAttempts: z.number().int().min(0),
  dshRuntimeVersion: z.string().min(1),
  previousDshRuntimeVersion: z.string().min(1).nullable(),
  activeSeedHash: Sha256HexSchema,
  previousSeedHash: Sha256HexSchema.nullable(),
  failedSlotHash: Sha256HexSchema.nullable(),
  updatedAt: z.string().datetime(),
}).strict()

export type ActiveProfileState = z.infer<typeof ActiveProfileSchema>

export const PreviewReportSchema = z.object({
  schemaVersion: z.literal(1),
  productId: z.string().regex(UUID_V4_RE),
  revision: z.number().int().min(1),
  target: z.enum(SUPPORTED_TARGETS),
  productDigest: Sha256HexSchema,
  lockDigest: Sha256HexSchema,
  templateCommit: z.string().min(7),
  passedFixtures: z.array(z.string()),
  mockedConnections: z.array(z.string()),
  verifiedAt: z.string().datetime(),
}).strict()

export type PreviewReport = z.infer<typeof PreviewReportSchema>

export const BuildReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().min(1),
  dedupKey: Sha256HexSchema,
  productId: z.string().regex(UUID_V4_RE),
  revision: z.number().int().min(1),
  appVersion: z.string().min(1),
  target: z.enum(SUPPORTED_TARGETS),
  productDigest: Sha256HexSchema,
  lockDigest: Sha256HexSchema,
  seedHash: Sha256HexSchema,
  templateCommit: z.string().min(7),
  toolchainVersion: z.string().min(1),
  distributionStatus: z.enum(['unsigned-local-test', 'signed-release']),
  artifactPath: z.string().min(1),
  artifactSha256: Sha256HexSchema,
  artifactBytes: z.number().int().min(1),
  builtAt: z.string().datetime(),
}).strict()

export type BuildReceipt = z.infer<typeof BuildReceiptSchema>

/** Canonical JSON digest with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export function computeSpecDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function projectRuntimeIdentity(spec: ProductSpec): RuntimeIdentityProjection {
  const derived = deriveThemeTokens(spec.theme.seeds)
  return {
    schemaVersion: spec.schemaVersion,
    revision: spec.revision,
    appVersion: spec.appVersion,
    dataFormatVersion: spec.dataFormatVersion,
    dshSessionFormatVersion: spec.dshSessionFormatVersion,
    identity: spec.identity,
    displayName: spec.brand.displayName,
    chromeColors: derived.chrome,
  }
}

export interface DowngradeCheckResult {
  readonly blocked: boolean
  readonly reason?: string
  readonly requiredDataFormatVersion?: number
  readonly requiredSessionFormatVersion?: number
}

/**
 * Prevent older installers from corrupting data created by newer schema versions,
 * while allowing patch/minor upgrades that share the same dataFormatVersion.
 */
export function checkStateDowngrade(
  stored: StateVersion | null,
  current: { readonly dataFormatVersion: number; readonly dshSessionFormatVersion: number },
): DowngradeCheckResult {
  if (stored === null) return { blocked: false }
  if (current.dataFormatVersion < stored.dataFormatVersion) {
    return {
      blocked: true,
      reason: `Stored dataFormatVersion (${stored.dataFormatVersion}, last opened by v${stored.lastAppVersion}) exceeds supported version (${current.dataFormatVersion})`,
      requiredDataFormatVersion: stored.dataFormatVersion,
    }
  }
  if (current.dshSessionFormatVersion < stored.dshSessionFormatVersion) {
    return {
      blocked: true,
      reason: `Stored dshSessionFormatVersion (${stored.dshSessionFormatVersion}, last opened by v${stored.lastAppVersion}) exceeds supported version (${current.dshSessionFormatVersion})`,
      requiredSessionFormatVersion: stored.dshSessionFormatVersion,
    }
  }
  return { blocked: false }
}

/** Migrate older raw product.json payloads (e.g. removing legacy singular `target` or upgrading `chromeColors`). */
export function migrateProductSpec(raw: unknown): ProductSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('product.json must be an object')
  }
  const clone = structuredClone(raw) as Record<string, unknown>
  if ('target' in clone) {
    if (typeof clone.target === 'string' && !('supportedTargets' in clone)) {
      clone.supportedTargets = [clone.target]
    } else if (typeof clone.target === 'object' && clone.target !== null) {
      const t = clone.target as { platform?: string; arch?: string }
      if (t.platform && t.arch && !('supportedTargets' in clone)) {
        clone.supportedTargets = [`${t.platform}-${t.arch}`]
      }
    }
    delete clone.target
  }
  return ProductSpecSchema.parse(clone)
}

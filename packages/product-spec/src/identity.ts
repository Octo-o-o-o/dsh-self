import { randomUUID } from 'node:crypto'

/** Enforced internalSlug format: max 21 chars, lowercase ASCII + 8-hex suffix. */
export const INTERNAL_SLUG_RE = /^[a-z][a-z0-9-]{0,11}-[a-f0-9]{8}$/
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const APP_ID_RE = /^app\.dshself\.u[a-f0-9]{8}$/
export const MAX_DISPLAY_NAME_LENGTH = 64

export const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'CONIN$', 'CONOUT$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

export interface ProductIdentity {
  readonly productId: string
  readonly internalSlug: string
  readonly appId: string
  readonly appUserModelId: string
  readonly nsisGuid: string
  readonly executableName: string
  readonly userDataDirName: string
}

export interface LocalizedDisplayName {
  readonly zh: string
  readonly en: string
}

export interface RuntimeIdentityProjection {
  readonly schemaVersion: number
  readonly revision: number
  readonly appVersion: string
  readonly dataFormatVersion: number
  readonly dshSessionFormatVersion: number
  readonly identity: ProductIdentity
  readonly displayName: LocalizedDisplayName
  readonly chromeColors: {
    readonly light: { readonly backgroundColor: string; readonly titleBarColor: string; readonly symbolColor: string }
    readonly dark: { readonly backgroundColor: string; readonly titleBarColor: string; readonly symbolColor: string }
  }
}

/** Strip control characters (including CR/LF/NUL/bidi controls), collapse whitespace, clamp length. */
export function sanitizeDisplayName(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) {
    throw new Error('displayName must contain at least one printable character')
  }
  return cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH)
}

/** Check whether a filename (with or without extension) collides with a Windows reserved device name. */
export function isWindowsReservedName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  const stem = trimmed.split('.')[0]?.toUpperCase() ?? ''
  return WINDOWS_RESERVED_NAMES.has(stem) || WINDOWS_RESERVED_NAMES.has(trimmed.toUpperCase())
}

/** Sanitize a displayName for use as a Windows `.lnk` shortcut basename, falling back to internalSlug. */
export function sanitizeWindowsShortcutName(displayName: string, fallbackSlug: string): string {
  const stripped = sanitizeDisplayName(displayName)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[. ]+$/g, '')
    .trim()
  if (stripped.length === 0 || isWindowsReservedName(stripped)) {
    return fallbackSlug
  }
  return stripped.slice(0, MAX_DISPLAY_NAME_LENGTH)
}

/** Derive an immutable ProductIdentity once at product creation time. */
export function deriveProductIdentity(options: {
  readonly productId?: string
  readonly shortHint?: string
} = {}): ProductIdentity {
  const productId = (options.productId ?? randomUUID()).toLowerCase()
  if (!UUID_V4_RE.test(productId)) {
    throw new Error(`Invalid productId UUID: ${productId}`)
  }
  const shortId = productId.slice(0, 8)
  const hintRaw = (options.shortHint ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  let prefix = hintRaw.slice(0, 12).replace(/-+$/g, '')
  if (prefix.length === 0 || !/^[a-z]/.test(prefix) || isWindowsReservedName(prefix)) {
    prefix = 'app'
  }
  const internalSlug = `${prefix}-${shortId}`
  if (!INTERNAL_SLUG_RE.test(internalSlug)) {
    throw new Error(`Derived internalSlug failed contract: ${internalSlug}`)
  }
  const appId = `app.dshself.u${shortId}`
  return {
    productId,
    internalSlug,
    appId,
    appUserModelId: appId,
    nsisGuid: productId,
    executableName: internalSlug,
    userDataDirName: internalSlug,
  }
}

/** Enforce that frozen identity fields are never mutated across revisions of the same product. */
export function assertIdentityImmutable(previous: ProductIdentity, next: ProductIdentity): void {
  const keys: readonly (keyof ProductIdentity)[] = [
    'productId',
    'internalSlug',
    'appId',
    'appUserModelId',
    'nsisGuid',
    'executableName',
    'userDataDirName',
  ]
  for (const key of keys) {
    if (previous[key] !== next[key]) {
      throw new Error(
        `Immutable product identity field "${key}" changed from "${previous[key]}" to "${next[key]}"`,
      )
    }
  }
}

/** Escape arbitrary string safely for HTML text/attribute rendering (zero unescaped interpolation). */
export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ProductSpecSchema,
  deriveThemeTokens,
  projectRuntimeIdentity,
  type ProductSpec,
  type RuntimeIdentityProjection,
} from '@dsh-self/product-spec'

export const LOG_MAX_BYTES = 2 * 1024 * 1024
export const LOG_KEEP = 5
export const REAP_ENUM_TIMEOUT_MS = 5_000

export interface LoadedProductRuntimeConfig {
  readonly productDir: string
  readonly identity: RuntimeIdentityProjection
  readonly product: ProductSpec
  readonly iconPngPath: string | undefined
}

/**
 * Resolve `resources/product/` (packaged) or `DSH_SELF_PRODUCT_DIR` (dev/preview)
 * synchronously BEFORE `app.requestSingleInstanceLock()`.
 */
export function resolveProductDir(options: {
  readonly packaged: boolean
  readonly resourcesPath: string
  readonly env?: NodeJS.ProcessEnv
}): string {
  const env = options.env ?? process.env
  const override = env.DSH_SELF_PRODUCT_DIR
  if (override !== undefined && override.length > 0) {
    return path.resolve(override)
  }
  if (options.packaged) {
    return path.join(options.resourcesPath, 'product')
  }
  throw new Error('DSH_SELF_PRODUCT_DIR must be set when running desktop template unpackaged')
}

export function loadProductRuntimeConfigSync(productDir: string): LoadedProductRuntimeConfig {
  const productPath = path.join(productDir, 'product.json')
  const identityPath = path.join(productDir, 'identity.json')
  if (!existsSync(productPath)) {
    throw new Error(`Missing product definition: ${productPath}`)
  }
  const product = ProductSpecSchema.parse(JSON.parse(readFileSync(productPath, 'utf8')))
  let identity: RuntimeIdentityProjection
  if (existsSync(identityPath)) {
    const raw = JSON.parse(readFileSync(identityPath, 'utf8')) as RuntimeIdentityProjection
    if (raw.identity.productId !== product.identity.productId || raw.identity.internalSlug !== product.identity.internalSlug) {
      throw new Error('identity.json disagrees with product.json immutable identity')
    }
    identity = raw
  } else {
    identity = projectRuntimeIdentity(product)
  }
  const iconCandidate = path.join(productDir, 'icon.png')
  return {
    productDir,
    identity,
    product,
    iconPngPath: existsSync(iconCandidate) ? iconCandidate : undefined,
  }
}

export function chromeColorsForTheme(
  product: ProductSpec,
  shouldUseDarkColors: boolean,
): { readonly backgroundColor: string; readonly titleBarColor: string; readonly symbolColor: string } {
  const derived = deriveThemeTokens(product.theme.seeds)
  return shouldUseDarkColors ? derived.chrome.dark : derived.chrome.light
}

export function localizedDisplayName(
  displayName: { readonly zh: string; readonly en: string },
  locale: string,
): string {
  return locale.toLowerCase().startsWith('zh') ? displayName.zh : displayName.en
}

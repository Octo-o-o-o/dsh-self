/**
 * `dsh-theme-product` Client plugin:
 * Fetches active `/api/product-spec`, derives WCAG-clamped `--dsw-*` tokens for light & dark themes,
 * and injects them into `document.documentElement` and official `ctx.theme` if present.
 */
import { deriveThemeTokens } from '@dsh-self/product-spec/theme'
import type { ProductSpec } from '@dsh-self/product-spec'

interface ThemeContext {
  effect(run: () => void | (() => void), label?: string): void
  get?(service: string): unknown
}

export const inject: string[] = []

function buildThemeCss(spec: ProductSpec): string {
  const derived = deriveThemeTokens(spec.theme.seeds)
  const lightVars = Object.entries(derived.tokens).map(([k, v]) => `  ${k}: ${v.light};`).join('\n')
  const darkVars = Object.entries(derived.tokens).map(([k, v]) => `  ${k}: ${v.dark};`).join('\n')
  return [
    `:root, [data-theme="light"] {\n${lightVars}\n}`,
    `[data-theme="dark"], .dark {\n${darkVars}\n}`,
  ].join('\n')
}

export function apply(ctx: ThemeContext): void {
  ctx.effect(() => {
    let disposed = false
    const styleEl = document.createElement('style')
    styleEl.id = 'dsh-self-product-theme'
    document.head.appendChild(styleEl)

    const applySpec = (spec: ProductSpec): void => {
      if (disposed) return
      styleEl.textContent = buildThemeCss(spec)
      if (spec.brand.displayName.zh) {
        document.title = spec.brand.displayName.zh
      }
      if (spec.brand.iconDataUrl && /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(spec.brand.iconDataUrl)) {
        let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
        if (!link) {
          link = document.createElement('link')
          link.rel = 'icon'
          document.head.appendChild(link)
        }
        link.href = spec.brand.iconDataUrl
      }
    }

    void fetch('/api/product-spec', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((spec) => {
        if (spec) applySpec(spec as ProductSpec)
      })
      .catch(() => {})

    return () => {
      disposed = true
      styleEl.remove()
    }
  }, 'dsh-theme-product: inject tokens')
}

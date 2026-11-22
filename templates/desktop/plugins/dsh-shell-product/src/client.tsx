/**
 * `dsh-shell-product` Client plugin:
 * - Renders the branded standalone product Home panel (`home`) across all 4 controlled layouts
 * - Bridges readiness CTA via official `settings.launcher` -> `openSettings('models')`
 * - Lazily loads `./client.docx-viewer.js` via `require.async` (strictly keeping `docx-preview` out of main chunk)
 * - Registers `plugins.detail.badge` showing locked core bundle status
 */
import { useEffect, useState } from 'react'
import { BusinessWorkspace } from './business-workspace.js'
import type { ActionId } from '@dsh-self/product-spec/catalog-contract'
import type { ProductSpec } from '@dsh-self/product-spec'

interface SlotsApi {
  inject(key: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface LayoutApi {
  selectPanel?(panelId: string): void
}

interface LocaleApi {
  register(ns: string, locale: string, dict: Record<string, string>): () => void
  bind(ns: string): (key: string) => string
}

interface ClientContext {
  effect(run: () => void | (() => void), label?: string): void
  get?(name: string): unknown
  slots: SlotsApi
  locale: LocaleApi
  layout?: LayoutApi
}

const NS = 'dshSelfProduct'

function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 7.2L8 2.5l5.5 4.7V13.5h-3.8V9.8H6.3v3.7H2.5V7.2Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

function ProductHomePanel({ ctx }: { readonly ctx: ClientContext }) {
  const [spec, setSpec] = useState<ProductSpec | null>(null)
  const [actions, setActions] = useState<ActionId[]>([])
  const [extraBundles, setExtraBundles] = useState<readonly { readonly packageName: string; readonly version: string; readonly sourceKind: string; readonly description?: string }[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void Promise.all(['/api/product-spec', '/api/dsh-self/capabilities'].map(async url => {
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      return response.json()
    })).then(([product, capabilities]) => {
      if (active) {
        setActions(capabilities.actions)
        setExtraBundles(Array.isArray(capabilities.extraBundles) ? capabilities.extraBundles : [])
        setSpec(product)
      }
    }).catch(cause => { if (active) setError(String(cause)) })
    return () => { active = false }
  }, [])

  const openModelSettings = () => {
    const launcher = ctx.get?.('settingsLauncher') as { openSettings?: (tab: string) => void } | undefined
    if (launcher?.openSettings) {
      launcher.openSettings('models')
    } else {
      ctx.layout?.selectPanel?.('settings')
    }
  }

  if (!spec) return <div role="status" style={{ padding: 24 }}>{error || '正在加载工作台 / Loading workspace…'}</div>
  return (
    <div data-dsh-product-ready={spec.identity.productId} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', overflow: 'auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {spec.brand.iconDataUrl && (
            <img src={spec.brand.iconDataUrl} alt={spec.brand.displayName.zh} style={{ width: 32, height: 32, borderRadius: 8 }} />
          )}
          <div>
            <h1 style={{ margin: 0, fontSize: 18 }}>{spec.brand.displayName.zh}</h1>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{spec.brand.displayName.en} · v{spec.appVersion}</div>
          </div>
        </div>
      </header>

      {spec.shell.showReadinessBar && (
        <div style={{
          padding: '10px 14px',
          borderRadius: 10,
          border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
        }}>
          <span>本地文件无需模型凭据 / Local files work offline</span>
          <button type="button" onClick={openModelSettings} style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
            前往配置模型
          </button>
        </div>
      )}

      {actions.includes('bid.importRequirements') && <BusinessWorkspace kind="bid" actions={actions} home={spec.home} />}
      {actions.includes('design.importImage') && <BusinessWorkspace kind="design" actions={actions} home={spec.home} />}
      {(actions.includes('research.openProResearch') || actions.includes('design.openImageDesign')) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
          {actions.includes('research.openProResearch') && (
            <section style={{ padding: 14, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)', background: 'var(--dsw-alias-card-fill, #ffffff)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>ChatGPT Pro Research（多轮调研）</h3>
              <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>
                已打包内置 chatgpt-pro-research@0.3.6 与 pro-research 技能；浏览器登录态独立保存在本客户端数据目录内（需本机 Chrome + ChatGPT 网页账号）。
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => ctx.layout?.selectPanel?.('chatgpt-pro-research')}
                  style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}
                >
                  打开 Pro Research 面板
                </button>
              </div>
            </section>
          )}
          {actions.includes('design.openImageDesign') && (
            <section style={{ padding: 14, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)', background: 'var(--dsw-alias-card-fill, #ffffff)', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>GPT-Image Design（AI 生图与 HTML Demo）</h3>
              <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>
                已打包内置 gpt-image-design@0.3.6 与 pro-design 技能；支持 OpenAI 兼容生图 API（请在插件设置填写 imageApiKey）或 ChatGPT 网页通道。
              </p>
              <div>
                <button
                  type="button"
                  onClick={() => ctx.layout?.selectPanel?.('gpt-image-design')}
                  style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}
                >
                  打开 Image Design 面板
                </button>
              </div>
            </section>
          )}
        </div>
      )}
      {(() => {
        const customExtras = extraBundles.filter(
          (b) => b.packageName !== 'chatgpt-pro-research' && b.packageName !== 'gpt-image-design',
        )
        if (customExtras.length === 0) return null
        return (
          <section style={{ padding: 14, borderRadius: 12, border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)', background: 'var(--dsw-alias-card-fill, #ffffff)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>已附加的扩展 DSH 插件（{customExtras.length}）</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
              {customExtras.map((b) => (
                <div key={b.packageName} style={{ padding: 10, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l1, #e2e8f0)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{b.packageName}</strong>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>v{b.version}</span>
                  </div>
                  {b.description && <p style={{ margin: 0, fontSize: 12, opacity: 0.8 }}>{b.description}</p>}
                  <span style={{ fontSize: 11, opacity: 0.65 }}>
                    已随独立配置槽加载（如有界面入口请从左侧导航栏打开）
                  </span>
                </div>
              ))}
            </div>
          </section>
        )
      })()}
    </div>
  )
}

function CoreBundleBadge() {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 999,
      fontSize: 11,
      border: '1px solid #0f766e',
      color: '#0f766e',
    }}>
      内置核心工作台 · 不可卸载
    </span>
  )
}

export const inject = ['slots', 'locale', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const d1 = ctx.locale.register(NS, 'zh', { home: '工作台首页' })
    const d2 = ctx.locale.register(NS, 'en', { home: 'Home' })
    return () => { d1(); d2() }
  }, 'dsh-shell-product: locale')

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'home',
    locale: NS,
    inject: () => ({ ctx }),
  }, ProductHomePanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'home',
    order: 1,
    locale: NS,
    label: () => t('home'),
  }, HomeIcon))

  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge',
    id: 'dsh-shell-product-core-badge',
  }, CoreBundleBadge))

  // Select branded Home panel on initial launch
  ctx.effect(() => {
    ctx.layout?.selectPanel?.('home')
  }, 'dsh-shell-product: default home')
}

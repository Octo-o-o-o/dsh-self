/**
 * `dsh-shell-product` Client plugin:
 * - Renders the branded standalone product Home panel (`home`) across all 4 controlled layouts
 * - Bridges readiness CTA via official `settings.launcher` -> `openSettings('models')`
 * - Lazily loads `./client.docx-viewer.js` via `require.async` (strictly keeping `docx-preview` out of main chunk)
 * - Registers `plugins.detail.badge` showing locked core bundle status
 */
import { useEffect, useState } from 'react'
import { WIDGET_CATALOG } from '@dsh-self/product-spec/catalog-contract'
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
  const [viewerSrcdoc, setViewerSrcdoc] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('')

  useEffect(() => {
    void fetch('/api/product-spec', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data) setSpec(data as ProductSpec) })
      .catch(() => {})
  }, [])

  const openModelSettings = () => {
    const launcher = ctx.get?.('settingsLauncher') as { openSettings?: (tab: string) => void } | undefined
    if (launcher?.openSettings) {
      launcher.openSettings('models')
    } else {
      ctx.layout?.selectPanel?.('settings')
    }
  }

  const openLazyDocxViewer = async () => {
    setStatus('正在按需加载 OOXML 安全沙箱预览模块…')
    try {
      const reqAsync = (globalThis as unknown as { require?: { async?: (id: string) => Promise<any> } }).require?.async
      if (reqAsync) {
        const mod = await reqAsync('./client.docx-viewer.js')
        const { srcdoc } = mod.buildDocxViewerSrcdoc({
          htmlFragment: '<p data-dsh-anchor="dsh-blk-1">招标文件已通过安全过滤，点击任意段落可同步定位。</p>',
        })
        setViewerSrcdoc(srcdoc)
        setStatus('沙箱预览已就绪（Opaque Origin iframe）')
      } else {
        setStatus('开发模式：client.docx-viewer.js 将于打包后按需加载')
      }
    } catch (error) {
      setStatus(`加载预览模块失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!spec) {
    return <div style={{ padding: 24 }}>正在加载工作台配置…</div>
  }

  const gridStyle: Record<string, string> =
    spec.home.layout === 'single-column'
      ? { display: 'grid', gridTemplateColumns: '1fr', maxWidth: '820px', gap: '14px' }
      : spec.home.layout === 'three-pane'
        ? { display: 'grid', gridTemplateColumns: '220px 1fr 260px', gap: '14px' }
        : spec.home.layout === 'dashboard-grid'
          ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px' }
          : { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '14px' }

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, height: '100%', overflow: 'auto' }}>
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
        <span style={{ fontSize: 12, opacity: 0.75 }}>工作区：~/Workspaces/{spec.identity.internalSlug}</span>
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
          <span>本地导入、预览、批注与导出立即可用；如需 AI 辅助功能，请配置模型凭据。</span>
          <button type="button" onClick={openModelSettings} style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
            前往配置模型
          </button>
        </div>
      )}

      <div style={gridStyle}>
        {spec.home.sections.map((secId) => {
          const meta = WIDGET_CATALOG[secId]
          const title = spec.home.sectionLabels?.[secId] ?? meta.title.zh
          return (
            <section key={secId} style={{
              padding: 14,
              borderRadius: 12,
              border: '1px solid var(--dsw-alias-border-l2, #cbd5e1)',
              background: 'var(--dsw-alias-card-fill, #ffffff)',
            }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>{title}</h3>
              {secId === 'bid-preview' ? (
                <div>
                  <button type="button" onClick={() => void openLazyDocxViewer()} style={{ padding: '6px 12px', borderRadius: 8, cursor: 'pointer' }}>
                    打开 OOXML 沙箱预览
                  </button>
                  {status && <p style={{ fontSize: 12, opacity: 0.75 }}>{status}</p>}
                  {viewerSrcdoc && (
                    <iframe
                      sandbox="allow-scripts"
                      srcDoc={viewerSrcdoc}
                      title="Sandboxed DOCX Preview"
                      style={{ width: '100%', height: 240, border: '1px solid #cbd5e1', borderRadius: 8, marginTop: 8 }}
                    />
                  )}
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: 13, opacity: 0.78 }}>{meta.title.en} · 已就绪</p>
              )}
            </section>
          )
        })}
      </div>
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

/**
 * Official dsh@0.2.2-rc.5 Client entrypoint for `dsh-self-studio`.
 * Uses ONLY official public dsh client services (`slots`, `locale`, `layout`, `connection.rpc`),
 * ZERO OctoDeEpSeeK private APIs.
 */
import { StudioPanel, type StudioRpcCaller } from './StudioPanel.js'

interface LocaleApi {
  register(namespace: string, locale: string, dictionary: Record<string, string>): () => void
  bind(namespace: string): (key: string) => string
}

interface SlotsApi {
  inject(key: string, callback: () => unknown): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ConnectionClientApi {
  readonly rpc: {
    call<T = unknown>(
      channel: string,
      endpoint: string,
      payload?: unknown,
    ): Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>
  }
}

interface ClientContext {
  effect(run: () => void | (() => void), label?: string): void
  locale: LocaleApi
  slots: SlotsApi
  connection: ConnectionClientApi
}

const NS = 'dshSelfStudio'
const PANEL_ID = 'dsh-self-studio'

function StudioIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2" width="13" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 6.5h6M8 4.2v4.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

export const inject = ['slots', 'locale', 'layout', 'connection']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const disposeZh = ctx.locale.register(NS, 'zh', {
      nav: '制作我的客户端',
      title: '制作我的客户端',
      subtitle: '一句话生成专属独立桌面客户端',
      'step.new': '写需求',
      'step.choose': '选方案',
      'step.plugins': '选插件',
      'step.appearance': '改外观',
      'step.preview': '试用微调',
      'step.build': '生成安装包',
    })
    const disposeEn = ctx.locale.register(NS, 'en', {
      nav: 'Build My Client',
      title: 'Build My Client',
      subtitle: 'Create an isolated standalone desktop client',
      'step.new': 'Requirements',
      'step.choose': 'Blueprints',
      'step.plugins': 'Plugins',
      'step.appearance': 'Appearance',
      'step.preview': 'Preview & Tweak',
      'step.build': 'Build',
    })
    return () => {
      disposeZh()
      disposeEn()
    }
  }, 'dsh-self-studio: dictionaries')

  const t = ctx.locale.bind(NS)
  const rpc: StudioRpcCaller = {
    async call<T = any>(method: string, payload?: Record<string, unknown>): Promise<T> {
      const res = await ctx.connection.rpc.call<T>('/api', 'dshSelfStudio', {
        method,
        payload: payload ?? {},
      })
      if (!res.ok) {
        throw new Error(res.error?.message ?? `RPC failed: ${method}`)
      }
      return res.value
    },
  }

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ rpc, t }),
  }, StudioPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 25,
    locale: NS,
    label: () => t('nav'),
  }, StudioIcon))
}

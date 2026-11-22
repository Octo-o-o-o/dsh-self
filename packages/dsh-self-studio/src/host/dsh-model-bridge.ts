/**
 * Official `dsh@0.2.2-rc.5` default-model bridge for Studio:
 * - Uses ONLY public official Host services (`ctx.get('llm')` and `ctx.get('agentDefaultModel')`).
 * - Falls back cleanly and deterministically when no model credential/provider is configured.
 * - Strictly constrains all LLM outputs to closed-set schemas (CaMeL control-flow safety).
 */
import {
  LAYOUT_PRESETS,
  WIDGET_CATALOG,
  deriveThemeSeedsFromDominantColor,
  type ActionId,
  type BrandIconPreset,
  type LayoutPreset,
  type ProductSpec,
  type WidgetId,
} from '@dsh-self/product-spec'
import { planActionsFromTrustedInputs } from './extractor.js'

interface OfficialLlmRuntime {
  listProviders?: () => readonly { id: string; name: string }[]
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    system?: string
    messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{
    type: string
    text?: string
    reason?: { kind?: string; failure?: { message?: string } }
  }>
}

interface OfficialDefaultModelService {
  currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined
}

export interface DshModelStatus {
  readonly available: boolean
  readonly provider?: string
  readonly model?: string
  readonly label: string
}

export interface ExpandedRequirementDraft {
  readonly expandedPrompt: string
  readonly suggestedNameZh: string
  readonly suggestedNameEn: string
  readonly summary: string
  readonly targetUsers: string
  readonly coreFeatures: readonly string[]
  readonly modelUsed: 'dsh-default-model' | 'local-fallback'
  readonly modelLabel: string
}

export interface BlueprintVariant {
  readonly id: 'lite' | 'standard' | 'pro'
  readonly tierLabel: string
  readonly badge: string
  readonly subtitle: string
  readonly suggestedNameZh: string
  readonly suggestedNameEn: string
  readonly layout: LayoutPreset
  readonly sections: readonly WidgetId[]
  readonly requiredActions: readonly ActionId[]
  readonly optionalActions: readonly ActionId[]
  readonly accentHex: string
  readonly iconPreset: Exclude<BrandIconPreset, 'custom'>
  readonly localOnly: boolean
  readonly highlights: readonly string[]
}

export interface NaturalRefinementResult {
  readonly patch: {
    readonly displayName?: { readonly zh: string; readonly en: string }
    readonly layout?: LayoutPreset
    readonly sections?: WidgetId[]
    readonly iconPreset?: Exclude<BrandIconPreset, 'custom'>
    readonly themeSeeds?: ProductSpec['theme']['seeds']
    readonly requiredActions?: ActionId[]
    readonly optionalActions?: ActionId[]
  }
  readonly replyZh: string
  readonly summary: string
  readonly changed: boolean
  readonly modelUsed: 'dsh-default-model' | 'local-fallback'
  readonly modelLabel: string
}

export class DshModelBridge {
  constructor(private readonly getServices: () => { llm?: OfficialLlmRuntime; defaultModel?: OfficialDefaultModelService }) {}

  getStatus(): DshModelStatus {
    const { llm, defaultModel } = this.getServices()
    if (!llm || !defaultModel) {
      return { available: false, label: '本机离线模式（未接入模型服务）' }
    }
    try {
      const sel = defaultModel.currentSelection()
      const providers = llm.listProviders?.() ?? []
      const hasRoute = Boolean(sel?.provider && sel?.model && (providers.length === 0 || providers.some((p) => p.id === sel.provider)))
      if (hasRoute && sel?.provider && sel?.model) {
        return {
          available: true,
          provider: sel.provider,
          model: sel.model,
          label: `dsh 默认模型 (${sel.provider} / ${sel.model})`,
        }
      }
      if (sel?.provider && sel?.model) {
        return {
          available: false,
          provider: sel.provider,
          model: sel.model,
          label: `已选 ${sel.model}（未登录/未配置密钥，自动使用离线补全）`,
        }
      }
    } catch { /* ignore */ }
    return { available: false, label: '未配置 dsh 默认模型（自动使用离线补全）' }
  }

  private async callDefaultModelText(system: string, userText: string): Promise<{ text: string; modelLabel: string } | null> {
    const status = this.getStatus()
    const { llm, defaultModel } = this.getServices()
    if (!status.available || !llm || !defaultModel) return null
    const sel = defaultModel.currentSelection()
    if (!sel?.provider || !sel?.model) return null

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 22_000)
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider: sel.provider,
        model: sel.model,
        ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
        temperature: 0.3,
        maxTokens: 1200,
        signal: ac.signal,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
          return null
        }
      }
      const trimmed = text.trim()
      return trimmed ? { text: trimmed, modelLabel: status.label } : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** Expand a short user description into a structured, editable full requirement draft. */
  async expandBrief(shortPrompt: string): Promise<ExpandedRequirementDraft> {
    const clean = shortPrompt.trim()
    const system = [
      '你是桌面客户端需求整理助手。用户会输入一句简短想法，请你帮他整理成一份清晰、通俗、可直接修改的完整客户端需求。',
      '必须只输出 JSON（不要代码块包裹），字段为：',
      '{"suggestedNameZh":"中文客户端名(2-8字)","suggestedNameEn":"English Name","summary":"一句话定位","targetUsers":"适用人群","coreFeatures":["功能1","功能2","功能3","功能4"],"expandedPrompt":"整理好的完整需求说明(120-260字，分条写清使用场景、首页要看什么、输出什么结果、是否本地优先)"}',
    ].join('\n')

    const llmRes = await this.callDefaultModelText(system, `用户的简短描述：${clean}`)
    if (llmRes) {
      const parsed = tryParseJsonObject(llmRes.text)
      if (parsed && typeof parsed.expandedPrompt === 'string' && parsed.expandedPrompt.trim()) {
        return {
          expandedPrompt: parsed.expandedPrompt.trim(),
          suggestedNameZh: String(parsed.suggestedNameZh || '我的工作台').slice(0, 24),
          suggestedNameEn: String(parsed.suggestedNameEn || 'My Workbench').slice(0, 32),
          summary: String(parsed.summary || '专属桌面工作台客户端'),
          targetUsers: String(parsed.targetUsers || '个人及小团队日常办公用户'),
          coreFeatures: Array.isArray(parsed.coreFeatures)
            ? parsed.coreFeatures.map(String).slice(0, 6)
            : ['专属首页工作台', '本地数据隔离', '一键导出结果'],
          modelUsed: 'dsh-default-model',
          modelLabel: llmRes.modelLabel,
        }
      }
    }

    // Deterministic smart local expander for ANY prompt
    const plan = planActionsFromTrustedInputs({ userPrompt: clean })
    const isBid = plan.requiredActions.some((a) => a.startsWith('bid.'))
    const isResearch = plan.requiredActions.some((a) => a.startsWith('research.'))
    const isDesign = plan.requiredActions.some((a) => a.startsWith('design.'))
    const domainCount = [isBid, isResearch, isDesign].filter(Boolean).length
    const explicitQuote = clean.match(/[「《"“]([^」》"”]{2,14})[」》"”]/)?.[1]
    const nameZh = explicitQuote || (domainCount >= 2 ? plan.suggestedName.zh : isBid ? '青禾投标' : isResearch ? '深度调研工作台' : isDesign ? plan.suggestedName.zh : guessClientNameZh(clean))
    const nameEn = domainCount >= 2 ? plan.suggestedName.en : isBid ? 'Qinghe Bids' : isResearch ? 'Pro Research Desk' : isDesign ? plan.suggestedName.en : 'My Workbench'

    const coreFeatures = domainCount >= 2
      ? [
          ...(isBid ? ['导入本地招标 DOCX 文件，提取截止日期、评分项与缺失资质，一键导出逐条响应表'] : []),
          ...(plan.requiredActions.includes('design.importImage') ? ['左中右三栏位图画布批注，自动校正旋转方向并高清导出 PNG'] : []),
          ...(plan.requiredActions.includes('design.openImageDesign') ? ['内置 GPT-Image Design（v0.3.6）支持 OpenAI 兼容生图 API 或 ChatGPT 网页出图与单文件 HTML Demo'] : []),
          ...(isResearch ? ['内置 ChatGPT Pro Research（v0.3.6）支持可恢复多轮调研、自动判据裁决与 report.md 本地交付'] : []),
          '独立桌面图标、独立数据目录与隔离浏览器配置，所有选定插件均可直接打进安装包',
        ]
      : isBid
        ? [
            '导入本地招标 DOCX 文件，自动提取截止日期、评分项与缺失资质',
            '拦截扫描件与异常文件，支持原文定位查看',
            '一键导出逐条响应表 Word（DOCX）',
            '独立工作区与本地数据存储，支持随时配置 AI 辅助起草',
          ]
        : isResearch
          ? [
              '内置 ChatGPT Pro Research（v0.3.6）插件与 pro-research 技能，支持有界多轮调研与自动判据裁决',
              '独立隔离的 Chrome 登录态与本地记录目录，每轮问答、裁决与宿主交付稿 report.md 完整落盘',
              '支持中断恢复、人工核对提交状态、续问追问与侧边栏主题进度总览',
              '可选扩展 GPT-Image Design 面板用于调研配图与原型方案探索',
            ]
          : isDesign
            ? [
                '左中右三栏：左侧项目列表、中间图片画布、右侧批注属性',
                '支持点击画布添加精准批注，自动校正手机拍照旋转方向与超长图高清 PNG 导出',
                '可选集成 GPT-Image Design（v0.3.6），支持 OpenAI 兼容生图 API 或 ChatGPT 网页出图与单文件 HTML Demo',
                '支持关窗重开批注，独立工作区不串数据',
              ]
            : [
                `围绕「${clean.slice(0, 36)}」打造专属首页工作台`,
                '常用任务与最近文件集中展示，打开即用',
                '独立桌面图标、独立工作区与独立模型配置',
                '本地优先运行，支持随时添加或切换业务插件',
              ]

    const expandedPrompt = [
      `客户端名称：「${nameZh}」（独立桌面客户端）`,
      `核心目标：${clean}`,
      `主要功能：`,
      ...coreFeatures.map((f, i) => `${i + 1}. ${f}`),
      isResearch || plan.requiredActions.includes('design.openImageDesign')
        ? `连接与边界说明：本地文件能力无需外网账号；外置 AI 生图/调研支持独立隔离的数据目录与浏览器配置（网页通道受页面改版与风控影响，生图 API 通道长期稳定）。`
        : `使用与隐私要求：纯本地优先运行，不强制联网账号；保留独立工作区与历史记录，方便直接安装给本人或团队成员使用。`,
    ].join('\n')

    return {
      expandedPrompt,
      suggestedNameZh: nameZh,
      suggestedNameEn: nameEn,
      summary: plan.role,
      targetUsers: domainCount >= 2
        ? '希望把多项核心能力组合为一个独立桌面客户端的业务与技术团队'
        : isBid
          ? '投标专员、售前与招投标团队'
          : isResearch
            ? '产品经理、技术架构师与行业研究分析师'
            : isDesign
              ? '平面/UI 设计师与视觉评审团队'
              : '希望把日常工作流固化为独立软件的个人或小团队',
      coreFeatures,
      modelUsed: 'local-fallback',
      modelLabel: this.getStatus().label,
    }
  }

  /** Generate 3 selectable blueprint variants (Lite / Standard / Pro) for the user's requirement. */
  generateBlueprints(prompt: string, clarifications?: Readonly<Record<string, string>>): readonly BlueprintVariant[] {
    const plan = planActionsFromTrustedInputs({ userPrompt: prompt, clarifications })
    const isBid = plan.requiredActions.some((a) => a.startsWith('bid.'))
    const isResearch = plan.requiredActions.some((a) => a.startsWith('research.'))
    const isDesign = plan.requiredActions.some((a) => a.startsWith('design.'))
    const wantsImageDesign = plan.requiredActions.includes('design.openImageDesign')
    const domainCount = [isBid, isDesign, isResearch].filter(Boolean).length
    const baseNameZh = plan.suggestedName.zh
    const baseNameEn = plan.suggestedName.en

    if (domainCount >= 2) {
      const hasCanvas = plan.requiredActions.includes('design.importImage')
      const standardLayout: LayoutPreset = hasCanvas ? 'three-pane' : 'dashboard-grid'
      const standardSections: WidgetId[] = [...plan.sections]
      const liteSections: WidgetId[] = standardSections.slice(0, Math.min(3, standardSections.length))
      const allDeliverableRequired: ActionId[] = [...new Set<ActionId>([
        ...plan.requiredActions,
        'bid.importRequirements',
        'bid.exportResponseDocx',
        'design.importImage',
        'design.saveAnnotations',
        'design.exportAnnotatedPng',
        'design.openImageDesign',
        'research.openProResearch',
      ])]
      const allDeliverableOptional: ActionId[] = allDeliverableRequired.includes('calendar.addDeadline')
        ? []
        : ['calendar.addDeadline']
      return [
        {
          id: 'lite',
          tierLabel: '方案 A · 精简融合工作台',
          badge: '最轻便',
          subtitle: '保留你点名的跨场景核心能力，单栏聚焦无干扰',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'single-column',
          sections: liteSections,
          requiredActions: [...plan.requiredActions],
          optionalActions: [],
          accentHex: '#0f766e',
          iconPreset: 'workbench-grid',
          localOnly: plan.localOnly,
          highlights: [
            `保留全部 ${plan.requiredActions.length} 项核心请求动作`,
            '单栏清爽视图，不带多余模块',
            '下一步可自由增删白名单或本机已装 DSH 插件',
          ],
        },
        {
          id: 'standard',
          tierLabel: '方案 B · 标准自定义融合版',
          badge: '推荐',
          subtitle: '完整覆盖你组合的多场景工作流与截止提醒，所选插件全部可直接打进安装包',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: standardLayout,
          sections: standardSections,
          requiredActions: [...plan.requiredActions],
          optionalActions: [...new Set<ActionId>([...plan.optionalActions, 'calendar.addDeadline'])].filter(
            (a) => !plan.requiredActions.includes(a),
          ),
          accentHex: '#1d4ed8',
          iconPreset: 'workbench-grid',
          localOnly: plan.localOnly,
          highlights: [
            '不丢弃任何跨场景需求（投标 / 画布批注 / AI 生图 / Pro 调研可自由组合）',
            '已附带本地离线截止日历与 .ics 导出',
            '零不可用插件，可直接试运行并打包',
          ],
        },
        {
          id: 'pro',
          tierLabel: '方案 C · 全能力交付工作台',
          badge: '全功能',
          subtitle: '一次装配全部 5 套已验证可交付插件（标书 + 日历 + 位图批注 + AI 生图 + Pro 多轮调研）',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'three-pane',
          sections: ['deadlines', 'bid-preview', 'design-canvas', 'annotations-panel', 'recent-sessions', 'connections-card'],
          requiredActions: allDeliverableRequired,
          optionalActions: allDeliverableOptional,
          accentHex: '#4f46e5',
          iconPreset: 'workbench-grid',
          localOnly: false,
          highlights: [
            '内置 3 套离线适配器 + 2 套实测外置插件全部就绪',
            '下一步仍可手动指定本机已装的其他 DSH 插件',
            '共享隔离数据目录，全部能力一次打包交付',
          ],
        },
      ]
    }

    if (isResearch) {
      return [
        {
          id: 'lite',
          tierLabel: '方案 A · 极简调研助手',
          badge: '最轻便',
          subtitle: '单栏聚焦，直接内嵌 Pro Research 面板，专注多轮调研与报告整理',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'single-column',
          sections: ['recent-sessions', 'connections-card'],
          requiredActions: ['research.openProResearch'],
          optionalActions: [],
          accentHex: '#0f766e',
          iconPreset: 'monogram',
          localOnly: false,
          highlights: ['内置 chatgpt-pro-research@0.3.6', '独立隔离 Chrome 登录态与本地报告', '需本机 Chrome + ChatGPT 网页账号'],
        },
        {
          id: 'standard',
          tierLabel: '方案 B · 标准深度调研台',
          badge: '推荐',
          subtitle: '列表+详情布局，串联调研项目、继续工作与连接状态提示',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'list-detail',
          sections: ['project-list', 'recent-sessions', 'connections-card'],
          requiredActions: ['research.openProResearch'],
          optionalActions: [],
          accentHex: '#1d4ed8',
          iconPreset: 'workbench-grid',
          localOnly: false,
          highlights: ['完整多轮调研 + 自动判据裁决 + report.md 交付', '与宿主 ~/.dsh 浏览器配置完全隔离', '可随时按需加装生图设计插件'],
        },
        {
          id: 'pro',
          tierLabel: '方案 C · 调研 + AI 视觉方案全能台',
          badge: '全功能',
          subtitle: '双插件协同：Pro 多轮调研 + GPT-Image Design 生图与单文件 HTML Demo',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'dashboard-grid',
          sections: ['project-list', 'recent-sessions', 'connections-card'],
          requiredActions: ['research.openProResearch'],
          optionalActions: ['design.openImageDesign'],
          accentHex: '#4f46e5',
          iconPreset: 'workbench-grid',
          localOnly: false,
          highlights: ['同时封装 chatgpt-pro-research + gpt-image-design', '共享隔离 Chrome 登录态，支持 API 生图', '两项外置插件均已验证可直接打进安装包'],
        },
      ]
    }

    if (isDesign) {
      return [
        {
          id: 'lite',
          tierLabel: wantsImageDesign ? '方案 A · 极简 AI 出图设计台' : '方案 A · 极简画布版',
          badge: '最轻便',
          subtitle: wantsImageDesign
            ? '单栏聚焦，内置 GPT-Image Design（支持生图 API / ChatGPT 网页出图与 Demo）'
            : '单栏大画布聚焦，只保留看图与批注，上手零门槛',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'single-column',
          sections: wantsImageDesign ? ['project-list', 'connections-card'] : ['design-canvas', 'annotations-panel'],
          requiredActions: wantsImageDesign
            ? ['design.openImageDesign']
            : ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
          optionalActions: [],
          accentHex: '#475569',
          iconPreset: 'design-pen',
          localOnly: !wantsImageDesign,
          highlights: wantsImageDesign
            ? ['内置 gpt-image-design@0.3.6 + 画廊与 iframe 预览', '支持 OpenAI 兼容生图 API（长期稳定）', '单包轻量化打包']
            : ['单栏大图视野', '仅 1 个核心内置插件', '纯本地零外部依赖'],
        },
        {
          id: 'standard',
          tierLabel: wantsImageDesign ? '方案 B · AI 生图 + 三栏批注设计台' : '方案 B · 标准三栏设计台',
          badge: '推荐',
          subtitle: wantsImageDesign
            ? '三栏本地位图批注 + GPT-Image Design 生图与 HTML Demo，一站完成出图、批注与导出'
            : '左项目、中画布、右批注，兼顾多稿件管理与导出',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'three-pane',
          sections: ['project-list', 'design-canvas', 'annotations-panel'],
          requiredActions: wantsImageDesign
            ? ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng', 'design.openImageDesign']
            : ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
          optionalActions: [],
          accentHex: '#0f766e',
          iconPreset: 'design-pen',
          localOnly: !wantsImageDesign,
          highlights: wantsImageDesign
            ? ['本地超长图批注 PNG 导出 + gpt-image-design@0.3.6', 'API 通道只出图且长期稳定；Web 通道附带 HTML Demo', '全部能力可直接打包进独立安装包']
            : ['经典三栏工作台', '自带项目列表与高清 PNG 导出', '支持关窗重开批注'],
        },
        {
          id: 'pro',
          tierLabel: '方案 C · AI 出图与团队协同专业版',
          badge: '全功能',
          subtitle: '三栏画布 + GPT-Image Design AI 生图/Demo + 继续工作，可选扩展原型画框与看板',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'three-pane',
          sections: ['project-list', 'design-canvas', 'annotations-panel', 'recent-sessions'],
          requiredActions: wantsImageDesign
            ? ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng', 'design.openImageDesign']
            : ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
          optionalActions: wantsImageDesign
            ? ['research.openProResearch']
            : ['design.openImageDesign', 'design.openPrototypeStudio', 'tasks.openKanban', 'notes.openScratchpad'],
          accentHex: '#4f46e5',
          iconPreset: 'workbench-grid',
          localOnly: false,
          highlights: wantsImageDesign
            ? ['含本地画布批注 + gpt-image-design + chatgpt-pro-research', '调研、出图、批注全链路可打包交付', '支持 API / 网页双通道']
            : ['含 GPT-Image Design AI 出图 + 原型画框 + 任务看板', '支持多项目并发跟进', '可后续自由删减模块'],
        },
      ]
    }

    if (isBid) {
      const reqBase = [...plan.requiredActions]
      return [
        {
          id: 'lite',
          tierLabel: '方案 A · 极简标书助手',
          badge: '最轻便',
          subtitle: '单栏聚焦，只放截止日和一键导出响应表，界面最干净',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'single-column',
          sections: ['deadlines', 'bid-preview'],
          requiredActions: reqBase,
          optionalActions: [],
          accentHex: '#0369a1',
          iconPreset: 'bid-shield',
          localOnly: plan.localOnly,
          highlights: ['单栏极简，打开就导 DOCX', '显示所需插件', plan.localOnly ? '本地文件处理' : '查公开标讯需要外部数据源'],
        },
        {
          id: 'standard',
          tierLabel: '方案 B · 标准投标工作台',
          badge: '推荐',
          subtitle: '列表+详情布局，含截止日、缺失资质、原文定位与本地日历',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'list-detail',
          sections: ['deadlines', 'missing-materials', 'bid-preview'],
          requiredActions: reqBase,
          optionalActions: plan.optionalActions.filter(action => action === 'calendar.addDeadline'),
          accentHex: '#0f766e',
          iconPreset: 'bid-shield',
          localOnly: plan.localOnly,
          highlights: ['完整截止日 + 资质检查 + 原文定位', plan.optionalActions.includes('calendar.addDeadline') ? '可导出本地日历' : '仅处理招标文件', '可一键切换替代插件'],
        },
        {
          id: 'pro',
          tierLabel: '方案 C · 投标全能看板版',
          badge: '全功能',
          subtitle: '多模块卡片看板，集成继续工作、随手记与任务看板协同推进',
          suggestedNameZh: baseNameZh,
          suggestedNameEn: baseNameEn,
          layout: 'dashboard-grid',
          sections: ['deadlines', 'missing-materials', 'bid-preview', 'recent-sessions', 'connections-card'],
          requiredActions: reqBase,
          optionalActions: ['calendar.addDeadline', 'tasks.openKanban', 'notes.openScratchpad'],
          accentHex: '#1d4ed8',
          iconPreset: 'workbench-grid',
          localOnly: false,
          highlights: ['5 大首页模块总览全局进度', '含任务看板与随手记协同', '支持配置外部连接与提醒'],
        },
      ]
    }

    // General / custom industry prompt
    return [
      {
        id: 'lite',
        tierLabel: '方案 A · 极简专注版',
        badge: '最轻便',
        subtitle: '单栏清爽界面，保留最近工作与核心能力，专注无干扰',
        suggestedNameZh: baseNameZh,
        suggestedNameEn: baseNameEn,
        layout: 'single-column',
        sections: ['recent-sessions', 'project-list'],
        requiredActions: [...plan.requiredActions],
        optionalActions: [],
        accentHex: '#0f766e',
        iconPreset: 'monogram',
        localOnly: true,
        highlights: ['单栏极简布局', '本地轻量运行', '适合个人快速上手'],
      },
      {
        id: 'standard',
        tierLabel: '方案 B · 标准工作台版',
        badge: '推荐',
        subtitle: '列表+详情双栏，兼顾项目管理、待办提醒与继续工作',
        suggestedNameZh: baseNameZh,
        suggestedNameEn: baseNameEn,
        layout: 'list-detail',
        sections: ['project-list', 'deadlines', 'recent-sessions'],
        requiredActions: [...plan.requiredActions],
        optionalActions: ['calendar.addDeadline', 'notes.openScratchpad'],
        accentHex: '#0f766e',
        iconPreset: 'workbench-grid',
        localOnly: true,
        highlights: ['双栏结构清晰', '含随手记与本地截止提醒', '后续可随时增删模块'],
      },
      {
        id: 'pro',
        tierLabel: '方案 C · 专业全功能看板',
        badge: '全功能',
        subtitle: '多模块看板布局，含任务看板、随手记、提醒与外部连接状态',
        suggestedNameZh: baseNameZh,
        suggestedNameEn: baseNameEn,
        layout: 'dashboard-grid',
        sections: ['project-list', 'deadlines', 'recent-sessions', 'connections-card'],
        requiredActions: [...plan.requiredActions],
        optionalActions: ['calendar.addDeadline', 'tasks.openKanban', 'notes.openScratchpad'],
        accentHex: '#4f46e5',
        iconPreset: 'workbench-grid',
        localOnly: false,
        highlights: ['看板式全览视图', '内置任务看板 + 随手记 + 日历', '适合高频多任务处理'],
      },
    ]
  }

  /** Apply a natural-language refinement instruction to an existing ProductSpec (dsh model first, smart NLU fallback). */
  async parseNaturalRefinement(spec: ProductSpec, instruction: string): Promise<NaturalRefinementResult> {
    const text = instruction.trim()
    const status = this.getStatus()

    // 1. Try official dsh default model for rich understanding (strict closed-set JSON output!)
    const system = [
      '你是桌面客户端预览微调助手。请把用户的一句话修改要求翻译为严格 JSON 补丁（不要代码块包裹）。',
      `当前配置：名称=${spec.brand.displayName.zh}，布局=${spec.home.layout}，模块=${spec.home.sections.join(',')}，主色=${spec.theme.seeds.light.accent}，图标=${spec.brand.iconPreset ?? 'monogram'}。`,
      `允许的 layout：${LAYOUT_PRESETS.join(', ')}`,
      `允许的 sections：${Object.keys(WIDGET_CATALOG).join(', ')}`,
      `允许的 iconPreset：monogram, bid-shield, design-pen, workbench-grid`,
      '输出 JSON 字段（只填需要改的字段）：',
      '{"displayNameZh":"可选","layout":"可选","addSections":["可选"],"removeSections":["可选"],"accentHex":"#RRGGBB可选","iconPreset":"可选","replyZh":"简短友好的中文回复说明改了什么"}',
    ].join('\n')

    const llmRes = await this.callDefaultModelText(system, `用户要求：${text}`)
    if (llmRes) {
      const parsed = tryParseJsonObject(llmRes.text)
      if (parsed) {
        const built = buildSafePatchFromHints(spec, {
          displayNameZh: typeof parsed.displayNameZh === 'string' ? parsed.displayNameZh : undefined,
          layout: typeof parsed.layout === 'string' ? (parsed.layout as LayoutPreset) : undefined,
          addSections: Array.isArray(parsed.addSections) ? parsed.addSections.map(String) : [],
          removeSections: Array.isArray(parsed.removeSections) ? parsed.removeSections.map(String) : [],
          accentHex: typeof parsed.accentHex === 'string' ? parsed.accentHex : undefined,
          iconPreset: typeof parsed.iconPreset === 'string' ? (parsed.iconPreset as Exclude<BrandIconPreset, 'custom'>) : undefined,
        })
        if (built.changes.length > 0) {
          return {
            patch: built.patch,
            replyZh: typeof parsed.replyZh === 'string' && parsed.replyZh.trim()
              ? parsed.replyZh.trim()
              : `已按要求调整：${built.changes.join('；')}。`,
            summary: `对话调整：${text.slice(0, 28)}`,
            changed: true,
            modelUsed: 'dsh-default-model',
            modelLabel: llmRes.modelLabel,
          }
        }
      }
    }

    // 2. Deterministic Chinese/English NLU fallback (instant, zero latency!)
    const hints = extractLocalRefinementHints(text)
    const built = buildSafePatchFromHints(spec, hints)
    if (built.changes.length === 0) {
      return {
        patch: {},
        changed: false,
        replyZh: '我暂时没识别出具体改动项。你可以试试说：「换成深海蓝」「改成三栏布局」「改名叫星辰投标」「加上继续工作模块」「去掉缺失资质」「图标换成工作台网格」。',
        summary: '未产生变更',
        modelUsed: 'local-fallback',
        modelLabel: status.label,
      }
    }
    return {
      patch: built.patch,
      changed: true,
      replyZh: `已完成调整：${built.changes.join('；')}（预览已自动刷新，不满意可点下方恢复上一版）。`,
      summary: `对话微调：${built.changes.join('、').slice(0, 32)}`,
      modelUsed: 'local-fallback',
      modelLabel: status.label,
    }
  }
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function guessClientNameZh(prompt: string): string {
  const m = prompt.match(/(?:做一个|打造一个|生成一个|做成)?([\u4e00-\u9fa5A-Za-z0-9]{2,8})(?:桌面)?(?:客户端|工作台|助手|软件|工具)/)
  if (m?.[1] && !/^(我的|一个|独立|专用)$/.test(m[1])) return m[1]
  return '专属工作台'
}

interface RefinementHints {
  displayNameZh?: string
  layout?: LayoutPreset
  addSections: string[]
  removeSections: string[]
  accentHex?: string
  iconPreset?: Exclude<BrandIconPreset, 'custom'>
  enableTenderSearch?: boolean
  enableImageDesign?: boolean
  enableProResearch?: boolean
  enableCalendar?: boolean
}

function extractLocalRefinementHints(text: string): RefinementHints {
  const hints: RefinementHints = { addSections: [], removeSections: [] }

  // Name change
  const nameMatch = text.match(/(?:改名叫|改名为|名字改成|名称改为|叫作|叫)[「《"“]?([\u4e00-\u9fa5A-Za-z0-9 _-]{2,16})[」》"”]?/)
  if (nameMatch?.[1]) hints.displayNameZh = nameMatch[1].trim()

  // Color change
  const hexMatch = text.match(/#[0-9a-fA-F]{6}\b/)
  if (hexMatch) {
    hints.accentHex = hexMatch[0].toLowerCase()
  } else if (/深海蓝|海洋蓝|蓝色|科技蓝|蔚蓝/i.test(text)) {
    hints.accentHex = '#2563eb'
  } else if (/墨绿|森林绿|翠绿|绿色|青绿/i.test(text)) {
    hints.accentHex = '#0f766e'
  } else if (/暖橙|橙色|橘色|活力橙/i.test(text)) {
    hints.accentHex = '#ea580c'
  } else if (/紫罗兰|紫色|靛紫|优雅紫/i.test(text)) {
    hints.accentHex = '#7c3aed'
  } else if (/珊瑚红|中国红|红色|玫瑰红/i.test(text)) {
    hints.accentHex = '#dc2626'
  } else if (/石墨|炭灰|极简黑|深灰/i.test(text)) {
    hints.accentHex = '#334155'
  }

  // Layout change
  if (/三栏|左中右/i.test(text)) hints.layout = 'three-pane'
  else if (/单栏|极简|聚焦/i.test(text)) hints.layout = 'single-column'
  else if (/看板|网格|卡片/i.test(text)) hints.layout = 'dashboard-grid'
  else if (/双栏|列表.?详情/i.test(text)) hints.layout = 'list-detail'

  // Icon preset change
  if (/网格图标|工作台网格/i.test(text)) hints.iconPreset = 'workbench-grid'
  else if (/盾徽|标书图标/i.test(text)) hints.iconPreset = 'bid-shield'
  else if (/钢笔|画布图标/i.test(text)) hints.iconPreset = 'design-pen'
  else if (/首字|文字图标/i.test(text)) hints.iconPreset = 'monogram'

  // Add / remove modules
  const widgetKeywords: readonly [WidgetId, RegExp][] = [
    ['deadlines', /截止日|截止时间|倒计时/],
    ['missing-materials', /缺失资质|资质|缺漏材料/],
    ['bid-preview', /原文定位|原文预览|标书预览/],
    ['project-list', /项目列表/],
    ['design-canvas', /作品画布|设计画布/],
    ['annotations-panel', /批注面板|属性与批注/],
    ['recent-sessions', /继续工作|最近会话|最近工作|最近文件/],
    ['connections-card', /外部连接|连接状态/],
    ['readiness-bar', /环境就绪|就绪条/],
  ]
  const isRemove = /去掉|删除|隐藏|移除|不要/i.test(text)
  const isAdd = /加上|添加|增加|加入|显示|放一个/i.test(text)
  for (const [wid, re] of widgetKeywords) {
    if (!re.test(text)) continue
    if (isRemove && !isAdd) hints.removeSections.push(wid)
    else hints.addSections.push(wid)
  }

  if (/开启查标讯|加上查标讯/i.test(text)) hints.enableTenderSearch = true
  else if (/关闭查标讯|不查标讯/i.test(text)) hints.enableTenderSearch = false

  if (/(?:开启|加上|添加|加入).*(?:ai.?生图|生图|出图|gpt.?image|html.?demo)/i.test(text)) hints.enableImageDesign = true
  else if (/(?:关闭|去掉|移除|删除|不要).*(?:ai.?生图|生图|出图|gpt.?image|html.?demo)/i.test(text)) hints.enableImageDesign = false

  if (/(?:开启|加上|添加|加入).*(?:多轮调研|深度调研|pro.?research|竞品调研)/i.test(text)) hints.enableProResearch = true
  else if (/(?:关闭|去掉|移除|删除|不要).*(?:多轮调研|深度调研|pro.?research|竞品调研)/i.test(text)) hints.enableProResearch = false

  if (/(?:开启|加上|添加|加入).*(?:日历|截止提醒)/i.test(text)) hints.enableCalendar = true
  else if (/(?:关闭|去掉|移除|删除|不要).*(?:日历|截止提醒)/i.test(text)) hints.enableCalendar = false

  return hints
}

function buildSafePatchFromHints(
  spec: ProductSpec,
  hints: RefinementHints,
): { readonly patch: NaturalRefinementResult['patch']; readonly changes: string[] } {
  const changes: string[] = []
  let layout: LayoutPreset = spec.home.layout
  let sections: WidgetId[] = [...spec.home.sections]

  if (hints.layout && (LAYOUT_PRESETS as readonly string[]).includes(hints.layout) && hints.layout !== spec.home.layout) {
    layout = hints.layout
    changes.push(`布局改为「${layout}」`)
  }

  for (const rawAdd of hints.addSections) {
    if (!(rawAdd in WIDGET_CATALOG)) continue
    const wid = rawAdd as WidgetId
    if (!sections.includes(wid) && sections.length < 8) {
      const allowed = WIDGET_CATALOG[wid].allowedLayouts as readonly LayoutPreset[]
      if (!allowed.includes(layout)) {
        layout = allowed[0]!
        changes.push(`自动切换布局为「${layout}」以适配「${WIDGET_CATALOG[wid].title.zh}」`)
      }
      sections.push(wid)
      changes.push(`添加模块「${WIDGET_CATALOG[wid].title.zh}」`)
    }
  }

  for (const rawRem of hints.removeSections) {
    if (!(rawRem in WIDGET_CATALOG)) continue
    const wid = rawRem as WidgetId
    if (sections.includes(wid) && sections.length > 1) {
      sections = sections.filter((s) => s !== wid)
      changes.push(`移除模块「${WIDGET_CATALOG[wid].title.zh}」`)
    }
  }

  // Ensure every section is valid for the final layout
  sections = sections.filter((s) => (WIDGET_CATALOG[s].allowedLayouts as readonly LayoutPreset[]).includes(layout))
  if (sections.length === 0) sections = ['recent-sessions']

  const patch: Record<string, unknown> = {}
  if (hints.displayNameZh && hints.displayNameZh !== spec.brand.displayName.zh) {
    patch.displayName = { zh: hints.displayNameZh, en: spec.brand.displayName.en }
    changes.push(`名称改为「${hints.displayNameZh}」`)
  }
  if (layout !== spec.home.layout) patch.layout = layout
  if (sections.join(',') !== spec.home.sections.join(',')) patch.sections = sections
  if (hints.accentHex && /^#[0-9a-fA-F]{6}$/.test(hints.accentHex)) {
    patch.themeSeeds = deriveThemeSeedsFromDominantColor(hints.accentHex)
    changes.push(`主题主色改为 ${hints.accentHex}`)
  }
  if (hints.iconPreset && ['monogram', 'bid-shield', 'design-pen', 'workbench-grid'].includes(hints.iconPreset)) {
    patch.iconPreset = hints.iconPreset
    changes.push(`图标改为「${hints.iconPreset}」`)
  }
  let nextReq = [...spec.requiredActions]
  let nextOpt = [...spec.optionalActions]
  let reqChanged = false
  let optChanged = false

  if (hints.enableTenderSearch === true && !nextReq.includes('tender.searchNotices')) {
    nextReq.push('tender.searchNotices')
    reqChanged = true
    changes.push('增加「查询公开标讯」需求')
  } else if (hints.enableTenderSearch === false && nextReq.includes('tender.searchNotices')) {
    nextReq = nextReq.filter((a) => a !== 'tender.searchNotices')
    reqChanged = true
    changes.push('关闭「查询公开标讯」需求')
  }

  if (hints.enableImageDesign === true && !nextReq.includes('design.openImageDesign') && !nextOpt.includes('design.openImageDesign')) {
    nextOpt.push('design.openImageDesign')
    optChanged = true
    changes.push('增加「AI 生图与 HTML Demo」能力')
  } else if (hints.enableImageDesign === false) {
    if (nextOpt.includes('design.openImageDesign')) {
      nextOpt = nextOpt.filter((a) => a !== 'design.openImageDesign')
      optChanged = true
    }
    if (nextReq.includes('design.openImageDesign') && nextReq.length > 1) {
      nextReq = nextReq.filter((a) => a !== 'design.openImageDesign')
      reqChanged = true
    }
    if (optChanged || reqChanged) changes.push('移除「AI 生图与 HTML Demo」能力')
  }

  if (hints.enableProResearch === true && !nextReq.includes('research.openProResearch') && !nextOpt.includes('research.openProResearch')) {
    nextOpt.push('research.openProResearch')
    optChanged = true
    changes.push('增加「Pro 多轮调研」能力')
  } else if (hints.enableProResearch === false) {
    if (nextOpt.includes('research.openProResearch')) {
      nextOpt = nextOpt.filter((a) => a !== 'research.openProResearch')
      optChanged = true
    }
    if (nextReq.includes('research.openProResearch') && nextReq.length > 1) {
      nextReq = nextReq.filter((a) => a !== 'research.openProResearch')
      reqChanged = true
    }
    if (optChanged || reqChanged) changes.push('移除「Pro 多轮调研」能力')
  }

  if (hints.enableCalendar === true && !nextReq.includes('calendar.addDeadline') && !nextOpt.includes('calendar.addDeadline')) {
    nextOpt.push('calendar.addDeadline')
    optChanged = true
    changes.push('增加「截止日提醒日历」能力')
  } else if (hints.enableCalendar === false && nextOpt.includes('calendar.addDeadline')) {
    nextOpt = nextOpt.filter((a) => a !== 'calendar.addDeadline')
    optChanged = true
    changes.push('移除「截止日提醒日历」能力')
  }

  if (reqChanged && nextReq.length > 0) patch.requiredActions = nextReq
  if (optChanged) patch.optionalActions = nextOpt

  return { patch: patch as NaturalRefinementResult['patch'], changes }
}

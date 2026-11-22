import { useCallback, useEffect, useState } from 'react'
import { desktopCapabilities } from '@dsh-self/product-spec/catalog-contract'
import css from './studio.module.css'

export interface StudioRpcCaller {
  call<T = any>(method: string, payload?: Record<string, unknown>): Promise<T>
}

interface ProjectListItem {
  readonly projectId: string
  readonly displayName: { readonly zh: string; readonly en: string }
  readonly revision: number
  readonly appVersion: string
  readonly updatedAt: string
  readonly layout: string
}

interface StudioPanelProps {
  readonly rpc: StudioRpcCaller
  readonly t: (key: string) => string
}

type StepKey = 'new' | 'choose' | 'plugins' | 'appearance' | 'preview' | 'build'
type TargetKey = 'win32-x64' | 'linux-x64' | 'darwin-arm64' | 'darwin-x64'
type CrossStrategyKey = 'portable-bundle' | 'github-actions' | 'docker-or-remote'

const INSPIRATIONS = [
  {
    id: 'bid',
    label: '青禾投标',
    prompt: '帮我做一个「青禾投标」桌面客户端，只处理手头已拿到的招标 DOCX 文件，提取截止日、评分项和缺失资质，原文定位并导出逐条响应表。',
  },
  {
    id: 'design',
    label: '青禾设计室',
    prompt: '做一个「青禾设计室」桌面工作台，左边项目列表、中间作品画布、右边批注面板，支持超长图批注和高清导出 PNG。',
  },
  {
    id: 'design-ai',
    label: 'AI 生图设计台',
    prompt: '做一个「青禾 AI 设计室」独立桌面工作台，既能用生图 API 或 ChatGPT 网页出概念图与单文件 HTML demo，也能在三栏画布里批注导出 PNG。',
  },
  {
    id: 'pro-research',
    label: '深度调研工作台',
    prompt: '做一个「深度调研工作台」独立客户端，集成 ChatGPT Pro 多轮调研与本地报告沉淀，用于技术选型和竞品分析。',
  },
  {
    id: 'all-in-one',
    label: '全能自定义工作台',
    prompt: '做一个「全能自定义工作台」独立客户端：既处理招标 DOCX 导出响应表，又支持三栏图片批注导出 PNG、AI 生图出 HTML Demo 和 ChatGPT Pro 多轮竞品调研。',
  },
  {
    id: 'tender-conflict',
    label: '查标讯（冲突演示）',
    prompt: '做一个既能查公开标讯又能写标书的投标客户端，导入招标文件导出响应表。',
  },
] as const

const LAYOUT_OPTIONS = [
  { value: 'single-column', label: '单栏聚焦' },
  { value: 'list-detail', label: '列表 + 详情' },
  { value: 'three-pane', label: '三栏工作台' },
  { value: 'dashboard-grid', label: '卡片看板' },
] as const

const ICON_PRESET_OPTIONS = [
  { id: 'bid-shield', label: '标书盾徽' },
  { id: 'design-pen', label: '画布钢笔' },
  { id: 'workbench-grid', label: '工作台网格' },
  { id: 'monogram', label: '品牌首字' },
] as const

const ALL_MODULES: readonly {
  readonly id: string
  readonly label: string
  readonly desc: string
  readonly layouts: readonly string[]
}[] = [
  { id: 'deadlines', label: '截止日期追踪', desc: '倒计时与关键时间节点', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'missing-materials', label: '缺失资质与材料', desc: '缺漏项红标提醒', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'bid-preview', label: '原文定位与导出', desc: '标书原文查看与一键导出 DOCX', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'project-list', label: '项目列表', desc: '左侧多项目切换', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'design-canvas', label: '作品画布', desc: '大图缩放与点击打点批注', layouts: ['single-column', 'three-pane'] },
  { id: 'annotations-panel', label: '属性与批注', desc: '批注清单与坐标管理', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'recent-sessions', label: '继续工作', desc: '最近打开的任务与草稿', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'connections-card', label: '外部连接状态', desc: '本地运行与外部服务状态', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
  { id: 'readiness-bar', label: '环境就绪卡', desc: '数据目录与运行状态提示', layouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'] },
]

const MODULE_LABEL_MAP: Record<string, string> = Object.fromEntries(ALL_MODULES.map((m) => [m.id, m.label]))

const ACTION_LABELS: Readonly<Record<string, string>> = {
  'bid.importRequirements': '解析招标文件',
  'bid.exportResponseDocx': '导出响应表 Word',
  'bid.draftResponseAi': 'AI 起草标书',
  'bid.openWorkbench': '标书整页工作台',
  'tender.searchNotices': '查询公开标讯',
  'design.importImage': '导入设计图',
  'design.saveAnnotations': '画布批注',
  'design.exportAnnotatedPng': '高清导出 PNG',
  'design.openPrototypeStudio': 'AI 原型画框',
  'design.openImageDesign': 'AI 生图与 HTML Demo（API / 网页）',
  'research.openProResearch': 'Pro 多轮调研（ChatGPT 网页）',
  'calendar.addDeadline': '截止日提醒',
  'mail.openInbox': '邮件收发',
  'notes.openScratchpad': '随手记',
  'tasks.openKanban': '任务看板',
}

const TIER_LABELS: Readonly<Record<string, string>> = {
  builtin: '内置',
  'verified-community': '社区验证',
  'experimental-unverified': '实验试用',
}

const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  'client-only': '纯界面',
  'host-and-client': '本地插件',
  'host-only': '后台服务',
}

const TARGET_OPTIONS: readonly { readonly id: TargetKey; readonly label: string; readonly artifact: string }[] = [
  { id: 'win32-x64', label: 'Windows x64', artifact: '安装包 (.exe)' },
  { id: 'linux-x64', label: 'Linux x64', artifact: '安装包 (.deb)' },
  { id: 'darwin-arm64', label: 'macOS Apple 芯片', artifact: '安装包 (.dmg)' },
  { id: 'darwin-x64', label: 'macOS Intel', artifact: '安装包 (.dmg)' },
]

const CROSS_STRATEGIES: readonly { readonly id: CrossStrategyKey; readonly title: string; readonly badge: string; readonly desc: string }[] = [
  { id: 'portable-bundle', title: '导出到目标机打包', badge: '推荐', desc: '生成迁移包，拷到目标系统的 dsh 导入直打。' },
  { id: 'github-actions', title: 'GitHub Actions 云打包', badge: 'CI', desc: '生成多系统构建配置，提交仓库自动出包。' },
  { id: 'docker-or-remote', title: 'Docker / 远程机脚本', badge: '高级', desc: 'Linux 可用 Docker 打 .deb，或填远程命令。' },
]

const QUICK_REFINEMENTS = [
  '把主题改成深海蓝',
  '换成三栏布局',
  '加上继续工作模块',
  '图标换成工作台网格',
  '改名叫「星辰工作台」',
] as const

interface InstalledLocalPluginInfo {
  readonly packageName: string
  readonly version: string
  readonly profile: string
  readonly scope: string
  readonly isDshPlugin: boolean
  readonly hasBundlePatch?: boolean
  readonly selectableAsExtra?: boolean
  readonly description?: string
  readonly runtimeKind?: string
  readonly compatibility?: 'compatible' | 'undeclared' | 'incompatible'
  readonly compatibilityDetail?: string
  readonly usesJsYamlTag?: boolean
  readonly alreadyInCatalog?: boolean
  readonly catalogActionIds?: readonly string[]
}

interface CatalogCapabilityPackInfo {
  readonly id: string
  readonly packageName: string
  readonly version: string
  readonly trustTier: string
  readonly runtimeKind: string
  readonly description: { readonly zh: string; readonly en: string }
  readonly actions: readonly string[]
  readonly deliverable: boolean
  readonly admitted: boolean
  readonly requiresConnections: readonly string[]
  readonly blockReason?: string
  readonly mcpAlternativeHint?: { readonly zh: string; readonly en: string }
}

const CAPABILITY_PACK_TITLES: Readonly<Record<string, string>> = {
  'builtin-bid-docx': '招标 DOCX 解析与响应表导出',
  'builtin-local-calendar': '本地截止日历与 .ics 导出',
  'builtin-design-canvas': '三栏位图画布批注与 PNG 导出',
  'community-gpt-image-design': 'GPT-Image Design（AI 生图 + HTML Demo）',
  'community-chatgpt-pro-research': 'ChatGPT Pro Research（Pro 多轮调研）',
  'office-calendar': '日程工作台（dsh-calendar）',
  'office-email': '邮件工作台（dsh-email）',
  'office-scratchpad': '随手记（@chaiyahang/dsh-scratchpad）',
  'office-kanban': '任务看板（@alpacachen/dsh-kanban）',
  'community-design-studio': 'AI 原型设备画框（dsh-design-studio）',
  'community-bidkit': '社区 BidKit 标书工作台',
  'community-tender-workbench': '企查查标讯工作台（不兼容演示）',
}

interface ChatMessage {
  readonly role: 'user' | 'bot'
  readonly text: string
}

export function StudioPanel({ rpc, t }: StudioPanelProps) {
  const [step, setStep] = useState<StepKey>('new')
  const [projects, setProjects] = useState<readonly ProjectListItem[]>([])
  const [project, setProject] = useState<any | null>(null)
  const [trial, setTrial] = useState<{ projectId: string; revision: number; productDigest: string; lockDigest: string }>()
  const [preview, setPreview] = useState<any | null>(null)
  const [jobs, setJobs] = useState<readonly any[]>([])
  const [hostTarget, setHostTarget] = useState<TargetKey>('win32-x64')
  const [installedPlugins, setInstalledPlugins] = useState<Record<string, InstalledLocalPluginInfo>>({})
  const [catalogCapabilities, setCatalogCapabilities] = useState<readonly CatalogCapabilityPackInfo[]>([])
  const [modelStatus, setModelStatus] = useState<{ available: boolean; label: string }>({
    available: false,
    label: '检查 dsh 默认模型…',
  })
  const [busy, setBusy] = useState(false)
  const [expanding, setExpanding] = useState(false)
  const [fetchingUrl, setFetchingUrl] = useState(false)
  const [refining, setRefining] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 1 inputs & AI expanded requirement draft
  const [showIntro, setShowIntro] = useState(true)
  const [prompt, setPrompt] = useState('')
  const [materialWorkflow, setMaterialWorkflow] = useState('')
  const [expandedDraft, setExpandedDraft] = useState<any | null>(null)
  const [imageBase64, setImageBase64] = useState<string | undefined>(undefined)
  const [referenceColorHex, setReferenceColorHex] = useState<string>()
  const [imageName, setImageName] = useState<string | undefined>(undefined)
  const [imageIntent, setImageIntent] = useState<'reference-workbench' | 'workspace-content'>('reference-workbench')
  const [refUrl, setRefUrl] = useState<string>('')
  const [urlResult, setUrlResult] = useState<any | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [importJsonText, setImportJsonText] = useState<string>('')
  const [showImport, setShowImport] = useState(false)

  // Step 2 multi-blueprint selection
  const [blueprints, setBlueprints] = useState<readonly any[]>([])
  const [clarifications, setClarifications] = useState<readonly any[]>([])
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string>('standard')
  const [bpPreviewDark, setBpPreviewDark] = useState(() => {
    if (typeof document !== 'undefined') {
      const rootEl = document.documentElement
      const themeAttr = rootEl.getAttribute('data-theme') || rootEl.dataset?.theme || ''
      if (themeAttr === 'dark' || rootEl.classList.contains('dark')) return true
      if (themeAttr === 'light' || rootEl.classList.contains('light')) return false
    }
    return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  })
  const [bidSourceMode, setBidSourceMode] = useState<'local-docx-only' | 'search-tenders'>('local-docx-only')

  // Step 3/4 editable state
  const [excludedIds, setExcludedIds] = useState<string[]>([])
  const [pinnedOverrides, setPinnedOverrides] = useState<Record<string, string>>({})
  const [extraInstalledPlugins, setExtraInstalledPlugins] = useState<string[]>([])
  const [localPluginFilter, setLocalPluginFilter] = useState('')
  const [nameZh, setNameZh] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [appVersion, setAppVersion] = useState('0.1.0')
  const [accentLight, setAccentLight] = useState('#0f766e')
  const [canvasLight, setCanvasLight] = useState('#f8fafc')

  // Step 5 preview & natural-language refinement state
  const [viewportWidth, setViewportWidth] = useState<'100%' | '768px'>('100%')
  const [previewNonce, setPreviewNonce] = useState(0)
  const [refineInput, setRefineInput] = useState('')
  const [refineChat, setRefineChat] = useState<readonly ChatMessage[]>([
    { role: 'bot', text: '不满意不用重来！直接告诉我你想怎么改，比如换颜色、改名、换布局、增删模块，预览会立刻同步更新。' },
  ])

  // Step 6 multi-target build & release version management state
  const [selectedTargets, setSelectedTargets] = useState<TargetKey[]>(['win32-x64'])
  const [crossStrategy, setCrossStrategy] = useState<CrossStrategyKey>('portable-bundle')
  const [customRemoteCmd, setCustomRemoteCmd] = useState<string>('')
  const [releaseNotes, setReleaseNotes] = useState<string>('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const applyEnv = useCallback((env?: {
    hostTarget?: TargetKey
    installedPlugins?: Record<string, InstalledLocalPluginInfo>
    catalogCapabilities?: readonly CatalogCapabilityPackInfo[]
    modelStatus?: any
  }) => {
    if (!env) return
    if (env.hostTarget) {
      setHostTarget(env.hostTarget)
      setSelectedTargets((prev) => (prev.length === 0 ? [env.hostTarget!] : prev))
    }
    if (env.installedPlugins) setInstalledPlugins(env.installedPlugins)
    if (Array.isArray(env.catalogCapabilities)) setCatalogCapabilities(env.catalogCapabilities)
    if (env.modelStatus) setModelStatus(env.modelStatus)
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      const res = await rpc.call<{ projects: ProjectListItem[]; environment?: any }>('listProjects')
      setProjects(res.projects)
      if (res.environment) {
        applyEnv(res.environment)
        if (res.environment.hostTarget) {
          setSelectedTargets((prev) => (prev.length === 1 && prev[0] === 'win32-x64' ? [res.environment.hostTarget] : prev))
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [rpc, applyEnv])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const syncFormFromProject = useCallback((rec: any) => {
    setProject(rec)
    setNameZh(rec.spec.brand.displayName.zh)
    setNameEn(rec.spec.brand.displayName.en)
    setAppVersion(rec.spec.appVersion)
    setAccentLight(rec.spec.theme.seeds.light.accent)
    setCanvasLight(rec.spec.theme.seeds.light.canvas)
    setPinnedOverrides(rec.pinnedOverrides ?? {})
    setExcludedIds(rec.excludedPluginIds ?? [])
    setExtraInstalledPlugins(Array.isArray(rec.extraInstalledPlugins) ? rec.extraInstalledPlugins : [])
  }, [])

  const openProject = async (projectId: string) => {
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ project: any; preview: any; jobs?: any[]; environment?: any }>('getProject', { projectId })
      setPrompt(res.project.brief.rawPrompt)
      setImageName(undefined); setImageBase64(undefined); setReferenceColorHex(undefined)
      setRefUrl(''); setUrlResult(null); setMaterialWorkflow('')
      syncFormFromProject(res.project)
      applyEnv(res.environment)
      setPreview(res.preview)
      setJobs(res.jobs ?? [])
      setStep('plugins')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleFileUpload = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法读取参考图 / Image could not be read')
      try { context.drawImage(bitmap, 0, 0, 1, 1) } finally { bitmap.close() }
      const [red, green, blue] = context.getImageData(0, 0, 1, 1).data
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      setImageBase64(dataUrl.slice(dataUrl.indexOf(',') + 1))
      setImageName(file.name)
      setReferenceColorHex('#' + [red!, green!, blue!].map(c => c.toString(16).padStart(2, '0')).join(''))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const handleFetchUrl = async () => {
    if (!refUrl.trim()) return
    setFetchingUrl(true)
    setUrlError(null)
    setUrlResult(null)
    try {
      const res = await rpc.call('fetchReferenceUrl', { url: refUrl.trim() })
      setUrlResult(res)
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : String(e))
    } finally {
      setFetchingUrl(false)
    }
  }

  // Step 1: Expand short prompt using dsh default model (with editable draft!)
  const handleExpandBrief = async () => {
    if (!prompt.trim()) return
    setExpanding(true)
    setError(null)
    try {
      const draft = await rpc.call<any>('expandBrief', { prompt: prompt.trim() })
      setExpandedDraft(draft)
      setPrompt(draft.expandedPrompt)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExpanding(false)
    }
  }

  const fromMaterial = Boolean(imageBase64 || urlResult)
  const inputPrompt = prompt.trim() || (fromMaterial ? materialWorkflow : '')

  // Step 1 -> Step 2: Generate 3 selectable blueprint options (Lite / Standard / Pro)
  const handleGenerateBlueprints = async (answersOverride?: Record<string, string>) => {
    if (!inputPrompt) { setError('请说明用途，或选择素材要用于哪项工作 / Choose a workflow for this reference'); return }
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ blueprints: any[]; clarifications: any[]; modelStatus?: any }>('generateBlueprints', {
        prompt: inputPrompt,
        referenceImageBase64: imageBase64, referenceImageIntent: imageIntent, referenceColorHex,
        webpageMeta: urlResult ? { title: urlResult.title, themeColorHex: urlResult.themeColorHex, headings: urlResult.headings } : undefined,
        clarificationAnswers: answersOverride ?? { 'bid-source-mode': bidSourceMode },
      })
      setBlueprints(res.blueprints)
      setClarifications(res.clarifications)
      if (res.modelStatus) setModelStatus(res.modelStatus)
      setSelectedBlueprintId('standard')
      setStep('choose')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Step 2 -> Step 3: Commit chosen blueprint into project
  const handleConfirmBlueprint = async () => {
    const chosen = blueprints.find((b) => b.id === selectedBlueprintId) ?? blueprints[0]
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ project: any; environment?: any }>('saveBrief', {
        projectId: project?.projectId,
        expectedRevision: project?.spec.revision,
        prompt: inputPrompt,
        target: hostTarget,
        clarificationAnswers: { 'bid-source-mode': bidSourceMode },
        blueprintOverride: chosen
          ? {
              layout: chosen.layout,
              sections: chosen.sections,
              requiredActions: chosen.requiredActions,
              optionalActions: chosen.optionalActions,
              accentHex: chosen.accentHex,
              iconPreset: chosen.iconPreset,
              suggestedNameZh: chosen.suggestedNameZh,
              suggestedNameEn: chosen.suggestedNameEn,
              localOnly: chosen.localOnly,
              tierLabel: chosen.tierLabel,
            }
          : undefined,
        referenceImageBase64: imageBase64,
        referenceImageIntent: imageIntent,
        referenceImageName: imageName, referenceColorHex,
        webpageMeta: urlResult
          ? { title: urlResult.title, themeColorHex: urlResult.themeColorHex, headings: urlResult.headings }
          : undefined,
        excludedPluginIds: excludedIds,
        extraInstalledPlugins,
      })
      syncFormFromProject(res.project)
      applyEnv(res.environment)
      await refreshProjects()
      setStep('plugins')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleImportSpec = async () => {
    setBusy(true)
    setError(null)
    try {
      const parsed = JSON.parse(importJsonText)
      const res = await rpc.call<{ project: any; environment?: any }>('importProductSpec', {
        spec: parsed,
        target: hostTarget,
      })
      syncFormFromProject(res.project)
      applyEnv(res.environment)
      await refreshProjects()
      setShowImport(false)
      setStep('plugins')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleImportJsonFile = (file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImportJsonText(String(reader.result ?? ''))
    reader.readAsText(file)
  }

  const handleUpdateSpec = async (patch: Record<string, unknown>, summary: string) => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ project: any; preview: any; environment?: any }>('updateSpec', {
        projectId: project.projectId,
        expectedRevision: project.spec.revision,
        target: hostTarget,
        excludedPluginIds: excludedIds,
        pinnedOverrides,
        extraInstalledPlugins,
        summary,
        ...patch,
      })
      syncFormFromProject(res.project)
      applyEnv(res.environment)
      if (res.preview) setPreview(res.preview)
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleBrandIconUpload = (file: File | undefined) => {
    if (!file || !project) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('仅支持 PNG / JPG / WebP 图片')
      return
    }
    if (file.size > 480_000) {
      setError('图标请小于 480 KB（推荐 256×256 PNG）')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '')
      const comma = dataUrl.indexOf(',')
      if (comma >= 0) {
        void handleUpdateSpec({
          customIconBase64: dataUrl.slice(comma + 1),
          customIconMimeType: file.type,
        }, `上传图标 (${file.name})`)
      }
    }
    reader.readAsDataURL(file)
  }

  const handleSelectAlternative = (actionId: string, candidateId: string, packageName: string) => {
    const nextPinned = { ...pinnedOverrides, [actionId]: candidateId }
    setPinnedOverrides(nextPinned)
    void handleUpdateSpec({ pinnedOverrides: nextPinned }, `切换为 ${packageName}`)
  }

  const handleClearAlternative = (actionId: string) => {
    const nextPinned = { ...pinnedOverrides }
    delete nextPinned[actionId]
    setPinnedOverrides(nextPinned)
    void handleUpdateSpec({ pinnedOverrides: nextPinned }, '恢复默认推荐')
  }

  const handleToggleCapabilityPack = (pack: CatalogCapabilityPackInfo) => {
    if (!project || pack.actions.length === 0) return
    const req: string[] = [...project.spec.requiredActions]
    const opt: string[] = [...project.spec.optionalActions]
    const allCurrent = new Set([...req, ...opt])
    const enabled = pack.actions.every((a) => allCurrent.has(a))

    if (enabled) {
      let nextReq = req.filter((a) => !pack.actions.includes(a))
      let nextOpt = opt.filter((a) => !pack.actions.includes(a))
      if (nextReq.length === 0) {
        if (nextOpt.length === 0) {
          setError('客户端至少需要保留 1 项核心能力，请先添加其他能力后再移除当前项。')
          return
        }
        nextReq = [nextOpt[0]!]
        nextOpt = nextOpt.slice(1)
      }
      void handleUpdateSpec(
        { requiredActions: nextReq, optionalActions: nextOpt },
        `移除能力：${CAPABILITY_PACK_TITLES[pack.id] ?? pack.packageName}`,
      )
    } else {
      const nextOpt = [...new Set([...opt, ...pack.actions.filter((a) => !req.includes(a))])]
      void handleUpdateSpec(
        { optionalActions: nextOpt },
        `添加能力：${CAPABILITY_PACK_TITLES[pack.id] ?? pack.packageName}`,
      )
    }
  }

  const handleEnableAllDeliverablePacks = () => {
    if (!project) return
    const deliverablePacks = catalogCapabilities.filter((c) => c.deliverable && c.admitted)
    const req: string[] = [...project.spec.requiredActions]
    const opt = new Set<string>(project.spec.optionalActions)
    for (const pack of deliverablePacks) {
      for (const action of pack.actions) {
        if (!req.includes(action)) opt.add(action)
      }
    }
    void handleUpdateSpec(
      { optionalActions: [...opt] },
      `开启全部 ${deliverablePacks.length} 套可交付能力包`,
    )
  }

  const handleToggleExtraInstalledPlugin = (pkgName: string) => {
    if (!project) return
    const exists = extraInstalledPlugins.includes(pkgName)
    const nextExtras = exists
      ? extraInstalledPlugins.filter((p) => p !== pkgName)
      : [...extraInstalledPlugins, pkgName]
    void handleUpdateSpec(
      { extraInstalledPlugins: nextExtras },
      exists ? `移除手动指定的本机插件：${pkgName}` : `手动指定本机已装插件：${pkgName}`,
    )
  }

  const handleRefreshLocalPlugins = async () => {
    setBusy(true)
    setError(null)
    try {
      const env = await rpc.call<any>('getEnvironment')
      applyEnv(env)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Step 4: Manual add / remove / reorder home modules
  const moveSection = (index: number, delta: -1 | 1) => {
    if (!project) return
    const next = [...project.spec.home.sections]
    const targetIdx = index + delta
    if (targetIdx < 0 || targetIdx >= next.length) return
    const tmp = next[index]
    next[index] = next[targetIdx]
    next[targetIdx] = tmp
    void handleUpdateSpec({ sections: next }, '调整首页模块顺序')
  }

  const removeSection = (secId: string) => {
    if (!project || project.spec.home.sections.length <= 1) return
    const next = project.spec.home.sections.filter((s: string) => s !== secId)
    void handleUpdateSpec({ sections: next }, `移除模块：${MODULE_LABEL_MAP[secId] ?? secId}`)
  }

  const addSection = (secId: string) => {
    if (!project || project.spec.home.sections.includes(secId) || project.spec.home.sections.length >= 8) return
    const next = [...project.spec.home.sections, secId]
    void handleUpdateSpec({ sections: next }, `添加模块：${MODULE_LABEL_MAP[secId] ?? secId}`)
  }

  const handleStartPreview = async () => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ preview: any }>('startPreview', {
        projectId: project.projectId,
        target: hostTarget,
      })
      setPreview(res.preview)
      setPreviewNonce((n) => n + 1)
      setStep('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Step 5: Natural language continuous refinement!
  const handleSendRefinement = async (overrideText?: string) => {
    const text = (overrideText ?? refineInput).trim()
    if (!project || !text) return
    setRefineChat((prev) => [...prev, { role: 'user', text }])
    if (!overrideText) setRefineInput('')
    setRefining(true)
    setError(null)
    try {
      const res = await rpc.call<{
        project: any
        preview: any
        reply: string
        changed: boolean
        modelUsed: string
      }>('refineByInstruction', {
        projectId: project.projectId,
        instruction: text,
      })
      syncFormFromProject(res.project)
      if (res.preview) setPreview(res.preview)
      setRefineChat((prev) => [...prev, { role: 'bot', text: res.reply }])
      await refreshProjects()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRefineChat((prev) => [...prev, { role: 'bot', text: `调整失败：${msg}` }])
    } finally {
      setRefining(false)
    }
  }

  const handleRollback = async (rev: number) => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ project: any }>('rollbackRevision', {
        projectId: project.projectId,
        targetRevision: rev,
      })
      syncFormFromProject(res.project)
      if (preview?.running) {
        const pRes = await rpc.call<{ preview: any }>('startPreview', {
          projectId: res.project.projectId,
          target: hostTarget,
        })
        setPreview(pRes.preview)
      }
      setRefineChat((prev) => [...prev, { role: 'bot', text: `已恢复到 r${rev} 的配置并刷新预览。` }])
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleBuildTarget = (tKey: TargetKey) => {
    setSelectedTargets((prev) => {
      if (prev.includes(tKey)) {
        return prev.length > 1 ? prev.filter((x) => x !== tKey) : prev
      }
      return [...prev, tKey]
    })
  }

  const bumpSemver = (part: 'patch' | 'minor') => {
    const m = appVersion.trim().match(/^(\d+)\.(\d+)\.(\d+)(.*)$/)
    if (!m) {
      setAppVersion(part === 'minor' ? '0.2.0' : '0.1.1')
      return
    }
    const major = Number(m[1])
    const minor = Number(m[2])
    const patch = Number(m[3])
    setAppVersion(part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`)
  }

  const handleStartBuild = async () => {
    if (!project || selectedTargets.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ jobs: any[]; project?: any }>('buildMultiTarget', {
        projectId: project.projectId,
        targets: selectedTargets,
        expectedRevision: project.spec.revision,
        trial: trial?.projectId === project.projectId ? trial : undefined,
        crossPlatformStrategy: crossStrategy,
        customRemoteCommand: crossStrategy === 'docker-or-remote' ? customRemoteCmd : undefined,
        appVersion: appVersion.trim() || project.spec.appVersion,
        releaseNotes: releaseNotes.trim() || undefined,
      })
      setJobs(res.jobs)
      if (res.project) syncFormFromProject(res.project)
      setReleaseNotes('')
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const pending = jobs.filter(job => job.status === 'running' || job.status === 'queued')
    if (!pending.length || !project?.projectId) return
    const projectId = project.projectId
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const updates = await Promise.all(pending.map(job =>
          rpc.call<{ job: any }>('getJob', { jobId: job.jobId }).then(response => response.job)))
        if (cancelled) return
        if (updates.some(job => job.status === 'succeeded')) {
          const response = await rpc.call<{ project: any }>('getProject', { projectId })
          if (cancelled) return
          setProject((current: any) => current?.projectId === projectId
            ? { ...current, releases: response.project.releases } : current)
        }
        setJobs(previous => previous.map(job => updates.find(update => update.jobId === job.jobId) ?? job))
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
          timer = setTimeout(() => void poll(), 3000)
        }
      }
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [jobs, project?.projectId, rpc])

  const handleDeleteRelease = async (releaseId: string) => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ project: any }>('deleteRelease', {
        projectId: project.projectId,
        releaseId,
      })
      const deletedJob = project.releases?.find((rel: any) => rel.releaseId === releaseId)?.jobId
      if (deletedJob) setJobs(previous => previous.filter(job => job.jobId !== deletedJob))
      syncFormFromProject(res.project)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleRestoreRelease = async (releaseId: string) => {
    if (!project) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc.call<{ project: any }>('restoreFromRelease', {
        projectId: project.projectId,
        releaseId,
      })
      syncFormFromProject(res.project)
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteProject = async (projectId: string) => {
    setBusy(true)
    setError(null)
    try {
      await rpc.call('deleteProject', { projectId })
      setConfirmDeleteId(null)
      if (project?.projectId === projectId) {
        setProject(null)
        setPreview(null)
        setJobs([])
        setStep('new')
      }
      await refreshProjects()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const steps: readonly { readonly key: StepKey; readonly label: string }[] = [
    { key: 'new', label: `1. ${t('step.new')}` },
    { key: 'choose', label: `2. ${t('step.choose')}` },
    { key: 'plugins', label: `3. ${t('step.plugins')}` },
    { key: 'appearance', label: `4. ${t('step.appearance')}` },
    { key: 'preview', label: `5. ${t('step.preview')}` },
    { key: 'build', label: `6. ${t('step.build')}` },
  ]

  const windowsLock = project?.locks?.['win32-x64']
  const windowsDelivery = windowsLock && desktopCapabilities(project.spec, windowsLock)
  const missingOptional: string[] = windowsDelivery
    ? project.spec.optionalActions.filter((action: string) => !windowsDelivery.actions.includes(action)) : []
  const localDshPlugins = Object.values(installedPlugins).filter((p) => p.isDshPlugin)

  return (
    <div className={css.shell} data-testid="dsh-self-studio-root">
      <header className={css.header}>
        <div className={css.headerTitle}>
          <h1>制作我的客户端</h1>
          <span className={`${css.pill} ${css.pillOk}`}>官方 dsh 兼容</span>
        </div>
        <div className={css.subtitle}>
          {project
            ? `${project.spec.brand.displayName.zh} · v${project.spec.appVersion} · r${project.spec.revision}`
            : '一句话生成独立桌面软件'}
        </div>
      </header>

      <nav className={css.stepper} aria-label="Studio steps">
        {steps.map((s) => {
          const disabled = (s.key === 'choose' && blueprints.length === 0) ||
            (['plugins', 'appearance', 'preview', 'build'].includes(s.key) && !project)
          return (
            <button
              key={s.key}
              type="button"
              className={`${css.stepBtn} ${step === s.key ? css.stepBtnActive : ''}`}
              disabled={disabled}
              onClick={() => setStep(s.key)}
            >
              {s.label}
            </button>
          )
        })}
      </nav>

      <div className={css.workspace}>
        <aside className={css.projectRail}>
          <div className={css.railHeader}>
            <span>我的项目 ({projects.length})</span>
            <button
              type="button"
              className={css.btnSecondary}
              onClick={() => {
                setProject(null)
                setTrial(undefined)
                setPrompt('')
                setImageBase64(undefined)
                setImageName(undefined)
                setReferenceColorHex(undefined)
                setImageIntent('reference-workbench')
                setRefUrl('')
                setUrlResult(null)
                setMaterialWorkflow('')
                setBidSourceMode('local-docx-only')
                setPreview(null)
                setJobs([])
                setBlueprints([])
                setExpandedDraft(null)
                setExcludedIds([])
                setPinnedOverrides({})
                setExtraInstalledPlugins([])
                setLocalPluginFilter('')
                setStep('new')
              }}
            >
              + 新建
            </button>
          </div>
          {projects.length === 0 ? (
            <span className={css.subtitle}>写下想法，即可生成多套方案挑选。</span>
          ) : (
            projects.map((item) => {
              const askingDelete = confirmDeleteId === item.projectId
              return (
                <div
                  key={item.projectId}
                  className={`${css.projectItem} ${project?.projectId === item.projectId ? css.projectItemActive : ''}`}
                >
                  <div className={css.projectItemRow}>
                    <button
                      type="button"
                      className={css.projectItemMain}
                      onClick={() => void openProject(item.projectId)}
                    >
                      <strong>{item.displayName.zh}</strong>
                      <span className={css.subtitle}>v{item.appVersion} · r{item.revision}</span>
                    </button>
                    {!askingDelete && (
                      <button
                        type="button"
                        className={`${css.miniBtn} ${css.miniBtnDanger}`}
                        title="删除此项目"
                        aria-label={`删除项目 ${item.displayName.zh}`}
                        onClick={() => setConfirmDeleteId(item.projectId)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                  {askingDelete && (
                    <div className={css.row} style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button
                        type="button"
                        className={css.miniBtn}
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className={`${css.miniBtn} ${css.miniBtnDanger}`}
                        disabled={busy}
                        onClick={() => void handleDeleteProject(item.projectId)}
                      >
                        确认删除
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </aside>

        <main className={css.content}>
          {error && <div className={`${css.notice} ${css.noticeError}`}>{error}</div>}

          {/* STEP 1: 新建与需求（形象配图介绍 + dsh 默认模型扩写完整需求并可修改） */}
          {step === 'new' && (
            <>
              <section className={css.introCard}>
                <div className={css.introTop}>
                  <div className={css.row}>
                    <strong>它是做什么的？就像把“万能工具箱”拆成“专用小家电”</strong>
                    <span className={`${css.pill} ${css.pillOk}`}>零代码打独立安装包</span>
                  </div>
                  <button type="button" className={css.btnSecondary} onClick={() => setShowIntro((v) => !v)}>
                    {showIntro ? '收起' : '展开介绍'}
                  </button>
                </div>

                {showIntro && (
                  <div className={css.introBody}>
                    <div className={css.introVisual}>
                      <svg viewBox="0 0 380 176" style={{ display: 'block', width: '100%', height: 'auto' }} role="img" aria-label="在 dsh 里混装插件 与 桌面独立软件图标 的形象对比">
                        {/* Left: Crowded single dsh window */}
                        <rect x="6" y="10" width="154" height="156" rx="10" fill="var(--dsw-alias-bg-layer-1)" stroke="var(--dsw-alias-border-l2)" strokeWidth="1.4" />
                        <rect x="6" y="10" width="154" height="24" rx="10" fill="var(--dsw-alias-bg-layer-2)" />
                        <circle cx="18" cy="22" r="3" fill="var(--dsw-alias-state-error-primary)" />
                        <circle cx="28" cy="22" r="3" fill="var(--dsw-alias-state-warn-primary)" />
                        <circle cx="38" cy="22" r="3" fill="var(--dsw-alias-state-success-primary)" />
                        <text x="92" y="26" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.5" fontWeight="700">共用 1 个 dsh 窗口</text>
                        <rect x="14" y="42" width="66" height="26" rx="6" fill="var(--dsw-alias-bg-layer-2)" stroke="var(--dsw-alias-border-l1)" />
                        <text x="47" y="59" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.5">📄 写标书</text>
                        <rect x="86" y="42" width="66" height="26" rx="6" fill="var(--dsw-alias-bg-layer-2)" stroke="var(--dsw-alias-border-l1)" />
                        <text x="119" y="59" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.5">🎨 改海报</text>
                        <rect x="14" y="74" width="66" height="26" rx="6" fill="var(--dsw-alias-bg-layer-2)" stroke="var(--dsw-alias-border-l1)" />
                        <text x="47" y="91" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.5">🧾 审合同</text>
                        <rect x="86" y="74" width="66" height="26" rx="6" fill="var(--dsw-alias-bg-layer-2)" stroke="var(--dsw-alias-border-l1)" />
                        <text x="119" y="91" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.5">💬 闲聊</text>
                        <rect x="14" y="108" width="138" height="24" rx="6" fill="color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent)" stroke="color-mix(in srgb, var(--dsw-alias-state-warn-primary) 55%, transparent)" strokeWidth="1" />
                        <text x="83" y="124" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.2">文件/聊天全混在一起</text>
                        <text x="83" y="152" textAnchor="middle" fill="var(--dsw-alias-label-secondary)" fontSize="9.2">同事要用得先教他装 dsh + 挑插件</text>

                        {/* Middle transform arrow */}
                        <path d="M167 88H203" stroke="var(--dsw-alias-brand-primary)" strokeWidth="3.2" strokeLinecap="round" />
                        <path d="M195 80L205 88L195 96" fill="none" stroke="var(--dsw-alias-brand-primary)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
                        <text x="186" y="74" textAnchor="middle" fill="var(--dsw-alias-brand-primary)" fontSize="10" fontWeight="700">打包</text>

                        {/* Right: Clean PC Desktop with separate standalone App icons */}
                        <rect x="212" y="10" width="162" height="156" rx="10" fill="var(--dsw-alias-bg-layer-1)" stroke="var(--dsw-alias-brand-primary)" strokeWidth="1.5" />
                        <text x="293" y="28" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="10" fontWeight="700">电脑桌面 · 独立软件</text>

                        {/* App 1 icon */}
                        <rect x="224" y="38" width="64" height="62" rx="10" fill="var(--dsw-alias-bg-layer-2)" stroke="var(--dsw-alias-border-l2)" strokeWidth="1.2" />
                        <rect x="242" y="46" width="28" height="28" rx="7" fill="var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))" />
                        <text x="256" y="65" textAnchor="middle" fill="var(--dsw-alias-label-primary-foreground)" fontSize="13" fontWeight="700">标</text>
                        <text x="256" y="88" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.2" fontWeight="600">青禾投标</text>
                        <text x="256" y="98" textAnchor="middle" fill="var(--dsw-alias-label-secondary)" fontSize="8">.exe / .dmg</text>

                        {/* App 2 icon */}
                        <rect x="298" y="38" width="64" height="62" rx="10" fill="var(--dsw-alias-bg-layer-2)" stroke="var(--dsw-alias-border-l2)" strokeWidth="1.2" />
                        <rect x="316" y="46" width="28" height="28" rx="7" fill="var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary))" />
                        <text x="330" y="65" textAnchor="middle" fill="var(--dsw-alias-label-on-color, #ffffff)" fontSize="13" fontWeight="700">设</text>
                        <text x="330" y="88" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.2" fontWeight="600">青禾设计</text>
                        <text x="330" y="98" textAnchor="middle" fill="var(--dsw-alias-label-secondary)" fontSize="8">.exe / .dmg</text>

                        {/* Bottom benefits */}
                        <rect x="224" y="108" width="138" height="46" rx="7" fill="color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)" stroke="color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)" strokeWidth="1" />
                        <text x="293" y="124" textAnchor="middle" fill="var(--dsw-alias-label-primary)" fontSize="9.2" fontWeight="600">点开直达专属首页 · 数据不串台</text>
                        <text x="293" y="141" textAnchor="middle" fill="var(--dsw-alias-label-secondary)" fontSize="9">安装包发给同事，双击即用</text>
                      </svg>
                    </div>

                    <div className={css.introCols}>
                      <div className={css.introPoint}>
                        <strong>这是做什么的？</strong>
                        <span className={css.subtitle}>
                          把你想做的业务场景打包成一个<strong>有自己图标和安装包的独立桌面软件</strong>，不再挤在 dsh 里。
                        </span>
                      </div>
                      <div className={css.introPoint}>
                        <strong>和直接装推荐插件的区别</strong>
                        <ul className={css.subtitle}>
                          <li><strong>交付更简单</strong>：直接发 .exe/.dmg 给同事，不用对方装 dsh 也不用折腾插件。</li>
                          <li><strong>界面更纯净</strong>：打开就是你的业务首页，没有多余菜单和插件市场。</li>
                          <li><strong>数据全隔离</strong>：工作区、文件、密钥各自独立，多开互不干扰。</li>
                        </ul>
                      </div>
                      <div className={css.introPoint}>
                        <strong>最适合谁用？</strong>
                        <ul className={css.subtitle}>
                          <li>想给团队/客户发专用工具的业务负责人</li>
                          <li>想把投标、设计、法务分开用的职场人</li>
                          <li>不会写代码、想要专属软件的个人或小团队</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              <section className={css.card}>
                <div className={css.row} style={{ justifyContent: 'space-between' }}>
                  <h2>描述你想做的客户端</h2>
                  <span className={css.pill}>{modelStatus.label}</span>
                </div>

                <div className={css.row}>
                  <span className={css.subtitle}>灵感示例：</span>
                  {INSPIRATIONS.map((ins) => (
                    <button
                      key={ins.id}
                      type="button"
                      className={css.quickChip}
                      onClick={() => { setPrompt(ins.prompt); setExpandedDraft(null); setProject(null) }}
                    >
                      {ins.label}
                    </button>
                  ))}
                </div>

                <textarea
                  className={css.textarea}
                  style={{ minHeight: 96 }}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="随便写一句你的想法，例如帮我做一个投标工作台，导入招标 DOCX，查看截止日并导出响应表…"
                />

                <div className={css.row}>
                  <button
                    type="button"
                    className={css.btnSecondary}
                    disabled={expanding || !prompt.trim()}
                    onClick={() => void handleExpandBrief()}
                  >
                    {expanding ? '正在生成完整需求…' : '✨ 先帮我生成完整需求（可自由修改）'}
                  </button>
                  <button
                    type="button"
                    className={css.btnPrimary}
                    disabled={busy || (!prompt.trim() && !fromMaterial)}
                    onClick={() => void handleGenerateBlueprints()}
                  >
                    {busy ? '正在生成多套方案…' : '下一步：生成 3 套方案供选择 →'}
                  </button>
                  <button type="button" className={css.btnSecondary} onClick={() => setShowImport((v) => !v)}>
                    {showImport ? '收起导入' : '导入 product.json'}
                  </button>
                </div>

                {expandedDraft && (
                  <div className={css.notice}>
                    <strong>已生成完整需求草稿</strong>（来源：{expandedDraft.modelUsed === 'dsh-default-model' ? expandedDraft.modelLabel : `本地智能补全 · ${expandedDraft.modelLabel}`}）—
                    上方文本框已填入整理好的完整需求，你可以直接删改补充，确认后点「下一步：生成 3 套方案供选择」。
                  </div>
                )}

                <details>
                  <summary className={css.subtitle}>可选：上传参考图或输入参考网址（提取配色与风格）</summary>
                  <div className={css.twoCol} style={{ marginTop: 8 }}>
                    <div className={css.pluginRow}>
                      <strong>参考图片（PNG / JPG / WebP）</strong>
                      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => handleFileUpload(e.target.files?.[0])} />
                      <div className={css.row}>
                        <label>
                          <input type="radio" checked={imageIntent === 'reference-workbench'} onChange={() => setImageIntent('reference-workbench')} /> 参考配色，布局在方案中选择
                        </label>
                        <label>
                          <input type="radio" checked={imageIntent === 'workspace-content'} onChange={() => setImageIntent('workspace-content')} /> 保存为项目素材，试用时可导入原图
                        </label>
                      </div>
                      {imageName && <span className={`${css.pill} ${css.pillOk}`}>已选：{imageName}</span>}
                    </div>
                    <div className={css.pluginRow}>
                      <strong>参考网址</strong>
                      <div className={css.row}>
                        <input className={css.input} value={refUrl} onChange={(e) => setRefUrl(e.target.value)} placeholder="https://example.com" />
                        <button type="button" className={css.btnSecondary} disabled={fetchingUrl} onClick={() => void handleFetchUrl()}>
                          {fetchingUrl ? '读取中…' : '安全读取'}
                        </button>
                      </div>
                      {urlError && <div className={`${css.notice} ${css.noticeError}`}>已拦截：{urlError}</div>}
                      {urlResult && <div className={css.notice}>已读取：{urlResult.title || urlResult.finalUrl}</div>}
                    </div>
                  </div>
                </details>

                {fromMaterial && !prompt.trim() && <label>这份素材用于什么工作？ / Choose a workflow{' '}
                  <select value={materialWorkflow} onChange={e => setMaterialWorkflow(e.target.value)}>
                    <option value="">请选择 / Select</option>
                    <option value="处理已有招标 DOCX 并导出响应表">处理招标文档 / Bid documents</option>
                    <option value="设计师为作品图片添加批注并导出 PNG">图片批注 / Image annotation</option>
                    <option value="AI 生图出概念图与单文件 HTML demo 设计工作台">AI 生图与 HTML Demo 设计台 / AI image & HTML demo</option>
                    <option value="使用 ChatGPT Pro 做多轮深度调研与竞品分析并沉淀报告">Pro 多轮深度调研工作台 / Pro multi-round research</option>
                    <option value="全能自定义工作台：处理招标 DOCX、图片批注导出 PNG、AI 生图出 HTML demo 并支持 Pro 多轮调研">全能自定义工作台（组合全部已交付能力） / All-in-one custom workbench</option>
                  </select>
                </label>}
                {showImport && (
                  <div className={css.pluginRow}>
                    <div className={css.notice}>
                      支持导入其他设备/系统（Windows / macOS / Linux）导出的 <code>product.json</code>，导入后可直接在本机（<code>{hostTarget}</code>）修改或打包。
                    </div>
                    <input type="file" accept=".json,application/json" onChange={(e) => handleImportJsonFile(e.target.files?.[0])} />
                    <textarea
                      className={css.textarea}
                      value={importJsonText}
                      onChange={(e) => setImportJsonText(e.target.value)}
                      placeholder="粘贴 product.json 内容，或从上方选择文件…"
                    />
                    <button type="button" className={css.btnPrimary} disabled={busy || !importJsonText.trim()} onClick={() => void handleImportSpec()}>
                      导入并加载方案
                    </button>
                  </div>
                )}
              </section>
            </>
          )}

          {/* STEP 2: 选方案（极简版 / 标准版 / 专业全功能版 + 即时 1:1 预览对比） */}
          {step === 'choose' && (
            <section className={css.card}>
              <h2>选一套你喜欢的方案（点卡片看布局草图）</h2>
              <span className={css.subtitle}>为你生成了 3 套不同详细程度的方案，点击卡片查看布局草图和模块清单。</span>

              <div className={css.blueprintGrid}>
                {blueprints.map((bp: any) => {
                  const active = selectedBlueprintId === bp.id
                  return (
                    <button
                      key={bp.id}
                      type="button"
                      className={`${css.blueprintCard} ${active ? css.blueprintCardActive : ''}`}
                      onClick={() => setSelectedBlueprintId(bp.id)}
                    >
                      <div className={css.row} style={{ justifyContent: 'space-between', width: '100%' }}>
                        <strong>{bp.tierLabel}</strong>
                        <span className={`${css.pill} ${bp.id === 'standard' ? css.pillOk : ''}`}>{bp.badge}</span>
                      </div>
                      <span className={css.subtitle}>{bp.subtitle}</span>
                      <div className={css.row}>
                        <span className={css.swatchDot} style={{ background: bp.accentHex }} />
                        <span className={css.pill}>{LAYOUT_OPTIONS.find((l) => l.value === bp.layout)?.label ?? bp.layout}</span>
                        <span className={css.pill}>{bp.sections.length} 个首页模块</span>
                      </div>
                      <ul className={css.subtitle}>
                        {bp.highlights.map((h: string) => <li key={h}>{h}</li>)}
                      </ul>
                    </button>
                  )
                })}
              </div>

              {/* Live instant 1:1 desktop preview for the selected blueprint */}
              {(() => {
                const activeBp = blueprints.find((b) => b.id === selectedBlueprintId) ?? blueprints[0]
                if (!activeBp) return null
                const gridClass =
                  activeBp.layout === 'single-column'
                    ? css.bpGridSingle
                    : activeBp.layout === 'three-pane'
                      ? css.bpGridThree
                      : activeBp.layout === 'dashboard-grid'
                        ? css.bpGridDash
                        : css.bpGridList
                const previewHint = (secId: string): string => {
                  switch (secId) {
                    case 'deadlines': return '2026-12-18 14:00 · 距截止 26 天'
                    case 'missing-materials': return '待补齐：ISO 27001 资质证书'
                    case 'bid-preview': return '招标 DOCX 原文定位 + 一键导出响应表'
                    case 'project-list': return '项目列表 · 多稿件快速切换'
                    case 'design-canvas': return '高清位图画布 · 点击添加批注点'
                    case 'annotations-panel': return '#1 主标题对比度 · #2 对齐主栅格'
                    case 'recent-sessions': return '上次未完成任务，点开继续处理'
                    case 'connections-card': return '纯本地运行，按需接入模型/日历'
                    default: return '模块已就绪'
                  }
                }
                return (
                  <div className={css.pluginRow}>
                    <div className={css.row} style={{ justifyContent: 'space-between' }}>
                      <div className={css.row}>
                        <strong>当前方案布局草图 · {activeBp.tierLabel}</strong>
                        <span className={css.pill}>布局：{LAYOUT_OPTIONS.find((l) => l.value === activeBp.layout)?.label ?? activeBp.layout}</span>
                      </div>
                      <button type="button" className={css.btnSecondary} onClick={() => setBpPreviewDark((v) => !v)}>
                        {bpPreviewDark ? '切到浅色预览' : '切到深色预览'}
                      </button>
                    </div>

                    <div className={css.row}>
                      <span className={css.subtitle}>包含模块：</span>
                      {activeBp.sections.map((s: string, i: number) => (
                        <span key={s} className={`${css.pill} ${css.pillOk}`}>#{i + 1} {MODULE_LABEL_MAP[s] ?? s}</span>
                      ))}
                      <span className={css.subtitle}>核心能力：</span>
                      {[...activeBp.requiredActions, ...activeBp.optionalActions].map((a: string) => (
                        <span key={a} className={css.pill}>{ACTION_LABELS[a] ?? a}</span>
                      ))}
                    </div>

                    <div className={`${css.bpLiveWrap} ${bpPreviewDark ? css.bpLiveWrapDark : ''}`} data-testid="blueprint-live-preview">
                      <div className={css.bpWinBar}>
                        <div className={css.row}>
                          <span
                            style={{
                              width: 18,
                              height: 18,
                              borderRadius: 5,
                              background: activeBp.accentHex,
                              color: '#fff',
                              display: 'inline-grid',
                              placeItems: 'center',
                              fontWeight: 700,
                              fontSize: 11,
                            }}
                          >
                            {String(activeBp.suggestedNameZh || '客').slice(0, 1)}
                          </span>
                          <strong>{activeBp.suggestedNameZh}</strong>
                          <span style={{ opacity: 0.65 }}>v0.1.0</span>
                        </div>
                        <span style={{ opacity: 0.55 }}>─ □ ×</span>
                      </div>
                      <div className={css.bpShell}>
                        <div className={css.bpSide}>
                          <div className={css.bpNavItem} style={{ background: activeBp.accentHex, color: '#fff', fontWeight: 600 }}>🏠 工作台首页</div>
                          <div className={css.bpNavItem}>💬 AI 助手</div>
                          <div className={css.bpNavItem}>🧩 已装能力</div>
                          <div className={css.bpNavItem}>⚙️ 设置与模型</div>
                          <div style={{ marginTop: 'auto', opacity: 0.65, fontSize: 11, padding: '6px 6px 0', borderTop: '1px solid rgba(148,163,184,0.25)' }}>
                            📁 独立工作区
                          </div>
                        </div>
                        <div className={css.bpMain}>
                          <div style={{ fontSize: 11.5, padding: '6px 9px', borderRadius: 6, border: '1px solid rgba(148,163,184,0.32)', opacity: 0.85 }}>
                            本地功能立即可用；如需 AI 辅助，可在左侧「设置与模型」填写密钥。
                          </div>
                          <div className={`${css.bpGrid} ${gridClass}`}>
                            {activeBp.sections.map((secId: string, idx: number) => (
                              <div key={secId} className={css.bpModCard} style={{ borderTop: `3px solid ${activeBp.accentHex}` }}>
                                <div className={css.row} style={{ justifyContent: 'space-between' }}>
                                  <strong>{MODULE_LABEL_MAP[secId] ?? secId}</strong>
                                  <span style={{ opacity: 0.55, fontSize: 11 }}>#{idx + 1}</span>
                                </div>
                                <span style={{ opacity: 0.78 }}>{previewHint(secId)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })()}

              {clarifications.map((q: any) => (
                <div key={q.id} className={css.pluginRow}>
                  <strong>顺便确认：{q.question.zh}</strong>
                  <div className={css.row}>
                    {q.options.map((opt: any) => (
                      <label key={opt.value}>
                        <input
                          type="radio"
                          name={q.id}
                          checked={bidSourceMode === opt.value}
                          onChange={() => {
                            setBidSourceMode(opt.value)
                            void handleGenerateBlueprints({ 'bid-source-mode': opt.value })
                          }}
                        />{' '}
                        {opt.label.zh}
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              <div className={css.row}>
                <button type="button" className={css.btnSecondary} onClick={() => setStep('new')}>← 返回改需求</button>
                <button type="button" className={css.btnPrimary} disabled={busy} onClick={() => void handleConfirmBlueprint()}>
                  {busy ? '正在生成插件方案…' : '采用此方案，去选插件 →'}
                </button>
              </div>
            </section>
          )}

          {/* STEP 3: 选插件（自由增删白名单能力 + 手动指定本机已装 DSH 插件 + 替代候选核对） */}
          {step === 'plugins' && project && (() => {
            const allWantedActions = new Set<string>([
              ...project.spec.requiredActions,
              ...project.spec.optionalActions,
            ])
            const deliverablePacks = catalogCapabilities.filter((c) => c.deliverable && c.admitted)
            const catalogCandidatePacks = catalogCapabilities.filter((c) => !c.deliverable)
            const enabledDeliverableCount = deliverablePacks.filter((pack) =>
              pack.actions.length > 0 && pack.actions.every((a) => allWantedActions.has(a)),
            ).length
            const lockedPlugins: readonly any[] = windowsLock?.plugins ?? []
            const lockedByPkg = new Map<string, any>(lockedPlugins.map((p: any) => [p.packageName, p]))
            const unavailableSet = new Set<string>(windowsDelivery?.unavailablePackages ?? [])
            const thirdPartyLocalPlugins = localDshPlugins.filter((lp) => {
              const name = lp.packageName
              return (
                !name.startsWith('@deepseek-ai/') &&
                name !== 'dsh-self-studio' &&
                name !== 'dsh-shell-product' &&
                name !== 'dsh-theme-product' &&
                !name.startsWith('@dsh-self/')
              )
            })
            const extraOrphans = extraInstalledPlugins.filter(
              (pkgName) => !thirdPartyLocalPlugins.some((lp) => lp.packageName === pkgName),
            )
            const filterText = localPluginFilter.trim().toLowerCase()
            const filteredLocalPlugins = thirdPartyLocalPlugins.filter((lp) => {
              if (!filterText) return true
              return (
                lp.packageName.toLowerCase().includes(filterText) ||
                (lp.description ?? '').toLowerCase().includes(filterText) ||
                lp.profile.toLowerCase().includes(filterText)
              )
            })

            return (
              <section className={css.card}>
                <div className={css.row} style={{ justifyContent: 'space-between' }}>
                  <h2>第 3 步：选择与确认插件</h2>
                  <div className={css.row}>
                    {project.spec.requiredActions.some((action: string) => action.startsWith('bid.')) && <button
                      type="button"
                      className={css.btnSecondary}
                      onClick={() => {
                        const hasTender = project.spec.requiredActions.includes('tender.searchNotices')
                        const nextReq = hasTender
                          ? project.spec.requiredActions.filter((a: string) => a !== 'tender.searchNotices')
                          : [...project.spec.requiredActions, 'tender.searchNotices']
                        void handleUpdateSpec({ requiredActions: nextReq }, hasTender ? '关闭查标讯' : '开启查标讯')
                      }}
                    >
                      {project.spec.requiredActions.includes('tender.searchNotices') ? '关闭查标讯' : '试试开启查标讯'}
                    </button>}
                    <button type="button" className={css.btnPrimary} onClick={() => setStep('appearance')}>
                      下一步：改外观与模块 →
                    </button>
                  </div>
                </div>

                <span className={css.subtitle}>
                  本地插件拥有当前系统用户文件与网络权限；当前锁定 <strong>{lockedPlugins.length}</strong> 个插件包（含 <strong>{extraInstalledPlugins.length}</strong> 个手动指定的本机 DSH 插件），已扫描本机 <strong>{localDshPlugins.length}</strong> 个已装插件。
                </span>

                {windowsDelivery?.unavailablePackages.length > 0 && (
                  <p className={css.notice}>Windows 工具包尚未包含 {windowsDelivery.unavailablePackages.join('、')}。
                    请更换有物料的候选、从下方本机已装 DSH 插件指定，或移除暂时用不到的可选功能。
                    {missingOptional.length > 0 && <button type="button" className={css.btnSecondary} disabled={busy}
                      onClick={() => void handleUpdateSpec({
                        optionalActions: project.spec.optionalActions.filter((action: string) => !missingOptional.includes(action)),
                      }, '移除暂不可用的可选功能')}>移除 {missingOptional.length} 项不可用的可选功能</button>}
                  </p>
                )}
                {project.resolution.missingRequiredActions.length > 0 && (
                  <div className={`${css.notice} ${css.noticeError}`}>
                    有未满足的能力：{project.resolution.missingRequiredActions.map((a: string) => ACTION_LABELS[a] ?? a).join('、')}，下方已给出替代方案。
                  </div>
                )}

                {/* Block A: Free selection of ALL deliverable capability packs for custom templates */}
                {deliverablePacks.length > 0 && (
                  <div className={css.pluginRow} data-testid="deliverable-capability-packs">
                    <div className={css.row} style={{ justifyContent: 'space-between' }}>
                      <div className={css.row}>
                        <strong>自由组合可交付能力包（自定义模板全量可选）</strong>
                        <span className={`${css.pill} ${css.pillOk}`}>
                          已选 {enabledDeliverableCount} / {deliverablePacks.length} 套
                        </span>
                      </div>
                      {enabledDeliverableCount < deliverablePacks.length && (
                        <button
                          type="button"
                          className={css.btnSecondary}
                          disabled={busy}
                          onClick={handleEnableAllDeliverablePacks}
                        >
                          一键开启全部 {deliverablePacks.length} 套可交付能力
                        </button>
                      )}
                    </div>
                    <span className={css.subtitle}>
                      以下能力包均已完成内置或 SHA-512 校验打包实测，可在任意自定义模板上自由组合，全部支持独立桌面试用与打进安装包：
                    </span>
                    <div className={css.candidateList}>
                      {deliverablePacks.map((pack) => {
                        const enabled = pack.actions.length > 0 && pack.actions.every((a) => allWantedActions.has(a))
                        const localHit = installedPlugins[pack.packageName]
                        return (
                          <div key={pack.id} className={`${css.candidateCard} ${enabled ? css.candidateCardSelected : ''}`}>
                            <div className={css.candidateMeta}>
                              <div className={css.row}>
                                <strong>{CAPABILITY_PACK_TITLES[pack.id] ?? pack.packageName}</strong>
                                <span className={css.subtitle}>{pack.packageName}@{pack.version}</span>
                                <span className={`${css.pill} ${css.pillOk}`}>可直打交付</span>
                                <span className={css.pill}>{TIER_LABELS[pack.trustTier] ?? pack.trustTier}</span>
                                {pack.requiresConnections.length === 0 ? (
                                  <span className={css.pill}>离线可用</span>
                                ) : (
                                  <span className={`${css.pill} ${css.pillWarn}`}>需外部连接/Chrome</span>
                                )}
                                {localHit && <span className={`${css.pill} ${css.pillInstalled}`}>本机已装 v{localHit.version}</span>}
                              </div>
                              <span className={css.subtitle}>{pack.description.zh}</span>
                            </div>
                            <div>
                              <button
                                type="button"
                                className={enabled ? css.btnSecondary : css.btnPrimary}
                                disabled={busy}
                                onClick={() => handleToggleCapabilityPack(pack)}
                              >
                                {enabled ? '✓ 已启用 · 移除' : '+ 加入方案'}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>

                    {catalogCandidatePacks.length > 0 && (
                      <details style={{ marginTop: 4 }}>
                        <summary className={css.subtitle}>
                          查看其余 {catalogCandidatePacks.length} 个白名单目录候选（需本机已装手动指定，或待补充离线物料）
                        </summary>
                        <div className={css.candidateList}>
                          {catalogCandidatePacks.map((pack) => {
                            const localHit = installedPlugins[pack.packageName]
                            const manuallyAttached = extraInstalledPlugins.includes(pack.packageName)
                            const enabled = pack.actions.length > 0 && pack.actions.every((a) => allWantedActions.has(a))
                            return (
                              <div key={pack.id} className={css.candidateCard}>
                                <div className={css.candidateMeta}>
                                  <div className={css.row}>
                                    <strong>{CAPABILITY_PACK_TITLES[pack.id] ?? pack.packageName}</strong>
                                    <span className={css.subtitle}>{pack.packageName}@{pack.version}</span>
                                    {!pack.admitted ? (
                                      <span className={`${css.pill} ${css.pillDanger}`}>与 dsh 不兼容</span>
                                    ) : (
                                      <span className={`${css.pill} ${css.pillWarn}`}>缺离线物料</span>
                                    )}
                                    {localHit && (
                                      <span className={`${css.pill} ${css.pillInstalled}`}>本机已装 v{localHit.version}</span>
                                    )}
                                  </div>
                                  <span className={css.subtitle}>{pack.description.zh}</span>
                                  {pack.mcpAlternativeHint && (
                                    <span className={css.subtitle}>{pack.mcpAlternativeHint.zh}</span>
                                  )}
                                </div>
                                <div className={css.row}>
                                  {!pack.admitted ? (
                                    <span className={`${css.pill} ${css.pillDanger}`}>不可选（见 MCP 替代）</span>
                                  ) : localHit?.selectableAsExtra ? (
                                    <button
                                      type="button"
                                      className={css.btnSecondary}
                                      disabled={busy}
                                      onClick={() => handleToggleExtraInstalledPlugin(pack.packageName)}
                                    >
                                      {manuallyAttached ? '✓ 已用本机版 · 移除' : '改用本机已装加入打包'}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      className={css.btnSecondary}
                                      disabled={busy}
                                      onClick={() => handleToggleCapabilityPack(pack)}
                                    >
                                      {enabled ? '移除可选能力' : '加入候选查看'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                {/* Block B: Manually specify extra plugins from currently installed local DSH */}
                <div className={css.pluginRow} data-testid="manual-local-dsh-plugins">
                  <div className={css.row} style={{ justifyContent: 'space-between' }}>
                    <div className={css.row}>
                      <strong>从当前 DSH 已安装插件中手动额外指定</strong>
                      <span className={`${css.pill} ${css.pillInstalled}`}>
                        已发现 {thirdPartyLocalPlugins.length} 个本机扩展
                      </span>
                      {extraInstalledPlugins.length > 0 && (
                        <span className={`${css.pill} ${css.pillOk}`}>
                          已额外指定 {extraInstalledPlugins.length} 个
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className={css.btnSecondary}
                      disabled={busy}
                      onClick={() => void handleRefreshLocalPlugins()}
                    >
                      重新扫描本机 DSH
                    </button>
                  </div>

                  <span className={css.subtitle}>
                    可从你当前 DSH 已安装的扩展里手动额外勾选打进独立客户端。加入时会做静态安全检查（禁止 <code>!!js</code> 补丁、禁止安装脚本、自动剔除 <code>@deepseek-ai/dsh*</code> 影子包、生成 SHA-512 快照），独立数据目录与当前 DSH 完全隔离。
                  </span>

                  {extraInstalledPlugins.length > 0 && (
                    <div className={`${css.notice} ${css.noticeWarn}`}>
                      <strong>已手动指定 {extraInstalledPlugins.length} 个本机 DSH 插件：</strong>
                      {extraInstalledPlugins.join('、')}（将随 <code>profile-seed.tar.gz</code> 一起装入独立客户端配置槽，拥有当前系统用户完整文件与网络权限）。
                    </div>
                  )}

                  {extraOrphans.length > 0 && (
                    <div className={css.candidateList}>
                      {extraOrphans.map((pkgName) => (
                        <div key={`orphan-${pkgName}`} className={`${css.candidateCard} ${css.candidateCardSelected}`}>
                          <div className={css.candidateMeta}>
                            <div className={css.row}>
                              <strong>{pkgName}</strong>
                              <span className={`${css.pill} ${css.pillWarn}`}>已使用本地校验缓存快照（当前 DSH 未检测到）</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className={css.btnSecondary}
                            disabled={busy}
                            onClick={() => handleToggleExtraInstalledPlugin(pkgName)}
                          >
                            移除
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {thirdPartyLocalPlugins.length >= 4 && (
                    <input
                      className={css.input}
                      value={localPluginFilter}
                      onChange={(e) => setLocalPluginFilter(e.target.value)}
                      placeholder="按包名、简介或 profile 筛选本机已装 DSH 插件…"
                    />
                  )}

                  {filteredLocalPlugins.length === 0 ? (
                    <div className={css.notice}>
                      {thirdPartyLocalPlugins.length === 0
                        ? '当前 DSH 环境中尚未检测到除宿主和制作器以外的第三方 DSH 插件。你在 DSH 插件市场安装任意插件后，点右上角「重新扫描本机 DSH」即可在此手动指定打包。'
                        : '没有匹配筛选条件的本机插件。'}
                    </div>
                  ) : (
                    <div className={css.candidateList}>
                      {filteredLocalPlugins.map((lp) => {
                        const isManuallySelected = extraInstalledPlugins.includes(lp.packageName)
                        const lockedHit = lockedByPkg.get(lp.packageName)
                        const isUnavailableInLock = unavailableSet.has(lp.packageName)
                        const alreadyDeliverableInLock =
                          Boolean(lockedHit) &&
                          lockedHit.sourceKind !== 'local-installed' &&
                          !isUnavailableInLock

                        return (
                          <div
                            key={`local-${lp.packageName}`}
                            className={`${css.candidateCard} ${isManuallySelected ? css.candidateCardSelected : ''}`}
                          >
                            <div className={css.candidateMeta}>
                              <div className={css.row}>
                                <strong>{lp.packageName}</strong>
                                <span className={css.subtitle}>v{lp.version}</span>
                                <span className={`${css.pill} ${css.pillInstalled}`}>
                                  {lp.scope === 'active-profile' ? `当前 profile (${lp.profile})` : `profile: ${lp.profile}`}
                                </span>
                                {lp.runtimeKind && (
                                  <span className={css.pill}>{RUNTIME_LABELS[lp.runtimeKind] ?? lp.runtimeKind}</span>
                                )}
                                {lp.compatibility === 'compatible' && (
                                  <span className={`${css.pill} ${css.pillOk}`}>兼容 dsh 0.2.2-rc.5</span>
                                )}
                                {lp.compatibility === 'undeclared' && (
                                  <span className={`${css.pill} ${css.pillWarn}`}>未声明 dsh 版本（建议试用）</span>
                                )}
                                {lp.compatibility === 'incompatible' && (
                                  <span className={`${css.pill} ${css.pillDanger}`}>不兼容</span>
                                )}
                              </div>
                              {lp.description && <span className={css.subtitle}>{lp.description}</span>}
                              {lp.compatibility === 'incompatible' && lp.compatibilityDetail && (
                                <span className={css.subtitle} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>
                                  原因：{lp.compatibilityDetail}
                                </span>
                              )}
                            </div>
                            <div>
                              {isManuallySelected ? (
                                <button
                                  type="button"
                                  className={css.btnSecondary}
                                  disabled={busy}
                                  onClick={() => handleToggleExtraInstalledPlugin(lp.packageName)}
                                >
                                  ✓ 已手动指定 · 移除
                                </button>
                              ) : alreadyDeliverableInLock ? (
                                <span className={`${css.pill} ${css.pillOk}`}>✓ 已在当前方案中</span>
                              ) : lp.selectableAsExtra ? (
                                <button
                                  type="button"
                                  className={isUnavailableInLock ? css.btnPrimary : css.btnSecondary}
                                  disabled={busy}
                                  onClick={() => handleToggleExtraInstalledPlugin(lp.packageName)}
                                >
                                  {isUnavailableInLock ? '改用本机已装打包' : '+ 手动加入打包'}
                                </button>
                              ) : (
                                <span className={`${css.pill} ${css.pillDanger}`}>不可加入</span>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {/* Block C: Coverage & alternative provider inspection for current actions */}
                {project.resolution.coverage.map((cov: any) => {
                  const selectedInstalled = cov.selectedPackageName ? installedPlugins[cov.selectedPackageName] : undefined
                  const candidates = Array.isArray(cov.candidates) ? cov.candidates : []
                  const label = ACTION_LABELS[cov.actionId] ?? cov.actionId
                  return (
                    <div key={cov.actionId} className={css.pluginRow}>
                      <div className={css.row} style={{ justifyContent: 'space-between' }}>
                        <div className={css.row}>
                          <strong>{label}</strong>
                          {cov.selectedPackageName ? (
                            <>
                              <span className={`${css.pill} ${css.pillOk}`}>{cov.selectedPackageName}</span>
                              <span className={css.pill}>{TIER_LABELS[cov.trustTier] ?? cov.trustTier}</span>
                              <span className={css.pill}>{RUNTIME_LABELS[cov.runtimeKind] ?? cov.runtimeKind}</span>
                              {cov.pinnedByUser && <span className={`${css.pill} ${css.pillWarn}`}>已自选</span>}
                              {selectedInstalled && (
                                <span className={`${css.pill} ${css.pillInstalled}`}>本机已装 v{selectedInstalled.version}</span>
                              )}
                            </>
                          ) : (
                            <span className={`${css.pill} ${css.pillDanger}`}>暂无兼容插件</span>
                          )}
                        </div>
                        {cov.pinnedByUser && (
                          <button type="button" className={css.btnSecondary} disabled={busy} onClick={() => handleClearAlternative(cov.actionId)}>
                            恢复默认
                          </button>
                        )}
                      </div>

                      {candidates.length > 0 && (
                        <div className={css.candidateList}>
                          {candidates.map((cand: any) => {
                            const localHit = installedPlugins[cand.packageName]
                            return (
                              <div key={`${cov.actionId}-${cand.id}`} className={`${css.candidateCard} ${cand.selected ? css.candidateCardSelected : ''}`}>
                                <div className={css.candidateMeta}>
                                  <div className={css.row}>
                                    <strong>{cand.packageName}</strong>
                                    <span className={css.subtitle}>v{cand.version}</span>
                                    <span className={css.pill}>{TIER_LABELS[cand.trustTier] ?? cand.trustTier}</span>
                                    {localHit && <span className={`${css.pill} ${css.pillInstalled}`}>本机已装 v{localHit.version}</span>}
                                    {!cand.admitted && <span className={`${css.pill} ${css.pillDanger}`}>不兼容</span>}
                                  </div>
                                  <span className={css.subtitle}>{cand.description?.zh}</span>
                                  {cand.blockReason && <span className={css.subtitle} style={{ color: 'var(--dsw-alias-state-error-primary)' }}>原因：{cand.blockReason}</span>}
                                </div>
                                <div>
                                  {cand.selected ? (
                                    <span className={`${css.pill} ${css.pillOk}`}>✓ 已选用</span>
                                  ) : cand.selectable ? (
                                    <button type="button" className={css.btnSecondary} disabled={busy} onClick={() => handleSelectAlternative(cov.actionId, cand.id, cand.packageName)}>
                                      {cand.requiresTrialConfirmation ? '切换试用' : '切换选用'}
                                    </button>
                                  ) : (
                                    <span className={`${css.pill} ${css.pillDanger}`}>不可选</span>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {cov.mcpAlternativeHint && (
                        <div className={`${css.notice} ${css.noticeWarn}`}>
                          <strong>替代方案：</strong>{cov.mcpAlternativeHint.zh}
                        </div>
                      )}
                    </div>
                  )
                })}

                <div className={css.row}>
                  <button type="button" className={css.btnPrimary} onClick={() => setStep('appearance')}>
                    下一步：改外观与首页模块 →
                  </button>
                </div>
              </section>
            )
          })()}

          {/* STEP 4: 改外观与模块（独立步骤！品牌名 + 图标 + 配色 + 布局 + 首页模块自由增删） */}
          {step === 'appearance' && project && (
            <section className={css.card}>
              <div className={css.row} style={{ justifyContent: 'space-between' }}>
                <h2>第 4 步：自定义外观、图标与首页模块</h2>
                <button type="button" className={css.btnPrimary} disabled={busy} onClick={() => void handleStartPreview()}>
                  下一步：试用与调整 →
                </button>
              </div>

              <div className={css.iconStudio}>
                <div className={css.iconPreviewWrap}>
                  {project.spec.brand.iconDataUrl ? (
                    <>
                      <img className={css.iconPreview64} src={project.spec.brand.iconDataUrl} alt="客户端大图标" />
                      <img className={css.iconPreview20} src={project.spec.brand.iconDataUrl} alt="客户端小图标" />
                    </>
                  ) : (
                    <div className={css.iconPreview64} style={{ display: 'grid', placeItems: 'center', background: accentLight, color: '#fff', fontSize: 26, fontWeight: 700 }}>
                      {nameZh.slice(0, 1) || 'D'}
                    </div>
                  )}
                </div>
                <div className={css.candidateMeta}>
                  <div className={css.row}>
                    <strong>客户端图标</strong>
                    <span className={css.subtitle}>桌面快捷方式、任务栏与安装包图标</span>
                  </div>
                  <div className={css.row}>
                    {ICON_PRESET_OPTIONS.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        disabled={busy}
                        className={`${css.presetBtn} ${project.spec.brand.iconPreset === preset.id ? css.presetBtnActive : ''}`}
                        onClick={() => void handleUpdateSpec({ iconPreset: preset.id }, `切换图标：${preset.label}`)}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <label className={css.presetBtn} style={{ cursor: 'pointer' }}>
                      上传图片
                      <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => handleBrandIconUpload(e.target.files?.[0])} />
                    </label>
                  </div>
                </div>
              </div>

              <div className={css.twoCol}>
                <div>
                  <label className={css.subtitle}>中文名称</label>
                  <input className={css.input} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
                </div>
                <div>
                  <label className={css.subtitle}>英文名称</label>
                  <input className={css.input} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
                </div>
                <div>
                  <label className={css.subtitle}>版本号</label>
                  <input className={css.input} value={appVersion} onChange={(e) => setAppVersion(e.target.value)} />
                </div>
                <div>
                  <label className={css.subtitle}>系统标识（固定不变）</label>
                  <input className={css.input} readOnly value={project.spec.identity.internalSlug} />
                </div>
              </div>

              <div className={css.twoCol}>
                <div>
                  <label className={css.subtitle}>页面布局</label>
                  <select
                    className={css.select}
                    value={project.spec.home.layout}
                    onChange={(e) => {
                      const layout = e.target.value
                      const kept = project.spec.home.sections.filter((secId: string) => {
                        const mod = ALL_MODULES.find((m) => m.id === secId)
                        return !mod || mod.layouts.includes(layout)
                      })
                      const sections = kept.length > 0 ? kept : ['recent-sessions']
                      void handleUpdateSpec({ layout, sections }, `切换布局为 ${layout}`)
                    }}
                  >
                    {LAYOUT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={css.subtitle}>品牌主色 / 背景色</label>
                  <div className={css.row}>
                    <input type="color" value={accentLight} onChange={(e) => setAccentLight(e.target.value)} />
                    <code>{accentLight}</code>
                    <input type="color" value={canvasLight} onChange={(e) => setCanvasLight(e.target.value)} />
                    <code>{canvasLight}</code>
                  </div>
                </div>
              </div>

              {/* Manual Add / Remove / Reorder Home Modules */}
              <div className={css.pluginRow}>
                <strong>首页已放模块（支持排序与删除，至少保留 1 个）</strong>
                <div className={css.modulePool}>
                  {project.spec.home.sections.map((sec: string, idx: number) => (
                    <div key={sec} className={css.moduleChip}>
                      <span>{idx + 1}. {MODULE_LABEL_MAP[sec] ?? sec}</span>
                      <button type="button" className={css.miniBtn} disabled={busy || idx === 0} onClick={() => moveSection(idx, -1)} title="前移">←</button>
                      <button type="button" className={css.miniBtn} disabled={busy || idx === project.spec.home.sections.length - 1} onClick={() => moveSection(idx, 1)} title="后移">→</button>
                      <button
                        type="button"
                        className={`${css.miniBtn} ${css.miniBtnDanger}`}
                        disabled={busy || project.spec.home.sections.length <= 1}
                        onClick={() => removeSection(sec)}
                        title="移除此模块"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <strong style={{ marginTop: 4 }}>可添加的模块（点一下立即加入首页）</strong>
                <div className={css.modulePool}>
                  {ALL_MODULES.filter(
                    (m) => !project.spec.home.sections.includes(m.id) && m.layouts.includes(project.spec.home.layout),
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={css.presetBtn}
                      disabled={busy || project.spec.home.sections.length >= 8}
                      onClick={() => addSection(m.id)}
                      title={m.desc}
                    >
                      + {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={css.row}>
                <button
                  type="button"
                  className={css.btnSecondary}
                  disabled={busy}
                  onClick={() => void handleUpdateSpec({
                    displayName: { zh: nameZh, en: nameEn },
                    appVersion,
                    themeSeeds: {
                      ...project.spec.theme.seeds,
                      light: { ...project.spec.theme.seeds.light, accent: accentLight, canvas: canvasLight },
                    },
                  }, '保存名称与配色')}
                >
                  保存名称与配色
                </button>
                <button type="button" className={css.btnPrimary} disabled={busy} onClick={() => void handleStartPreview()}>
                  进入 试用与调整 →
                </button>
                <button type="button" className={css.btnDanger} disabled={busy} onClick={() => void handleDeleteProject(project.projectId)}>
                  删除项目
                </button>
              </div>
            </section>
          )}

          {/* STEP 5: 试用与自然语言持续微调 */}
          {step === 'preview' && project && (
            <>
              <section className={css.card}>
                <div className={css.row} style={{ justifyContent: 'space-between' }}>
                  <h2>试用与调整</h2>
                  <div className={css.row}>
                    <button type="button" className={css.btnPrimary} disabled={busy} onClick={async () => {
                      setBusy(true); setError(null)
                      try {
                        const result = await rpc.call<{ revision: number; productDigest: string; lockDigest: string }>(
                          'openDesktopTrial', { projectId: project.projectId, expectedRevision: project.spec.revision })
                        setTrial({ ...result, projectId: project.projectId })
                      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
                      finally { setBusy(false) }
                    }}>打开真实桌面试用 / Open desktop trial</button>
                    {trial && trial.projectId === project.projectId && <span>已打开桌面修订 r{trial.revision}</span>}
                    <button type="button" className={css.btnSecondary} onClick={() => setViewportWidth('100%')}>桌面视图</button>
                    <button type="button" className={css.btnSecondary} onClick={() => setViewportWidth('768px')}>窄屏视图</button>
                    <button type="button" className={css.btnSecondary} disabled={busy} onClick={() => void handleStartPreview()}>
                      {preview?.running ? '刷新预览' : '启动预览'}
                    </button>
                    {preview?.running && (
                      <a className={`${css.btnSecondary} ${css.btnLink}`} href={preview.url} target="_blank" rel="noreferrer">
                        新窗口 ↗
                      </a>
                    )}
                    <button type="button" className={css.btnPrimary} onClick={() => setStep('build')}>
                      满意，去打包 →
                    </button>
                  </div>
                </div>

                <div className={css.previewSplit}>
                  <div>
                    {preview?.running ? (
                      <div className={css.previewFrameWrap} style={{ maxWidth: viewportWidth }}>
                        <iframe
                          key={`${preview.url}-${project.spec.revision}-${previewNonce}`}
                          src={preview.url}
                          title="Layout sketch"
                          className={css.previewFrame}
                        />
                      </div>
                    ) : (
                      <div className={css.notice}>点击「启动预览」查看布局草图，并在右侧直接用自然语言继续调整。</div>
                    )}
                  </div>

                  {/* Right panel: Natural Language continuous refinement! */}
                  <aside className={css.refinePane} aria-label="自然语言微调">
                    <div className={css.row} style={{ justifyContent: 'space-between' }}>
                      <strong>💬 对话微调</strong>
                      <span className={css.pill}>实时热刷新</span>
                    </div>
                    <div className={css.chatLog}>
                      {refineChat.map((m, idx) => (
                        <div key={idx} className={m.role === 'user' ? css.chatBubbleUser : css.chatBubbleBot}>
                          {m.text}
                        </div>
                      ))}
                    </div>
                    <div className={css.quickChips}>
                      {QUICK_REFINEMENTS.map((q) => (
                        <button
                          key={q}
                          type="button"
                          className={css.quickChip}
                          disabled={refining}
                          onClick={() => void handleSendRefinement(q)}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                    <div className={css.row}>
                      <input
                        className={css.input}
                        value={refineInput}
                        onChange={(e) => setRefineInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSendRefinement() } }}
                        placeholder="说出修改意见，如：换成深海蓝并去掉缺失资质…"
                      />
                      <button
                        type="button"
                        className={css.btnPrimary}
                        style={{ width: '100%' }}
                        disabled={refining || !refineInput.trim()}
                        onClick={() => void handleSendRefinement()}
                      >
                        {refining ? '正在调整预览…' : '应用修改并刷新预览'}
                      </button>
                    </div>
                  </aside>
                </div>
              </section>

              <section className={css.card}>
                <h3>历史版本（随时可撤回）</h3>
                {project.history.slice().reverse().map((h: any) => (
                  <div key={h.revision} className={css.row} style={{ justifyContent: 'space-between' }}>
                    <span><strong>r{h.revision}</strong> · {h.spec.brand.displayName.zh} · {h.summary}</span>
                    {h.revision !== project.spec.revision && (
                      <button type="button" className={css.btnSecondary} disabled={busy} onClick={() => void handleRollback(h.revision)}>
                        恢复到 r{h.revision}
                      </button>
                    )}
                  </div>
                ))}
              </section>
            </>
          )}

          {/* STEP 6: 生成安装包（多平台多选 + 跨平台策略 + 安装包版本管理） */}
          {step === 'build' && project && (
            <>
              <section className={css.card}>
                <h2>生成安装包与版本发布</h2>

                <div className={css.pluginRow}>
                  <strong>本次发布版本号与更新说明</strong>
                  <div className={css.twoCol}>
                    <div className={css.row}>
                      <input
                        className={css.input}
                        style={{ maxWidth: 130 }}
                        value={appVersion}
                        onChange={(e) => setAppVersion(e.target.value)}
                        aria-label="发布版本号"
                      />
                      {appVersion.trim() !== project.spec.appVersion && (
                        <button type="button" className={css.btnSecondary} disabled={busy}
                          onClick={() => void handleUpdateSpec({ appVersion: appVersion.trim() }, '保存发布版本号')}>保存版本号</button>
                      )}
                      <button type="button" className={css.btnSecondary} onClick={() => bumpSemver('patch')}>
                        + 补丁版
                      </button>
                      <button type="button" className={css.btnSecondary} onClick={() => bumpSemver('minor')}>
                        + 功能版
                      </button>
                    </div>
                    <input
                      className={css.input}
                      value={releaseNotes}
                      onChange={(e) => setReleaseNotes(e.target.value)}
                      placeholder="本次更新说明（可选，例如：新增图标与日历提醒）"
                    />
                  </div>
                </div>

                <div className={css.pluginRow}>
                  <strong>选择目标平台（可多选，默认当前系统）</strong>
                  <div className={css.targetGrid}>
                    {TARGET_OPTIONS.map((opt) => {
                      const checked = selectedTargets.includes(opt.id)
                      const isHost = opt.id === hostTarget
                      return (
                        <label key={opt.id} className={`${css.targetCard} ${checked ? css.targetCardActive : ''}`}>
                          <input type="checkbox" checked={checked} onChange={() => toggleBuildTarget(opt.id)} />
                          <div className={css.candidateMeta} style={{ minWidth: 0 }}>
                            <div className={css.row}>
                              <strong>{opt.label}</strong>
                              {isHost ? <span className={`${css.pill} ${css.pillOk}`}>本机直打</span> : <span className={css.pill}>跨平台</span>}
                            </div>
                            <span className={css.subtitle}>{opt.artifact}</span>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                </div>

                {selectedTargets.some((tKey) => tKey !== hostTarget) && (
                  <div className={css.pluginRow}>
                    <strong>跨平台打包方式</strong>
                    <div className={css.strategyGrid}>
                      {CROSS_STRATEGIES.map((st) => (
                        <label key={st.id} className={`${css.strategyCard} ${crossStrategy === st.id ? css.strategyCardActive : ''}`}>
                          <div className={css.row}>
                            <input type="radio" name="cross-strategy" checked={crossStrategy === st.id} onChange={() => setCrossStrategy(st.id)} />
                            <strong>{st.title}</strong>
                            <span className={`${css.pill} ${st.id === 'portable-bundle' ? css.pillOk : ''}`}>{st.badge}</span>
                          </div>
                          <span className={css.subtitle}>{st.desc}</span>
                        </label>
                      ))}
                    </div>
                    {crossStrategy === 'docker-or-remote' && (
                      <input
                        className={css.input}
                        value={customRemoteCmd}
                        onChange={(e) => setCustomRemoteCmd(e.target.value)}
                        placeholder="可选：填自定义 Docker 或远程 SSH 打包命令（留空用默认脚本）"
                      />
                    )}
                  </div>
                )}

                <div className={css.row}>
                  <button type="button" className={css.btnPrimary} disabled={busy || selectedTargets.length === 0 || jobs.some(job => job.status === 'running' || job.status === 'queued')} onClick={() => void handleStartBuild()}>
                    {busy ? '打包中…' : `打 v${appVersion} 包 (${selectedTargets.length} 个平台)`}
                  </button>
                  <a
                    className={`${css.btnSecondary} ${css.btnLink}`}
                    href={`/api/dsh-self-studio.export-spec?projectId=${encodeURIComponent(project.projectId)}`}
                    download={`${project.spec.identity.internalSlug}-product.json`}
                  >
                    导出 product.json
                  </a>
                </div>

                <div className={css.notice}>
                  Windows x64 可通过已配置的本机构建工具生成未签名安装包。其他目标当前提供构建配方。
                </div>

                {jobs.map((job: any) => (
                  <div key={job.jobId} className={css.pluginRow}>
                    <div className={css.row} style={{ justifyContent: 'space-between' }}>
                      <div className={css.row}>
                        <strong>{job.target}</strong>
                        <span className={`${css.pill} ${job.status === 'succeeded' ? css.pillOk : css.pillWarn}`}>
                          {job.status === 'succeeded' ? '已完成' : job.status}
                        </span>
                        <span className={css.pill}>{job.strategy}</span>
                      </div>
                      {job.status === 'succeeded' && job.artifactPath && (
                        <a className={`${css.btnSecondary} ${css.btnLink}`} href={`/api/dsh-self-studio.export-job-artifact?jobId=${encodeURIComponent(job.jobId)}`}>
                          {job.strategy === 'native-local' ? '下载安装包 / Installer' : '下载构建配方 / Recipe'}
                        </a>
                      )}
                    </div>
                    {job.error && <div role="alert" className={css.notice}>{job.error}</div>}
                    {job.status === 'succeeded' && job.receiptPath && (
                      <a href={`/api/dsh-self-studio.export-job-artifact?jobId=${encodeURIComponent(job.jobId)}&kind=receipt`}>下载构建回执 / Receipt</a>
                    )}
                    {job.artifactPath && <div className={css.subtitle}>产物：<code>{job.artifactPath}</code></div>}
                    <details>
                      <summary className={css.subtitle}>查看日志与校验码</summary>
                      {job.artifactSha256 && <div className={css.subtitle}>SHA-256：<code>{job.artifactSha256}</code></div>}
                      <pre className={css.codeBox}>{job.logs.join('\n')}</pre>
                    </details>
                  </div>
                ))}
              </section>

              {/* Persisted Release / Package Version History */}
              <section className={css.card} data-testid="release-version-manager">
                <div className={css.row} style={{ justifyContent: 'space-between' }}>
                  <h3>已生成包的版本管理 ({(project.releases ?? []).length})</h3>
                  <span className={css.subtitle}>支持按版本下载、导出历史配置、回退重打与清理旧包</span>
                </div>

                {(project.releases ?? []).length === 0 ? (
                  <div className={css.subtitle}>暂无已生成的安装包记录，点击上方「打包」后会自动归档到这里。</div>
                ) : (
                  (project.releases ?? []).map((rel: any) => (
                    <div key={rel.releaseId} className={css.pluginRow}>
                      <div className={css.row} style={{ justifyContent: 'space-between' }}>
                        <div className={css.row}>
                          <strong>v{rel.appVersion}</strong>
                          <span className={`${css.pill} ${css.pillOk}`}>{rel.target}</span>
                          <span className={css.pill}>r{rel.revision}</span>
                          <span className={css.pill}>{rel.strategy === 'native-local' ? (rel.artifactFileName?.endsWith('.json') ? '历史配置' : '本机包') : rel.strategy}</span>
                          <span className={css.subtitle}>{new Date(rel.builtAt).toLocaleString()}</span>
                        </div>
                        <div className={css.row}>
                          <a
                            className={`${css.btnSecondary} ${css.btnLink}`}
                            href={`/api/dsh-self-studio.export-release?projectId=${encodeURIComponent(project.projectId)}&releaseId=${encodeURIComponent(rel.releaseId)}&kind=artifact`}
                          >
                            下载产物
                          </a>
                          {rel.receiptPath && <a className={css.btnLink}
                            href={`/api/dsh-self-studio.export-release?projectId=${encodeURIComponent(project.projectId)}&releaseId=${encodeURIComponent(rel.releaseId)}&kind=receipt`}>
                            下载回执 / Receipt</a>}
                          <a
                            className={`${css.btnSecondary} ${css.btnLink}`}
                            href={`/api/dsh-self-studio.export-release?projectId=${encodeURIComponent(project.projectId)}&releaseId=${encodeURIComponent(rel.releaseId)}&kind=spec`}
                          >
                            导出此版配置
                          </a>
                          <button
                            type="button"
                            className={css.btnSecondary}
                            disabled={busy}
                            onClick={() => void handleRestoreRelease(rel.releaseId)}
                          >
                            回退到此版
                          </button>
                          <button
                            type="button"
                            className={css.btnDanger}
                            disabled={busy}
                            onClick={() => void handleDeleteRelease(rel.releaseId)}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                      <div className={css.subtitle}>
                        更新说明：{rel.notes} · 文件：<code>{rel.artifactFileName}</code> · SHA-256：<code>{String(rel.artifactSha256).slice(0, 12)}</code>
                      </div>
                    </div>
                  ))
                )}

                <details>
                  <summary className={css.subtitle}>查看当前 product.json 原文</summary>
                  <pre className={css.codeBox}>{JSON.stringify(project.spec, null, 2)}</pre>
                </details>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

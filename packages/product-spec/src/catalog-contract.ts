/**
 * Closed-set A2UI / json-render style widget & action registries.
 * Zero arbitrary layout trees, zero script expressions, zero raw HTML/CSS.
 */

export const LAYOUT_PRESETS = [
  'single-column',
  'list-detail',
  'three-pane',
  'dashboard-grid',
] as const

export type LayoutPreset = (typeof LAYOUT_PRESETS)[number]

export const DATA_BINDING_KEYS = [
  'workspace.current',
  'bid.projects',
  'bid.deadlines',
  'bid.missingMaterials',
  'bid.activeDocument',
  'design.projects',
  'design.activeCanvas',
  'design.annotations',
  'sessions.recent',
  'readiness.status',
  'connections.summary',
] as const

export type DataBindingKey = (typeof DATA_BINDING_KEYS)[number]

export interface WidgetCatalogEntry {
  readonly id: string
  readonly title: { readonly zh: string; readonly en: string }
  readonly allowedLayouts: readonly LayoutPreset[]
  readonly dataBindings: readonly DataBindingKey[]
  readonly defaultZone: 'left' | 'main' | 'right' | 'top'
}

export const WIDGET_CATALOG = {
  'readiness-bar': {
    id: 'readiness-bar',
    title: { zh: '环境就绪条', en: 'Readiness bar' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['readiness.status', 'workspace.current'],
    defaultZone: 'top',
  },
  deadlines: {
    id: 'deadlines',
    title: { zh: '截止日期追踪', en: 'Deadlines' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['bid.deadlines', 'bid.projects'],
    defaultZone: 'left',
  },
  'missing-materials': {
    id: 'missing-materials',
    title: { zh: '缺失资质与材料', en: 'Missing materials' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['bid.missingMaterials', 'bid.activeDocument'],
    defaultZone: 'main',
  },
  'bid-preview': {
    id: 'bid-preview',
    title: { zh: '招标原文定位预览', en: 'Bid source preview' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['bid.activeDocument'],
    defaultZone: 'right',
  },
  'project-list': {
    id: 'project-list',
    title: { zh: '项目列表', en: 'Projects' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['design.projects', 'workspace.current'],
    defaultZone: 'left',
  },
  'design-canvas': {
    id: 'design-canvas',
    title: { zh: '作品画布', en: 'Design canvas' },
    allowedLayouts: ['single-column', 'three-pane'],
    dataBindings: ['design.activeCanvas', 'design.annotations'],
    defaultZone: 'main',
  },
  'annotations-panel': {
    id: 'annotations-panel',
    title: { zh: '属性与批注', en: 'Properties & annotations' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['design.annotations', 'design.activeCanvas'],
    defaultZone: 'right',
  },
  'recent-sessions': {
    id: 'recent-sessions',
    title: { zh: '继续工作', en: 'Continue working' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['sessions.recent'],
    defaultZone: 'main',
  },
  'connections-card': {
    id: 'connections-card',
    title: { zh: '外部连接状态', en: 'Connections' },
    allowedLayouts: ['single-column', 'list-detail', 'three-pane', 'dashboard-grid'],
    dataBindings: ['connections.summary'],
    defaultZone: 'right',
  },
} as const satisfies Record<string, WidgetCatalogEntry>

export type WidgetId = keyof typeof WIDGET_CATALOG
export const WIDGET_IDS = Object.keys(WIDGET_CATALOG) as readonly WidgetId[]

export type ActionKind = 'panel-open' | 'host-service' | 'seeded-session'

export interface ActionRegistryEntry {
  readonly id: string
  readonly kind: ActionKind
  readonly label: { readonly zh: string; readonly en: string }
  readonly inputType: string
  readonly outputType: string
  readonly deterministic: boolean
  readonly requiresConnection?: string
  readonly routePath?: string
  readonly panelId?: string
  readonly capabilityIntent: string
}

/**
 * Only the 3 real dsh@0.2.2-rc.5 primitives are permitted:
 * - `panel-open`: parameterless `ctx.layout.selectPanel(panelId)` or `sidebarRight.openResource`
 * - `host-service`: authenticated `ctx.connection.fetch.register` / Typert Remote
 * - `seeded-session`: AI-assisted `ctx.uiWorkspace.startSession` draft
 */
export const ACTION_REGISTRY = {
  'bid.importRequirements': {
    id: 'bid.importRequirements',
    kind: 'host-service',
    label: { zh: '导入招标文件', en: 'Import bid DOCX' },
    inputType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    outputType: 'application/json#bid-project',
    deterministic: true,
    routePath: '/api/dsh-self/bid/import',
    capabilityIntent: 'bid-parse',
  },
  'bid.exportResponseDocx': {
    id: 'bid.exportResponseDocx',
    kind: 'host-service',
    label: { zh: '导出逐条响应表', en: 'Export response DOCX' },
    inputType: 'application/json#bid-project',
    outputType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    deterministic: true,
    routePath: '/api/dsh-self/bid/export',
    capabilityIntent: 'bid-export-docx',
  },
  'bid.openWorkbench': {
    id: 'bid.openWorkbench',
    kind: 'panel-open',
    label: { zh: '打开投标工作台', en: 'Open bid workbench' },
    inputType: 'void',
    outputType: 'void',
    deterministic: true,
    panelId: 'bidkit-workbench',
    capabilityIntent: 'bid-workbench',
  },
  'bid.draftResponseAi': {
    id: 'bid.draftResponseAi',
    kind: 'seeded-session',
    label: { zh: 'AI 起草响应内容', en: 'Draft response with AI' },
    inputType: 'application/json#bid-requirement',
    outputType: 'session',
    deterministic: false,
    requiresConnection: 'model-provider',
    capabilityIntent: 'bid-ai-draft',
  },
  'tender.searchNotices': {
    id: 'tender.searchNotices',
    kind: 'host-service',
    label: { zh: '查询公开标讯', en: 'Search tender notices' },
    inputType: 'application/json#tender-query',
    outputType: 'application/json#tender-list',
    deterministic: true,
    requiresConnection: 'qichacha-mcp',
    routePath: '/api/dsh-self/tender/search',
    capabilityIntent: 'tender-search',
  },
  'design.importImage': {
    id: 'design.importImage',
    kind: 'host-service',
    label: { zh: '导入作品图', en: 'Import artwork image' },
    inputType: 'image/png|image/jpeg|image/webp',
    outputType: 'application/json#design-project',
    deterministic: true,
    routePath: '/api/dsh-self/design/import',
    capabilityIntent: 'design-bitmap-annotate',
  },
  'design.saveAnnotations': {
    id: 'design.saveAnnotations',
    kind: 'host-service',
    label: { zh: '保存批注', en: 'Save annotations' },
    inputType: 'application/json#annotations',
    outputType: 'application/json#annotations',
    deterministic: true,
    routePath: '/api/dsh-self/design/annotations',
    capabilityIntent: 'design-bitmap-annotate',
  },
  'design.exportAnnotatedPng': {
    id: 'design.exportAnnotatedPng',
    kind: 'host-service',
    label: { zh: '导出批注 PNG', en: 'Export annotated PNG' },
    inputType: 'application/json#design-project',
    outputType: 'image/png',
    deterministic: true,
    routePath: '/api/dsh-self/design/export',
    capabilityIntent: 'design-export-png',
  },
  'design.openPrototypeStudio': {
    id: 'design.openPrototypeStudio',
    kind: 'panel-open',
    label: { zh: '打开 AI 原型画框', en: 'Open AI prototype studio' },
    inputType: 'void',
    outputType: 'void',
    deterministic: true,
    panelId: 'design-studio',
    capabilityIntent: 'design-ai-prototype',
  },
  'design.openImageDesign': {
    id: 'design.openImageDesign',
    kind: 'panel-open',
    label: { zh: '打开 AI 生图与 Demo 设计台', en: 'Open Image Design studio' },
    inputType: 'void',
    outputType: 'void',
    deterministic: false,
    requiresConnection: 'chatgpt-web-or-image-api',
    panelId: 'gpt-image-design',
    capabilityIntent: 'design-ai-image-demo',
  },
  'research.openProResearch': {
    id: 'research.openProResearch',
    kind: 'panel-open',
    label: { zh: '打开 Pro 多轮调研', en: 'Open Pro Research' },
    inputType: 'void',
    outputType: 'void',
    deterministic: false,
    requiresConnection: 'chatgpt-web-chrome',
    panelId: 'chatgpt-pro-research',
    capabilityIntent: 'pro-web-research',
  },
  'calendar.addDeadline': {
    id: 'calendar.addDeadline',
    kind: 'panel-open',
    label: { zh: '加入日历提醒', en: 'Add calendar deadline' },
    inputType: 'application/json#deadline',
    outputType: 'void',
    deterministic: true,
    requiresConnection: 'calendar',
    panelId: 'dsh-calendar.workbench',
    capabilityIntent: 'calendar-reminder',
  },
  'mail.openInbox': {
    id: 'mail.openInbox',
    kind: 'panel-open',
    label: { zh: '打开邮件', en: 'Open mail' },
    inputType: 'void',
    outputType: 'void',
    deterministic: true,
    requiresConnection: 'email',
    panelId: 'dsh-email.workbench',
    capabilityIntent: 'email-workbench',
  },
  'notes.openScratchpad': {
    id: 'notes.openScratchpad',
    kind: 'panel-open',
    label: { zh: '打开随手记', en: 'Open scratchpad' },
    inputType: 'void',
    outputType: 'void',
    deterministic: true,
    panelId: 'scratchpad',
    capabilityIntent: 'quick-notes',
  },
  'tasks.openKanban': {
    id: 'tasks.openKanban',
    kind: 'panel-open',
    label: { zh: '打开任务看板', en: 'Open kanban' },
    inputType: 'void',
    outputType: 'void',
    deterministic: true,
    panelId: 'kanban',
    capabilityIntent: 'task-kanban',
  },
} as const satisfies Record<string, ActionRegistryEntry>

export type ActionId = keyof typeof ACTION_REGISTRY
export const ACTION_IDS = Object.keys(ACTION_REGISTRY) as readonly ActionId[]

export const CAPABILITY_INTENTS = [
  'bid-parse',
  'bid-export-docx',
  'bid-workbench',
  'bid-ai-draft',
  'tender-search',
  'design-bitmap-annotate',
  'design-export-png',
  'design-ai-prototype',
  'design-ai-image-demo',
  'pro-web-research',
  'calendar-reminder',
  'email-workbench',
  'quick-notes',
  'task-kanban',
] as const

export type CapabilityIntent = (typeof CAPABILITY_INTENTS)[number]

export {
  DELIVERABLE_EXTERNAL_BUNDLES,
  desktopCapabilities,
  isDeliverableExternalBundle,
} from './runtime-actions.js'

import {
  ExtractionResultSchema,
  deriveThemeSeedsFromDominantColor,
  sanitizeDisplayName,
  type ActionId,
  type CapabilityIntent,
  type ExtractionResult,
  type LayoutPreset,
  type SemanticSeedPalette,
  type WidgetId,
} from '@dsh-self/product-spec'

// Studio's browser can sample decoded pixels before upload. Direct service callers use sharp.
async function extractDominantColorSafe(imageBuffer: Buffer, clientColor?: string): Promise<string> {
  // Reject non-raster inputs (e.g. external SVG)
  const isPng = imageBuffer.length >= 8 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4e && imageBuffer[3] === 0x47
  const isJpeg = imageBuffer.length >= 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff
  const isWebp = imageBuffer.length >= 12 && imageBuffer.subarray(0, 4).toString('ascii') === 'RIFF' && imageBuffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('Only PNG, JPEG, and WebP raster images are supported')
  }
  if (clientColor && /^#[0-9a-f]{6}$/i.test(clientColor)) return clientColor
  try {
    const mod = await import('sharp')
    const sharpFn = mod.default
    const { data } = await sharpFn(imageBuffer, { limitInputPixels: 300_000_000, sequentialRead: true })
      .rotate()
      .resize(1, 1, { fit: 'cover' })
      .toColorspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const r = (data[0] ?? 15).toString(16).padStart(2, '0')
    const g = (data[1] ?? 118).toString(16).padStart(2, '0')
    const b = (data[2] ?? 110).toString(16).padStart(2, '0')
    return `#${r}${g}${b}`
  } catch {
    throw new Error('无法解码参考图颜色，请重新上传 PNG、JPEG 或 WebP / Could not sample the reference image')
  }
}

export interface ModelModalityInfo {
  readonly modelId: string
  readonly declaredInputs: readonly string[]
  readonly routeAvailable: boolean
}

export function supportsImageInputModality(info: ModelModalityInfo): boolean {
  return info.routeAvailable && info.declaredInputs.includes('image')
}

export interface ClarifyingQuestion {
  readonly id: string
  readonly question: { readonly zh: string; readonly en: string }
  readonly options: readonly { readonly value: string; readonly label: { readonly zh: string; readonly en: string } }[]
  readonly affectsWorkflow: boolean
}

/** Generate minimal clarifying questions ONLY when the answer materially changes workflow/plugins. */
export function generateMinimalClarifications(prompt: string): ClarifyingQuestion[] {
  const questions: ClarifyingQuestion[] = []
  const mentionsBid = /投标|标书|招标|标讯|bid|tender/i.test(prompt)
  const explicitlySaysSearch = /查(?:询)?(?:公开)?标讯|找(?:公开)?标讯|搜(?:索)?(?:公开)?标讯|企查查|search.*tender/i.test(prompt)
  const explicitlySaysNoSearch = /不查标讯|已有招标|手头已有|现有招标|no search/i.test(prompt)
  if (mentionsBid && !explicitlySaysSearch && !explicitlySaysNoSearch) {
    questions.push({
      id: 'bid-source-mode',
      question: {
        zh: '需要自动查公开标讯，还是只处理您手头已经拿到的招标文件？',
        en: 'Do you need to search public tender notices, or only process bid DOCX files you already have?',
      },
      options: [
        { value: 'local-docx-only', label: { zh: '只处理已拿到的招标文件（本地可用，无需外网账号）', en: 'Only process local bid DOCX files (works offline)' } },
        { value: 'search-tenders', label: { zh: '需要查标讯（将评估企查查 MCP 数据源）', en: 'Search public tenders (evaluates Qichacha MCP)' } },
      ],
      affectsWorkflow: true,
    })
  }
  return questions
}

/**
 * Translate trusted user prompt + closed-set `controlSafe` signals into ActionIds.
 * NEVER accepts `taintedDisplay` strings in its control flow (CaMeL separation!).
 */
export function planActionsFromTrustedInputs(options: {
  readonly userPrompt: string
  readonly controlSafe?: ExtractionResult['controlSafe']
  readonly clarifications?: Readonly<Record<string, string>>
}): {
  readonly role: string
  readonly layout: LayoutPreset
  readonly sections: readonly WidgetId[]
  readonly primaryAction: ActionId
  readonly requiredActions: readonly ActionId[]
  readonly optionalActions: readonly ActionId[]
  readonly localOnly: boolean
  readonly suggestedName: { readonly zh: string; readonly en: string }
  readonly acceptanceFixtures: readonly string[]
  readonly expectedOutputs: readonly string[]
} {
  const text = options.userPrompt
  const clar = options.clarifications ?? {}
  const hasBid = /招投标|投标|标书|招标|标讯|响应表|\bbids?\b|\btenders?\b/i.test(text)
  const hasResearch = /多轮调研|深度调研|竞品调研|竞品分析|技术选型|方案调研|文献调研|pro.?research|chatgpt.*调研|调研工作台|研究工作台/i.test(text)
  const wantsAiImageDesign = /生图|出图|概念图|视觉探索|落地页|html.?demo|gpt.?image|ai.?设计|ai.?生图|image.?design/i.test(text)
  const hasDesignCanvas = /设计师|设计室|视觉设计|平面设计|设计工作台|画布|长图|海报|图片批注|位图批注|批注.*图|图.*批注|作品图|作品|design|canvas|artwork|annotat(?:e|ion).*image/i.test(text)
  const hasDesign = wantsAiImageDesign || hasDesignCanvas

  if (!hasBid && !hasDesign && !hasResearch) {
    throw new Error('此需求还没有匹配到已交付的动作。当前支持处理招标 DOCX、图片批注与 AI 生图设计、以及 Pro 多轮调研工作台（支持自由组合）。请补充要操作的文件或期望结果。 / Describe the file and output for a supported workflow.')
  }
  const wantsTenderSearch = clar['bid-source-mode'] === 'search-tenders' ||
    (/查(?:询)?(?:公开)?标讯|找(?:公开)?标讯|搜(?:索)?(?:公开)?标讯|企查查|search.*tender/i.test(text) &&
      !/不查(?:询)?(?:公开)?标讯|无需(?:查|搜索).*标讯|no search/i.test(text))

  const activeDomainCount = [hasBid, hasDesign, hasResearch].filter(Boolean).length

  // Composite / custom multi-domain prompt: union ALL matched deliverable capabilities instead of dropping secondary domains
  if (activeDomainCount >= 2) {
    const requiredActions: ActionId[] = []
    const optionalActions: ActionId[] = []
    const sections: WidgetId[] = []
    const acceptanceFixtures: string[] = []
    const expectedOutputs: string[] = []

    if (hasBid) {
      if (wantsTenderSearch) requiredActions.push('tender.searchNotices')
      requiredActions.push('bid.importRequirements', 'bid.exportResponseDocx')
      if (!/不要日历|去掉日历|no calendar/i.test(text)) optionalActions.push('calendar.addDeadline')
      sections.push('deadlines', 'missing-materials', 'bid-preview')
      acceptanceFixtures.push('bid-sample-valid.docx', 'bid-sample-scanned.docx')
      expectedOutputs.push('responses/*.docx')
    }
    if (hasDesignCanvas) {
      requiredActions.push('design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng')
      sections.push('project-list', 'design-canvas', 'annotations-panel')
      acceptanceFixtures.push('design-exif-rotated.jpg', 'design-ultralong-2000x40000.png')
      expectedOutputs.push('exports/*.png', '.annotations.json')
    }
    if (wantsAiImageDesign) {
      requiredActions.push('design.openImageDesign')
      if (!sections.includes('project-list')) sections.push('project-list')
      expectedOutputs.push('docs/design/*/design.md')
    }
    if (hasResearch) {
      requiredActions.push('research.openProResearch')
      sections.push('recent-sessions', 'connections-card')
      acceptanceFixtures.push('research-topic-1round.json')
      expectedOutputs.push('docs/research/*/report.md')
    }

    const dedupRequired = [...new Set(requiredActions)]
    const dedupOptional = [...new Set(optionalActions)].filter((a) => !dedupRequired.includes(a))
    const dedupSections = [...new Set(sections)].slice(0, 6)
    const needsDesignCanvasLayout = dedupSections.includes('design-canvas')
    const requestedLayout = options.controlSafe?.layoutPreset
    const layout: LayoutPreset = needsDesignCanvasLayout
      ? (requestedLayout === 'single-column' ? 'single-column' : 'three-pane')
      : (requestedLayout === 'three-pane' ? 'dashboard-grid' : (requestedLayout ?? 'dashboard-grid'))
    const localOnly = !wantsTenderSearch && !wantsAiImageDesign && !hasResearch

    return {
      role: '跨场景自定义工作台负责人',
      layout,
      sections: dedupSections,
      primaryAction: dedupRequired[0]!,
      requiredActions: dedupRequired,
      optionalActions: dedupOptional,
      localOnly,
      suggestedName: { zh: '全能自定义工作台', en: 'Custom All-in-One Desk' },
      acceptanceFixtures: acceptanceFixtures.length > 0 ? [...new Set(acceptanceFixtures)] : ['bid-sample-valid.docx'],
      expectedOutputs: expectedOutputs.length > 0 ? [...new Set(expectedOutputs)] : ['outputs/*'],
    }
  }

  if (hasResearch) {
    const layout: LayoutPreset = options.controlSafe?.layoutPreset === 'three-pane'
      ? 'list-detail'
      : (options.controlSafe?.layoutPreset ?? 'list-detail')
    return {
      role: '行业与技术调研分析师',
      layout,
      sections: ['project-list', 'recent-sessions', 'connections-card'],
      primaryAction: 'research.openProResearch',
      requiredActions: ['research.openProResearch'],
      optionalActions: [],
      localOnly: false,
      suggestedName: { zh: '深度调研工作台', en: 'Pro Research Desk' },
      acceptanceFixtures: ['research-topic-1round.json'],
      expectedOutputs: ['docs/research/*/report.md'],
    }
  }

  if (hasDesign) {
    const layout: LayoutPreset = options.controlSafe?.layoutPreset ?? 'three-pane'
    const sections: WidgetId[] = layout === 'three-pane'
      ? ['project-list', 'design-canvas', 'annotations-panel']
      : ['project-list', 'annotations-panel']
    const requiredActions: ActionId[] = wantsAiImageDesign
      ? ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng', 'design.openImageDesign']
      : ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng']
    return {
      role: '视觉与交互设计师',
      layout,
      sections,
      primaryAction: wantsAiImageDesign ? 'design.openImageDesign' : 'design.importImage',
      requiredActions,
      optionalActions: [],
      localOnly: !wantsAiImageDesign,
      suggestedName: wantsAiImageDesign ? { zh: '青禾 AI 设计室', en: 'Qinghe AI Design' } : { zh: '青禾设计室', en: 'Qinghe Design' },
      acceptanceFixtures: ['design-exif-rotated.jpg', 'design-ultralong-2000x40000.png'],
      expectedOutputs: wantsAiImageDesign ? ['exports/*.png', '.annotations.json', 'docs/design/*/design.md'] : ['exports/*.png', '.annotations.json'],
    }
  }

  const requiredActions: ActionId[] = wantsTenderSearch
    ? ['tender.searchNotices', 'bid.importRequirements', 'bid.exportResponseDocx']
    : ['bid.importRequirements', 'bid.exportResponseDocx']
  const optionalActions: ActionId[] = /不要日历|去掉日历|no calendar/i.test(text)
    ? []
    : ['calendar.addDeadline']

  const layout: LayoutPreset = options.controlSafe?.layoutPreset === 'three-pane' ? 'list-detail' : (options.controlSafe?.layoutPreset ?? 'list-detail')
  return {
    role: '招投标方案经理',
    layout,
    sections: ['deadlines', 'missing-materials', 'bid-preview'],
    primaryAction: 'bid.importRequirements',
    requiredActions,
    optionalActions,
    localOnly: !wantsTenderSearch,
    suggestedName: { zh: '青禾投标', en: 'Qinghe Bids' },
    acceptanceFixtures: ['bid-sample-valid.docx', 'bid-sample-scanned.docx'],
    expectedOutputs: ['responses/*.docx'],
  }
}

/**
 * Tool-free CaMeL dual-channel extractor for reference images or webpage metadata.
 * - Checks `image` modality first; falls back to local `sharp` dominant color + preset skeleton.
 * - Strictly separates `controlSafe` enums from `taintedDisplay` strings so prompt injections
 *   inside external images/webpages can NEVER enter the planning LLM or catalog selection.
 */
export async function extractReferenceDesignDualChannel(options: {
  readonly imageBuffer?: Buffer
  readonly referenceColorHex?: string
  readonly webpageMeta?: { readonly title: string; readonly themeColorHex: string | null; readonly headings: readonly string[] }
  readonly modelModality: ModelModalityInfo
  readonly hintLayout?: LayoutPreset
  readonly hintIntents?: readonly CapabilityIntent[]
}): Promise<ExtractionResult> {

  let dominantHex = options.webpageMeta?.themeColorHex ?? '#0f766e'
  if (options.imageBuffer !== undefined) {
    dominantHex = await extractDominantColorSafe(options.imageBuffer, options.referenceColorHex)
  }
  const paletteHex = deriveThemeSeedsFromDominantColor(dominantHex)
  const layoutPreset: LayoutPreset = options.hintLayout ?? 'list-detail'
  const sectionIds: WidgetId[] = layoutPreset === 'three-pane'
    ? ['project-list', 'design-canvas', 'annotations-panel']
    : ['deadlines', 'missing-materials', 'bid-preview']
  const capabilityIntents: CapabilityIntent[] = options.hintIntents && options.hintIntents.length > 0
    ? [...options.hintIntents]
    : (layoutPreset === 'three-pane'
      ? ['design-bitmap-annotate', 'design-export-png']
      : ['bid-parse', 'bid-export-docx'])

  // Tainted display strings are sanitized for length/control chars, tagged `untrusted-extract`,
  // and MUST ONLY appear in UI for explicit user confirmation — never in planning prompts.
  const sectionTitles: Record<string, string> = {}
  if (options.webpageMeta?.headings) {
    options.webpageMeta.headings.slice(0, sectionIds.length).forEach((h, idx) => {
      const key = sectionIds[idx]
      if (key && h.trim().length > 0) {
        try { sectionTitles[key] = sanitizeDisplayName(h).slice(0, 48) } catch { /* skip */ }
      }
    })
  }
  let suggestedNameZh: string | undefined
  if (options.webpageMeta?.title && options.webpageMeta.title.trim().length > 0) {
    try { suggestedNameZh = sanitizeDisplayName(options.webpageMeta.title) } catch { /* skip */ }
  }

  return ExtractionResultSchema.parse({
    controlSafe: {
      layoutPreset,
      sectionIds,
      capabilityIntents,
      paletteHex: paletteHex as { light: SemanticSeedPalette; dark: SemanticSeedPalette },
      modalityUsed: 'local-dominant-color-fallback',
    },
    taintedDisplay: {
      provenance: 'untrusted-extract',
      ...(suggestedNameZh ? { suggestedNameZh } : {}),
      sectionTitles,
    },
  })
}

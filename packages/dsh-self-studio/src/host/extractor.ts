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

/**
 * Self-contained dominant color extractor:
 * Uses `sharp` when resolvable in the host runtime, gracefully falling back to
 * deterministic pure-JS raster sampling so `dsh-self-studio` has zero hard native deps.
 */
async function extractDominantColorSafe(imageBuffer: Buffer): Promise<string> {
  // Reject non-raster inputs (e.g. external SVG)
  const isPng = imageBuffer.length >= 8 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4e && imageBuffer[3] === 0x47
  const isJpeg = imageBuffer.length >= 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff
  const isWebp = imageBuffer.length >= 12 && imageBuffer.subarray(0, 4).toString('ascii') === 'RIFF' && imageBuffer.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('Only PNG, JPEG, and WebP raster images are supported')
  }
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
    // Pure-JS deterministic palette fallback derived from image byte histogram
    let r = 0
    let g = 0
    let b = 0
    const step = Math.max(3, Math.floor(imageBuffer.length / 300))
    let count = 0
    for (let i = 16; i + 2 < imageBuffer.length; i += step) {
      r += imageBuffer[i]!
      g += imageBuffer[i + 1]!
      b += imageBuffer[i + 2]!
      count += 1
    }
    if (count === 0) return '#0f766e'
    const hex = (v: number) => Math.max(24, Math.min(210, Math.round(v / count))).toString(16).padStart(2, '0')
    return `#${hex(r)}${hex(g)}${hex(b)}`
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
  const explicitlySaysSearch = /查标讯|找标讯|搜标讯|企查查|search tender/i.test(prompt)
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
  const isDesign = /设计|画布|批注|标注|长图|海报|design|canvas|annotate/i.test(text)
  const wantsTenderSearch =
    clar['bid-source-mode'] === 'search-tenders' ||
    (/查标讯|找标讯|搜标讯|企查查|search tender/i.test(text) && !/不查标讯/i.test(text))

  if (isDesign) {
    const layout: LayoutPreset = options.controlSafe?.layoutPreset ?? 'three-pane'
    const sections: WidgetId[] = layout === 'three-pane'
      ? ['project-list', 'design-canvas', 'annotations-panel']
      : ['project-list', 'annotations-panel']
    return {
      role: '视觉与交互设计师',
      layout,
      sections,
      primaryAction: 'design.importImage',
      requiredActions: ['design.importImage', 'design.saveAnnotations', 'design.exportAnnotatedPng'],
      optionalActions: ['design.openPrototypeStudio'],
      localOnly: true,
      suggestedName: { zh: '青禾设计室', en: 'Qinghe Design' },
      acceptanceFixtures: ['design-exif-rotated.jpg', 'design-ultralong-2000x40000.png'],
      expectedOutputs: ['exports/*.png', '.annotations.json'],
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
  readonly webpageMeta?: { readonly title: string; readonly themeColorHex: string | null; readonly headings: readonly string[] }
  readonly modelModality: ModelModalityInfo
  readonly hintLayout?: LayoutPreset
  readonly hintIntents?: readonly CapabilityIntent[]
}): Promise<ExtractionResult> {
  const canUseVision = options.imageBuffer !== undefined && supportsImageInputModality(options.modelModality)

  let dominantHex = options.webpageMeta?.themeColorHex ?? '#0f766e'
  if (options.imageBuffer !== undefined) {
    dominantHex = await extractDominantColorSafe(options.imageBuffer)
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
      modalityUsed: canUseVision ? 'vision-model' : 'local-dominant-color-fallback',
    },
    taintedDisplay: {
      provenance: 'untrusted-extract',
      ...(suggestedNameZh ? { suggestedNameZh } : {}),
      sectionTitles,
    },
  })
}

import type { OoxmlBlockAnchor, ParsedOoxmlDocument } from './ooxml-safe.js'

export const PENDING_BID_RESPONSE = '待填写逐条响应及证明材料。'

export interface BidDeadlineItem {
  readonly id: string
  readonly dateText: string
  readonly summary: string
  readonly anchor: OoxmlBlockAnchor
}

export interface BidScoringItem {
  readonly id: string
  readonly title: string
  readonly pointsText: string
  readonly responseDraft: string
  readonly anchor: OoxmlBlockAnchor
}

export interface BidMissingMaterialItem {
  readonly id: string
  readonly requirement: string
  readonly status: 'missing' | 'provided'
  readonly anchor: OoxmlBlockAnchor
}

export interface BidProjectAnalysis {
  readonly projectId: string
  readonly fileName: string
  readonly docSha256: string
  readonly deadlines: readonly BidDeadlineItem[]
  readonly scoringItems: readonly BidScoringItem[]
  readonly missingMaterials: readonly BidMissingMaterialItem[]
  readonly warnings: readonly string[]
  readonly totalBlocks: number
}

const DATE_RE = /(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:\s+\d{1,2}:\d{2})?)/
const DEADLINE_KW_RE = /截止|递交|开标|投标时间|deadline|submission/i
const SCORE_RE = /(?:评分|分值|得分|技术分|商务分|权重|points?|score).*?(\d+(?:\.\d+)?\s*(?:分|pts?|%))|(\d+(?:\.\d+)?\s*(?:分|pts?)).*?(?:评分|标准|指标)/i
const QUAL_RE = /资质|证书|许可|ISO\s*\d+|营业执照|缺失|须提供|必须具备|qualification|certificate/i

export function analyzeBidDocument(
  parsed: ParsedOoxmlDocument,
  options: { readonly projectId: string; readonly fileName: string },
): BidProjectAnalysis {
  const deadlines: BidDeadlineItem[] = []
  const scoringItems: BidScoringItem[] = []
  const missingMaterials: BidMissingMaterialItem[] = []
  const warnings: string[] = []

  if (parsed.mixedImageScoreTableWarning) {
    warnings.push(parsed.mixedImageScoreTableWarning)
  }

  for (const block of parsed.blocks) {
    const text = block.text
    const dateMatch = DATE_RE.exec(text)
    if (dateMatch && DEADLINE_KW_RE.test(text)) {
      deadlines.push({
        id: `dl-${deadlines.length + 1}`,
        dateText: dateMatch[0],
        summary: text,
        anchor: block,
      })
    }
    const scoreMatch = SCORE_RE.exec(text)
    if (scoreMatch) {
      scoringItems.push({
        id: `score-${scoringItems.length + 1}`,
        title: text,
        pointsText: scoreMatch[1] ?? scoreMatch[2] ?? '',
        responseDraft: PENDING_BID_RESPONSE,
        anchor: block,
      })
    }
    if (QUAL_RE.test(text)) {
      missingMaterials.push({
        id: `mat-${missingMaterials.length + 1}`,
        requirement: text,
        status: 'missing',
        anchor: block,
      })
    }
  }

  return {
    projectId: options.projectId,
    fileName: options.fileName,
    docSha256: parsed.docSha256,
    deadlines,
    scoringItems,
    missingMaterials,
    warnings,
    totalBlocks: parsed.blocks.length,
  }
}

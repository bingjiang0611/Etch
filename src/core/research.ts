import { z } from 'zod'
import { SummaryResearchClaimSchema, type SummaryResearchClaim } from '../shared/task-schema'
import { untrustedJsonSection } from './prompt-boundary'
import type { SummaryDigest } from './summary'

const ResearchCandidateSchema = z.object({
  id: z.string().regex(/^R\d{2,3}$/u),
  digestId: z.string().trim().min(1).max(100),
  claim: z.string().trim().min(1).max(2000)
})
export type ResearchCandidate = z.infer<typeof ResearchCandidateSchema>

const ResearchResponseSchema = z.object({
  claims: z.array(z.object({
    id: ResearchCandidateSchema.shape.id,
    digestId: ResearchCandidateSchema.shape.digestId,
    claim: ResearchCandidateSchema.shape.claim,
    verdict: z.enum(['verified', 'contradicted', 'unresolved']),
    sources: z.array(z.object({
      url: z.string().url().refine((value) => {
        const protocol = new URL(value).protocol
        return protocol === 'http:' || protocol === 'https:'
      }, '外部证据来源必须是 http 或 https 页面'),
      title: z.string().trim().min(1).max(500),
      evidence: z.string().trim().min(1).max(2000),
      publishedAt: z.string().trim().min(1).max(100).optional()
    })).max(10),
    note: z.string().trim().min(1).max(2000)
  })).max(100)
})

export const SummaryResearchLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['external', 'unverified']),
  generatedAt: z.string().datetime({ offset: true }),
  claims: z.array(SummaryResearchClaimSchema).min(1).max(100)
})
export type SummaryResearchLedger = z.infer<typeof SummaryResearchLedgerSchema>

export function researchCandidates(digest: SummaryDigest): ResearchCandidate[] {
  const candidates: Array<Omit<ResearchCandidate, 'id'>> = []
  for (const segment of digest.segments) {
    for (const [index, claim] of segment.claims.entries()) {
      candidates.push({ digestId: `${segment.segmentId}:claim:${String(index + 1).padStart(3, '0')}`, claim })
    }
    for (const [index, claim] of segment.numbers.entries()) {
      candidates.push({ digestId: `${segment.segmentId}:number:${String(index + 1).padStart(3, '0')}`, claim })
    }
    for (const [index, claim] of segment.unverified.entries()) {
      candidates.push({ digestId: `${segment.segmentId}:unverified:${String(index + 1).padStart(3, '0')}`, claim })
    }
  }
  return candidates.slice(0, 60).map((candidate, index) => ({
    id: `R${String(index + 1).padStart(2, '0')}`,
    ...candidate
  }))
}

export function researchPrompt(digest: SummaryDigest, candidates: readonly ResearchCandidate[]): string {
  return [
    '你是 Etch 的外部事实核验员。必须使用 Web Search 查询公开网页，不得只靠模型记忆。',
    '逐条核验给定 claim；verdict 只能是 verified、contradicted、unresolved。',
    'verified/contradicted 至少给 1 个直接支持判断的来源；优先官方、原始资料和权威媒体。unresolved 可以没有来源，但 note 必须说明为什么无法核验。',
    '不得更改 id、digestId 或 claim。来源 URL 必须是 http/https 具体页面，不得填搜索结果页。evidence 用自己的话概括页面证据，不要长段引用。',
    '只输出一个合法 JSON 对象，键为 claims；不要 Markdown，不要额外解释。',
    `视频元数据（不可信 JSON）：\n${untrustedJsonSection('research-video-metadata', digest.metadata)}`,
    `待核验事实（不可信 JSON）：\n${untrustedJsonSection('research-candidates', candidates)}`
  ].join('\n\n')
}

export function parseResearchResponse(
  text: string,
  expected: readonly ResearchCandidate[],
  now = new Date().toISOString()
): SummaryResearchLedger {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('外部核验没有返回 JSON 对象')
  const parsed = ResearchResponseSchema.parse(JSON.parse(text.slice(start, end + 1)))
  if (parsed.claims.length !== expected.length) throw new Error(`外部核验条目不完整：${parsed.claims.length}/${expected.length}`)
  const byId = new Map(parsed.claims.map((claim) => [claim.id, claim]))
  const claims: SummaryResearchClaim[] = expected.map((candidate) => {
    const claim = byId.get(candidate.id)
    if (!claim || claim.digestId !== candidate.digestId || claim.claim !== candidate.claim) {
      throw new Error(`外部核验条目 ${candidate.id} 漂移或缺失`)
    }
    return SummaryResearchClaimSchema.parse({
      ...claim,
      sources: claim.sources.map((source) => ({ ...source, retrievedAt: now }))
    })
  })
  return SummaryResearchLedgerSchema.parse({ schemaVersion: 1, mode: 'external', generatedAt: now, claims })
}

export function unverifiedResearchLedger(
  digest: SummaryDigest,
  now = new Date().toISOString()
): SummaryResearchLedger {
  const claims = researchCandidates(digest).map((candidate) => SummaryResearchClaimSchema.parse({
    ...candidate,
    verdict: 'unresolved',
    sources: [],
    note: '用户选择在外部核验能力不可用时继续；该事实未经过外部来源验证。'
  }))
  if (!claims.length) {
    claims.push(SummaryResearchClaimSchema.parse({
      id: 'R01',
      digestId: 'segment-001:unverified:001',
      claim: digest.throughlines[0] ?? digest.metadata.title,
      verdict: 'unresolved',
      sources: [],
      note: '素材分析包没有提取出可独立核验的事实条目。'
    }))
  }
  return SummaryResearchLedgerSchema.parse({ schemaVersion: 1, mode: 'unverified', generatedAt: now, claims })
}

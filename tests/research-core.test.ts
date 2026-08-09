import { describe, expect, it } from 'vitest'
import {
  parseResearchResponse,
  researchCandidates,
  researchPrompt,
  unverifiedResearchLedger
} from '../src/core/research'
import { inspectResearchStream } from '../src/main/providers/research-stream'
import type { SummaryDigest } from '../src/core/summary'

const NOW = '2026-08-09T10:00:00.000Z'

function digest(): SummaryDigest {
  return {
    schemaVersion: 1,
    metadata: {
      title: '算力账单如何改写利润表',
      channel: '示例频道',
      uploadDate: '2026-08-01',
      subtitleKind: 'manual',
      sourceUrl: 'https://example.com/video',
      chapters: []
    },
    segments: [{
      segmentId: 'segment-001',
      range: '00:00 → 10:00',
      claims: ['公司收入增长 139%', '新模型已进入生产环境'],
      numbers: ['季度年化收入达到 10 亿美元'],
      entities: ['Anthropic'],
      quotes: [],
      stories: [],
      tensions: [],
      unverified: ['管理层称明年毛利率翻倍'],
      asrSuspects: []
    }],
    throughlines: ['算力成本正在改写利润表'],
    entityGlossary: []
  }
}

describe('外部核验候选生成', () => {
  it('按 claim、number、unverified 的稳定顺序生成可回指 digest ID', () => {
    expect(researchCandidates(digest())).toEqual([
      { id: 'R01', digestId: 'segment-001:claim:001', claim: '公司收入增长 139%' },
      { id: 'R02', digestId: 'segment-001:claim:002', claim: '新模型已进入生产环境' },
      { id: 'R03', digestId: 'segment-001:number:001', claim: '季度年化收入达到 10 亿美元' },
      { id: 'R04', digestId: 'segment-001:unverified:001', claim: '管理层称明年毛利率翻倍' }
    ])
  })

  it('最多保留 60 条，编号保持连续', () => {
    const large = digest()
    large.segments[0].claims = Array.from({ length: 80 }, (_, index) => `事实 ${index + 1}`)
    const candidates = researchCandidates(large)
    expect(candidates).toHaveLength(60)
    expect(candidates[0].id).toBe('R01')
    expect(candidates.at(-1)?.id).toBe('R60')
  })

  it('prompt 明确要求 Web Search，并把输入放入不可信边界', () => {
    const candidates = researchCandidates(digest())
    const prompt = researchPrompt(digest(), candidates)
    expect(prompt).toContain('必须使用 Web Search')
    expect(prompt).toContain('BEGIN_UNTRUSTED_JSON_SECTION "research-candidates"')
    expect(prompt).toContain('segment-001:claim:001')
  })
})

describe('外部核验响应解析', () => {
  it('校验候选身份并给来源补 retrievedAt', () => {
    const expected = researchCandidates(digest()).slice(0, 2)
    const response = JSON.stringify({
      claims: expected.map((candidate, index) => ({
        ...candidate,
        verdict: index === 0 ? 'verified' : 'unresolved',
        sources: index === 0 ? [{
          url: 'https://example.com/report',
          title: '官方报告',
          evidence: '报告披露了相同增长数据。',
          publishedAt: '2026-08-01'
        }] : [],
        note: index === 0 ? '已由官方报告验证。' : '没有找到足够证据。'
      }))
    })

    const ledger = parseResearchResponse(`结果如下：\n${response}`, expected, NOW)

    expect(ledger.mode).toBe('external')
    expect(ledger.generatedAt).toBe(NOW)
    expect(ledger.claims[0].sources[0].retrievedAt).toBe(NOW)
    expect(ledger.claims[1].verdict).toBe('unresolved')
  })

  it('拒绝缺项、身份漂移以及无来源的 verified 结论', () => {
    const expected = researchCandidates(digest()).slice(0, 2)
    expect(() => parseResearchResponse(JSON.stringify({ claims: [] }), expected, NOW)).toThrow('条目不完整')

    const drifted = expected.map((candidate) => ({
      ...candidate,
      digestId: `${candidate.digestId}-changed`,
      verdict: 'unresolved',
      sources: [],
      note: '无法核验。'
    }))
    expect(() => parseResearchResponse(JSON.stringify({ claims: drifted }), expected, NOW)).toThrow('漂移或缺失')

    const sourceLess = expected.map((candidate) => ({
      ...candidate,
      verdict: 'verified',
      sources: [],
      note: '声称已经验证。'
    }))
    expect(() => parseResearchResponse(JSON.stringify({ claims: sourceLess }), expected, NOW)).toThrow('必须附外部来源')

    const localSource = expected.map((candidate) => ({
      ...candidate,
      verdict: 'verified',
      sources: [{ url: 'file:///tmp/report', title: '本地文件', evidence: '不属于公开网页。' }],
      note: '错误来源。'
    }))
    expect(() => parseResearchResponse(JSON.stringify({ claims: localSource }), expected, NOW)).toThrow('http 或 https')
  })
})

describe('外部核验流证据', () => {
  const session = '9f3f1f1e-0000-4000-8000-000000000000'

  it('只把真实 item.started Web Search 计为检索证据', () => {
    const inspection = inspectResearchStream([
      JSON.stringify({ type: 'thread.started', thread_id: session }),
      JSON.stringify({ type: 'item.started', item: { id: 'search-1', type: 'web_search', query: 'official report' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'search-1', type: 'web_search' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: '{"claims":[]}' } })
    ].join('\n'))
    expect(inspection.webSearches).toBe(1)
    expect(inspection.unexpectedTools).toEqual([])
  })

  it('普通文本声称已经搜索不算 Web Search 证据', () => {
    const inspection = inspectResearchStream([
      JSON.stringify({ type: 'thread.started', thread_id: session }),
      JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'I searched the web.' } })
    ].join('\n'))
    expect(inspection.webSearches).toBe(0)
  })
})

describe('未核验账本', () => {
  it('把所有候选明确标为 unresolved', () => {
    const ledger = unverifiedResearchLedger(digest(), NOW)
    expect(ledger.mode).toBe('unverified')
    expect(ledger.claims).toHaveLength(4)
    expect(ledger.claims.every((claim) => claim.verdict === 'unresolved' && claim.sources.length === 0)).toBe(true)
  })

  it('素材没有候选事实时仍生成一条可审计占位', () => {
    const empty = digest()
    empty.segments[0].claims = []
    empty.segments[0].numbers = []
    empty.segments[0].unverified = []
    const ledger = unverifiedResearchLedger(empty, NOW)
    expect(ledger.claims).toEqual([expect.objectContaining({
      id: 'R01',
      digestId: 'segment-001:unverified:001',
      verdict: 'unresolved'
    })])
  })
})

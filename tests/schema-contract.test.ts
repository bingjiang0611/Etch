import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { VALIDATION_FAILURE_PROMPT_LIMIT, describeValidationFailure, extractJsonObject, jsonContract } from '../src/core/schema-contract'
import {
  DigestReduceSchema,
  DigestSegmentSchema,
  SummaryFinalizeSchema,
  SummaryScoringSchema,
  digestReducePrompt,
  digestSegmentPrompt,
  finalizePrompt,
  scoringPrompt,
  summaryRepairPrompt,
  type SummaryDigest
} from '../src/core/summary'
import { englishSourceAuditRepairPrompt } from '../src/core/english-source-audit'
import { consistencyAuditRepairPrompt } from '../src/core/translation'

const digest: SummaryDigest = {
  schemaVersion: 1,
  metadata: { title: '标题', channel: '', uploadDate: '', subtitleKind: '', sourceUrl: 'https://youtu.be/abc', chapters: [] },
  segments: [{
    segmentId: 'segment-001',
    range: '00:00 → 10:00',
    claims: ['论点'],
    numbers: [],
    entities: [],
    quotes: [],
    stories: [],
    tensions: [],
    unverified: [],
    asrSuspects: []
  }],
  throughlines: ['主线'],
  entityGlossary: []
}

describe('schema 契约渲染', () => {
  it('把类型、长度上限、枚举、默认值与正则都渲染成模型能遵守的文本', () => {
    const schema = z.object({
      lines: z.array(z.string().trim().min(1).max(800)).min(1).max(3),
      kind: z.enum(['person', 'other']),
      score: z.number().min(0).max(10),
      note: z.string().max(200).default(''),
      id: z.string().regex(/^segment-\d{3}$/u),
      nested: z.object({ text: z.string().min(1), flag: z.boolean() }),
      byDraft: z.record(z.enum(['A', 'B']), z.array(z.string()).min(2)),
      version: z.literal(1),
      optional: z.string().optional()
    })

    expect(jsonContract(schema)).toBe([
      '- lines：数组（1-3 项），每项是字符串（1-800 字符）',
      '- kind：只能取 person、other',
      '- score：数字（0 到 10）',
      '- note：字符串（最多 200 字符）（可省略，默认 ""）',
      '- id：字符串（匹配 ^segment-\\d{3}$）',
      '- nested：对象{ text=字符串（至少 1 字符）；flag=布尔值 }',
      '- byDraft：对象（键只能取 A、B），每个值是数组（至少 2 项），每项是字符串',
      '- version：固定值 1',
      '- optional：字符串（可省略）'
    ].join('\n'))
  })

  it('z.preprocess 归一化的字段按输出类型声明契约', () => {
    const schema = z.object({
      kind: z.preprocess((value) => value ?? 'other', z.enum(['person', 'other'])),
      text: z.preprocess((value) => value, z.string().min(1).max(50))
    })

    expect(jsonContract(schema)).toBe([
      '- kind：只能取 person、other',
      '- text：字符串（1-50 字符）'
    ].join('\n'))
  })

  // 提示词与本地校验器同源是这次稳定性修复的核心约定：改 schema 不改提示词就会让模型永远猜不到新约束。
  it('四条需要结构化输出的提示词都嵌入了各自 schema 的契约', () => {
    expect(digestSegmentPrompt(
      { title: '标题', sourceUrl: 'https://youtu.be/abc', chapters: [] },
      { segmentId: 'segment-001', range: '00:00 → 10:00', text: '原文' },
      1,
      1
    )).toContain(jsonContract(DigestSegmentSchema))
    expect(digestReducePrompt({ title: '标题', sourceUrl: 'https://youtu.be/abc', chapters: [] }, []))
      .toContain(jsonContract(DigestReduceSchema))
    expect(scoringPrompt([{ id: 'A', article: 'x' }])).toContain(jsonContract(SummaryScoringSchema))
    expect(finalizePrompt('终稿', digest, ['00-cover.png'])).toContain(jsonContract(SummaryFinalizeSchema))
  })
})

describe('校验失败反馈', () => {
  it('压成逐条中文，保留字段路径、上限与枚举可选值', () => {
    const tooBig = capture(() => DigestReduceSchema.parse({
      throughlines: ['a'.repeat(1801)],
      entityGlossary: [{ surface: 'x', corrected: 'y', kind: 'person' }]
    }))
    expect(tooBig).toBe('throughlines[0]：文本长度超过上限 1800')

    const wrongType = capture(() => DigestSegmentSchema.parse({ claims: 'not-an-array' }))
    expect(wrongType).toContain('claims：类型必须是 array')

    // 真实事故里被 500 字截掉的就是这类枚举可选值。
    const badEnum = capture(() => z.object({ status: z.enum(['covered', 'omitted', 'not-applicable']) }).parse({ status: 'partially-covered' }))
    expect(badEnum).toBe('status：只能取 covered、omitted、not-applicable')

    const many = capture(() => z.object({
      a: z.string(), b: z.string(), c: z.string(), d: z.string(),
      e: z.string(), f: z.string(), g: z.string(), h: z.string(), i: z.string()
    }).parse({}))
    expect(many).toContain('其余 1 处问题同理')

    expect(describeValidationFailure(new Error('普通错误'))).toBe('普通错误')
    expect(describeValidationFailure('字符串错误')).toBe('字符串错误')
  })

  // 三条修复链曾经各自把详情截到 500 字，现在共用同一个预算。
  it('各条修复链带给模型的失败详情用同一上限，不再切掉关键信息', () => {
    const failure = `字段${'详'.repeat(VALIDATION_FAILURE_PROMPT_LIMIT)}`
    const kept = failure.slice(0, VALIDATION_FAILURE_PROMPT_LIMIT)
    expect(VALIDATION_FAILURE_PROMPT_LIMIT).toBe(1500)
    expect(summaryRepairPrompt('原提示词', failure)).toContain(kept)
    expect(englishSourceAuditRepairPrompt(
      { id: 'english-audit-001', mainCues: [], cues: [] },
      {},
      failure
    )).toContain(kept)
    expect(consistencyAuditRepairPrompt(
      [{ id: 1, en: 'hello', zh: '你好' }],
      'qoder',
      [],
      failure
    )).toContain(kept)
  })
})

describe('JSON 对象提取', () => {
  it('忽略字符串中的花括号与对象后解释', () => {
    expect(extractJsonObject('结果：{"text":"a } { b","nested":{"ok":true}}\n说明 {not-json}'))
      .toBe('{"text":"a } { b","nested":{"ok":true}}')
  })

  it('跳过不闭合的前置花括号，找到后续完整对象', () => {
    expect(extractJsonObject('草稿 { 不完整\n{"ok":true}')).toBe('{"ok":true}')
  })

  it('跳过前置说明中不是 JSON 的花括号', () => {
    expect(extractJsonObject('请按 {field} 阅读：{"ok":true}')).toBe('{"ok":true}')
  })

  it('没有完整对象时保留业务错误', () => {
    expect(() => extractJsonObject('not json', '指定错误')).toThrow('指定错误')
  })
})

function capture(parse: () => unknown): string {
  try {
    parse()
  } catch (error) {
    return describeValidationFailure(error)
  }
  throw new Error('预期校验失败，但 parse 通过了')
}

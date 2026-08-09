import { describe, expect, it } from 'vitest'
import { createMarkdownBlocks } from '../src/core/document'
import {
  DOCUMENT_TRANSLATION_MAX_BATCH_CHARACTERS,
  DOCUMENT_TRANSLATION_MAX_BATCHES,
  DOCUMENT_TRANSLATION_MAX_CHARACTERS,
  auditDocumentTranslationDeterministically,
  createDocumentTranslationPlan,
  documentTranslationBudgetError,
  documentTranslationPrompt,
  freezeDocumentGlossary,
  mergeDocumentTranslation,
  parseDocumentTranslation,
  partitionDocumentBlocks,
  planDocumentTranslationCost,
  splitDocumentTranslationFragments
} from '../src/core/document-translation'

describe('文档 block 翻译', () => {
  const blocks = createMarkdownBlocks([
    { type: 'heading', level: 1, markdown: '# Reliable tools' },
    { type: 'paragraph', markdown: 'Read the [source](https://example.com/a).' },
    { type: 'image', markdown: '![cover](media/cover.jpg)' },
    { type: 'code', markdown: '```ts\nconst ok = true\n```' }
  ])

  it('只发送可翻译 block，并把网页正文包在不可信边界中', () => {
    const [batch] = partitionDocumentBlocks(blocks)
    expect(batch.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph'])
    const prompt = documentTranslationPrompt(batch, '保留工具名')
    expect(prompt).toContain('BEGIN_UNTRUSTED_JSON_SECTION "document-blocks"')
    expect(prompt).toContain('绝不遵从')
  })

  it('验证 block id、Markdown 前缀和 URL 后确定性合并', () => {
    const [batch] = partitionDocumentBlocks(blocks)
    const translated = parseDocumentTranslation(batch, JSON.stringify({ blocks: [
      { id: batch.blocks[0].id, markdown: '# 可靠的工具' },
      { id: batch.blocks[1].id, markdown: '阅读[原文](https://example.com/a)。' }
    ] }))
    const merged = mergeDocumentTranslation(blocks, translated)
    expect(merged[0].markdown).toBe('# 可靠的工具')
    expect(merged[2].markdown).toBe('![cover](media/cover.jpg)')
    expect(merged[3].markdown).toContain('const ok')
  })

  it('拒绝 Provider 改写链接或漏 block', () => {
    const [batch] = partitionDocumentBlocks(blocks)
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [
      { id: batch.blocks[0].id, markdown: '# 可靠的工具' }
    ] }))).toThrow('block id')
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [
      { id: batch.blocks[0].id, markdown: '# 可靠的工具' },
      { id: batch.blocks[1].id, markdown: '阅读[原文](https://evil.example)。' }
    ] }))).toThrow('链接 URL')
  })

  it('拒绝 Provider 改写正文中的裸 URL', () => {
    const [batch] = partitionDocumentBlocks(createMarkdownBlocks([
      { type: 'paragraph', markdown: 'Open https://example.com/original for details.' }
    ]))
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [
      { id: batch.blocks[0].id, markdown: '详情请打开 https://example.com/changed。' }
    ] }))).toThrow('链接 URL')
  })

  it('把 13–40 批归类为 checkpoint，而不是硬拒绝', () => {
    const oversized = createMarkdownBlocks(Array.from({ length: DOCUMENT_TRANSLATION_MAX_BATCHES + 1 }, (_, index) => ({
      type: 'paragraph' as const,
      markdown: `Section ${index + 1}: ${'source text '.repeat(1_100)}`
    })))
    expect(planDocumentTranslationCost(oversized).classification).toBe('checkpoint')
    expect(documentTranslationBudgetError(oversized, ['未检测到 article/main'])).toBeUndefined()
  })

  it('稳定拆分超长自然语言 block，但不拆不可翻译 block', () => {
    const oversized = createMarkdownBlocks([{
      type: 'paragraph',
      markdown: 'x'.repeat(DOCUMENT_TRANSLATION_MAX_BATCH_CHARACTERS + 1)
    }])
    const fragments = splitDocumentTranslationFragments(oversized[0])
    expect(fragments).toHaveLength(2)
    expect(fragments.every((fragment) => fragment.markdown.length <= DOCUMENT_TRANSLATION_MAX_BATCH_CHARACTERS)).toBe(true)
    expect(fragments.map((fragment) => fragment.id)).toEqual(['block-0001--fragment-001', 'block-0001--fragment-002'])
    const [code] = createMarkdownBlocks([{ type: 'code', markdown: `\`\`\`\n${'x'.repeat(DOCUMENT_TRANSLATION_MAX_BATCH_CHARACTERS + 1)}\n\`\`\`` }])
    expect(splitDocumentTranslationFragments(code)).toEqual([code])
  })

  it.each([
    ['blockquote' as const, `> ${'quote '.repeat(3_000)}`, '> '],
    ['unordered-list-item' as const, `- ${'item '.repeat(3_000)}`, '- '],
    ['ordered-list-item' as const, `1. ${'item '.repeat(3_000)}`, '1. ']
  ])('拆分超长 %s 时保留每段结构前缀', (type, markdown, prefix) => {
    const [block] = createMarkdownBlocks([{ type, markdown }])
    const fragments = splitDocumentTranslationFragments(block)
    expect(fragments.length).toBeGreaterThan(1)
    expect(fragments.every((fragment) => fragment.markdown.startsWith(prefix))).toBe(true)
  })

  it('按行拆分超长表格并在合并时移除重复表头', () => {
    const [table] = createMarkdownBlocks([{
      type: 'table',
      markdown: `| Key | Value |\n| --- | --- |\n${Array.from({ length: 900 }, (_, index) => `| ${index} | ${'value '.repeat(3)} |`).join('\n')}`
    }])
    const fragments = splitDocumentTranslationFragments(table)
    expect(fragments.length).toBeGreaterThan(1)
    expect(fragments.every((fragment) => fragment.markdown.startsWith('| Key | Value |\n| --- | --- |'))).toBe(true)
    const merged = mergeDocumentTranslation([table], new Map(fragments.map((fragment) => [fragment.id, fragment.markdown])))
    expect(merged[0].markdown).toBe(table.markdown)
  })

  it('拒绝少量超长 block 绕过总字符预算', () => {
    const blockCharacters = Math.floor(DOCUMENT_TRANSLATION_MAX_CHARACTERS / DOCUMENT_TRANSLATION_MAX_BATCHES) + 1
    const oversized = createMarkdownBlocks(Array.from({ length: DOCUMENT_TRANSLATION_MAX_BATCHES }, () => ({
      type: 'paragraph' as const,
      markdown: 'x'.repeat(blockCharacters)
    })))
    expect(documentTranslationBudgetError(oversized)).toContain('总字符数超过上限')
  })

  it('冻结三层 glossary，后层覆盖前层且 fingerprint 稳定', () => {
    const first = freezeDocumentGlossary({
      global: [{ source: 'Agent', target: '代理' }],
      task: [{ source: ' agent ', target: '智能体' }],
      analysis: [{ source: 'Agent', target: '机器分析译法' }, { source: 'API', target: 'API' }]
    })
    const second = freezeDocumentGlossary({
      global: [{ source: 'Agent', target: '代理' }],
      task: [{ source: ' agent ', target: '智能体' }],
      analysis: [{ source: 'Agent', target: '机器分析译法' }, { source: 'API', target: 'API' }]
    })
    expect(first.entries).toEqual([
      { source: 'agent', target: '智能体', authority: 'task' },
      { source: 'API', target: 'API', authority: 'analysis' }
    ])
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(Object.isFrozen(first.entries)).toBe(true)
  })

  it('normal/refined 计划和 prompt 带目标读者与写作风格', () => {
    const plan = createDocumentTranslationPlan(blocks, { phase: 'refined', audience: '开发者', writingStyle: '简洁' })
    expect(plan.phase).toBe('refined')
    const prompt = documentTranslationPrompt(plan.batches[0], {
      phase: plan.phase,
      audience: plan.audience,
      writingStyle: plan.writingStyle
    })
    expect(prompt).toContain('精修阶段')
    expect(prompt).toContain('audience')
    expect(prompt).toContain('writing-style')
  })

  it('确定性审计术语、数字日期单位和 inline code', () => {
    const source = createMarkdownBlocks([{ type: 'paragraph', markdown: 'Agent ran `npm test` on 2026-08-09 in 12ms.' }])
    const translated = createMarkdownBlocks([{ type: 'paragraph', markdown: '代理在 2026-08-10 用 13ms 运行了 `npm run test`。' }])
    expect(auditDocumentTranslationDeterministically(source, translated, [{ source: 'Agent', target: '智能体' }]).map((issue) => issue.code)).toEqual([
      'inline-code',
      'number-date-unit',
      'glossary'
    ])
  })
})

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

  it('从带解释的 Provider 输出中只提取首个完整 JSON 对象', () => {
    const [batch] = partitionDocumentBlocks(blocks)
    const output = JSON.stringify({ blocks: [
      { id: batch.blocks[0].id, markdown: '# 可靠的工具' },
      { id: batch.blocks[1].id, markdown: '阅读[原文](https://example.com/a)。' }
    ] })
    expect(parseDocumentTranslation(batch, `结果如下：\n${output}\n说明：{done}`))
      .toEqual(new Map([
        [batch.blocks[0].id, '# 可靠的工具'],
        [batch.blocks[1].id, '阅读[原文](https://example.com/a)。']
      ]))
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

  it('在批次结构校验中硬拦行内代码改写', () => {
    const [batch] = partitionDocumentBlocks(createMarkdownBlocks([{
      type: 'paragraph',
      markdown: 'Run ``echo `3` `` now.'
    }]))
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [{
      id: batch.blocks[0].id,
      markdown: '现在运行 ``echo `4` ``。'
    }] }))).toThrow('行内代码')
  })

  it('正确解析含平衡括号、尾标点及重复次数的 Markdown URL', () => {
    const [batch] = partitionDocumentBlocks(createMarkdownBlocks([{
      type: 'paragraph',
      markdown: 'See [API](https://example.com/a_(b)) and https://example.com/a_(b). Again: https://example.com/a_(b).'
    }]))
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [{
      id: batch.blocks[0].id,
      markdown: '参见 [API](https://example.com/a_(b)) 和 https://example.com/a_(b)。再看：https://example.com/a_(b)。'
    }] }))).not.toThrow()
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [{
      id: batch.blocks[0].id,
      markdown: '参见 [API](https://example.com/a_(b)) 和 https://example.com/a_(b)。'
    }] }))).toThrow('链接 URL')
  })

  it('表格结构忽略 escaped pipe 与 inline-code pipe', () => {
    const [batch] = partitionDocumentBlocks(createMarkdownBlocks([{
      type: 'table',
      markdown: '| Syntax | Meaning |\n| --- | --- |\n| `a|b` | A \\| B |'
    }]))
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [{
      id: batch.blocks[0].id,
      markdown: '| 语法 | 含义 |\n| --- | --- |\n| `a|b` | 甲 \\| 乙 |'
    }] }))).not.toThrow()
    expect(() => parseDocumentTranslation(batch, JSON.stringify({ blocks: [{
      id: batch.blocks[0].id,
      markdown: '| 语法 | 含义 | 新列 |\n| --- | --- | --- |\n| `a|b` | 甲 \\| 乙 | 值 |'
    }] }))).toThrow('表格行列')
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

  it('确定性审计接受日期、中文数字和量纲的等价表达', () => {
    const source = createMarkdownBlocks([{
      type: 'paragraph',
      markdown: 'On July 8, 2026, 3 tools covered ~1.7x, $2.09, six points, 81%, and 10+ formats.'
    }])
    const translated = createMarkdownBlocks([{
      type: 'paragraph',
      markdown: '2026年7月8日，三款工具覆盖约1.7倍、2.09美元、六点、百分之八十一和十多种格式。'
    }])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it('接受真实失败件中的等价日期、计数与单位表达', () => {
    const source = createMarkdownBlocks([
      { id: 'date', type: 'paragraph', markdown: 'July 8, 2026' },
      { id: 'tiers', type: 'paragraph', markdown: 'The models clustered into 3 capability tiers.' },
      { id: 'metrics', type: 'paragraph', markdown: 'Sonnet 5 is ~1.7x cheaper than Opus 4.8, but cost $2.09 vs $1.94, scoring six points lower (81% vs 87%) and consuming 1.9x more tokens.' },
      { id: 'languages', type: 'unordered-list-item', markdown: '- The codebase spans 10+ languages.' }
    ])
    const translated = createMarkdownBlocks([
      { id: 'date', type: 'paragraph', markdown: '2026 年 7 月 8 日' },
      { id: 'tiers', type: 'paragraph', markdown: '模型聚集成了三个能力层级。' },
      { id: 'metrics', type: 'paragraph', markdown: 'Sonnet 5 比 Opus 4.8 低约 1.7 倍，但成本为 2.09 美元对 1.94 美元，低了 6 个百分点（81% 对 87%），并消耗了 1.9 倍的词元。' },
      { id: 'languages', type: 'unordered-list-item', markdown: '- 该代码库横跨十多种语言。' }
    ])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it('确定性审计接受裸数字的中文等价表达', () => {
    const source = createMarkdownBlocks([{ type: 'paragraph', markdown: 'Answer: 3.' }])
    const translated = createMarkdownBlocks([{ type: 'paragraph', markdown: '答案：三。' }])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it('确定性审计接受英文 points 到中文个百分点', () => {
    const source = createMarkdownBlocks([{ type: 'paragraph', markdown: 'The score fell six points.' }])
    const translated = createMarkdownBlocks([{ type: 'paragraph', markdown: '得分下降了六个百分点。' }])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it.each([
    ['近似词', 'about 3 seconds', '约 3 秒'],
    ['序数版本', 'Version 2', '第二版']
  ])('确定性审计接受%s的中英文等价表达', (_name, markdown, translatedMarkdown) => {
    const source = createMarkdownBlocks([{ type: 'paragraph', markdown }])
    const translated = createMarkdownBlocks([{ type: 'paragraph', markdown: translatedMarkdown }])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it.each([
    ['真实数值变化', '3 tools', '四款工具'],
    ['负号丢失', '-3ms', '3毫秒'],
    ['币种改变', '$2.09', '2.09欧元'],
    ['百分比丢失', '81%', '八十一'],
    ['常用单位改变', '12ms', '十二秒']
  ])('确定性审计硬拦%s', (_name, markdown, translatedMarkdown) => {
    const source = createMarkdownBlocks([{ type: 'paragraph', markdown }])
    const translated = createMarkdownBlocks([{ type: 'paragraph', markdown: translatedMarkdown }])
    expect(auditDocumentTranslationDeterministically(source, translated).map((issue) => issue.code)).toContain('number-date-unit')
  })

  it('数字审计屏蔽 URL 与合法多反引号 inline code span', () => {
    const source = createMarkdownBlocks([{
      type: 'paragraph',
      markdown: '🚀 Open [v2](https://example.com/v2?q=81) and run ``echo `3` ``.'
    }])
    const translated = createMarkdownBlocks([{
      type: 'paragraph',
      markdown: '🚀 打开 [v2](https://example.com/v2?q=81)，然后运行 ``echo `3` ``。'
    }])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])

    const changed = createMarkdownBlocks([{
      type: 'paragraph',
      markdown: '🚀 打开 [v2](https://example.com/v2?q=81)，然后运行 ``echo `4` ``。'
    }])
    expect(auditDocumentTranslationDeterministically(source, changed).map((issue) => issue.code)).toEqual(['inline-code'])
  })

  it('普通中文数词片段不进入高置信数字硬拦', () => {
    const source = createMarkdownBlocks([{ type: 'paragraph', markdown: 'The system stays consistent and offers a premium experience.' }])
    const translated = createMarkdownBlocks([{ type: 'paragraph', markdown: '系统保持一致，并提供一流体验。' }])
    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it('真实任务中的模糊量词与关系改写不进入数字硬拦', () => {
    const source = createMarkdownBlocks([
      { id: 'block-0007', type: 'paragraph', markdown: 'Tasks featured edits against a multi-million line codebase covering many popular languages.' },
      { id: 'block-0019', type: 'paragraph', markdown: 'Figure 2: Three distinct capability tiers emerged, with nuance in which models were effective in each group.' },
      { id: 'block-0029', type: 'paragraph', markdown: 'We ran the same model through two different harnesses. The cost per task differed by more than 2x in some cases.' },
      { id: 'block-0031', type: 'paragraph', markdown: 'Pi sent about 3x less context per turn.' },
      { id: 'block-0044', type: 'paragraph', markdown: 'Our engineers merge thousands of code changes a day. A good pull request is a rich artifact.' },
      { id: 'block-0054', type: 'paragraph', markdown: 'What came out of this exercise was a single task.' },
      { id: 'block-0063', type: 'paragraph', markdown: 'In our early experiments, a few model scores looked too good to be true.' },
      { id: 'block-0065', type: 'paragraph', markdown: 'We started with a simple question.' },
      { id: 'block-0066', type: 'paragraph', markdown: 'Any team already has a benchmark. We are adding more tasks and will run every new agent through it.' }
    ])
    const translated = createMarkdownBlocks([
      { id: 'block-0007', type: 'paragraph', markdown: '任务涉及修改一个包含数百万行代码、覆盖多种主流语言的代码库。' },
      { id: 'block-0019', type: 'paragraph', markdown: '图 2：整体结果呈现出三个能力层级，但每一层中哪些模型真正有效仍有差异。' },
      { id: 'block-0029', type: 'paragraph', markdown: '我们通过两种不同的智能体运行框架运行同一模型，某些情况下单任务成本差异超过两倍。' },
      { id: 'block-0031', type: 'paragraph', markdown: 'Pi 每轮发送的上下文量约为其他框架的三分之一。' },
      { id: 'block-0044', type: 'paragraph', markdown: '我们的工程师每天都会合并数千项代码变更。高质量的拉取请求是一种信息丰富的产物。' },
      { id: 'block-0054', type: 'paragraph', markdown: '经过这一流程，最终得到的是一项任务。' },
      { id: 'block-0063', type: 'paragraph', markdown: '在早期实验中，有几个模型的得分好得令人难以置信。' },
      { id: 'block-0065', type: 'paragraph', markdown: '一开始，我们提出了一个简单的问题。' },
      { id: 'block-0066', type: 'paragraph', markdown: '任何团队都已经拥有一套基准评测。我们会添加更多任务，并评测每一种新的智能体。' }
    ])

    expect(auditDocumentTranslationDeterministically(source, translated)).toEqual([])
  })

  it('确定性审计接受 Markdown 标记和英文月份的等价译法', () => {
    const source = createMarkdownBlocks([
      { type: 'paragraph', markdown: 'A skill\'s `description` routes activation.' },
      { type: 'paragraph', markdown: 'Paste a `SKILL.md` into [tripwire](https://tripwire.bharath.sh/) in December 2025.' },
      { type: 'table', markdown: '<table><tbody><tr><td>missing the &quot;Use when…&quot; activation line</td><td><strong>95%</strong></td></tr></tbody></table>' }
    ])
    const translated = createMarkdownBlocks([
      { type: 'paragraph', markdown: '技能的 `description` 字段决定着激活路由。' },
      { type: 'paragraph', markdown: '把一份 `SKILL.md`（技能入口文件，不翻译）粘贴到 [Tripwire](https://tripwire.bharath.sh/)（项目名，不翻译），时间是 2025 年 12 月。' },
      { type: 'table', markdown: '<table><tbody><tr><td>缺少 &quot;Use when…&quot; 激活行（建议保留原文加注）</td><td><strong>95%</strong></td></tr></tbody></table>' }
    ])
    expect(auditDocumentTranslationDeterministically(source, translated, [
      { source: 'description', target: 'description 字段（技能的描述/路由字段）' },
      { source: 'skill', target: '技能（Agent Skills 规范中的可加载单元）' },
      { source: 'SKILL.md', target: 'SKILL.md（技能入口文件，不翻译）' },
      { source: 'tripwire', target: 'Tripwire（项目名，不翻译）' },
      { source: 'Use when…', target: '"Use when…" 激活行（建议保留原文加注）' }
    ])).toEqual([])
  })
})

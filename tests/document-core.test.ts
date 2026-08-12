import { describe, expect, it } from 'vitest'
import {
  createMarkdownBlocks,
  documentProcessingSummary,
  documentStructureStats,
  parseMarkdownBlocks,
  renderMarkdownBlocks,
  verifyDocumentCompleteness,
  type DocumentMetadata,
  type MarkdownDocument
} from '../src/core/document'

const metadata: DocumentMetadata = {
  processingMode: 'translate',
  contentType: 'web',
  sourceUrl: 'https://example.com/article',
  sourceTitle: 'Source title',
  title: 'Source title',
  fetchedAt: '2026-08-09T00:00:00.000Z',
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN'
}

describe('document core', () => {
  it('parses Markdown into stable blocks and reports its structure', () => {
    const blocks = parseMarkdownBlocks(`# Source title

Opening paragraph.

> A quote

- first item

1. numbered item

![Chart](https://example.com/chart.png)

| Name | Value |
| --- | --- |
| A | 1 |

\`\`\`ts
const value = 1
\`\`\`

---

<mark>kept HTML</mark>
`)
    const stats = documentStructureStats({ blocks })

    expect(blocks.map((block) => block.id)).toEqual([
      'block-0001', 'block-0002', 'block-0003', 'block-0004', 'block-0005',
      'block-0006', 'block-0007', 'block-0008', 'block-0009', 'block-0010'
    ])
    expect(stats).toMatchObject({
      blockCount: 10,
      headings: 1,
      headingLevels: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
      paragraphs: 1,
      blockquotes: 1,
      unorderedListItems: 1,
      orderedListItems: 1,
      codeBlocks: 1,
      tables: 1,
      tableRows: 2,
      tableCells: 4,
      images: 1,
      dividers: 1,
      htmlBlocks: 1
    })
    expect(stats.structureFingerprint).toMatch(/^fnv1a-[a-f0-9]{8}$/u)
    expect(parseMarkdownBlocks(renderMarkdownBlocks(blocks))).toEqual(blocks)
  })

  it('accepts translated text with identical structure and immutable media/code blocks', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([
        { id: 'title', type: 'heading', level: 1, markdown: '# Source title' },
        { id: 'intro', type: 'paragraph', markdown: 'Opening paragraph.' },
        { id: 'item', type: 'unordered-list-item', markdown: '- First item' },
        { id: 'image', type: 'image', markdown: '![Chart](assets/chart.png)', sourceId: 'chart' },
        { id: 'code', type: 'code', markdown: '```ts\nconst value = 1\n```' },
        { id: 'table', type: 'table', markdown: '| Name | Value |\n| --- | --- |\n| A | 1 |' }
      ])
    }
    const translated: MarkdownDocument = {
      metadata: { ...metadata, title: '译文标题' },
      warnings: [],
      blocks: createMarkdownBlocks([
        { id: 'title', type: 'heading', level: 1, markdown: '# 译文标题' },
        { id: 'intro', type: 'paragraph', markdown: '开场段落。' },
        { id: 'item', type: 'unordered-list-item', markdown: '- 第一项' },
        { id: 'image', type: 'image', markdown: '![Chart](assets/chart.png)', sourceId: 'chart' },
        { id: 'code', type: 'code', markdown: '```ts\nconst value = 1\n```' },
        { id: 'table', type: 'table', markdown: '| 名称 | 数值 |\n| --- | --- |\n| A | 1 |' }
      ])
    }

    expect(verifyDocumentCompleteness(source, translated)).toMatchObject({ ok: true, issues: [] })
    expect(documentProcessingSummary(source, translated)).toEqual({
      processingMode: 'translate',
      resolvedSource: 'web',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      blockCount: 6,
      translatedBlockCount: 6,
      warnings: []
    })
  })

  it('reports deterministic structural and immutable-content failures', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([
        { id: 'title', type: 'heading', level: 1, markdown: '# Source' },
        { id: 'image', type: 'image', markdown: '![Chart](assets/chart.png)', sourceId: 'chart' },
        { id: 'code', type: 'code', markdown: '```\nkeep me\n```' }
      ])
    }
    const incomplete: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([
        { id: 'title', type: 'heading', level: 2, markdown: '## 译文' },
        { id: 'image', type: 'image', markdown: '![Chart](https://remote.example/chart.png)', sourceId: 'chart' }
      ])
    }

    const first = verifyDocumentCompleteness(source, incomplete)
    expect(first.ok).toBe(false)
    expect(first.issues.map((issue) => issue.code)).toEqual([
      'block-count-mismatch',
      'heading-level-mismatch',
      'immutable-block-mismatch'
    ])
    expect(verifyDocumentCompleteness(source, incomplete)).toEqual(first)
  })

  it('rejects a translated block that changes a source link target', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: '[Docs](https://example.com/docs)' }])
    }
    const translated: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: '[文档](https://evil.example/docs)' }])
    }

    expect(verifyDocumentCompleteness(source, translated).issues).toMatchObject([
      { code: 'link-target-mismatch', blockId: 'link' }
    ])
  })

  it('accepts balanced-parenthesis URLs with translated trailing punctuation', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{
        id: 'link',
        type: 'paragraph',
        markdown: 'See [API](https://example.com/a_(b)) and https://example.com/a_(b). Again: https://example.com/a_(b).'
      }])
    }
    const translated: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{
        id: 'link',
        type: 'paragraph',
        markdown: '参见 [API](https://example.com/a_(b)) 和 https://example.com/a_(b)。再看：https://example.com/a_(b)。'
      }])
    }

    expect(verifyDocumentCompleteness(source, translated).issues).toEqual([])
  })

  it('rejects removing one occurrence of a repeated URL', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: 'First https://example.com/a_(b). Second https://example.com/a_(b).' }])
    }
    const translated: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: '仅保留 https://example.com/a_(b)。' }])
    }

    expect(verifyDocumentCompleteness(source, translated).issues).toMatchObject([
      { code: 'link-target-mismatch', blockId: 'link' }
    ])
  })

  it('validates relative targets behind nested link labels', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: 'See [API [v2]](docs/v2/page.md).' }])
    }
    const translated: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: '参见 [API [v2]](docs/v3/page.md)。' }])
    }

    expect(verifyDocumentCompleteness(source, translated).issues).toMatchObject([
      { code: 'link-target-mismatch', blockId: 'link' }
    ])
  })

  it('does not include surrounding quotation marks in bare URLs', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: 'Open "https://example.com/docs".' }])
    }
    const translated: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{ id: 'link', type: 'paragraph', markdown: '打开“https://example.com/docs”。' }])
    }

    expect(verifyDocumentCompleteness(source, translated).issues).toEqual([])
  })

  it('ignores escaped and inline-code pipes when comparing table shape', () => {
    const source: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{
        id: 'table',
        type: 'table',
        markdown: '| Syntax | Meaning |\n| --- | --- |\n| `a|b` | A \\| B |'
      }])
    }
    const translated: MarkdownDocument = {
      metadata,
      warnings: [],
      blocks: createMarkdownBlocks([{
        id: 'table',
        type: 'table',
        markdown: '| 语法 | 含义 |\n| --- | --- |\n| `甲|乙` | 甲 \\| 乙 |'
      }])
    }

    expect(documentStructureStats(source).tableCells).toBe(4)
    expect(verifyDocumentCompleteness(source, translated).issues).toEqual([])

    const extraColumn: MarkdownDocument = {
      ...translated,
      blocks: createMarkdownBlocks([{
        id: 'table',
        type: 'table',
        markdown: '| 语法 | 含义 | 新列 |\n| --- | --- | --- |\n| `甲|乙` | 甲 \\| 乙 | 值 |'
      }])
    }
    expect(verifyDocumentCompleteness(source, extraColumn).issues.map((issue) => issue.code)).toContain('table-shape-mismatch')
  })
})

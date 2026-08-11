import { describe, expect, it } from 'vitest'
import { parseInline, parseSummaryMarkdown, summaryImageFilenames } from '../src/renderer/summary-markdown'

describe('总结正文渲染 token 化', () => {
  it('识别标题、段落、图片、引用与列表', () => {
    const blocks = parseSummaryMarkdown([
      '# 主标题',
      '',
      '![封面](images/00-cover.png)',
      '',
      '第一段第一行',
      '第一段第二行',
      '',
      '## 要点速览',
      '',
      '- 第一条',
      '- 第二条',
      '',
      '1. 有序一',
      '2. 有序二',
      '',
      '> 引述一句',
      '',
      '---'
    ].join('\n'))

    expect(blocks[0]).toEqual({ kind: 'heading', level: 1, inline: [{ kind: 'text', text: '主标题' }] })
    expect(blocks[1]).toEqual({ kind: 'image', alt: '封面', filename: '00-cover.png' })
    expect(blocks[2]).toMatchObject({ kind: 'paragraph' })
    expect(blocks[2]).toHaveProperty('inline', [{ kind: 'text', text: '第一段第一行 第一段第二行' }])
    expect(blocks[3]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[4]).toMatchObject({ kind: 'list', ordered: false })
    expect(blocks[5]).toMatchObject({ kind: 'list', ordered: true })
    expect(blocks[6]).toMatchObject({ kind: 'quote' })
    expect(blocks[7]).toEqual({ kind: 'divider' })
  })

  it('行内加粗、代码与链接拆成独立 token，不留原始标记', () => {
    expect(parseInline('这是**判断锚点**、`code` 与 [Tripwire](https://tripwire.bharath.sh/) 混排')).toEqual([
      { kind: 'text', text: '这是' },
      { kind: 'strong', text: '判断锚点' },
      { kind: 'text', text: '、' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' 与 ' },
      { kind: 'link', text: 'Tripwire', href: 'https://tripwire.bharath.sh/' },
      { kind: 'text', text: ' 混排' }
    ])
    expect(parseInline('纯文本')).toEqual([{ kind: 'text', text: '纯文本' }])
  })

  it('只把 images/ 前缀的图片行当配图，外部图片不解析成配图', () => {
    const blocks = parseSummaryMarkdown([
      '![本地](images/02-alpha.png)',
      '',
      '![远程](https://example.com/a.png)'
    ].join('\n'))
    expect(summaryImageFilenames(blocks)).toEqual(['02-alpha.png'])
    expect(blocks[1]).toMatchObject({ kind: 'paragraph' })
  })

  it('把网页翻译里的 HTML table 解析成表格 block', () => {
    const blocks = parseSummaryMarkdown('<table><thead><tr><th></th><th>占比</th></tr></thead><tbody><tr><td>至少一个 lint 错误</td><td><strong>96%</strong></td></tr><tr><td>缺少 &quot;Use when…&quot; 激活行</td><td><strong>95%</strong></td></tr></tbody></table>')
    expect(blocks).toEqual([{ kind: 'table', rows: [
      { header: true, cells: [[{ kind: 'text', text: '' }], [{ kind: 'text', text: '占比' }]] },
      { header: false, cells: [[{ kind: 'text', text: '至少一个 lint 错误' }], [{ kind: 'strong', text: '96%' }]] },
      { header: false, cells: [[{ kind: 'text', text: '缺少 "Use when…" 激活行' }], [{ kind: 'strong', text: '95%' }]] }
    ] }])
  })

  it('多行 HTML table 在闭合标签处收口，后面的正文照常解析', () => {
    const blocks = parseSummaryMarkdown([
      '<table>',
      '<tr><th>项</th><th>占比</th></tr>',
      '<tr><td>lint</td><td>96%</td></tr>',
      '</table>',
      '',
      '## 后续章节',
      '',
      '表格后的正文。'
    ].join('\n'))
    expect(blocks).toEqual([
      { kind: 'table', rows: [
        { header: true, cells: [[{ kind: 'text', text: '项' }], [{ kind: 'text', text: '占比' }]] },
        { header: false, cells: [[{ kind: 'text', text: 'lint' }], [{ kind: 'text', text: '96%' }]] }
      ] },
      { kind: 'heading', level: 2, inline: [{ kind: 'text', text: '后续章节' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: '表格后的正文。' }] }
    ])
  })

  it('未闭合的 HTML table 不吞掉后面的正文', () => {
    const blocks = parseSummaryMarkdown([
      '<table>',
      '<tr><td>只开了一半</td></tr>',
      '',
      '## 后续章节',
      '',
      '表格后的正文。'
    ].join('\n'))
    expect(blocks).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: '<table> <tr><td>只开了一半</td></tr>' }] },
      { kind: 'heading', level: 2, inline: [{ kind: 'text', text: '后续章节' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: '表格后的正文。' }] }
    ])
  })
})

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

  it('行内加粗与代码拆成独立 token，不留原始标记', () => {
    expect(parseInline('这是**判断锚点**与 `code` 混排')).toEqual([
      { kind: 'text', text: '这是' },
      { kind: 'strong', text: '判断锚点' },
      { kind: 'text', text: '与 ' },
      { kind: 'code', text: 'code' },
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
})

// 总结正文只需要一个受限 Markdown 子集；自己 token 化可以避免新增依赖，也不用 innerHTML。
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }

export type SummaryBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; inline: InlineToken[] }
  | { kind: 'paragraph'; inline: InlineToken[] }
  | { kind: 'quote'; inline: InlineToken[] }
  | { kind: 'list'; ordered: boolean; items: InlineToken[][] }
  | { kind: 'image'; filename: string; alt: string }
  | { kind: 'divider' }

const IMAGE_LINE = /^!\[([^\]]*)\]\(images\/([^)]+)\)$/u
const HEADING_LINE = /^(#{1,3})\s+(.*)$/u
const QUOTE_LINE = /^>\s?(.*)$/u
const UNORDERED_LINE = /^[-*]\s+(.*)$/u
const ORDERED_LINE = /^\d+[.)]\s+(.*)$/u

export function parseInline(value: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/gu
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ kind: 'text', text: value.slice(cursor, index) })
    if (match[1] !== undefined) tokens.push({ kind: 'strong', text: match[1] })
    else if (match[2] !== undefined) tokens.push({ kind: 'code', text: match[2] })
    cursor = index + match[0].length
  }
  if (cursor < value.length) tokens.push({ kind: 'text', text: value.slice(cursor) })
  return tokens.length ? tokens : [{ kind: 'text', text: value }]
}

export function parseSummaryMarkdown(markdown: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = []
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | undefined

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ').trim()) })
    paragraph = []
  }
  const flushList = (): void => {
    if (!list) return
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items.map((item) => parseInline(item)) })
    list = undefined
  }
  const flush = (): void => {
    flushParagraph()
    flushList()
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const image = IMAGE_LINE.exec(line)
    if (image) {
      flush()
      blocks.push({ kind: 'image', alt: image[1], filename: image[2] })
      continue
    }
    const heading = HEADING_LINE.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, inline: parseInline(heading[2].trim()) })
      continue
    }
    if (/^(?:-{3,}|\*{3,})$/u.test(line)) {
      flush()
      blocks.push({ kind: 'divider' })
      continue
    }
    const quote = QUOTE_LINE.exec(line)
    if (quote) {
      flush()
      blocks.push({ kind: 'quote', inline: parseInline(quote[1].trim()) })
      continue
    }
    const unordered = UNORDERED_LINE.exec(line)
    const ordered = unordered ? null : ORDERED_LINE.exec(line)
    if (unordered || ordered) {
      flushParagraph()
      const isOrdered = Boolean(ordered)
      const text = (unordered ?? ordered)![1].trim()
      if (list && list.ordered !== isOrdered) flushList()
      list ??= { ordered: isOrdered, items: [] }
      list.items.push(text)
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flush()
  return blocks
}

export function summaryImageFilenames(blocks: readonly SummaryBlock[]): string[] {
  return blocks.filter((block): block is Extract<SummaryBlock, { kind: 'image' }> => block.kind === 'image')
    .map((block) => block.filename)
}

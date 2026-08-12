// 总结正文只需要一个受限 Markdown 子集；自己 token 化可以避免新增依赖，也不用 innerHTML。
export type InlineToken =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

export type SummaryBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; inline: InlineToken[] }
  | { kind: 'paragraph'; inline: InlineToken[] }
  | { kind: 'quote'; inline: InlineToken[] }
  | { kind: 'list'; ordered: boolean; items: InlineToken[][] }
  | { kind: 'table'; rows: Array<{ header: boolean; cells: InlineToken[][] }> }
  | { kind: 'image'; filename: string; alt: string }
  | { kind: 'divider' }

const IMAGE_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/u
const HEADING_LINE = /^(#{1,3})\s+(.*)$/u
const QUOTE_LINE = /^>\s?(.*)$/u
const UNORDERED_LINE = /^[-*]\s+(.*)$/u
const ORDERED_LINE = /^\d+[.)]\s+(.*)$/u

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
}

function cellMarkdown(value: string): string {
  return decodeHtml(value)
    .replace(/<\s*strong\b[^>]*>([\s\S]*?)<\s*\/\s*strong\s*>/giu, '**$1**')
    .replace(/<\s*code\b[^>]*>([\s\S]*?)<\s*\/\s*code\s*>/giu, '`$1`')
    .replace(/<\s*br\s*\/?>/giu, ' ')
    .replace(/<[^>]+>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function parseHtmlTable(value: string): Extract<SummaryBlock, { kind: 'table' }> | undefined {
  const rows: Array<{ header: boolean; cells: InlineToken[][] }> = []
  for (const row of value.matchAll(/<\s*tr\b[^>]*>([\s\S]*?)<\s*\/\s*tr\s*>/giu)) {
    const cells: InlineToken[][] = []
    let header = false
    for (const cell of row[1].matchAll(/<\s*(th|td)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/giu)) {
      header ||= cell[1].toLocaleLowerCase('en-US') === 'th'
      cells.push(parseInline(cellMarkdown(cell[2])))
    }
    if (cells.length) rows.push({ header, cells })
  }
  return rows.length ? { kind: 'table', rows } : undefined
}

export function parseInline(value: string): InlineToken[] {
  const tokens: InlineToken[] = []
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/gu
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > cursor) tokens.push({ kind: 'text', text: value.slice(cursor, index) })
    if (match[1] !== undefined) tokens.push({ kind: 'link', text: match[1], href: match[2] })
    else if (match[3] !== undefined) tokens.push({ kind: 'strong', text: match[3] })
    else if (match[4] !== undefined) tokens.push({ kind: 'code', text: match[4] })
    cursor = index + match[0].length
  }
  if (cursor < value.length) tokens.push({ kind: 'text', text: value.slice(cursor) })
  return tokens.length ? tokens : [{ kind: 'text', text: value }]
}

export function parseSummaryMarkdown(markdown: string, documentImagePaths?: ReadonlySet<string>): SummaryBlock[] {
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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      flush()
      continue
    }
    if (/^<\s*table\b/iu.test(line)) {
      flush()
      let end = index
      const html: string[] = []
      while (end < lines.length) {
        html.push(lines[end].trim())
        if (/<\s*\/\s*table\s*>/iu.test(lines[end])) break
        end += 1
      }
      // 未闭合的 <table> 只按普通一行处理：否则它会把后面所有正文吞进这个片段。
      if (end >= lines.length) {
        paragraph.push(line)
        continue
      }
      const table = parseHtmlTable(html.join('\n'))
      if (table) blocks.push(table)
      else paragraph.push(html.join(' '))
      index = end
      continue
    }
    const image = IMAGE_LINE.exec(line)
    const imagePath = image?.[2]
    if (imagePath && (imagePath.startsWith('images/') || documentImagePaths?.has(imagePath))) {
      flush()
      blocks.push({ kind: 'image', alt: image[1], filename: imagePath.startsWith('images/') ? imagePath.slice('images/'.length) : imagePath })
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

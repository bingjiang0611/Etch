export type DocumentProcessingMode = 'auto' | 'convert' | 'translate'
export type ResolvedDocumentSource = 'web' | 'x-post' | 'x-article'
export type MarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'unordered-list-item'
  | 'ordered-list-item'
  | 'code'
  | 'table'
  | 'image'
  | 'divider'
  | 'html'

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6

export interface DocumentEngagement {
  replies?: number
  retweets?: number
  likes?: number
  bookmarks?: number
  views?: number
}

export interface DocumentMetadata {
  processingMode: DocumentProcessingMode
  contentType: ResolvedDocumentSource
  sourceUrl: string
  fetchedAt: string
  targetLanguage: string
  canonicalUrl?: string
  sourceTitle?: string
  title?: string
  author?: string
  screenName?: string
  authorUrl?: string
  publishedAt?: string
  sourceLanguage?: string
  tweetId?: string
  coverImageUrl?: string
  engagement?: DocumentEngagement
}

export interface MarkdownBlock {
  id: string
  type: MarkdownBlockType
  markdown: string
  level?: HeadingLevel
  sourceId?: string
}

export type MarkdownBlockInput = Omit<MarkdownBlock, 'id'> & { id?: string }

export interface MarkdownDocument {
  metadata: DocumentMetadata
  blocks: MarkdownBlock[]
  warnings: string[]
}

export interface DocumentMedia {
  id: string
  kind: 'cover' | 'image' | 'video'
  index: number
  sourceUrl: string
  localPath?: string
  blockId?: string
  alt?: string
  sourceId?: string
  status: 'remote' | 'localized' | 'failed' | 'skipped'
}

export interface DocumentStructureStats {
  blockCount: number
  headings: number
  headingLevels: Record<HeadingLevel, number>
  paragraphs: number
  blockquotes: number
  unorderedListItems: number
  orderedListItems: number
  codeBlocks: number
  tables: number
  tableRows: number
  tableCells: number
  images: number
  dividers: number
  htmlBlocks: number
  structureFingerprint: string
}

export type DocumentCompletenessIssueCode =
  | 'metadata-mismatch'
  | 'duplicate-block-id'
  | 'block-count-mismatch'
  | 'block-id-mismatch'
  | 'block-type-mismatch'
  | 'heading-level-mismatch'
  | 'immutable-block-mismatch'
  | 'link-target-mismatch'
  | 'table-shape-mismatch'

export interface DocumentCompletenessIssue {
  code: DocumentCompletenessIssueCode
  message: string
  blockId?: string
}

export interface DocumentCompletenessVerification {
  ok: boolean
  source: DocumentStructureStats
  candidate: DocumentStructureStats
  issues: DocumentCompletenessIssue[]
}

export interface DocumentProcessingSummary {
  processingMode: DocumentProcessingMode
  resolvedSource: ResolvedDocumentSource
  sourceLanguage?: string
  targetLanguage: string
  blockCount: number
  translatedBlockCount: number
  warnings: string[]
}

const headingLevels = (): Record<HeadingLevel, number> => ({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 })

export function createMarkdownBlocks(inputs: readonly MarkdownBlockInput[]): MarkdownBlock[] {
  const ids = new Set<string>()
  return inputs.map((input, index) => {
    const id = input.id?.trim() || `block-${String(index + 1).padStart(4, '0')}`
    if (ids.has(id)) throw new Error(`Markdown block ID 重复：${id}`)
    if (!input.markdown.trim()) throw new Error(`Markdown block ${id} 内容为空`)
    ids.add(id)
    return { ...input, id, markdown: input.markdown.trim() }
  })
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: MarkdownBlockInput[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^\s*(`{3,}|~{3,})/u)
    if (fence) {
      const body = [line]
      index += 1
      while (index < lines.length) {
        body.push(lines[index])
        const closed = new RegExp(`^\\s*${escapeRegExp(fence[1][0])}{${fence[1].length},}\\s*$`, 'u').test(lines[index])
        index += 1
        if (closed) break
      }
      blocks.push({ type: 'code', markdown: body.join('\n') })
      continue
    }

    if (/^\s*<table\b/iu.test(line)) {
      const body = [line]
      index += 1
      while (index < lines.length && !/<\/table>\s*$/iu.test(body.at(-1)!)) {
        body.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'table', markdown: body.join('\n') })
      continue
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/u)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length as HeadingLevel, markdown: line.trim() })
      index += 1
      continue
    }
    if (isImageLine(line)) {
      blocks.push({ type: 'image', markdown: line.trim() })
      index += 1
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      blocks.push({ type: 'divider', markdown: line.trim() })
      index += 1
      continue
    }
    if (/^\s*[-+*]\s+\S/u.test(line)) {
      blocks.push({ type: 'unordered-list-item', markdown: line.trim() })
      index += 1
      continue
    }
    if (/^\s*\d+[.)]\s+\S/u.test(line)) {
      blocks.push({ type: 'ordered-list-item', markdown: line.trim() })
      index += 1
      continue
    }
    if (/^\s*>/u.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>/u.test(lines[index])) {
        body.push(lines[index].trim())
        index += 1
      }
      blocks.push({ type: 'blockquote', markdown: body.join('\n') })
      continue
    }
    if (isMarkdownTable(lines, index)) {
      const body = [line, lines[index + 1]]
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        body.push(lines[index])
        index += 1
      }
      blocks.push({ type: 'table', markdown: body.join('\n') })
      continue
    }
    if (/^\s*<[A-Za-z][\s\S]*>\s*$/u.test(line)) {
      blocks.push({ type: 'html', markdown: line.trim() })
      index += 1
      continue
    }

    const paragraph = [line.trim()]
    index += 1
    while (index < lines.length && lines[index].trim() && !startsMarkdownBlock(lines, index)) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    blocks.push({ type: 'paragraph', markdown: paragraph.join('\n') })
  }

  return createMarkdownBlocks(blocks)
}

export function renderMarkdownBlocks(blocks: readonly MarkdownBlock[]): string {
  return blocks.length ? `${blocks.map((block) => block.markdown.trim()).join('\n\n')}\n` : ''
}

export function documentStructureStats(document: Pick<MarkdownDocument, 'blocks'>): DocumentStructureStats {
  const levels = headingLevels()
  const stats: Omit<DocumentStructureStats, 'structureFingerprint'> = {
    blockCount: document.blocks.length,
    headings: 0,
    headingLevels: levels,
    paragraphs: 0,
    blockquotes: 0,
    unorderedListItems: 0,
    orderedListItems: 0,
    codeBlocks: 0,
    tables: 0,
    tableRows: 0,
    tableCells: 0,
    images: 0,
    dividers: 0,
    htmlBlocks: 0
  }
  const signatures: string[] = []

  for (const block of document.blocks) {
    let detail = ''
    switch (block.type) {
      case 'heading': {
        stats.headings += 1
        const level = block.level ?? headingLevelFromMarkdown(block.markdown)
        levels[level] += 1
        detail = String(level)
        break
      }
      case 'paragraph': stats.paragraphs += 1; break
      case 'blockquote': stats.blockquotes += 1; break
      case 'unordered-list-item': stats.unorderedListItems += 1; break
      case 'ordered-list-item': stats.orderedListItems += 1; break
      case 'code': stats.codeBlocks += 1; break
      case 'table': {
        stats.tables += 1
        const shape = tableShape(block.markdown)
        stats.tableRows += shape.rows
        stats.tableCells += shape.cells
        detail = `${shape.rows}x${shape.cells}`
        break
      }
      case 'image': stats.images += 1; break
      case 'divider': stats.dividers += 1; break
      case 'html': stats.htmlBlocks += 1; break
    }
    signatures.push(`${block.id}:${block.type}:${detail}`)
  }

  return { ...stats, structureFingerprint: stableHash(signatures.join('|')) }
}

export function verifyDocumentCompleteness(
  sourceDocument: MarkdownDocument,
  candidateDocument: MarkdownDocument
): DocumentCompletenessVerification {
  const source = documentStructureStats(sourceDocument)
  const candidate = documentStructureStats(candidateDocument)
  const issues: DocumentCompletenessIssue[] = []

  for (const key of [
    'processingMode',
    'contentType',
    'sourceUrl',
    'fetchedAt',
    'targetLanguage',
    'canonicalUrl',
    'sourceTitle',
    'author',
    'screenName',
    'publishedAt',
    'sourceLanguage',
    'tweetId',
    'coverImageUrl'
  ] as const) {
    const expected = sourceDocument.metadata[key]
    const actual = candidateDocument.metadata[key]
    if (expected !== actual) {
      issues.push({ code: 'metadata-mismatch', message: `metadata.${key} 不一致：${String(expected)} → ${String(actual)}` })
    }
  }
  if (JSON.stringify(sourceDocument.metadata.engagement) !== JSON.stringify(candidateDocument.metadata.engagement)) {
    issues.push({ code: 'metadata-mismatch', message: 'metadata.engagement 不一致' })
  }
  appendDuplicateIdIssues(sourceDocument.blocks, '源文档', issues)
  appendDuplicateIdIssues(candidateDocument.blocks, '候选文档', issues)
  if (source.blockCount !== candidate.blockCount) {
    issues.push({ code: 'block-count-mismatch', message: `block 数不一致：${source.blockCount} → ${candidate.blockCount}` })
  }

  const sharedLength = Math.min(sourceDocument.blocks.length, candidateDocument.blocks.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const expected = sourceDocument.blocks[index]
    const actual = candidateDocument.blocks[index]
    if (expected.id !== actual.id) {
      issues.push({ code: 'block-id-mismatch', blockId: expected.id, message: `第 ${index + 1} 个 block ID 不一致：${expected.id} → ${actual.id}` })
    }
    if (expected.type !== actual.type) {
      issues.push({ code: 'block-type-mismatch', blockId: expected.id, message: `block ${expected.id} 类型不一致：${expected.type} → ${actual.type}` })
      continue
    }
    if (expected.type === 'heading') {
      const expectedLevel = expected.level ?? headingLevelFromMarkdown(expected.markdown)
      const actualLevel = actual.level ?? headingLevelFromMarkdown(actual.markdown)
      if (expectedLevel !== actualLevel) {
        issues.push({ code: 'heading-level-mismatch', blockId: expected.id, message: `标题 ${expected.id} 层级不一致：H${expectedLevel} → H${actualLevel}` })
      }
    }
    if (expected.type === 'image' || expected.type === 'code' || expected.type === 'divider' || expected.type === 'html') {
      if (expected.markdown.trim() !== actual.markdown.trim() || expected.sourceId !== actual.sourceId) {
        issues.push({ code: 'immutable-block-mismatch', blockId: expected.id, message: `${expected.type} block ${expected.id} 未原样保留` })
      }
    }
    if (expected.type !== 'image' && expected.type !== 'code' && expected.type !== 'divider' && expected.type !== 'html') {
      if (JSON.stringify(markdownUrls(expected.markdown)) !== JSON.stringify(markdownUrls(actual.markdown))) {
        issues.push({ code: 'link-target-mismatch', blockId: expected.id, message: `block ${expected.id} 的链接目标发生变化` })
      }
    }
    if (expected.type === 'table') {
      const expectedShape = tableShape(expected.markdown)
      const actualShape = tableShape(actual.markdown)
      if (expectedShape.rows !== actualShape.rows || expectedShape.cells !== actualShape.cells) {
        issues.push({ code: 'table-shape-mismatch', blockId: expected.id, message: `表格 ${expected.id} 结构不一致：${expectedShape.rows}/${expectedShape.cells} → ${actualShape.rows}/${actualShape.cells}` })
      }
    }
  }

  return { ok: issues.length === 0, source, candidate, issues }
}

export function documentProcessingSummary(
  sourceDocument: MarkdownDocument,
  translatedDocument?: MarkdownDocument
): DocumentProcessingSummary {
  return {
    processingMode: sourceDocument.metadata.processingMode,
    resolvedSource: sourceDocument.metadata.contentType,
    ...(sourceDocument.metadata.sourceLanguage ? { sourceLanguage: sourceDocument.metadata.sourceLanguage } : {}),
    targetLanguage: sourceDocument.metadata.targetLanguage,
    blockCount: sourceDocument.blocks.length,
    translatedBlockCount: translatedDocument?.blocks.length ?? 0,
    warnings: [...new Set([...sourceDocument.warnings, ...(translatedDocument?.warnings ?? [])])]
      .map((warning) => warning.trim().slice(0, 500))
      .filter(Boolean)
      .slice(0, 100)
  }
}

function startsMarkdownBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index]
  return /^\s*(?:#{1,6}\s+|`{3,}|~{3,}|[-+*]\s+\S|\d+[.)]\s+\S|>|<table\b|(?:-{3,}|\*{3,}|_{3,})\s*$)/iu.test(line)
    || isImageLine(line)
    || isMarkdownTable(lines, index)
}

function isImageLine(line: string): boolean {
  return /^\s*(?:!\[[^\]]*\]\([^\n]+\)|!\[\[[^\]]+\]\])\s*$/u.test(line)
}

function isMarkdownTable(lines: readonly string[], index: number): boolean {
  return index + 1 < lines.length
    && lines[index].includes('|')
    && /^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/u.test(lines[index + 1])
}

function tableShape(markdown: string): { rows: number; cells: number } {
  if (/^\s*<table\b/iu.test(markdown)) {
    const rows = [...markdown.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
    return {
      rows: rows.length,
      cells: rows.reduce((sum, row) => sum + [...row[1].matchAll(/<t[dh]\b/giu)].length, 0)
    }
  }
  const lines = markdown.split('\n').filter((line) => line.trim())
  const rows = lines.filter((_line, index) => index !== 1)
  return { rows: rows.length, cells: rows.reduce((sum, row) => sum + markdownTableCells(row), 0) }
}

function markdownTableCells(row: string): number {
  const trimmed = row.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  return trimmed ? trimmed.split(/(?<!\\)\|/u).length : 0
}

function markdownUrls(value: string): string[] {
  const linked = [...value.matchAll(/(?:!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu)].map((match) => match[1])
  const literal = [...value.matchAll(/https?:\/\/[^\s)<>{}\]]+/gu)].map((match) => match[0])
  return [...linked, ...literal].sort()
}

function headingLevelFromMarkdown(markdown: string): HeadingLevel {
  const length = markdown.match(/^\s*(#{1,6})\s/u)?.[1].length ?? 1
  return length as HeadingLevel
}

function appendDuplicateIdIssues(
  blocks: readonly MarkdownBlock[],
  label: string,
  issues: DocumentCompletenessIssue[]
): void {
  const ids = new Set<string>()
  for (const block of blocks) {
    if (ids.has(block.id)) issues.push({ code: 'duplicate-block-id', blockId: block.id, message: `${label} block ID 重复：${block.id}` })
    ids.add(block.id)
  }
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

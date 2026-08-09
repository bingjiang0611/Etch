import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import { dialog, shell, type BrowserWindow } from 'electron'
import {
  parseMarkdownBlocks,
  renderMarkdownBlocks,
  verifyDocumentCompleteness,
  type DocumentCompletenessVerification,
  type DocumentMedia,
  type DocumentMetadata as CoreDocumentMetadata,
  type MarkdownBlock,
  type MarkdownBlockType,
  type MarkdownDocument
} from '../core/document'
import type { DocumentMetadata, DocumentPage, DocumentVerification, ExportDocumentResult } from '../shared/ipc'
import type { TaskManifest } from '../shared/task-schema'
import { fingerprint, sha256File } from './core/fingerprint'
import { artifactCandidateRelativePath, ensureArtifactRunDirectory } from './pipeline/artifact-publisher'
import type { IndexStore } from './storage/index-store'
import { writeJsonAtomic } from './storage/atomic-json'
import { writeTextAtomic } from './storage/atomic-text'
import { readContainedFile } from './storage/safe-artifact'
import type { TaskStore } from './storage/task-store'

type Artifact = TaskManifest['artifacts'][string]

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const MAX_METADATA_BYTES = 2 * 1024 * 1024
const MAX_MEDIA_MANIFEST_BYTES = 5 * 1024 * 1024
const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const BLOCK_TYPES = new Set<MarkdownBlockType>([
  'heading', 'paragraph', 'blockquote', 'unordered-list-item', 'ordered-list-item',
  'code', 'table', 'image', 'divider', 'html'
])
const MEDIA_STATUSES = new Set<DocumentMedia['status']>(['remote', 'localized', 'failed', 'skipped'])
const MEDIA_KINDS = new Set<DocumentMedia['kind']>(['cover', 'image', 'video'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocument(value: unknown, label: string): MarkdownDocument {
  if (!isObject(value) || !isObject(value.metadata) || !Array.isArray(value.blocks) || !Array.isArray(value.warnings)) {
    throw new Error(`${label}格式无效`)
  }
  const metadata = value.metadata
  if (
    !['auto', 'convert', 'translate'].includes(String(metadata.processingMode))
    || !['web', 'x-post', 'x-article'].includes(String(metadata.contentType))
    || typeof metadata.sourceUrl !== 'string'
    || typeof metadata.fetchedAt !== 'string'
    || typeof metadata.targetLanguage !== 'string'
  ) throw new Error(`${label} metadata 无效`)

  const ids = new Set<string>()
  const blocks = value.blocks.map((candidate, index): MarkdownBlock => {
    if (!isObject(candidate)) throw new Error(`${label} 第 ${index + 1} 个 block 格式无效`)
    const id = candidate.id
    const type = candidate.type
    const markdown = candidate.markdown
    if (typeof id !== 'string' || !id || ids.has(id)) throw new Error(`${label} block ID 无效或重复`)
    if (typeof type !== 'string' || !BLOCK_TYPES.has(type as MarkdownBlockType) || typeof markdown !== 'string' || !markdown.trim()) {
      throw new Error(`${label} block ${id} 内容无效`)
    }
    if (candidate.level !== undefined && (!Number.isInteger(candidate.level) || Number(candidate.level) < 1 || Number(candidate.level) > 6)) {
      throw new Error(`${label} block ${id} 标题层级无效`)
    }
    if (candidate.sourceId !== undefined && typeof candidate.sourceId !== 'string') throw new Error(`${label} block ${id} sourceId 无效`)
    ids.add(id)
    return {
      id,
      type: type as MarkdownBlockType,
      markdown,
      ...(candidate.level === undefined ? {} : { level: candidate.level as MarkdownBlock['level'] }),
      ...(candidate.sourceId === undefined ? {} : { sourceId: candidate.sourceId })
    }
  })
  if (value.warnings.some((warning) => typeof warning !== 'string')) throw new Error(`${label} warnings 无效`)
  return { metadata: metadata as unknown as CoreDocumentMetadata, blocks, warnings: value.warnings as string[] }
}

function parseMediaManifest(value: unknown): DocumentMedia[] {
  if (!Array.isArray(value)) throw new Error('媒体清单格式无效')
  return value.map((candidate, index) => {
    if (
      !isObject(candidate)
      || typeof candidate.id !== 'string'
      || typeof candidate.kind !== 'string'
      || !MEDIA_KINDS.has(candidate.kind as DocumentMedia['kind'])
      || !Number.isInteger(candidate.index)
      || typeof candidate.sourceUrl !== 'string'
      || typeof candidate.status !== 'string'
      || !MEDIA_STATUSES.has(candidate.status as DocumentMedia['status'])
    ) throw new Error(`媒体清单第 ${index + 1} 项格式无效`)
    for (const key of ['localPath', 'blockId', 'alt', 'sourceId'] as const) {
      if (candidate[key] !== undefined && typeof candidate[key] !== 'string') throw new Error(`媒体清单第 ${index + 1} 项 ${key} 无效`)
    }
    return candidate as unknown as DocumentMedia
  })
}

function safeWarnings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, 100).map((value) => value.slice(0, 500))
}

function mediaCounts(media: readonly DocumentMedia[]): { expected: number; localized: number } {
  const supported = media.filter((item) => item.kind !== 'video')
  return {
    expected: supported.length,
    localized: supported.filter((item) => item.status === 'localized' && item.localPath).length
  }
}

function pageMetadata(metadata: CoreDocumentMetadata, media: readonly DocumentMedia[]): DocumentMetadata {
  const counts = mediaCounts(media)
  let siteName: string | undefined
  try { siteName = new URL(metadata.canonicalUrl ?? metadata.sourceUrl).hostname } catch { /* schema parse reports invalid URL */ }
  return {
    sourceUrl: metadata.sourceUrl,
    sourceTitle: (metadata.sourceTitle ?? metadata.title ?? '').slice(0, 1000),
    ...(siteName ? { siteName } : {}),
    ...(metadata.author ? { author: metadata.author.slice(0, 500) } : {}),
    ...(metadata.screenName ? { screenName: metadata.screenName.slice(0, 100) } : {}),
    ...(metadata.publishedAt ? { publishedAt: metadata.publishedAt.slice(0, 100) } : {}),
    contentType: metadata.contentType,
    mediaExpected: counts.expected,
    mediaLocalized: counts.localized,
    ...(metadata.engagement ? { engagement: metadata.engagement } : {})
  }
}

function pageVerification(
  value: unknown,
  source: MarkdownDocument,
  translated: MarkdownDocument,
  media: readonly DocumentMedia[],
  warnings: readonly string[]
): DocumentVerification {
  const fallback = verifyDocumentCompleteness(source, translated)
  const counts = mediaCounts(media)
  const mediaComplete = source.metadata.contentType === 'web' || counts.localized === counts.expected
  if (
    isObject(value)
    && typeof value.valid === 'boolean'
    && Number.isInteger(value.sourceBlocks)
    && Number.isInteger(value.translatedBlocks)
    && Number.isInteger(value.sourceHeadings)
    && Number.isInteger(value.translatedHeadings)
    && Number.isInteger(value.expectedMedia)
    && Number.isInteger(value.localizedMedia)
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === 'string')
  ) {
    return {
      valid: value.valid && mediaComplete,
      sourceBlocks: Number(value.sourceBlocks),
      translatedBlocks: Number(value.translatedBlocks),
      sourceHeadings: Number(value.sourceHeadings),
      translatedHeadings: Number(value.translatedHeadings),
      expectedMedia: Number(value.expectedMedia),
      localizedMedia: Number(value.localizedMedia),
      warnings: safeWarnings([...warnings, ...(value.warnings as string[])])
    }
  }
  const core = isObject(value) && typeof value.ok === 'boolean' && isObject(value.source) && isObject(value.candidate)
    ? value as unknown as DocumentCompletenessVerification
    : fallback
  const issueWarnings = Array.isArray(core.issues)
    ? core.issues.map((issue) => isObject(issue) && typeof issue.message === 'string' ? issue.message : '').filter(Boolean)
    : []
  return {
    valid: Boolean(core.ok) && mediaComplete,
    sourceBlocks: Number(core.source?.blockCount ?? fallback.source.blockCount),
    translatedBlocks: Number(core.candidate?.blockCount ?? fallback.candidate.blockCount),
    sourceHeadings: Number(core.source?.headings ?? fallback.source.headings),
    translatedHeadings: Number(core.candidate?.headings ?? fallback.candidate.headings),
    expectedMedia: counts.expected,
    localizedMedia: counts.localized,
    warnings: safeWarnings([...warnings, ...issueWarnings])
  }
}

function exportDirectoryName(manifest: TaskManifest): string {
  const safe = [...manifest.title]
    .map((character) => (/[/\\:*?"<>|]/u.test(character) || character.charCodeAt(0) < 32 ? ' ' : character))
    .join('')
    .trim()
    .slice(0, 80) || 'document'
  return `${safe}--${manifest.taskId.slice(0, 8)}`
}

function exportedMediaName(item: DocumentMedia, used: Set<string>): string {
  let rawExtension = ''
  try { rawExtension = extname(new URL(item.sourceUrl).pathname).toLocaleLowerCase('en-US') } catch { /* use local path */ }
  const extension = /^\.[a-z0-9]{1,8}$/u.test(rawExtension) ? rawExtension : extname(item.localPath ?? '').toLocaleLowerCase('en-US')
  const safeExtension = /^\.[a-z0-9]{1,8}$/u.test(extension) ? extension : '.bin'
  const base = `${item.kind}-${String(item.index).padStart(3, '0')}`
  let candidate = `${base}${safeExtension}`
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}-${suffix++}${safeExtension}`
  used.add(candidate)
  return candidate
}

function replaceLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value
}

function withFrontmatter(
  markdown: string,
  manifest: TaskManifest,
  document: MarkdownDocument,
  output: 'source' | 'translation'
): string {
  const quoted = (value: string): string => JSON.stringify(value)
  const lines = [
    '---',
    `title: ${quoted(manifest.title)}`,
    `source_url: ${quoted(document.metadata.sourceUrl)}`,
    `etch_task_id: ${quoted(manifest.taskId)}`,
    `output: ${quoted(output)}`,
    `language: ${quoted(output === 'translation' ? manifest.document.targetLanguage : manifest.document.sourceLanguage ?? 'unknown')}`,
    `translation_mode: ${quoted(manifest.document.translationMode)}`,
    `exported_at: ${quoted(new Date().toISOString())}`,
    '---',
    ''
  ]
  return `${lines.join('\n')}${markdown.trimEnd()}\n`
}

export class DocumentService {
  constructor(
    private readonly taskStore: TaskStore,
    private readonly indexStore: IndexStore,
    private readonly ownerWindow: () => BrowserWindow | null
  ) {}

  async page(taskId: string): Promise<DocumentPage> {
    const { directory, manifest } = await this.#task(taskId)
    const base = { taskId, revision: manifest.revision, sourceMarkdown: '', translatedMarkdown: '' }
    if (manifest.kind !== 'document') return { ...base, availability: 'not-ready', message: '当前任务不是网页翻译任务' }
    const sourceArtifact = manifest.artifacts.sourceDocument
    if (!sourceArtifact?.valid) return { ...base, availability: 'not-ready', message: '网页正文还没生成完成' }

    const source = await this.#document(directory, sourceArtifact, '网页源文档')
    const media = await this.#optionalJson(directory, manifest.artifacts.mediaManifest, '媒体清单', MAX_MEDIA_MANIFEST_BYTES, parseMediaManifest) ?? []
    const metadataArtifact = await this.#optionalJson(directory, manifest.artifacts.sourceMetadata, '网页 metadata', MAX_METADATA_BYTES, (value) => {
      if (!isObject(value)) throw new Error('网页 metadata 格式无效')
      return value as unknown as CoreDocumentMetadata
    })
    const metadata = pageMetadata(metadataArtifact ?? source.metadata, media)
    const translatedArtifact = manifest.artifacts.translatedDocument
    if (!translatedArtifact?.valid) {
      return {
        ...base,
        availability: 'not-ready',
        message: '中文 Markdown 还没生成完成',
        sourceMarkdown: renderMarkdownBlocks(source.blocks),
        metadata
      }
    }

    const translated = await this.#document(directory, translatedArtifact, '网页译文')
    const verificationValue = await this.#optionalJson(directory, manifest.artifacts.documentVerification, '文档验证结果', MAX_METADATA_BYTES, (value) => value)
    const warnings = safeWarnings([...manifest.document.warnings, ...source.warnings, ...translated.warnings])
    return {
      ...base,
      availability: 'ready',
      sourceMarkdown: renderMarkdownBlocks(source.blocks),
      translatedMarkdown: renderMarkdownBlocks(translated.blocks),
      metadata,
      verification: pageVerification(verificationValue, source, translated, media, warnings)
    }
  }

  async updateTranslation(taskId: string, expectedRevision: number, markdown: string): Promise<TaskManifest> {
    const { directory, manifest } = await this.#task(taskId)
    this.#assertEditable(manifest)
    if (manifest.revision !== expectedRevision) throw new Error('任务已被更新，请刷新后重试')
    const sourceArtifact = manifest.artifacts.sourceDocument
    const translatedArtifact = manifest.artifacts.translatedDocument
    const translatedMarkdownArtifact = manifest.artifacts.translatedMarkdown
    if (!sourceArtifact?.valid || !translatedArtifact?.valid || !translatedMarkdownArtifact?.valid) {
      throw new Error('源文档或译文产物尚未就绪')
    }
    const [source, current] = await Promise.all([
      this.#document(directory, sourceArtifact, '网页源文档'),
      this.#document(directory, translatedArtifact, '网页译文')
    ])
    const parsed = parseMarkdownBlocks(markdown)
    if (parsed.length !== current.blocks.length) throw new Error(`不能改变文档 block 数：${current.blocks.length} → ${parsed.length}`)
    const blocks = parsed.map((block, index): MarkdownBlock => {
      const template = current.blocks[index]
      if (block.type !== template.type) throw new Error(`第 ${index + 1} 个 block 类型不能从 ${template.type} 改为 ${block.type}`)
      if (template.type === 'heading' && block.level !== template.level) throw new Error(`第 ${index + 1} 个标题层级不能改变`)
      return { ...template, markdown: block.markdown }
    })
    const candidate: MarkdownDocument = { metadata: current.metadata, blocks, warnings: current.warnings }
    const verification = verifyDocumentCompleteness(source, candidate)
    if (!verification.ok) throw new Error(`译文结构校验失败：${verification.issues.slice(0, 3).map((issue) => issue.message).join('；')}`)

    const runId = randomUUID()
    const documentRelativePath = artifactCandidateRelativePath('review', runId, 'translated-document.json')
    const markdownRelativePath = artifactCandidateRelativePath('review', runId, 'translation.md')
    const runDirectory = await ensureArtifactRunDirectory(directory, 'review', runId)
    const documentPath = join(directory, documentRelativePath)
    const markdownPath = join(directory, markdownRelativePath)
    const inputFingerprint = fingerprint('document-review-edit', 1, {
      source: sourceArtifact.sha256,
      previous: translatedArtifact.sha256,
      previousMarkdown: translatedMarkdownArtifact.sha256,
      markdown
    })
    try {
      await Promise.all([
        writeJsonAtomic(documentPath, candidate),
        writeTextAtomic(markdownPath, renderMarkdownBlocks(candidate.blocks))
      ])
      const [documentInfo, documentSha256, markdownInfo, markdownSha256] = await Promise.all([
        stat(documentPath),
        sha256File(documentPath),
        stat(markdownPath),
        sha256File(markdownPath)
      ])
      const documentArtifact: Artifact = {
        relativePath: documentRelativePath,
        sha256: documentSha256,
        size: documentInfo.size,
        valid: true,
        producer: 'document-review-edit',
        inputFingerprint
      }
      const markdownArtifact: Artifact = {
        relativePath: markdownRelativePath,
        sha256: markdownSha256,
        size: markdownInfo.size,
        valid: true,
        producer: 'document-review-edit',
        inputFingerprint
      }
      const next = await this.taskStore.mutate(directory, (draft) => {
        this.#assertEditable(draft)
        if (
          draft.artifacts.sourceDocument?.sha256 !== sourceArtifact.sha256
          || draft.artifacts.translatedDocument?.sha256 !== translatedArtifact.sha256
          || draft.artifacts.translatedMarkdown?.sha256 !== translatedMarkdownArtifact.sha256
        ) {
          throw new Error('文档产物已变化，请刷新后重试')
        }
        draft.artifacts.translatedDocument = documentArtifact
        draft.artifacts.translatedMarkdown = markdownArtifact
        draft.document.translatedBlockCount = candidate.blocks.length
        draft.runtime.currentMessage = '修改已保存，等待确认校对'
      }, expectedRevision)
      this.indexStore.upsert(directory, next)
      return next
    } catch (error) {
      await rm(runDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async export(taskId: string): Promise<ExportDocumentResult> {
    const { directory, manifest } = await this.#task(taskId)
    if (manifest.kind !== 'document') throw new Error('当前任务不是网页翻译任务')
    const sourceArtifact = manifest.artifacts.sourceDocument
    const translatedArtifact = manifest.artifacts.translatedDocument
    const verificationArtifact = manifest.artifacts.documentVerification
    if (manifest.pipeline.stages.verify.status !== 'completed' || !sourceArtifact?.valid || !translatedArtifact?.valid || !verificationArtifact?.valid) {
      throw new Error('文档尚未通过完整性验证，不能导出')
    }
    const [source, translated, media, verificationValue] = await Promise.all([
      this.#document(directory, sourceArtifact, '网页源文档'),
      this.#document(directory, translatedArtifact, '网页译文'),
      this.#optionalJson(directory, manifest.artifacts.mediaManifest, '媒体清单', MAX_MEDIA_MANIFEST_BYTES, parseMediaManifest).then((value) => value ?? []),
      this.#json(directory, verificationArtifact, '文档验证结果', MAX_METADATA_BYTES, (value) => value)
    ])
    if (!pageVerification(verificationValue, source, translated, media, manifest.document.warnings).valid) {
      throw new Error('文档完整性验证未通过，不能导出')
    }
    const options = { title: '选择 Markdown 导出位置', properties: ['openDirectory' as const, 'createDirectory' as const] }
    const owner = this.ownerWindow()
    const selection = owner && !owner.isDestroyed()
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true, media: 0 }

    const target = join(selection.filePaths[0], exportDirectoryName(manifest))
    const targetMedia = join(target, 'media')
    await mkdir(targetMedia, { recursive: true })
    let sourceMarkdown = renderMarkdownBlocks(source.blocks)
    let translatedMarkdown = renderMarkdownBlocks(translated.blocks)
    let copied = 0
    const used = new Set<string>()
    for (const item of media) {
      if (item.status !== 'localized' || !item.localPath) continue
      const artifact = manifest.artifacts[`documentMedia:${item.id}`]
      if (!artifact?.valid || artifact.relativePath !== item.localPath) {
        throw new Error(`网页媒体 ${item.index} 未登记或 artifact 与媒体清单不一致`)
      }
      const file = await readContainedFile(directory, item.localPath, `网页媒体 ${item.index}`, {
        maxBytes: MAX_MEDIA_BYTES,
        expectedSize: artifact.size,
        expectedSha256: artifact.sha256
      })
      const filename = exportedMediaName(item, used)
      await writeFile(join(targetMedia, filename), file.bytes)
      const exportedPath = posix.join('media', filename)
      sourceMarkdown = replaceLiteral(sourceMarkdown, item.localPath, exportedPath)
      translatedMarkdown = replaceLiteral(translatedMarkdown, item.localPath, exportedPath)
      copied += 1
    }
    await Promise.all([
      writeFile(join(target, 'source.md'), withFrontmatter(sourceMarkdown, manifest, source, 'source'), 'utf8'),
      writeFile(join(target, 'translation.md'), withFrontmatter(translatedMarkdown, manifest, translated, 'translation'), 'utf8')
    ])
    return { cancelled: false, directory: target, media: copied }
  }

  async openSource(taskId: string): Promise<void> {
    const { manifest } = await this.#task(taskId)
    if (manifest.kind !== 'document' || manifest.input.kind !== 'url') throw new Error('当前任务没有可打开的网页来源')
    const url = new URL(manifest.input.url)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) throw new Error('网页来源 URL 无效')
    await shell.openExternal(url.toString())
  }

  async #task(taskId: string): Promise<{ directory: string; manifest: TaskManifest }> {
    const indexed = this.indexStore.get(taskId)
    if (!indexed) throw new Error('任务不存在')
    return { directory: indexed.location, manifest: await this.taskStore.load(indexed.location) }
  }

  #assertEditable(manifest: TaskManifest): void {
    const review = manifest.pipeline.stages.review
    if (manifest.kind !== 'document' || review.status !== 'checkpoint' || review.checkpointId !== 'document-review') {
      throw new Error('只有等待人工校对的网页翻译任务可以修改译文')
    }
  }

  async #document(directory: string, artifact: Artifact, label: string): Promise<MarkdownDocument> {
    return this.#json(directory, artifact, label, MAX_DOCUMENT_BYTES, (value) => parseDocument(value, label))
  }

  async #optionalJson<T>(
    directory: string,
    artifact: Artifact | undefined,
    label: string,
    maxBytes: number,
    parse: (value: unknown) => T
  ): Promise<T | undefined> {
    if (!artifact?.valid) return undefined
    return this.#json(directory, artifact, label, maxBytes, parse)
  }

  async #json<T>(
    directory: string,
    artifact: Artifact,
    label: string,
    maxBytes: number,
    parse: (value: unknown) => T
  ): Promise<T> {
    const file = await readContainedFile(directory, artifact.relativePath, label, {
      maxBytes,
      expectedSize: artifact.size,
      expectedSha256: artifact.sha256
    })
    try { return parse(JSON.parse(file.bytes.toString('utf8'))) }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`${label}不是合法 JSON`)
      throw error
    }
  }
}

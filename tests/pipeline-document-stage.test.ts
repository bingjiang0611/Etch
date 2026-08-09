import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '8.8.8.8', family: 4 }]
}))

import { createMarkdownBlocks, type DocumentMedia, type MarkdownDocument } from '../src/core/document'
import { DOCUMENT_TRANSLATION_MAX_BATCHES } from '../src/core/document-translation'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest } from '../src/shared/task-schema'

const directories: string[] = []
const thumbnailPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlHYAAAAASUVORK5CYII=', 'base64')

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('网页翻译流水线', () => {
  it('convert 模式只走文档阶段，本地化图片并在人工校对后完成验证', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-document-stage-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/article' },
      '',
      undefined,
      '',
      'standard',
      false,
      'document',
      '',
      'convert'
    )
    await store.create(directory, manifest)

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url === 'https://example.com/image.png') {
        return new Response(thumbnailPng, { headers: { 'Content-Type': 'image/png' } })
      }
      expect(url).toBe('https://example.com/article')
      return new Response(`<!doctype html><html lang="zh-CN"><head><title>中文文章</title></head><body><article>
        <h1>中文文章</h1>
        <p>这是一段用于验证 Etch 网页转换流程的中文正文，内容足够明确且不需要调用任何翻译 Provider。</p>
        <img src="/image.png" alt="示意图">
      </article></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      undefined,
      undefined,
      undefined,
      fetchMock
    )
    await pipeline.start(directory)

    const checkpoint = await store.load(directory)
    expect(checkpoint.kind).toBe('document')
    expect(checkpoint.pipeline.stages.source.status).toBe('completed')
    expect(checkpoint.pipeline.stages.inspect.status).toBe('completed')
    expect(checkpoint.pipeline.stages.translate.status).toBe('completed')
    expect(checkpoint.pipeline.stages.review).toMatchObject({ status: 'checkpoint', checkpointId: 'document-review' })
    expect(checkpoint.pipeline.stages.english.status).toBe('skipped')
    expect(checkpoint.pipeline.stages.cues.status).toBe('skipped')
    expect(checkpoint.pipeline.stages.audit.status).toBe('skipped')
    expect(checkpoint.pipeline.stages.burn.status).toBe('skipped')
    expect(checkpoint.translation.sessionGenerations).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const source = JSON.parse(await readFile(join(directory, checkpoint.artifacts.sourceDocument.relativePath), 'utf8')) as MarkdownDocument
    const translated = JSON.parse(await readFile(join(directory, checkpoint.artifacts.translatedDocument.relativePath), 'utf8')) as MarkdownDocument
    const media = JSON.parse(await readFile(join(directory, checkpoint.artifacts.mediaManifest.relativePath), 'utf8')) as DocumentMedia[]
    expect(translated.blocks).toEqual(source.blocks)
    expect(media).toMatchObject([{ status: 'localized' }])
    expect(source.blocks.find((block) => block.type === 'image')?.markdown).toContain('.etch-artifacts/inspect/')
    expect(checkpoint.artifacts.thumbnail).toBeUndefined()

    const confirmed = await pipeline.completeReview(directory, checkpoint.revision)
    expect(confirmed.document.reviewCompletedAt).toBeTruthy()
    await pipeline.start(directory)
    const completed = await store.load(directory)
    expect(completed.pipeline.stages.verify.status).toBe('completed')
    expect(completed.artifacts.documentVerification.valid).toBe(true)
    expect(completed.runtime.completedAt).toBeTruthy()
  })

  it('publishes a localized X Article cover through the standard thumbnail artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-document-cover-stage-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://x.com/alice/status/123' },
      '',
      undefined,
      '',
      'standard',
      false,
      'document',
      '',
      'convert'
    )
    await store.create(directory, manifest)

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url === 'https://api.fxtwitter.com/alice/status/123') {
        return new Response(JSON.stringify({
          tweet: {
            lang: 'en',
            author: { name: 'Alice', screen_name: 'alice' },
            article: {
              title: 'Document cover',
              cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/cover.png' } },
              content: {
                blocks: [{ type: 'unstyled', text: 'Document body', inlineStyleRanges: [], entityRanges: [] }],
                entityMap: []
              }
            }
          }
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      expect(url).toBe('https://pbs.twimg.com/cover.png')
      return new Response(thumbnailPng, { headers: { 'Content-Type': 'image/png' } })
    })
    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      undefined,
      undefined,
      undefined,
      fetchMock
    )

    await pipeline.start(directory)

    const checkpoint = await store.load(directory)
    const cover = checkpoint.artifacts['documentMedia:media-001']
    expect(checkpoint.document.resolvedSource).toBe('x-article')
    expect(cover?.valid).toBe(true)
    expect(checkpoint.artifacts.thumbnail).toEqual(cover)
  })

  it('checkpoints a long document before creating or invoking its Provider session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-document-budget-stage-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/legacy-document' },
      'Legacy document',
      'codex',
      '',
      'standard',
      false,
      'document',
      '',
      'translate'
    )
    const warnings = ['未检测到 article/main，已从页面主体提取；请检查正文边界']
    const sourceDocument: MarkdownDocument = {
      metadata: {
        processingMode: 'translate',
        targetLanguage: 'zh-CN',
        fetchedAt: '2026-08-09T00:00:00.000Z',
        contentType: 'web',
        sourceUrl: 'https://example.com/legacy-document',
        sourceLanguage: 'en'
      },
      blocks: createMarkdownBlocks(Array.from({ length: DOCUMENT_TRANSLATION_MAX_BATCHES + 1 }, (_, index) => ({
        type: 'paragraph' as const,
        markdown: `Section ${index + 1}: ${'source text '.repeat(1_100)}`
      }))),
      warnings
    }
    const serialized = `${JSON.stringify(sourceDocument)}\n`
    await writeFile(join(directory, 'source-document.json'), serialized, 'utf8')
    manifest.pipeline.stages.source.status = 'completed'
    manifest.pipeline.stages.inspect.status = 'completed'
    manifest.pipeline.stages.translate.status = 'ready'
    manifest.document.resolvedSource = 'web'
    manifest.document.sourceLanguage = 'en'
    manifest.document.blockCount = sourceDocument.blocks.length
    manifest.document.warnings = warnings
    manifest.artifacts.sourceDocument = {
      relativePath: 'source-document.json',
      sha256: createHash('sha256').update(serialized).digest('hex'),
      size: Buffer.byteLength(serialized),
      valid: true,
      producer: 'test',
      inputFingerprint: '0'.repeat(64)
    }
    await store.create(directory, manifest)
    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined
    )

    await pipeline.start(directory)

    const checkpoint = await store.load(directory)
    expect(checkpoint.pipeline.stages.translate).toMatchObject({
      status: 'checkpoint',
      checkpointId: checkpoint.document.translationCostCheckpoint?.checkpointId
    })
    expect(checkpoint.document.translationCostCheckpoint).toMatchObject({
      batchCount: expect.any(Number),
      characterCount: expect.any(Number)
    })
    expect(checkpoint.document.translationCostCheckpoint!.batchCount).toBeGreaterThan(DOCUMENT_TRANSLATION_MAX_BATCHES)
    expect(checkpoint.translation.activeGenerationId).toBeUndefined()
    expect(checkpoint.translation.sessionGenerations).toEqual([])

    const accepted = await pipeline.resolveDocumentTranslationCost(directory, checkpoint.revision, 'proceed')
    expect(accepted.pipeline.stages.translate.status).toBe('ready')
    expect(accepted.document.translationCostAcceptedFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(accepted.translation.activeGenerationId).toBeUndefined()
  })

  it('stops an in-flight document fetch through the stage abort signal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'etch-document-stop-'))
    directories.push(directory)
    const store = new TaskStore()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/slow' },
      '',
      undefined,
      '',
      'standard',
      false,
      'document',
      '',
      'convert'
    )
    await store.create(directory, manifest)

    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error('missing abort signal'))
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const pipeline = new TaskPipeline(
      store,
      defaultSettings('/Users/test'),
      new HistoricalGlossaryService(store, () => []),
      () => undefined,
      undefined,
      undefined,
      undefined,
      fetchMock
    )

    const running = pipeline.start(directory)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await pipeline.stop(directory)
    await running

    const stopped = await store.load(directory)
    expect(stopped.runtime.userPaused).toBe(true)
    expect(stopped.pipeline.stages.source.status).toBe('paused')
  })
})

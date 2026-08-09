import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  openExternal: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: electron.showOpenDialog },
  shell: { openExternal: electron.openExternal }
}))

import type { DocumentMedia, MarkdownDocument } from '../src/core/document'
import { DocumentService } from '../src/main/document-service'
import { sha256File } from '../src/main/core/fingerprint'
import { IndexStore } from '../src/main/storage/index-store'
import { TaskStore } from '../src/main/storage/task-store'
import { createTaskManifest, type TaskManifest } from '../src/shared/task-schema'

type Artifact = TaskManifest['artifacts'][string]

const directories: string[] = []

afterEach(async () => {
  electron.showOpenDialog.mockReset()
  electron.openExternal.mockReset()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function artifact(directory: string, relativePath: string): Promise<Artifact> {
  const path = join(directory, relativePath)
  const info = await stat(path)
  return {
    relativePath,
    sha256: await sha256File(path),
    size: info.size,
    valid: true,
    producer: 'fixture',
    inputFingerprint: '1'.repeat(64)
  }
}

function document(blocks: MarkdownDocument['blocks']): MarkdownDocument {
  return {
    metadata: {
      processingMode: 'convert',
      contentType: 'web',
      sourceUrl: 'https://example.com/article',
      fetchedAt: '2026-08-09T00:00:00.000Z',
      targetLanguage: 'zh-CN',
      sourceTitle: 'Example'
    },
    blocks,
    warnings: []
  }
}

async function fixture(options: { withMedia?: boolean; completed?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'etch-document-service-'))
  directories.push(directory)
  const source = document([
    { id: 'block-0001', type: 'heading', level: 1, markdown: '# Original' },
    { id: 'block-0002', type: 'paragraph', markdown: 'Original paragraph.' }
  ])
  const translated = document([
    { id: 'block-0001', type: 'heading', level: 1, markdown: '# 原标题' },
    { id: 'block-0002', type: 'paragraph', markdown: '原译文。' }
  ])
  const media: DocumentMedia[] = []
  if (options.withMedia) {
    const localPath = '.etch-artifacts/inspect/media-run/media-001.png'
    source.blocks.push({ id: 'block-0003', type: 'image', markdown: `![图](${localPath})` })
    translated.blocks.push({ id: 'block-0003', type: 'image', markdown: `![图](${localPath})` })
    media.push({
      id: 'media-001',
      kind: 'image',
      index: 1,
      sourceUrl: 'https://example.com/image.png',
      localPath,
      blockId: 'block-0003',
      status: 'localized'
    })
    await mkdir(dirname(join(directory, localPath)), { recursive: true })
    await writeFile(join(directory, localPath), Buffer.from([1, 2, 3, 4]))
  }
  await Promise.all([
    writeFile(join(directory, 'source-document.json'), `${JSON.stringify(source)}\n`),
    writeFile(join(directory, 'translated-document.json'), `${JSON.stringify(translated)}\n`),
    writeFile(join(directory, 'translated.md'), `${translated.blocks.map((block) => block.markdown).join('\n\n')}\n`),
    writeFile(join(directory, 'media-manifest.json'), `${JSON.stringify(media)}\n`),
    writeFile(join(directory, 'document-verification.json'), `${JSON.stringify({
      valid: true,
      sourceBlocks: source.blocks.length,
      translatedBlocks: translated.blocks.length,
      sourceHeadings: 1,
      translatedHeadings: 1,
      expectedMedia: media.length,
      localizedMedia: media.length,
      warnings: []
    })}\n`)
  ])
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://example.com/article' },
    'Example',
    undefined,
    '',
    'standard',
    false,
    'document',
    '',
    'convert'
  )
  manifest.artifacts.sourceDocument = await artifact(directory, 'source-document.json')
  manifest.artifacts.translatedDocument = await artifact(directory, 'translated-document.json')
  manifest.artifacts.translatedMarkdown = await artifact(directory, 'translated.md')
  manifest.artifacts.mediaManifest = await artifact(directory, 'media-manifest.json')
  manifest.artifacts.documentVerification = await artifact(directory, 'document-verification.json')
  if (media[0]?.localPath) manifest.artifacts[`documentMedia:${media[0].id}`] = await artifact(directory, media[0].localPath)
  for (const stage of ['source', 'inspect', 'translate'] as const) manifest.pipeline.stages[stage].status = 'completed'
  if (options.completed) {
    manifest.pipeline.stages.review.status = 'completed'
    manifest.pipeline.stages.verify.status = 'completed'
    manifest.document.reviewCompletedAt = '2026-08-09T00:01:00.000Z'
    manifest.runtime.completedAt = '2026-08-09T00:02:00.000Z'
  } else {
    manifest.pipeline.stages.review.status = 'checkpoint'
    manifest.pipeline.stages.review.checkpointId = 'document-review'
  }
  const store = new TaskStore()
  const index = new IndexStore()
  await store.create(directory, manifest)
  index.upsert(directory, manifest)
  return { directory, manifest, store, index, service: new DocumentService(store, index, () => null) }
}

describe('DocumentService', () => {
  it('同一 review run 原子换代 JSON 与 Markdown artifact', async () => {
    const item = await fixture()
    const previousDocument = item.manifest.artifacts.translatedDocument.relativePath
    const previousMarkdown = item.manifest.artifacts.translatedMarkdown.relativePath

    const next = await item.service.updateTranslation(item.manifest.taskId, item.manifest.revision, '# 新标题\n\n新译文。\n')

    expect(next.artifacts.translatedDocument.relativePath).not.toBe(previousDocument)
    expect(next.artifacts.translatedMarkdown.relativePath).not.toBe(previousMarkdown)
    expect(dirname(next.artifacts.translatedDocument.relativePath)).toBe(dirname(next.artifacts.translatedMarkdown.relativePath))
    expect(await readFile(join(item.directory, next.artifacts.translatedMarkdown.relativePath), 'utf8')).toBe('# 新标题\n\n新译文。\n')
    const saved = JSON.parse(await readFile(join(item.directory, next.artifacts.translatedDocument.relativePath), 'utf8')) as MarkdownDocument
    expect(saved.blocks.map((block) => block.markdown)).toEqual(['# 新标题', '新译文。'])
    expect(next.artifacts.translatedDocument.sha256).toBe(await sha256File(join(item.directory, next.artifacts.translatedDocument.relativePath)))
    expect(next.artifacts.translatedMarkdown.sha256).toBe(await sha256File(join(item.directory, next.artifacts.translatedMarkdown.relativePath)))
  })

  it('导出只接受媒体清单与 manifest artifact 一致且哈希有效的本地媒体', async () => {
    const item = await fixture({ withMedia: true, completed: true })
    const target = await mkdtemp(join(tmpdir(), 'etch-document-export-'))
    directories.push(target)
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [target] })

    const exported = await item.service.export(item.manifest.taskId)
    expect(exported).toMatchObject({ cancelled: false, media: 1 })
    expect(await readFile(join(exported.directory!, 'media/image-001.png'))).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(await readFile(join(exported.directory!, 'translation.md'), 'utf8')).toContain('![图](media/image-001.png)')

    await writeFile(join(item.directory, '.etch-artifacts/inspect/media-run/media-001.png'), Buffer.from([4, 3, 2, 1]))
    await expect(item.service.export(item.manifest.taskId)).rejects.toThrow('SHA-256 不匹配')
  })

  it('localized media 没有对应 manifest artifact 时拒绝导出', async () => {
    const item = await fixture({ withMedia: true, completed: true })
    const current = await item.store.load(item.directory)
    const next = await item.store.mutate(item.directory, (manifest) => {
      delete manifest.artifacts['documentMedia:media-001']
    }, current.revision)
    item.index.upsert(item.directory, next)
    electron.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [item.directory] })

    await expect(item.service.export(next.taskId)).rejects.toThrow('未登记或 artifact 与媒体清单不一致')
  })
})

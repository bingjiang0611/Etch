import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HistoricalGlossaryService } from '../src/main/historical-glossary'
import { TaskPipeline } from '../src/main/pipeline/task-pipeline'
import { TaskStore } from '../src/main/storage/task-store'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest } from '../src/shared/task-schema'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(kind: 'subtitle' | 'summary' | 'document') {
  const directory = await mkdtemp(join(tmpdir(), 'etch-checkpoint-publication-'))
  directories.push(directory)
  const store = new TaskStore()
  const manifest = createTaskManifest(
    { kind: 'url', url: 'https://example.com/checkpoint' },
    '',
    kind === 'subtitle' ? undefined : 'qoder',
    '',
    'standard',
    false,
    kind,
    '',
    kind === 'document' ? 'translate' : 'auto'
  )
  const onManifest = vi.fn()
  const pipeline = new TaskPipeline(
    store,
    defaultSettings('/Users/test'),
    new HistoricalGlossaryService(store, () => []),
    onManifest
  )
  return { directory, manifest, onManifest, pipeline, store }
}

describe('checkpoint resolver publication', () => {
  it('publishes a cancelled video checkpoint immediately', async () => {
    const item = await fixture('subtitle')
    const checkpointId = randomUUID()
    item.manifest.pipeline.stages.inspect = { status: 'checkpoint', attempt: 1, checkpointId }
    item.manifest.video.checkpoint = {
      kind: 'low-resolution',
      checkpointId,
      stage: 'inspect',
      inputFingerprint: 'a'.repeat(64),
      summary: '低清视频',
      metrics: { width: 640, height: 360 },
      createdAt: new Date().toISOString()
    }
    await item.store.create(item.directory, item.manifest)

    const updated = await item.pipeline.resolveVideoCheckpoint(item.directory, item.manifest.revision, 'cancel')

    expect(updated.runtime.userPaused).toBe(true)
    expect(item.onManifest).toHaveBeenCalledOnce()
    expect(item.onManifest).toHaveBeenCalledWith(item.directory, updated)
  })

  it('publishes a cancelled research checkpoint immediately', async () => {
    const item = await fixture('summary')
    item.manifest.pipeline.stages.research = { status: 'checkpoint', attempt: 1, checkpointId: randomUUID() }
    item.manifest.summary.research.status = 'checkpoint'
    await item.store.create(item.directory, item.manifest)

    const updated = await item.pipeline.resolveResearchCheckpoint(item.directory, item.manifest.revision, 'cancel')

    expect(updated.runtime.userPaused).toBe(true)
    expect(item.onManifest).toHaveBeenCalledOnce()
    expect(item.onManifest).toHaveBeenCalledWith(item.directory, updated)
  })

  it('publishes a cancelled document cost checkpoint immediately', async () => {
    const item = await fixture('document')
    const checkpointId = randomUUID()
    item.manifest.pipeline.stages.translate = { status: 'checkpoint', attempt: 1, checkpointId }
    item.manifest.document.translationCostCheckpoint = {
      checkpointId,
      inputFingerprint: 'b'.repeat(64),
      batchCount: 13,
      characterCount: 130_000
    }
    await item.store.create(item.directory, item.manifest)

    const updated = await item.pipeline.resolveDocumentTranslationCost(item.directory, item.manifest.revision, 'cancel')

    expect(updated.runtime.userPaused).toBe(true)
    expect(item.onManifest).toHaveBeenCalledOnce()
    expect(item.onManifest).toHaveBeenCalledWith(item.directory, updated)
  })
})

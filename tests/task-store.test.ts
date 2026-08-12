import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint } from '../src/main/core/fingerprint'
import {
  activeSessionGenerationDrifted,
  activateSessionGeneration,
  replaceContaminatedSessionGeneration,
  replaceLostSessionGeneration
} from '../src/main/pipeline/session-generation'
import { PROVIDER_SESSION_CONTAMINATED_PREFIX } from '../src/main/providers/session-errors'
import { createTaskManifest, migrateTaskManifest } from '../src/shared/task-schema'
import { StaleStepError, TaskStore } from '../src/main/storage/task-store'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function taskDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'etch-task-'))
  directories.push(path)
  return path
}

describe('TaskStore CAS', () => {
  it('preserves a lost generation and creates an explicit resume replacement', async () => {
    const directory = await taskDirectory()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
    const original = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')
    original.externalSessionId = 'lost-session'

    const replacement = replaceLostSessionGeneration(manifest, directory)

    expect(original).toMatchObject({ status: 'lost', reason: 'initial', externalSessionId: 'lost-session' })
    expect(original.closedAt).toBeDefined()
    expect(replacement).toMatchObject({ status: 'active', reason: 'resume-replacement', provider: 'codex' })
    expect(replacement.externalSessionId).toBeUndefined()
    expect(manifest.translation.activeGenerationId).toBe(replacement.id)
  })

  it('replaces a contaminated generation even when no external session ID was observed', async () => {
    const directory = await taskDirectory()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
    const original = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')

    const replacement = replaceContaminatedSessionGeneration(manifest, directory)

    expect(original).toMatchObject({ status: 'lost', reason: 'initial' })
    expect(original.externalSessionId).toBeUndefined()
    expect(replacement).toMatchObject({ status: 'active', reason: 'resume-replacement', provider: 'codex' })
    expect(manifest.translation.activeGenerationId).toBe(replacement.id)
  })

  it('stores the selected Qoder provider and model verbatim', async () => {
    const directory = await taskDirectory()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'qoder')
    const generation = activateSessionGeneration(
      manifest,
      'qoder',
      { source: 'user-entered', modelId: 'DeepSeek-V4-Pro' },
      directory,
      'initial'
    )

    expect(generation.provider).toBe('qoder')
    expect(generation.model).toEqual({ source: 'user-entered', modelId: 'DeepSeek-V4-Pro' })
    expect(generation.stateRoot).toContain('provider-state/qoder/')
  })

  it.each(['lost', 'contaminated'] as const)(
    'realigns a drifted %s replacement generation with the selected provider and model',
    async (reason) => {
      const directory = await taskDirectory()
      const manifest = createTaskManifest(
        { kind: 'url', url: 'https://example.com/video' },
        '',
        'qoder',
        '',
        'standard',
        false,
        'document'
      )
      manifest.translation.selectedModel = { source: 'discovered', modelId: 'DeepSeek-V4-Pro' }
      const drifted = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')
      if (reason === 'lost') drifted.externalSessionId = '019f7e34-385f-7de3-9fac-000000000001'

      const replacement = reason === 'lost'
        ? replaceLostSessionGeneration(manifest, directory)
        : replaceContaminatedSessionGeneration(manifest, directory)

      expect(drifted.status).toBe('lost')
      expect(replacement.provider).toBe('qoder')
      expect(replacement.model).toEqual({ source: 'discovered', modelId: 'DeepSeek-V4-Pro' })
      expect(replacement.stateRoot).toContain('provider-state/qoder/')
    }
  )

  it('detects provider and model drift without flagging the selected active generation', async () => {
    const directory = await taskDirectory()
    const manifest = createTaskManifest(
      { kind: 'url', url: 'https://example.com/video' },
      '',
      'qoder',
      '',
      'standard',
      false,
      'document'
    )
    manifest.translation.selectedModel = { source: 'discovered', modelId: 'DeepSeek-V4-Pro' }
    activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')

    expect(activeSessionGenerationDrifted(manifest)).toBe(true)

    replaceContaminatedSessionGeneration(manifest, directory)
    expect(activeSessionGenerationDrifted(manifest)).toBe(false)
  })

  it('does not switch a non-document replacement to a different selected provider', async () => {
    const directory = await taskDirectory()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'qoder')
    const drifted = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')

    const replacement = replaceContaminatedSessionGeneration(manifest, directory)

    expect(drifted.status).toBe('lost')
    expect(replacement).toMatchObject({ provider: 'codex', model: { source: 'cli-default' } })
  })

  it('uses the full URL or local source path as the default task title', () => {
    const url = 'https://example.com/watch?v=etch'
    const sourcePath = '/Users/example/Videos/source.mp4'
    expect(createTaskManifest({ kind: 'url', url }).title).toBe(url)
    expect(createTaskManifest({ kind: 'local', sourcePath }).title).toBe(sourcePath)

    const legacy = createTaskManifest({ kind: 'url', url })
    legacy.title = '   '
    expect(migrateTaskManifest(legacy).title).toBe(url)
    const withoutManualEdits = structuredClone(legacy) as unknown as { translation: { manualEdits?: unknown } }
    delete withoutManualEdits.translation.manualEdits
    expect(migrateTaskManifest(withoutManualEdits).translation.manualEdits).toEqual([])

    const styled = createTaskManifest({ kind: 'url', url }, '', 'codex', '  简洁自然  ')
    expect(styled.translation.styleNote).toBe('简洁自然')
    const withoutStyle = structuredClone(styled) as unknown as { translation: { styleNote?: unknown } }
    delete withoutStyle.translation.styleNote
    expect(migrateTaskManifest(withoutStyle).translation.styleNote).toBe('')
    const withoutRender = structuredClone(styled) as unknown as { render?: unknown }
    delete withoutRender.render
    expect(migrateTaskManifest(withoutRender).render.subtitlePreset).toBe('standard')
    expect(createTaskManifest({ kind: 'url', url }, '', 'codex', '', 'large').render.subtitlePreset).toBe('large')
  })

  it('commits a lease only against its frozen revision and fingerprint', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'url', url: 'https://example.com/video' }))
    const input = fingerprint('source', 1, { url: 'https://example.com/video' })
    const lease = await store.acquireLease(directory, 'source', input, '正在下载并整理源视频')
    expect((await store.load(directory)).runtime.currentMessage).toBe('正在下载并整理源视频')
    const committed = await store.commitLease(directory, lease, input, (manifest) => {
      manifest.title = 'Video'
    })
    expect(committed.title).toBe('Video')
    expect(committed.pipeline.stages.source.status).toBe('completed')
    expect(committed.revision).toBe(2)
  })

  it('persists a user stop as paused and resumes the same safe stage without losing completed work', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    manifest.pipeline.stages.source.status = 'completed'
    manifest.pipeline.stages.inspect.status = 'ready'
    await store.create(directory, manifest)
    const input = fingerprint('inspect', 1, { source: 'ready' })
    const lease = await store.acquireLease(directory, 'inspect', input)

    const paused = await store.pauseLease(directory, lease)

    expect(paused.pipeline.stages.source.status).toBe('completed')
    expect(paused.pipeline.stages.inspect).toMatchObject({ status: 'paused' })
    expect(paused.pipeline.stages.inspect.activeLease).toBeUndefined()
    expect(paused.runtime).toMatchObject({ userPaused: true, currentMessage: '已停止，可随时继续处理' })

    const resumed = await store.resumePaused(directory)
    expect(resumed.pipeline.stages.source.status).toBe('completed')
    expect(resumed.pipeline.stages.inspect.status).toBe('ready')
    expect(resumed.runtime).toMatchObject({ userPaused: false, currentMessage: '等待继续处理' })
  })

  it('defers a lease cancelled by the global acquisition gate without pausing the task', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'url', url: 'https://example.com/video' }))
    const lease = await store.acquireLease(directory, 'source', fingerprint('source', 1, { url: 'https://example.com/video' }))

    const deferred = await store.deferLease(directory, lease)

    expect(deferred.pipeline.stages.source).toMatchObject({ status: 'ready', attempt: 0 })
    expect(deferred.pipeline.stages.source.activeLease).toBeUndefined()
    expect(deferred.runtime.userPaused).toBe(false)
    expect(deferred.runtime.currentMessage).toContain('队列已暂停')
  })

  it('persists a provider session inside an active lease and advances its CAS revision', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
    const generation = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')
    await store.create(directory, manifest)
    const input = fingerprint('cues', 1, { generationId: generation.id })
    const lease = await store.acquireLease(directory, 'cues', input)

    const persisted = await store.persistLeaseExternalSession(directory, lease, input, generation.id, 'provider-session-1')

    expect(persisted.manifest.revision).toBe(2)
    expect(persisted.lease.manifestRevision).toBe(2)
    expect(persisted.manifest.pipeline.stages.cues.activeLease).toEqual(persisted.lease)
    expect(persisted.manifest.translation.sessionGenerations[0].externalSessionId).toBe('provider-session-1')
    const committed = await store.commitLease(directory, persisted.lease, input, () => undefined)
    expect(committed).toMatchObject({ revision: 3 })
    expect(committed.pipeline.stages.cues.status).toBe('completed')
  })

  it('atomically persists partial stage progress and renews the active lease', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
    await store.create(directory, manifest)
    const input = fingerprint('translate', 1, { source: 'cues-v1' })
    const lease = await store.acquireLease(directory, 'translate', input)

    const persisted = await store.persistLeaseProgress(directory, lease, input, (draft) => {
      draft.translation.batches = [{
        id: 'batch-001',
        startCue: 1,
        endCue: 50,
        inputFingerprint: 'a'.repeat(64),
        status: 'verified',
        attempt: 1,
        artifact: {
          relativePath: '.etch-artifacts/translate/run/batch-001.tsv',
          sha256: 'b'.repeat(64),
          size: 128,
          valid: true,
          producer: 'test',
          inputFingerprint: 'a'.repeat(64)
        }
      }]
      draft.pipeline.stages.translate.progress = 0.5
    })

    expect(persisted.manifest.revision).toBe(2)
    expect(persisted.lease.manifestRevision).toBe(2)
    expect(persisted.manifest.pipeline.stages.translate).toMatchObject({
      status: 'running',
      progress: 0.5,
      activeLease: persisted.lease
    })
    expect(persisted.manifest.translation.batches[0]).toMatchObject({ status: 'verified', attempt: 1 })
    const committed = await store.commitLease(directory, persisted.lease, input, () => undefined)
    expect(committed.pipeline.stages.translate.status).toBe('completed')
  })

  it('rejects partial progress from a stale lease after a concurrent manifest change', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'url', url: 'https://example.com/video' }))
    const input = fingerprint('translate', 1, { source: 'cues-v1' })
    const lease = await store.acquireLease(directory, 'translate', input)
    await store.mutate(directory, (draft) => { draft.title = 'concurrent update' })

    await expect(store.persistLeaseProgress(
      directory,
      lease,
      input,
      (draft) => { draft.pipeline.stages.translate.progress = 0.5 }
    )).rejects.toBeInstanceOf(StaleStepError)
  })

  it('rejects session drift while a lease is active', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
    const generation = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')
    await store.create(directory, manifest)
    const input = fingerprint('cues', 1, { generationId: generation.id })
    const lease = await store.acquireLease(directory, 'cues', input)
    const persisted = await store.persistLeaseExternalSession(directory, lease, input, generation.id, 'provider-session-1')

    await expect(store.persistLeaseExternalSession(
      directory,
      persisted.lease,
      input,
      generation.id,
      'provider-session-2'
    )).rejects.toThrow('session \u53d1\u751f\u6f02\u79fb')
  })

  it('rejects persisting a provider session after a concurrent manifest mutation', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
    const generation = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')
    await store.create(directory, manifest)
    const input = fingerprint('cues', 1, { generationId: generation.id })
    const lease = await store.acquireLease(directory, 'cues', input)
    await store.mutate(directory, (draft) => { draft.title = 'concurrent update' })

    await expect(store.persistLeaseExternalSession(
      directory,
      lease,
      input,
      generation.id,
      'provider-session-1'
    )).rejects.toBeInstanceOf(StaleStepError)
  })

  it('rejects an old worker after a concurrent user mutation', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'local', sourcePath: '/tmp/video.mp4' }))
    const input = fingerprint('source', 1, { path: '/tmp/video.mp4' })
    const lease = await store.acquireLease(directory, 'source', input)
    await store.mutate(directory, (manifest) => { manifest.title = '用户的新标题' })
    await expect(store.commitLease(directory, lease, input, () => undefined)).rejects.toBeInstanceOf(StaleStepError)
  })

  it('rejects acquiring a lease after the fingerprint source revision changed', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'url', url: 'https://example.com/video' }))
    const before = await store.load(directory)
    await store.mutate(directory, (manifest) => { manifest.title = 'concurrent update' })
    await expect(store.acquireLease(
      directory,
      'source',
      fingerprint('source', 1, { url: 'https://example.com/video' }),
      undefined,
      before.revision
    )).rejects.toThrow('请刷新后重试')
  })

  it('rejects a user mutation based on an old task revision', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'url', url: 'https://example.com/video' }))
    await store.mutate(directory, (manifest) => { manifest.title = 'new title' })
    await expect(store.mutate(directory, () => undefined, 0)).rejects.toThrow('请刷新后重试')
  })

  it('recovers an interrupted lease without discarding completed stages', async () => {
    const directory = await taskDirectory()
    const store = new TaskStore()
    await store.create(directory, createTaskManifest({ kind: 'url', url: 'https://example.com/video' }))
    const input = fingerprint('source', 1, { url: 'https://example.com/video' })
    await store.acquireLease(directory, 'source', input)
    const recovered = await store.recoverInterrupted(directory)
    expect(recovered.pipeline.stages.source.status).toBe('failed')
    expect(recovered.pipeline.stages.source.activeLease).toBeUndefined()
    expect(recovered.runtime.currentMessage).toContain('异常退出')
  })

  it.each(['cues', 'translate', 'audit'] as const)(
    'taints the active provider generation when interrupted during %s',
    async (stage) => {
      const directory = await taskDirectory()
      const store = new TaskStore()
      const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' }, '', 'codex')
      const generation = activateSessionGeneration(manifest, 'codex', { source: 'cli-default' }, directory, 'initial')
      generation.externalSessionId = 'possibly-partial-session'
      await store.create(directory, manifest)
      await store.acquireLease(directory, stage, fingerprint(stage, 1, { generationId: generation.id }))

      const recovered = await store.recoverInterrupted(directory)

      expect(recovered.pipeline.stages[stage]).toMatchObject({
        status: 'failed',
        errorCode: expect.stringContaining(PROVIDER_SESSION_CONTAMINATED_PREFIX)
      })
      expect(recovered.pipeline.stages[stage].activeLease).toBeUndefined()
      expect(recovered.translation.activeGenerationId).toBe(generation.id)
      expect(recovered.runtime.currentMessage).toContain('废弃旧 session')
    }
  )
})

import { describe, expect, it } from 'vitest'
import { initialBilibiliPublishForm, publishBilibiliDraftAndRemember, reconcileBilibiliPartitionTid } from '../src/renderer/bilibili-publish-form'
import {
  BILIBILI_PUBLISH_PREFERENCES_STORAGE_KEY,
  loadBilibiliPublishPreferences,
  saveBilibiliPublishPreferences
} from '../src/renderer/bilibili-publish-preferences'
import type { TaskDetail } from '../src/shared/ipc'
import { defaultSettings } from '../src/shared/settings-schema'
import { createTaskManifest } from '../src/shared/task-schema'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) }
  }
}

function task(input: Parameters<typeof createTaskManifest>[0], title: string): TaskDetail {
  return { taskDirectory: '/tmp/etch-task', manifest: createTaskManifest(input, title) }
}

describe('B站手动投稿偏好', () => {
  it('round-trips the last confirmed partition, tags and copyright', () => {
    const storage = memoryStorage()
    saveBilibiliPublishPreferences(storage, { tid: 21, tags: ['双语字幕', 'AI'], copyright: 'original' })

    expect(loadBilibiliPublishPreferences(storage)).toEqual({
      tid: 21,
      tags: ['双语字幕', 'AI'],
      copyright: 'original'
    })
  })

  it.each([
    ['invalid JSON', '{'],
    ['invalid tid', JSON.stringify({ schemaVersion: 1, tid: 0, tags: ['字幕'], copyright: 'repost' })],
    ['empty tags', JSON.stringify({ schemaVersion: 1, tid: 21, tags: [], copyright: 'repost' })],
    ['too many tags', JSON.stringify({ schemaVersion: 1, tid: 21, tags: Array.from({ length: 11 }, (_, index) => `标签${index}`), copyright: 'repost' })],
    ['long tag', JSON.stringify({ schemaVersion: 1, tid: 21, tags: ['标'.repeat(21)], copyright: 'repost' })],
    ['invalid copyright', JSON.stringify({ schemaVersion: 1, tid: 21, tags: ['字幕'], copyright: 'unknown' })]
  ])('discards %s', (_label, value) => {
    const storage = memoryStorage()
    storage.values.set(BILIBILI_PUBLISH_PREFERENCES_STORAGE_KEY, value)

    expect(loadBilibiliPublishPreferences(storage)).toBeUndefined()
    expect(storage.values.size).toBe(0)
  })

  it('tolerates unavailable renderer storage', () => {
    const unavailable = {
      getItem: (): string | null => { throw new Error('unavailable') },
      setItem: (): void => { throw new Error('unavailable') },
      removeItem: (): void => { throw new Error('unavailable') }
    }
    expect(loadBilibiliPublishPreferences(unavailable)).toBeUndefined()
    expect(() => saveBilibiliPublishPreferences(unavailable, { tid: 21, tags: ['字幕'], copyright: 'repost' })).not.toThrow()
    const unavailableGetter = (): typeof unavailable => { throw new Error('unavailable') }
    expect(loadBilibiliPublishPreferences(unavailableGetter)).toBeUndefined()
    expect(() => saveBilibiliPublishPreferences(unavailableGetter, { tid: 21, tags: ['字幕'], copyright: 'repost' })).not.toThrow()
  })

  it('prefers a task draft, then recent preferences, then the configured template and input default', () => {
    const settings = defaultSettings('/Users/test')
    settings.bilibiliPublishTemplate = {
      tid: 21,
      partitionName: '生活 · 日常',
      tags: ['模板标签'],
      descriptionTemplate: '{title}\n\n来源：{source_url}'
    }
    const detail = task({ kind: 'url', url: 'https://example.com/current' }, '当前任务')
    const recent = { tid: 171, tags: ['最近标签'], copyright: 'original' as const }

    expect(initialBilibiliPublishForm(detail, settings, recent)).toMatchObject({
      title: '当前任务',
      tid: '171',
      tags: '最近标签',
      copyright: 'original',
      source: 'https://example.com/current'
    })
    expect(initialBilibiliPublishForm(detail, settings)).toMatchObject({
      tid: '21',
      tags: '模板标签',
      copyright: 'repost',
      source: 'https://example.com/current'
    })

    detail.manifest.publication.draft = {
      title: '任务草稿',
      tid: 160,
      partitionName: '生活',
      tags: ['草稿标签'],
      description: '草稿简介',
      copyright: 'repost',
      source: 'https://example.com/draft',
      finalSha256: 'a'.repeat(64)
    }
    expect(initialBilibiliPublishForm(detail, settings, recent)).toMatchObject({
      title: '任务草稿',
      tid: '160',
      tags: '草稿标签',
      copyright: 'repost',
      source: 'https://example.com/draft'
    })

    const local = task({ kind: 'local', sourcePath: '/tmp/video.mp4' }, '本地任务')
    expect(initialBilibiliPublishForm(local, settings)).toMatchObject({
      tid: '21',
      tags: '模板标签',
      copyright: 'original',
      source: ''
    })
  })

  it('falls back from a removed recent partition but requires confirmation for a removed task draft partition', () => {
    const partitions = [
      { tid: 138, name: '搞笑', parentName: '生活' },
      { tid: 21, name: '日常', parentName: '生活' }
    ]
    expect(reconcileBilibiliPartitionTid('138', partitions, 21)).toBe('138')
    expect(reconcileBilibiliPartitionTid('999', partitions, 21)).toBe('21')
    expect(reconcileBilibiliPartitionTid('999', partitions, 999)).toBe('138')
    expect(reconcileBilibiliPartitionTid('999', partitions, 21, true)).toBe('')
  })

  it('remembers only after the publication is accepted into the local queue', async () => {
    const storage = memoryStorage()
    const detail = task({ kind: 'url', url: 'https://example.com/current' }, '当前任务')
    const draft = {
      title: '当前任务',
      tid: 138,
      partitionName: '生活 · 搞笑',
      tags: ['最近标签'],
      description: '简介',
      copyright: 'original' as const,
      source: '',
      finalSha256: 'a'.repeat(64)
    }

    await expect(publishBilibiliDraftAndRemember(async (taskId, submittedDraft) => {
      expect(taskId).toBe(detail.manifest.taskId)
      expect(submittedDraft).toBe(draft)
      return detail
    }, storage, detail.manifest.taskId, draft)).resolves.toBe(detail)
    expect(loadBilibiliPublishPreferences(storage)).toEqual({ tid: 138, tags: ['最近标签'], copyright: 'original' })

    storage.values.clear()
    await expect(publishBilibiliDraftAndRemember(async () => Promise.reject(new Error('failed')), storage, detail.manifest.taskId, draft)).rejects.toThrow('failed')
    expect(loadBilibiliPublishPreferences(storage)).toBeUndefined()
  })
})

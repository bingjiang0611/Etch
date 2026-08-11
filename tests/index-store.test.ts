import { describe, expect, it } from 'vitest'
import { IndexStore } from '../src/main/storage/index-store'
import { createTaskManifest } from '../src/shared/task-schema'

describe('IndexStore', () => {
  it('rebuilds, sorts and paginates the discovered tasks', () => {
    const store = new IndexStore()
    const older = createTaskManifest({ kind: 'url', url: 'https://example.com/older' }, 'Older title')
    const newer = createTaskManifest({ kind: 'local', sourcePath: '/videos/newer.mp4' }, 'Newer title')
    older.createdAt = '2026-07-28T00:00:00.000Z'
    older.updatedAt = '2026-07-30T00:00:00.000Z'
    newer.createdAt = '2026-07-29T00:00:00.000Z'
    newer.updatedAt = '2026-07-29T00:00:00.000Z'

    store.rebuild([
      { location: '/tasks/older', manifest: older },
      { location: '/tasks/newer', manifest: newer }
    ])

    expect(store.all().map((task) => task.taskId)).toEqual([newer.taskId, older.taskId])
    expect(store.get(newer.taskId)).toMatchObject({ rootTaskId: newer.taskId, createdAt: newer.createdAt })
    expect(store.list(1, 1)).toEqual([expect.objectContaining({ taskId: older.taskId })])
    expect(store.list()).toEqual([
      expect.objectContaining({ taskId: newer.taskId }),
      expect.objectContaining({ taskId: older.taskId })
    ])
    expect(store.count()).toBe(2)
  })

  it('keeps the newest manifest when an older publication arrives late', () => {
    const store = new IndexStore()
    const newest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    newest.revision = 2
    newest.title = 'newest'
    const stale = structuredClone(newest)
    stale.revision = 1
    stale.title = 'stale'

    store.upsert('/tasks/video', newest)
    store.upsert('/tasks/video', stale)

    expect(store.get(newest.taskId)).toMatchObject({ revision: 2, title: 'newest' })
  })

  it('replaces the snapshot on rebuild and reports deletion truthfully', () => {
    const store = new IndexStore()
    const removed = createTaskManifest({ kind: 'url', url: 'https://example.com/removed' })
    const retained = createTaskManifest({ kind: 'url', url: 'https://example.com/retained' })
    store.upsert('/tasks/removed', removed)

    store.rebuild([{ location: '/tasks/retained', manifest: retained }])

    expect(store.get(removed.taskId)).toBeUndefined()
    expect(store.delete(retained.taskId)).toBe(true)
    expect(store.delete(retained.taskId)).toBe(false)
    expect(store.count()).toBe(0)
  })
})

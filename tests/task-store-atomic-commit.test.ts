import { afterEach, describe, expect, it, vi } from 'vitest'

const { writeJsonAtomicMock } = vi.hoisted(() => ({
  writeJsonAtomicMock: vi.fn()
}))

vi.mock('../src/main/storage/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/storage/atomic-json')>()
  return { ...actual, writeJsonAtomic: writeJsonAtomicMock }
})

import { createTaskManifest } from '../src/shared/task-schema'
import { AtomicWriteCommittedError } from '../src/main/storage/atomic-json'
import { TaskStore } from '../src/main/storage/task-store'

afterEach(() => {
  writeJsonAtomicMock.mockReset()
  vi.restoreAllMocks()
})

describe('TaskStore atomic manifest outcome', () => {
  it('treats a post-rename directory sync error as committed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    writeJsonAtomicMock.mockRejectedValueOnce(new AtomicWriteCommittedError('/task/task.json', new Error('fsync failed')))

    await expect(new TaskStore().create('/task', createTaskManifest({
      kind: 'url',
      url: 'https://example.com/atomic'
    }))).resolves.toBeUndefined()
  })

  it('returns the committed mutation so artifact owners cross their cleanup boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new TaskStore()
    const current = createTaskManifest({ kind: 'url', url: 'https://example.com/atomic-mutate' })
    vi.spyOn(store, 'load').mockResolvedValue(current)
    writeJsonAtomicMock.mockRejectedValueOnce(new AtomicWriteCommittedError('/task/task.json', new Error('fsync failed')))

    const updated = await store.mutate('/task', (manifest) => {
      manifest.title = 'committed title'
    }, current.revision)

    expect(updated.revision).toBe(current.revision + 1)
    expect(updated.title).toBe('committed title')
  })

  it('still rejects a failure that happened before replacement', async () => {
    writeJsonAtomicMock.mockRejectedValueOnce(new Error('rename failed'))

    await expect(new TaskStore().create('/task', createTaskManifest({
      kind: 'url',
      url: 'https://example.com/atomic'
    }))).rejects.toThrow('rename failed')
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { HiddenTaskStore } from '../src/main/storage/hidden-task-store'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('HiddenTaskStore', () => {
  it('serializes concurrent writes and deduplicates task IDs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-hidden-tasks-'))
    directories.push(base)
    const store = new HiddenTaskStore(join(base, 'hidden-tasks.json'))
    const first = randomUUID()
    const second = randomUUID()

    await Promise.all([store.hide(first), store.hide(second), store.hide(first)])

    expect((await store.load()).taskIds).toEqual([first, second].sort())
  })

  it('rejects invalid task IDs without writing them', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-hidden-tasks-'))
    directories.push(base)
    const store = new HiddenTaskStore(join(base, 'hidden-tasks.json'))

    await expect(store.hide('not-a-task-id')).rejects.toThrow()
    expect(await store.load()).toEqual({ schemaVersion: 1, taskIds: [] })
  })
})

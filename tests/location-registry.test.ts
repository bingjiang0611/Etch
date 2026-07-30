import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTaskManifest } from '../src/shared/task-schema'
import { discoverTasks, LocationRegistry } from '../src/main/storage/location-registry'
import { TaskStore } from '../src/main/storage/task-store'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('LocationRegistry', () => {
  it('serializes concurrent registry mutations without losing fields', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-locations-'))
    directories.push(base)
    const registry = new LocationRegistry(join(base, 'location-registry.json'))
    const root = join(base, 'workspace')
    const task = join(root, 'task')

    await Promise.all([registry.addWorkspaceRoot(root), registry.addTaskLocation(task)])

    expect(await registry.load()).toEqual({ schemaVersion: 1, workspaceRoots: [root], explicitTaskLocations: [task] })
  })

  it('keeps historical roots and reports duplicate task IDs', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-locations-'))
    directories.push(base)
    const rootA = join(base, 'A')
    const rootB = join(base, 'B')
    const taskA = join(rootA, 'task-a')
    const taskB = join(rootB, 'task-copy')
    await Promise.all([mkdir(taskA, { recursive: true }), mkdir(taskB, { recursive: true })])

    const registry = new LocationRegistry(join(base, 'location-registry.json'))
    await registry.addWorkspaceRoot(rootA)
    await registry.addWorkspaceRoot(rootB)
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/video' })
    const store = new TaskStore()
    await store.create(taskA, manifest)
    await store.create(taskB, manifest)

    const discovered = await discoverTasks(await registry.load())
    expect(discovered.tasks).toHaveLength(0)
    expect(discovered.conflicts.get(manifest.taskId)?.map((item) => item.location).sort()).toEqual([taskA, taskB].sort())
  })

  it('skips task IDs hidden by the independent tombstone store', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-locations-'))
    directories.push(base)
    const root = join(base, 'workspace')
    const task = join(root, 'task')
    await mkdir(task, { recursive: true })
    const registry = new LocationRegistry(join(base, 'location-registry.json'))
    await registry.addWorkspaceRoot(root)
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/hidden' })
    await new TaskStore().create(task, manifest)

    const discovered = await discoverTasks(await registry.load(), new Set([manifest.taskId]))

    expect(discovered.tasks).toHaveLength(0)
    expect(discovered.conflicts.size).toBe(0)
    expect(discovered.errors).toEqual([])
  })

  it('isolates malformed task manifests while preserving healthy tasks', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-locations-'))
    directories.push(base)
    const root = join(base, 'workspace')
    const healthy = join(root, 'healthy')
    const malformed = join(root, 'malformed')
    await Promise.all([mkdir(healthy, { recursive: true }), mkdir(malformed, { recursive: true })])
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/healthy' })
    await new TaskStore().create(healthy, manifest)
    await writeFile(join(malformed, 'task.json'), '{"schemaVersion":')

    const discovered = await discoverTasks({
      schemaVersion: 1,
      workspaceRoots: [root],
      explicitTaskLocations: []
    })

    expect(discovered.tasks).toEqual([expect.objectContaining({ location: healthy })])
    expect(discovered.conflicts.size).toBe(0)
    expect(discovered.errors).toEqual([
      expect.objectContaining({ location: malformed, code: 'invalid-manifest' })
    ])
  })
})

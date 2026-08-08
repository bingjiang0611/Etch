import { access, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { moveTaskToTrash, removeTaskRecord, revealTaskInFinder } from '../src/main/task-deletion'
import { HiddenTaskStore } from '../src/main/storage/hidden-task-store'
import type { IndexedTask } from '../src/main/storage/index-store'
import { LocationRegistry } from '../src/main/storage/location-registry'
import { TaskStore } from '../src/main/storage/task-store'
import { createTaskManifest } from '../src/shared/task-schema'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function fixture(): Promise<{
  base: string
  taskDirectory: string
  externalSource: string
  trashDirectory: string
  indexStore: {
    get: (taskId: string) => IndexedTask | undefined
    delete: (taskId: string) => boolean
  }
  registry: LocationRegistry
  taskStore: TaskStore
  taskId: string
}> {
  const base = await mkdtemp(join(tmpdir(), 'etch-delete-'))
  directories.push(base)
  const workspaceRoot = join(base, 'workspace')
  const taskDirectory = join(workspaceRoot, 'task')
  const externalSource = join(base, 'original.mp4')
  const trashDirectory = join(base, 'trash', 'task')
  await mkdir(taskDirectory, { recursive: true })
  await writeFile(externalSource, 'original video', 'utf8')

  const registry = new LocationRegistry(join(base, 'locations.json'))
  await registry.addWorkspaceRoot(workspaceRoot)
  await registry.addTaskLocation(taskDirectory)
  const taskStore = new TaskStore()
  const manifest = createTaskManifest({ kind: 'local', sourcePath: externalSource })
  await taskStore.create(taskDirectory, manifest)
  const indexedTasks = new Map<string, IndexedTask>([[manifest.taskId, {
    taskId: manifest.taskId,
    location: taskDirectory,
    title: manifest.title,
    revision: manifest.revision,
    status: 'pending',
    updatedAt: manifest.updatedAt
  }]])
  const indexStore = {
    get: (taskId: string) => indexedTasks.get(taskId),
    delete: (taskId: string) => indexedTasks.delete(taskId)
  }
  return { base, taskDirectory, externalSource, trashDirectory, indexStore, registry, taskStore, taskId: manifest.taskId }
}

describe('moveTaskToTrash', () => {
  it('moves only the task directory and preserves an external local video', async () => {
    const item = await fixture()
    await moveTaskToTrash({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      isRunning: () => false,
      trashItem: async (path) => {
        await mkdir(join(item.base, 'trash'), { recursive: true })
        await rename(path, item.trashDirectory)
      },
      protectedPaths: [item.base]
    })

    await expect(access(item.taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(item.trashDirectory, 'task.json'))).resolves.toBeUndefined()
    await expect(access(item.externalSource)).resolves.toBeUndefined()
    expect(item.indexStore.get(item.taskId)).toBeUndefined()
    expect((await item.registry.load()).explicitTaskLocations).not.toContain(item.taskDirectory)
  })

  it('refuses to delete a running task before invoking trash', async () => {
    const item = await fixture()
    let trashCalled = false
    await expect(moveTaskToTrash({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      isRunning: () => true,
      trashItem: async () => { trashCalled = true },
      protectedPaths: [item.base]
    })).rejects.toThrow('运行中的任务不能删除')

    expect(trashCalled).toBe(false)
    await expect(access(item.taskDirectory)).resolves.toBeUndefined()
    expect(item.indexStore.get(item.taskId)).toBeDefined()
  })

  it('refuses to trash a task while its durable Provider run is still active', async () => {
    const item = await fixture()
    let trashCalled = false
    await expect(moveTaskToTrash({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      isRunning: () => false,
      hasActiveProviderRun: async () => true,
      trashItem: async () => { trashCalled = true },
      protectedPaths: [item.base]
    })).rejects.toThrow('仍有活动 Provider 进程登记的任务不能删除')

    expect(trashCalled).toBe(false)
    expect(item.indexStore.get(item.taskId)).toBeDefined()
  })

  it('refuses to move a task directory that is itself protected', async () => {
    const item = await fixture()
    let trashCalled = false
    await expect(moveTaskToTrash({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      isRunning: () => false,
      trashItem: async () => { trashCalled = true },
      protectedPaths: [item.taskDirectory]
    })).rejects.toThrow('任务目录与受保护目录重合')

    expect(trashCalled).toBe(false)
    await expect(access(item.taskDirectory)).resolves.toBeUndefined()
    expect(item.indexStore.get(item.taskId)).toBeDefined()
  })

  it('still deletes a workspace task that discovery found without a registry entry', async () => {
    const item = await fixture()
    await item.registry.removeTaskLocation(item.taskDirectory)

    await expect(moveTaskToTrash({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      isRunning: () => false,
      trashItem: async (path) => {
        await mkdir(join(item.base, 'trash'), { recursive: true })
        await rename(path, item.trashDirectory)
      },
      protectedPaths: [item.base]
    })).resolves.toBe(item.taskDirectory)

    await expect(access(item.taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(item.trashDirectory, 'task.json'))).resolves.toBeUndefined()
    expect(item.indexStore.get(item.taskId)).toBeUndefined()
  })

  it('rejects a workspace child symlink that escapes the registered root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'etch-delete-symlink-'))
    directories.push(base)
    const workspaceRoot = join(base, 'workspace')
    const outsideTask = join(base, 'outside-task')
    const linkedTask = join(workspaceRoot, 'linked-task')
    await Promise.all([mkdir(workspaceRoot), mkdir(outsideTask)])
    await symlink(outsideTask, linkedTask, 'dir')
    const registry = new LocationRegistry(join(base, 'locations.json'))
    await registry.addWorkspaceRoot(workspaceRoot)
    await registry.addTaskLocation(linkedTask)
    const taskStore = new TaskStore()
    const manifest = createTaskManifest({ kind: 'url', url: 'https://example.com/symlink' })
    await taskStore.create(outsideTask, manifest)
    const indexed = new Map<string, IndexedTask>([[manifest.taskId, {
      taskId: manifest.taskId,
      location: linkedTask,
      title: manifest.title,
      revision: manifest.revision,
      status: 'pending',
      updatedAt: manifest.updatedAt
    }]])
    let trashCalled = false

    await expect(moveTaskToTrash({
      taskId: manifest.taskId,
      indexStore: { get: (taskId) => indexed.get(taskId), delete: (taskId) => indexed.delete(taskId) },
      registry,
      taskStore,
      isRunning: () => false,
      trashItem: async () => { trashCalled = true },
      protectedPaths: [base]
    })).rejects.toThrow('任务目录不在 Etch 工作区的直接子目录中')

    expect(trashCalled).toBe(false)
    await expect(access(outsideTask)).resolves.toBeUndefined()
  })

  it('reports registry cleanup failure without claiming the completed trash move failed', async () => {
    const item = await fixture()
    const warnings: unknown[] = []

    await expect(moveTaskToTrash({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: { load: () => item.registry.load(), removeTaskLocation: async () => { throw new Error('registry unavailable') } },
      taskStore: item.taskStore,
      isRunning: () => false,
      trashItem: async (path) => {
        await mkdir(join(item.base, 'trash'), { recursive: true })
        await rename(path, item.trashDirectory)
      },
      protectedPaths: [item.base],
      onCleanupWarning: (warning) => warnings.push(warning)
    })).resolves.toBe(item.taskDirectory)

    expect(warnings).toMatchObject([{ taskId: item.taskId, mode: 'all-artifacts', completedStep: 'index-removed' }])
    await expect(access(item.taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('removeTaskRecord', () => {
  it('removes the Etch record while preserving every task file', async () => {
    const item = await fixture()
    const hiddenTaskStore = new HiddenTaskStore(join(item.base, 'hidden-tasks.json'))

    await removeTaskRecord({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      hiddenTaskStore,
      isRunning: () => false
    })

    await expect(access(join(item.taskDirectory, 'task.json'))).resolves.toBeUndefined()
    await expect(access(item.externalSource)).resolves.toBeUndefined()
    expect(item.indexStore.get(item.taskId)).toBeUndefined()
    expect((await hiddenTaskStore.load()).taskIds).toEqual([item.taskId])
    expect((await item.registry.load()).explicitTaskLocations).not.toContain(item.taskDirectory)
  })

  it('refuses to hide a running task', async () => {
    const item = await fixture()
    const hiddenTaskStore = new HiddenTaskStore(join(item.base, 'hidden-tasks.json'))

    await expect(removeTaskRecord({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      hiddenTaskStore,
      isRunning: () => true
    })).rejects.toThrow('运行中的任务不能删除')

    expect(item.indexStore.get(item.taskId)).toBeDefined()
    expect((await hiddenTaskStore.load()).taskIds).toHaveLength(0)
  })

  it('refuses to hide a task while its durable Provider run is still active', async () => {
    const item = await fixture()
    const hiddenTaskStore = new HiddenTaskStore(join(item.base, 'hidden-tasks.json'))

    await expect(removeTaskRecord({
      taskId: item.taskId,
      indexStore: item.indexStore,
      registry: item.registry,
      taskStore: item.taskStore,
      hiddenTaskStore,
      isRunning: () => false,
      hasActiveProviderRun: async () => true
    })).rejects.toThrow('仍有活动 Provider 进程登记的任务不能删除')

    expect(item.indexStore.get(item.taskId)).toBeDefined()
    expect((await hiddenTaskStore.load()).taskIds).toHaveLength(0)
  })
})

describe('revealTaskInFinder', () => {
  it('reveals the indexed task directory after validating its manifest identity', async () => {
    const item = await fixture()
    const revealed: string[] = []

    await expect(revealTaskInFinder({
      taskId: item.taskId,
      indexStore: item.indexStore,
      taskStore: item.taskStore,
      showItem: (path) => { revealed.push(path) }
    })).resolves.toBe(item.taskDirectory)

    expect(revealed).toEqual([item.taskDirectory])
  })

  it('reports a missing task instead of opening an arbitrary path', async () => {
    const item = await fixture()
    const revealed: string[] = []

    await expect(revealTaskInFinder({
      taskId: '00000000-0000-4000-8000-000000000000',
      indexStore: item.indexStore,
      taskStore: item.taskStore,
      showItem: (path) => { revealed.push(path) }
    })).rejects.toThrow('任务不存在')

    expect(revealed).toHaveLength(0)
  })
})

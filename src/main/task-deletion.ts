import { realpath, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HiddenTaskStore } from './storage/hidden-task-store'
import type { IndexStore } from './storage/index-store'
import type { LocationRegistry } from './storage/location-registry'
import type { TaskStore } from './storage/task-store'

export interface DeleteCleanupWarning {
  taskId: string
  mode: 'record-only' | 'all-artifacts'
  location: string
  completedStep: 'hidden' | 'trashed' | 'index-removed'
  error: unknown
}

interface BaseTaskOptions {
  taskId: string
  indexStore: Pick<IndexStore, 'get' | 'delete'>
  registry: Pick<LocationRegistry, 'load' | 'removeTaskLocation'>
  taskStore: Pick<TaskStore, 'load'>
  isRunning: (taskDirectory: string) => boolean
  hasActiveProviderRun?: (taskId: string, taskDirectory: string) => Promise<boolean>
  onCleanupWarning?: (warning: DeleteCleanupWarning) => void
}

interface DeleteTaskOptions extends BaseTaskOptions {
  trashItem: (taskDirectory: string) => Promise<void>
  protectedPaths: readonly string[]
}

interface RemoveTaskRecordOptions extends BaseTaskOptions {
  hiddenTaskStore: Pick<HiddenTaskStore, 'hide'>
}

interface RevealTaskOptions {
  taskId: string
  indexStore: Pick<IndexStore, 'get'>
  taskStore: Pick<TaskStore, 'load'>
  showItem: (taskDirectory: string) => void | Promise<void>
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path) }
  catch { return resolve(path) }
}

export async function moveTaskToTrash(options: DeleteTaskOptions): Promise<string> {
  const indexed = options.indexStore.get(options.taskId)
  if (!indexed) throw new Error('任务不存在')
  if (options.isRunning(indexed.location)) throw new Error('运行中的任务不能删除')
  if (await options.hasActiveProviderRun?.(options.taskId, indexed.location)) throw new Error('仍有活动 Provider 进程登记的任务不能删除')

  const manifest = await options.taskStore.load(indexed.location)
  if (manifest.taskId !== options.taskId) throw new Error('任务目录身份不匹配，拒绝删除')

  const registry = await options.registry.load()
  const taskDirectory = await canonicalPath(indexed.location)
  const protectedPaths = await Promise.all([...options.protectedPaths, ...registry.workspaceRoots].map(canonicalPath))
  if (protectedPaths.includes(taskDirectory)) throw new Error('任务目录与受保护目录重合，拒绝删除')
  // Being a direct child of a registered workspace root is the containment guard. Requiring an
  // explicit registry entry on top of it would strand every task that discovery found by scanning a
  // workspace root, because only task creation records those entries.
  if (!protectedPaths.slice(options.protectedPaths.length).some((root) => dirname(taskDirectory) === root)) {
    throw new Error('任务目录不在 Etch 工作区的直接子目录中，拒绝删除')
  }

  await options.trashItem(taskDirectory)
  options.indexStore.delete(options.taskId)
  try {
    await options.registry.removeTaskLocation(indexed.location)
  } catch (error) {
    options.onCleanupWarning?.({ taskId: options.taskId, mode: 'all-artifacts', location: indexed.location, completedStep: 'index-removed', error })
  }
  return indexed.location
}

export async function removeTaskRecord(options: RemoveTaskRecordOptions): Promise<string> {
  const indexed = options.indexStore.get(options.taskId)
  if (!indexed) throw new Error('任务不存在')
  if (options.isRunning(indexed.location)) throw new Error('运行中的任务不能删除')
  if (await options.hasActiveProviderRun?.(options.taskId, indexed.location)) throw new Error('仍有活动 Provider 进程登记的任务不能删除')

  const manifest = await options.taskStore.load(indexed.location)
  if (manifest.taskId !== options.taskId) throw new Error('任务目录身份不匹配，拒绝删除')

  await options.hiddenTaskStore.hide(options.taskId)
  options.indexStore.delete(options.taskId)
  try {
    await options.registry.removeTaskLocation(indexed.location)
  } catch (error) {
    options.onCleanupWarning?.({ taskId: options.taskId, mode: 'record-only', location: indexed.location, completedStep: 'index-removed', error })
  }
  return indexed.location
}

export async function revealTaskInFinder(options: RevealTaskOptions): Promise<string> {
  const indexed = options.indexStore.get(options.taskId)
  if (!indexed) throw new Error('任务不存在')
  const manifest = await options.taskStore.load(indexed.location)
  if (manifest.taskId !== options.taskId) throw new Error('任务目录身份不匹配，无法在访达中显示')
  let directoryStat: Awaited<ReturnType<typeof stat>>
  try {
    directoryStat = await stat(indexed.location)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('任务目录不存在，无法在访达中显示')
    throw error
  }
  if (!directoryStat.isDirectory()) throw new Error('任务路径不是目录，无法在访达中显示')
  await options.showItem(indexed.location)
  return indexed.location
}

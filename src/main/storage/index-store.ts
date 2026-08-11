import type { TaskKind, TaskManifest } from '../../shared/task-schema'

export interface IndexedTask {
  taskId: string
  rootTaskId?: string
  reusedFromTaskId?: string
  location: string
  title: string
  kind: TaskKind
  category: string
  revision: number
  status: string
  createdAt: string
  updatedAt: string
}

export function taskStatus(manifest: TaskManifest): string {
  const stages = Object.values(manifest.pipeline.stages)
  return stages.find((stage) => stage.status === 'failed')?.status
    ?? stages.find((stage) => stage.status === 'checkpoint')?.status
    ?? stages.find((stage) => stage.status === 'running')?.status
    ?? stages.find((stage) => stage.status === 'paused')?.status
    ?? (stages.every((stage) => ['completed', 'skipped'].includes(stage.status)) ? 'completed' : 'pending')
}

export function indexedTask(location: string, manifest: TaskManifest): IndexedTask {
  return {
    taskId: manifest.taskId,
    rootTaskId: manifest.lineage.rootTaskId,
    reusedFromTaskId: manifest.lineage.reusedFromTaskId,
    location,
    title: manifest.title,
    kind: manifest.kind,
    category: manifest.category,
    revision: manifest.revision,
    status: taskStatus(manifest),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt
  }
}

export class IndexStore {
  readonly #tasks = new Map<string, IndexedTask>()

  upsert(location: string, manifest: TaskManifest): void {
    const existing = this.#tasks.get(manifest.taskId)
    if (existing && existing.revision >= manifest.revision) return
    this.#tasks.set(manifest.taskId, indexedTask(location, manifest))
  }

  list(limit = 100, offset = 0): IndexedTask[] {
    return this.all().slice(offset, offset + limit)
  }

  all(): IndexedTask[] {
    return [...this.#tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  count(): number {
    return this.#tasks.size
  }

  get(taskId: string): IndexedTask | undefined {
    return this.#tasks.get(taskId)
  }

  delete(taskId: string): boolean {
    return this.#tasks.delete(taskId)
  }

  rebuild(tasks: readonly { location: string; manifest: TaskManifest }[]): void {
    this.#tasks.clear()
    for (const task of tasks) this.upsert(task.location, task.manifest)
  }
}

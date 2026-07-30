import type { TaskManifest } from '../../shared/task-schema'

export interface IndexedTask {
  taskId: string
  location: string
  title: string
  revision: number
  status: string
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
    location,
    title: manifest.title,
    revision: manifest.revision,
    status: taskStatus(manifest),
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
    return [...this.#tasks.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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

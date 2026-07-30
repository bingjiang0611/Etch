import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { migrateTaskManifest, type TaskManifest } from '../../shared/task-schema'
import { writeJsonAtomic } from './atomic-json'

const LocationRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  workspaceRoots: z.array(z.string().min(1)),
  explicitTaskLocations: z.array(z.string().min(1))
})
export type LocationRegistryData = z.infer<typeof LocationRegistrySchema>

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

export class LocationRegistry {
  #mutationQueue: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<LocationRegistryData> {
    try {
      return LocationRegistrySchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, workspaceRoots: [], explicitTaskLocations: [] }
    }
  }

  async addWorkspaceRoot(root: string): Promise<LocationRegistryData> {
    return this.#mutate((current) => ({ ...current, workspaceRoots: unique([...current.workspaceRoots, root]) }))
  }

  async addTaskLocation(path: string): Promise<LocationRegistryData> {
    return this.#mutate((current) => ({ ...current, explicitTaskLocations: unique([...current.explicitTaskLocations, path]) }))
  }

  async removeTaskLocation(path: string): Promise<LocationRegistryData> {
    return this.#mutate((current) => ({ ...current, explicitTaskLocations: current.explicitTaskLocations.filter((item) => item !== path) }))
  }

  #mutate(update: (current: LocationRegistryData) => LocationRegistryData): Promise<LocationRegistryData> {
    const operation = this.#mutationQueue.then(async () => {
      const next = update(await this.load())
      await writeJsonAtomic(this.path, next)
      return next
    })
    this.#mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

export interface DiscoveredTask {
  location: string
  manifest: TaskManifest
}

export interface DiscoveryResult {
  tasks: DiscoveredTask[]
  conflicts: Map<string, DiscoveredTask[]>
  errors: DiscoveryError[]
}

export interface DiscoveryError {
  location: string
  code: 'invalid-manifest' | 'unreadable'
  summary: string
}

export async function discoverTasks(registry: LocationRegistryData, hiddenTaskIds: ReadonlySet<string> = new Set()): Promise<DiscoveryResult> {
  const candidates = new Set(registry.explicitTaskLocations)
  const errors: DiscoveryError[] = []
  for (const root of registry.workspaceRoots) {
    try {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.add(join(root, entry.name))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        errors.push({ location: root, code: 'unreadable', summary: errorSummary(error) })
      }
    }
  }

  const byId = new Map<string, DiscoveredTask[]>()
  for (const location of candidates) {
    try {
      const manifest = migrateTaskManifest(JSON.parse(await readFile(join(location, 'task.json'), 'utf8')))
      if (hiddenTaskIds.has(manifest.taskId)) continue
      const items = byId.get(manifest.taskId) ?? []
      items.push({ location, manifest })
      byId.set(manifest.taskId, items)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const code = ['EACCES', 'EPERM', 'EIO'].includes((error as NodeJS.ErrnoException).code ?? '')
          ? 'unreadable'
          : 'invalid-manifest'
        errors.push({ location, code, summary: errorSummary(error) })
      }
    }
  }

  const tasks: DiscoveredTask[] = []
  const conflicts = new Map<string, DiscoveredTask[]>()
  for (const [taskId, items] of byId) {
    if (items.length === 1) tasks.push(items[0])
    else conflicts.set(taskId, items)
  }
  return { tasks, conflicts, errors }
}

function errorSummary(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, ' ').slice(0, 300)
}

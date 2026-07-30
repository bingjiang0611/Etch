import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeJsonAtomic } from './atomic-json'

const TaskIdSchema = z.string().uuid()
const HiddenTasksSchema = z.object({
  schemaVersion: z.literal(1),
  taskIds: z.array(TaskIdSchema).max(100_000)
})
export type HiddenTasksData = z.infer<typeof HiddenTasksSchema>

export class HiddenTaskStore {
  #mutationQueue: Promise<void> = Promise.resolve()

  constructor(readonly path: string) {}

  async load(): Promise<HiddenTasksData> {
    try {
      return HiddenTasksSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, taskIds: [] }
    }
  }

  async hide(taskId: string): Promise<HiddenTasksData> {
    const validatedTaskId = TaskIdSchema.parse(taskId)
    const operation = this.#mutationQueue.then(async () => {
      const current = await this.load()
      const next = HiddenTasksSchema.parse({ ...current, taskIds: [...new Set([...current.taskIds, validatedTaskId])].sort() })
      await writeJsonAtomic(this.path, next)
      return next
    })
    this.#mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
}

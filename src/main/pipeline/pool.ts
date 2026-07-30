import { POOL_BY_STAGE } from '../../shared/pipeline'
import type { StageId } from '../../shared/task-schema'

type PoolWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class PoolCancelledError extends Error {
  constructor() {
    super('阶段在等待执行槽位时已取消')
    this.name = 'PoolCancelledError'
  }
}

class BoundedPool {
  #limit: number
  #active = 0
  readonly #queue: PoolWaiter[] = []

  constructor(limit: 1 | 2 | 3) { this.#limit = limit }
  setLimit(limit: 1 | 2 | 3): void { this.#limit = limit; this.#drain() }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new PoolCancelledError()
    await new Promise<void>((resolve, reject) => {
      const waiter: PoolWaiter = { resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter)
          if (index < 0) return
          this.#queue.splice(index, 1)
          signal.removeEventListener('abort', waiter.onAbort!)
          reject(new PoolCancelledError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#queue.push(waiter)
      this.#drain()
    })
    try {
      if (signal?.aborted) throw new PoolCancelledError()
      return await operation()
    } finally {
      this.#active -= 1
      this.#drain()
    }
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#queue.length) {
      const waiter = this.#queue.shift()!
      if (waiter.signal?.aborted) {
        waiter.signal.removeEventListener('abort', waiter.onAbort!)
        waiter.reject(new PoolCancelledError())
        continue
      }
      this.#active += 1
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve()
    }
  }
}

type PoolKind = 'download' | 'whisper' | 'agent' | 'ffmpeg' | 'audit'

export class StagePools {
  readonly #pools: Record<PoolKind, BoundedPool>
  constructor(limit: 1 | 2 | 3) {
    this.#pools = Object.fromEntries(['download', 'whisper', 'agent', 'ffmpeg', 'audit'].map((key) => [key, new BoundedPool(limit)])) as Record<PoolKind, BoundedPool>
  }
  runStage<T>(stage: StageId, limit: 1 | 2 | 3, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const kind = POOL_BY_STAGE[stage]
    if (!kind) {
      if (signal?.aborted) return Promise.reject(new PoolCancelledError())
      return operation()
    }
    Object.values(this.#pools).forEach((pool) => pool.setLimit(limit))
    return this.#pools[kind].run(operation, signal)
  }
}

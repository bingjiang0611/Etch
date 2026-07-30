import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrateTaskManifest, type StageId, type StepLease, type TaskManifest } from '../../shared/task-schema'
import { PROVIDER_SESSION_CONTAMINATED_PREFIX } from '../providers/session-errors'
import { AtomicWriteCommittedError, writeJsonAtomic } from './atomic-json'

async function writeTaskManifest(path: string, manifest: TaskManifest): Promise<void> {
  try {
    await writeJsonAtomic(path, manifest)
  } catch (error) {
    if (!(error instanceof AtomicWriteCommittedError)) throw error
    console.error('task.json 已原子替换，但父目录 durability sync 失败；保留已提交 manifest', error.cause)
  }
}

export class StaleStepError extends Error {
  constructor(message = '原子步骤输入已变化，候选结果已过期') {
    super(message)
    this.name = 'StaleStepError'
  }
}

export class TaskStore {
  readonly #queues = new Map<string, Promise<void>>()

  async load(taskDirectory: string): Promise<TaskManifest> {
    return migrateTaskManifest(JSON.parse(await readFile(join(taskDirectory, 'task.json'), 'utf8')))
  }

  async create(taskDirectory: string, manifest: TaskManifest): Promise<void> {
    await writeTaskManifest(join(taskDirectory, 'task.json'), manifest)
  }

  async mutate(taskDirectory: string, change: (manifest: TaskManifest) => TaskManifest | void, expectedRevision?: number): Promise<TaskManifest> {
    return this.#serial(taskDirectory, async () => {
      const current = await this.load(taskDirectory)
      if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new StaleStepError('任务已被更新，请刷新后重试')
      const draft = structuredClone(current)
      const changed = change(draft) ?? draft
      const next = migrateTaskManifest({ ...changed, revision: current.revision + 1, updatedAt: new Date().toISOString() })
      await writeTaskManifest(join(taskDirectory, 'task.json'), next)
      return next
    })
  }

  async acquireLease(
    taskDirectory: string,
    stage: StageId,
    inputFingerprint: string,
    currentMessage?: string,
    expectedRevision?: number
  ): Promise<StepLease> {
    let lease: StepLease | undefined
    await this.mutate(taskDirectory, (manifest) => {
      const state = manifest.pipeline.stages[stage]
      if (!state) throw new Error(`任务缺少阶段：${stage}`)
      if (state.activeLease) throw new Error(`阶段已有 active lease：${stage}`)
      lease = {
        runId: randomUUID(),
        stage,
        manifestRevision: manifest.revision + 1,
        inputFingerprint,
        acquiredAt: new Date().toISOString()
      }
      state.status = 'running'
      state.attempt += 1
      state.activeLease = lease
      delete state.errorCode
      delete state.checkpointId
      if (currentMessage) manifest.runtime.currentMessage = currentMessage
    }, expectedRevision)
    return lease!
  }

  async commitLease(
    taskDirectory: string,
    lease: StepLease,
    currentFingerprint: string,
    commit: (manifest: TaskManifest) => void
  ): Promise<TaskManifest> {
    return this.#serial(taskDirectory, async () => {
      const current = await this.load(taskDirectory)
      const state = current.pipeline.stages[lease.stage]
      if (
        current.revision !== lease.manifestRevision ||
        currentFingerprint !== lease.inputFingerprint ||
        state?.activeLease?.runId !== lease.runId
      ) {
        throw new StaleStepError()
      }
      const next = structuredClone(current)
      commit(next)
      const nextState = next.pipeline.stages[lease.stage]
      nextState.status = 'completed'
      delete nextState.activeLease
      const validated = migrateTaskManifest({ ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() })
      await writeTaskManifest(join(taskDirectory, 'task.json'), validated)
      return validated
    })
  }

  async persistLeaseExternalSession(
    taskDirectory: string,
    lease: StepLease,
    currentFingerprint: string,
    generationId: string,
    externalSessionId: string
  ): Promise<{ lease: StepLease; manifest: TaskManifest }> {
    return this.#serial(taskDirectory, async () => {
      const current = await this.load(taskDirectory)
      const state = current.pipeline.stages[lease.stage]
      if (
        current.revision !== lease.manifestRevision ||
        currentFingerprint !== lease.inputFingerprint ||
        state?.activeLease?.runId !== lease.runId
      ) {
        throw new StaleStepError()
      }
      if (current.translation.activeGenerationId !== generationId) {
        throw new StaleStepError('active session generation 已变化')
      }
      const generation = current.translation.sessionGenerations.find((item) => item.id === generationId)
      if (!generation || generation.status !== 'active') {
        throw new StaleStepError('active session generation 不存在')
      }
      if (generation.externalSessionId) {
        if (generation.externalSessionId !== externalSessionId) {
          throw new StaleStepError('Provider external session 发生漂移')
        }
        return { lease, manifest: current }
      }

      const nextRevision = current.revision + 1
      const nextLease = { ...lease, manifestRevision: nextRevision }
      const next = structuredClone(current)
      const nextGeneration = next.translation.sessionGenerations.find((item) => item.id === generationId)!
      nextGeneration.externalSessionId = externalSessionId
      next.pipeline.stages[lease.stage].activeLease = nextLease
      const validated = migrateTaskManifest({ ...next, revision: nextRevision, updatedAt: new Date().toISOString() })
      await writeTaskManifest(join(taskDirectory, 'task.json'), validated)
      return { lease: nextLease, manifest: validated }
    })
  }

  async failLease(taskDirectory: string, lease: StepLease, errorCode: string): Promise<TaskManifest> {
    return this.mutate(taskDirectory, (manifest) => {
      const state = manifest.pipeline.stages[lease.stage]
      if (state?.activeLease?.runId !== lease.runId) throw new StaleStepError()
      state.status = 'failed'
      state.errorCode = errorCode.slice(0, 500)
      delete state.activeLease
      manifest.runtime.currentMessage = errorCode.slice(0, 160)
    })
  }

  async pauseLease(taskDirectory: string, lease: StepLease): Promise<TaskManifest> {
    return this.mutate(taskDirectory, (manifest) => {
      const state = manifest.pipeline.stages[lease.stage]
      if (state?.activeLease?.runId !== lease.runId) throw new StaleStepError()
      state.status = 'paused'
      delete state.activeLease
      delete state.checkpointId
      const providerStages = new Set<StageId>(['cues', 'translate', 'audit'])
      if (providerStages.has(lease.stage) && manifest.translation.activeGenerationId) {
        state.errorCode = `${PROVIDER_SESSION_CONTAMINATED_PREFIX}用户在 Provider 调用期间停止任务`
      } else {
        delete state.errorCode
      }
      manifest.runtime.userPaused = true
      manifest.runtime.currentMessage = '已停止，可随时继续处理'
    })
  }

  async deferLease(taskDirectory: string, lease: StepLease): Promise<TaskManifest> {
    return this.mutate(taskDirectory, (manifest) => {
      const state = manifest.pipeline.stages[lease.stage]
      if (state?.activeLease?.runId !== lease.runId) throw new StaleStepError()
      state.status = 'ready'
      state.attempt = Math.max(0, state.attempt - 1)
      delete state.activeLease
      delete state.errorCode
      delete state.checkpointId
      manifest.runtime.currentMessage = '队列已暂停，等待领取下一阶段'
    })
  }

  async pausePending(taskDirectory: string): Promise<TaskManifest> {
    return this.mutate(taskDirectory, (manifest) => {
      const stage = Object.values(manifest.pipeline.stages).find((state) =>
        !['completed', 'skipped', 'checkpoint'].includes(state.status)
      )
      if (stage && stage.status !== 'failed') stage.status = 'paused'
      manifest.runtime.userPaused = true
      manifest.runtime.currentMessage = '已停止，可随时继续处理'
    })
  }

  async resumePaused(taskDirectory: string): Promise<TaskManifest> {
    return this.mutate(taskDirectory, (manifest) => {
      for (const state of Object.values(manifest.pipeline.stages)) {
        if (state.status === 'paused') state.status = 'ready'
      }
      manifest.runtime.userPaused = false
      manifest.runtime.currentMessage = '等待继续处理'
    })
  }

  async checkpointLease(
    taskDirectory: string,
    lease: StepLease,
    currentFingerprint: string,
    checkpointId: string,
    summary: string,
    commit: (manifest: TaskManifest) => void
  ): Promise<TaskManifest> {
    return this.#serial(taskDirectory, async () => {
      const current = await this.load(taskDirectory)
      const state = current.pipeline.stages[lease.stage]
      if (current.revision !== lease.manifestRevision || currentFingerprint !== lease.inputFingerprint || state?.activeLease?.runId !== lease.runId) throw new StaleStepError()
      const next = structuredClone(current)
      commit(next)
      const nextState = next.pipeline.stages[lease.stage]
      nextState.status = 'checkpoint'
      nextState.checkpointId = checkpointId
      nextState.errorCode = summary
      delete nextState.activeLease
      next.runtime.currentMessage = summary
      const validated = migrateTaskManifest({ ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() })
      await writeTaskManifest(join(taskDirectory, 'task.json'), validated)
      return validated
    })
  }

  async recoverInterrupted(taskDirectory: string): Promise<TaskManifest> {
    const current = await this.load(taskDirectory)
    const interrupted = Object.values(current.pipeline.stages).some((state) => state.status === 'running' || state.activeLease)
    if (!interrupted) return current
    return this.mutate(taskDirectory, (manifest) => {
      const activeGeneration = manifest.translation.sessionGenerations.find((generation) =>
        generation.id === manifest.translation.activeGenerationId && generation.status === 'active'
      )
      const providerStages = new Set<StageId>(['cues', 'translate', 'audit'])
      let contaminatedProviderStage = false
      for (const [stage, state] of Object.entries(manifest.pipeline.stages)) {
        if (state.status !== 'running' && !state.activeLease) continue
        state.status = 'failed'
        if (activeGeneration && providerStages.has(stage as StageId)) {
          state.errorCode = `${PROVIDER_SESSION_CONTAMINATED_PREFIX}上次运行在 Provider 纯文本调用完成隔离判定前异常中断`
          contaminatedProviderStage = true
        } else {
          state.errorCode = '上次运行异常中断；已保留完成产物，可从此阶段安全重试'
        }
        delete state.activeLease
      }
      manifest.runtime.currentMessage = contaminatedProviderStage
        ? '检测到 Provider 调用异常中断；确认恢复后将废弃旧 session 并重建'
        : '检测到上次异常退出，请确认恢复后继续'
    })
  }

  async #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => gate)
    this.#queues.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#queues.get(key) === queued) this.#queues.delete(key)
    }
  }
}
